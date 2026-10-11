from django.db import migrations

# PostgreSQL triggers: saved layouts and the record of what was printed are append-only.
# SQLite gets the same from records/guards.py after every migrate (registered in printing/apps.py).
APPEND_ONLY_TABLES = ["printing_printtemplate", "printing_printjob"]


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
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


class Migration(migrations.Migration):
    dependencies = [("printing", "0001_initial"), ("records", "0002_record_guards")]
    operations = [migrations.RunPython(install, uninstall)]
