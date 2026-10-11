import datetime
import io
import re
import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import transaction
from django.test import SimpleTestCase, TestCase
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from records.models import Encounter, Patient, PatientIdentifier, PatientNote, PatientPhoto
from vault import backup, crypto, services
from vault.models import BackupKey, BackupPlace, BackupRun, ClinicKey, KeyGrant

PASSWORD = "synthetic-owner-password"
RECOVERY_PATTERN = r"(?:[0-9A-HJKMNP-TV-Z]{4}-){9}[0-9A-HJKMNP-TV-Z]{4}"
SECRET_TEXT = "Synthetic complaint that must never appear in a backup file"


def bootstrap():
    out = io.StringIO()
    with mock.patch.dict("os.environ", {"BOOTSTRAP_PASSWORD": PASSWORD}):
        call_command("bootstrap_clinic", "--clinic", "Synthetic clinic", "--username", "owner", stdout=out)
    return Clinic.objects.get(), User.objects.get(username="owner"), re.search(RECOVERY_PATTERN, out.getvalue()).group(0)


def synthetic_records(clinic, owner):
    patient = Patient.objects.create(clinic=clinic, first_name="Zebedee", last_name="Synthetic", date_of_birth="1990-01-01", gender="other")
    PatientIdentifier.issue(patient, owner)
    encounter = Encounter.objects.create(patient=patient, clinician=owner, chief_complaint=SECRET_TEXT)
    PatientNote.objects.create(patient=patient, author=owner, body="Synthetic note")
    key = default_storage.save(f"clinics/{clinic.pk}/photos/synthetic.jpg", ContentFile(b"\xff\xd8synthetic-photo-bytes" * 5000))
    PatientPhoto.objects.create(patient=patient, storage_key=key, mime_type="image/jpeg", byte_size=1, sha256="0" * 64, uploaded_by=owner)
    return patient, encounter, key


class BackupTestCase(TestCase):
    def setUp(self):
        cache.clear()
        self.folder = Path(tempfile.mkdtemp(prefix="dochp-backup-test-"))
        self.addCleanup(shutil.rmtree, self.folder, ignore_errors=True)

    def place(self, clinic, name="This computer", folder=None):
        return BackupPlace.objects.create(clinic=clinic, name=name, folder=str(folder or self.folder))


