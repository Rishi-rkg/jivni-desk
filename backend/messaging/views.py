"""The Messages tab: the approval queue, sending through WhatsApp by hand, templates, rules and campaigns."""

import datetime
import uuid
from urllib.parse import quote

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from accounts.access import CLINIC_ADMIN, MESSAGE_APPROVE, MESSAGES
from accounts.features import feature_on, require_feature
from records.models import Patient
from records.views import ClinicViewSet
from scheduling.models import Appointment

from .models import FIELDS, Campaign, Message, MessageRule, MessageTemplate, clean_body, ensure_standard, fields_in, render, whatsapp_digits
from .rules import (
    audience,
    block_reason,
    consents,
    context_for,
    full_name,
    latest_invoice,
    make_message,
    medicine_named,
    next_appointment,
    person,
    prepare,
)

CONTENT_RULE = "Messages never contain a diagnosis, symptoms or medicine names."
BOXES = {
    "waiting": [Message.Status.WAITING, Message.Status.APPROVED],
    "replies": [Message.Status.RECEIVED, Message.Status.HANDLED],
    "sent": [Message.Status.SENT],
    "failed": [Message.Status.FAILED],
}


def context_line(message):
    """One line saying where a message came from: the appointment, the bill, the rule or the campaign."""
    if message.is_reply:
        return "Reply from the patient, noted by staff"
    parts = []
    if message.appointment_id:
        appointment = message.appointment
        when = f"{appointment.day:%a %d %b}" + (f" {appointment.time:%H:%M}" if appointment.time else "")
        parts.append(f"Appointment {when}")
    if message.invoice_id and message.invoice.number:
        parts.append(message.invoice.number)
    if message.rule_id:
        parts.append(f"Rule: {message.rule.name}")
    if message.campaign_id:
        parts.append(f"Campaign: {message.campaign.name}")
    if not parts:
        parts.append("Written by hand" if message.source == Message.Source.MANUAL else f"Template: {message.template_name}")
    return " · ".join(parts)


def message_rows(messages):
    messages = list(messages)
    answers = consents({message.patient_id for message in messages})
    rows = []
    for message in messages:
        consent = answers[message.patient_id].get(message.kind)
        patient = message.patient
        rows.append(
            {
                "id": str(message.pk),
                "status": message.status,
                "source": message.source,
                "kind": message.kind,
                "title": message.title,
                "body": message.body,
                "patient": {"id": str(patient.pk), "name": full_name(patient), "archived": bool(patient.archived_at)},
                "to": message.to_number or patient.whatsapp_number or patient.phone,
                "context": context_line(message),
                "template": {"name": message.template_name, "version": message.template_version} if message.template_name else None,
                "blocked": block_reason(patient, message.kind, answers[message.patient_id]) if message.status in Message.OPEN else "",
                "consent": None
                if message.is_reply
                else {
                    "kind": message.kind,
                    "granted": bool(consent and consent.granted),
                    "recorded_at": consent.created_at.isoformat() if consent else None,
                },
                "send_after": message.send_after.isoformat() if message.send_after else None,
                "created_at": message.created_at.isoformat(),
                "created_by_name": person(message.created_by),
                "approved_at": message.approved_at.isoformat() if message.approved_at else None,
                "approved_by_name": person(message.approved_by),
                "sent_at": message.sent_at.isoformat() if message.sent_at else None,
                "sent_by_name": person(message.sent_by),
                "failed_reason": message.failed_reason,
            }
        )
    return rows


class MessagingViewSet(ClinicViewSet):
    roles = MESSAGES

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        require_feature(self.member, "messages")
        self.need(self.roles)

    def need(self, roles):
        if self.member.role_id not in roles:
            raise PermissionDenied("Your clinic role does not allow this action.")

    def patient(self, value, archived=False):
        try:
            patients = Patient.objects.filter(clinic=self.member.clinic)
            return (patients if archived else patients.filter(archived_at__isnull=True)).get(pk=uuid.UUID(str(value)))
        except (Patient.DoesNotExist, ValueError):
            raise serializers.ValidationError({"patient": "Choose a patient of this clinic."}) from None

    def template(self, value, approved=True):
        try:
            template = MessageTemplate.objects.get(pk=uuid.UUID(str(value)), clinic=self.member.clinic)
        except (MessageTemplate.DoesNotExist, ValueError):
            raise serializers.ValidationError({"template": "Choose one of this clinic's templates."}) from None
        if approved and not template.approved:
            raise serializers.ValidationError({"template": "That template is still a draft. Approve it in Templates first."})
        return template


