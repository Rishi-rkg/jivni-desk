from django.apps import AppConfig


class BillingConfig(AppConfig):
    name = "billing"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from records import guards as record_guards

        from . import guards

        record_guards.register(append_only=guards.APPEND_ONLY_TABLES, sqlite=guards.sqlite_statements)
