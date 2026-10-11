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
from django.db.models.signals import post_migrate, pre_migrate

# Rows may be added but never changed or removed.
APPEND_ONLY_TABLES = [
    "records_patientnote",
    "records_encounter",
    "records_observation",
    "records_prescription",
    "records_prescriptionitem",
    "records_patientrevision",
    "records_encounterproduct",
    "records_encounteramendment",
    "audit_auditevent",
]
# What is measured at a visit and its unit; kept in step with records.models.OBSERVATION_UNITS by a test.
OBSERVATION_UNITS = {"height": "cm", "weight": "kg", "systolic": "mmHg", "diastolic": "mmHg", "pulse": "bpm"}
# Rows may change, but never their identity.
IDENTITY_TABLES = ["records_patient", "records_patientaddress", "records_patientphoto", "records_patientidentifier"]

# Other parts of the application (billing, appointments, messages, printing) add their own tables
# and their own SQLite triggers here from their AppConfig.ready(); their PostgreSQL triggers come
# from their own migrations.
EXTRA_APPEND_ONLY = []
EXTRA_SQLITE = []


def register(append_only=(), sqlite=None):
    for table in append_only:
        if table not in EXTRA_APPEND_ONLY:
            EXTRA_APPEND_ONLY.append(table)
    if sqlite and sqlite not in EXTRA_SQLITE:
        EXTRA_SQLITE.append(sqlite)


def all_append_only_tables():
    return APPEND_ONLY_TABLES + EXTRA_APPEND_ONLY


APPEND_ONLY_MESSAGE = "Clinical records and audit events are append-only"
IDENTITY_MESSAGE = "Record identity is immutable"
CLINIC_MESSAGE = "Patient clinic is immutable"
OBSERVATION_MESSAGE = "Observation must match its encounter and use the right unit"


def _sqlite_statements(existing):
    for extra in EXTRA_SQLITE:
        yield from extra(existing)
    for table in all_append_only_tables():
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
        pairs = [f"(NEW.kind = '{kind}' AND NEW.unit = '{unit}')" for kind, unit in OBSERVATION_UNITS.items()]
        yield (
            "CREATE TRIGGER IF NOT EXISTS guard_observation BEFORE INSERT ON records_observation "
            "WHEN NEW.patient_id IS NOT (SELECT patient_id FROM records_encounter WHERE id = NEW.encounter_id) "
            f"OR NOT ({' OR '.join(pairs)}) "
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


def remove_sqlite_guards(using="default"):
    """Take the SQLite guards off for the length of a migration.

    SQLite changes a table by building a new one and renaming it, and refuses the rename while any
    trigger mentions a table that is missing at that moment (the observation guard reads the visit
    table). The guards go back on as soon as the migration finishes; see install_sqlite_guards.
    """
    connection = connections[using]
    if connection.vendor != "sqlite":
        return
    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")
        for (name,) in cursor.fetchall():
            if not name.startswith("guard_"):
                continue
            cursor.execute(f'DROP TRIGGER IF EXISTS "{name}"')


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


def _before_migrate(sender, using, **kwargs):
    remove_sqlite_guards(using)


def _after_migrate(sender, using, **kwargs):
    install_sqlite_guards(using)


def connect():
    pre_migrate.connect(_before_migrate, dispatch_uid="records.remove_sqlite_guards")
    post_migrate.connect(_after_migrate, dispatch_uid="records.install_sqlite_guards")