class MessageViewSet(MessagingViewSet):
    def queryset(self):
        return Message.objects.filter(clinic=self.member.clinic).select_related(
            "patient", "rule", "campaign", "appointment", "invoice", "created_by", "approved_by", "sent_by"
        )

    def find(self, pk):
        try:
            return self.queryset().get(pk=uuid.UUID(str(pk)))
        except (Message.DoesNotExist, ValueError):
            raise serializers.ValidationError("That message was not found.") from None

    def one(self, message, status=200, **more):
        return Response({**message_rows([self.find(message.pk)])[0], **more}, status=status)

    def wording(self, patient, body):
        """The wording, checked: no field left unfilled, and no medicine from the patient's record."""
        body = clean_body(body)
        left = fields_in(body)
        if left:
            raise serializers.ValidationError({"body": f"Fill in or remove {{{FIELDS[left[0]]}}} before saving."})
        named = medicine_named(patient, body)
        if named:
            raise serializers.ValidationError({"body": f"This names a medicine from the patient's record ({named}). {CONTENT_RULE}"})
        return body

    def sendable(self, message):
        reason = block_reason(message.patient, message.kind, consents([message.patient_id])[message.patient_id])
        if reason:
            raise serializers.ValidationError({"detail": f"Not sendable: {reason}"})
        self.wording(message.patient, message.body)

    # --- reading

    def list(self, request):
        clinic, params = self.member.clinic, request.query_params
        messages = self.queryset()
        if params.get("patient"):
            # One patient's history: everything except what was discarded.
            messages = messages.filter(patient=self.patient(params["patient"], archived=True)).exclude(status=Message.Status.DISCARDED)
        else:
            box = params.get("box", "waiting")
            if box not in BOXES:
                raise serializers.ValidationError({"box": "Unknown list of messages."})
            if box == "waiting":
                prepare(clinic)
            messages = messages.filter(status__in=BOXES[box])
            if box == "waiting":
                messages = messages.order_by("created_at", "id")
            elif box == "sent":
                messages = messages.order_by("-sent_at", "id")
        self.event("message.list")
        return Response({"today": clinic.today().isoformat(), "results": message_rows(messages[:300])})

    @action(detail=False, methods=["get"])
    def counts(self, request):
        """The numbers beside the tab and its lists. Looking also prepares what today's rules call for."""
        clinic = self.member.clinic
        prepare(clinic)
        messages = Message.objects.filter(clinic=clinic)
        return Response(
            {
                "waiting": messages.filter(status__in=Message.OPEN).count(),
                "replies": messages.filter(status=Message.Status.RECEIVED).count(),
                "failed": messages.filter(status=Message.Status.FAILED).count(),
            }
        )

    @action(detail=False, methods=["post"])
    def preview(self, request):
        """A template's wording for one patient, before anything is saved. Fields nothing is known for stay as written."""
        clinic = self.member.clinic
        patient = self.patient(request.data.get("patient"))
        template = self.template(request.data.get("template"))
        appointment, invoice = self.links(patient, request.data)
        body, missing = render(
            template.body,
            context_for(clinic, patient, appointment or next_appointment(clinic, patient), invoice or latest_invoice(clinic, patient)),
        )
        return Response({"title": template.name, "kind": template.kind, "body": body, "missing": [FIELDS[name] for name in missing]})

    def links(self, patient, data):
        """The appointment or bill a message is about, when the screen it was started from names one."""
        from billing.models import Invoice

        clinic, appointment, invoice = self.member.clinic, None, None
        if data.get("appointment"):
            try:
                appointment = Appointment.objects.get(pk=uuid.UUID(str(data["appointment"])), clinic=clinic, patient=patient)
            except (Appointment.DoesNotExist, ValueError):
                raise serializers.ValidationError({"appointment": "That appointment was not found."}) from None
        if data.get("invoice"):
            require_feature(self.member, "billing")
            try:
                bills = Invoice.objects.exclude(status=Invoice.Status.DRAFT)
                invoice = bills.get(pk=uuid.UUID(str(data["invoice"])), clinic=clinic, patient=patient)
            except (Invoice.DoesNotExist, ValueError):
                raise serializers.ValidationError({"invoice": "That bill was not found."}) from None
        return appointment, invoice

    # --- writing

    def create(self, request):
        data, clinic = request.data, self.member.clinic
        patient = self.patient(data.get("patient"))
        template = self.template(data["template"]) if data.get("template") else None
        appointment, invoice = self.links(patient, data)
        kind = template.kind if template else data.get("kind", "care")
        if kind not in MessageTemplate.Kind.values:
            raise serializers.ValidationError({"kind": "Choose a care message or a greeting."})
        title = " ".join(str(data.get("title") or (template.name if template else "Message")).split())[:120]
        message = Message.objects.create(
            clinic=clinic,
            patient=patient,
            kind=kind,
            title=title,
            body=self.wording(patient, data.get("body")),
            source=Message.Source.TEMPLATE if template else Message.Source.MANUAL,
            template=template,
            template_name=template.name if template else "",
            template_version=template.version if template else None,
            appointment=appointment,
            invoice=invoice,
            send_after=self.later(data.get("send_after")),
            created_by=request.user,
        )
        self.event("message.create", message)
        return self.one(message, 201)

    def later(self, value):
        if not value:
            return None
        try:
            day = datetime.date.fromisoformat(str(value))
        except ValueError:
            raise serializers.ValidationError({"send_after": "Use a date like 2026-10-06."}) from None
        if day <= self.member.clinic.today():
            raise serializers.ValidationError({"send_after": "Choose a day after today."})
        return day

    def partial_update(self, request, pk=None):
        with transaction.atomic():
            message = self.find(pk)
            if message.status not in Message.OPEN:
                raise serializers.ValidationError("Only a message that has not been sent can be changed.")
            if "body" in request.data:
                body = self.wording(message.patient, request.data["body"])
                if body != message.body and message.status == Message.Status.APPROVED and self.member.role_id not in MESSAGE_APPROVE:
                    # New wording needs a doctor's or the owner's eye again.
                    message.status, message.approved_by, message.approved_at = Message.Status.WAITING, None, None
                message.body = body
            if "send_after" in request.data:
                message.send_after = self.later(request.data["send_after"])
            message.save()
            self.event("message.update", message)
        return self.one(message)

    def change(self, pk, name, work):
        with transaction.atomic():
            message = Message.objects.select_for_update(of=("self",)).select_related("patient").get(pk=self.find(pk).pk)
            more = work(message) or {}
            message.save()
            self.event(f"message.{name}", message)
        return self.one(message, **more)

    @action(detail=True, methods=["post"])
    def approve(self, request, pk=None):
        self.need(MESSAGE_APPROVE)

        def work(message):
            if message.status != Message.Status.WAITING:
                raise serializers.ValidationError("That message is not waiting for approval.")
            self.sendable(message)
            message.status, message.approved_by, message.approved_at = Message.Status.APPROVED, request.user, timezone.now()

        return self.change(pk, "approve", work)

    @action(detail=True, methods=["post"])
    def send(self, request, pk=None):
        """Marks the message sent and answers with the WhatsApp link for the person to open and press Send in."""

        def work(message):
            if message.status == Message.Status.WAITING:
                self.need(MESSAGE_APPROVE)
                message.approved_by, message.approved_at = request.user, timezone.now()
            elif message.status != Message.Status.APPROVED:
                raise serializers.ValidationError("That message has already been dealt with.")
            self.sendable(message)
            number = message.patient.whatsapp_number or message.patient.phone
            message.status, message.to_number = Message.Status.SENT, number
            message.sent_by, message.sent_at, message.send_after = request.user, timezone.now(), None
            return {"link": f"https://wa.me/{whatsapp_digits(number)}?text={quote(message.body, safe='')}"}

        return self.change(pk, "send", work)

    @action(detail=True, methods=["post"])
    def discard(self, request, pk=None):
        def work(message):
            if message.status not in Message.OPEN:
                raise serializers.ValidationError("Only a message that has not been sent can be discarded.")
            message.status, message.closed_by, message.closed_at = Message.Status.DISCARDED, request.user, timezone.now()

        return self.change(pk, "discard", work)

    @action(detail=True, methods=["post"])
    def failed(self, request, pk=None):
        """For a message that turned out not to go, for example because the number is not on WhatsApp."""
        reason = " ".join(str(request.data.get("reason", "")).split())[:200]
        if not reason:
            raise serializers.ValidationError({"reason": "Say in a few words what went wrong."})

        def work(message):
            if message.status != Message.Status.SENT:
                raise serializers.ValidationError("Only a sent message can be marked as failed.")
            message.status, message.failed_reason = Message.Status.FAILED, reason

        return self.change(pk, "failed", work)

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        """A fresh copy of a failed message, back in the queue. The failed one stays as it is."""
        old = self.find(pk)
        if old.status != Message.Status.FAILED:
            raise serializers.ValidationError("Only a failed message can be tried again.")
        approver = self.member.role_id in MESSAGE_APPROVE
        message = Message.objects.create(
            clinic=old.clinic,
            patient=old.patient,
            kind=old.kind,
            title=old.title,
            body=old.body,
            source=old.source,
            template=old.template,
            template_name=old.template_name,
            template_version=old.template_version,
            rule=old.rule,
            campaign=old.campaign,
            appointment=old.appointment,
            invoice=old.invoice,
            status=Message.Status.APPROVED if approver else Message.Status.WAITING,
            approved_by=request.user if approver else None,
            approved_at=timezone.now() if approver else None,
            created_by=request.user,
        )
        self.event("message.retry", message)
        return self.one(message, 201)

    @action(detail=False, methods=["post"])
    def bulk(self, request):
        """Approve selected, or discard selected. Anything that cannot be done is left alone and counted."""
        name, ids = request.data.get("action"), request.data.get("ids")
        if name not in {"approve", "discard"} or not isinstance(ids, list) or not 1 <= len(ids) <= 200:
            raise serializers.ValidationError("Choose the messages and what to do with them.")
        if name == "approve":
            self.need(MESSAGE_APPROVE)
        done = skipped = 0
        for pk in ids:
            try:
                (self.approve if name == "approve" else self.discard)(request, pk=pk)
                done += 1
            except serializers.ValidationError:
                skipped += 1
        return Response({"done": done, "skipped": skipped})

    # --- replies

    @action(detail=False, methods=["post"])
    def replies(self, request):
        """Notes a reply a patient sent on WhatsApp, so the next person sees it without opening the phone."""
        patient = self.patient(request.data.get("patient"), archived=True)
        message = Message.objects.create(
            clinic=self.member.clinic,
            patient=patient,
            title="Reply",
            body=clean_body(request.data.get("body")),
            source=Message.Source.REPLY,
            status=Message.Status.RECEIVED,
            created_by=request.user,
        )
        self.event("message.reply", message)
        return self.one(message, 201)

    @action(detail=True, methods=["post"])
    def handled(self, request, pk=None):
        def work(message):
            if message.status != Message.Status.RECEIVED:
                raise serializers.ValidationError("That reply has already been dealt with.")
            message.status, message.closed_by, message.closed_at = Message.Status.HANDLED, request.user, timezone.now()

        return self.change(pk, "handled", work)


