"""Bills from draft to paid: the price list, numbering, GST, payments, corrections, lists and roles."""

import datetime
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from billing import money
from billing.models import Invoice, InvoiceEvent, Payment, PriceItem, Sequence
from records.models import Encounter, Patient, PatientIdentifier, Prescription


class MoneyTests(SimpleTestCase):
    def test_the_bill_in_the_mockup_adds_up(self):
        lines = [("service", 1, "500", "0"), ("prescribed", 1, "300", "5"), ("supplement", 1, "450", "18"), ("shelf", 1, "120", "18")]
        figures = money.totals(lines, Decimal("50"))
        self.assertEqual((figures["subtotal"], figures["total"]), (Decimal("1370.00"), Decimal("1320.00")))
        self.assertEqual(figures["tax_total"], Decimal("101.24"))
        self.assertEqual(
            [(row["rate"], row["taxable"], row["cgst"], row["sgst"]) for row in figures["tax_summary"]],
            [
                (Decimal("5"), Decimal("285.71"), Decimal("7.15"), Decimal("7.14")),
                (Decimal("18"), Decimal("483.05"), Decimal("43.48"), Decimal("43.47")),
            ],
        )

    def test_a_discount_comes_off_the_consultation_first_then_medicines_then_products(self):
        lines = [("supplement", 2, "100", "18"), ("service", 1, "50", "0"), ("prescribed", 1, "100", "5")]
        figures = money.totals(lines, Decimal("200"))
        # 50 off the consultation, 100 off the medicines, the last 50 off the products.
        self.assertEqual(figures["total"], Decimal("150.00"))
        self.assertEqual([row["rate"] for row in figures["tax_summary"]], [Decimal("18")])
        self.assertEqual(figures["tax_summary"][0]["taxable"], Decimal("127.12"))
        # A discount larger than the bill never makes it negative.
        self.assertEqual(money.totals(lines, Decimal("999"))["total"], Decimal("0.00"))
        self.assertEqual(money.totals([], Decimal("5"))["total"], Decimal("0.00"))

    def test_the_financial_year_runs_from_april(self):
        self.assertEqual(money.financial_year(datetime.date(2026, 3, 31)), "25-26")
        self.assertEqual(money.financial_year(datetime.date(2026, 4, 1)), "26-27")
        self.assertEqual(money.financial_year(datetime.date(2099, 12, 31)), "99-00")


