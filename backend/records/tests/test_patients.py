"""The patient list, the fuller registration form, consent, family, documents, the timeline and import."""

import datetime
import io
from decimal import Decimal

from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import transaction
from django.test import TestCase
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from billing.models import Invoice, InvoiceLine, Payment
from records.models import Encounter, FamilyLink, Patient, PatientConsent, PatientDocument, PatientNote, PatientRevision
from vault import backup
from vault.tests.test_backup import PASSWORD, BackupTestCase, bootstrap

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


def jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (60, 40), (200, 80, 80)).save(buffer, "JPEG")
    return buffer.getvalue()


class PatientTestCase(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic", time_zone="Asia/Kolkata")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.anita = self.patient("Anita", "Synthetic", phone="5550142")
        self.vikram = self.patient("Vikram", "Synthetic", phone="5550143")
        self.foreign = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def patient(self, first, last="", **more):
        return Patient.objects.create(
            clinic=self.clinic, first_name=first, last_name=last, date_of_birth="1984-03-14", gender="female", **more
        )

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def visit(self, patient, days_ago=0, follow_up=None):
        return Encounter.objects.create(
            patient=patient,
            clinician=self.user,
            chief_complaint="Synthetic complaint",
            occurred_at=timezone.now() - datetime.timedelta(days=days_ago),
            follow_up_date=follow_up,
        )

    def bill(self, patient, total="320", paid="0"):
        invoice = Invoice.objects.create(clinic=self.clinic, patient=patient, created_by=self.user)
        InvoiceLine.objects.create(invoice=invoice, kind="service", description="Consultation", rate=Decimal(total))
        invoice.refresh_totals()
        invoice.status, invoice.number, invoice.issued_at = "issued", f"INV/26-27/{Invoice.objects.count():04d}", timezone.now()
        invoice.save()
        if Decimal(paid):
            Payment.objects.create(invoice=invoice, amount=Decimal(paid), method="cash", received_by=self.user, receipt_number="R/1")
        return invoice

    def url(self, patient=None, tail=""):
        return f"/api/v1/patients/{(patient or self.anita).pk}/{tail}"


class ListTests(PatientTestCase):
    def test_rows_carry_last_visit_next_advised_and_balance(self):
        today = self.clinic.today()
        self.visit(self.anita, days_ago=40, follow_up=None)
        self.visit(self.anita, days_ago=0, follow_up=today + datetime.timedelta(days=14))
        self.bill(self.anita, "1320", "1000")
        data = self.client.get("/api/v1/patients/").data
        rows = {row["first_name"]: row for row in data["results"]}
        self.assertEqual(data["clinic_total"], 2)
        self.assertEqual(
            (rows["Anita"]["last_visit"], rows["Anita"]["next_advised"], rows["Anita"]["balance"]),
            (today.isoformat(), (today + datetime.timedelta(days=14)).isoformat(), "320.00"),
        )
        self.assertEqual((rows["Vikram"]["last_visit"], rows["Vikram"]["next_advised"], rows["Vikram"]["balance"]), (None, None, "0.00"))
        # The balance is for roles that work with bills.
        self.role("assistant")
        self.assertNotIn("balance", self.client.get("/api/v1/patients/").data["results"][0])

    def test_chips_narrow_the_list_and_sort_orders_it(self):
        today = self.clinic.today()
        self.visit(self.anita, days_ago=0, follow_up=today + datetime.timedelta(days=14))
        self.visit(self.vikram, days_ago=45, follow_up=today - datetime.timedelta(days=4))
        prakash = self.patient("Prakash", "Synthetic")
        self.bill(self.vikram, "400")
        self.bill(self.anita, "100", "100")

        def names(query=""):
            return [row["first_name"] for row in self.client.get(f"/api/v1/patients/?{query}").data["results"]]

        self.assertEqual(names("follow_up=due"), ["Vikram"])
        self.assertEqual(names("balance=due"), ["Vikram"])
        self.assertEqual(names("seen=month"), ["Anita"])
        self.assertEqual(names("sort=last_visit"), ["Anita", "Vikram", "Prakash"])
        self.assertEqual(names("sort=registered")[0], "Prakash")
        self.assertEqual(names(), ["Anita", "Prakash", "Vikram"])
        prakash.archived_at = timezone.now()
        prakash.save()
        self.assertEqual(names("archived=true&search=Prakash"), ["Prakash"])
        self.assertEqual(self.client.get("/api/v1/patients/").data["clinic_total"], 2)
        self.role("assistant")
        self.assertEqual(self.client.get("/api/v1/patients/?balance=due").status_code, 403)


class RegistrationTests(PatientTestCase):
    def test_registration_keeps_the_extra_details_and_consent(self):
        body = {
            "first_name": "Sunita",
            "date_of_birth": "2018-05-01",
            "gender": "female",
            "referred_by": "Dr Elsewhere",
            "old_file_number": "F-221",
            "consent": {"care": True, "greetings": False},
        }
        response = self.client.post("/api/v1/patients/", body, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual((response.data["referred_by"], response.data["old_file_number"]), ("Dr Elsewhere", "F-221"))
        consent = response.data["consent"]
        self.assertEqual((consent["care"]["granted"], consent["care"]["by"], consent["care"]["wording_version"]), (True, "Dr Synthetic", 1))
        # "No" to something never asked before is not written down as a refusal.
        self.assertIsNone(consent["greetings"])
        self.assertEqual(PatientConsent.objects.count(), 1)
        for bad in [{"consent": {"care": "yes"}}, {"consent": {"sms": True}}, {"consent": ["care"]}]:
            self.assertEqual(self.client.post("/api/v1/patients/", {**body, **bad}, format="json").status_code, 400, bad)

    def test_consent_changes_are_added_never_rewritten(self):
        url = self.url(tail="consent/")
        self.assertEqual(self.client.post(url, {"care": True, "greetings": True}, format="json").data["greetings"]["granted"], True)
        self.client.post(url, {"care": True, "greetings": True}, format="json")  # nothing changed: nothing written
        self.assertEqual(PatientConsent.objects.count(), 2)
        withdrawn = self.client.post(url, {"greetings": False}, format="json").data
        self.assertEqual((withdrawn["care"]["granted"], withdrawn["greetings"]["granted"]), (True, False))
        self.assertEqual(PatientConsent.objects.filter(kind="greetings").count(), 2)
        self.assertEqual(self.client.get(self.url()).data["consent"]["greetings"]["granted"], False)
        self.assertEqual(self.client.post(url, {}, format="json").status_code, 400)
        self.assertEqual(self.client.post(self.url(self.foreign, "consent/"), {"care": True}, format="json").status_code, 404)
        self.role("billing")
        self.assertEqual(self.client.post(url, {"care": False}, format="json").status_code, 403)

    def test_edits_track_the_new_details_and_the_alert_belongs_to_doctors(self):
        changed = self.client.patch(self.url(), {"referred_by": "A friend", "alert": "Sensitive to camphor"}, format="json")
        self.assertEqual((changed.status_code, changed.data["alert"]), (200, "Sensitive to camphor"))
        revision = PatientRevision.objects.get()
        self.assertEqual(revision.changes, {"referred_by": {"from": "", "to": "A friend"}})
        self.role("reception")
        seen = self.client.get(self.url()).data
        self.assertNotIn("alert", seen)
        self.assertEqual(self.client.patch(self.url(), {"alert": "Changed by the desk"}, format="json").status_code, 400)
        self.assertEqual(self.client.patch(self.url(), {"phone": "5550999"}, format="json").status_code, 200)
        self.anita.refresh_from_db()
        self.assertEqual((self.anita.alert, self.anita.phone), ("Sensitive to camphor", "5550999"))
        self.role("assistant")
        self.assertEqual(self.client.get(self.url()).data["alert"], "Sensitive to camphor")

    def test_family_links_stay_inside_the_clinic_and_show_from_both_sides(self):
        linked = self.client.post(self.url(tail="family/"), {"relative": str(self.vikram.pk), "relation": "husband"}, format="json")
        self.assertEqual(linked.status_code, 200, linked.data)
        self.assertEqual([(row["name"], row["relation"]) for row in linked.data], [("Vikram Synthetic", "husband")])
        self.assertEqual(
            [(row["name"], row["relation"]) for row in self.client.get(self.url(self.vikram)).data["family"]], [("Anita Synthetic", "")]
        )
        for bad in [str(self.anita.pk), str(self.foreign.pk), "nonsense"]:
            self.assertEqual(self.client.post(self.url(tail="family/"), {"relative": bad}, format="json").status_code, 400, bad)
        link = FamilyLink.objects.get()
        self.role("billing")
        self.assertEqual(self.client.delete(self.url(tail=f"family/{link.pk}/")).status_code, 403)
        self.role("reception")
        self.assertEqual(self.client.delete(self.url(self.vikram, f"family/{link.pk}/")).data, [])
        self.assertFalse(FamilyLink.objects.exists())


class NotesAndDocumentsTests(PatientTestCase):
    def test_general_notes_are_front_desk_work_and_everyone_reads_them(self):
        self.role("reception")
        general = {"patient": str(self.anita.pk), "kind": "general", "body": "Prefers morning appointments."}
        self.assertEqual(self.client.post("/api/v1/notes/", general, format="json").status_code, 201)
        self.assertEqual(self.client.post("/api/v1/notes/", {**general, "kind": "clinical"}, format="json").status_code, 403)
        self.role("clinician")
        self.client.post("/api/v1/notes/", {**general, "kind": "clinical", "body": "Clinical"}, format="json")
        self.client.post("/api/v1/notes/", {**general, "kind": "remember", "body": "Remember"}, format="json")
        for role, kinds in [
            ("billing", ["general"]),
            ("assistant", ["clinical", "general"]),
            ("clinician", ["clinical", "general", "remember"]),
        ]:
            self.role(role)
            listed = self.client.get(f"/api/v1/notes/?patient={self.anita.pk}").data["results"]
            self.assertEqual(sorted(note["kind"] for note in listed), kinds, role)
        self.role("billing")
        self.assertEqual(self.client.post("/api/v1/notes/", general, format="json").status_code, 403)

    def test_documents_are_kept_for_clinical_roles(self):
        upload = SimpleUploadedFile("Anita blood report.pdf", PDF, content_type="application/pdf")
        created = self.client.post(self.url(tail="documents/"), {"title": "Blood report", "file": upload}, format="multipart")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(
            (created.data["title"], created.data["mime_type"], created.data["uploaded_by_name"]),
            ("Blood report", "application/pdf", "Dr Synthetic"),
        )
        document = PatientDocument.objects.get()
        self.addCleanup(default_storage.delete, document.storage_key)
        self.assertNotIn("Anita", document.storage_key)
        served = self.client.get(f"/api/v1/documents/{document.pk}/")
        self.assertEqual((served.status_code, served["Content-Type"], b"".join(served.streaming_content)), (200, "application/pdf", PDF))
        self.assertEqual((served["X-Content-Type-Options"], served["Content-Disposition"]), ("nosniff", 'inline; filename="document.pdf"'))
        picture = self.client.post(
            self.url(tail="documents/"),
            {"title": "Scan", "file": SimpleUploadedFile("x.jpg", jpeg(), content_type="image/jpeg")},
            format="multipart",
        )
        self.assertEqual((picture.status_code, picture.data["mime_type"]), (201, "image/jpeg"))
        self.addCleanup(default_storage.delete, PatientDocument.objects.get(title="Scan").storage_key)
        self.assertEqual(len(self.client.get(self.url(tail="documents/")).data["results"]), 2)
        # The newest documents across the clinic, each with its patient's name, for clinical roles only.
        every = self.client.get("/api/v1/documents/").data["results"]
        self.assertEqual(len(every), 2)
        self.assertEqual({row["patient"] for row in every}, {self.anita.pk})
        self.assertTrue(all(row["patient_name"] for row in every))
        self.assertTrue(AuditEvent.objects.filter(action="document.list_all").exists())
        for title, data in [("", PDF), ("Program", b"MZ\x90\x00 not a document"), ("Web page", b"<html><script>alert(1)</script></html>")]:
            bad = SimpleUploadedFile("x.pdf", data, content_type="application/pdf")
            self.assertEqual(
                self.client.post(self.url(tail="documents/"), {"title": title, "file": bad}, format="multipart").status_code, 400, title
            )
        self.assertEqual(self.client.post(self.url(self.foreign, "documents/"), {"title": "x"}, format="multipart").status_code, 404)
        for role in ["reception", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get(self.url(tail="documents/")).status_code, 403, role)
            self.assertEqual(self.client.get(f"/api/v1/documents/{document.pk}/").status_code, 403, role)
        self.assertTrue(AuditEvent.objects.filter(action="document.view", resource_id=document.pk).exists())

    def test_measurements_are_listed_by_day(self):
        visit = self.visit(self.anita)
        for kind, value, unit in [("height", 162, "cm"), ("weight", "64.5", "kg"), ("systolic", 118, "mmHg"), ("diastolic", 76, "mmHg")]:
            visit.observations.create(patient=self.anita, kind=kind, value=Decimal(str(value)), unit=unit)
        rows = self.client.get(self.url(tail="measurements/")).data["results"]
        self.assertEqual(
            rows, [{"date": self.clinic.today().isoformat(), "height": "162", "weight": "64.5", "systolic": "118", "diastolic": "76"}]
        )
        self.role("reception")
        self.assertEqual(self.client.get(self.url(tail="measurements/")).status_code, 403)


class FeedTests(PatientTestCase):
    def setUp(self):
        super().setUp()
        self.old = self.visit(self.anita, days_ago=60)
        self.new = self.visit(self.anita, days_ago=1)
        self.invoice = self.bill(self.anita, "1320", "1000")
        PatientNote.objects.create(patient=self.anita, author=self.user, kind="general", body="Prefers mornings")
        PatientNote.objects.create(patient=self.anita, author=self.user, kind="clinical", body="Clinical note")
        PatientNote.objects.create(patient=self.anita, author=self.user, kind="remember", body="Teaches dance")
        PatientDocument.objects.create(
            patient=self.anita,
            title="Blood report",
            storage_key="k1",
            mime_type="application/pdf",
            byte_size=10,
            sha256="0" * 64,
            uploaded_by=self.user,
        )

    def kinds(self, **query):
        tail = "feed/?" + "&".join(f"{key}={value}" for key, value in query.items())
        return [item["kind"] for item in self.client.get(self.url(tail=tail)).data["items"]]

    def test_the_timeline_is_one_list_newest_first_with_what_each_role_may_see(self):
        feed = self.client.get(self.url(tail="feed/")).data
        self.assertFalse(feed["more"])
        self.assertEqual(sorted(item["kind"] for item in feed["items"]), ["document", "invoice", "note", "note", "visit", "visit"])
        self.assertEqual([item["at"] for item in feed["items"]], sorted((item["at"] for item in feed["items"]), reverse=True))
        visit = next(item for item in feed["items"] if item["kind"] == "visit")
        self.assertEqual((visit["id"], visit["visit"]["chief_complaint"]), (str(self.new.pk), "Synthetic complaint"))
        bill = next(item for item in feed["items"] if item["kind"] == "invoice")
        self.assertEqual((bill["state"], bill["total"], bill["balance"], bill["method"]), ("partially_paid", "1320.00", "320.00", "cash"))
        # "Remember" notes are not timeline items for anyone; they have their own box.
        self.assertNotIn("Teaches dance", str(feed))
        self.role("reception")
        desk = self.client.get(self.url(tail="feed/")).data["items"]
        self.assertEqual(sorted(item["kind"] for item in desk), ["invoice", "note", "visit", "visit"])
        self.assertTrue(all("visit" not in item for item in desk if item["kind"] == "visit"))
        self.assertNotIn("Synthetic complaint", str(desk))
        self.assertNotIn("Clinical note", str(desk))
        self.role("assistant")
        self.assertEqual(sorted(self.kinds()), ["document", "note", "note", "visit", "visit"])
        self.role("admin")
        self.assertEqual(sorted(self.kinds()), ["note", "visit", "visit"])

    def test_earlier_items_are_loaded_by_date(self):
        first = self.client.get(self.url(tail="feed/?limit=3")).data
        self.assertEqual((len(first["items"]), first["more"]), (3, True))
        before = first["items"][-1]["at"].replace("+", "%2B")
        rest = self.client.get(self.url(tail=f"feed/?limit=50&before={before}")).data
        ids = [item["id"] for item in first["items"]] + [item["id"] for item in rest["items"]]
        self.assertEqual((len(ids), len(set(ids)), rest["more"]), (6, 6, False))
        self.assertEqual(self.client.get(self.url(tail="feed/?before=yesterday")).status_code, 400)
        self.assertEqual(self.client.get(self.url(self.foreign, "feed/")).status_code, 404)


class ImportExportTests(PatientTestCase):
    ROWS = [
        {"first_name": "Leela", "last_name": "Synthetic", "date_of_birth": "14/03/1990", "gender": "F", "phone": "5550201"},
        {"first_name": "Farid", "date_of_birth": "1 Jan 1975", "gender": "male", "old_file_number": "F-9"},
        {"first_name": "Anita", "last_name": "Synthetic", "date_of_birth": "1984-03-14"},  # already registered
        {"first_name": "", "date_of_birth": "1990-01-01"},
        {"first_name": "Future", "date_of_birth": "2999-01-01"},
        {"first_name": "Letters", "date_of_birth": "1990-01-01", "phone": "call me"},
        {"first_name": "NoDate"},
    ]

    def test_a_trial_run_saves_nothing_and_says_what_would_happen(self):
        report = self.client.post("/api/v1/patients/import/", {"rows": self.ROWS}, format="json").data
        self.assertEqual(
            (report["dry_run"], report["ready"], report["duplicates"], report["error_count"], report["created"]), (True, 2, 1, 4, 0)
        )
        self.assertEqual([error["row"] for error in report["errors"]], [5, 6, 7, 8])
        self.assertIn("First name is missing", report["errors"][0]["problem"])
        self.assertIn("Phone number has letters in it", report["errors"][2]["problem"])
        self.assertEqual(Patient.objects.filter(clinic=self.clinic).count(), 2)

    def test_the_real_run_adds_the_good_rows_with_card_codes(self):
        report = self.client.post("/api/v1/patients/import/", {"rows": self.ROWS, "dry_run": False}, format="json").data
        self.assertEqual((report["created"], report["duplicates"]), (2, 1))
        leela = Patient.objects.get(first_name="Leela")
        self.assertEqual((leela.date_of_birth.isoformat(), leela.gender, leela.clinic), ("1990-03-14", "female", self.clinic))
        self.assertTrue(leela.identifiers.filter(revoked_at__isnull=True).exists())
        self.assertEqual(Patient.objects.get(first_name="Farid").old_file_number, "F-9")
        # One audit row for the import, with no patient named.
        event = AuditEvent.objects.get(action="patient.import")
        self.assertIsNone(event.resource_id)
        again = self.client.post(
            "/api/v1/patients/import/", {"rows": self.ROWS, "dry_run": False, "include_duplicates": True}, format="json"
        ).data
        self.assertEqual(again["created"], 3)

    def test_import_and_export_are_for_the_owner(self):
        exported = self.client.get("/api/v1/patients/export/")
        text = exported.content.decode()
        self.assertEqual(exported.status_code, 200)
        self.assertIn("Anita,,Synthetic,1984-03-14", text)
        self.assertNotIn("Other", text)
        self.assertNotIn("Anita", exported["Content-Disposition"])
        for bad in [{"rows": []}, {"rows": "text"}, {"rows": [["a"]]}, {}]:
            self.assertEqual(self.client.post("/api/v1/patients/import/", bad, format="json").status_code, 400, bad)
        for role in ["admin", "clinician", "reception"]:
            self.role(role)
            self.assertEqual(self.client.post("/api/v1/patients/import/", {"rows": self.ROWS}, format="json").status_code, 403, role)
            self.assertEqual(self.client.get("/api/v1/patients/export/").status_code, 403, role)


class DocumentBackupTests(BackupTestCase):
    def test_documents_and_consent_come_back_from_a_backup(self):
        savepoint = transaction.savepoint()
        clinic, owner, recovery = bootstrap()
        patient = Patient.objects.create(clinic=clinic, first_name="Zebedee", date_of_birth="1990-01-01", gender="other")
        key = default_storage.save(f"clinics/{clinic.pk}/documents/synthetic.pdf", io.BytesIO(PDF))
        PatientDocument.objects.create(
            patient=patient,
            title="Blood report",
            storage_key=key,
            mime_type="application/pdf",
            byte_size=len(PDF),
            sha256="0" * 64,
            uploaded_by=owner,
        )
        PatientConsent.objects.create(patient=patient, kind="care", granted=True, recorded_by=owner)
        self.place(clinic)
        run = backup.run_backup(clinic, user=owner)
        self.assertTrue(run.ok, run.places)
        transaction.savepoint_rollback(savepoint)
        default_storage.delete(key)
        manifest = backup.restore_backup(self.folder / run.file_name, password=PASSWORD)
        self.assertEqual(manifest["counts"]["files"], 1)
        document = PatientDocument.objects.get()
        self.assertEqual((document.title, default_storage.open(document.storage_key).read()), ("Blood report", PDF))
        self.assertTrue(PatientConsent.objects.get().granted)
        default_storage.delete(document.storage_key)
