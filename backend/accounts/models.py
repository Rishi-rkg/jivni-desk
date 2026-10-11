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


def valid_upi_id(value):
    name, _, handle = value.partition("@")
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789.-_")
    if value and not (name and handle and set(name.lower()) <= allowed and handle.isascii() and handle.isalnum()):
        raise ValidationError("Use a UPI ID such as clinicname@bank.")


def valid_prefix(value):
    if not (value and value.isascii() and value.isalnum()):
        raise ValidationError("Use letters and digits only, such as INV.")


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
    # Printed on bills and prescriptions.
    registration_number = models.CharField(max_length=60, blank=True)
    # Where a "scan to pay" code on a bill sends the money, for example clinicname@bank.
    upi_id = models.CharField(max_length=80, blank=True, validators=[valid_upi_id])
    # The start of every bill number, as in INV/26-27/0001.
    invoice_prefix = models.CharField(max_length=8, default="INV", validators=[valid_prefix])
    lock_after_minutes = models.PositiveSmallIntegerField(default=15, choices=[(2, "2 minutes"), (5, "5 minutes"), (15, "15 minutes")])
    # Switches chosen by the owner; anything not listed here keeps its default (accounts/features.py).
    features = models.JSONField(default=dict, blank=True)
    logo = models.BinaryField(null=True, blank=True, editable=True)
    logo_mime = models.CharField(max_length=30, blank=True)

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
