import secrets
import uuid
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models
from django.utils import timezone


def not_future(value):
    # Kept only because migration 0001 imports it; Patient.clean now uses the clinic's date.
    if value > timezone.localdate():
        raise ValidationError("Date cannot be in the future.")


class StableRecord(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        instance._original_id = instance.pk
        return instance

    def save(self, *args, **kwargs):
        if hasattr(self, "_original_id") and self.pk != self._original_id:
            raise ValidationError("Record identity is immutable.")
        self.full_clean()
        super().save(*args, **kwargs)
        self._original_id = self.pk


class Patient(StableRecord):
    class Gender(models.TextChoices):
        MALE = "male", "Male"
        FEMALE = "female", "Female"
        OTHER = "other", "Other"
        UNDISCLOSED = "undisclosed", "Not disclosed"

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    first_name = models.CharField(max_length=100)
    middle_name = models.CharField(max_length=100, blank=True)
    last_name = models.CharField(max_length=100, blank=True)
    # Empty only for a patient added in a hurry while booking by phone; the full form asks for it.
    date_of_birth = models.DateField(null=True, blank=True)
    gender = models.CharField(max_length=20, choices=Gender.choices)
    phone = models.CharField(max_length=40, blank=True)
    whatsapp_number = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    referred_by = models.CharField(max_length=120, blank=True)
    # The number on the patient's old paper file, so it can still be found on the shelf.
    old_file_number = models.CharField(max_length=60, blank=True)
    # Something every clinical person must see at once, such as a sensitivity. Clinical roles only.
    alert = models.CharField(max_length=500, blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["last_name", "first_name", "id"]
        indexes = [models.Index(fields=["clinic", "last_name", "first_name"])]

    def clean(self):
        if self.date_of_birth and self.clinic_id and self.date_of_birth > self.clinic.today():
            raise ValidationError({"date_of_birth": "Date cannot be in the future."})

    def save(self, *args, **kwargs):
        if not self._state.adding:
            original = Patient.objects.get(pk=getattr(self, "_original_id", self.pk))
            if original.clinic_id != self.clinic_id:
                raise ValidationError("A patient cannot be transferred between clinics.")
        super().save(*args, **kwargs)


class PatientLinked(StableRecord):
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT)

    class Meta:
        abstract = True


class AppendOnlyQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ValidationError("Clinical records are append-only.")

    def delete(self):
        raise ValidationError("Clinical records are append-only.")


class AppendOnlyRecord(StableRecord):
    objects = AppendOnlyQuerySet.as_manager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Clinical records are append-only; add an amendment.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Clinical records are append-only; archive the patient instead.")


class PatientAddress(PatientLinked):
    patient = models.OneToOneField(Patient, on_delete=models.PROTECT, related_name="address")
    line1 = models.CharField(max_length=200)
    line2 = models.CharField(max_length=200, blank=True)
    city = models.CharField(max_length=100)
    region = models.CharField(max_length=100, blank=True)
    postal_code = models.CharField(max_length=30, blank=True)
    country = models.CharField(max_length=2, help_text="ISO 3166-1 alpha-2 country code")


class PatientPhoto(PatientLinked):
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="photos")
    storage_key = models.CharField(max_length=500, unique=True, editable=False)
    mime_type = models.CharField(max_length=50)
    byte_size = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)


CODE_PREFIX = "PAT-"
# No 0, 1, I, L, O or U: the code is read aloud on the phone and typed from a card.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 10


def new_patient_code():
    return CODE_PREFIX + "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def normalize_patient_code(text):
    """Accept a scanned or typed code with or without the prefix, in any case. None if it cannot be one."""
    value = "".join(str(text).split()).upper()
    if value.startswith(CODE_PREFIX):
        value = value[len(CODE_PREFIX) :]
    if len(value) != CODE_LENGTH or any(char not in CODE_ALPHABET for char in value):
        return None
    return CODE_PREFIX + value


class PatientIdentifier(StableRecord):
    """The short code staff say, print and scan. Random and meaningless without the database.

    A patient has one active code. A lost card is handled by revoking the code and issuing another;
    the code and its patient never change.
    """

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="identifiers")
    code = models.CharField(max_length=20, unique=True, editable=False)
    issued_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["patient"], condition=models.Q(revoked_at__isnull=True), name="one_active_identifier_per_patient"
            )
        ]

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        instance._original = (instance.code, instance.patient_id, instance.revoked_at)
        return instance

    def save(self, *args, **kwargs):
        if hasattr(self, "_original"):
            code, patient_id, revoked_at = self._original
            if (self.code, self.patient_id) != (code, patient_id):
                raise ValidationError("A patient code and its patient cannot be changed.")
            if revoked_at and self.revoked_at != revoked_at:
                raise ValidationError("A revoked patient code cannot be reactivated.")
        super().save(*args, **kwargs)
        self._original = (self.code, self.patient_id, self.revoked_at)

    def delete(self, *args, **kwargs):
        raise ValidationError("Patient codes are revoked, never deleted.")

    @classmethod
    def issue(cls, patient, user=None):
        for _ in range(20):
            code = new_patient_code()
            if not cls.objects.filter(code=code).exists():
                return cls.objects.create(patient=patient, code=code, issued_by=user)
        raise RuntimeError("Could not generate a unique patient code.")


