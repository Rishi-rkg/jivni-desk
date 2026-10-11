from django.apps import AppConfig


class SchedulingConfig(AppConfig):
    name = "scheduling"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        # A patient's appointments join their timeline.
        from records.views import TIMELINE_SOURCES

        from .views import appointment_timeline

        if appointment_timeline not in TIMELINE_SOURCES:
            TIMELINE_SOURCES.append(appointment_timeline)
