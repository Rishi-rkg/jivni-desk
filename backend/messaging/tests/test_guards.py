"""The database itself keeps sent messages as they were, on both engines, and backups carry them.

These tests go around the model code on purpose (plain querysets and raw SQL): the triggers are
there for the day application code is wrong.
"""

import datetime

from django.db import DatabaseError, connection, models, transaction
from django.test import TestCase
from django.utils import timezone

from accounts.models import Clinic, User
from messaging import guards
from messaging.models import Message, MessageRule, MessageTemplate, ensure_standard
from records import guards as record_guards
from records.models import Patient
from scheduling.models import Appointment, WorkDay
from vault import backup
from vault.tests.test_backup import PASSWORD, BackupTestCase, bootstrap


def plain(model):
    return models.QuerySet(model)


class MessageGuardTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Anita", gender="female", phone="9000000142")
        self.waiting = Message.objects.create(clinic=self.clinic, patient=self.patient, title="Message", body="Synthetic wording")
        self.sent = Message.objects.create(clinic=self.clinic, patient=self.patient, title="Message", body="Synthetic wording")
        plain(Message).filter(pk=self.sent.pk).update(status="sent", sent_at=timezone.now(), sent_by=self.user, to_number="9000000142")
        self.reply = Message.objects.create(
            clinic=self.clinic, patient=self.patient, title="Reply", body="Synthetic reply", source="reply", status="received"
        )

    def refused(self, action, message):
        with self.assertRaises(DatabaseError) as caught, transaction.atomic():
            action()
        self.assertIn(message, str(caught.exception))

    def test_a_sent_message_keeps_its_wording_number_and_patient(self):
        other = Patient.objects.create(clinic=self.clinic, first_name="Vikram", gender="male")
        for change in [
            {"body": "Changed"},
            {"to_number": "9000000199"},
            {"patient": other},
            {"title": "Changed"},
            {"sent_at": None},
            {"clinic": Clinic.objects.create(name="Other clinic")},
        ]:
            self.refused(lambda change=change: plain(Message).filter(pk=self.sent.pk).update(**change), guards.FROZEN_MESSAGE)
        self.refused(lambda: plain(Message).filter(pk=self.reply.pk).update(body="Changed"), guards.FROZEN_MESSAGE)
        # What happens to it afterwards can still be written down.
        plain(Message).filter(pk=self.sent.pk).update(status="failed", failed_reason="Number is not on WhatsApp")
        plain(Message).filter(pk=self.reply.pk).update(status="handled", closed_at=timezone.now())
        # A message that has not gone yet can still be reworded.
        plain(Message).filter(pk=self.waiting.pk).update(body="Reworded before sending")

    def test_no_message_is_ever_deleted(self):
        for message in (self.waiting, self.sent, self.reply):
            with self.assertRaises(DatabaseError) as caught, transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(
                    "DELETE FROM messaging_message WHERE id = %s", [message.pk.hex if connection.vendor == "sqlite" else message.pk]
                )
            self.assertIn(guards.KEPT_MESSAGE, str(caught.exception))
        self.assertEqual(Message.objects.count(), 3)

    def test_the_message_triggers_are_installed(self):
        installed = record_guards.guarded_tables().get("messaging_message", set())
        self.assertTrue(any("message_frozen" in name for name in installed), installed)
        if connection.vendor == "sqlite":
            self.assertTrue(any("message_kept" in name for name in installed), installed)


class MessagingBackupTests(BackupTestCase):
    def test_messages_and_the_diary_come_back_from_a_backup(self):
        savepoint = transaction.savepoint()
        clinic, owner, recovery = bootstrap()
        patient = Patient.objects.create(clinic=clinic, first_name="Zebedee", last_name="Synthetic", gender="other", phone="9000000142")
        ensure_standard(clinic)
        template = MessageTemplate.objects.get(clinic=clinic, key="check_in_30")
        day = datetime.date(2031, 10, 7)
        WorkDay.objects.create(clinic=clinic, day=day, sessions=[["09:30", "13:00"]])
        booked = Appointment.objects.create(clinic=clinic, patient=patient, day=day, time=datetime.time(10, 15), created_by=owner)
        message = Message.objects.create(
            clinic=clinic,
            patient=patient,
            title="30 day check-in",
            body="Hello Zebedee, a synthetic check-in.",
            template=template,
            template_name=template.name,
            template_version=1,
            appointment=booked,
            dedupe="synthetic:1",
        )
        plain(Message).filter(pk=message.pk).update(status="sent", sent_at=timezone.now(), sent_by=owner, to_number="9000000142")
        self.place(clinic)
        run = backup.run_backup(clinic, user=owner)
        self.assertTrue(run.ok, run.places)
        path = self.folder / run.file_name
        self.assertNotIn(b"Zebedee", path.read_bytes())
        transaction.savepoint_rollback(savepoint)
        self.assertFalse(Message.objects.exists())

        backup.restore_backup(path, password=PASSWORD)
        restored = Message.objects.get()
        self.assertEqual(
            (restored.status, restored.body, restored.to_number, restored.template.name, restored.dedupe),
            ("sent", "Hello Zebedee, a synthetic check-in.", "9000000142", "Follow-up 30 days", "synthetic:1"),
        )
        self.assertEqual((restored.appointment.day, restored.appointment.time), (day, datetime.time(10, 15)))
        self.assertEqual(WorkDay.objects.get().sessions, [["09:30", "13:00"]])
        self.assertEqual((MessageTemplate.objects.count(), MessageRule.objects.count()), (5, 4))
        # The restored message is still protected.
        with self.assertRaises(DatabaseError), transaction.atomic():
            plain(Message).filter(pk=restored.pk).update(body="Changed")
