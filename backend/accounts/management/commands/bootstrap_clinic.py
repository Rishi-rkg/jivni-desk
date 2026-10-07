import getpass
import os
from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from accounts.models import Clinic, User, Role, Membership


class Command(BaseCommand):
    help = "Create a clinic and owner; password comes from a prompt or BOOTSTRAP_PASSWORD environment variable."

    def add_arguments(self, parser):
        parser.add_argument("--clinic", required=True)
        parser.add_argument("--username", required=True)

    @transaction.atomic
    def handle(self, *args, **options):
        if User.objects.filter(username=options["username"]).exists():
            raise CommandError("Username already exists; bootstrap will not modify an existing account.")
        password = os.environ.get("BOOTSTRAP_PASSWORD") or getpass.getpass("Owner password: ")
        user = User(username=options["username"])
        validate_password(password, user)
        user.set_password(password)
        user.save()
        clinic = Clinic.objects.create(name=options["clinic"])
        Membership.objects.create(clinic=clinic, user=user, role=Role.objects.get(pk="owner"))
        self.stdout.write(self.style.SUCCESS(f"Created clinic {clinic.id} and owner {user.username}."))
