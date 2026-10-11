"""Layouts, label data, the patient card and the print queue: roles, clinic walls and what leaves the server."""

from decimal import Decimal

from django.db import DatabaseError, connection, models, transaction
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from billing.models import Invoice, InvoiceLine
from printing.apps import APPEND_ONLY_TABLES
from printing.models import PrintJob, PrintTemplate, template_in_use
from records import guards
from records.models import Encounter, Patient, PatientIdentifier, Prescription, PrescriptionItem


class PrintingTestCase(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic", address="4 Garden Street", phone="5550100", time_zone="Asia/Kolkata")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.patient = Patient.objects.create(
            clinic=self.clinic, first_name="Synthetic", last_name="Patient", date_of_birth="1990-01-01", gender="other"
        )
        self.code = PatientIdentifier.issue(self.patient).code
        self.encounter = Encounter.objects.create(
            patient=self.patient, clinician=self.user, chief_complaint="Synthetic complaint", follow_up_date=self.clinic.today()
        )
        for position, (line, medicine) in enumerate(
            [("4 tabs, twice daily · 14 days", "Synthetic remedy A"), ("5 drops at bedtime", "Synthetic remedy B")]
        ):
            envelope = Prescription.objects.create(
                encounter=self.encounter, prescriber=self.user, position=position, dosage_line=line, dosage={"amount": "4", "unit": "tabs"}
            )
            PrescriptionItem.objects.create(prescription=envelope, medicine_name_snapshot=medicine, potency="30C")
        other_patient = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        self.foreign_encounter = Encounter.objects.create(patient=other_patient, clinician=self.user, chief_complaint="x")
        self.foreign_patient = other_patient
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def role(self, value):
        self.member.role_id = value
        self.member.save()


