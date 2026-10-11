"""Restore drill: restore a backup file into a brand-new, empty database and report what came back.

    python scripts/restore_drill.py BACKUP_FILE

Asks for a staff password (or set BACKUP_PASSWORD). Uses a scratch database named clinic_restore_drill on
the development PostgreSQL and a scratch folder for stored files, so the working data is never touched.
Run it regularly: a backup that has never been restored is only a hope.
"""
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_db  # noqa: E402

DATABASE = "clinic_restore_drill"


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    backup_file = str(Path(sys.argv[1]).resolve())
    local = dev_db.read_env()
    dev_db.start(local)
    env = dev_db.django_env(local)
    env.pop("TEST_DATABASE", None)
    env.update({"POSTGRES_DB": DATABASE, "DJANGO_DEBUG": "true", "DATA_PROTECTION_MODE": "development-only"})
    env["PATIENT_STORAGE_ROOT"] = tempfile.mkdtemp(prefix="dochp-restore-drill-")

    import psycopg

    with psycopg.connect(host=env["POSTGRES_HOST"], port=env["POSTGRES_PORT"], user=env["POSTGRES_USER"],
                         password=env["POSTGRES_PASSWORD"], dbname="postgres", autocommit=True) as connection:
        connection.execute(f'DROP DATABASE IF EXISTS "{DATABASE}" WITH (FORCE)')
        connection.execute(f'CREATE DATABASE "{DATABASE}"')

    manage = [sys.executable, "manage.py"]
    backend = ROOT / "backend"
    subprocess.run([*manage, "migrate", "--noinput", "-v", "0"], cwd=backend, env=env, check=True)
    started = time.perf_counter()
    result = subprocess.run([*manage, "restore_backup", backup_file], cwd=backend, env=env)
    if result.returncode:
        raise SystemExit("The restore drill FAILED.")
    print(f"Restore took {time.perf_counter() - started:.1f} seconds.")
    report = (
        "from accounts.models import Clinic, User; from records.models import Patient, Encounter; "
        "from audit.models import AuditEvent; "
        "print('Restored:', Clinic.objects.count(), 'clinic,', User.objects.count(), 'users,', Patient.objects.count(), "
        "'patients,', Encounter.objects.count(), 'visits,', AuditEvent.objects.count(), 'audit events')"
    )
    subprocess.run([*manage, "shell", "-c", report], cwd=backend, env=env, check=True)
    with psycopg.connect(host=env["POSTGRES_HOST"], port=env["POSTGRES_PORT"], user=env["POSTGRES_USER"],
                         password=env["POSTGRES_PASSWORD"], dbname="postgres", autocommit=True) as connection:
        connection.execute(f'DROP DATABASE IF EXISTS "{DATABASE}" WITH (FORCE)')
    print("The restore drill passed. The scratch database was removed.")


if __name__ == "__main__":
    main()
