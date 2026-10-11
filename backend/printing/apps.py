from django.apps import AppConfig

APPEND_ONLY_TABLES = ["printing_printtemplate", "printing_printjob"]


class PrintingConfig(AppConfig):
    name = "printing"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from records import guards

        guards.register(append_only=APPEND_ONLY_TABLES)