class TemplateViewSet(MessagingViewSet):
    """Wording the clinic reuses. Everyone who works with messages reads it; owner and administrator change it."""

    roles = MESSAGES | {"admin"}

    def row(self, template, used=()):
        return {
            "id": str(template.pk),
            "name": template.name,
            "kind": template.kind,
            "body": template.body,
            "version": template.version,
            "approved": template.approved,
            "standard": bool(template.key),
            "uses": [FIELDS[name] for name in fields_in(template.body)],
            "in_rules": template.pk in used,
            "updated_at": template.updated_at.isoformat(),
        }

    def list(self, request):
        clinic = self.member.clinic
        ensure_standard(clinic)
        used = set(MessageRule.objects.filter(clinic=clinic, enabled=True).values_list("template_id", flat=True))
        templates = MessageTemplate.objects.filter(clinic=clinic)
        return Response(
            {
                "fields": [{"name": name, "label": label} for name, label in FIELDS.items()],
                "rule": CONTENT_RULE,
                "results": [self.row(template, used) for template in templates],
            }
        )

    def fill(self, template, data):
        if "name" in data:
            template.name = str(data["name"])[:80]
        if "kind" in data:
            template.kind = data["kind"]
        if "approved" in data:
            template.approved = data["approved"] is True
        if "body" in data and clean_body(data["body"]) != template.body:
            if template.pk and not template._state.adding:
                template.version += 1
            template.body = str(data["body"])
        template.updated_by = self.request.user
        if not template.name.strip():
            raise serializers.ValidationError({"name": "Give the template a name."})
        if (
            MessageTemplate.objects.filter(clinic=template.clinic, name__iexact=" ".join(template.name.split()))
            .exclude(pk=template.pk)
            .exists()
        ):
            raise serializers.ValidationError({"name": "Another template already has this name."})
        template.save()

    def create(self, request):
        self.need(CLINIC_ADMIN)
        template = MessageTemplate(clinic=self.member.clinic)
        self.fill(template, {"body": "", **request.data})
        self.event("message_template.create", template)
        return Response(self.row(template), status=201)

    def partial_update(self, request, pk=None):
        self.need(CLINIC_ADMIN)
        template = self.template(pk, approved=False)
        self.fill(template, request.data)
        self.event("message_template.update", template)
        return Response(self.row(template))


