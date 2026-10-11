from django.db import migrations

# PostgreSQL: products advised at a visit and amendments to a visit are append-only, and the check on
# measurements learns blood pressure and pulse. SQLite gets the same from records/guards.py.
APPEND_ONLY_TABLES = ["records_encounterproduct", "records_encounteramendment"]

NEW_CHECK = """
    CREATE OR REPLACE FUNCTION clinic_guard_observation() RETURNS trigger AS $$
    BEGIN
        IF NEW.patient_id IS DISTINCT FROM (SELECT patient_id FROM records_encounter WHERE id = NEW.encounter_id) THEN
            RAISE EXCEPTION 'Observation patient must match encounter';
        END IF;
        IF NOT ((NEW.kind = 'height' AND NEW.unit = 'cm') OR (NEW.kind = 'weight' AND NEW.unit = 'kg')
                OR (NEW.kind = 'systolic' AND NEW.unit = 'mmHg') OR (NEW.kind = 'diastolic' AND NEW.unit = 'mmHg')
                OR (NEW.kind = 'pulse' AND NEW.unit = 'bpm')) THEN
            RAISE EXCEPTION 'Invalid observation units';
        END IF;
        RETURN NEW;
    END; $$ LANGUAGE plpgsql;
"""
OLD_CHECK = """
    CREATE OR REPLACE FUNCTION clinic_guard_observation() RETURNS trigger AS $$
    BEGIN
        IF NEW.patient_id IS DISTINCT FROM (SELECT patient_id FROM records_encounter WHERE id = NEW.encounter_id) THEN
            RAISE EXCEPTION 'Observation patient must match encounter';
        END IF;
        IF NOT ((NEW.kind = 'height' AND NEW.unit = 'cm') OR (NEW.kind = 'weight' AND NEW.unit = 'kg')) THEN
            RAISE EXCEPTION 'Invalid observation units';
        END IF;
        RETURN NEW;
    END; $$ LANGUAGE plpgsql;
"""


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute(NEW_CHECK)
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(
            f"CREATE TRIGGER guard_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION clinic_guard_append_only();"
        )


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f"DROP TRIGGER guard_append_only ON {table};")
    schema_editor.execute(OLD_CHECK)


class Migration(migrations.Migration):
    dependencies = [("records", "0008_visit_drafts_products_amendments")]
    operations = [migrations.RunPython(install, uninstall)]
