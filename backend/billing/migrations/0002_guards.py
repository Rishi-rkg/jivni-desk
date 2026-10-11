from django.db import migrations

# PostgreSQL triggers for bills. SQLite gets the same rules from billing/guards.py after every migrate.
# Written out in full here because a migration must not depend on application code that may change later.
APPEND_ONLY_TABLES = ["billing_payment", "billing_creditnote", "billing_invoiceevent", "billing_dayclose"]
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


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    changed = " OR ".join(f"NEW.{column} IS DISTINCT FROM OLD.{column}" for column in FROZEN)
    schema_editor.execute(f"""
        CREATE FUNCTION billing_guard_invoice() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'An issued bill cannot be changed'; END IF;
                RETURN OLD;
            END IF;
            IF OLD.status <> 'draft' AND (NEW.status = 'draft' OR (OLD.status = 'void' AND NEW.status <> 'void') OR {changed}) THEN
                RAISE EXCEPTION 'An issued bill cannot be changed';
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE FUNCTION billing_guard_invoiceline() RETURNS trigger AS $$
        BEGIN
            IF (SELECT status FROM billing_invoice WHERE id = OLD.invoice_id) <> 'draft' THEN
                RAISE EXCEPTION 'The lines of an issued bill cannot be changed';
            END IF;
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER guard_invoice_frozen BEFORE UPDATE OR DELETE ON billing_invoice
            FOR EACH ROW EXECUTE FUNCTION billing_guard_invoice();
        CREATE TRIGGER guard_invoiceline_frozen BEFORE UPDATE OR DELETE ON billing_invoiceline
            FOR EACH ROW EXECUTE FUNCTION billing_guard_invoiceline();
    """)
    for table in APPEND_ONLY_TABLES:
        # Reuses the function created in records migration 0002.
        schema_editor.execute(
            f"CREATE TRIGGER guard_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION clinic_guard_append_only();"
        )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f"DROP TRIGGER guard_append_only ON {table};")
    schema_editor.execute("""
        DROP TRIGGER guard_invoice_frozen ON billing_invoice;
        DROP TRIGGER guard_invoiceline_frozen ON billing_invoiceline;
        DROP FUNCTION billing_guard_invoice();
        DROP FUNCTION billing_guard_invoiceline();
    """)


class Migration(migrations.Migration):
    dependencies = [("billing", "0001_initial"), ("records", "0002_record_guards")]
    operations = [migrations.RunPython(install, uninstall)]
