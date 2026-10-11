"""Clinic switches, print details, the logo and the signed-in person's own name."""

import io

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase
from PIL import Image
from rest_framework.test import APIClient

from accounts.features import FEATURES, NOT_BUILT, feature_on, features_of
from accounts.models import Clinic, Membership, User
from audit.models import AuditEvent


def png(size=(900, 300), colour=(20, 90, 110)):
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, "PNG")
    return buffer.getvalue()


class ClinicSwitchTests(TestCase):
    def setUp(self):
        self.clinic = Clinic.objects.create(name="Synthetic clinic")
        self.other_clinic = Clinic.objects.create(name="Other clinic")
        self.user = User.objects.create_user(username="owner", password="synthetic-password")
        self.member = Membership.objects.create(clinic=self.clinic, user=self.user, role_id="owner")
        self.client = APIClient()
        self.client.force_login(self.user)
        session = self.client.session
        session["clinic_id"] = str(self.clinic.pk)
        session.save()

    def role(self, value):
        self.member.role_id = value
        self.member.save()

    def test_defaults_are_served_and_half_built_parts_stay_off(self):
        features = self.client.get("/api/v1/clinic/").data["features"]
        self.assertEqual(set(features), set(FEATURES))
        self.assertEqual({name for name, on in features.items() if on}, {name for name, (_, on) in FEATURES.items() if on})
        for name in NOT_BUILT:
            self.assertFalse(features[name])
            response = self.client.patch("/api/v1/clinic/", {"features": {name: True}}, format="json")
            self.assertEqual(response.status_code, 400, name)
        # Even a value written straight into the database cannot turn one on.
        self.clinic.features = {name: True for name in NOT_BUILT}
        self.clinic.save()
        self.assertFalse(any(features_of(self.clinic)[name] for name in NOT_BUILT))

    def test_only_the_owner_changes_switches_and_only_for_their_clinic(self):
        response = self.client.patch("/api/v1/clinic/", {"features": {"billing": False, "auto_reminders": True}}, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["features"]["billing"], response.data["features"]["auto_reminders"]), (False, True))
        self.clinic.refresh_from_db()
        self.assertFalse(feature_on(self.clinic, "billing"))
        self.assertTrue(feature_on(self.clinic, "appointments"))
        self.assertTrue(feature_on(self.other_clinic, "billing"))
        self.assertTrue(AuditEvent.objects.filter(action="clinic.switches", resource_id=self.clinic.pk).exists())
        me = self.client.get("/api/v1/auth/me/").json()
        self.assertFalse(me["memberships"][0]["features"]["billing"])
        for role in ["admin", "clinician", "assistant", "reception", "billing"]:
            self.role(role)
            response = self.client.patch("/api/v1/clinic/", {"features": {"billing": True}}, format="json")
            self.assertEqual(response.status_code, 403, role)
        self.clinic.refresh_from_db()
        self.assertFalse(feature_on(self.clinic, "billing"))

    def test_bad_switch_requests_change_nothing(self):
        for body in [{"features": {"nonsense": True}}, {"features": {"billing": "yes"}}, {"features": ["billing"]}]:
            self.assertEqual(self.client.patch("/api/v1/clinic/", body, format="json").status_code, 400, body)
        self.clinic.refresh_from_db()
        self.assertEqual(self.clinic.features, {})

    def test_print_details_are_checked(self):
        good = {"registration_number": "MH-12345", "upi_id": "sunrise.clinic@okbank", "invoice_prefix": "sc", "lock_after_minutes": 5}
        response = self.client.patch("/api/v1/clinic/", good, format="json")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data["invoice_prefix"], response.data["lock_after_minutes"]), ("SC", 5))
        for bad in [{"upi_id": "no-at-sign"}, {"upi_id": "a b@bank"}, {"invoice_prefix": "IN/V"}, {"lock_after_minutes": 7}]:
            self.assertEqual(self.client.patch("/api/v1/clinic/", bad, format="json").status_code, 400, bad)
        # An administrator may keep these details, though not the switches.
        self.role("admin")
        self.assertEqual(self.client.patch("/api/v1/clinic/", {"registration_number": "MH-9"}, format="json").status_code, 200)

    def test_the_lock_time_follows_the_clinic_and_a_shared_computer_locks_sooner(self):
        self.assertEqual(self.client.get("/api/v1/auth/me/").json()["idle_timeout_seconds"], 900)
        self.clinic.lock_after_minutes = 5
        self.clinic.save()
        self.assertEqual(self.client.get("/api/v1/auth/me/").json()["idle_timeout_seconds"], 300)
        session = self.client.session
        session["shared_computer"] = True
        session.save()
        self.assertEqual(self.client.get("/api/v1/auth/me/").json()["idle_timeout_seconds"], 120)
        self.assertEqual(self.client.session["idle_seconds"], 120)

    def test_logo_upload_is_re_encoded_shrunk_and_scoped(self):
        self.assertEqual(self.client.get("/api/v1/clinic/logo/").status_code, 404)
        upload = SimpleUploadedFile("anything at all.png", png(), content_type="image/png")
        response = self.client.post("/api/v1/clinic/logo/", {"logo": upload}, format="multipart")
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(response.data["has_logo"])
        served = self.client.get("/api/v1/clinic/logo/")
        self.assertEqual(served["Content-Type"], "image/png")
        image = Image.open(io.BytesIO(served.content))
        self.assertEqual((image.format, max(image.size)), ("PNG", 512))
        self.other_clinic.refresh_from_db()
        self.assertIsNone(self.other_clinic.logo)
        # Every member sees it (it is printed on what they hand out); only owner and administrator change it.
        self.role("reception")
        self.assertEqual(self.client.get("/api/v1/clinic/logo/").status_code, 200)
        again = SimpleUploadedFile("logo.png", png(), content_type="image/png")
        self.assertEqual(self.client.post("/api/v1/clinic/logo/", {"logo": again}, format="multipart").status_code, 403)
        self.assertEqual(self.client.delete("/api/v1/clinic/logo/").status_code, 403)
        self.role("admin")
        self.assertEqual(self.client.delete("/api/v1/clinic/logo/").status_code, 200)
        self.assertEqual(self.client.get("/api/v1/clinic/logo/").status_code, 404)

    def test_bad_logos_are_refused(self):
        for name, data in [("logo.png", b"not an image"), ("logo.gif", b"GIF89a" + bytes(20)), ("big.png", bytes(1024 * 1024 + 1))]:
            upload = SimpleUploadedFile(name, data, content_type="image/png")
            self.assertEqual(self.client.post("/api/v1/clinic/logo/", {"logo": upload}, format="multipart").status_code, 400, name)
        self.assertEqual(self.client.post("/api/v1/clinic/logo/", {}, format="multipart").status_code, 400)

    def test_a_person_changes_their_own_display_name(self):
        response = self.client.post("/api/v1/auth/account/", {"full_name": "  Dr Synthetic Owner "}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"]["name"], "Dr Synthetic Owner")
        for bad in [{"full_name": ""}, {"full_name": "x" * 151}, {}]:
            self.assertEqual(self.client.post("/api/v1/auth/account/", bad, format="json").status_code, 400, bad)
        self.client.logout()
        self.assertEqual(self.client.post("/api/v1/auth/account/", {"full_name": "Nobody"}, format="json").status_code, 401)
