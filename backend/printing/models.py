"""What the clinic prints: how each document is laid out, and a record of what was sent to a printer.

Printing itself happens in the browser's own print window (any printer the computer has, or "Save
as PDF"). A label printer needs nothing special: it is chosen in that window and the page is already
the size of the label.
"""

from django.conf import settings as django_settings
from django.db import models

from records.models import AppendOnlyRecord

# Every setting a layout has, with its starting value. A clinic's saved choices are laid over these.
DEFAULTS = {
    "label": {
        "size": "2x2in",
        "width_mm": 50.8,
        "height_mm": 50.8,
        "dosage_size": "large",
        "show_logo": True,
        "show_address": True,
        "show_phone": True,
        "show_barcode": True,
        "show_next_visit": True,
        # The owner's default: dosage instructions only. A clinic may choose to print the medicine names.
        "show_medicines": False,
    },
    "prescription": {"paper": "A4", "show_medicines": False, "footer_note": ""},
    "invoice": {"show_upi": True, "footer_note": ""},
    "receipt": {"footer_note": ""},
    "card": {"show_phone": True, "show_address": False},
}
LABEL_SIZES = {"2x2in": (50.8, 50.8), "50x25mm": (50.0, 25.0), "58x40mm": (58.0, 40.0)}


class PrintTemplate(AppendOnlyRecord):
    """One saved version of a document's layout. The newest version of each kind is the one in use."""

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    kind = models.CharField(max_length=14, choices=[(kind, kind) for kind in DEFAULTS])
    version = models.PositiveIntegerField()
    settings = models.JSONField()
    saved_by = models.ForeignKey(django_settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["kind", "-version"]
        constraints = [models.UniqueConstraint(fields=["clinic", "kind", "version"], name="unique_template_version")]


def template_in_use(clinic, kind):
    """(version, settings) for a kind of document. Version 0 is the layout the application ships with."""
    saved = PrintTemplate.objects.filter(clinic=clinic, kind=kind).order_by("-version").first()
    chosen = saved.settings if saved and isinstance(saved.settings, dict) else {}
    merged = {**DEFAULTS[kind], **{key: value for key, value in chosen.items() if key in DEFAULTS[kind]}}
    if kind == "label" and merged["size"] in LABEL_SIZES:
        merged["width_mm"], merged["height_mm"] = LABEL_SIZES[merged["size"]]
    return (saved.version if saved else 0), merged


class PrintJob(AppendOnlyRecord):
    """One thing sent to a printer: what, for whom, by whom, and exactly what was on it."""

    class Kind(models.TextChoices):
        LABEL = "label", "Envelope label"
        INVOICE = "invoice", "Invoice"
        RECEIPT = "receipt", "Receipt"
        PRESCRIPTION = "prescription", "Prescription"
        CARD = "card", "Patient card"
        DAY_END = "day_end", "Day-end report"
        DAY_SHEET = "day_sheet", "Day sheet"
        TEST = "test", "Test label"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    kind = models.CharField(max_length=14, choices=Kind.choices)
    title = models.CharField(max_length=120)
    patient = models.ForeignKey("records.Patient", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    encounter = models.ForeignKey("records.Encounter", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    invoice = models.ForeignKey("billing.Invoice", on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    copies = models.PositiveSmallIntegerField(default=1)
    printer = models.CharField(max_length=80, default="This computer's print window")
    # What the page showed, kept as it was: a label's wording is not rebuilt from later changes.
    snapshot = models.JSONField(default=dict, blank=True)
    created_by = models.ForeignKey(django_settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["-created_at", "id"]
        indexes = [models.Index(fields=["clinic", "created_at"])]
