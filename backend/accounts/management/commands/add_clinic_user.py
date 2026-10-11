import getpass

from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import Clinic, Membership, Role, User


class Command(BaseCommand):
    help = "Operator-only user provisioning; does not grant Django superuser privileges."

    def add_arguments(self, parser):
        parser.add_argument("--clinic-id", required=True)
        parser.add_argument("--username", required=True)
        parser.add_argument("--role", required=True, choices=Role.Code.values)

    @transaction.atomic
    def handle(self, *args, **options):
        clinic = Clinic.objects.get(pk=options["clinic_id"])
        if User.objects.filter(username=options["username"]).exists():
            raise CommandError("Username already exists.")
        user = User(username=options["username"])
        password = getpass.getpass("New user password: ")
        validate_password(password, user)
        user.set_password(password)
        user.save()
        Membership.objects.create(clinic=clinic, user=user, role_id=options["role"])
        self.stdout.write(self.style.SUCCESS("User and clinic membership created."))
