"""Bills, payments and the price list.

A bill starts as a draft that can be edited freely. Issuing gives it a number and freezes it: the
lines, the totals and a snapshot of the clinic's and patient's details as they were that day. After
that nothing is edited; payments, refunds, credit notes and a void are added beside it. The
database enforces this too (billing/guards.py).
"""

from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import IntegrityError, models, transaction
from django.utils import timezone

from records.models import AppendOnlyRecord, StableRecord

from . import money

MONEY = {"max_digits": 10, "decimal_places": 2}
NOT_NEGATIVE = [MinValueValidator(Decimal("0"))]
POSITIVE = [MinValueValidator(Decimal("0.01"))]
GST_RATE = [MinValueValidator(Decimal("0")), MaxValueValidator(Decimal("40"))]


class PriceItem(StableRecord):
    class Kind(models.TextChoices):
        SERVICE = "service", "Service"
        PRESCRIBED = "prescribed", "Prescribed"
        SUPPLEMENT = "supplement", "Supplement"
        SHELF = "shelf", "Shelf medicine"
        CONSUMABLE = "consumable", "Consumable"

    class Role(models.TextChoices):
        """The few items a bill made from a visit looks for by purpose rather than by name."""

        NONE = "", "Ordinary item"
        FIRST_VISIT = "consultation_first", "Consultation, first visit"
        FOLLOW_UP = "consultation_follow_up", "Consultation, follow-up"
        PRESCRIBED_WEEK = "prescribed_per_week", "Prescribed medicines, per week"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    name = models.CharField(max_length=200)
    kind = models.CharField(max_length=12, choices=Kind.choices)
    role = models.CharField(max_length=24, choices=Role.choices, blank=True)
    # The price the customer pays, GST included.
    rate = models.DecimalField(**MONEY, validators=NOT_NEGATIVE)
    gst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0, validators=GST_RATE)
    # What a scanner reads on the pack. Empty for services.
    barcode = models.CharField(max_length=64, blank=True)
    active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["kind", "name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["clinic", "barcode"], condition=~models.Q(barcode=""), name="unique_price_item_barcode"),
            models.UniqueConstraint(fields=["clinic", "role"], condition=~models.Q(role=""), name="unique_price_item_role"),
        ]

    def clean(self):
        self.barcode = "".join(self.barcode.split())
        if self.barcode and not (self.barcode.isascii() and self.barcode.isalnum() and len(self.barcode) >= 6):
            raise ValidationError({"barcode": "A barcode is at least 6 letters or digits, with no spaces."})

    def delete(self, *args, **kwargs):
        raise ValidationError("Price list items are switched off, never deleted, so old bills keep their meaning.")


STANDARD_ITEMS = [
    (PriceItem.Role.FIRST_VISIT, "Consultation, first visit", PriceItem.Kind.SERVICE),
    (PriceItem.Role.FOLLOW_UP, "Consultation, follow-up", PriceItem.Kind.SERVICE),
    (PriceItem.Role.PRESCRIBED_WEEK, "Prescribed medicines, per week", PriceItem.Kind.PRESCRIBED),
]


def ensure_standard_items(clinic):
    """The three items a bill made from a visit needs. They start at zero so no price is invented for the clinic."""
    if PriceItem.objects.filter(clinic=clinic).exclude(role="").exists():
        return
    try:
        with transaction.atomic():
            for role, name, kind in STANDARD_ITEMS:
                PriceItem.objects.create(clinic=clinic, name=name, kind=kind, role=role, rate=Decimal("0.00"))
    except IntegrityError:
        # Two people opened the price list for the first time at the same moment; the other one made them.
        pass


class Sequence(models.Model):
    """The last number given out for each kind of document in each financial year."""

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    kind = models.CharField(max_length=10)
    year = models.CharField(max_length=5)
    last = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic", "kind", "year"], name="unique_sequence")]


def next_number(clinic, kind):
    """INV/26-27/0001: numbers run in order within the financial year and are never reused."""
    year = money.financial_year(clinic.today())
    prefix = {"invoice": clinic.invoice_prefix or "INV", "receipt": "R", "credit": "CN"}[kind]
    for _ in range(3):
        try:
            with transaction.atomic():
                sequence, _ = Sequence.objects.select_for_update().get_or_create(clinic=clinic, kind=kind, year=year)
                sequence.last += 1
                sequence.save(update_fields=["last"])
                return f"{prefix}/{year}/{sequence.last:04d}"
        except IntegrityError:
            # Two people issued the year's first bill at the same moment; the second simply tries again.
            continue
    raise RuntimeError("Could not allocate a document number.")


