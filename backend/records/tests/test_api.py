import io
from datetime import timedelta

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from records.models import Encounter, Observation, Patient, Prescription, PrescriptionItem


class APITests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.other = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def patient_data(self):
        return {
            "first_name": "Test",
            "middle_name": "Only",
            "last_name": "Patient",
            "date_of_birth": "2000-02-29",
            "gender": "female",
            "address": {"line1": "1 Synthetic St", "city": "Test City", "country": "us"},
        }

    def encounter_data(self):
        return {
            "patient": str(self.patient.pk),
            "chief_complaint": "Synthetic complaint",
            "observations": [{"kind": "height", "value": "172.50", "unit": "cm"}, {"kind": "weight", "value": "70.25", "unit": "kg"}],
            "prescriptions": [
                {
                    "instructions": "Synthetic only",
                    "items": [
                        {
                            "medicine_name_snapshot": "Test medicine",
                            "potency": "Test potency",
                            "dose": "Test dose",
                            "frequency": "Test frequency",
                            "quantity": 1,
                        }
                    ],
                }
            ],
        }

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def test_unauthenticated_access_denied(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/v1/patients/").status_code, 401)

    def test_create_patient_nested_address_audit(self):
        response = self.client.post("/api/v1/patients/", self.patient_data(), format="json")
        self.assertEqual(response.status_code, 201, response.data)
        patient = Patient.objects.get(pk=response.data["id"])
        self.assertEqual(patient.clinic, self.clinic)
        self.assertEqual(patient.address.country, "US")
        self.assertTrue(AuditEvent.objects.filter(action="patient.create", resource_id=patient.pk).exists())

    def test_future_and_invalid_dates_rejected(self):
        for date in ["2001-02-29", str(timezone.localdate() + timedelta(days=1))]:
            payload = self.patient_data()
            payload["date_of_birth"] = date
            self.assertEqual(self.client.post("/api/v1/patients/", payload, format="json").status_code, 400)

    def test_clinic_isolation_list_detail_and_write(self):
        response = self.client.get("/api/v1/patients/")
        self.assertEqual([p["id"] for p in response.data["results"]], [str(self.patient.pk)])
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.other.pk}/").status_code, 404)
        self.assertEqual(self.client.patch(f"/api/v1/patients/{self.other.pk}/", {"first_name": "Changed"}, format="json").status_code, 404)
        payload = self.encounter_data()
        payload["patient"] = str(self.other.pk)
        self.assertEqual(self.client.post("/api/v1/encounters/", payload, format="json").status_code, 400)
        self.assertEqual(Encounter.objects.count(), 0)

    def test_search_and_read_audit_do_not_capture_search_content(self):
        response = self.client.get("/api/v1/patients/?search=Synthetic")
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(self.client.get("/api/v1/patients/?search=no-such-person").data["count"], 0)
        self.client.get(f"/api/v1/patients/{self.patient.pk}/")
        self.assertTrue(AuditEvent.objects.filter(action="patient.view", resource_id=self.patient.pk).exists())
        self.assertFalse(AuditEvent.objects.filter(action__icontains="Synthetic").exists())

    def test_demographic_update_preserves_identity(self):
        response = self.client.patch(
            f"/api/v1/patients/{self.patient.pk}/",
            {"first_name": "Updated", "id": str(self.other.pk), "clinic": str(self.other_clinic.pk)},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["id"], str(self.patient.pk))
        self.patient.refresh_from_db()
        self.assertEqual(self.patient.clinic, self.clinic)

    def test_create_encounter_observations_prescriptions_atomically(self):
        response = self.client.post("/api/v1/encounters/", self.encounter_data(), format="json")
        self.assertEqual(response.status_code, 201, response.data)
        encounter = Encounter.objects.get(pk=response.data["id"])
        self.assertEqual(encounter.clinician, self.user)
        self.assertEqual(encounter.observations.count(), 2)
        self.assertEqual(PrescriptionItem.objects.get().medicine_name_snapshot, "Test medicine")
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.patient.pk}/timeline/").data["encounters"][0]["id"], str(encounter.pk))

    def test_bad_nested_item_rolls_back_entire_encounter(self):
        payload = self.encounter_data()
        payload["prescriptions"][0]["items"][0]["quantity"] = 0
        self.assertEqual(self.client.post("/api/v1/encounters/", payload, format="json").status_code, 400)
        self.assertEqual(Encounter.objects.count(), 0)
        self.assertEqual(Observation.objects.count(), 0)
        self.assertEqual(Prescription.objects.count(), 0)

    def test_model_validation_error_rolls_back_and_returns_400(self):
        payload = self.encounter_data()
        payload["occurred_at"] = (timezone.now() + timedelta(days=1)).isoformat()
        self.assertEqual(self.client.post("/api/v1/encounters/", payload, format="json").status_code, 400)
        self.assertEqual(Encounter.objects.count(), 0)

    def test_invalid_observation_unit_rejected(self):
        payload = self.encounter_data()
        payload["observations"][0]["unit"] = "kg"
        self.assertEqual(self.client.post("/api/v1/encounters/", payload, format="json").status_code, 400)

    def test_clinical_roles_are_separate_from_demographic_roles(self):
        for role in ["reception", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get(f"/api/v1/patients/{self.patient.pk}/").status_code, 200)
            self.assertEqual(self.client.get("/api/v1/encounters/").status_code, 403)
            self.assertEqual(self.client.get("/api/v1/notes/").status_code, 403)
            self.assertEqual(self.client.get(f"/api/v1/patients/{self.patient.pk}/timeline/").status_code, 403)
            self.assertEqual(self.client.post("/api/v1/encounters/", self.encounter_data(), format="json").status_code, 403)
        self.role("assistant")
        self.assertEqual(self.client.get("/api/v1/encounters/").status_code, 200)
        self.assertEqual(self.client.post("/api/v1/encounters/", self.encounter_data(), format="json").status_code, 403)

    def test_billing_cannot_create_or_update_patient(self):
        self.role("billing")
        self.assertEqual(self.client.post("/api/v1/patients/", self.patient_data(), format="json").status_code, 403)
        self.assertEqual(
            self.client.patch(f"/api/v1/patients/{self.patient.pk}/", {"first_name": "Changed"}, format="json").status_code, 403
        )

    def test_revoked_membership_denies_access(self):
        self.member.is_active = False
        self.member.save()
        self.assertEqual(self.client.get("/api/v1/patients/").status_code, 403)

    def test_records_cannot_be_deleted_or_encounters_overwritten(self):
        encounter = Encounter.objects.create(patient=self.patient, clinician=self.user, chief_complaint="Test")
        self.assertEqual(self.client.delete(f"/api/v1/patients/{self.patient.pk}/").status_code, 405)
        self.assertEqual(
            self.client.patch(f"/api/v1/encounters/{encounter.pk}/", {"chief_complaint": "Overwrite"}, format="json").status_code, 405
        )

    def test_notes_and_amendments_are_preserved(self):
        response = self.client.post("/api/v1/notes/", {"patient": str(self.patient.pk), "body": "Synthetic note"}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        amendment = self.client.post(
            "/api/v1/notes/", {"patient": str(self.patient.pk), "body": "Correction", "amends": response.data["id"]}, format="json"
        )
        self.assertEqual(amendment.status_code, 201)
        self.assertEqual(self.client.get("/api/v1/notes/").data["count"], 2)

    def test_photo_is_validated_private_and_clinic_scoped(self):
        buffer = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buffer, "PNG")
        image = SimpleUploadedFile("private-location.png", buffer.getvalue(), content_type="image/png")
        response = self.client.post(f"/api/v1/patients/{self.patient.pk}/photos/", {"photo": image}, format="multipart")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertNotIn("storage_key", response.data)
        photo_id = response.data["id"]
        response = self.client.get(f"/api/v1/photos/{photo_id}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store, private")
        # Consume Django's test-client streaming wrapper; calling close() directly
        # emits request_finished and can close the surrounding test transaction.
        self.assertTrue(b"".join(response.streaming_content))
        session = self.client.session
        Membership.objects.create(clinic=self.other_clinic, user=self.user, role_id="clinician")
        session["clinic_id"] = str(self.other_clinic.pk)
        session.save()
        self.assertEqual(self.client.get(f"/api/v1/photos/{photo_id}/").status_code, 404)

    def test_fake_photo_rejected(self):
        image = SimpleUploadedFile("bad.png", b"not an image", content_type="image/png")
        self.assertEqual(
            self.client.post(f"/api/v1/patients/{self.patient.pk}/photos/", {"photo": image}, format="multipart").status_code, 400
        )

    def test_invalid_patient_filter_is_400(self):
        self.assertEqual(self.client.get("/api/v1/encounters/?patient=not-uuid").status_code, 400)


