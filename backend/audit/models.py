import uuid
from django.conf import settings
from django.db import models
from django.core.exceptions import ValidationError


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
    # Never persist symptoms, search strings, credentials, or other record content here.
    objects = AppendOnlyQuerySet.as_manager()

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ValidationError("Audit events are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValidationError("Audit events are append-only.")


def record_event(request, action, resource=None, clinic=None):
    AuditEvent.objects.create(
        actor=request.user if request.user.is_authenticated else None,
        clinic=clinic, action=action,
        resource_type=resource.__class__.__name__ if resource else "",
        resource_id=resource.pk if resource else None,
    )
