"""WhatsApp messages the clinic prepares and a person sends.

This is step one of the plan: staff-sent. Nothing leaves the computer by itself. A message is prepared
(by a rule, from a template, or written by hand), approved by a doctor or the owner, and then opened in
WhatsApp on the clinic's own device, where a person presses Send. The application cannot know whether a
message was delivered or read, so the most it ever says is "Sent by staff".

Messages never carry a diagnosis, symptoms or medicine names.
"""

import re

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction

from records.models import StableRecord

BODY_LIMIT = 1000

# What a template may insert, and how the editor names it.
FIELDS = {
    "first_name": "first name",
    "name": "full name",
    "doctor": "doctor",
    "clinic_name": "clinic name",
    "clinic_phone": "clinic phone",
    "appointment_date": "appointment date",
    "appointment_time": "appointment time",
    "invoice_number": "invoice number",
    "amount_due": "amount due",
}
TOKEN = re.compile(r"\{([a-z_]+)\}")
# Numbers written without a country code are taken to be Indian ones.
DEFAULT_CALLING_CODE = "91"


def fields_in(text):
    return [name for name in dict.fromkeys(TOKEN.findall(text or "")) if name in FIELDS]


def unknown_fields(text):
    return [name for name in dict.fromkeys(TOKEN.findall(text or "")) if name not in FIELDS]


def render(text, context):
    """Fills a template's fields. Returns the wording and the fields nothing was known for, which stay as written."""
    missing = []

    def fill(match):
        name = match.group(1)
        value = context.get(name)
        if name not in FIELDS:
            return match.group(0)
        if not value:
            if name not in missing:
                missing.append(name)
            return match.group(0)
        return str(value)

    return TOKEN.sub(fill, text or ""), missing


def whatsapp_digits(number):
    """The number as WhatsApp wants it: digits only, country code first. Empty when it cannot be a full number."""
    digits = "".join(char for char in str(number or "") if char.isdigit())
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        digits = DEFAULT_CALLING_CODE + digits
    return digits if 11 <= len(digits) <= 15 else ""


def clean_body(text):
    text = "\n".join(line.rstrip() for line in str(text or "").replace("\r\n", "\n").split("\n")).strip()
    if not text:
        raise ValidationError({"body": "Write the message."})
    if len(text) > BODY_LIMIT:
        raise ValidationError({"body": f"Keep the message under {BODY_LIMIT} characters."})
    return text


class MessageTemplate(StableRecord):
    """Wording the clinic reuses. Each change of wording is a new version; messages keep the wording they were made with."""

    class Kind(models.TextChoices):
        CARE = "care", "Care message"
        GREETINGS = "greetings", "Greeting or clinic news"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    # Set on the templates every clinic starts with, so a rule can find its template whatever it is renamed to.
    key = models.CharField(max_length=30, blank=True)
    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.CARE)
    body = models.TextField()
    version = models.PositiveSmallIntegerField(default=1)
    # A draft is not offered when writing a message and is not used by rules or campaigns.
    approved = models.BooleanField(default=False)
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [models.UniqueConstraint(fields=["clinic", "name"], name="unique_message_template_name")]

    def clean(self):
        self.name = " ".join(self.name.split())
        self.body = clean_body(self.body)
        unknown = unknown_fields(self.body)
        if unknown:
            raise ValidationError({"body": f"There is no field called {{{unknown[0]}}}. Use the Insert buttons."})


class MessageRule(StableRecord):
    """When a message is prepared for a patient without anyone asking."""

    class Trigger(models.TextChoices):
        BEFORE_APPOINTMENT = "before_appointment", "Before an appointment"
        AFTER_LAST_VISIT = "after_last_visit", "After the last visit"
        BIRTHDAY = "birthday", "On the patient's birthday"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    name = models.CharField(max_length=80)
    trigger = models.CharField(max_length=20, choices=Trigger.choices)
    # Days before the appointment, or days after the last visit. Not used for birthdays.
    days = models.PositiveSmallIntegerField(default=1)
    # After a visit: only when no appointment is booked ahead.
    only_if_not_booked = models.BooleanField(default=True)
    template = models.ForeignKey(MessageTemplate, on_delete=models.PROTECT, related_name="rules")
    enabled = models.BooleanField(default=False)
    # Without approval a message is ready to send as soon as it is prepared. Appointment reminders only,
    # and only while the clinic's "Send reminders without approval" switch is on.
    needs_approval = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "name"], name="unique_message_rule_name")]

    def clean(self):
        self.name = " ".join(self.name.split())
        if self.trigger == self.Trigger.BIRTHDAY:
            self.days = 0
        elif not 1 <= self.days <= 730:
            raise ValidationError({"days": "Use between 1 and 730 days."})
        if self.trigger == self.Trigger.BEFORE_APPOINTMENT and self.days > 7:
            raise ValidationError({"days": "A reminder goes at most 7 days before the appointment."})
        if not self.needs_approval and self.trigger != self.Trigger.BEFORE_APPOINTMENT:
            raise ValidationError({"needs_approval": "Only appointment reminders can skip approval."})
        if self.template_id and self.template.clinic_id != self.clinic_id:
            raise ValidationError({"template": "Choose one of this clinic's templates."})


