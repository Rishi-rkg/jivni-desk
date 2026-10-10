"""Phase 1 close-out: clinic-local dates, archive actions, doctor-only notes, audit visibility, idle lock."""
import time
import uuid
from datetime import date, datetime, timezone as dt_timezone
from unittest import mock
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.test import TestCase
from rest_framework.test import APIClient
from accounts.models import Clinic, User, Membership
from audit.models import AuditEvent
from records.models import Patient, Encounter


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=dt_timezone.utc)


class ClinicLocalDateTests(TestCase):
    def setUp(self):
        self.east = Clinic.objects.create(name="East clinic", time_zone="Asia/Kolkata")
        self.west = Clinic.objects.create(name="West clinic", time_zone="America/New_York")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")

    def test_today_follows_the_clinic_not_utc(self):
        # 20:00 UTC on 1 January is already 2 January in Kolkata and still 1 January in New York.
        with mock.patch("django.utils.timezone.now", return_value=at("2026-01-01T20:00:00")):
            self.assertEqual(self.east.today(), date(2026, 1, 2))
            self.assertEqual(self.west.today(), date(2026, 1, 1))
            Patient.objects.create(clinic=self.east, first_name="Newborn", date_of_birth="2026-01-02", gender="other")
            with self.assertRaises(ValidationError):
                Patient.objects.create(clinic=self.east, first_name="Future", date_of_birth="2026-01-03", gender="other")
            with self.assertRaises(ValidationError):
                Patient.objects.create(clinic=self.west, first_name="Future", date_of_birth="2026-01-02", gender="other")

    def test_follow_up_is_compared_with_the_local_visit_date(self):
        patient = Patient.objects.create(clinic=self.east, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        with mock.patch("django.utils.timezone.now", return_value=at("2026-01-05T00:00:00")):
            visit = dict(patient=patient, clinician=self.user, chief_complaint="Synthetic", occurred_at=at("2026-01-01T20:00:00"))
            with self.assertRaises(ValidationError):
                Encounter.objects.create(follow_up_date="2026-01-01", **visit)
            Encounter.objects.create(follow_up_date="2026-01-02", **visit)

    def test_invalid_time_zone_is_rejected(self):
        clinic = Clinic(name="Bad", time_zone="Mars/Olympus")
        with self.assertRaises(ValidationError):
            clinic.full_clean()


class HardeningAPITests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.patient = Patient.objects.create(clinic=self.clinic, first_name="Synthetic", date_of_birth="1990-01-01", gender="other")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def test_unauthenticated_requests_get_401(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/v1/patients/").status_code, 401)
        self.assertEqual(self.client.get("/api/v1/clinic/").status_code, 401)

    # --- archive and restore

    def test_archived_at_cannot_be_set_through_patch(self):
        url = f"/api/v1/patients/{self.patient.pk}/"
        response = self.client.patch(url, {"archived_at": "2001-01-01T00:00:00Z", "first_name": "Renamed"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.data["archived_at"])
        self.patient.refresh_from_db()
        self.assertIsNone(self.patient.archived_at)

    def test_archive_and_restore_are_audited_and_stamped_by_the_server(self):
        url = f"/api/v1/patients/{self.patient.pk}/"
        response = self.client.post(url + "archive/", {"archived_at": "2001-01-01T00:00:00Z"}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.patient.refresh_from_db()
        self.assertGreater(self.patient.archived_at.year, 2001)
        self.assertEqual(self.client.get("/api/v1/patients/").data["count"], 0)
        self.assertEqual(self.client.get("/api/v1/patients/?archived=true").data["count"], 1)
        # Archiving twice does not move the timestamp or add a second event.
        first = self.patient.archived_at
        self.client.post(url + "archive/")
        self.patient.refresh_from_db()
        self.assertEqual(self.patient.archived_at, first)
        self.assertEqual(AuditEvent.objects.filter(action="patient.archive", resource_id=self.patient.pk).count(), 1)
        self.assertEqual(self.client.post(url + "restore/").status_code, 200)
        self.patient.refresh_from_db()
        self.assertIsNone(self.patient.archived_at)
        self.assertEqual(AuditEvent.objects.filter(action="patient.restore", resource_id=self.patient.pk).count(), 1)

    def test_only_clinical_writers_may_archive(self):
        for role in ["assistant", "reception", "billing", "admin"]:
            self.role(role)
            self.assertEqual(self.client.post(f"/api/v1/patients/{self.patient.pk}/archive/").status_code, 403, role)
        self.patient.refresh_from_db()
        self.assertIsNone(self.patient.archived_at)

    def test_archive_is_clinic_scoped(self):
        other = Patient.objects.create(clinic=self.other_clinic, first_name="Other", date_of_birth="1990-01-01", gender="other")
        self.assertEqual(self.client.post(f"/api/v1/patients/{other.pk}/archive/").status_code, 404)

    # --- internal notes

    def test_internal_notes_are_for_clinical_writers_only(self):
        encounter = Encounter.objects.create(patient=self.patient, clinician=self.user, chief_complaint="Synthetic", internal_notes="Doctor only")
        urls = ["/api/v1/encounters/", f"/api/v1/encounters/{encounter.pk}/", f"/api/v1/patients/{self.patient.pk}/timeline/"]

        def visible(url):
            data = self.client.get(url).data
            item = data["results"][0] if "results" in data else data["encounters"][0] if "encounters" in data else data
            return item.get("internal_notes")

        for url in urls:
            self.assertEqual(visible(url), "Doctor only", url)
        self.role("owner")
        self.assertEqual(visible(urls[0]), "Doctor only")
        self.role("assistant")
        for url in urls:
            self.assertIsNone(visible(url), url)

    # --- audit

    def test_denied_access_is_recorded_without_content(self):
        self.role("reception")
        self.assertEqual(self.client.get(f"/api/v1/patients/{self.patient.pk}/timeline/").status_code, 403)
        event = AuditEvent.objects.get(action="access.denied")
        self.assertEqual((event.outcome, event.clinic, event.actor, event.resource_id), ("denied", self.clinic, self.user, self.patient.pk))
        self.assertEqual(event.resource_type, "patient")

    def test_events_carry_request_id_and_source_address(self):
        response = self.client.get(f"/api/v1/patients/{self.patient.pk}/")
        event = AuditEvent.objects.get(action="patient.view")
        self.assertEqual(str(event.request_id), response["X-Request-ID"])
        self.assertEqual(event.source_ip, "127.0.0.1")
        self.assertEqual(event.outcome, "success")

    def test_audit_list_shows_outcome_and_filters(self):
        self.role("owner")
        AuditEvent.objects.create(clinic=self.clinic, action="auth.login_failed", outcome="failed")
        AuditEvent.objects.create(clinic=self.other_clinic, action="auth.login_failed", outcome="failed")
        self.client.get(f"/api/v1/patients/{self.patient.pk}/")
        response = self.client.get("/api/v1/audit-events/?outcome=failed")
        self.assertEqual(response.data["count"], 1)
        self.assertEqual(response.data["results"][0]["actor_username"], "")
        rows = self.client.get("/api/v1/audit-events/").data["results"]
        self.assertEqual(next(row for row in rows if row["action"] == "patient.view")["actor_username"], "doctor")

    # --- clinic settings

    def test_any_member_reads_settings_and_only_admins_change_them(self):
        self.assertEqual(self.client.get("/api/v1/clinic/").data["time_zone"], "UTC")
        change = {"time_zone": "Asia/Kolkata", "currency": "inr", "tax_identifier": "SYNTHETIC-1"}
        self.assertEqual(self.client.patch("/api/v1/clinic/", change, format="json").status_code, 403)
        self.assertTrue(AuditEvent.objects.filter(action="access.denied", resource_type="Clinic").exists())
        for role in ["owner", "admin"]:
            self.role(role)
            response = self.client.patch("/api/v1/clinic/", change, format="json")
            self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["time_zone"], response.data["currency"]), ("Asia/Kolkata", "INR"))
        self.assertTrue(AuditEvent.objects.filter(action="clinic.update", resource_id=self.clinic.pk).exists())
        self.other_clinic.refresh_from_db()
        self.assertEqual(self.other_clinic.time_zone, "UTC")

    def test_invalid_settings_are_rejected(self):
        self.role("owner")
        for change in [{"time_zone": "Mars/Olympus"}, {"currency": "RUPEES"}, {"currency": "12"}, {"name": ""}]:
            self.assertEqual(self.client.patch("/api/v1/clinic/", change, format="json").status_code, 400, change)
        self.assertEqual(self.client.patch("/api/v1/clinic/", {"id": str(uuid.uuid4())}, format="json").data["id"], str(self.clinic.pk))

    # --- idle lock

    def test_idle_session_is_ended_and_audited(self):
        session = self.client.session
        session["last_activity"] = int(time.time()) - 16 * 60
        session.save()
        self.assertEqual(self.client.get("/api/v1/patients/").status_code, 401)
        self.assertTrue(AuditEvent.objects.filter(action="auth.idle_timeout", actor=self.user, clinic=self.clinic).exists())
        self.assertEqual(self.client.get("/api/v1/auth/me/").status_code, 401)

    def test_active_session_stays_open(self):
        session = self.client.session
        session["last_activity"] = int(time.time()) - 5 * 60
        session.save()
        self.assertEqual(self.client.get("/api/v1/patients/").status_code, 200)
        self.assertGreater(self.client.session["last_activity"], int(time.time()) - 5)
        self.assertEqual(self.client.get("/api/v1/auth/me/").json()["idle_timeout_seconds"], 900)


class LoginAuditTests(TestCase):
    def setUp(self):
        cache.clear()
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.user = User.objects.create_user(username="doctor", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="clinician")
        self.client = APIClient()

    def login(self, username, password):
        return self.client.post("/api/v1/auth/login/", {"username": username, "password": password}, format="json")

    def test_failed_login_is_recorded_against_the_account_clinic(self):
        self.assertEqual(self.login("doctor", "wrong-password").status_code, 401)
        event = AuditEvent.objects.get(action="auth.login_failed")
        self.assertEqual((event.clinic, event.outcome, event.actor, event.resource_type, event.resource_id), (self.clinic, "failed", None, "User", self.user.pk))

    def test_failed_login_for_unknown_username_has_no_clinic_and_no_username(self):
        self.assertEqual(self.login("nobody-here", "wrong-password").status_code, 401)
        event = AuditEvent.objects.get(action="auth.login_failed")
        self.assertEqual((event.clinic, event.resource_type, event.resource_id), (None, "", None))

    def test_removed_member_login_is_recorded_for_the_clinic(self):
        self.member.is_active = False
        self.member.save()
        self.assertEqual(self.login("doctor", "synthetic-password").status_code, 403)
        event = AuditEvent.objects.get(action="auth.login_denied")
        self.assertEqual((event.clinic, event.outcome, event.actor), (self.clinic, "denied", self.user))

    def test_owner_can_see_failed_logins(self):
        self.login("doctor", "wrong-password")
        owner = User.objects.create_user(username="owner", password="synthetic-password")
        Membership.objects.create(clinic=self.clinic, user=owner, role_id="owner")
        self.assertEqual(self.login("owner", "synthetic-password").status_code, 200)
        actions = [row["action"] for row in self.client.get("/api/v1/audit-events/?outcome=failed").data["results"]]
        self.assertEqual(actions, ["auth.login_failed"])


class HealthTests(TestCase):
    def test_health_reports_database_state(self):
        self.assertEqual(self.client.get("/health/").status_code, 200)
        with mock.patch("config.urls.connection.cursor", side_effect=RuntimeError("down")):
            response = self.client.get("/health/")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"status": "unavailable"})