class AuthenticationTests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.client = APIClient(enforce_csrf_checks=True)

    def token(self):
        return self.client.get("/api/v1/auth/csrf/").json()["csrf_token"]

    def test_login_requires_csrf_and_issues_session(self):
        data = {"username": "doctor", "password": "synthetic-password"}
        self.assertEqual(self.client.post("/api/v1/auth/login/", data, format="json").status_code, 403)
        response = self.client.post("/api/v1/auth/login/", data, format="json", HTTP_X_CSRFTOKEN=self.token())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["clinic_id"], str(self.clinic.pk))
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 200)
        self.assertEqual(self.client.post("/api/v1/patients/", {}, format="json").status_code, 403)
        self.assertEqual(
            self.client.post("/api/v1/auth/logout/", {}, format="json", HTTP_X_CSRFTOKEN=response.json()["csrf_token"]).status_code, 200
        )
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 401)

    def test_failed_login_is_generic_and_throttled(self):
        for _ in range(5):
            self.assertEqual(
                self.client.post(
                    "/api/v1/auth/login/", {"username": "doctor", "password": "bad"}, format="json", HTTP_X_CSRFTOKEN=self.token()
                ).status_code,
                401,
            )
        self.assertEqual(
            self.client.post(
                "/api/v1/auth/login/", {"username": "doctor", "password": "bad"}, format="json", HTTP_X_CSRFTOKEN=self.token()
            ).status_code,
            429,
        )

    def test_select_clinic_checks_membership(self):
        self.client.force_login(self.user)
        other = Clinic.objects.create(name="Other")
        self.assertEqual(
            self.client.post(
                "/api/v1/auth/clinic/", {"clinic_id": str(other.pk)}, format="json", HTTP_X_CSRFTOKEN=self.token()
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post("/api/v1/auth/clinic/", {"clinic_id": "bad"}, format="json", HTTP_X_CSRFTOKEN=self.token()).status_code, 403
        )
        Membership.objects.create(clinic=other, user=self.user, role_id="reception")
        self.assertEqual(
            self.client.post(
                "/api/v1/auth/clinic/", {"clinic_id": str(other.pk)}, format="json", HTTP_X_CSRFTOKEN=self.token()
            ).status_code,
            200,
        )