class BillingTestCase(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic", time_zone="Asia/Kolkata", tax_identifier="27ABCDE1234F1Z5")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password", first_name="Dr Synthetic")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.patient = Patient.objects.create(
            clinic=self.clinic, first_name="Synthetic", last_name="Patient", date_of_birth="1990-01-01", gender="other", phone="5550100"
        )
        self.code = PatientIdentifier.issue(self.patient).code
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()
        # Document numbers carry the financial year the test happens to run in.
        self.fy = money.financial_year(self.clinic.today())

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def item(self, name="Vitamin D3 capsules, 60", kind="supplement", rate="450", gst="18", **more):
        return PriceItem.objects.create(clinic=self.clinic, name=name, kind=kind, rate=Decimal(rate), gst_rate=Decimal(gst), **more)

    def draft(self, **changes):
        body = {
            "patient_id": str(self.patient.pk),
            "lines": [
                {"kind": "service", "description": "Consultation, follow-up", "rate": "500", "gst_rate": "0"},
                {"kind": "prescribed", "description": "Prescribed medicines, 14 days", "rate": "300", "gst_rate": "5"},
                {"kind": "supplement", "description": "Vitamin D3 capsules, 60", "rate": "450", "gst_rate": "18"},
                {"kind": "shelf", "description": "Calendula cream 30 g", "rate": "120", "gst_rate": "18"},
            ],
            "discount": "50",
            "discount_reason": "Returning patient",
            **changes,
        }
        return self.client.post("/api/v1/invoices/", body, format="json")

    def issued(self, **changes):
        invoice = self.draft(**changes).data
        response = self.client.post(f"/api/v1/invoices/{invoice['id']}/issue/", {}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        return response.data

    def pay(self, invoice, amount, method="cash", **more):
        return self.client.post(f"/api/v1/invoices/{invoice['id']}/payments/", {"amount": amount, "method": method, **more}, format="json")


class PriceListTests(BillingTestCase):
    def test_a_new_clinic_gets_the_three_standard_items_at_zero(self):
        items = self.client.get("/api/v1/price-items/").data
        self.assertEqual({item["role"] for item in items}, {"consultation_first", "consultation_follow_up", "prescribed_per_week"})
        self.assertEqual({item["rate"] for item in items}, {"0.00"})
        self.assertEqual(len(self.client.get("/api/v1/price-items/").data), 3)
        self.assertFalse(PriceItem.objects.filter(clinic=self.other_clinic).exists())

    def test_owner_and_administrator_keep_the_list_and_others_only_read_it(self):
        body = {"name": "Vitamin D3 capsules, 60", "kind": "supplement", "rate": "450", "gst_rate": "18", "barcode": "8901234567890"}
        created = self.client.post("/api/v1/price-items/", body, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertTrue(AuditEvent.objects.filter(action="price_item.create").exists())
        changed = self.client.patch(f"/api/v1/price-items/{created.data['id']}/", {"rate": "475", "active": False}, format="json")
        self.assertEqual((changed.data["rate"], changed.data["active"]), ("475.00", False))
        self.assertEqual(self.client.delete(f"/api/v1/price-items/{created.data['id']}/").status_code, 405)
        self.role("admin")
        self.assertEqual(self.client.post("/api/v1/price-items/", {**body, "barcode": "8901234567891"}, format="json").status_code, 201)
        for role in ["clinician", "reception", "billing"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/price-items/").status_code, 200, role)
            self.assertEqual(self.client.post("/api/v1/price-items/", {**body, "barcode": ""}, format="json").status_code, 403, role)
        self.role("assistant")
        self.assertEqual(self.client.get("/api/v1/price-items/").status_code, 403)

    def test_bad_items_are_refused(self):
        self.item(barcode="8901234567890")
        base = {"name": "Calendula cream 30 g", "kind": "shelf", "rate": "120", "gst_rate": "18"}
        for bad in [
            {"barcode": "8901234567890"},  # already used
            {"barcode": "12 3"},
            {"rate": "-1"},
            {"gst_rate": "41"},
            {"kind": "gift"},
            {"name": ""},
            {"kind": "service", "barcode": "8901234567899"},
        ]:
            self.assertEqual(self.client.post("/api/v1/price-items/", {**base, **bad}, format="json").status_code, 400, bad)
        # The same barcode may exist in another clinic.
        PriceItem.objects.create(clinic=self.other_clinic, name="Other", kind="shelf", rate=1, barcode="8901234567890")

    def test_items_of_another_clinic_cannot_be_changed_or_billed(self):
        foreign = PriceItem.objects.create(clinic=self.other_clinic, name="Other", kind="shelf", rate=1)
        self.assertEqual(self.client.patch(f"/api/v1/price-items/{foreign.pk}/", {"rate": "2"}, format="json").status_code, 404)
        response = self.draft(lines=[{"price_item": str(foreign.pk)}])
        self.assertEqual(response.status_code, 400)


class DraftTests(BillingTestCase):
    def test_a_draft_adds_up_and_can_be_edited_and_deleted(self):
        response = self.draft()
        self.assertEqual(response.status_code, 201, response.data)
        bill = response.data
        self.assertEqual((bill["status"], bill["state"], bill["number"]), ("draft", "draft", ""))
        self.assertEqual((bill["subtotal"], bill["total"], bill["tax_total"], bill["balance"]), ("1370.00", "1320.00", "101.24", "1320.00"))
        self.assertEqual([line["group"] for line in bill["lines"]], ["care", "care", "products", "products"])
        self.assertEqual(bill["tax_summary"][0], {"rate": "5", "taxable": "285.71", "cgst": "7.15", "sgst": "7.14"})
        self.assertEqual(bill["history"][-1]["action"], "created")
        self.assertEqual(bill["patient"]["name"], "Synthetic Patient")

        changed = self.client.patch(
            f"/api/v1/invoices/{bill['id']}/",
            {"lines": [{"kind": "service", "description": "Consultation", "rate": "400", "quantity": "2"}], "discount": "0"},
            format="json",
        )
        self.assertEqual(changed.status_code, 200, changed.data)
        self.assertEqual((changed.data["total"], len(changed.data["lines"]), changed.data["tax_summary"]), ("800.00", 1, []))
        self.assertEqual(self.client.delete(f"/api/v1/invoices/{bill['id']}/").status_code, 204)
        self.assertFalse(Invoice.objects.exists())
        self.assertTrue(AuditEvent.objects.filter(action="invoice.delete_draft").exists())

    def test_a_line_from_the_price_list_takes_its_details_and_keeps_them(self):
        item = self.item()
        bill = self.draft(lines=[{"price_item": str(item.pk), "quantity": "2"}], discount="0").data
        line = bill["lines"][0]
        self.assertEqual(
            (line["description"], line["kind"], line["rate"], line["gst_rate"], line["amount"]),
            (item.name, "supplement", "450.00", "18.00", "900.00"),
        )
        # The price list changes later; the bill does not.
        item.rate, item.name = Decimal("999"), "Renamed"
        item.save()
        self.assertEqual(self.client.get(f"/api/v1/invoices/{bill['id']}/").data["lines"][0]["description"], "Vitamin D3 capsules, 60")

    def test_a_walk_in_bill_needs_no_patient(self):
        bill = self.draft(patient_id=None, buyer_name="Walk-in customer", buyer_phone="5550199", discount="0").data
        self.assertIsNone(bill["patient"])
        self.assertEqual(bill["buyer_name"], "Walk-in customer")
        issued = self.client.post(f"/api/v1/invoices/{bill['id']}/issue/", {"payment": {"method": "upi"}}, format="json").data
        self.assertEqual((issued["state"], issued["paid"], issued["snapshot"]["patient"]), ("paid", "1370.00", None))

    def test_bad_drafts_are_refused(self):
        other_patient = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        for bad in [
            {"patient_id": str(other_patient.pk)},
            {"discount": "5000"},
            {"discount": "-1"},
            {"lines": [{"kind": "service", "description": "x", "rate": "-5"}]},
            {"lines": [{"kind": "service", "description": "x", "rate": "5", "quantity": "0"}]},
            {"lines": [{"kind": "service", "rate": "5"}]},
            {"lines": [{"kind": "service", "description": "x", "rate": "5", "source": "magic"}]},
            {"lines": [{"kind": "service", "description": "x", "rate": "1"}] * 61},
        ]:
            self.assertEqual(self.draft(**bad).status_code, 400, bad)
        self.assertFalse(Invoice.objects.exists())

    def test_a_bill_cannot_be_issued_empty_or_twice(self):
        empty = self.draft(lines=[], discount="0").data
        self.assertEqual(self.client.post(f"/api/v1/invoices/{empty['id']}/issue/", {}, format="json").status_code, 400)
        bill = self.issued()
        self.assertEqual(self.client.post(f"/api/v1/invoices/{bill['id']}/issue/", {}, format="json").status_code, 400)
        self.assertEqual(Sequence.objects.get(kind="invoice").last, 1)

    def test_product_lines_need_product_sales_switched_on(self):
        self.clinic.features = {"product_sales": False}
        self.clinic.save()
        self.assertEqual(self.draft().status_code, 400)
        only_care = self.draft(lines=[{"kind": "service", "description": "Consultation", "rate": "500"}], discount="0")
        self.assertEqual(only_care.status_code, 201)


class IssueAndPaymentTests(BillingTestCase):
    def test_issuing_numbers_the_bill_and_freezes_a_snapshot(self):
        first, second = self.issued(), self.issued()
        self.assertEqual((first["number"], second["number"]), (f"INV/{self.fy}/0001", f"INV/{self.fy}/0002"))
        self.assertEqual((first["status"], first["state"], first["date"]), ("issued", "issued", self.clinic.today().isoformat()))
        snapshot = first["snapshot"]
        self.assertEqual(
            (snapshot["clinic"]["name"], snapshot["clinic"]["gstin"], snapshot["show_gst"]), ("Synthetic clinic", "27ABCDE1234F1Z5", True)
        )
        self.assertEqual(
            (snapshot["patient"]["name"], snapshot["patient"]["code"], snapshot["issued_by"]),
            ("Synthetic Patient", self.code, "Dr Synthetic"),
        )
        # Later changes to the clinic or the patient do not reach the issued bill.
        self.clinic.name, self.patient.first_name = "Renamed clinic", "Renamed"
        self.clinic.save()
        self.patient.save()
        again = self.client.get(f"/api/v1/invoices/{first['id']}/").data
        self.assertEqual(
            (again["snapshot"]["clinic"]["name"], again["snapshot"]["patient"]["name"]), ("Synthetic clinic", "Synthetic Patient")
        )
        # An issued bill cannot be edited or deleted.
        self.assertEqual(self.client.patch(f"/api/v1/invoices/{first['id']}/", {"discount": "0"}, format="json").status_code, 400)
        self.assertEqual(self.client.delete(f"/api/v1/invoices/{first['id']}/").status_code, 400)
        self.assertEqual(Invoice.objects.get(pk=first["id"]).total, Decimal("1320.00"))

    def test_numbers_start_again_each_financial_year_and_follow_the_clinic_prefix(self):
        self.clinic.invoice_prefix = "SC"
        self.clinic.save()
        # The clinic's own calendar day decides the year, not the server's clock.
        with mock.patch.object(Clinic, "today", return_value=datetime.date(2027, 3, 31)):
            last_of_year = self.issued()
        with mock.patch.object(Clinic, "today", return_value=datetime.date(2027, 4, 1)):
            first_of_next, second_of_next = self.issued(), self.issued()
        self.assertEqual(
            (last_of_year["number"], first_of_next["number"], second_of_next["number"]), ("SC/26-27/0001", "SC/27-28/0001", "SC/27-28/0002")
        )

    def test_no_gstin_means_no_gst_on_the_bill(self):
        self.clinic.tax_identifier = ""
        self.clinic.save()
        self.assertFalse(self.issued()["snapshot"]["show_gst"])
        self.clinic.tax_identifier, self.clinic.features = "27ABCDE1234F1Z5", {"show_gst": False}
        self.clinic.save()
        self.assertFalse(self.issued()["snapshot"]["show_gst"])

    def test_payments_move_the_bill_from_issued_to_paid(self):
        bill = self.issued()
        part = self.pay(bill, "1000", "upi", reference="UPI-REF-1")
        self.assertEqual(part.status_code, 201, part.data)
        self.assertEqual((part.data["state"], part.data["paid"], part.data["balance"]), ("partially_paid", "1000.00", "320.00"))
        payment = part.data["payments"][0]
        self.assertEqual(
            (payment["receipt_number"], payment["method"], payment["received_by_name"]), (f"R/{self.fy}/0001", "upi", "Dr Synthetic")
        )
        self.assertEqual(self.pay(bill, "320.01").status_code, 400)  # more than the balance
        self.assertEqual(self.pay(bill, "0").status_code, 400)
        self.assertEqual(self.pay(bill, "10", "cheque").status_code, 400)
        rest = self.pay(bill, "320")
        self.assertEqual((rest.data["state"], rest.data["balance"]), ("paid", "0.00"))
        self.assertEqual([event["action"] for event in rest.data["history"]], ["payment", "payment", "issued", "created"])
        self.assertEqual(self.pay(bill, "1").status_code, 400)
        draft = self.draft().data
        self.assertEqual(self.pay(draft, "10").status_code, 400)

    def test_issue_and_take_payment_in_one_step(self):
        bill = self.draft().data
        response = self.client.post(f"/api/v1/invoices/{bill['id']}/issue/", {"payment": {"method": "cash"}}, format="json")
        self.assertEqual((response.data["state"], response.data["paid"]), ("paid", "1320.00"))
        # A payment that cannot be taken leaves the bill a draft: nothing is half done.
        other = self.draft().data
        bad = self.client.post(f"/api/v1/invoices/{other['id']}/issue/", {"payment": {"method": "cash", "amount": "9999"}}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(Invoice.objects.get(pk=other["id"]).status, "draft")
        self.assertEqual(Sequence.objects.get(kind="invoice").last, 1)

    def test_void_credit_note_and_refund_are_for_owner_and_billing_with_a_reason(self):
        bill = self.issued()
        url = f"/api/v1/invoices/{bill['id']}"
        self.assertEqual(self.client.post(f"{url}/void/", {}, format="json").status_code, 400)  # no reason
        for role in ["reception", "clinician"]:
            self.role(role)
            for step, body in [
                ("void", {"reason": "x"}),
                ("credit-note", {"amount": "1", "reason": "x"}),
                ("refund", {"amount": "1", "method": "cash", "reason": "x"}),
            ]:
                self.assertEqual(self.client.post(f"{url}/{step}/", body, format="json").status_code, 403, (role, step))
        self.role("billing")
        self.pay(bill, "500")
        self.assertEqual(self.client.post(f"{url}/void/", {"reason": "Wrong patient"}, format="json").status_code, 400)  # money was taken
        self.assertEqual(
            self.client.post(f"{url}/refund/", {"amount": "600", "method": "cash", "reason": "x"}, format="json").status_code, 400
        )
        refunded = self.client.post(f"{url}/refund/", {"amount": "500", "method": "cash", "reason": "Paid twice"}, format="json")
        self.assertEqual((refunded.status_code, refunded.data["paid"], refunded.data["state"]), (201, "0.00", "issued"))
        voided = self.client.post(f"{url}/void/", {"reason": "Billed to the wrong patient"}, format="json")
        self.assertEqual(
            (voided.data["status"], voided.data["state"], voided.data["balance"], voided.data["void_reason"]),
            ("void", "void", "0.00", "Billed to the wrong patient"),
        )
        self.assertEqual(voided.data["number"], bill["number"])
        self.assertEqual(self.pay(bill, "10").status_code, 400)
        # The number is not reused.
        self.assertEqual(self.issued()["number"], f"INV/{self.fy}/0002")

    def test_a_credit_note_takes_an_amount_off_and_can_give_the_money_back(self):
        bill = self.issued()
        self.pay(bill, "1320")
        url = f"/api/v1/invoices/{bill['id']}/credit-note/"
        self.assertEqual(self.client.post(url, {"amount": "2000", "reason": "x"}, format="json").status_code, 400)
        self.assertEqual(self.client.post(url, {"amount": "120"}, format="json").status_code, 400)
        credited = self.client.post(url, {"amount": "120", "reason": "Cream returned unopened", "refund_method": "cash"}, format="json")
        self.assertEqual(credited.status_code, 201, credited.data)
        self.assertEqual(
            (credited.data["credited"], credited.data["paid"], credited.data["balance"], credited.data["state"]),
            ("120.00", "1200.00", "0.00", "paid"),
        )
        self.assertEqual(credited.data["credit_notes"][0]["number"], f"CN/{self.fy}/0001")
        self.assertEqual([p["kind"] for p in credited.data["payments"]], ["payment", "refund"])
        # Credited in full: the bill reads Refunded.
        full = self.client.post(url, {"amount": "1200", "reason": "Everything returned", "refund_method": "upi"}, format="json")
        self.assertEqual((full.data["state"], full.data["paid"], full.data["balance"]), ("refunded", "0.00", "0.00"))
        self.assertEqual(self.client.post(url, {"amount": "1", "reason": "x"}, format="json").status_code, 400)


class ListTests(BillingTestCase):
    def test_lists_filter_by_status_dates_patient_and_search(self):
        draft = self.draft().data
        issued = self.issued()
        part = self.issued()
        self.pay(part, "100")
        paid = self.issued(patient_id=None, buyer_name="Zebedee Walkin")
        self.pay(paid, "1320")
        void = self.issued()
        self.client.post(f"/api/v1/invoices/{void['id']}/void/", {"reason": "x"}, format="json")

        def ids(**options):
            response = self.client.post("/api/v1/invoices/find/", options, format="json")
            self.assertEqual(response.status_code, 200, response.data)
            return {row["id"] for row in response.data["results"]}

        self.assertEqual(len(ids()), 5)
        self.assertEqual(ids(state="draft"), {draft["id"]})
        self.assertEqual(ids(state="issued"), {issued["id"]})
        self.assertEqual(ids(state="partially_paid"), {part["id"]})
        self.assertEqual(ids(state="paid"), {paid["id"]})
        self.assertEqual(ids(state="void"), {void["id"]})
        self.assertEqual(ids(state="outstanding"), {issued["id"], part["id"]})
        self.assertEqual(ids(search="zebedee"), {paid["id"]})
        self.assertEqual(ids(search=issued["number"]), {issued["id"]})
        self.assertEqual(len(ids(search="Synthetic")), 4)
        self.assertEqual(ids(patient=str(self.patient.pk)), {draft["id"], issued["id"], part["id"], void["id"]})
        today = self.clinic.today()
        self.assertEqual(len(ids(**{"from": today.isoformat(), "to": today.isoformat()})), 5)
        self.assertEqual(ids(**{"from": (today + datetime.timedelta(days=1)).isoformat()}), set())
        self.assertEqual(self.client.post("/api/v1/invoices/find/", {"state": "lost"}, format="json").status_code, 400)
        # The plain list takes the same filters, for a patient's own billing tab.
        listed = self.client.get(f"/api/v1/invoices/?patient={self.patient.pk}&state=outstanding").data
        self.assertEqual({row["id"] for row in listed["results"]}, {issued["id"], part["id"]})
        self.assertEqual(listed["results"][0]["patient"]["name"], "Synthetic Patient")
        # A patient's name in a search is never written to the audit log.
        self.assertFalse(AuditEvent.objects.filter(action="invoice.list").exclude(resource_id=None).exists())

    def test_summary_day_end_outstanding_and_payments(self):
        first, second = self.issued(), self.issued()
        self.pay(first, "1000", "cash")
        self.pay(first, "320", "upi")
        self.pay(second, "500", "card")
        self.draft()
        summary = self.client.get("/api/v1/billing/summary/").data
        self.assertEqual(
            (
                summary["billed_today"],
                summary["invoices_today"],
                summary["collected_today"],
                summary["outstanding"],
                summary["outstanding_count"],
                summary["drafts"],
            ),
            ("2640.00", 2, "1820.00", "820.00", 1, 1),
        )
        day = self.client.get("/api/v1/billing/day-end/").data
        self.assertEqual(day["methods"], {"cash": "1000.00", "upi": "320.00", "card": "500.00", "bank": "0.00"})
        self.assertEqual((day["collected"], day["closed"]), ("1820.00", None))
        closed = self.client.post("/api/v1/billing/day-end/", {"cash_counted": "990", "note": "Ten short"}, format="json").data
        self.assertEqual(
            (closed["closed"]["expected_cash"], closed["closed"]["difference"], closed["closed"]["closed_by_name"]),
            ("1000.00", "-10.00", "Dr Synthetic"),
        )
        tomorrow = (self.clinic.today() + datetime.timedelta(days=1)).isoformat()
        self.assertEqual(
            self.client.post("/api/v1/billing/day-end/", {"day": tomorrow, "cash_counted": "0"}, format="json").status_code, 400
        )
        self.assertEqual(self.client.post("/api/v1/billing/day-end/", {"cash_counted": "lots"}, format="json").status_code, 400)
        payments = self.client.get("/api/v1/payments/").data
        self.assertEqual(payments["count"], 3)
        self.assertEqual({row["invoice_number"] for row in payments["results"]}, {first["number"], second["number"]})
        self.assertEqual(payments["results"][0]["patient"], "Synthetic Patient")
        self.role("reception")
        self.assertEqual(self.client.post("/api/v1/billing/day-end/", {"cash_counted": "1"}, format="json").status_code, 403)
        self.assertEqual(self.client.get("/api/v1/billing/export/").status_code, 403)

    def test_exports_are_spreadsheets_without_formulas(self):
        bill = self.issued(patient_id=None, buyer_name="=HYPERLINK(1)")
        self.pay(bill, "1320", "cash", reference="+123")
        for kind, expected in [("invoices", bill["number"]), ("payments", f"R/{self.fy}/0001"), ("accountant", "285.71")]:
            response = self.client.get(f"/api/v1/billing/export/?kind={kind}")
            self.assertEqual(response.status_code, 200, kind)
            text = response.content.decode("utf-8-sig")
            self.assertIn(expected, text, kind)
            self.assertNotIn(",=HYPERLINK", text)
            self.assertNotIn("Synthetic", response["Content-Disposition"])
        self.assertIn("'=HYPERLINK(1)", self.client.get("/api/v1/billing/export/?kind=invoices").content.decode("utf-8-sig"))
        self.assertIn("'+123", self.client.get("/api/v1/billing/export/?kind=payments").content.decode("utf-8-sig"))
        self.assertEqual(self.client.get("/api/v1/billing/export/?kind=everything").status_code, 400)


class AccessTests(BillingTestCase):
    def test_another_clinics_bills_are_invisible(self):
        bill = self.issued()
        outsider = User.objects.create_user(username="other-owner", password="synthetic-password")
        Membership.objects.create(clinic=self.other_clinic, user=outsider, role_id="owner")
        client = APIClient()
        client.force_login(outsider)
        session = client.session
        session["clinic_id"] = str(self.other_clinic.pk)
        session.save()
        self.assertEqual(client.get("/api/v1/invoices/").data["count"], 0)
        self.assertEqual(client.post("/api/v1/invoices/find/", {}, format="json").data["count"], 0)
        self.assertEqual(client.get(f"/api/v1/invoices/{bill['id']}/").status_code, 404)
        for step in ["issue", "payments", "void", "refund", "credit-note", "printed"]:
            response = client.post(
                f"/api/v1/invoices/{bill['id']}/{step}/", {"amount": "1", "method": "cash", "reason": "x"}, format="json"
            )
            self.assertIn(response.status_code, {400, 404}, step)
        self.assertEqual(Payment.objects.count(), 0)
        self.assertEqual(client.get("/api/v1/billing/summary/").data["billed_today"], "0.00")
        self.assertEqual(client.get("/api/v1/payments/").data["count"], 0)

    def test_roles_without_billing_and_a_switched_off_clinic_are_refused(self):
        bill = self.issued()
        for role in ["assistant", "admin"]:
            self.role(role)
            self.assertEqual(self.client.get("/api/v1/invoices/").status_code, 403, role)
            self.assertEqual(self.client.get(f"/api/v1/invoices/{bill['id']}/").status_code, 403, role)
            self.assertEqual(self.draft().status_code, 403, role)
        self.assertTrue(AuditEvent.objects.filter(action="access.denied", outcome="denied").exists())
        self.role("owner")
        self.clinic.features = {"billing": False}
        self.clinic.save()
        for path in ["/api/v1/invoices/", "/api/v1/price-items/", "/api/v1/payments/", "/api/v1/billing/summary/"]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 403, path)
            self.assertIn("switched off", response.data["detail"])
        self.client.logout()
        self.assertEqual(self.client.get("/api/v1/invoices/").status_code, 401)

    def test_printing_is_noted_in_the_history(self):
        draft = self.draft().data
        self.assertEqual(self.client.post(f"/api/v1/invoices/{draft['id']}/printed/", {}, format="json").status_code, 400)
        bill = self.issued()
        self.assertEqual(self.client.post(f"/api/v1/invoices/{bill['id']}/printed/", {}, format="json").status_code, 200)
        self.assertEqual(InvoiceEvent.objects.filter(invoice_id=bill["id"], action="printed").count(), 1)


class FromVisitTests(BillingTestCase):
    def setUp(self):
        super().setUp()
        self.encounter = Encounter.objects.create(
            patient=self.patient,
            clinician=self.user,
            chief_complaint="Synthetic complaint",
            visit_type="follow_up",
            follow_up_date=self.clinic.local_date(timezone.now()) + datetime.timedelta(days=14),
        )
        for position, length in enumerate(["14", "7"]):
            Prescription.objects.create(
                encounter=self.encounter,
                prescriber=self.user,
                position=position,
                dosage_line="4 tabs, twice daily",
                dosage={"amount": "4", "unit": "tabs", "length": length, "period": "days"},
            )
        self.client.get("/api/v1/price-items/")  # creates the standard items
        PriceItem.objects.filter(clinic=self.clinic, role="consultation_follow_up").update(rate=Decimal("500"))
        PriceItem.objects.filter(clinic=self.clinic, role="prescribed_per_week").update(rate=Decimal("150"), gst_rate=Decimal("5"))

    def test_a_bill_from_a_visit_has_the_consultation_and_one_unnamed_medicines_line(self):
        response = self.client.post("/api/v1/invoices/from-visit/", {"encounter": str(self.encounter.pk)}, format="json")
        self.assertEqual(response.status_code, 201, response.data)
        bill = response.data
        self.assertEqual(
            [(line["description"], line["rate"], line["source"]) for line in bill["lines"]],
            [("Consultation, follow-up", "500.00", "visit"), ("Prescribed medicines, 14 days", "300.00", "visit")],
        )
        self.assertEqual(
            (bill["total"], bill["encounter"], bill["history"][-1]["action"]), ("800.00", self.encounter.pk, "created_from_visit")
        )
        # Asking again returns the same bill rather than billing the visit twice.
        again = self.client.post("/api/v1/invoices/from-visit/", {"encounter": str(self.encounter.pk)}, format="json")
        self.assertEqual((again.status_code, again.data["id"]), (200, bill["id"]))
        issued = self.client.post(f"/api/v1/invoices/{bill['id']}/issue/", {}, format="json").data
        visit = issued["snapshot"]["visit"]
        self.assertEqual(
            (visit["doctor"], visit["type"], visit["next_visit"]), ("Dr Synthetic", "Follow-up", self.encounter.follow_up_date.isoformat())
        )
        self.assertNotIn("Synthetic complaint", str(issued))

    def test_visits_of_other_clinics_and_nonsense_are_refused(self):
        other_patient = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        foreign = Encounter.objects.create(patient=other_patient, clinician=self.user, chief_complaint="x")
        for value in [str(foreign.pk), "not-an-id", None]:
            self.assertEqual(self.client.post("/api/v1/invoices/from-visit/", {"encounter": value}, format="json").status_code, 400, value)
        self.assertFalse(Invoice.objects.exists())


class ProductScanTests(BillingTestCase):
    def test_a_product_barcode_resolves_through_the_one_scan_service(self):
        item = self.item(barcode="8901234567890")
        self.item(name="Switched off", barcode="8901234567891", active=False)
        PriceItem.objects.create(clinic=self.other_clinic, name="Other clinic", kind="shelf", rate=1, barcode="8901234567892")
        response = self.client.get("/api/v1/scan/8901234567890/")
        self.assertEqual((response.status_code, response.data["kind"]), (200, "product"))
        self.assertEqual(
            response.data["product"], {"id": str(item.pk), "name": item.name, "kind": "supplement", "rate": "450.00", "gst_rate": "18.00"}
        )
        for code in ["8901234567891", "8901234567892", "0000000"]:
            self.assertEqual(self.client.get(f"/api/v1/scan/{code}/").data["kind"], "unknown", code)
        # A patient card still opens the patient.
        self.assertEqual(self.client.get(f"/api/v1/scan/{self.code}/").data["kind"], "patient")
        self.clinic.features = {"product_sales": False}
        self.clinic.save()
        self.assertEqual(self.client.get("/api/v1/scan/8901234567890/").status_code, 404)