class Invoice(StableRecord):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        ISSUED = "issued", "Issued"
        VOID = "void", "Void"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    # Empty for a walk-in sale: someone buying a product needs no patient record.
    patient = models.ForeignKey("records.Patient", on_delete=models.PROTECT, null=True, blank=True, related_name="invoices")
    encounter = models.ForeignKey("records.Encounter", on_delete=models.PROTECT, null=True, blank=True, related_name="invoices")
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.DRAFT)
    number = models.CharField(max_length=30, blank=True)
    buyer_name = models.CharField(max_length=200, blank=True)
    buyer_phone = models.CharField(max_length=40, blank=True)
    discount = models.DecimalField(**MONEY, default=0, validators=NOT_NEGATIVE)
    discount_reason = models.CharField(max_length=200, blank=True)
    note = models.CharField(max_length=300, blank=True)
    subtotal = models.DecimalField(**MONEY, default=0)
    total = models.DecimalField(**MONEY, default=0)
    tax_total = models.DecimalField(**MONEY, default=0)
    # The clinic's, patient's and visit's details as they were when the bill was issued.
    snapshot = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    issued_at = models.DateTimeField(null=True, blank=True)
    issued_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    voided_at = models.DateTimeField(null=True, blank=True)
    voided_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    void_reason = models.CharField(max_length=300, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at", "id"]
        indexes = [models.Index(fields=["clinic", "status", "issued_at"])]
        constraints = [models.UniqueConstraint(fields=["clinic", "number"], condition=~models.Q(number=""), name="unique_invoice_number")]

    def clean(self):
        if self.patient_id and self.patient.clinic_id != self.clinic_id:
            raise ValidationError({"patient": "Invalid patient."})
        if self.encounter_id and (not self.patient_id or self.encounter.patient_id != self.patient_id):
            raise ValidationError({"encounter": "The visit must belong to the patient on the bill."})

    def delete(self, *args, **kwargs):
        if self.status != self.Status.DRAFT:
            raise ValidationError("An issued bill is never deleted. Void it or add a credit note.")
        with transaction.atomic():
            InvoiceLine.objects.filter(invoice=self).delete()
            return super().delete(*args, **kwargs)

    # --- figures

    def line_tuples(self):
        return [(line.kind, line.quantity, line.rate, line.gst_rate) for line in self.lines.all()]

    def figures(self):
        return money.totals(self.line_tuples(), self.discount)

    def refresh_totals(self):
        figures = self.figures()
        self.subtotal, self.total, self.tax_total = figures["subtotal"], figures["total"], figures["tax_total"]

    @property
    def paid(self):
        """Money received less money given back."""
        total = Decimal("0.00")
        for payment in self.payments.all():
            total += payment.amount if payment.kind == Payment.Kind.PAYMENT else -payment.amount
        return total

    @property
    def credited(self):
        return sum((note.amount for note in self.credit_notes.all()), Decimal("0.00"))

    @property
    def balance(self):
        if self.status != self.Status.ISSUED:
            return self.total if self.status == self.Status.DRAFT else Decimal("0.00")
        return self.total - self.credited - self.paid

    @property
    def state(self):
        """What the status label says: draft, issued, partially_paid, paid, void or refunded."""
        if self.status != self.Status.ISSUED:
            return self.status
        if self.total > 0 and self.credited >= self.total:
            return "refunded"
        if self.paid <= 0:
            return "issued" if self.total - self.credited > 0 else "paid"
        return "paid" if self.balance <= 0 else "partially_paid"


class InvoiceLine(StableRecord):
    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="lines")
    kind = models.CharField(max_length=12, choices=PriceItem.Kind.choices)
    # The text as it was written on the bill; a later change to the price list never rewrites it.
    description = models.CharField(max_length=200)
    quantity = models.DecimalField(max_digits=8, decimal_places=2, default=1, validators=POSITIVE)
    rate = models.DecimalField(**MONEY, validators=NOT_NEGATIVE)
    gst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0, validators=GST_RATE)
    price_item = models.ForeignKey(PriceItem, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    # Where the line came from: "visit" (filled in from the visit), "scan" (a pack was scanned) or typed by hand.
    source = models.CharField(max_length=8, blank=True)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at", "id"]

    @property
    def amount(self):
        return money.line_amount(self.quantity, self.rate)

    @property
    def group(self):
        return money.group_of(self.kind)


class Payment(AppendOnlyRecord):
    class Kind(models.TextChoices):
        PAYMENT = "payment", "Payment"
        REFUND = "refund", "Refund"

    class Method(models.TextChoices):
        CASH = "cash", "Cash"
        UPI = "upi", "UPI"
        CARD = "card", "Card"
        BANK = "bank", "Bank transfer"

    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="payments")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.PAYMENT)
    amount = models.DecimalField(**MONEY, validators=POSITIVE)
    method = models.CharField(max_length=5, choices=Method.choices)
    reference = models.CharField(max_length=100, blank=True)
    note = models.CharField(max_length=300, blank=True)
    received_at = models.DateTimeField(default=timezone.now)
    received_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    receipt_number = models.CharField(max_length=30)

    class Meta:
        ordering = ["received_at", "created_at", "id"]


class CreditNote(AppendOnlyRecord):
    """A correction to an issued bill: the bill stays as it was and this takes an amount off it."""

    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="credit_notes")
    number = models.CharField(max_length=30)
    amount = models.DecimalField(**MONEY, validators=POSITIVE)
    reason = models.CharField(max_length=300)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["created_at", "id"]


class InvoiceEvent(AppendOnlyRecord):
    """One line of an issued bill's history: who did what, when.

    A draft has no rows here (it can still be deleted); its "created" line is read from the bill itself.
    """

    invoice = models.ForeignKey(Invoice, on_delete=models.PROTECT, related_name="events")
    action = models.CharField(max_length=30)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, related_name="+")
    detail = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]


class DayClose(AppendOnlyRecord):
    """The cash counted in the drawer at the end of a day, beside what the bills say it should be."""

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    day = models.DateField()
    expected_cash = models.DecimalField(**MONEY)
    cash_counted = models.DecimalField(**MONEY, validators=NOT_NEGATIVE)
    note = models.CharField(max_length=300, blank=True)
    closed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["-day", "-created_at", "id"]
