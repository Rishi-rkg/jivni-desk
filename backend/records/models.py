import uuid
from decimal import Decimal
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models
from django.utils import timezone


def not_future(value):
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
    date_of_birth = models.DateField(validators=[not_future])
    gender = models.CharField(max_length=20, choices=Gender.choices)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    archived_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["last_name", "first_name", "id"]
        indexes = [models.Index(fields=["clinic", "last_name", "first_name"])]

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


class PatientNote(AppendOnlyRecord):
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="notes")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
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

    class Meta:
        ordering = ["-occurred_at", "-created_at", "id"]
        indexes = [models.Index(fields=["patient", "occurred_at"])]

    def clean(self):
        if self.occurred_at > timezone.now():
            raise ValidationError({"occurred_at": "An encounter cannot be in the future."})
        if self.follow_up_date and self.follow_up_date < self.occurred_at.date():
            raise ValidationError({"follow_up_date": "Follow-up must be on or after the encounter."})


class Observation(AppendOnlyRecord):
    class Kind(models.TextChoices):
        HEIGHT = "height", "Height"
        WEIGHT = "weight", "Weight"
    patient = models.ForeignKey(Patient, on_delete=models.PROTECT, related_name="observations")
    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="observations")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    value = models.DecimalField(max_digits=7, decimal_places=2, validators=[MinValueValidator(Decimal("0.01"))])
    unit = models.CharField(max_length=5, choices=[("cm", "cm"), ("kg", "kg")])
    measured_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.CheckConstraint(condition=models.Q(value__gt=0), name="positive_observation")]

    def clean(self):
        if self.encounter_id and self.encounter.patient_id != self.patient_id:
            raise ValidationError("Observation and encounter must refer to the same patient.")
        if self.unit != {"height": "cm", "weight": "kg"}.get(self.kind):
            raise ValidationError("Height uses cm; weight uses kg.")


class Prescription(AppendOnlyRecord):
    encounter = models.ForeignKey(Encounter, on_delete=models.PROTECT, related_name="prescriptions")
    prescriber = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT)
    instructions = models.TextField(blank=True)


class PrescriptionItem(AppendOnlyRecord):
    prescription = models.ForeignKey(Prescription, on_delete=models.PROTECT, related_name="items")
    # Snapshot text; a future library reference must never rewrite historical prescriptions.
    medicine_name_snapshot = models.CharField(max_length=200)
    potency = models.CharField(max_length=60, blank=True)
    dose = models.CharField(max_length=100)
    frequency = models.CharField(max_length=100)
    duration = models.CharField(max_length=100, blank=True)
    instructions = models.TextField(blank=True)
    quantity = models.PositiveIntegerField(null=True, blank=True, validators=[MinValueValidator(1)])

    class Meta:
        ordering = ["created_at", "id"]
