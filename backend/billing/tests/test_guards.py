"""The database itself keeps issued bills and their money trail as they were, on both engines.

These tests go around the model code on purpose (plain querysets and raw SQL): the triggers are
there for the day application code is wrong.
"""

from decimal import Decimal

from django.db import DatabaseError, connection, models, transaction
from django.test import TestCase
from django.utils import timezone

from accounts.models import Clinic, User
from billing import guards
from billing.models import CreditNote, DayClose, Invoice, InvoiceEvent, InvoiceLine, Payment
from records import guards as record_guards
from vault import backup
from vault.tests.test_backup import PASSWORD, BackupTestCase, bootstrap


def plain(model):
    return models.QuerySet(model)


class BillGuardTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password")
        self.draft = self.bill()
        self.issued = self.bill()
        plain(Invoice).filter(pk=self.issued.pk).update(status="issued", number="INV/26-27/0001", issued_at=timezone.now())

    def bill(self):
        invoice = Invoice.objects.create(clinic=self.clinic, created_by=self.user, total=Decimal("100"))
        InvoiceLine.objects.create(invoice=invoice, kind="service", description="Consultation", rate=Decimal("100"))
        return invoice

    def refused(self, action, message):
        with self.assertRaises(DatabaseError) as caught, transaction.atomic():
            action()
        self.assertIn(message, str(caught.exception))

    def test_an_issued_bill_keeps_its_number_figures_and_snapshot(self):
        for change in [
            {"number": "INV/26-27/0009"},
            {"total": Decimal("1")},
            {"discount": Decimal("5")},
            {"snapshot": {"clinic": {"name": "Changed"}}},
            {"status": "draft"},
            {"note": "Changed"},
            {"clinic": Clinic.objects.create(name="Other clinic")},
        ]:
            self.refused(lambda change=change: plain(Invoice).filter(pk=self.issued.pk).update(**change), guards.INVOICE_MESSAGE)
        with self.assertRaises(DatabaseError) as caught, transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("DELETE FROM billing_invoice WHERE status <> 'draft'")
        self.assertIn(guards.INVOICE_MESSAGE, str(caught.exception))
        # It can still be made void, once, and stays void.
        plain(Invoice).filter(pk=self.issued.pk).update(status="void", void_reason="Synthetic", voided_at=timezone.now())
        self.refused(lambda: plain(Invoice).filter(pk=self.issued.pk).update(status="issued"), guards.INVOICE_MESSAGE)

    def test_the_lines_of_an_issued_bill_are_fixed_and_a_draft_stays_editable(self):
        line = self.issued.lines.get()
        self.refused(lambda: plain(InvoiceLine).filter(pk=line.pk).update(rate=Decimal("1")), guards.LINE_MESSAGE)
        self.refused(lambda: plain(InvoiceLine).filter(pk=line.pk).delete(), guards.LINE_MESSAGE)
        plain(InvoiceLine).filter(invoice=self.draft).update(rate=Decimal("250"))
        plain(Invoice).filter(pk=self.draft.pk).update(total=Decimal("250"), note="Edited while a draft")
        self.draft.refresh_from_db()
        self.draft.delete()
        self.assertFalse(Invoice.objects.filter(pk=self.draft.pk).exists())

    def test_money_and_history_rows_are_append_only(self):
        rows = [
            Payment.objects.create(
                invoice=self.issued, amount=Decimal("10"), method="cash", received_by=self.user, receipt_number="R/26-27/0001"
            ),
            CreditNote.objects.create(
                invoice=self.issued, number="CN/26-27/0001", amount=Decimal("5"), reason="Synthetic", created_by=self.user
            ),
            InvoiceEvent.objects.create(invoice=self.issued, action="issued", actor=self.user),
            DayClose.objects.create(
                clinic=self.clinic, day="2026-10-06", expected_cash=Decimal("10"), cash_counted=Decimal("10"), closed_by=self.user
            ),
        ]
        self.assertEqual({row._meta.db_table for row in rows}, set(guards.APPEND_ONLY_TABLES))
        for row in rows:
            table = row._meta.db_table
            self.refused(lambda row=row: plain(type(row)).filter(pk=row.pk).update(created_at=None), record_guards.APPEND_ONLY_MESSAGE)
            with self.assertRaises(DatabaseError, msg=table) as caught, transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(f"DELETE FROM {table}")  # noqa: S608 - table names are constants from guards.py
            self.assertIn(record_guards.APPEND_ONLY_MESSAGE, str(caught.exception), table)
        # The model code refuses too, before the database is asked.
        with self.assertRaises(Exception):  # noqa: B017 - any refusal will do
            rows[0].delete()

    def test_every_billing_trigger_is_installed(self):
        installed = record_guards.guarded_tables()
        for table in guards.APPEND_ONLY_TABLES:
            self.assertTrue(any("append_only" in name for name in installed.get(table, ())), table)
        self.assertTrue(any("invoice_frozen" in name for name in installed.get("billing_invoice", ())))
        self.assertTrue(any("invoiceline" in name for name in installed.get("billing_invoiceline", ())))


class BillingBackupTests(BackupTestCase):
    def test_bills_and_payments_come_back_from_a_backup(self):
        savepoint = transaction.savepoint()
        clinic, owner, recovery = bootstrap()
        invoice = Invoice.objects.create(clinic=clinic, created_by=owner, buyer_name="Zebedee Walkin")
        InvoiceLine.objects.create(
            invoice=invoice, kind="shelf", description="Calendula cream 30 g", rate=Decimal("120"), gst_rate=Decimal("18")
        )
        invoice.refresh_totals()
        invoice.status, invoice.number, invoice.issued_at, invoice.snapshot = (
            "issued",
            "INV/26-27/0001",
            timezone.now(),
            {"clinic": {"name": clinic.name}},
        )
        invoice.save()
        Payment.objects.create(invoice=invoice, amount=Decimal("120"), method="upi", received_by=owner, receipt_number="R/26-27/0001")
        InvoiceEvent.objects.create(invoice=invoice, action="issued", actor=owner)
        self.place(clinic)
        run = backup.run_backup(clinic, user=owner)
        self.assertTrue(run.ok, run.places)
        path = self.folder / run.file_name
        self.assertNotIn(b"Zebedee", path.read_bytes())
        transaction.savepoint_rollback(savepoint)
        self.assertFalse(Invoice.objects.exists())

        backup.restore_backup(path, password=PASSWORD)
        restored = Invoice.objects.get()
        self.assertEqual(
            (restored.number, restored.state, restored.total, restored.buyer_name),
            ("INV/26-27/0001", "paid", Decimal("120.00"), "Zebedee Walkin"),
        )
        self.assertEqual(restored.lines.get().description, "Calendula cream 30 g")
        self.assertEqual((restored.payments.get().receipt_number, restored.events.get().action), ("R/26-27/0001", "issued"))
        # The restored bill is still protected.
        with self.assertRaises(DatabaseError), transaction.atomic():
            plain(Invoice).filter(pk=restored.pk).update(total=Decimal("1"))
