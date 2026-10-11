"""Restore drill: restore a backup file into a brand-new, empty database and report what came back.

    python scripts/restore_drill.py BACKUP_FILE            into a scratch PostgreSQL database
    python scripts/restore_drill.py BACKUP_FILE --sqlite   into a scratch SQLite database

Asks for a staff password (or set BACKUP_PASSWORD). Everything happens in a scratch database and a
scratch folder for stored files, so the working data is never touched. A backup made on either kind
of database restores into either. Run it regularly: a backup that has never been restored is only a hope.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_db  # noqa: E402

DATABASE = "clinic_restore_drill"
REPORT = (
    "from accounts.models import Clinic, User; from records.models import Patient, Encounter; "
    "from audit.models import AuditEvent; from django.db import connection; "
    "print('Restored into', connection.vendor + ':', Clinic.objects.count(), 'clinic,', User.objects.count(), 'users,', "
    "Patient.objects.count(), 'patients,', Encounter.objects.count(), 'visits,', AuditEvent.objects.count(), 'audit events')"
)


def scratch_postgres(env):
    import psycopg

    def recreate(create):
        with psycopg.connect(host=env["POSTGRES_HOST"], port=env["POSTGRES_PORT"], user=env["POSTGRES_USER"],
                             password=env["POSTGRES_PASSWORD"], dbname="postgres", autocommit=True) as connection:
            connection.execute(f'DROP DATABASE IF EXISTS "{DATABASE}" WITH (FORCE)')
            if create:
                connection.execute(f'CREATE DATABASE "{DATABASE}"')

    return recreate


def main():
    arguments = [value for value in sys.argv[1:] if value != "--sqlite"]
    if len(arguments) != 1:
        raise SystemExit(__doc__)
    use_sqlite = "--sqlite" in sys.argv
    backup_file = str(Path(arguments[0]).resolve())
    scratch = Path(tempfile.mkdtemp(prefix="dochp-restore-drill-"))
    if use_sqlite:
        env = dict(os.environ)
        env.update({"DATABASE_ENGINE": "sqlite", "DATABASE_PATH": str(scratch / "restored.sqlite3")})
        env.setdefault("DJANGO_SECRET_KEY", "restore-drill-secret-used-only-for-this-scratch-database")
        recreate = None
    else:
        local = dev_db.read_env()
        dev_db.start(local)
        env = dev_db.django_env(local)
        env["POSTGRES_DB"] = DATABASE
        recreate = scratch_postgres(env)
        recreate(True)
    env.pop("TEST_DATABASE", None)
    env.update({"DJANGO_DEBUG": "true", "DATA_PROTECTION_MODE": "development-only", "PATIENT_STORAGE_ROOT": str(scratch / "files")})

    manage = [sys.executable, "manage.py"]
    backend = ROOT / "backend"
    subprocess.run([*manage, "migrate", "--noinput", "-v", "0"], cwd=backend, env=env, check=True)
    started = time.perf_counter()
    if subprocess.run([*manage, "restore_backup", backup_file], cwd=backend, env=env).returncode:
        raise SystemExit("The restore drill FAILED.")
    print(f"Restore took {time.perf_counter() - started:.1f} seconds.")
    subprocess.run([*manage, "shell", "-c", REPORT], cwd=backend, env=env, check=True)
    if recreate:
        recreate(False)
    shutil.rmtree(scratch, ignore_errors=True)
    print("The restore drill passed. The scratch database and files were removed.")


if __name__ == "__main__":
    main()
