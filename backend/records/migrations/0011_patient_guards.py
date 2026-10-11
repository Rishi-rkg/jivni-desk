from django.db import migrations

# PostgreSQL: consent answers and patient documents are append-only. SQLite gets the same from records/guards.py.
APPEND_ONLY_TABLES = ["records_patientconsent", "records_patientdocument"]


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(
            f"CREATE TRIGGER guard_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION clinic_guard_append_only();"
        )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f"DROP TRIGGER guard_append_only ON {table};")


class Migration(migrations.Migration):
    dependencies = [("records", "0010_patient_details_family_consent_documents")]
    operations = [migrations.RunPython(install, uninstall)]