class PatientRevision(AppendOnlyRecord):
    """What changed in a patient's demographics, by whom. Holds old and new values, so it is as
    sensitive as the patient record itself and must be encrypted with it."""

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="revisions")
    changed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    changes = models.JSONField()

    class Meta:
        ordering = ["-created_at", "id"]


class PatientNote(AppendOnlyRecord):
    class Kind(models.TextChoices):
        # A front-desk note with nothing clinical in it ("prefers mornings"). Every role reads it.
        GENERAL = "general", "General note"
        CLINICAL = "clinical", "Clinical note"
        # "Remember about the patient": a hobby, a family member, how they like things explained.
        # For the doctor's eyes only; never printed, sent or shown to other staff.
        REMEMBER = "remember", "Remember about the patient"

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="notes")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.CLINICAL)
    body = models.TextField()
    amends = models.ForeignKey("self", on_delete=models.PROTECT, null=True, blank=True)

    def clean(self):
        if self.amends_id and self.amends.patient_id != self.patient_id:
            raise ValidationError("An amendment must refer to the same patient.")


class Encounter(AppendOnlyRecord):
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="encounters")
    clinician = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    occurred_at = models.DateTimeField(default=timezone.now)
    chief_complaint = models.TextField()
    symptoms = models.TextField(blank=True)
    history = models.TextField(blank=True)
    assessment = models.TextField(blank=True)
    internal_notes = models.TextField(blank=True)
    follow_up_date = models.DateField(null=True, blank=True)
    visit_type = models.CharField(
        max_length=14, blank=True, choices=[("first", "First visit"), ("follow_up", "Follow-up"), ("medicine_only", "Medicine only")]
    )
    # How the patient has been since the last visit.
    progress = models.CharField(
        max_length=14,
        blank=True,
        choices=[
            ("much_better", "Much better"),
            ("better", "Better"),
            ("no_change", "No change"),
            ("worse", "Worse"),
            ("new_complaint", "New complaint"),
        ],
    )

    class Meta:
        ordering = ["-occurred_at", "-created_at", "id"]
        indexes = [models.Index(fields=["patient", "occurred_at"])]

    def clean(self):
        if self.occurred_at > timezone.now():
            raise ValidationError({"occurred_at": "An encounter cannot be in the future."})
        if self.follow_up_date and self.follow_up_date < self.patient.clinic.local_date(self.occurred_at):
            raise ValidationError({"follow_up_date": "Follow-up must be on or after the encounter."})


# What is measured at a visit, and the unit each is written in. The database checks the same pairs.
OBSERVATION_UNITS = {"height": "cm", "weight": "kg", "systolic": "mmHg", "diastolic": "mmHg", "pulse": "bpm"}


class Observation(AppendOnlyRecord):
    class Kind(models.TextChoices):
        HEIGHT = "height", "Height"
        WEIGHT = "weight", "Weight"
        # Blood pressure is two readings, the upper and the lower.
        SYSTOLIC = "systolic", "Blood pressure, upper"
        DIASTOLIC = "diastolic", "Blood pressure, lower"
        PULSE = "pulse", "Pulse"

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="observations")
    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="observations")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    value = models.DecimalField(max_digits=7, decimal_places=2, validators=[MinValueValidator(Decimal("0.01"))])
    unit = models.CharField(max_length=5, choices=[(unit, unit) for unit in ["cm", "kg", "mmHg", "bpm"]])
    measured_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(value__gt=0), name="positive_observation")]

    def clean(self):
        if self.encounter_id and self.encounter.patient_id != self.patient_id:
            raise ValidationError("Observation and encounter must refer to the same patient.")
        if self.unit != OBSERVATION_UNITS.get(self.kind):
            raise ValidationError("That measurement is written in a different unit.")


class Prescription(AppendOnlyRecord):
    """One envelope: one mix of medicines with one dosage line. A visit can have several.

    The medicines in the mix are the items. `dosage_line` is the sentence written for the patient, exactly
    as it was when the envelope was made up; `dosage` keeps the parts it was built from.
    """

    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="prescriptions")
    prescriber = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    instructions = models.TextField(blank=True)
    dosage_line = models.CharField(max_length=200, blank=True)
    dosage = models.JSONField(default=dict, blank=True)
    # Envelope 1, envelope 2: the order the doctor made them up in. Two rows saved in the same instant
    # have the same created_at, so the order is written down rather than inferred.
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at", "id"]


