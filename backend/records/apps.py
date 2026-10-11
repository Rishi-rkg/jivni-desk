from django.apps import AppConfig


class RecordsConfig(AppConfig):
    name = "records"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from . import guards

        guards.connect()