class BackupRoundTripTests(BackupTestCase):
    def test_backup_then_restore_into_an_empty_installation(self):
        # Everything is created inside a savepoint so it can be removed again: the clinical tables are
        # append-only, and a rollback is the only way to return to an empty installation inside a test.
        savepoint = transaction.savepoint()
        clinic, owner, recovery = bootstrap()
        patient, encounter, photo_key = synthetic_records(clinic, owner)
        self.place(clinic)
        run = backup.run_backup(clinic, user=owner)
        self.assertTrue(run.ok, run.places)
        path = self.folder / run.file_name
        expected = {
            "clinic": str(clinic.pk),
            "patient": str(patient.pk),
            "code": patient.identifiers.get().code,
            "encounter": str(encounter.pk),
            "audit": AuditEvent.objects.count(),
            "master": services.unlock(owner, PASSWORD)[clinic.pk],
            "photo": default_storage.open(photo_key).read(),
        }

        # The file gives nothing away: no names, no clinical text, no photo bytes, no key.
        content = path.read_bytes()
        for secret in [SECRET_TEXT.encode(), b"Zebedee", b"Synthetic clinic", b"synthetic-photo-bytes", expected["master"][1], b"owner"]:
            self.assertNotIn(secret, content)
        self.assertEqual(run.byte_size, len(content))

        transaction.savepoint_rollback(savepoint)
        default_storage.delete(photo_key)
        self.assertFalse(Clinic.objects.exists())

        for wrong in [{"password": "not-the-password"}, {"recovery_key": services.new_recovery_key()}]:
            with self.assertRaises(backup.BackupError):
                backup.restore_backup(path, **wrong)
        self.assertFalse(Clinic.objects.exists())

        manifest = backup.restore_backup(path, recovery_key=recovery)
        self.assertEqual(manifest["counts"]["patients"], 1)
        self.assertEqual(manifest["counts"]["files"], 1)
        restored = Patient.objects.get()
        self.assertEqual(
            (str(restored.pk), str(restored.clinic_id), restored.first_name), (expected["patient"], expected["clinic"], "Zebedee")
        )
        self.assertEqual(restored.identifiers.get().code, expected["code"])
        self.assertEqual(Encounter.objects.get().chief_complaint, SECRET_TEXT)
        self.assertEqual(str(Encounter.objects.get().pk), expected["encounter"])
        self.assertEqual(AuditEvent.objects.count(), expected["audit"])
        self.assertEqual(default_storage.open(photo_key).read(), expected["photo"])
        default_storage.delete(photo_key)
        # Staff sign in exactly as before, and the same clinic key comes back.
        owner = User.objects.get(username="owner")
        self.assertTrue(owner.check_password(PASSWORD))
        self.assertEqual(services.unlock(owner, PASSWORD)[restored.clinic_id], expected["master"])
        self.assertEqual(services.recover(restored.clinic, recovery), expected["master"])
        # New rows can still be added after a restore (database sequences were moved on).
        Membership.objects.create(clinic=restored.clinic, user=User.objects.create_user(username="new", password="x"), role_id="reception")
        # History of earlier backup runs is not part of a backup.
        self.assertFalse(BackupRun.objects.exists())

    def test_restore_refuses_when_data_exists(self):
        clinic, owner, _ = bootstrap()
        self.place(clinic)
        run = backup.run_backup(clinic)
        with self.assertRaises(backup.BackupError):
            backup.restore_backup(self.folder / run.file_name, password=PASSWORD)

    def test_a_staff_password_opens_the_backup_and_verify_reads_everything(self):
        clinic, owner, recovery = bootstrap()
        synthetic_records(clinic, owner)
        self.place(clinic)
        path = self.folder / backup.run_backup(clinic).file_name
        master = services.unlock(owner, PASSWORD)[clinic.pk]
        for opening in [{"password": PASSWORD}, {"recovery_key": recovery}, {"clinic_keys": master}]:
            manifest = backup.verify_backup(path, **opening)
            self.assertEqual((manifest["counts"]["patients"], manifest["counts"]["visits"], manifest["counts"]["files"]), (1, 1, 1))
        for wrong in [{"password": "nope"}, {"clinic_keys": {1: crypto.random_key()}}, {"clinic_keys": {}}]:
            with self.assertRaises(backup.BackupError):
                backup.verify_backup(path, **wrong)

    def test_damage_anywhere_is_detected(self):
        clinic, owner, _ = bootstrap()
        synthetic_records(clinic, owner)
        self.place(clinic)
        path = self.folder / backup.run_backup(clinic).file_name
        original = path.read_bytes()
        master = services.unlock(owner, PASSWORD)[clinic.pk]
        damaged = self.folder / "damaged.dhpb"
        for position in [3, 40, len(original) // 2, len(original) - 5]:
            changed = bytearray(original)
            changed[position] ^= 1
            damaged.write_bytes(bytes(changed))
            with self.assertRaises(backup.BackupError, msg=position):
                backup.verify_backup(damaged, clinic_keys=master)
        for cut in [10, len(original) // 2, len(original) - 1]:
            damaged.write_bytes(original[:cut])
            with self.assertRaises(backup.BackupError, msg=cut):
                backup.verify_backup(damaged, clinic_keys=master)
        damaged.write_bytes(original + b"extra")
        with self.assertRaises(backup.BackupError):
            backup.verify_backup(damaged, clinic_keys=master)

    def test_backups_need_no_one_signed_in_but_do_need_a_backup_key(self):
        clinic, owner, _ = bootstrap()
        self.place(clinic)
        self.assertTrue(backup.run_backup(clinic).ok)  # nobody unlocked anything
        BackupKey.objects.all().delete()
        with self.assertRaises(backup.BackupError):
            backup.run_backup(clinic)
        # Signing in creates the missing backup key for a clinic that was set up before backups existed.
        backup.ensure_backup_keys(services.unlock(owner, PASSWORD))
        self.assertTrue(backup.run_backup(clinic).ok)

    def test_an_installation_with_two_clinics_is_refused(self):
        clinic, _, _ = bootstrap()
        self.place(clinic)
        Clinic.objects.create(name="Second clinic")
        with self.assertRaises(backup.BackupError):
            backup.run_backup(clinic)

    def test_revoked_grants_are_not_carried_into_backups(self):
        clinic, owner, _ = bootstrap()
        doctor = User.objects.create_user(username="doctor", password="synthetic-doctor-password")
        Membership.objects.create(clinic=clinic, user=doctor, role_id="clinician")
        master = services.unlock(owner, PASSWORD)[clinic.pk]
        services.grant_access(clinic, master, doctor, "synthetic-doctor-password")
        services.revoke_access(clinic, doctor)
        self.place(clinic)
        path = self.folder / backup.run_backup(clinic).file_name
        with self.assertRaises(backup.BackupError):
            backup.verify_backup(path, password="synthetic-doctor-password")
        self.assertEqual(KeyGrant.objects.filter(clinic_key=ClinicKey.objects.get(), revoked_at__isnull=True).count(), 2)


class PlacesAndScheduleTests(BackupTestCase):
    def test_a_backup_is_copied_to_every_place_and_failures_are_reported_per_place(self):
        clinic, _, _ = bootstrap()
        second = Path(tempfile.mkdtemp(prefix="dochp-backup-test-"))
        self.addCleanup(shutil.rmtree, second, ignore_errors=True)
        self.place(clinic)
        nas = self.place(clinic, "Clinic NAS", second)
        gone = self.place(clinic, "Cloud drive", self.folder / "not-mounted")
        run = backup.run_backup(clinic)
        self.assertTrue(run.ok)
        # Places made in the same instant have no fixed order, so compare by name.
        self.assertEqual(
            {place["name"]: place["ok"] for place in run.places}, {"This computer": True, "Clinic NAS": True, "Cloud drive": False}
        )
        self.assertEqual((self.folder / run.file_name).read_bytes(), (second / run.file_name).read_bytes())
        self.assertFalse(list(self.folder.glob("*.partial")) + list(second.glob("*.partial")))
        nas.refresh_from_db()
        gone.refresh_from_db()
        self.assertIsNotNone(nas.last_ok_at)
        self.assertTrue(gone.last_error)
        self.assertNotIn(str(self.folder), gone.last_error)

    def test_no_place_reachable_is_a_failed_run(self):
        clinic, _, _ = bootstrap()
        self.place(clinic, folder=self.folder / "missing")
        run = backup.run_backup(clinic)
        self.assertFalse(run.ok)
        self.assertEqual(run.file_name, "")
        self.assertTrue(backup.is_overdue(clinic))

    def test_folder_check(self):
        self.assertGreater(backup.check_folder(self.folder), 0)
        for bad in ["relative/folder", str(self.folder / "missing")]:
            with self.assertRaises(backup.BackupError):
                backup.check_folder(bad)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_schedule(self):
        clinic, _, _ = bootstrap()
        clinic.time_zone = "Asia/Kolkata"
        clinic.save()
        self.assertFalse(backup.is_due(clinic))  # no place yet
        self.place(clinic)
        self.assertTrue(backup.is_due(clinic))  # never backed up
        tz = clinic.tzinfo

        def at(day, hour):
            return datetime.datetime(2026, 10, day, hour, 0, tzinfo=tz)

        run = BackupRun.objects.create(clinic=clinic, kind="automatic", ok=True, finished_at=at(10, 2))
        self.assertFalse(backup.is_due(clinic, at(10, 23)))
        self.assertFalse(backup.is_due(clinic, at(11, 1)))
        self.assertTrue(backup.is_due(clinic, at(11, 2)))
        policy = backup.policy_for(clinic)
        policy.frequency = "twice_daily"
        policy.save()
        self.assertFalse(backup.is_due(clinic, at(10, 13)))
        self.assertTrue(backup.is_due(clinic, at(10, 14)))
        policy.frequency = "weekly"
        policy.save()
        self.assertFalse(backup.is_due(clinic, at(16, 23)))
        self.assertTrue(backup.is_due(clinic, at(17, 2)))
        policy.automatic = False
        policy.save()
        self.assertFalse(backup.is_due(clinic, at(30, 2)))
        self.assertFalse(backup.is_overdue(clinic, at(12, 1)))
        self.assertTrue(backup.is_overdue(clinic, at(12, 3)))
        run.delete()

    def test_old_backups_are_pruned_but_monthly_and_newest_are_kept(self):
        clinic, _, _ = bootstrap()
        policy = backup.policy_for(clinic)
        policy.keep_daily_days, policy.keep_monthly_months = 14, 12
        now = datetime.datetime(2026, 10, 11, 3, 0, tzinfo=datetime.UTC)
        names = {}
        for label, when in {
            "today": now,
            "last_week": now - datetime.timedelta(days=7),
            "sep_first": datetime.datetime(2026, 9, 1, 2, 0, tzinfo=datetime.UTC),
            "sep_later": datetime.datetime(2026, 9, 20, 2, 0, tzinfo=datetime.UTC),
            "two_years": datetime.datetime(2024, 9, 1, 2, 0, tzinfo=datetime.UTC),
        }.items():
            names[label] = f"{backup.PREFIX}{when.strftime(backup.STAMP)}{backup.EXTENSION}"
            (self.folder / names[label]).write_bytes(b"x")
        (self.folder / "holiday-photos.dhpb").write_bytes(b"not ours")
        (self.folder / "dochp-backup-notes.txt").write_bytes(b"not ours")
        removed = backup.prune(self.folder, policy, now)
        self.assertEqual(sorted(removed), sorted([names["sep_later"], names["two_years"]]))
        remaining = {path.name for path in self.folder.iterdir()}
        self.assertEqual(
            remaining, {names["today"], names["last_week"], names["sep_first"], "holiday-photos.dhpb", "dochp-backup-notes.txt"}
        )
        policy.keep_daily_days = 1
        (self.folder / names["sep_first"]).unlink()
        (self.folder / names["last_week"]).unlink()
        self.assertEqual(backup.prune(self.folder, policy, now + datetime.timedelta(days=400)), [])  # the newest is never removed


class BackupAPITests(BackupTestCase):
    def setUp(self):
        super().setUp()
        self.clinic, self.owner, self.recovery = bootstrap()
        self.client = APIClient()
        self.client.post("/api/v1/auth/login/", {"username": "owner", "password": PASSWORD}, format="json")

    def add_place(self, **changes):
        return self.client.post(
            "/api/v1/backups/places/", {"name": "This computer", "kind": "local", "folder": str(self.folder), **changes}, format="json"
        )

    def test_owner_sets_up_runs_and_checks_a_backup(self):
        overview = self.client.get("/api/v1/backups/").data
        self.assertEqual((overview["places"], overview["runs"]), ([], []))
        self.assertEqual((overview["status"]["overdue"], overview["status"]["problem"]), (True, ""))
        self.assertEqual(self.client.post("/api/v1/backups/run/").status_code, 400)  # no place yet
        self.assertEqual(self.add_place(folder="relative").status_code, 400)
        self.assertEqual(self.add_place(folder=str(self.folder / "missing")).status_code, 400)
        created = self.add_place()
        self.assertEqual(created.status_code, 201, created.data)
        self.assertTrue(created.data["reachable"])
        self.assertEqual(self.add_place().status_code, 400)  # same folder twice
        synthetic_records(self.clinic, self.owner)
        run = self.client.post("/api/v1/backups/run/")
        self.assertEqual(run.status_code, 201, run.data)
        self.assertTrue((self.folder / run.data["file_name"]).is_file())
        check = self.client.post(f"/api/v1/backups/runs/{run.data['id']}/verify/")
        self.assertEqual(check.status_code, 200, check.data)
        self.assertTrue(check.data["run"]["verified_ok"])
        self.assertEqual(check.data["counts"]["patients"], 1)
        overview = self.client.get("/api/v1/backups/").data
        self.assertFalse(overview["status"]["overdue"])
        self.assertEqual(len(overview["runs"]), 1)
        for action in ["backup.place_added", "backup.run", "backup.verify"]:
            self.assertTrue(AuditEvent.objects.filter(action=action, clinic=self.clinic, outcome="success").exists(), action)

    def test_a_damaged_backup_fails_its_check(self):
        self.add_place()
        run = self.client.post("/api/v1/backups/run/").data
        path = self.folder / run["file_name"]
        content = bytearray(path.read_bytes())
        content[-3] ^= 1
        path.write_bytes(bytes(content))
        check = self.client.post(f"/api/v1/backups/runs/{run['id']}/verify/")
        self.assertFalse(check.data["run"]["verified_ok"])
        path.unlink()
        self.assertEqual(self.client.post(f"/api/v1/backups/runs/{run['id']}/verify/").status_code, 400)

    def test_policy_changes_are_validated(self):
        response = self.client.patch(
            "/api/v1/backups/policy/", {"frequency": "weekly", "at": "22:30", "keep_daily_days": 90}, format="json"
        )
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["frequency"], response.data["at"], response.data["keep_daily_days"]), ("weekly", "22:30:00", 90))
        for bad in [{"frequency": "hourly"}, {"keep_daily_days": 0}, {"warn_after_days": 0}, {"at": "25:00"}]:
            self.assertEqual(self.client.patch("/api/v1/backups/policy/", bad, format="json").status_code, 400, bad)

    def test_removing_a_place_keeps_its_files(self):
        place_id = self.add_place().data["id"]
        run = self.client.post("/api/v1/backups/run/").data
        self.assertEqual(self.client.delete(f"/api/v1/backups/places/{place_id}/").status_code, 204)
        self.assertTrue((self.folder / run["file_name"]).is_file())
        self.assertFalse(BackupPlace.objects.exists())

    def test_only_the_owner_may_touch_backups(self):
        place_id = self.add_place().data["id"]
        for role in ["admin", "clinician", "assistant", "reception", "billing"]:
            Membership.objects.filter(user=self.owner).update(role_id=role)
            self.assertEqual(self.client.get("/api/v1/backups/").status_code, 403, role)
            self.assertEqual(self.client.post("/api/v1/backups/run/").status_code, 403, role)
            self.assertEqual(self.client.patch("/api/v1/backups/policy/", {"automatic": False}, format="json").status_code, 403, role)
            self.assertEqual(self.client.delete(f"/api/v1/backups/places/{place_id}/").status_code, 403, role)
        self.assertTrue(AuditEvent.objects.filter(action="access.denied", resource_type="backup").exists())
        self.client.post("/api/v1/auth/logout/", {}, format="json")
        self.assertEqual(self.client.get("/api/v1/backups/").status_code, 401)

    def test_verify_needs_the_records_unlocked(self):
        self.add_place()
        run = self.client.post("/api/v1/backups/run/").data
        del self.client.cookies["clinic_unlock"]
        response = self.client.post(f"/api/v1/backups/runs/{run['id']}/verify/")
        self.assertEqual(response.status_code, 400)
        self.assertIn("unlock", str(response.data))


