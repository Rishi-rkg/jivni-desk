from django.core.management.base import BaseCommand, CommandError

from vault import backup, services
from vault.management.prompts import secret


class Command(BaseCommand):
    help = (
        "Restore a backup file into a new, empty installation (run migrate first). Opens the backup with a staff "
        "password, or with the clinic recovery key when --recovery-key is given. Use --check to read the backup "
        "back in full without restoring anything."
    )

    def add_arguments(self, parser):
        parser.add_argument("file")
        parser.add_argument("--recovery-key", action="store_true", help="Open the backup with the clinic recovery key.")
        parser.add_argument("--check", action="store_true", help="Verify the backup only; change nothing.")

    def handle(self, *args, **options):
        if options["recovery_key"]:
            opening = {"recovery_key": secret("Recovery key: ", "RECOVERY_KEY")}
        else:
            opening = {"password": secret("Password of a staff member who could open the records: ", "BACKUP_PASSWORD")}
        try:
            action = backup.verify_backup if options["check"] else backup.restore_backup
            manifest = action(options["file"], **opening)
        except (backup.BackupError, services.VaultError) as error:
            raise CommandError(str(error)) from None
        except FileNotFoundError:
            raise CommandError("That backup file was not found.") from None
        counts = manifest["counts"]
        summary = f"{counts['patients']} patients, {counts['visits']} visits, {counts['files']} files (made {manifest['created_at'][:16]})"
        if options["check"]:
            self.stdout.write(self.style.SUCCESS(f"The backup reads back in full: {summary}."))
        else:
            self.stdout.write(
                self.style.SUCCESS(f"Restored {summary}. Staff sign in with the passwords they had when the backup was made.")
            )
