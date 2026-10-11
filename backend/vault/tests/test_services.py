import io
import re
import uuid
from unittest import mock

from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent
from vault import crypto, services
from vault.models import ClinicKey, KeyGrant
from vault.session import COOKIE

PASSWORD = "synthetic-owner-password"
RECOVERY_PATTERN = r"(?:[0-9A-HJKMNP-TV-Z]{4}-){9}[0-9A-HJKMNP-TV-Z]{4}"


def make_member(clinic, username, role, password):
    user = User.objects.create_user(username=username, password=password)
    Membership.objects.create(clinic=clinic, user=user, role_id=role)
    return user


class KeyGrantTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.owner = make_member(self.clinic, "owner", "owner", PASSWORD)
        self.recovery = services.create_clinic_key(self.clinic, self.owner, PASSWORD)
        self.master = services.unlock(self.owner, PASSWORD)[self.clinic.pk]

    def test_owner_password_and_recovery_key_open_the_same_key(self):
        self.assertRegex(self.recovery, f"^{RECOVERY_PATTERN}$")
        self.assertEqual(set(self.master), {1})
        self.assertEqual(len(self.master[1]), 32)
        self.assertEqual(services.recover(self.clinic, self.recovery), self.master)
        # Typed sloppily: lower case, spaces, and letters people confuse with digits.
        typed = self.recovery.lower().replace("-", " ").replace("0", "o").replace("1", "l")
        self.assertEqual(services.recover(self.clinic, typed), self.master)

    def test_wrong_secrets_open_nothing(self):
        self.assertEqual(services.unlock(self.owner, "wrong-password"), {})
        for bad in ["", "not a key", services.new_recovery_key()]:
            with self.assertRaises(services.VaultError):
                services.recover(self.clinic, bad)

    def test_a_tampered_cost_setting_locks_instead_of_stalling(self):
        KeyGrant.objects.filter(user=self.owner).update(kdf={"alg": "argon2id", "time_cost": 3, "memory_cost": 2**40, "parallelism": 4})
        self.assertEqual(services.unlock(self.owner, PASSWORD), {})

    def test_a_clinic_gets_one_key_and_keys_differ_between_clinics(self):
        with self.assertRaises(services.VaultError):
            services.create_clinic_key(self.clinic, self.owner, PASSWORD)
        other = Clinic.objects.create(name="Other clinic")
        Membership.objects.create(clinic=other, user=self.owner, role_id="owner")
        services.create_clinic_key(other, self.owner, PASSWORD)
        unlocked = services.unlock(self.owner, PASSWORD)
        self.assertEqual(set(unlocked), {self.clinic.pk, other.pk})
        self.assertNotEqual(unlocked[self.clinic.pk][1], unlocked[other.pk][1])

    def test_the_database_never_holds_a_usable_key(self):
        stored = b"".join(bytes(grant.sealed_key) + bytes(grant.salt) for grant in KeyGrant.objects.all())
        self.assertNotIn(self.master[1], stored)
        self.assertNotIn(self.master[1][:8], stored)
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM vault_clinickey")
            self.assertNotIn(
                self.master[1], [bytes(value) for row in cursor.fetchall() for value in row if isinstance(value, bytes | memoryview)]
            )

    def test_a_grant_cannot_be_moved_to_another_person_or_clinic(self):
        doctor = make_member(self.clinic, "doctor", "clinician", "synthetic-doctor-password")
        services.grant_access(self.clinic, self.master, doctor, "synthetic-doctor-password")
        # An attacker with database write access copies the owner's sealed key onto their own grant row.
        owner_grant = KeyGrant.objects.get(user=self.owner)
        KeyGrant.objects.filter(user=doctor).update(sealed_key=owner_grant.sealed_key, salt=owner_grant.salt)
        self.assertEqual(services.unlock(doctor, PASSWORD), {})
        self.assertEqual(services.unlock(doctor, "synthetic-doctor-password"), {})

    def test_granting_needs_an_unlocked_key_and_an_active_member(self):
        doctor = make_member(self.clinic, "doctor", "clinician", "synthetic-doctor-password")
        with self.assertRaises(services.VaultError):
            services.grant_access(self.clinic, {}, doctor, "synthetic-doctor-password")
        outsider = User.objects.create_user(username="outsider", password="synthetic-outsider-password")
        with self.assertRaises(services.VaultError):
            services.grant_access(self.clinic, self.master, outsider, "synthetic-outsider-password")
        services.grant_access(self.clinic, self.master, doctor, "synthetic-doctor-password", granted_by=self.owner)
        self.assertEqual(services.unlock(doctor, "synthetic-doctor-password")[self.clinic.pk], self.master)
        self.assertEqual(KeyGrant.objects.get(user=doctor).created_by, self.owner)

    def test_removed_members_cannot_unlock_and_revoking_destroys_the_sealed_copy(self):
        doctor = make_member(self.clinic, "doctor", "clinician", "synthetic-doctor-password")
        services.grant_access(self.clinic, self.master, doctor, "synthetic-doctor-password")
        Membership.objects.filter(user=doctor).update(is_active=False)
        self.assertEqual(services.unlock(doctor, "synthetic-doctor-password"), {})
        Membership.objects.filter(user=doctor).update(is_active=True)
        self.assertEqual(services.revoke_access(self.clinic, doctor), 1)
        grant = KeyGrant.objects.get(user=doctor)
        self.assertEqual((bytes(grant.sealed_key), bytes(grant.salt)), (b"", b""))
        self.assertIsNotNone(grant.revoked_at)
        self.assertEqual(services.unlock(doctor, "synthetic-doctor-password"), {})
        self.assertEqual(services.unlock(self.owner, PASSWORD)[self.clinic.pk], self.master)

    def test_password_change_reseals_the_grant_and_touches_no_data(self):
        record = uuid.uuid4()
        blob = crypto.encrypt(self.master[1], 1, self.clinic.pk, record, "note.body", b"Synthetic note")
        before = KeyGrant.objects.get(user=self.owner)
        self.assertEqual(services.change_password(self.owner, PASSWORD, "synthetic-new-password"), 1)
        after = KeyGrant.objects.get(user=self.owner)
        self.assertNotEqual(bytes(before.sealed_key), bytes(after.sealed_key))
        self.assertEqual(services.unlock(self.owner, PASSWORD), {})
        reopened = services.unlock(self.owner, "synthetic-new-password")[self.clinic.pk]
        self.assertEqual(crypto.decrypt(reopened, self.clinic.pk, record, "note.body", blob), b"Synthetic note")
        self.assertEqual(services.recover(self.clinic, self.recovery), self.master)
        self.assertEqual(services.change_password(self.owner, "not-the-password", "anything-else-entirely"), 0)

    def test_replacing_the_recovery_key_kills_the_old_one(self):
        with self.assertRaises(services.VaultError):
            services.replace_recovery_key(self.clinic, {})
        new = services.replace_recovery_key(self.clinic, self.master, replaced_by=self.owner)
        self.assertNotEqual(new, self.recovery)
        with self.assertRaises(services.VaultError):
            services.recover(self.clinic, self.recovery)
        self.assertEqual(services.recover(self.clinic, new), self.master)
        self.assertEqual(KeyGrant.objects.filter(kind="recovery", revoked_at__isnull=True).count(), 1)


