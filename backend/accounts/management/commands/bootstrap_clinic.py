import getpass
import os

from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import Clinic, Membership, Role, User, valid_currency, valid_time_zone


class Command(BaseCommand):
    help = "Create a clinic and owner; password comes from a prompt or BOOTSTRAP_PASSWORD environment variable."

    def add_arguments(self, parser):
        parser.add_argument("--clinic", required=True)
        parser.add_argument("--username", required=True)
        parser.add_argument("--time-zone", default="Asia/Kolkata", help="IANA time zone name; decides what the clinic calls today.")
        parser.add_argument("--currency", default="INR", help="Three-letter currency code.")

    @transaction.atomic
    def handle(self, *args, **options):
        if User.objects.filter(username=options["username"]).exists():
            raise CommandError("Username already exists; bootstrap will not modify an existing account.")
        valid_time_zone(options["time_zone"])
        valid_currency(options["currency"])
        password = os.environ.get("BOOTSTRAP_PASSWORD") or getpass.getpass("Owner password: ")
        user = User(username=options["username"])
        validate_password(password, user)
        user.set_password(password)
        user.save()
        clinic = Clinic.objects.create(name=options["clinic"], time_zone=options["time_zone"], currency=options["currency"].upper())
        Membership.objects.create(clinic=clinic, user=user, role=Role.objects.get(pk="owner"))
        self.stdout.write(self.style.SUCCESS(f"Created clinic {clinic.id} and owner {user.username}."))