class BackupCommandTests(BackupTestCase):
    def test_commands_back_up_check_and_respect_the_schedule(self):
        out = io.StringIO()
        with self.assertRaises(CommandError):
            call_command("backup_now", stdout=out)  # no clinic
        clinic, owner, recovery = bootstrap()
        with self.assertRaises(CommandError):
            call_command("backup_now", stdout=out)  # no place
        self.place(clinic)
        call_command("backup_now", "--if-due", stdout=out)
        self.assertEqual(BackupRun.objects.get().kind, "automatic")
        call_command("backup_now", "--if-due", stdout=out)
        self.assertEqual(BackupRun.objects.count(), 1)
        self.assertIn("No backup is due.", out.getvalue())
        path = str(self.folder / BackupRun.objects.get().file_name)
        with mock.patch.dict("os.environ", {"BACKUP_PASSWORD": PASSWORD}):
            call_command("restore_backup", path, "--check", stdout=out)
        with mock.patch.dict("os.environ", {"RECOVERY_KEY": recovery}):
            call_command("restore_backup", path, "--check", "--recovery-key", stdout=out)
        self.assertEqual(out.getvalue().count("reads back in full"), 2)
        with mock.patch.dict("os.environ", {"BACKUP_PASSWORD": "wrong"}), self.assertRaises(CommandError):
            call_command("restore_backup", path, "--check", stdout=out)
        with mock.patch.dict("os.environ", {"BACKUP_PASSWORD": PASSWORD}), self.assertRaises(CommandError):
            call_command("restore_backup", path, stdout=out)  # this installation is not empty
        with mock.patch.dict("os.environ", {"BACKUP_PASSWORD": PASSWORD}), self.assertRaises(CommandError):
            call_command("restore_backup", str(self.folder / "missing.dhpb"), "--check", stdout=out)


