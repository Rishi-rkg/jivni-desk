import re

from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import Clinic, Installation, Membership, User
from audit.models import AuditEvent
from vault import services
from vault.models import BackupKey, ClinicKey
from vault.session import COOKIE

RECOVERY_PATTERN = r"^(?:[0-9A-HJKMNP-TV-Z]{4}-){9}[0-9A-HJKMNP-TV-Z]{4}$"
PASSWORD = "synthetic-setup-password"


class FirstTimeSetupTests(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient(enforce_csrf_checks=True)

    def post(self, **changes):
        token = self.client.get("/api/v1/auth/csrf/").json()["csrf_token"]
        body = {"clinic_name": "Synthetic Clinic", "username": "owner", "full_name": "Dr Synthetic", "password": PASSWORD, **changes}
        return self.client.post("/api/v1/auth/setup/", body, format="json", HTTP_X_CSRFTOKEN=token)

    def test_a_new_installation_asks_for_setup_and_an_existing_one_does_not(self):
        self.assertEqual(self.client.get("/api/v1/auth/setup/").json(), {"needed": True})
        Clinic.objects.create(name="Already here")
        self.assertEqual(self.client.get("/api/v1/auth/setup/").json(), {"needed": False})
        self.assertEqual(self.post().status_code, 409)
        self.assertFalse(User.objects.exists())

    def test_setup_creates_the_clinic_with_encryption_on_and_signs_the_owner_in(self):
        response = self.post()
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertRegex(body["recovery_key"], RECOVERY_PATTERN)
        clinic, owner = Clinic.objects.get(), User.objects.get()
        self.assertEqual((clinic.name, clinic.time_zone, clinic.currency), ("Synthetic Clinic", "Asia/Kolkata", "INR"))
        self.assertEqual((owner.username, owner.get_full_name()), ("owner", "Dr Synthetic"))
        self.assertEqual(Membership.objects.get().role_id, "owner")
        self.assertFalse(owner.is_superuser or owner.is_staff)
        # Encryption and backups are ready without any further step.
        self.assertEqual(ClinicKey.objects.filter(clinic=clinic).count(), 1)
        self.assertEqual(BackupKey.objects.count(), 1)
        master = services.unlock(owner, PASSWORD)[clinic.pk]
        self.assertEqual(services.recover(clinic, body["recovery_key"]), master)
        # Signed in and unlocked straight away.
        self.assertTrue(body["memberships"][0]["records_unlocked"])
        self.assertIn(COOKIE, response.cookies)
        me = self.client.get("/api/v1/auth/me/").json()
        self.assertEqual(me["clinic_id"], str(clinic.pk))
        self.assertTrue(me["memberships"][0]["records_unlocked"])
        self.assertNotIn("recovery_key", me)
        self.assertTrue(AuditEvent.objects.filter(action="clinic.setup", clinic=clinic, actor=owner).exists())
        self.assertEqual(Installation.objects.count(), 1)

    def test_the_recovery_key_is_not_stored_anywhere(self):
        key = self.post().json()["recovery_key"]
        compact = key.replace("-", "")
        from django.db import connection

        with connection.cursor() as cursor:
            for table in connection.introspection.table_names(cursor):
                cursor.execute(f'SELECT * FROM "{table}"')  # noqa: S608 - table names come from the database itself
                dump = repr(cursor.fetchall())
                self.assertNotIn(key, dump, table)
                self.assertNotIn(compact, dump, table)

    def test_setup_runs_only_once(self):
        self.assertEqual(self.post().status_code, 201)
        fresh = APIClient(enforce_csrf_checks=True)
        token = fresh.get("/api/v1/auth/csrf/").json()["csrf_token"]
        again = fresh.post(
            "/api/v1/auth/setup/",
            {"clinic_name": "Intruder", "username": "intruder", "password": "synthetic-other-password"},
            format="json",
            HTTP_X_CSRFTOKEN=token,
        )
        self.assertEqual(again.status_code, 409)
        self.assertEqual((Clinic.objects.count(), User.objects.count()), (1, 1))

    def test_invalid_input_creates_nothing_and_says_what_is_wrong(self):
        cases = [
            ({"password": "short"}, "password"),
            ({"password": "owner"}, "password"),
            ({"clinic_name": "  "}, "clinic_name"),
            ({"username": "has spaces"}, "username"),
            ({"username": ""}, "username"),
            ({"time_zone": "Mars/Olympus"}, "time_zone"),
        ]
        for changes, field in cases:
            response = self.post(**changes)
            self.assertEqual(response.status_code, 400, changes)
            self.assertIn(field, response.json(), changes)
        self.assertFalse(Clinic.objects.exists() or User.objects.exists() or Installation.objects.exists())
        self.assertEqual(self.post(time_zone="Europe/London").status_code, 201)
        self.assertEqual(Clinic.objects.get().time_zone, "Europe/London")

    def test_setup_needs_a_csrf_token(self):
        response = self.client.post("/api/v1/auth/setup/", {"clinic_name": "x", "username": "owner", "password": PASSWORD}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertFalse(Clinic.objects.exists())

    def test_recovery_key_shape(self):
        self.assertIsNotNone(re.match(RECOVERY_PATTERN, services.new_recovery_key()))
