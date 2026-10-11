import uuid
import zoneinfo

from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone


def valid_time_zone(value):
    try:
        zoneinfo.ZoneInfo(value)
    except (KeyError, ValueError, OSError):
        raise ValidationError("Use an IANA time zone name such as Asia/Kolkata.") from None


def valid_currency(value):
    if value and not (len(value) == 3 and value.isascii() and value.isalpha()):
        raise ValidationError("Use a three-letter currency code such as INR.")


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)


class Clinic(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)
    # Clinic settings. Issued documents must snapshot these, never read them live.
    time_zone = models.CharField(max_length=64, default="UTC", validators=[valid_time_zone])
    address = models.TextField(blank=True, max_length=500)
    phone = models.CharField(max_length=40, blank=True)
    email = models.EmailField(blank=True)
    tax_identifier = models.CharField(max_length=60, blank=True)
    currency = models.CharField(max_length=3, blank=True, validators=[valid_currency])

    @property
    def tzinfo(self):
        try:
            return zoneinfo.ZoneInfo(self.time_zone)
        except (KeyError, ValueError, OSError):
            return zoneinfo.ZoneInfo("UTC")

    def local_date(self, moment):
        return moment.astimezone(self.tzinfo).date()

    def today(self):
        """The calendar date at the clinic, which is what staff mean by today."""
        return self.local_date(timezone.now())


class Role(models.Model):
    class Code(models.TextChoices):
        OWNER = "owner", "Owner"
        ADMIN = "admin", "Administrator"
        CLINICIAN = "clinician", "Clinician"
        ASSISTANT = "assistant", "Clinical assistant"
        RECEPTION = "reception", "Reception"
        BILLING = "billing", "Billing"

    code = models.CharField(max_length=20, choices=Code.choices, primary_key=True)
    label = models.CharField(max_length=60)


class Membership(models.Model):
    clinic = models.ForeignKey(Clinic, on_delete=models.PROTECT)
    user = models.ForeignKey(User, on_delete=models.PROTECT, related_name="memberships")
    role = models.ForeignKey(Role, on_delete=models.PROTECT)
    is_active = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["clinic", "user"], name="unique_clinic_user")]


class Installation(models.Model):
    """One row, made by first-time setup. Its fixed primary key means two setups cannot both succeed."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
    set_up_at = models.DateTimeField(auto_now_add=True)
