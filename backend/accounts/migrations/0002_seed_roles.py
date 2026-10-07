from django.db import migrations


def seed(apps, schema_editor):
    Role = apps.get_model("accounts", "Role")
    for code, label in [
        ("owner", "Owner"), ("admin", "Administrator"), ("clinician", "Clinician"),
        ("assistant", "Clinical assistant"), ("reception", "Reception"), ("billing", "Billing"),
    ]:
        Role.objects.update_or_create(code=code, defaults={"label": label})


class Migration(migrations.Migration):
    dependencies = [("accounts", "0001_initial")]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
