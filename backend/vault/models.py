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