class SessionUnlockTests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.owner = make_member(self.clinic, "owner", "owner", PASSWORD)
        services.create_clinic_key(self.clinic, self.owner, PASSWORD)
        self.doctor = make_member(self.clinic, "doctor", "clinician", "synthetic-doctor-password")
        self.client = APIClient()

    def login(self, username="owner", password=PASSWORD):
        return self.client.post("/api/v1/auth/login/", {"username": username, "password": password}, format="json")

    def unlocked(self):
        return self.client.get("/api/v1/auth/me/").json()["memberships"][0]["records_unlocked"]

    def test_sign_in_unlocks_and_sets_a_separate_protected_cookie(self):
        response = self.login()
        self.assertTrue(response.json()["memberships"][0]["records_unlocked"])
        cookie = response.cookies[COOKIE]
        self.assertTrue(cookie["httponly"])
        self.assertEqual((cookie["samesite"], cookie["path"]), ("Strict", "/api/"))
        self.assertTrue(self.unlocked())
        # Neither half alone contains the clinic key.
        master = services.unlock(self.owner, PASSWORD)[self.clinic.pk][1]
        self.assertNotIn(master.hex(), str(dict(self.client.session)).encode().hex())
        self.assertNotEqual(cookie.value.encode(), master)

    def test_both_halves_are_needed(self):
        self.login()
        saved = self.client.cookies[COOKIE].value
        del self.client.cookies[COOKIE]
        self.assertFalse(self.unlocked())
        self.client.cookies[COOKIE] = "bm90LXRoZS1rZXk="
        self.assertFalse(self.unlocked())
        self.client.cookies[COOKIE] = saved
        self.assertTrue(self.unlocked())
        session = self.client.session
        del session["vault"]
        session.save()
        self.assertFalse(self.unlocked())

    def test_a_member_without_a_grant_signs_in_but_stays_locked(self):
        response = self.login("doctor", "synthetic-doctor-password")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["memberships"][0]["records_unlocked"])
        self.assertEqual(response.cookies[COOKIE].value, "")

    def test_sign_out_removes_both_halves(self):
        self.login()
        response = self.client.post("/api/v1/auth/logout/", {}, format="json")
        self.assertEqual(response.cookies[COOKIE].value, "")
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 401)

    def test_another_users_cookie_does_not_unlock(self):
        self.login()
        stolen = self.client.cookies[COOKIE].value
        other = APIClient()
        other.post("/api/v1/auth/login/", {"username": "doctor", "password": "synthetic-doctor-password"}, format="json")
        other.cookies[COOKIE] = stolen
        self.assertFalse(other.get("/api/v1/auth/me/").json()["memberships"][0]["records_unlocked"])

    def test_password_change_keeps_access_and_requires_the_current_password(self):
        self.login()
        url = "/api/v1/auth/password/"
        bad = self.client.post(url, {"current_password": "wrong", "new_password": "synthetic-brand-new-password"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertTrue(AuditEvent.objects.filter(action="auth.password_change_failed", outcome="failed").exists())
        weak = self.client.post(url, {"current_password": PASSWORD, "new_password": "short"}, format="json")
        self.assertEqual(weak.status_code, 400)
        self.assertIn("new_password", weak.json())
        good = self.client.post(url, {"current_password": PASSWORD, "new_password": "synthetic-brand-new-password"}, format="json")
        self.assertEqual(good.status_code, 200, good.content)
        self.assertTrue(self.unlocked())
        self.assertTrue(AuditEvent.objects.filter(action="auth.password_changed", actor=self.owner).exists())
        fresh = APIClient()
        self.assertEqual(fresh.post("/api/v1/auth/login/", {"username": "owner", "password": PASSWORD}, format="json").status_code, 401)
        again = fresh.post("/api/v1/auth/login/", {"username": "owner", "password": "synthetic-brand-new-password"}, format="json")
        self.assertTrue(again.json()["memberships"][0]["records_unlocked"])

    def test_password_change_needs_a_session(self):
        response = self.client.post("/api/v1/auth/password/", {"current_password": PASSWORD, "new_password": "x"}, format="json")
        self.assertEqual(response.status_code, 401)


class CommandTests(TestCase):
    def run_command(self, name, *args, **env):
        out = io.StringIO()
        with mock.patch.dict("os.environ", env):
            call_command(name, *args, stdout=out)
        return out.getvalue()

    def test_bootstrap_creates_the_key_and_shows_the_recovery_key_once(self):
        output = self.run_command("bootstrap_clinic", "--clinic", "Synthetic clinic", "--username", "owner", BOOTSTRAP_PASSWORD=PASSWORD)
        clinic = Clinic.objects.get()
        recovery = re.search(RECOVERY_PATTERN, output).group(0)
        self.assertEqual(ClinicKey.objects.filter(clinic=clinic).count(), 1)
        owner = User.objects.get(username="owner")
        self.assertEqual(services.recover(clinic, recovery), services.unlock(owner, PASSWORD)[clinic.pk])

    def test_adding_a_user_to_an_encrypted_clinic_needs_someone_who_holds_the_key(self):
        self.run_command("bootstrap_clinic", "--clinic", "Synthetic clinic", "--username", "owner", BOOTSTRAP_PASSWORD=PASSWORD)
        clinic = Clinic.objects.get()
        base = ["--clinic-id", str(clinic.pk), "--username", "reception", "--role", "reception"]
        with self.assertRaises(CommandError):
            self.run_command("add_clinic_user", *base, NEW_USER_PASSWORD="synthetic-reception-password")
        with self.assertRaises(CommandError):
            self.run_command(
                "add_clinic_user",
                *base,
                "--authorized-by",
                "owner",
                AUTHORIZER_PASSWORD="wrong",
                NEW_USER_PASSWORD="synthetic-reception-password",
            )
        self.assertFalse(User.objects.filter(username="reception").exists())
        self.run_command(
            "add_clinic_user",
            *base,
            "--authorized-by",
            "owner",
            AUTHORIZER_PASSWORD=PASSWORD,
            NEW_USER_PASSWORD="synthetic-reception-password",
        )
        reception = User.objects.get(username="reception")
        self.assertIn(clinic.pk, services.unlock(reception, "synthetic-reception-password"))

    def test_existing_clinic_gets_keys_and_members_get_access(self):
        clinic = Clinic.objects.create(name="Older clinic")
        owner = make_member(clinic, "owner", "owner", PASSWORD)
        doctor = make_member(clinic, "doctor", "clinician", "synthetic-doctor-password")
        with self.assertRaises(CommandError):
            self.run_command(
                "init_clinic_keys", "--clinic-id", str(clinic.pk), "--username", "doctor", OWNER_PASSWORD="synthetic-doctor-password"
            )
        with self.assertRaises(CommandError):
            self.run_command("init_clinic_keys", "--clinic-id", str(clinic.pk), "--username", "owner", OWNER_PASSWORD="wrong")
        output = self.run_command("init_clinic_keys", "--clinic-id", str(clinic.pk), "--username", "owner", OWNER_PASSWORD=PASSWORD)
        self.assertRegex(output, RECOVERY_PATTERN)
        with self.assertRaises(CommandError):
            self.run_command("init_clinic_keys", "--clinic-id", str(clinic.pk), "--username", "owner", OWNER_PASSWORD=PASSWORD)
        grant = ["grant_clinic_access", "--clinic-id", str(clinic.pk), "--username", "doctor", "--authorized-by", "owner"]
        with self.assertRaises(CommandError):
            self.run_command(*grant, AUTHORIZER_PASSWORD=PASSWORD, MEMBER_PASSWORD="wrong")
        self.run_command(*grant, AUTHORIZER_PASSWORD=PASSWORD, MEMBER_PASSWORD="synthetic-doctor-password")
        self.assertEqual(services.unlock(doctor, "synthetic-doctor-password"), services.unlock(owner, PASSWORD))

    def test_recovery_restores_the_owner_and_spends_the_key(self):
        output = self.run_command("bootstrap_clinic", "--clinic", "Synthetic clinic", "--username", "owner", BOOTSTRAP_PASSWORD=PASSWORD)
        clinic, owner = Clinic.objects.get(), User.objects.get(username="owner")
        recovery = re.search(RECOVERY_PATTERN, output).group(0)
        master = services.unlock(owner, PASSWORD)[clinic.pk]
        command = ["recover_clinic_access", "--clinic-id", str(clinic.pk), "--username", "owner"]
        with self.assertRaises(CommandError):
            self.run_command(*command, RECOVERY_KEY=services.new_recovery_key(), NEW_PASSWORD="synthetic-recovered-password")
        output = self.run_command(*command, RECOVERY_KEY=recovery, NEW_PASSWORD="synthetic-recovered-password")
        owner.refresh_from_db()
        self.assertTrue(owner.check_password("synthetic-recovered-password"))
        self.assertEqual(services.unlock(owner, "synthetic-recovered-password")[clinic.pk], master)
        self.assertEqual(services.unlock(owner, PASSWORD), {})
        with self.assertRaises(services.VaultError):
            services.recover(clinic, recovery)
        self.assertEqual(services.recover(clinic, re.search(RECOVERY_PATTERN, output).group(0)), master)
