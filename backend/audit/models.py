import ipaddress
import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class AppendOnlyQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ValidationError("Audit events are append-only.")

    def delete(self):
        raise ValidationError("Audit events are append-only.")


class AuditEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    clinic = models.ForeignKey("accounts.Clinic", on_delete=models.PROTECT, null=True)
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True)
    action = models.CharField(max_length=60)
    resource_type = models.CharField(max_length=60, blank=True)
    resource_id = models.UUIDField(null=True)
    occurred_at = models.DateTimeField(auto_now_add=True, db_index=True)
    outcome = models.CharField(
        max_length=10, choices=[("success", "Success"), ("denied", "Denied"), ("failed", "Failed")], default="success"
    )
    source_ip = models.GenericIPAddressField(null=True)
    request_id = models.UUIDField(null=True)
    # Never persist symptoms, search strings, credentials, or other record content here.
    objects = AppendOnlyQuerySet.as_manager()

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Audit events are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Audit events are append-only.")


def source_address(request):
    # REMOTE_ADDR only. A deployment behind a proxy must set it from a trusted header at the proxy.
    try:
        return str(ipaddress.ip_address(request.META.get("REMOTE_ADDR", "")))
    except ValueError:
        return None


def record_event(request, action, resource=None, clinic=None, outcome="success", actor=None, resource_type="", resource_id=None):
    if actor is None and request.user.is_authenticated:
        actor = request.user
    AuditEvent.objects.create(
        actor=actor,
        clinic=clinic,
        action=action,
        outcome=outcome,
        resource_type=resource.__class__.__name__ if resource else resource_type,
        resource_id=resource.pk if resource else resource_id,
        source_ip=source_address(request),
        request_id=getattr(request, "request_id", None),
    )
