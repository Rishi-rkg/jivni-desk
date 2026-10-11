import secrets
from django.db import migrations

# Same alphabet and shape as records.models.new_patient_code; copied because migrations must not
# depend on application code that may change later.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"


def issue_codes(apps, schema_editor):
    Patient = apps.get_model("records", "Patient")
    PatientIdentifier = apps.get_model("records", "PatientIdentifier")
    for patient in Patient.objects.filter(identifiers__isnull=True).iterator():
        while True:
            code = "PAT-" + "".join(secrets.choice(ALPHABET) for _ in range(10))
            if not PatientIdentifier.objects.filter(code=code).exists():
                break
        PatientIdentifier.objects.create(patient=patient, code=code)


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    # Reuses the guard functions created in 0002_record_guards.
    schema_editor.execute("CREATE TRIGGER guard_identity BEFORE UPDATE ON records_patientidentifier FOR EACH ROW EXECUTE FUNCTION clinic_guard_identity();")
    schema_editor.execute("CREATE TRIGGER guard_append_only BEFORE UPDATE OR DELETE ON records_patientrevision FOR EACH ROW EXECUTE FUNCTION clinic_guard_append_only();")


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("DROP TRIGGER guard_identity ON records_patientidentifier;")
    schema_editor.execute("DROP TRIGGER guard_append_only ON records_patientrevision;")


class Migration(migrations.Migration):
    dependencies = [("records", "0004_patient_codes_and_revisions")]
    operations = [
        migrations.RunPython(issue_codes, migrations.RunPython.noop),
        migrations.RunPython(install, uninstall),
    ]