class PrescriptionItem(AppendOnlyRecord):
    prescription = models.ForeignKey(Prescription, on_delete=models.PROTECT, related_name="items")
    # Snapshot text; a future library reference must never rewrite historical prescriptions.
    medicine_name_snapshot = models.CharField(max_length=200)
    potency = models.CharField(max_length=60, blank=True)
    # In an envelope the dosage belongs to the whole mix, so these are optional per medicine.
    dose = models.CharField(max_length=100, blank=True)
    frequency = models.CharField(max_length=100, blank=True)
    duration = models.CharField(max_length=100, blank=True)
    instructions = models.TextField(blank=True)
    quantity = models.PositiveIntegerField(null=True, blank=True, validators=[MinValueValidator(1)])
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at", "id"]


class EncounterProduct(AppendOnlyRecord):
    """A shelf medicine, supplement or consumable advised at a visit. It is not labelled; it goes on the bill.

    The name and price are kept as they were that day. `price_item_id` only remembers which price list
    item was picked, by ID, so the bill can link back to it.
    """

    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="products")
    price_item_id = models.UUIDField(null=True, blank=True)
    name = models.CharField(max_length=200)
    kind = models.CharField(max_length=12, default="supplement")
    quantity = models.DecimalField(max_digits=8, decimal_places=2, default=1, validators=[MinValueValidator(Decimal("0.01"))])
    rate = models.DecimalField(max_digits=10, decimal_places=2, default=0, validators=[MinValueValidator(Decimal("0"))])
    gst_rate = models.DecimalField(max_digits=5, decimal_places=2, default=0, validators=[MinValueValidator(Decimal("0"))])
    note = models.CharField(max_length=200, blank=True)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "created_at", "id"]

    def clean(self):
        if self.kind not in {"supplement", "shelf", "consumable"}:
            raise ValidationError({"kind": "A visit product is a supplement, a shelf medicine or a consumable."})


class EncounterAmendment(AppendOnlyRecord):
    """A correction to a finalised visit. The visit stays as it was written; this is added beside it."""

    class Section(models.TextChoices):
        PRESCRIPTION = "prescription", "Prescription"
        COMPLAINT = "complaint", "Complaint and symptoms"
        MEASUREMENTS = "measurements", "Measurements"
        FOLLOW_UP = "follow_up", "Follow-up date"
        OTHER = "other", "Something else"

    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="amendments")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    section = models.CharField(max_length=14, choices=Section.choices)
    correction = models.TextField()
    reason = models.CharField(max_length=300)

    class Meta:
        ordering = ["created_at", "id"]


class EncounterDraft(StableRecord):
    """A visit being written. It can be changed and thrown away; finalising turns it into a visit that cannot.

    One draft per patient per doctor. Its contents are as clinical as the visit and are seen by doctors only.
    """

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="visit_drafts")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    data = models.JSONField(default=dict, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at", "id"]
        constraints = [models.UniqueConstraint(fields=["patient", "author"], name="one_draft_per_patient_and_doctor")]


class PrescriptionSet(StableRecord):
    """A doctor's saved starting point: envelopes with their medicines and dosage, under a name such as "Teething"."""

    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT)
    name = models.CharField(max_length=100)
    envelopes = models.JSONField()
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["name", "id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "name"], name="unique_prescription_set_name")]


class FamilyLink(StableRecord):
    """Two patients of the same clinic who belong together: a parent and child, a couple, a guardian."""

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="family_links")
    relative = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="+")
    # What the relative is to the patient, in the clinic's own words: "daughter", "mother-in-law".
    relation = models.CharField(max_length=60, blank=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [models.UniqueConstraint(fields=["patient", "relative"], name="unique_family_link")]

    def clean(self):
        if self.patient_id == self.relative_id:
            raise ValidationError("A patient cannot be linked to themselves.")
        if self.patient_id and self.relative_id and self.patient.clinic_id != self.relative.clinic_id:
            raise ValidationError("Both patients must belong to this clinic.")


# Raise this when the wording a patient agrees to changes; each consent row keeps the version it was given under.
CONSENT_WORDING_VERSION = 1


class PatientConsent(AppendOnlyRecord):
    """A patient saying yes or no to a kind of message. The newest row of each kind is what counts."""

    class Kind(models.TextChoices):
        CARE = "care", "Care messages"
        GREETINGS = "greetings", "Greetings and clinic news"

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="consents")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    granted = models.BooleanField()
    wording_version = models.PositiveSmallIntegerField(default=CONSENT_WORDING_VERSION)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["-created_at", "id"]


def current_consent(patient):
    """{"care": row or None, "greetings": row or None}: the newest answer for each kind of message."""
    answers = {kind: None for kind in PatientConsent.Kind.values}
    for row in PatientConsent.objects.filter(patient=patient).select_related("recorded_by").order_by("created_at"):
        answers[row.kind] = row
    return answers


class PatientDocument(AppendOnlyRecord):
    """A lab report or other paper kept with the patient: a PDF or a picture."""

    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="documents")
    title = models.CharField(max_length=200)
    storage_key = models.CharField(max_length=500, unique=True, editable=False)
    mime_type = models.CharField(max_length=50)
    byte_size = models.PositiveIntegerField()
    sha256 = models.CharField(max_length=64)
    uploaded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")

    class Meta:
        ordering = ["-created_at", "id"]
