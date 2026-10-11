"""Database-level safeguards for records, on every supported database.

The model code already refuses to change or delete clinical history. These triggers make the
database itself refuse, so a mistake in application code, a raw SQL statement or an admin tool
cannot quietly rewrite a record.

PostgreSQL gets its triggers from migrations (records 0002 and 0005). SQLite gets them here, and
they are re-created after every migrate, because SQLite rebuilds a table when its columns change
and a rebuilt table loses its triggers.

A new clinical table must be added to the lists below AND to a new PostgreSQL migration;
`records/tests/test_guards.py` fails if either database is missing a guard.
"""

from django.db import connections
from django.db.models.signals import post_migrate

# Rows may be added but never changed or removed.
APPEND_ONLY_TABLES = [
    "records_patientnote",
    "records_encounter",
    "records_observation",
    "records_prescription",
    "records_prescriptionitem",
    "records_patientrevision",
    "audit_auditevent",
]
# Rows may change, but never their identity.
IDENTITY_TABLES = ["records_patient", "records_patientaddress", "records_patientphoto", "records_patientidentifier"]

APPEND_ONLY_MESSAGE = "Clinical records and audit events are append-only"
IDENTITY_MESSAGE = "Record identity is immutable"
CLINIC_MESSAGE = "Patient clinic is immutable"
OBSERVATION_MESSAGE = "Observation must match its encounter and use the right unit"


def _sqlite_statements(existing):
    for table in APPEND_ONLY_TABLES:
        if table in existing:
            for event in ("UPDATE", "DELETE"):
                yield (
                    f"CREATE TRIGGER IF NOT EXISTS guard_append_only_{event.lower()}_{table} BEFORE {event} ON {table} "
                    f"BEGIN SELECT RAISE(ABORT, '{APPEND_ONLY_MESSAGE}'); END"
                )
    for table in IDENTITY_TABLES:
        if table in existing:
            yield (
                f"CREATE TRIGGER IF NOT EXISTS guard_identity_{table} BEFORE UPDATE OF id ON {table} "
                f"WHEN NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, '{IDENTITY_MESSAGE}'); END"
            )
    if "records_patient" in existing:
        yield (
            "CREATE TRIGGER IF NOT EXISTS guard_patient_clinic BEFORE UPDATE OF clinic_id ON records_patient "
            f"WHEN NEW.clinic_id IS NOT OLD.clinic_id BEGIN SELECT RAISE(ABORT, '{CLINIC_MESSAGE}'); END"
        )
    if {"records_observation", "records_encounter"} <= existing:
        yield (
            "CREATE TRIGGER IF NOT EXISTS guard_observation BEFORE INSERT ON records_observation "
            "WHEN NEW.patient_id IS NOT (SELECT patient_id FROM records_encounter WHERE id = NEW.encounter_id) "
            "OR NOT ((NEW.kind = 'height' AND NEW.unit = 'cm') OR (NEW.kind = 'weight' AND NEW.unit = 'kg')) "
            f"BEGIN SELECT RAISE(ABORT, '{OBSERVATION_MESSAGE}'); END"
        )


def install_sqlite_guards(using="default"):
    connection = connections[using]
    if connection.vendor != "sqlite":
        return
    with connection.cursor() as cursor:
        existing = set(connection.introspection.table_names(cursor))
        for statement in _sqlite_statements(existing):
            cursor.execute(statement)


def guarded_tables(using="default"):
    """{table: set of trigger names} as the database reports them. Used by tests and health checks."""
    connection = connections[using]
    found = {}
    with connection.cursor() as cursor:
        if connection.vendor == "sqlite":
            cursor.execute("SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger'")
        else:
            cursor.execute("SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal")
        for table, trigger in cursor.fetchall():
            found.setdefault(table, set()).add(trigger)
    return found


def _after_migrate(sender, using, **kwargs):
    install_sqlite_guards(using)


def connect():
    post_migrate.connect(_after_migrate, dispatch_uid="records.install_sqlite_guards")
