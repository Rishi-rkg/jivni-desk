import datetime
import uuid

from django.conf import settings
from django.db import models


class ClinicKey(models.Model):
    """One version of a clinic's master key. The key itself is never stored; only sealed copies in KeyGrant."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT, related_name="keys")
    version = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    retired_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["clinic", "-version"]
        constraints = [models.UniqueConstraint(fields=["clinic", "version"], name="unique_clinic_key_version")]


class KeyGrant(models.Model):
    """A copy of a clinic key sealed for one person's password, or for the clinic's recovery key."""

    class Kind(models.TextChoices):
        USER = "user", "User password"
        RECOVERY = "recovery", "Recovery key"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    clinic_key = models.ForeignKey(ClinicKey, on_delete=models.PROTECT, related_name="grants")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="key_grants")
    salt = models.BinaryField()
    kdf = models.JSONField()
    sealed_key = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+")
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["clinic_key", "user"],
                condition=models.Q(revoked_at__isnull=True, kind="user"),
                name="one_active_grant_per_user_and_key",
            ),
            models.UniqueConstraint(
                fields=["clinic_key"],
                condition=models.Q(revoked_at__isnull=True, kind="recovery"),
                name="one_active_recovery_grant_per_key",
            ),
            models.CheckConstraint(
                condition=models.Q(kind="user", user__isnull=False) | models.Q(kind="recovery", user__isnull=True),
                name="grant_kind_matches_user",
            ),
        ]


class BackupKey(models.Model):
    """A key pair for backups. The public half can lock a backup at any time, even while nobody is signed in;
    the private half is sealed under the clinic key, so opening a backup needs a password or the recovery key."""

    clinic_key = models.OneToOneField(ClinicKey, on_delete=models.PROTECT, related_name="backup_key", primary_key=True)
    public_key = models.BinaryField()
    sealed_private = models.BinaryField()
    created_at = models.DateTimeField(auto_now_add=True)


class BackupPlace(models.Model):
    """A folder backups are copied to: on this computer, on a NAS share, or a cloud drive that appears as a folder."""

    class Kind(models.TextChoices):
        LOCAL = "local", "Local or USB folder"
        NAS = "nas", "Network storage"
        CLOUD = "cloud", "Cloud drive folder"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.CASCADE, related_name="backup_places")
    name = models.CharField(max_length=80)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.LOCAL)
    folder = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)
    last_ok_at = models.DateTimeField(null=True, blank=True)
    last_error = models.CharField(max_length=300, blank=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [models.UniqueConstraint(fields=["clinic", "folder"], name="unique_backup_folder_per_clinic")]


class BackupPolicy(models.Model):
    class Frequency(models.TextChoices):
        DAILY = "daily", "Every day"
        TWICE_DAILY = "twice_daily", "Twice a day"
        WEEKLY = "weekly", "Every week"

    clinic = models.OneToOneField("accounts.Clinic", on_delete=models.CASCADE, related_name="backup_policy", primary_key=True)
    automatic = models.BooleanField(default=True)
    frequency = models.CharField(max_length=12, choices=Frequency.choices, default=Frequency.DAILY)
    at = models.TimeField(default=datetime.time(2, 0))
    keep_daily_days = models.PositiveIntegerField(default=30)
    keep_monthly_months = models.PositiveIntegerField(default=12, help_text="0 keeps monthly backups forever.")
    warn_after_days = models.PositiveIntegerField(default=2)


class BackupRun(models.Model):
    """One backup that was attempted: what was written and where. Holds no patient data."""

    class Kind(models.TextChoices):
        MANUAL = "manual", "Manual"
        AUTOMATIC = "automatic", "Automatic"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.CASCADE, related_name="backup_runs")
    kind = models.CharField(max_length=10, choices=Kind.choices)
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    file_name = models.CharField(max_length=120, blank=True)
    byte_size = models.BigIntegerField(default=0)
    sha256 = models.CharField(max_length=64, blank=True)
    places = models.JSONField(default=list)
    ok = models.BooleanField(default=False)
    error = models.CharField(max_length=300, blank=True)
    verified_at = models.DateTimeField(null=True, blank=True)
    verified_ok = models.BooleanField(null=True)
    started_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+")

    class Meta:
        ordering = ["-started_at", "id"]
