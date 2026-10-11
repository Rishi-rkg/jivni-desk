"""Preparing messages: the wording for one patient, whether it may go, and what the rules call for today.

Nobody is signed in overnight, and patient data is only readable while someone is, so rule messages are
prepared when a person opens Messages or the dashboard. Each prepared message has a key that can exist
only once, so preparing again never makes a second copy.
"""

import calendar
import datetime
import re

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from accounts.features import feature_on
from records import patient_extras
from records.models import Encounter, Patient, PatientConsent, PrescriptionItem
from scheduling.models import Appointment, sessions_on

from .models import Message, MessageRule, MessageTemplate, ensure_standard, render, whatsapp_digits

# Rules are looked at no more often than this, however many screens ask.
PREPARE_EVERY_SECONDS = 600


def person(user):
    return (user.get_full_name() or user.username) if user else ""


def full_name(patient):
    return " ".join(part for part in [patient.first_name, patient.middle_name, patient.last_name] if part)


def amount_words(clinic, amount):
    symbol = "₹" if clinic.currency == "INR" else f"{clinic.currency} "
    return f"{symbol}{amount:,.2f}"


def next_appointment(clinic, patient):
    return (
        Appointment.objects.filter(
            clinic=clinic, patient=patient, day__gte=clinic.today(), status=Appointment.Status.BOOKED, time__isnull=False
        )
        .select_related("doctor")
        .order_by("day", "time")
        .first()
    )


def latest_invoice(clinic, patient):
    from billing.models import Invoice

    return Invoice.objects.filter(clinic=clinic, patient=patient, status=Invoice.Status.ISSUED).order_by("-issued_at").first()


def context_for(clinic, patient, appointment=None, invoice=None):
    """What a template's fields stand for, for one patient. Nothing clinical is ever put in here."""
    doctor = appointment.doctor if appointment and appointment.doctor_id else None
    if not doctor:
        last = Encounter.objects.filter(patient=patient).select_related("clinician").order_by("-occurred_at").first()
        doctor = last.clinician if last else None
    context = {
        "first_name": patient.first_name,
        "name": full_name(patient),
        "doctor": person(doctor),
        "clinic_name": clinic.name,
        "clinic_phone": clinic.phone,
    }
    if appointment:
        context["appointment_date"] = appointment.day.strftime("%a %d %b %Y")
        context["appointment_time"] = appointment.time.strftime("%H:%M") if appointment.time else ""
    if invoice and invoice.number:
        context["invoice_number"] = invoice.number
        context["amount_due"] = amount_words(clinic, max(invoice.balance, 0))
    return context


def consents(patient_ids):
    """{patient id: {"care": newest answer or None, "greetings": ...}} in one query."""
    answers = {patient_id: {kind: None for kind in PatientConsent.Kind.values} for patient_id in patient_ids}
    for row in PatientConsent.objects.filter(patient_id__in=list(answers)).order_by("created_at"):
        answers[row.patient_id][row.kind] = row
    return answers


def block_reason(patient, kind, consent):
    """Why a message of this kind cannot go to this patient now, in plain words. Empty when it can."""
    if patient.archived_at:
        return "The patient is archived."
    number = patient.whatsapp_number or patient.phone
    if not number:
        return "No WhatsApp number on the patient's record."
    if not whatsapp_digits(number):
        return "The WhatsApp number looks incomplete."
    answer = consent.get(kind) if consent else None
    if not answer or not answer.granted:
        return "No care-message consent." if kind == "care" else "No consent to greetings and clinic news."
    return ""


def medicine_named(patient, text):
    """The first medicine from the patient's own prescriptions that the wording names, or an empty string.

    A message must never carry a medicine name. This catches the likeliest slip: copying one from the record.
    """
    padded = " " + " ".join(re.findall(r"[a-z]+", str(text).lower())) + " "
    names = PrescriptionItem.objects.filter(prescription__encounter__patient=patient).values_list("medicine_name_snapshot", flat=True)
    for name in dict.fromkeys(names):
        words = [word for word in re.split(r"[^a-z0-9]+", name.lower()) if word.isalpha()]
        whole = " ".join(words)
        if len(whole) >= 4 and f" {whole} " in padded:
            return name
        if words and len(words[0]) >= 5 and f" {words[0]} " in padded:
            return name
    return ""


def make_message(clinic, patient, template, *, source, status=Message.Status.WAITING, user=None, dedupe=None, **links):
    """A message from a template for one patient, or None when it already exists or a field cannot be filled."""
    body, missing = render(template.body, context_for(clinic, patient, links.get("appointment"), links.get("invoice")))
    if missing:
        return None
    if dedupe and Message.objects.filter(clinic=clinic, dedupe=dedupe).exists():
        return None
    try:
        with transaction.atomic():
            return Message.objects.create(
                clinic=clinic,
                patient=patient,
                kind=template.kind,
                title=links.pop("title", None) or template.name,
                body=body,
                source=source,
                status=status,
                template=template,
                template_name=template.name,
                template_version=template.version,
                dedupe=dedupe,
                created_by=user,
                **links,
            )
    except (IntegrityError, ValidationError):
        # Someone else prepared the same message a moment ago.
        return None


