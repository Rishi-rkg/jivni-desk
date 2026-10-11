"""The database itself refuses to rewrite history, on PostgreSQL and on SQLite alike.

These tests go around the model code on purpose (plain querysets and raw SQL), because the point of
the triggers is to hold when application code is wrong.
"""

import uuid

from django.apps import apps
from django.db import DatabaseError, connection, models, transaction
from django.test import TestCase

from accounts.models import Clinic, User
from audit.models import AuditEvent
from records import guards
from records.models import (
    AppendOnlyRecord,
    Encounter,
    Observation,
    Patient,
    PatientIdentifier,
    PatientNote,
    PatientRevision,
    Prescription,
    PrescriptionItem,
)


def plain(model):
    """A queryset without the model's own append-only protection."""
    return models.QuerySet(model)


class DatabaseGuardTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.encounter = Encounter.objects.create(patient=self.patient, clinician=self.user, chief_complaint="Synthetic")

    def refused(self, action, message):
        with self.assertRaises(DatabaseError) as caught, transaction.atomic():
            action()
        self.assertIn(message, str(caught.exception))

    def test_every_append_only_table_refuses_update_and_delete(self):
        prescription = Prescription.objects.create(encounter=self.encounter, prescriber=self.user)
        rows = [
            self.encounter,
            PatientNote.objects.create(patient=self.patient, author=self.user, body="Synthetic"),
            Observation.objects.create(patient=self.patient, encounter=self.encounter, kind="height", unit="cm", value=170),
            prescription,
            PrescriptionItem.objects.create(prescription=prescription, medicine_name_snapshot="Synthetic", dose="1", frequency="daily"),
            PatientRevision.objects.create(patient=self.patient, changed_by=self.user, changes={"phone": {"from": "", "to": "1"}}),
            AuditEvent.objects.create(clinic=self.clinic, actor=self.user, action="test"),
        ]
        self.assertEqual({row._meta.db_table for row in rows}, set(guards.APPEND_ONLY_TABLES))
        for row in rows:
            table = row._meta.db_table
            self.refused(
                lambda row=row: (
                    plain(type(row)).filter(pk=row.pk).update(created_at=None)
                    if hasattr(row, "created_at")
                    else plain(type(row)).filter(pk=row.pk).update(action="x")
                ),
                guards.APPEND_ONLY_MESSAGE,
            )
            with self.assertRaises(DatabaseError, msg=table) as caught, transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(f"DELETE FROM {table}")  # noqa: S608 - table names are constants from guards.py
            self.assertIn(guards.APPEND_ONLY_MESSAGE, str(caught.exception), table)
            self.assertTrue(plain(type(row)).filter(pk=row.pk).exists(), table)

    def test_identities_cannot_be_changed(self):
        identifier = PatientIdentifier.issue(self.patient)
        for row in [self.patient, identifier]:
            self.refused(lambda row=row: plain(type(row)).filter(pk=row.pk).update(id=uuid.uuid4()), guards.IDENTITY_MESSAGE)
        # Ordinary edits to these tables still work.
        plain(Patient).filter(pk=self.patient.pk).update(first_name="Renamed")
        self.assertEqual(Patient.objects.get().first_name, "Renamed")

    def test_a_patient_cannot_be_moved_to_another_clinic(self):
        other = Clinic.objects.create(name="Other clinic")
        self.refused(lambda: plain(Patient).filter(pk=self.patient.pk).update(clinic=other), "clinic is immutable")

    def test_an_observation_must_match_its_encounter_and_unit(self):
        other = Patient.objects.create(clinic=self.clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        base = {"encounter": self.encounter, "kind": "height", "unit": "cm", "value": 170}
        for wrong in [{"patient": other}, {"patient": self.patient, "unit": "kg"}]:
            with self.assertRaises(DatabaseError), transaction.atomic():
                plain(Observation).bulk_create([Observation(**{**base, **wrong})])
        plain(Observation).bulk_create([Observation(patient=self.patient, **base)])

    def test_no_guarded_table_is_missing_its_trigger(self):
        installed = guards.guarded_tables()
        for table in guards.APPEND_ONLY_TABLES:
            self.assertTrue(any("append_only" in name for name in installed.get(table, ())), table)
        for table in guards.IDENTITY_TABLES:
            self.assertTrue(any("identity" in name for name in installed.get(table, ())), table)

    def test_every_append_only_model_is_listed(self):
        declared = {model._meta.db_table for model in apps.get_models() if issubclass(model, AppendOnlyRecord)} | {"audit_auditevent"}
        self.assertEqual(declared, set(guards.APPEND_ONLY_TABLES))

    def test_sqlite_guards_survive_a_table_rebuild(self):
        if connection.vendor != "sqlite":
            self.skipTest("SQLite rebuilds tables on some schema changes; PostgreSQL does not.")
        with connection.cursor() as cursor:
            cursor.execute("DROP TRIGGER guard_append_only_delete_records_patientnote")
        self.assertNotIn("guard_append_only_delete_records_patientnote", guards.guarded_tables()["records_patientnote"])
        guards.install_sqlite_guards()  # what runs after every migrate
        # Before a migrate they all come off (SQLite cannot rebuild a table while a trigger mentions it) ...
        guards.remove_sqlite_guards()
        self.assertEqual(guards.guarded_tables(), {})
        # ... and afterwards every one is back.
        guards.install_sqlite_guards()
        for table in guards.APPEND_ONLY_TABLES + guards.IDENTITY_TABLES:
            self.assertTrue(guards.guarded_tables().get(table), table)
        self.assertIn("guard_append_only_delete_records_patientnote", guards.guarded_tables()["records_patientnote"])
