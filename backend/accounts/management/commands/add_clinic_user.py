from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import Clinic, Membership, Role, User
from vault import services as vault
from vault.management.prompts import secret
from vault.models import ClinicKey


class Command(BaseCommand):
    help = "Operator-only user provisioning; does not grant Django superuser privileges."

    def add_arguments(self, parser):
        parser.add_argument("--clinic-id", required=True)
        parser.add_argument("--username", required=True)
        parser.add_argument("--role", required=True, choices=Role.Code.values)
        parser.add_argument(
            "--authorized-by",
            help="A member who can open the clinic's records. Required once the clinic has an encryption key.",
        )

    @transaction.atomic
    def handle(self, *args, **options):
        clinic = Clinic.objects.get(pk=options["clinic_id"])
        if User.objects.filter(username=options["username"]).exists():
            raise CommandError("Username already exists.")
        keys = authorizer = None
        if ClinicKey.objects.filter(clinic=clinic).exists():
            # An operator alone cannot hand out access to encrypted records; someone who holds it must.
            authorizer = User.objects.filter(username=options["authorized_by"] or "").first()
            if not authorizer:
                raise CommandError("This clinic's records are encrypted. Pass --authorized-by with a member who can open them.")
            keys = vault.unlock(authorizer, secret(f"Password for {authorizer.username}: ", "AUTHORIZER_PASSWORD")).get(clinic.pk)
            if not keys:
                raise CommandError("That person cannot open this clinic's records with that password.")
        user = User(username=options["username"])
        password = secret("New user password: ", "NEW_USER_PASSWORD")
        validate_password(password, user)
        user.set_password(password)
        user.save()
        Membership.objects.create(clinic=clinic, user=user, role_id=options["role"])
        if keys:
            vault.grant_access(clinic, keys, user, password, granted_by=authorizer)
        self.stdout.write(self.style.SUCCESS("User and clinic membership created."))
