from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from records.models import Patient, PatientIdentifier


class ScanTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="billing", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=self.user, role_id="billing")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.code = PatientIdentifier.issue(self.patient).code
        other = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        self.other_code = PatientIdentifier.issue(other).code
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def test_a_patient_card_resolves_for_any_member_of_the_clinic(self):
        for scanned in [self.code, self.code.lower(), self.code[4:], f" {self.code} "]:
            response = self.client.get(f"/api/v1/scan/{scanned}/")
            self.assertEqual(response.status_code, 200, scanned)
            self.assertEqual(response.data["kind"], "patient")
            self.assertEqual(response.data["patient"]["id"], str(self.patient.pk))
            self.assertEqual(response.data["patient"]["identifier"], self.code)
        self.assertEqual(AuditEvent.objects.filter(action="patient.scan", resource_id=self.patient.pk).count(), 4)

    def test_unknown_foreign_and_revoked_codes_are_refused_alike(self):
        revoked = PatientIdentifier.objects.get(code=self.code)
        for scanned in [self.other_code, "8901234567890", "PAT-2222222222", "not a code"]:
            response = self.client.get(f"/api/v1/scan/{scanned}/")
            self.assertEqual(response.status_code, 404, scanned)
            self.assertEqual(response.data["kind"], "unknown")
        from django.utils import timezone

        revoked.revoked_at = timezone.now()
        revoked.save()
        self.assertEqual(self.client.get(f"/api/v1/scan/{self.code}/").status_code, 404)
        events = AuditEvent.objects.filter(action="scan.unknown", outcome="failed")
        self.assertEqual(events.count(), 5)
        # Nothing about what was scanned is kept.
        self.assertFalse(events.exclude(resource_id=None).exists())
        self.assertFalse(events.exclude(resource_type="").exists())

    def test_scanning_needs_a_signed_in_member(self):
        self.client.logout()
        self.assertEqual(self.client.get(f"/api/v1/scan/{self.code}/").status_code, 401)
        outsider = User.objects.create_user(username="outsider", password="synthetic-password")
        self.client.force_login(outsider)
        self.assertEqual(self.client.get(f"/api/v1/scan/{self.code}/").status_code, 403)
