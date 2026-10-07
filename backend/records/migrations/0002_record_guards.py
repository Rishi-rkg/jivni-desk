from django.db import migrations

IMMUTABLE_TABLES = ["records_patient", "records_patientaddress", "records_patientphoto"]
APPEND_ONLY_TABLES = ["records_patientnote", "records_encounter", "records_observation", "records_prescription", "records_prescriptionitem", "audit_auditevent"]


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("""
        CREATE FUNCTION clinic_guard_identity() RETURNS trigger AS $$
        BEGIN
            IF NEW.id IS DISTINCT FROM OLD.id THEN
                RAISE EXCEPTION 'Record identity is immutable';
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE FUNCTION clinic_guard_patient_clinic() RETURNS trigger AS $$
        BEGIN
            IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id THEN
                RAISE EXCEPTION 'Patient clinic is immutable';
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE FUNCTION clinic_guard_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'Clinical records and audit events are append-only';
        END; $$ LANGUAGE plpgsql;
        CREATE FUNCTION clinic_guard_observation() RETURNS trigger AS $$
        BEGIN
            IF NEW.patient_id IS DISTINCT FROM (SELECT patient_id FROM records_encounter WHERE id = NEW.encounter_id) THEN
                RAISE EXCEPTION 'Observation patient must match encounter';
            END IF;
            IF NOT ((NEW.kind = 'height' AND NEW.unit = 'cm') OR (NEW.kind = 'weight' AND NEW.unit = 'kg')) THEN
                RAISE EXCEPTION 'Invalid observation units';
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER guard_patient_clinic BEFORE UPDATE ON records_patient
            FOR EACH ROW EXECUTE FUNCTION clinic_guard_patient_clinic();
        CREATE TRIGGER guard_observation BEFORE INSERT ON records_observation
            FOR EACH ROW EXECUTE FUNCTION clinic_guard_observation();
    """)
    for table in IMMUTABLE_TABLES:
        schema_editor.execute(f"CREATE TRIGGER guard_identity BEFORE UPDATE ON {table} FOR EACH ROW EXECUTE FUNCTION clinic_guard_identity();")
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f"CREATE TRIGGER guard_append_only BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW EXECUTE FUNCTION clinic_guard_append_only();")


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    for table in IMMUTABLE_TABLES:
        schema_editor.execute(f"DROP TRIGGER guard_identity ON {table};")
    for table in APPEND_ONLY_TABLES:
        schema_editor.execute(f"DROP TRIGGER guard_append_only ON {table};")
    schema_editor.execute("""
        DROP TRIGGER guard_patient_clinic ON records_patient;
        DROP TRIGGER guard_observation ON records_observation;
        DROP FUNCTION clinic_guard_identity();
        DROP FUNCTION clinic_guard_patient_clinic();
        DROP FUNCTION clinic_guard_append_only();
        DROP FUNCTION clinic_guard_observation();
    """)


class Migration(migrations.Migration):
    dependencies = [("records", "0001_initial"), ("audit", "0001_initial")]
    operations = [migrations.RunPython(install, uninstall)]
