from django.apps import AppConfig


class MessagingConfig(AppConfig):
    name = "messaging"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from records import guards as record_guards
        from records.views import TIMELINE_SOURCES

        from . import guards
        from .views import message_timeline

        record_guards.register(sqlite=guards.sqlite_statements)
        # A patient's messages join their timeline.
        if message_timeline not in TIMELINE_SOURCES:
            TIMELINE_SOURCES.append(message_timeline)