def rule_words(rule, without_approval):
    """A rule in a sentence, as the list shows it."""
    if not rule.enabled:
        return "Switched off"
    if rule.trigger == MessageRule.Trigger.BEFORE_APPOINTMENT:
        when = f"{rule.days} day{'' if rule.days == 1 else 's'} before"
    elif rule.trigger == MessageRule.Trigger.AFTER_LAST_VISIT:
        when = f"{rule.days} days after last visit" + (", if no follow-up is booked" if rule.only_if_not_booked else "")
    else:
        when = "On the day"
    if rule.template.kind == MessageTemplate.Kind.GREETINGS:
        when += " · greetings consent only"
    ready = without_approval and not rule.needs_approval and rule.trigger == MessageRule.Trigger.BEFORE_APPOINTMENT
    return f"{when} · {'ready to send without approval' if ready else 'needs approval'}"


class RuleViewSet(MessagingViewSet):
    roles = MESSAGES | {"admin"}

    def row(self, rule):
        without_approval = feature_on(self.member.clinic, "auto_reminders")
        return {
            "id": str(rule.pk),
            "name": rule.name,
            "trigger": rule.trigger,
            "days": rule.days,
            "only_if_not_booked": rule.only_if_not_booked,
            "template": {"id": str(rule.template_id), "name": rule.template.name, "approved": rule.template.approved},
            "enabled": rule.enabled,
            "needs_approval": rule.needs_approval,
            "words": rule_words(rule, without_approval),
        }

    def rules(self):
        return MessageRule.objects.filter(clinic=self.member.clinic).select_related("template")

    def list(self, request):
        ensure_standard(self.member.clinic)
        return Response(
            {"without_approval": feature_on(self.member.clinic, "auto_reminders"), "results": [self.row(rule) for rule in self.rules()]}
        )

    def fill(self, rule, data):
        for name in ("enabled", "needs_approval", "only_if_not_booked"):
            if name in data:
                setattr(rule, name, data[name] is True)
        if "name" in data:
            rule.name = str(data["name"])[:80]
        if "trigger" in data and rule._state.adding:
            rule.trigger = data["trigger"]
        if "days" in data:
            try:
                rule.days = int(data["days"])
            except (TypeError, ValueError):
                raise serializers.ValidationError({"days": "Use a whole number of days."}) from None
            if rule.days < 0:
                raise serializers.ValidationError({"days": "Use a whole number of days."})
        if "template" in data:
            rule.template = self.template(data["template"], approved=False)
        if not rule.name.strip():
            raise serializers.ValidationError({"name": "Give the rule a name."})
        if not rule.template_id:
            raise serializers.ValidationError({"template": "Choose the template this rule uses."})
        if self.rules().filter(name__iexact=" ".join(rule.name.split())).exclude(pk=rule.pk).exists():
            raise serializers.ValidationError({"name": "Another rule already has this name."})
        rule.save()

    def create(self, request):
        self.need(CLINIC_ADMIN)
        rule = MessageRule(clinic=self.member.clinic)
        self.fill(rule, request.data)
        self.event("message_rule.create", rule)
        return Response(self.row(rule), status=201)

    def partial_update(self, request, pk=None):
        self.need(CLINIC_ADMIN)
        try:
            rule = self.rules().get(pk=uuid.UUID(str(pk)))
        except (MessageRule.DoesNotExist, ValueError):
            raise serializers.ValidationError("That rule was not found.") from None
        self.fill(rule, request.data)
        self.event("message_rule.update", rule)
        return Response(self.row(rule))