class TemplateTests(PrintingTestCase):
    def test_every_layout_starts_from_the_shipped_one(self):
        templates = {row["kind"]: row for row in self.client.get("/api/v1/print-templates/").data}
        self.assertEqual(set(templates), {"label", "prescription", "invoice", "receipt", "card"})
        label = templates["label"]
        self.assertEqual((label["version"], label["settings"]["size"], label["settings"]["show_medicines"]), (0, "2x2in", False))
        self.assertEqual((label["settings"]["width_mm"], label["settings"]["height_mm"]), (50.8, 50.8))

    def test_saving_makes_a_new_version_and_keeps_the_old_ones(self):
        first = self.client.post("/api/v1/print-templates/", {"kind": "label", "settings": {"show_phone": False}}, format="json")
        self.assertEqual((first.status_code, first.data["version"], first.data["settings"]["show_phone"]), (201, 1, False))
        second = self.client.post(
            "/api/v1/print-templates/", {"kind": "label", "settings": {"size": "50x25mm", "show_medicines": True}}, format="json"
        )
        settings = second.data["settings"]
        self.assertEqual(
            (second.data["version"], settings["size"], settings["width_mm"], settings["height_mm"]), (2, "50x25mm", 50.0, 25.0)
        )
        # An earlier choice carries into the next version unless it is changed.
        self.assertEqual((settings["show_phone"], settings["show_medicines"], second.data["saved_by_name"]), (False, True, "Dr Synthetic"))
        self.assertEqual(PrintTemplate.objects.filter(clinic=self.clinic, kind="label").count(), 2)
        self.assertEqual(template_in_use(self.other_clinic, "label")[0], 0)
        self.assertTrue(AuditEvent.objects.filter(action="print_template.save").exists())
        custom = self.client.post(
            "/api/v1/print-templates/", {"kind": "label", "settings": {"size": "custom", "width_mm": 62, "height_mm": 29.04}}, format="json"
        )
        self.assertEqual((custom.data["settings"]["width_mm"], custom.data["settings"]["height_mm"]), (62.0, 29.0))

    def test_bad_settings_and_other_roles_are_refused(self):
        for body in [
            {"kind": "poster", "settings": {}},
            {"kind": "label", "settings": {"size": "A0"}},
            {"kind": "label", "settings": {"show_phone": "yes"}},
            {"kind": "label", "settings": {"width_mm": 500}},
            {"kind": "label", "settings": {"width_mm": True}},
            {"kind": "label", "settings": {"nonsense": True}},
            {"kind": "label", "settings": ["show_phone"]},
            {"kind": "prescription", "settings": {"paper": "Letter"}},
            {"kind": "invoice", "settings": {"footer_note": "x" * 201}},
        ]:
            self.assertEqual(self.client.post("/api/v1/print-templates/", body, format="json").status_code, 400, body)
        self.assertFalse(PrintTemplate.objects.exists())
        self.role("admin")
        self.assertEqual(
            self.client.post("/api/v1/print-templates/", {"kind": "card", "settings": {"show_phone": False}}, format="json").status_code,
            201,
        )
        for role in ["clinician", "assistant", "reception", "billing"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/print-templates/").status_code, 200, role)
            self.assertEqual(
                self.client.post("/api/v1/print-templates/", {"kind": "label", "settings": {}}, format="json").status_code, 403, role
            )


class PrintDataTests(PrintingTestCase):
    def test_a_label_carries_the_dosage_and_no_medicine_name_unless_the_clinic_chose_so(self):
        data = self.client.get(f"/api/v1/print-data/label/{self.encounter.pk}/").data
        self.assertEqual(
            (data["clinic"]["name"], data["patient"]["name"], data["patient"]["code"]), ("Synthetic clinic", "Synthetic Patient", self.code)
        )
        self.assertEqual([e["dosage_line"] for e in data["envelopes"]], ["4 tabs, twice daily · 14 days", "5 drops at bedtime"])
        self.assertEqual([e["number"] for e in data["envelopes"]], [1, 2])
        self.assertEqual((data["date"], data["next_visit"]), (self.clinic.today().isoformat(), self.clinic.today().isoformat()))
        self.assertNotIn("Synthetic remedy", str(data))
        self.assertNotIn("Synthetic complaint", str(data))
        self.client.post("/api/v1/print-templates/", {"kind": "label", "settings": {"show_medicines": True}}, format="json")
        shown = self.client.get(f"/api/v1/print-data/label/{self.encounter.pk}/").data
        self.assertEqual(shown["envelopes"][0]["medicines"], ["Synthetic remedy A 30C"])

    def test_a_prescription_follows_its_own_setting_for_medicine_names(self):
        self.client.post("/api/v1/print-templates/", {"kind": "label", "settings": {"show_medicines": True}}, format="json")
        data = self.client.get(f"/api/v1/print-data/prescription/{self.encounter.pk}/").data
        self.assertEqual((data["doctor"], data["settings"]["paper"]), ("Dr Synthetic", "A4"))
        self.assertNotIn("Synthetic remedy", str(data))
        self.client.post("/api/v1/print-templates/", {"kind": "prescription", "settings": {"show_medicines": True}}, format="json")
        shown = self.client.get(f"/api/v1/print-data/prescription/{self.encounter.pk}/").data
        self.assertEqual(shown["envelopes"][1]["medicines"], ["Synthetic remedy B 30C"])

    def test_who_may_ask_for_what(self):
        label, card = f"/api/v1/print-data/label/{self.encounter.pk}/", f"/api/v1/print-data/card/{self.patient.pk}/"
        prescription = f"/api/v1/print-data/prescription/{self.encounter.pk}/"
        for role, sees_label, sees_card in [
            ("clinician", True, True),
            ("assistant", True, True),
            ("reception", False, True),
            ("billing", False, False),
            ("admin", False, False),
        ]:
            self.role(role)
            self.assertEqual(self.client.get(label).status_code, 200 if sees_label else 403, role)
            self.assertEqual(self.client.get(prescription).status_code, 200 if sees_label else 403, role)
            self.assertEqual(self.client.get(card).status_code, 200 if sees_card else 403, role)
            self.assertEqual(self.client.get("/api/v1/print-data/test-label/").status_code, 200, role)
        self.role("owner")
        self.assertEqual(
            self.client.get(card).data["patient"], {"id": str(self.patient.pk), "name": "Synthetic Patient", "code": self.code}
        )

    def test_other_clinics_and_nonsense_are_not_found(self):
        for path in [
            f"/api/v1/print-data/label/{self.foreign_encounter.pk}/",
            f"/api/v1/print-data/prescription/{self.foreign_encounter.pk}/",
            f"/api/v1/print-data/card/{self.foreign_patient.pk}/",
            "/api/v1/print-data/label/not-an-id/",
        ]:
            self.assertEqual(self.client.get(path).status_code, 400, path)
        self.client.logout()
        self.assertEqual(self.client.get(f"/api/v1/print-data/label/{self.encounter.pk}/").status_code, 401)


class PrintQueueTests(PrintingTestCase):
    def job(self, **body):
        return self.client.post("/api/v1/print-jobs/", body, format="json")

    def test_printing_labels_is_recorded_with_what_was_on_them(self):
        response = self.job(kind="label", encounter=str(self.encounter.pk), envelopes=[2], copies=2)
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(
            (response.data["title"], response.data["patient"], response.data["copies"], response.data["envelopes"]),
            ("Envelope label × 2", "Synthetic Patient", 2, [2]),
        )
        job = PrintJob.objects.get()
        self.assertEqual([e["dosage_line"] for e in job.snapshot["envelopes"]], ["5 drops at bedtime"])
        self.assertEqual((job.snapshot["patient"]["code"], job.clinic), (self.code, self.clinic))
        self.assertTrue(AuditEvent.objects.filter(action="print_job.create", resource_id=job.pk).exists())
        for bad in [
            {"envelopes": []},
            {"envelopes": [3]},
            {"envelopes": "all"},
            {"copies": 0},
            {"copies": 51},
            {"encounter": str(self.foreign_encounter.pk)},
        ]:
            body = {"kind": "label", "encounter": str(self.encounter.pk), "envelopes": [1], **bad}
            self.assertEqual(self.job(**body).status_code, 400, bad)
        self.assertEqual(self.job(kind="poster").status_code, 400)
        self.assertEqual(PrintJob.objects.count(), 1)

    def test_a_printed_bill_is_noted_in_its_history_and_drafts_are_not_printed(self):
        invoice = Invoice.objects.create(clinic=self.clinic, patient=self.patient, created_by=self.user)
        InvoiceLine.objects.create(invoice=invoice, kind="service", description="Consultation", rate=Decimal("500"))
        self.assertEqual(self.job(kind="invoice", invoice=str(invoice.pk)).status_code, 400)
        models.QuerySet(Invoice).filter(pk=invoice.pk).update(status="issued", number="INV/26-27/0001")
        response = self.job(kind="invoice", invoice=str(invoice.pk))
        self.assertEqual((response.status_code, response.data["title"]), (201, "Invoice INV/26-27/0001"))
        self.assertEqual(invoice.events.get().action, "printed")
        self.assertEqual(
            self.job(kind="receipt", invoice=str(invoice.pk), receipt_number="R/26-27/0001").data["title"], "Receipt R/26-27/0001"
        )
        foreign = Invoice.objects.create(clinic=self.other_clinic, created_by=self.user)
        self.assertEqual(self.job(kind="invoice", invoice=str(foreign.pk)).status_code, 400)

    def test_the_queue_shows_each_role_only_what_it_may_print(self):
        self.job(kind="label", encounter=str(self.encounter.pk), envelopes=[1])
        self.job(kind="prescription", encounter=str(self.encounter.pk))
        self.job(kind="card", patient=str(self.patient.pk))
        self.job(kind="test")
        PrintJob.objects.create(clinic=self.other_clinic, kind="card", title="Other clinic", created_by=self.user)

        def kinds():
            return sorted(row["kind"] for row in self.client.get("/api/v1/print-jobs/").data["results"])

        self.assertEqual(kinds(), ["card", "label", "prescription", "test"])
        self.role("reception")
        self.assertEqual(kinds(), ["card", "test"])
        self.assertEqual(self.job(kind="label", encounter=str(self.encounter.pk), envelopes=[1]).status_code, 403)
        self.assertEqual(self.job(kind="card", patient=str(self.patient.pk)).status_code, 201)
        self.role("billing")
        self.assertEqual(kinds(), ["test"])
        self.assertEqual(self.job(kind="card", patient=str(self.patient.pk)).status_code, 403)
        self.assertEqual(self.client.get("/api/v1/print-jobs/?day=2020-01-01").data["results"], [])
        self.assertEqual(self.client.get("/api/v1/print-jobs/?day=soon").status_code, 400)

    def test_layouts_and_print_records_are_append_only_in_the_database(self):
        self.client.post("/api/v1/print-templates/", {"kind": "label", "settings": {"show_phone": False}}, format="json")
        self.job(kind="card", patient=str(self.patient.pk))
        installed = guards.guarded_tables()
        for table in APPEND_ONLY_TABLES:
            self.assertIn(table, guards.all_append_only_tables())
            self.assertTrue(any("append_only" in name for name in installed.get(table, ())), table)
            with self.assertRaises(DatabaseError, msg=table) as caught, transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(f"DELETE FROM {table}")  # noqa: S608 - table names are constants from apps.py
            self.assertIn(guards.APPEND_ONLY_MESSAGE, str(caught.exception), table)
        with self.assertRaises(DatabaseError), transaction.atomic():
            models.QuerySet(PrintJob).update(copies=9)