def reminder_days(clinic, today, count):
    """Tomorrow through the count-th working day ahead, so a Saturday prepares Monday's reminders."""
    days, day, working = [], today, 0
    for _ in range(14):
        day += datetime.timedelta(days=1)
        days.append(day)
        if sessions_on(clinic, day):
            working += 1
        if working >= count:
            break
    return days


def before_appointment(rule, clinic, today):
    appointments = Appointment.objects.filter(
        clinic=clinic,
        day__in=reminder_days(clinic, today, rule.days),
        status=Appointment.Status.BOOKED,
        remind=True,
        time__isnull=False,
        patient__archived_at__isnull=True,
    ).select_related("patient", "doctor")
    for appointment in appointments:
        yield appointment.patient, f"remind:{appointment.pk}:{appointment.day}:{appointment.time:%H%M}", {"appointment": appointment}


def after_last_visit(rule, clinic, today):
    # A week's grace, so a day when nobody opened the application does not lose the message.
    newest, oldest = today - datetime.timedelta(days=rule.days), today - datetime.timedelta(days=rule.days + 6)
    start = datetime.datetime.combine(oldest, datetime.time.min, tzinfo=clinic.tzinfo)
    end = datetime.datetime.combine(newest + datetime.timedelta(days=1), datetime.time.min, tzinfo=clinic.tzinfo)
    patients = patient_extras.with_visit_dates(Patient.objects.filter(clinic=clinic, archived_at__isnull=True)).filter(
        last_visit_at__gte=start, last_visit_at__lt=end
    )
    booked = set()
    if rule.only_if_not_booked:
        booked = set(
            Appointment.objects.filter(
                clinic=clinic, day__gte=today, status__in=[Appointment.Status.BOOKED, Appointment.Status.ARRIVED]
            ).values_list("patient_id", flat=True)
        )
    for patient in patients:
        if patient.pk not in booked:
            yield patient, f"after:{rule.pk}:{patient.pk}:{clinic.local_date(patient.last_visit_at)}", {}


def birthday(rule, clinic, today):
    dates = Q(date_of_birth__month=today.month, date_of_birth__day=today.day)
    if (today.month, today.day) == (2, 28) and not calendar.isleap(today.year):
        dates |= Q(date_of_birth__month=2, date_of_birth__day=29)
    for patient in Patient.objects.filter(dates, clinic=clinic, archived_at__isnull=True):
        yield patient, f"birthday:{patient.pk}:{today.year}", {}


CANDIDATES = {
    MessageRule.Trigger.BEFORE_APPOINTMENT: before_appointment,
    MessageRule.Trigger.AFTER_LAST_VISIT: after_last_visit,
    MessageRule.Trigger.BIRTHDAY: birthday,
}


def prepare(clinic, force=False):
    """Prepares the messages today's rules call for and returns how many were made. Safe to run any number of times."""
    if not feature_on(clinic, "messages"):
        return 0
    today = clinic.today()
    if not force and not cache.add(f"messages-prepared:{clinic.pk}:{today}", 1, PREPARE_EVERY_SECONDS):
        return 0
    ensure_standard(clinic)
    without_approval = feature_on(clinic, "auto_reminders")
    made = 0
    for rule in MessageRule.objects.filter(clinic=clinic, enabled=True, template__approved=True).select_related("template"):
        found = list(CANDIDATES[rule.trigger](rule, clinic, today))
        answers = consents([patient.pk for patient, _, _ in found])
        ready = without_approval and not rule.needs_approval and rule.trigger == MessageRule.Trigger.BEFORE_APPOINTMENT
        for patient, dedupe, links in found:
            # A greeting for someone who has not agreed to greetings is simply not prepared.
            consent = answers[patient.pk].get(rule.template.kind)
            if rule.template.kind == MessageTemplate.Kind.GREETINGS and not (consent and consent.granted):
                continue
            message = make_message(
                clinic,
                patient,
                rule.template,
                source=Message.Source.RULE,
                status=Message.Status.APPROVED if ready else Message.Status.WAITING,
                dedupe=dedupe,
                rule=rule,
                title=rule.name,
                **links,
            )
            if not message:
                continue
            made += 1
            if message.status == Message.Status.APPROVED:
                Message.objects.filter(pk=message.pk).update(approved_at=timezone.now())
            if links.get("appointment"):
                # Not through save(): preparing a reminder must not re-check the appointment's time.
                Appointment.objects.filter(pk=links["appointment"].pk).update(reminder_at=timezone.now())
    return made


def audience(clinic, name, today):
    """The patients a campaign is for, before consent and numbers are looked at."""
    patients = Patient.objects.filter(clinic=clinic, archived_at__isnull=True)
    if name == "everyone":
        return patients
    days = 183 if name == "seen_6_months" else 365
    since = datetime.datetime.combine(today - datetime.timedelta(days=days), datetime.time.min, tzinfo=clinic.tzinfo)
    return patient_extras.with_visit_dates(patients).filter(last_visit_at__gte=since)