class Campaign(StableRecord):
    """One greeting or piece of clinic news prepared for a group of patients at once."""

    AUDIENCES = {
        "everyone": "Every patient",
        "seen_6_months": "Seen in the last 6 months",
        "seen_12_months": "Seen in the last 12 months",
    }

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    name = models.CharField(max_length=80)
    template = models.ForeignKey(MessageTemplate, on_delete=models.PROTECT, related_name="+")
    audience = models.CharField(max_length=20, choices=list(AUDIENCES.items()))
    # How many messages were prepared, and how many patients were left out for want of consent or a number.
    prepared = models.PositiveIntegerField(default=0)
    left_out = models.PositiveIntegerField(default=0)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["-created_at", "id"]


class Message(StableRecord):
    class Status(models.TextChoices):
        WAITING = "waiting", "Waiting for approval"
        APPROVED = "approved", "Ready to send"
        SENT = "sent", "Sent by staff"
        FAILED = "failed", "Failed"
        DISCARDED = "discarded", "Discarded"
        # A reply a patient sent, noted here by staff.
        RECEIVED = "received", "Reply"
        HANDLED = "handled", "Reply, handled"

    class Source(models.TextChoices):
        RULE = "rule", "Rule"
        TEMPLATE = "template", "Template"
        MANUAL = "manual", "Written by hand"
        CAMPAIGN = "campaign", "Campaign"
        REPLY = "reply", "Reply"

    OPEN = [Status.WAITING, Status.APPROVED]

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    patient = models.ForeignKey("records.Patient", on_delete=models.PROTECT, related_name="messages")
    kind = models.CharField(max_length=10, choices=MessageTemplate.Kind.choices, default=MessageTemplate.Kind.CARE)
    title = models.CharField(max_length=120)
    # The wording as it was approved and sent. A later change to a template never rewrites it.
    body = models.TextField()
    # The number it went to, written down when it was sent.
    to_number = models.CharField(max_length=40, blank=True)
    source = models.CharField(max_length=10, choices=Source.choices, default=Source.MANUAL)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.WAITING)
    template = models.ForeignKey(MessageTemplate, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    template_name = models.CharField(max_length=80, blank=True)
    template_version = models.PositiveSmallIntegerField(null=True, blank=True)
    rule = models.ForeignKey(MessageRule, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    campaign = models.ForeignKey(Campaign, on_delete=models.PROTECT, null=True, blank=True, related_name="messages")
    appointment = models.ForeignKey("scheduling.Appointment", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    invoice = models.ForeignKey("billing.Invoice", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    # What makes a prepared message the only one of its kind, so preparing twice never makes two.
    dedupe = models.CharField(max_length=120, null=True, blank=True)
    # "Send later": not offered for sending before this date.
    send_after = models.DateField(null=True, blank=True)
    # Empty when a rule prepared it.
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    approved_at = models.DateTimeField(null=True, blank=True)
    sent_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    sent_at = models.DateTimeField(null=True, blank=True)
    failed_reason = models.CharField(max_length=200, blank=True)
    # Who discarded it, or who dealt with a reply.
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    closed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "dedupe"], name="unique_message_dedupe")]
        indexes = [models.Index(fields=["clinic", "status"]), models.Index(fields=["patient", "created_at"])]

    def clean(self):
        self.body = clean_body(self.body)
        if self.patient_id and self.patient.clinic_id != self.clinic_id:
            raise ValidationError({"patient": "Choose one of this clinic's patients."})

    @property
    def is_reply(self):
        return self.source == self.Source.REPLY


# The templates and rules every clinic starts with. Plain wording with nothing clinical in it.
STANDARD_TEMPLATES = [
    (
        "appointment_reminder",
        "Appointment reminder",
        "care",
        "Hello {first_name}, this is a reminder of your appointment at {clinic_name} on {appointment_date} at {appointment_time}.",
    ),
    (
        "check_in_30",
        "Follow-up 30 days",
        "care",
        "Hello {first_name},\n\nWe hope you are doing well. It has been about one month since your visit to {clinic_name}.\n\n"
        "Would you like to book a follow-up appointment?\n\n{clinic_name}",
    ),
    (
        "follow_up_90",
        "Follow-up 90 days",
        "care",
        "Hello {first_name},\n\nIt has been about three months since your visit to {clinic_name}. "
        "If you would like a follow-up appointment, reply to this message or call us.\n\n{clinic_name}",
    ),
    ("birthday", "Birthday greeting", "greetings", "Happy birthday, {first_name}! Warm wishes from everyone at {clinic_name}."),
    (
        "invoice",
        "Invoice and receipt",
        "care",
        "Hello {first_name}, thank you for visiting {clinic_name}. Your bill {invoice_number} has {amount_due} left to pay.",
    ),
]
STANDARD_RULES = [
    ("Appointment reminder", "before_appointment", 1, "appointment_reminder", True),
    ("30 day check-in", "after_last_visit", 30, "check_in_30", True),
    ("Birthday greeting", "birthday", 0, "birthday", True),
    ("90 day follow-up", "after_last_visit", 90, "follow_up_90", False),
]


def ensure_standard(clinic):
    """Gives a clinic its starting templates and rules the first time messages are opened. Safe to call again."""
    if MessageTemplate.objects.filter(clinic=clinic).exclude(key="").exists():
        return
    try:
        with transaction.atomic():
            by_key = {}
            for key, name, kind, body in STANDARD_TEMPLATES:
                by_key[key] = MessageTemplate.objects.create(clinic=clinic, key=key, name=name, kind=kind, body=body, approved=True)
            for name, trigger, days, key, enabled in STANDARD_RULES:
                MessageRule.objects.create(clinic=clinic, name=name, trigger=trigger, days=days, template=by_key[key], enabled=enabled)
    except IntegrityError:
        # Two first requests arrived together and the other one made them.
        pass
