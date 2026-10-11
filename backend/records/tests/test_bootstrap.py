from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from unittest import mock
from accounts.models import Clinic, Membership


class BootstrapClinicTests(TestCase):
    def run_command(self, *args):
        with mock.patch.dict("os.environ", {"BOOTSTRAP_PASSWORD": "synthetic-bootstrap-password"}):
            call_command("bootstrap_clinic", "--clinic", "Synthetic clinic", "--username", "owner", *args, verbosity=0)

    def test_new_clinic_defaults_to_india(self):
        self.run_command()
        clinic = Clinic.objects.get()
        self.assertEqual((clinic.time_zone, clinic.currency), ("Asia/Kolkata", "INR"))
        self.assertEqual(Membership.objects.get().role_id, "owner")

    def test_overrides_and_validation(self):
        with self.assertRaises(Exception):
            self.run_command("--time-zone", "Mars/Olympus")
        self.assertEqual(Clinic.objects.count(), 0)
        self.run_command("--time-zone", "Europe/London", "--currency", "gbp")
        clinic = Clinic.objects.get()
        self.assertEqual((clinic.time_zone, clinic.currency), ("Europe/London", "GBP"))
        with self.assertRaises(CommandError):
            self.run_command()
