"""Writing a visit: drafts, finalising, products, amendments, saved sets and the extra measurements."""

from decimal import Decimal

from django.db import DatabaseError, models, transaction
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from billing.models import PriceItem
from records import guards
from records.models import OBSERVATION_UNITS, Encounter, EncounterDraft, Observation, Patient, PrescriptionSet


class VisitTestCase(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.foreign_patient = Patient.objects.create(
            clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other"
        )
        self.client = self.client_for(self.user)

    def client_for(self, user):
        client = APIClient()
        client.force_login(user)
        session = client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()
        return client

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def visit(self, **changes):
        body = {"patient": str(self.patient.pk), "chief_complaint": "Synthetic complaint", "visit_type": "follow_up", **changes}
        return self.client.post("/api/v1/encounters/", body, format="json")


class DraftTests(VisitTestCase):
    def draft(self, **data):
        return self.client.post(
            "/api/v1/visit-drafts/", {"patient": str(self.patient.pk), "data": {"complaint": "Half written", **data}}, format="json"
        )

    def test_a_doctor_keeps_one_draft_per_patient_and_saving_replaces_it(self):
        first = self.draft()
        self.assertEqual((first.status_code, first.data["mine"], first.data["author_name"]), (201, True, "Dr Synthetic"))
        again = self.draft(complaint="More written")
        self.assertEqual((again.status_code, again.data["id"], again.data["data"]["complaint"]), (200, first.data["id"], "More written"))
        patched = self.client.patch(f"/api/v1/visit-drafts/{first.data['id']}/", {"data": {"complaint": "Patched"}}, format="json")
        self.assertEqual(patched.data["data"], {"complaint": "Patched"})
        self.assertEqual(EncounterDraft.objects.count(), 1)
        listed = self.client.get(f"/api/v1/visit-drafts/?patient={self.patient.pk}").data
        self.assertEqual([row["patient_name"] for row in listed], ["Synthetic"])
        # Saving a draft is audited by ID, never by content.
        self.assertTrue(AuditEvent.objects.filter(action="visit_draft.save", resource_id=first.data["id"]).exists())

    def test_drafts_are_for_doctors_and_stay_in_their_clinic(self):
        draft = self.draft().data
        for role in ["assistant", "reception", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/visit-drafts/").status_code, 403, role)
            self.assertEqual(self.draft().status_code, 403, role)
        self.role("clinician")
        # Another doctor of the clinic sees the draft but does not overwrite or discard it; the owner may discard it.
        colleague = User.objects.create_user(username="colleague", password="synthetic-password")
        membership = Membership.objects.create(clinic=self.clinic, user=colleague, role_id="clinician")
        other = self.client_for(colleague)
        self.assertEqual([row["mine"] for row in other.get("/api/v1/visit-drafts/").data], [False])
        self.assertEqual(other.patch(f"/api/v1/visit-drafts/{draft['id']}/", {"data": {}}, format="json").status_code, 403)
        self.assertEqual(other.delete(f"/api/v1/visit-drafts/{draft['id']}/").status_code, 403)
        own = other.post("/api/v1/visit-drafts/", {"patient": str(self.patient.pk), "data": {}}, format="json")
        self.assertEqual((own.status_code, EncounterDraft.objects.count()), (201, 2))
        membership.role_id = "owner"
        membership.save()
        self.assertEqual(other.delete(f"/api/v1/visit-drafts/{draft['id']}/").status_code, 204)
        # Other clinics: no patient, no draft.
        self.assertEqual(
            self.client.post("/api/v1/visit-drafts/", {"patient": str(self.foreign_patient.pk), "data": {}}, format="json").status_code, 400
        )
        foreign = EncounterDraft.objects.create(patient=self.foreign_patient, author=self.user, data={})
        self.assertEqual(self.client.get(f"/api/v1/visit-drafts/{foreign.pk}/").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/v1/visit-drafts/{foreign.pk}/").status_code, 404)

    def test_bad_drafts_are_refused(self):
        for body in [{"data": "text"}, {"data": {"x": "y" * 250_000}}, {"data": ["a"]}]:
            response = self.client.post("/api/v1/visit-drafts/", {"patient": str(self.patient.pk), **body}, format="json")
            self.assertEqual(response.status_code, 400, str(body)[:40])
        self.assertEqual(self.client.get("/api/v1/visit-drafts/?patient=nonsense").status_code, 400)

    def test_finalising_makes_the_visit_and_removes_the_draft_in_one_step(self):
        draft = self.draft().data
        foreign = EncounterDraft.objects.create(patient=self.foreign_patient, author=self.user, data={})
        # A visit that fails validation leaves the draft in place.
        self.assertEqual(self.visit(draft=draft["id"], visit_type="nonsense").status_code, 400)
        self.assertTrue(EncounterDraft.objects.filter(pk=draft["id"]).exists())
        # Naming someone else's draft removes nothing of theirs.
        self.assertEqual(self.visit(draft=str(foreign.pk)).status_code, 201)
        self.assertTrue(EncounterDraft.objects.filter(pk=foreign.pk).exists())
        response = self.visit(draft=draft["id"])
        self.assertEqual(response.status_code, 201, response.data)
        self.assertFalse(EncounterDraft.objects.filter(pk=draft["id"]).exists())
        self.assertNotIn("draft", response.data)


class VisitContentTests(VisitTestCase):
    def test_blood_pressure_and_pulse_are_recorded_with_their_units(self):
        observations = [
            {"kind": "height", "value": "162", "unit": "cm"},
            {"kind": "systolic", "value": "118", "unit": "mmHg"},
            {"kind": "diastolic", "value": "76", "unit": "mmHg"},
            {"kind": "pulse", "value": "72", "unit": "bpm"},
        ]
        response = self.visit(observations=observations)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual({o["kind"]: o["unit"] for o in response.data["observations"]}, {o["kind"]: o["unit"] for o in observations})
        for wrong in [
            {"kind": "pulse", "value": "72", "unit": "mmHg"},
            {"kind": "systolic", "value": "0", "unit": "mmHg"},
            {"kind": "sugar", "value": "5", "unit": "bpm"},
        ]:
            self.assertEqual(self.visit(observations=[wrong]).status_code, 400, wrong)
        # The database checks the same pairs, whatever the application code does.
        self.assertEqual(guards.OBSERVATION_UNITS, OBSERVATION_UNITS)
        encounter = Encounter.objects.first()
        with self.assertRaises(DatabaseError), transaction.atomic():
            models.QuerySet(Observation).bulk_create(
                [Observation(patient=self.patient, encounter=encounter, kind="pulse", unit="kg", value=72)]
            )
        models.QuerySet(Observation).bulk_create(
            [Observation(patient=self.patient, encounter=encounter, kind="pulse", unit="bpm", value=72)]
        )

    def test_products_advised_at_a_visit_are_kept_as_written_and_reach_the_bill(self):
        item = PriceItem.objects.create(
            clinic=self.clinic, name="Calendula cream 30 g", kind="shelf", rate=Decimal("120"), gst_rate=Decimal("18")
        )
        products = [
            {
                "price_item_id": str(item.pk),
                "name": item.name,
                "kind": "shelf",
                "quantity": "2",
                "rate": "120",
                "gst_rate": "18",
                "note": "Apply at night",
            },
            {"name": "Typed by hand", "kind": "consumable", "rate": "60"},
        ]
        response = self.visit(products=products)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            [(p["name"], p["quantity"], p["note"]) for p in response.data["products"]],
            [(item.name, "2.00", "Apply at night"), ("Typed by hand", "1.00", "")],
        )
        self.assertIsNone(response.data["invoice"])
        for bad in [
            [{"name": "x", "kind": "service", "rate": "1"}],
            [{"name": "", "rate": "1"}],
            [{"name": "x", "rate": "-1"}],
            [{"name": "x", "rate": "1"}] * 31,
        ]:
            self.assertEqual(self.visit(products=bad).status_code, 400, str(bad)[:60])
        # The price list changes; the visit and the bill made from it keep the day's price.
        item.rate = Decimal("999")
        item.save()
        self.role("owner")
        bill = self.client.post("/api/v1/invoices/from-visit/", {"encounter": response.data["id"]}, format="json")
        self.assertEqual(bill.status_code, 201, bill.data)
        lines = [(line["description"], line["quantity"], line["rate"], line["group"], line["price_item"]) for line in bill.data["lines"]]
        self.assertIn(("Calendula cream 30 g", "2.00", "120.00", "products", item.pk), lines)
        self.assertIn(("Typed by hand", "1.00", "60.00", "products", None), lines)
        visit = self.client.get(f"/api/v1/encounters/{response.data['id']}/").data
        self.assertEqual(visit["invoice"], {"id": bill.data["id"], "number": "", "state": "draft"})

    def test_an_amendment_is_added_beside_the_visit_by_a_doctor(self):
        visit = self.visit().data
        url = f"/api/v1/encounters/{visit['id']}/amendments/"
        body = {"section": "prescription", "correction": "Potency should read 30C, not 200C.", "reason": "Typing mistake"}
        response = self.client.post(url, body, format="json")
        self.assertEqual((response.status_code, response.data["author_name"]), (201, "Dr Synthetic"))
        again = self.client.get(f"/api/v1/encounters/{visit['id']}/").data
        self.assertEqual([a["correction"] for a in again["amendments"]], ["Potency should read 30C, not 200C."])
        self.assertEqual(again["chief_complaint"], "Synthetic complaint")
        self.assertTrue(AuditEvent.objects.filter(action="encounter.amend", resource_id=visit["id"]).exists())
        for bad in [{**body, "section": "everything"}, {**body, "reason": ""}, {**body, "correction": ""}]:
            self.assertEqual(self.client.post(url, bad, format="json").status_code, 400, bad)
        self.role("assistant")
        self.assertEqual(self.client.post(url, body, format="json").status_code, 403)
        self.assertEqual(len(self.client.get(f"/api/v1/encounters/{visit['id']}/").data["amendments"]), 1)
        foreign = Encounter.objects.create(patient=self.foreign_patient, clinician=self.user, chief_complaint="x")
        self.role("clinician")
        self.assertEqual(self.client.post(f"/api/v1/encounters/{foreign.pk}/amendments/", body, format="json").status_code, 404)

    def test_too_many_envelopes_are_refused(self):
        envelope = {"dosage_line": "x", "items": [{"medicine_name_snapshot": "A"}]}
        self.assertEqual(self.visit(prescriptions=[envelope] * 13).status_code, 400)


class PrescriptionSetTests(VisitTestCase):
    def test_doctors_save_use_and_remove_sets_within_their_clinic(self):
        envelopes = [{"medicines": [{"name": "Synthetic remedy", "potency": "30C"}], "amount": "4", "unit": "tabs"}]
        saved = self.client.post("/api/v1/prescription-sets/", {"name": " Teething ", "envelopes": envelopes}, format="json")
        self.assertEqual((saved.status_code, saved.data["name"]), (201, "Teething"))
        self.assertEqual(
            self.client.post("/api/v1/prescription-sets/", {"name": "teething", "envelopes": envelopes}, format="json").status_code, 400
        )
        for bad in [{"name": "Empty", "envelopes": []}, {"name": "Wrong", "envelopes": "text"}, {"name": "", "envelopes": envelopes}]:
            self.assertEqual(self.client.post("/api/v1/prescription-sets/", bad, format="json").status_code, 400, bad)
        PrescriptionSet.objects.create(clinic=self.other_clinic, name="Elsewhere", envelopes=envelopes, created_by=self.user)
        self.assertEqual([row["name"] for row in self.client.get("/api/v1/prescription-sets/").data], ["Teething"])
        foreign = PrescriptionSet.objects.get(name="Elsewhere")
        self.assertEqual(self.client.delete(f"/api/v1/prescription-sets/{foreign.pk}/").status_code, 404)
        self.role("assistant")
        self.assertEqual(self.client.get("/api/v1/prescription-sets/").status_code, 403)
        self.role("clinician")
        self.assertEqual(self.client.delete(f"/api/v1/prescription-sets/{saved.data['id']}/").status_code, 204)
        self.assertEqual(self.client.get("/api/v1/prescription-sets/").data, [])
