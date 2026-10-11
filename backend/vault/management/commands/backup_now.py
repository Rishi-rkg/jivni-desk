from django.core.management.base import BaseCommand, CommandError

from accounts.models import Clinic
from vault import backup
from vault.models import BackupRun


class Command(BaseCommand):
    help = (
        "Make an encrypted backup to the clinic's backup places. Needs no password: backups are locked with the "
        "clinic's backup key. With --if-due it does nothing unless the schedule calls for one, so it can be run "
        "every few minutes by a scheduler."
    )

    def add_arguments(self, parser):
        parser.add_argument("--if-due", action="store_true", help="Only back up when the clinic's schedule says one is due.")

    def handle(self, *args, **options):
        clinic = Clinic.objects.first()
        if clinic is None:
            raise CommandError("There is no clinic to back up yet.")
        if options["if_due"] and not backup.is_due(clinic):
            self.stdout.write("No backup is due.")
            return
        try:
            run = backup.run_backup(clinic, BackupRun.Kind.AUTOMATIC if options["if_due"] else BackupRun.Kind.MANUAL)
        except backup.BackupError as error:
            raise CommandError(str(error)) from None
        for place in run.places:
            self.stdout.write(f"{place['name']}: {'saved' if place['ok'] else 'FAILED - ' + place.get('error', '')}")
        if not run.ok:
            raise CommandError(run.error)
        self.stdout.write(self.style.SUCCESS(f"Backup {run.file_name} ({run.byte_size} bytes)."))
