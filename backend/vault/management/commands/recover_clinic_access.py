from django.contrib.auth.password_validation import validate_password
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from accounts.models import Clinic, Membership
from vault import services
from vault.management.prompts import RECOVERY_NOTICE, secret


class Command(BaseCommand):
    help = "Use the clinic recovery key to give an owner a new password and access, then replace the recovery key."

    def add_arguments(self, parser):
        parser.add_argument("--clinic-id", required=True)
        parser.add_argument("--username", required=True, help="An owner of the clinic.")

    @transaction.atomic
    def handle(self, *args, **options):
        clinic = Clinic.objects.get(pk=options["clinic_id"])
        member = (
            Membership.objects.filter(clinic=clinic, user__username=options["username"], role_id="owner", is_active=True)
            .select_related("user")
            .first()
        )
        if not member:
            raise CommandError("That user is not an active owner of the clinic.")
        try:
            keys = services.recover(clinic, secret("Recovery key: ", "RECOVERY_KEY"))
        except services.VaultError as error:
            raise CommandError(str(error)) from None
        password = secret("New owner password: ", "NEW_PASSWORD")
        validate_password(password, member.user)
        member.user.set_password(password)
        member.user.save()
        services.grant_access(clinic, keys, member.user, password, granted_by=member.user)
        # A recovery key that has been typed into a terminal is spent; issue a fresh one.
        recovery = services.replace_recovery_key(clinic, keys, replaced_by=member.user)
        self.stdout.write(self.style.SUCCESS("Owner password reset and access restored. The old recovery key no longer works."))
        self.stdout.write(RECOVERY_NOTICE.format(key=recovery))
