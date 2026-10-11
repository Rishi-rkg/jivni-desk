"""Database-level safeguards for bills, on both supported databases.

Payments, credit notes, bill history and day closes are append-only (the shared trigger from
records/guards.py). On top of that:

- an issued or void bill keeps its number, figures, patient and snapshot, never returns to a draft,
  and is never deleted; a void bill stays void;
- the lines of an issued or void bill cannot be changed or removed.

SQLite gets these from here after every migrate; PostgreSQL gets them from billing migration 0002.
`billing/tests/test_guards.py` checks both.
"""

APPEND_ONLY_TABLES = ["billing_payment", "billing_creditnote", "billing_invoiceevent", "billing_dayclose"]

INVOICE_MESSAGE = "An issued bill cannot be changed"
LINE_MESSAGE = "The lines of an issued bill cannot be changed"

# Columns of an issued bill that may never change again. Migration 0002 lists the same ones for PostgreSQL.
FROZEN = [
    "number",
    "clinic_id",
    "patient_id",
    "encounter_id",
    "buyer_name",
    "buyer_phone",
    "subtotal",
    "total",
    "tax_total",
    "discount",
    "discount_reason",
    "note",
    "issued_at",
    "snapshot",
]


def sqlite_statements(existing):
    if "billing_invoice" not in existing:
        return
    changed = " OR ".join(f"NEW.{column} IS NOT OLD.{column}" for column in FROZEN)
    yield (
        "CREATE TRIGGER IF NOT EXISTS guard_invoice_frozen BEFORE UPDATE ON billing_invoice "
        f"WHEN OLD.status <> 'draft' AND (NEW.status = 'draft' OR (OLD.status = 'void' AND NEW.status <> 'void') OR {changed}) "
        f"BEGIN SELECT RAISE(ABORT, '{INVOICE_MESSAGE}'); END"
    )
    yield (
        "CREATE TRIGGER IF NOT EXISTS guard_invoice_kept BEFORE DELETE ON billing_invoice "
        f"WHEN OLD.status <> 'draft' BEGIN SELECT RAISE(ABORT, '{INVOICE_MESSAGE}'); END"
    )
    if "billing_invoiceline" in existing:
        for event in ("UPDATE", "DELETE"):
            yield (
                f"CREATE TRIGGER IF NOT EXISTS guard_invoiceline_{event.lower()} BEFORE {event} ON billing_invoiceline "
                "WHEN (SELECT status FROM billing_invoice WHERE id = OLD.invoice_id) <> 'draft' "
                f"BEGIN SELECT RAISE(ABORT, '{LINE_MESSAGE}'); END"
            )