class StreamTests(SimpleTestCase):
    def setUp(self):
        self.key, self.prefix = crypto.random_key(), b"1234567"

    def test_chunks_cannot_be_reordered_dropped_or_cut(self):
        sealer = crypto.StreamSealer(self.key, self.prefix, b"aad")
        first, second, last = sealer.seal(b"one"), sealer.seal(b"two"), sealer.seal(b"three", final=True)
        with self.assertRaises(ValueError):
            sealer.seal(b"after the end")
        opener = crypto.StreamOpener(self.key, self.prefix, b"aad")
        self.assertEqual([opener.open(first), opener.open(second), opener.open(last, final=True)], [b"one", b"two", b"three"])
        for sequence in [[(second, False)], [(first, True)], [(first, False), (last, True)], [(first, False), (second, True)]]:
            opener = crypto.StreamOpener(self.key, self.prefix, b"aad")
            with self.assertRaises(crypto.DecryptionError):
                for chunk, final in sequence:
                    opener.open(chunk, final=final)
        with self.assertRaises(crypto.DecryptionError):
            crypto.StreamOpener(self.key, self.prefix, b"other").open(first)

    def test_sealing_to_a_public_key(self):
        private, public = crypto.new_keypair()
        sealed = crypto.seal_to_public(public, b"file key", b"aad")
        self.assertEqual(crypto.open_with_private(private, sealed, b"aad"), b"file key")
        self.assertNotEqual(sealed, crypto.seal_to_public(public, b"file key", b"aad"))
        other_private, _ = crypto.new_keypair()
        for attempt in [
            (other_private, sealed, b"aad"),
            (private, sealed, b"other"),
            (private, sealed[:-1], b"aad"),
            (private, b"short", b"aad"),
        ]:
            with self.assertRaises(crypto.DecryptionError):
                crypto.open_with_private(*attempt)

    def test_a_backup_time_is_part_of_its_name(self):
        name = f"{backup.PREFIX}{timezone.now().strftime(backup.STAMP)}{backup.EXTENSION}"
        self.assertRegex(name, r"^dochp-backup-\d{8}-\d{6}\.dhpb$")
