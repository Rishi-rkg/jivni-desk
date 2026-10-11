from django.core.management.base import BaseCommand, CommandError

from accounts.models import Clinic, User
from vault import services
from vault.management.prompts import secret


class Command(BaseCommand):
    help = "Let a member open the clinic's records. Someone who already can must authorise it with their own password."

    def add_arguments(self, parser):
        parser.add_argument("--clinic-id", required=True)
        parser.add_argument("--username", required=True, help="The member receiving access.")
        parser.add_argument("--authorized-by", required=True, help="A member who can already open the records.")

    def handle(self, *args, **options):
        clinic = Clinic.objects.get(pk=options["clinic_id"])
        try:
            member = User.objects.get(username=options["username"])
            authorizer = User.objects.get(username=options["authorized_by"])
        except User.DoesNotExist:
            raise CommandError("Unknown username.") from None
        keys = services.unlock(authorizer, secret(f"Password for {authorizer.username}: ", "AUTHORIZER_PASSWORD")).get(clinic.pk)
        if not keys:
            raise CommandError("That person cannot open this clinic's records with that password.")
        password = secret(f"Password for {member.username}: ", "MEMBER_PASSWORD")
        if not member.check_password(password):
            raise CommandError("The member's password is not correct.")
        try:
            services.grant_access(clinic, keys, member, password, granted_by=authorizer)
        except services.VaultError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(self.style.SUCCESS("Access granted."))
