"""Visits as the doctor works: envelopes with one dosage line each, and doctor-only "remember" notes."""

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from records.models import Encounter, Patient, PatientNote, Prescription


class EnvelopeAndRememberTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def visit(self, **changes):
        body = {
            "patient": str(self.patient.pk),
            "chief_complaint": "Synthetic complaint",
            "visit_type": "follow_up",
            "progress": "better",
            "prescriptions": [
                {
                    "dosage_line": "4 tabs, twice daily before meals · 14 days",
                    "dosage": {"amount": "4", "unit": "tabs", "frequency": "twice daily", "timing": "before meals", "for": "14 days"},
                    "items": [
                        {"medicine_name_snapshot": "Synthetic remedy A", "potency": "30C"},
                        {"medicine_name_snapshot": "Synthetic remedy B", "potency": "200C"},
                    ],
                },
                {"dosage_line": "5 drops, at bedtime · 7 days", "items": [{"medicine_name_snapshot": "Synthetic remedy C"}]},
            ],
            **changes,
        }
        return self.client.post("/api/v1/encounters/", body, format="json")

    def test_a_visit_holds_several_envelopes_each_with_its_mix_and_dosage_line(self):
        response = self.visit()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual((response.data["visit_type"], response.data["progress"]), ("follow_up", "better"))
        envelopes = response.data["prescriptions"]
        self.assertEqual(
            [e["dosage_line"] for e in envelopes], ["4 tabs, twice daily before meals · 14 days", "5 drops, at bedtime · 7 days"]
        )
        self.assertEqual([i["medicine_name_snapshot"] for i in envelopes[0]["items"]], ["Synthetic remedy A", "Synthetic remedy B"])
        self.assertEqual(envelopes[0]["dosage"]["unit"], "tabs")
        self.assertEqual(envelopes[1]["items"][0]["dose"], "")
        self.assertEqual(Prescription.objects.filter(encounter_id=response.data["id"]).count(), 2)

    def test_invalid_choices_and_empty_envelopes_are_rejected_whole(self):
        for changes in [
            {"visit_type": "walk_in"},
            {"progress": "cured"},
            {"prescriptions": [{"dosage_line": "x", "items": []}]},
            {"prescriptions": [{"dosage_line": "x" * 201, "items": [{"medicine_name_snapshot": "A"}]}]},
            {"prescriptions": [{"dosage": {"k": "v" * 101}, "items": [{"medicine_name_snapshot": "A"}]}]},
            {"prescriptions": [{"dosage": ["not", "named"], "items": [{"medicine_name_snapshot": "A"}]}]},
        ]:
            self.assertEqual(self.visit(**changes).status_code, 400, changes)
        self.assertFalse(Encounter.objects.exists() or Prescription.objects.exists())

    def test_older_style_visits_still_save(self):
        body = {"patient": str(self.patient.pk), "chief_complaint": "Synthetic"}
        self.assertEqual(self.client.post("/api/v1/encounters/", body, format="json").status_code, 201)
        body["prescriptions"] = [{"items": [{"medicine_name_snapshot": "A", "dose": "1", "frequency": "daily"}]}]
        response = self.client.post("/api/v1/encounters/", body, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data["prescriptions"][0]["dosage_line"], "")

    def note(self, kind, body="Synthetic"):
        return self.client.post("/api/v1/notes/", {"patient": str(self.patient.pk), "kind": kind, "body": body}, format="json")

    def test_remember_notes_are_for_doctors_only_everywhere(self):
        self.assertEqual(self.note("remember", "Teaches dance on weekends").status_code, 201)
        self.assertEqual(self.note("clinical", "Ordinary note").status_code, 201)
        self.assertEqual(self.note("gossip").status_code, 400)
        base = f"/api/v1/notes/?patient={self.patient.pk}"
        timeline = f"/api/v1/patients/{self.patient.pk}/timeline/"
        for role in ["clinician", "owner"]:
            self.role(role)
            self.assertEqual(self.client.get(base).data["count"], 2)
            self.assertEqual([n["body"] for n in self.client.get(base + "&kind=remember").data["results"]], ["Teaches dance on weekends"])
            self.assertEqual(self.client.get(base + "&kind=clinical").data["count"], 1)
            self.assertEqual(len(self.client.get(timeline).data["notes"]), 2)
        self.role("assistant")
        self.assertEqual([n["kind"] for n in self.client.get(base).data["results"]], ["clinical"])
        self.assertEqual(self.client.get(base + "&kind=remember").data["count"], 0)
        self.assertEqual([n["kind"] for n in self.client.get(timeline).data["notes"]], ["clinical"])
        self.assertEqual(self.note("remember").status_code, 403)
        for role in ["reception", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get(base + "&kind=remember").status_code, 403)

    def test_remember_notes_stay_inside_the_clinic(self):
        other = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        PatientNote.objects.create(patient=other, author=self.user, kind="remember", body="Other clinic's note")
        self.assertEqual(self.client.get("/api/v1/notes/?kind=remember").data["count"], 0)
        response = self.client.post("/api/v1/notes/", {"patient": str(other.pk), "kind": "remember", "body": "x"}, format="json")
        self.assertEqual(response.status_code, 400)
