import uuid
from datetime import timedelta
from decimal import Decimal

from django.core.exceptions import ValidationError
from django.test import TestCase
from django.utils import timezone

from accounts.models import Clinic, Membership, Role, User
from audit.models import AuditEvent
from records.models import Encounter, Observation, Patient, PatientNote, Prescription, PrescriptionItem
from records.security import UnconfiguredEnvelopeEncryption


class ModelTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")

    def test_patient_uuid_is_immutable_after_save_and_reload(self):
        for patient in [self.patient, Patient.objects.get(pk=self.patient.pk)]:
            patient.id = uuid.uuid4()
            with self.assertRaises(ValidationError):
                patient.save()

    def test_future_birth_date_rejected(self):
        self.patient.date_of_birth = timezone.localdate() + timedelta(days=1)
        with self.assertRaises(ValidationError):
            self.patient.save()

    def test_clinic_transfer_rejected(self):
        self.patient.clinic = Clinic.objects.create(name="Another clinic")
        with self.assertRaises(ValidationError):
            self.patient.save()

    def test_observation_patient_and_units_consistent(self):
        encounter = Encounter.objects.create(patient=self.patient, clinician=self.user, chief_complaint="Synthetic symptom")
        other = Patient.objects.create(clinic=self.clinic, first_name="Another", date_of_birth="1990-01-01", gender="other")
        with self.assertRaises(ValidationError):
            Observation.objects.create(patient=other, encounter=encounter, kind="height", unit="cm", value=Decimal("165"))
        with self.assertRaises(ValidationError):
            Observation.objects.create(patient=self.patient, encounter=encounter, kind="height", unit="kg", value=Decimal("165"))
        with self.assertRaises(ValidationError):
            Observation.objects.create(patient=self.patient, encounter=encounter, kind="weight", unit="kg", value=0)

    def test_amendment_must_reference_same_patient(self):
        note = PatientNote.objects.create(patient=self.patient, author=self.user, body="Original")
        other = Patient.objects.create(clinic=self.clinic, first_name="Another", date_of_birth="1990-01-01", gender="other")
        with self.assertRaises(ValidationError):
            PatientNote.objects.create(patient=other, author=self.user, body="Amendment", amends=note)

    def test_prescription_snapshot_is_independent(self):
        encounter = Encounter.objects.create(patient=self.patient, clinician=self.user, chief_complaint="Synthetic symptom")
        rx = Prescription.objects.create(encounter=encounter, prescriber=self.user)
        item = PrescriptionItem.objects.create(
            prescription=rx, medicine_name_snapshot="Synthetic medicine", dose="Recorded dose", frequency="Recorded frequency"
        )
        self.patient.first_name = "Changed"
        self.patient.save()
        item.refresh_from_db()
        self.assertEqual(item.medicine_name_snapshot, "Synthetic medicine")

    def test_audit_is_append_only(self):
        event = AuditEvent.objects.create(clinic=self.clinic, actor=self.user, action="patient.view", resource_id=self.patient.pk)
        with self.assertRaises(ValidationError):
            event.save()
        with self.assertRaises(ValidationError):
            event.delete()
        with self.assertRaises(ValidationError):
            AuditEvent.objects.filter(pk=event.pk).update(action="changed")
        with self.assertRaises(ValidationError):
            AuditEvent.objects.filter(pk=event.pk).delete()

    def test_encryption_placeholder_cannot_silently_store_plaintext(self):
        with self.assertRaises(NotImplementedError):
            UnconfiguredEnvelopeEncryption().encrypt(self.clinic.pk, self.patient.pk, b"synthetic")

    def test_roles_seeded(self):
        self.assertEqual(set(Role.objects.values_list("code", flat=True)), set(Role.Code.values))