class CampaignViewSet(MessagingViewSet):
    """One greeting or piece of news for a group of patients. The owner prepares it; each message is still approved and sent by a person."""

    def split(self, template, name):
        """(patients who can get it, how many are left out for want of consent or a number)."""
        clinic = self.member.clinic
        if name not in Campaign.AUDIENCES:
            raise serializers.ValidationError({"audience": "Choose who the campaign is for."})
        patients = list(audience(clinic, name, clinic.today()))
        answers = consents([patient.pk for patient in patients])
        ready = [patient for patient in patients if not block_reason(patient, template.kind, answers[patient.pk])]
        return ready, len(patients) - len(ready)

    def list(self, request):
        campaigns = Campaign.objects.filter(clinic=self.member.clinic).select_related("template", "created_by")
        rows = []
        for campaign in campaigns[:100]:
            statuses = list(campaign.messages.values_list("status", flat=True))
            rows.append(
                {
                    "id": str(campaign.pk),
                    "name": campaign.name,
                    "template_name": campaign.template.name,
                    "audience": Campaign.AUDIENCES[campaign.audience],
                    "prepared": campaign.prepared,
                    "left_out": campaign.left_out,
                    "waiting": sum(status in Message.OPEN for status in statuses),
                    "sent": statuses.count(Message.Status.SENT),
                    "created_at": campaign.created_at.isoformat(),
                    "created_by_name": person(campaign.created_by),
                }
            )
        return Response({"audiences": [{"name": name, "label": label} for name, label in Campaign.AUDIENCES.items()], "results": rows})

    @action(detail=False, methods=["post"])
    def count(self, request):
        """How many patients a campaign would reach, before it is prepared."""
        self.need({"owner"})
        ready, left_out = self.split(self.template(request.data.get("template")), request.data.get("audience"))
        return Response({"ready": len(ready), "left_out": left_out})

    def create(self, request):
        self.need({"owner"})
        clinic = self.member.clinic
        template = self.template(request.data.get("template"))
        name = " ".join(str(request.data.get("name", "")).split())[:80]
        if not name:
            raise serializers.ValidationError({"name": "Give the campaign a name."})
        ready, left_out = self.split(template, request.data.get("audience"))
        if not ready:
            raise serializers.ValidationError({"audience": "Nobody in this group can receive this kind of message."})
        if len(ready) > 2000:
            raise serializers.ValidationError({"audience": "That is more than 2,000 messages. Choose a smaller group."})
        with transaction.atomic():
            campaign = Campaign.objects.create(
                clinic=clinic, name=name, template=template, audience=request.data["audience"], left_out=left_out, created_by=request.user
            )
            made = 0
            for patient in ready:
                message = make_message(
                    clinic,
                    patient,
                    template,
                    source=Message.Source.CAMPAIGN,
                    user=request.user,
                    dedupe=f"campaign:{campaign.pk}:{patient.pk}",
                    campaign=campaign,
                    title=name,
                )
                made += bool(message)
            Campaign.objects.filter(pk=campaign.pk).update(prepared=made)
            self.event("message_campaign.create", campaign)
        return Response({"id": str(campaign.pk), "prepared": made, "left_out": left_out}, status=201)


def message_timeline(member, patient, before, limit):
    """A patient's messages as timeline items, for the roles that work with messages."""
    clinic = member.clinic
    if member.role_id not in MESSAGES or not feature_on(clinic, "messages"):
        return []
    items = []
    messages = Message.objects.filter(clinic=clinic, patient=patient).exclude(status=Message.Status.DISCARDED)
    for message in messages.order_by("-created_at")[: limit * 2]:
        moment = message.sent_at or message.created_at
        if before and moment >= before:
            continue
        items.append(
            {
                "kind": "message",
                "id": str(message.pk),
                "at": moment.isoformat(),
                "title": message.title,
                "status": message.status,
                "body": message.body,
            }
        )
    return items[:limit]
