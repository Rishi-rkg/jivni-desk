"""Users and roles, one-time passwords, two-step sign-in, the recovery key and signing people out."""

import time
from unittest import mock

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts import totp, two_step
from accounts.models import Clinic, Membership, TwoStep, User
from audit.models import AuditEvent
from vault import services
from vault.models import KeyGrant

PASSWORD = "synthetic-owner-password"
NEW_PASSWORD = "synthetic-chosen-password"
ONE_TIME = r"^(?:[2-9A-HJKMNP-TV-Z]{4}-){3}[2-9A-HJKMNP-TV-Z]{4}$"


class TeamTestCase(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        body = {"clinic_name": "Synthetic Clinic", "username": "owner", "full_name": "Dr Synthetic", "password": PASSWORD}
        made = self.client.post("/api/v1/auth/setup/", body, format="json")
        self.assertEqual(made.status_code, 201, made.content)
        self.recovery = made.json()["recovery_key"]
        self.clinic, self.owner = Clinic.objects.get(), User.objects.get()

    def sign_in(self, username, password, client=None, **more):
        client = client or APIClient()
        return client, client.post("/api/v1/auth/login/", {"username": username, "password": password, **more}, format="json")

    def invite(self, username="priya", name="Priya Desk", role="reception"):
        return self.client.post("/api/v1/clinic/users/", {"username": username, "name": name, "role": role}, format="json")

    def join(self, username="priya", name="Priya Desk", role="reception"):
        """Invite someone and have them choose their own password. Returns their signed-in client."""
        made = self.invite(username, name, role).json()
        client, _ = self.sign_in(username, made["one_time_password"])
        changed = client.post(
            "/api/v1/auth/password/", {"current_password": made["one_time_password"], "new_password": NEW_PASSWORD}, format="json"
        )
        self.assertEqual(changed.status_code, 200, changed.content)
        return client, made["id"]

    def code(self, secret, later=0):
        return totp.code_at(secret, totp.step_at(time.time()) + later)

    def turn_on(self, client, password):
        secret = client.post("/api/v1/auth/two-step/start/", {"password": password}, format="json").json()["secret"]
        done = client.post("/api/v1/auth/two-step/confirm/", {"password": password, "code": self.code(secret)}, format="json")
        self.assertEqual(done.status_code, 200, done.content)
        return secret


class CodeTests(TestCase):
    # The published examples of RFC 6238 for SHA-1, cut to six digits.
    SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    def test_codes_match_the_published_examples(self):
        for moment, code in [(59, "287082"), (1111111109, "081804"), (1234567890, "005924"), (2000000000, "279037")]:
            self.assertEqual(totp.code_at(self.SECRET, totp.step_at(moment)), code)

    def test_a_code_is_good_for_its_own_half_minute_and_one_either_side_and_only_once(self):
        now = 1111111109
        step = totp.step_at(now)
        self.assertEqual(totp.verify(self.SECRET, "081804", now), step)
        self.assertEqual(totp.verify(self.SECRET, "081 804", now + 30), step)
        self.assertEqual(totp.verify(self.SECRET, "081804", now - 30), step)
        self.assertIsNone(totp.verify(self.SECRET, "081804", now + 90))
        self.assertIsNone(totp.verify(self.SECRET, "081804", now, last_step=step))
        self.assertIsNone(totp.verify(self.SECRET, "81804", now))
        self.assertIsNone(totp.verify(self.SECRET, "abcdef", now))
        secret = totp.new_secret()
        self.assertEqual(len(secret), 32)
        self.assertEqual(totp.uri(secret, "dr owner"), f"otpauth://totp/Jivni%3Adr%20owner?secret={secret}&issuer=Jivni&digits=6&period=30")


class InvitationTests(TeamTestCase):
    def test_an_invited_person_gets_a_one_time_password_and_must_choose_their_own(self):
        made = self.invite()
        self.assertEqual(made.status_code, 201, made.content)
        row = made.json()
        self.assertRegex(row["one_time_password"], ONE_TIME)
        self.assertEqual(
            (row["username"], row["name"], row["role"], row["must_change_password"]), ("priya", "Priya Desk", "reception", True)
        )
        self.assertTrue(row["can_open_records"])
        priya = User.objects.get(username="priya")
        self.assertTrue(KeyGrant.objects.filter(user=priya, kind="user", revoked_at__isnull=True).exists())
        # The password is not kept anywhere it could be read back.
        self.assertNotIn("one_time_password", self.client.get("/api/v1/clinic/users/").json()["results"][1])
        self.assertFalse(any(row["one_time_password"] in str(vars(event)) for event in AuditEvent.objects.all()))

        client, signed = self.sign_in("priya", row["one_time_password"])
        self.assertEqual((signed.status_code, signed.json()["pending"]), (200, ["password"]))
        # Nothing else answers until they have chosen their own.
        refused = client.get("/api/v1/patients/")
        self.assertEqual((refused.status_code, refused.json()["pending"]), (403, ["password"]))
        self.assertEqual(client.get("/api/v1/auth/me/").json()["pending"], ["password"])
        changed = client.post(
            "/api/v1/auth/password/", {"current_password": row["one_time_password"], "new_password": NEW_PASSWORD}, format="json"
        )
        self.assertEqual((changed.status_code, changed.json()["pending"]), (200, []))
        self.assertEqual(client.get("/api/v1/patients/").status_code, 200)
        priya.refresh_from_db()
        self.assertFalse(priya.must_change_password)
        # The clinic key was sealed again for the password they chose.
        self.assertEqual(services.unlock(priya, NEW_PASSWORD), services.unlock(self.owner, PASSWORD))
        self.assertEqual(self.sign_in("priya", row["one_time_password"])[1].status_code, 401)
        self.assertTrue(AuditEvent.objects.filter(action="team.invite", resource_id=priya.pk).exists())

    def test_invitations_are_checked_and_are_the_owners_alone(self):
        self.assertEqual(self.invite(username="owner").json(), {"username": ["That username is taken."]})
        self.assertEqual(self.invite(username="two words").status_code, 400)
        self.assertEqual(self.invite(name=" ").status_code, 400)
        self.assertEqual(self.invite(role="janitor").status_code, 400)
        self.assertEqual(User.objects.count(), 1)
        for role in ["admin", "clinician", "reception"]:
            client, _ = self.join(role, f"Synthetic {role}", role)
            self.assertEqual(client.get("/api/v1/clinic/users/").status_code, 403, role)
            self.assertEqual(
                client.post("/api/v1/clinic/users/", {"username": "x", "name": "X", "role": "owner"}, format="json").status_code, 403
            )
            self.assertEqual(client.get("/api/v1/clinic/security/").status_code, 403, role)
            self.assertEqual(client.post("/api/v1/clinic/sessions/end/").status_code, 403, role)
        listed = self.client.get("/api/v1/clinic/users/").json()
        self.assertEqual([row["username"] for row in listed["results"]], ["owner", "admin", "clinician", "reception"])
        self.assertEqual((listed["results"][0]["you"], listed["results"][0]["signed_in"]), (True, 1))
        self.assertIn({"code": "reception", "label": "Reception"}, listed["roles"])


class MemberTests(TeamTestCase):
    def test_roles_change_but_a_clinic_keeps_an_owner(self):
        _, priya = self.join()
        changed = self.client.patch(f"/api/v1/clinic/users/{priya}/", {"role": "billing", "name": "Priya Billing"}, format="json")
        self.assertEqual((changed.status_code, changed.json()["role"], changed.json()["name"]), (200, "billing", "Priya Billing"))
        own = self.client.patch(f"/api/v1/clinic/users/{self.owner.pk}/", {"role": "admin"}, format="json")
        self.assertEqual(own.status_code, 400)
        self.assertEqual(self.client.patch(f"/api/v1/clinic/users/{self.owner.pk}/", {"is_active": False}, format="json").status_code, 400)
        # A second owner can step the first one down, but the last owner stays.
        second, second_id = self.join("second", "Dr Second", "owner")
        self.assertEqual(second.patch(f"/api/v1/clinic/users/{self.owner.pk}/", {"role": "clinician"}, format="json").status_code, 200)
        self.assertEqual(second.patch(f"/api/v1/clinic/users/{second_id}/", {"role": "clinician"}, format="json").status_code, 400)
        self.assertEqual(self.client.get("/api/v1/clinic/users/").status_code, 403)
        other = Clinic.objects.create(name="Other clinic")
        stranger = User.objects.create_user(username="stranger", password=NEW_PASSWORD)
        Membership.objects.create(clinic=other, user=stranger, role_id="reception")
        self.assertEqual(second.patch(f"/api/v1/clinic/users/{stranger.pk}/", {"role": "owner"}, format="json").status_code, 400)
        self.assertTrue(AuditEvent.objects.filter(action="team.role").exists())

    def test_switching_someone_off_ends_their_access_at_once_and_back_on_starts_afresh(self):
        client, priya = self.join()
        user = User.objects.get(pk=priya)
        off = self.client.patch(f"/api/v1/clinic/users/{priya}/", {"is_active": False}, format="json")
        self.assertEqual((off.status_code, off.json()["is_active"], off.json()["can_open_records"]), (200, False, False))
        self.assertEqual(client.get("/api/v1/auth/me/").status_code, 401)
        self.assertEqual(self.sign_in("priya", NEW_PASSWORD)[1].status_code, 403)
        self.assertEqual(services.unlock(user, NEW_PASSWORD), {})
        self.assertEqual(self.client.post(f"/api/v1/clinic/users/{priya}/reset-password/").status_code, 400)
        on = self.client.patch(f"/api/v1/clinic/users/{priya}/", {"is_active": True}, format="json").json()
        self.assertRegex(on["one_time_password"], ONE_TIME)
        self.assertEqual((on["is_active"], on["must_change_password"], on["can_open_records"]), (True, True, True))
        self.assertEqual(self.sign_in("priya", NEW_PASSWORD)[1].status_code, 401)
        back, signed = self.sign_in("priya", on["one_time_password"])
        self.assertEqual(signed.json()["pending"], ["password"])
        self.assertTrue(signed.json()["memberships"][0]["records_unlocked"])

    def test_a_reset_gives_a_new_one_time_password_and_signs_the_person_out(self):
        client, priya = self.join()
        self.turn_on(client, NEW_PASSWORD)
        reset = self.client.post(f"/api/v1/clinic/users/{priya}/reset-password/")
        self.assertEqual(reset.status_code, 200, reset.content)
        self.assertRegex(reset.json()["one_time_password"], ONE_TIME)
        self.assertEqual((reset.json()["two_step"], reset.json()["must_change_password"]), (False, True))
        self.assertEqual(client.get("/api/v1/auth/me/").status_code, 401)
        self.assertEqual(self.sign_in("priya", NEW_PASSWORD)[1].status_code, 401)
        self.assertEqual(self.sign_in("priya", reset.json()["one_time_password"])[1].json()["pending"], ["password"])
        self.assertEqual(self.client.post(f"/api/v1/clinic/users/{self.owner.pk}/reset-password/").status_code, 400)
        self.assertEqual(self.client.post(f"/api/v1/clinic/users/{priya}/promote/").status_code, 400)

    def test_signing_out_everywhere(self):
        first, priya = self.join()
        second, _ = self.sign_in("priya", NEW_PASSWORD)
        self.assertEqual(self.client.get("/api/v1/clinic/security/").json()["sessions"], 3)
        ended = self.client.post(f"/api/v1/clinic/users/{priya}/sign-out/").json()
        self.assertEqual((ended["ended"], ended["signed_in"]), (2, 0))
        self.assertEqual((first.get("/api/v1/auth/me/").status_code, second.get("/api/v1/auth/me/").status_code), (401, 401))
        # "Sign out all" spares only the screen it was pressed on.
        self.sign_in("priya", NEW_PASSWORD)
        elsewhere, _ = self.sign_in("owner", PASSWORD)
        self.assertEqual(self.client.post("/api/v1/clinic/sessions/end/").json(), {"ended": 2})
        self.assertEqual(elsewhere.get("/api/v1/auth/me/").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 200)
        self.assertTrue(AuditEvent.objects.filter(action="clinic.sessions_ended").exists())


class TwoStepTests(TeamTestCase):
    def test_setting_it_up_needs_the_password_and_a_code_typed_back(self):
        self.assertEqual(self.client.post("/api/v1/auth/two-step/start/", {"password": "wrong"}, format="json").status_code, 400)
        started = self.client.post("/api/v1/auth/two-step/start/", {"password": PASSWORD}, format="json").json()
        self.assertEqual(started["uri"], totp.uri(started["secret"], "owner"))
        # Until a code is typed back it does nothing: sign-in still works without one.
        self.assertFalse(self.client.get("/api/v1/auth/me/").json()["user"]["two_step"])
        self.assertEqual(self.sign_in("owner", PASSWORD)[1].status_code, 200)
        wrong = self.client.post("/api/v1/auth/two-step/confirm/", {"password": PASSWORD, "code": "000000"}, format="json")
        self.assertEqual(wrong.status_code, 400)
        done = self.client.post(
            "/api/v1/auth/two-step/confirm/", {"password": PASSWORD, "code": self.code(started["secret"])}, format="json"
        )
        self.assertEqual((done.status_code, done.json()["user"]["two_step"]), (200, True))
        self.assertEqual(self.client.post("/api/v1/auth/two-step/start/", {"password": PASSWORD}, format="json").status_code, 400)
        # The secret is not readable from the database.
        row = TwoStep.objects.get()
        self.assertNotIn(started["secret"].encode(), bytes(row.sealed_secret))
        self.assertTrue(AuditEvent.objects.filter(action="auth.two_step_on").exists())

    def test_sign_in_then_asks_for_a_code_that_works_once(self):
        secret = self.turn_on(self.client, PASSWORD)
        _, asked = self.sign_in("owner", PASSWORD)
        self.assertEqual((asked.status_code, asked.json()["two_step"]), (401, True))
        self.assertEqual(self.sign_in("owner", PASSWORD, code="000000")[1].status_code, 401)
        # The code used to set it up has been used.
        self.assertEqual(self.sign_in("owner", PASSWORD, code=self.code(secret))[1].status_code, 401)
        with mock.patch("accounts.two_step.time.time", return_value=time.time() + 60):
            fresh, signed = self.sign_in("owner", PASSWORD, code=self.code(secret))
            self.assertEqual(signed.status_code, 200, signed.content)
            self.assertTrue(signed.json()["memberships"][0]["records_unlocked"])
            self.assertEqual(self.sign_in("owner", PASSWORD, code=self.code(secret))[1].status_code, 401)
        # Unlocking the screen of a session that is still signed in does not ask again.
        self.assertEqual(self.sign_in("owner", PASSWORD, client=fresh)[1].status_code, 200)
        self.assertEqual(self.sign_in("owner", "wrong-password", client=fresh)[1].status_code, 401)
        self.assertTrue(AuditEvent.objects.filter(action="auth.two_step_failed", outcome="failed").exists())

    def test_it_survives_a_change_of_password_and_can_be_turned_off(self):
        secret = self.turn_on(self.client, PASSWORD)
        changed = self.client.post("/api/v1/auth/password/", {"current_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json")
        self.assertEqual(changed.status_code, 200)
        with mock.patch("accounts.two_step.time.time", return_value=time.time() + 60):
            self.assertEqual(self.sign_in("owner", NEW_PASSWORD, code=self.code(secret))[1].status_code, 200)
        self.assertEqual(self.client.post("/api/v1/auth/two-step/off/", {"password": "wrong"}, format="json").status_code, 400)
        off = self.client.post("/api/v1/auth/two-step/off/", {"password": NEW_PASSWORD}, format="json")
        self.assertEqual((off.status_code, off.json()["user"]["two_step"]), (200, False))
        self.assertEqual(self.sign_in("owner", NEW_PASSWORD)[1].status_code, 200)

    def test_the_clinic_can_ask_it_of_owners_and_doctors(self):
        doctor, doctor_id = self.join("doctor", "Dr Second", "clinician")
        desk, _ = self.join()
        self.assertEqual(self.client.patch("/api/v1/clinic/", {"features": {"two_step": True}}, format="json").status_code, 200)
        self.assertTrue(two_step.required_for(User.objects.get(pk=doctor_id)))
        # The next sign-in will not open the workspace until it is set up; the front desk is not asked.
        again, signed = self.sign_in("doctor", NEW_PASSWORD)
        self.assertEqual(signed.json()["pending"], ["two_step"])
        self.assertEqual(again.get("/api/v1/patients/").status_code, 403)
        self.assertEqual(self.sign_in("priya", NEW_PASSWORD)[1].json()["pending"], [])
        self.turn_on(again, NEW_PASSWORD)
        self.assertEqual(again.get("/api/v1/auth/me/").json()["pending"], [])
        self.assertEqual(again.get("/api/v1/patients/").status_code, 200)
        self.assertEqual(again.post("/api/v1/auth/two-step/off/", {"password": NEW_PASSWORD}, format="json").status_code, 400)
        listed = {row["username"]: row for row in self.client.get("/api/v1/clinic/users/").json()["results"]}
        self.assertEqual((listed["doctor"]["two_step"], listed["doctor"]["two_step_asked"]), (True, True))
        self.assertEqual((listed["priya"]["two_step"], listed["priya"]["two_step_asked"]), (False, False))
        self.assertEqual((listed["owner"]["two_step"], listed["owner"]["two_step_asked"]), (False, True))
        # The owner can take it off for someone who lost their phone; they set it up again at the next sign-in.
        taken = self.client.post(f"/api/v1/clinic/users/{doctor_id}/two-step-off/")
        self.assertEqual((taken.status_code, taken.json()["two_step"]), (200, False))
        self.assertEqual(again.get("/api/v1/auth/me/").status_code, 401)
        self.assertEqual(self.sign_in("doctor", NEW_PASSWORD)[1].json()["pending"], ["two_step"])


class RecoveryTests(TeamTestCase):
    def recover(self, **changes):
        body = {"username": "owner", "recovery_key": self.recovery, "new_password": NEW_PASSWORD, **changes}
        return APIClient().post("/api/v1/auth/recover/", body, format="json")

    def test_the_recovery_key_gives_the_owner_a_new_password_and_is_then_replaced(self):
        self.turn_on(self.client, PASSWORD)
        self.assertEqual(
            self.recover(recovery_key="0000-" * 9 + "0000").json(), {"detail": "That username and recovery key do not open a clinic here."}
        )
        self.assertEqual(self.recover(username="nobody").json(), {"detail": "That username and recovery key do not open a clinic here."})
        self.assertEqual(self.recover(recovery_key="not a key").status_code, 400)
        self.assertIn("new_password", self.recover(new_password="short").json())
        master = services.unlock(self.owner, PASSWORD)
        done = self.recover(recovery_key=self.recovery.lower().replace("-", " "))
        self.assertEqual(done.status_code, 200, done.content)
        fresh = done.json()["recovery_keys"]
        self.assertEqual((len(fresh), fresh[0]["clinic"]), (1, "Synthetic Clinic"))
        self.assertNotEqual(fresh[0]["recovery_key"], self.recovery)
        # The old key is spent, the new one opens the same records, and every old way in is closed.
        with self.assertRaises(services.VaultError):
            services.recover(self.clinic, self.recovery)
        self.assertEqual(services.recover(self.clinic, fresh[0]["recovery_key"]), master[self.clinic.pk])
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 401)
        self.assertEqual(self.sign_in("owner", PASSWORD)[1].status_code, 401)
        _, signed = self.sign_in("owner", NEW_PASSWORD)
        self.assertEqual((signed.status_code, signed.json()["user"]["two_step"]), (200, False))
        self.assertTrue(signed.json()["memberships"][0]["records_unlocked"])
        self.assertTrue(AuditEvent.objects.filter(action="auth.recovery_used", clinic=self.clinic).exists())
        self.assertTrue(AuditEvent.objects.filter(action="auth.recovery_failed", outcome="failed").exists())
        self.assertFalse(any(self.recovery in str(vars(event)) for event in AuditEvent.objects.all()))

    def test_only_an_owner_can_be_recovered_and_guesses_are_limited(self):
        self.join()
        self.assertEqual(self.recover(username="priya").status_code, 400)
        for _ in range(4):
            self.assertEqual(self.recover(recovery_key="0000-" * 9 + "0000").status_code, 400)
        self.assertEqual(self.recover().status_code, 429)
        self.assertEqual(self.sign_in("owner", PASSWORD)[1].status_code, 200)

    def test_the_owner_makes_a_new_recovery_key_from_security(self):
        seen = self.client.get("/api/v1/clinic/security/").json()
        self.assertEqual((seen["two_step_asked"], seen["lock_after_minutes"], seen["sessions"]), (False, 15, 1))
        self.assertIsNotNone(seen["recovery_key_created_at"])
        self.assertEqual(self.client.post("/api/v1/clinic/recovery-key/", {"password": "wrong"}, format="json").status_code, 400)
        made = self.client.post("/api/v1/clinic/recovery-key/", {"password": PASSWORD}, format="json")
        self.assertEqual(made.status_code, 201, made.content)
        with self.assertRaises(services.VaultError):
            services.recover(self.clinic, self.recovery)
        self.assertEqual(services.recover(self.clinic, made.json()["recovery_key"]), services.unlock(self.owner, PASSWORD)[self.clinic.pk])
        self.assertTrue(AuditEvent.objects.filter(action="clinic.recovery_key").exists())
        self.assertEqual(self.client.patch("/api/v1/clinic/", {"lock_after_minutes": 5}, format="json").json()["lock_after_minutes"], 5)
