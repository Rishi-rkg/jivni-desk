import uuid
from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)


class Clinic(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    created_at = models.DateTimeField(auto_now_add=True)


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
