"""Phase 2 groundwork: patient codes and scan lookup, WhatsApp number, duplicate check, demographic history."""

from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from records.models import CODE_ALPHABET, Patient, PatientIdentifier, PatientRevision, new_patient_code, normalize_patient_code


class PatientCodeModelTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")

    def test_codes_are_opaque_and_well_formed(self):
        codes = {new_patient_code() for _ in range(200)}
        self.assertEqual(len(codes), 200)
        for code in codes:
            self.assertRegex(code, rf"^PAT-[{CODE_ALPHABET}]{{10}}$")
        self.assertFalse(set("01ILOU") & set(CODE_ALPHABET))

    def test_normalization_accepts_what_people_type_and_scan(self):
        self.assertEqual(normalize_patient_code(" pat-w8kq3g7dp9 "), "PAT-W8KQ3G7DP9")
        self.assertEqual(normalize_patient_code("W8KQ3G7DP9"), "PAT-W8KQ3G7DP9")
        for bad in ["", "PAT-", "PAT-W8KQ3G7DP", "PAT-W8KQ3G7DP0", "Synthetic", "PAT-W8KQ3G7DP9X"]:
            self.assertIsNone(normalize_patient_code(bad), bad)

    def test_one_active_code_and_no_rewriting(self):
        identifier = PatientIdentifier.issue(self.patient)
        with self.assertRaises(ValidationError):
            PatientIdentifier.issue(self.patient)
        loaded = PatientIdentifier.objects.get(pk=identifier.pk)
        loaded.code = new_patient_code()
        with self.assertRaises(ValidationError):
            loaded.save()
        with self.assertRaises(ValidationError):
            identifier.delete()

    def test_revoked_code_stays_revoked(self):
        from django.utils import timezone

        identifier = PatientIdentifier.issue(self.patient)
        identifier.revoked_at = timezone.now()
        identifier.save()
        loaded = PatientIdentifier.objects.get(pk=identifier.pk)
        loaded.revoked_at = None
        with self.assertRaises(ValidationError):
            loaded.save()
        PatientIdentifier.issue(self.patient)

    def test_revisions_are_append_only(self):
        user = User.objects.create_user(username="doctor", password="synthetic-password")
        revision = PatientRevision.objects.create(patient=self.patient, changed_by=user, changes={"phone": {"from": "", "to": "1"}})
        with self.assertRaises(ValidationError):
            revision.save()
        with self.assertRaises(ValidationError):
            revision.delete()
        with self.assertRaises(ValidationError):
            PatientRevision.objects.filter(pk=revision.pk).delete()


