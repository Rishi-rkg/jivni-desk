from django.core.management.base import BaseCommand, CommandError

from accounts.models import Clinic, Membership
from vault import services
from vault.management.prompts import RECOVERY_NOTICE, secret


class Command(BaseCommand):
    help = "Create the encryption key for a clinic that has none, sealed for its owner, and show the recovery key once."

    def add_arguments(self, parser):
        parser.add_argument("--clinic-id", required=True)
        parser.add_argument("--username", required=True, help="An owner of the clinic.")

    def handle(self, *args, **options):
        clinic = Clinic.objects.get(pk=options["clinic_id"])
        member = (
            Membership.objects.filter(clinic=clinic, user__username=options["username"], role_id="owner", is_active=True)
            .select_related("user")
            .first()
        )
        if not member:
            raise CommandError("That user is not an active owner of the clinic.")
        password = secret("Owner password: ", "OWNER_PASSWORD")
        if not member.user.check_password(password):
            raise CommandError("The password is not correct.")
        try:
            recovery = services.create_clinic_key(clinic, member.user, password)
        except services.VaultError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(RECOVERY_NOTICE.format(key=recovery))