class PatientIdentityAPITests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="reception", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="reception")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()
        self.patient = self.register(first_name="Anita", last_name="Synthetic", date_of_birth="1984-03-02", phone="5550142")
        self.other = Patient.objects.create(
            clinic=self.other_clinic, first_name="Anita", last_name="Synthetic", date_of_birth="1984-03-02", gender="other", phone="5550142"
        )
        self.other_code = PatientIdentifier.issue(self.other).code

    def register(self, **fields):
        response = self.client.post("/api/v1/patients/", {"gender": "female", **fields}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        return response.data

    # --- codes

    def test_registration_issues_a_code_and_lists_show_it(self):
        self.assertRegex(self.patient["identifier"], r"^PAT-[2-9A-Z]{10}$")
        listed = self.client.get("/api/v1/patients/").data["results"]
        self.assertEqual([row["identifier"] for row in listed], [self.patient["identifier"]])

    def test_search_by_code_with_or_without_prefix(self):
        code = self.patient["identifier"]
        for text in [code, code.lower(), code[4:]]:
            self.assertEqual(self.client.get("/api/v1/patients/", {"search": text}).data["count"], 1, text)
        self.assertEqual(self.client.get("/api/v1/patients/", {"search": self.other_code}).data["count"], 0)

    def test_scan_opens_only_this_clinics_active_codes(self):
        response = self.client.get(f"/api/v1/patients/by-code/{self.patient['identifier'].lower()}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], self.patient["id"])
        self.assertTrue(AuditEvent.objects.filter(action="patient.scan", outcome="success", resource_id=self.patient["id"]).exists())
        for code in [self.other_code, "PAT-2222222222", "not-a-code"]:
            self.assertEqual(self.client.get(f"/api/v1/patients/by-code/{code}/").status_code, 404, code)
        failed = AuditEvent.objects.filter(action="patient.scan", outcome="failed")
        self.assertEqual(failed.count(), 3)
        self.assertFalse(failed.exclude(resource_id=None).exists())

    def test_reissue_revokes_the_old_code_at_once(self):
        old = self.patient["identifier"]
        response = self.client.post(f"/api/v1/patients/{self.patient['id']}/reissue-code/")
        self.assertEqual(response.status_code, 200, response.data)
        new = response.data["identifier"]
        self.assertNotEqual(new, old)
        self.assertEqual(self.client.get(f"/api/v1/patients/by-code/{old}/").status_code, 404)
        self.assertEqual(self.client.get(f"/api/v1/patients/by-code/{new}/").status_code, 200)
        self.assertEqual(PatientIdentifier.objects.filter(patient_id=self.patient["id"]).count(), 2)
        self.assertTrue(AuditEvent.objects.filter(action="patient.reissue_code", resource_id=self.patient["id"]).exists())

    def test_reissue_needs_a_demographics_role_and_the_right_clinic(self):
        self.assertEqual(self.client.post(f"/api/v1/patients/{self.other.pk}/reissue-code/").status_code, 404)
        self.member.role_id = "billing"
        self.member.save()
        self.assertEqual(self.client.post(f"/api/v1/patients/{self.patient['id']}/reissue-code/").status_code, 403)
        self.assertEqual(self.client.get(f"/api/v1/patients/by-code/{self.patient['identifier']}/").status_code, 200)

    # --- WhatsApp number

    def test_whatsapp_number_is_stored_and_searchable(self):
        patient = self.register(first_name="Vikram", date_of_birth="1979-01-01", phone="5550100", whatsapp_number="5550199")
        self.assertEqual(patient["whatsapp_number"], "5550199")
        self.assertEqual(self.client.get("/api/v1/patients/", {"search": "5550199"}).data["count"], 1)

    # --- duplicate check

    def check(self, **fields):
        response = self.client.post("/api/v1/patients/check-duplicates/", fields, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data["matches"]

    def test_duplicate_check_explains_matches_and_stays_in_the_clinic(self):
        matches = self.check(first_name="anita", last_name="SYNTHETIC", date_of_birth="1984-03-02", phone="5550142")
        self.assertEqual([m["id"] for m in matches], [self.patient["id"]])
        self.assertEqual(matches[0]["reasons"], ["same phone number", "same first name and date of birth", "same name"])
        self.assertEqual(self.check(first_name="Anita", date_of_birth="1990-01-01"), [])
        self.assertEqual(self.check(phone="5550142")[0]["reasons"], ["same phone number"])
        self.assertEqual(self.check(), [])

    def test_duplicate_check_never_puts_details_in_the_url_or_audit(self):
        self.assertEqual(self.client.get("/api/v1/patients/check-duplicates/").status_code, 405)
        self.check(first_name="Anita", last_name="Synthetic")
        event = AuditEvent.objects.get(action="patient.duplicate_check")
        self.assertIsNone(event.resource_id)

    # --- demographic history

    def test_edits_are_recorded_with_old_and_new_values(self):
        url = f"/api/v1/patients/{self.patient['id']}/"
        self.client.patch(
            url, {"phone": "5550999", "address": {"line1": "1 Synthetic St", "city": "Test City", "country": "in"}}, format="json"
        )
        self.client.patch(url, {"phone": "5550999"}, format="json")  # nothing changed: no revision
        self.client.patch(url, {"address": None, "last_name": "Renamed"}, format="json")
        revisions = self.client.get(url + "revisions/").data["revisions"]
        self.assertEqual(len(revisions), 2)
        newest, oldest = revisions
        self.assertEqual(oldest["changes"]["phone"], {"from": "5550142", "to": "5550999"})
        self.assertEqual(oldest["changes"]["address.city"], {"from": "", "to": "Test City"})
        self.assertEqual(oldest["changes"]["address.country"], {"from": "", "to": "IN"})
        # The address row is gone, but what it said is preserved.
        self.assertEqual(newest["changes"]["address.line1"], {"from": "1 Synthetic St", "to": ""})
        self.assertEqual(newest["changes"]["last_name"], {"from": "Synthetic", "to": "Renamed"})
        self.assertEqual(newest["changed_by_name"], "reception")
        self.assertTrue(AuditEvent.objects.filter(action="patient.revisions", resource_id=self.patient["id"]).exists())

    def test_rejected_edit_leaves_no_revision(self):
        url = f"/api/v1/patients/{self.patient['id']}/"
        self.assertEqual(self.client.patch(url, {"date_of_birth": "2999-01-01"}, format="json").status_code, 400)
        self.assertEqual(PatientRevision.objects.count(), 0)

    def test_revisions_are_clinic_scoped(self):
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.other.pk}/revisions/").status_code, 404)
