from django.db import migrations

# PostgreSQL triggers for messages. SQLite gets the same rules from messaging/guards.py after every migrate.
# Written out in full here because a migration must not depend on application code that may change later.
FROZEN = ["clinic_id", "patient_id", "kind", "title", "body", "to_number", "sent_at", "sent_by_id"]


def install(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    changed = " OR ".join(f"NEW.{column} IS DISTINCT FROM OLD.{column}" for column in FROZEN)
    schema_editor.execute(f"""
        CREATE FUNCTION messaging_guard_message() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                RAISE EXCEPTION 'A message is never deleted';
            END IF;
            IF (OLD.sent_at IS NOT NULL OR OLD.source = 'reply') AND ({changed}) THEN
                RAISE EXCEPTION 'A sent message cannot be changed';
            END IF;
            RETURN NEW;
        END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER guard_message_frozen BEFORE UPDATE OR DELETE ON messaging_message
            FOR EACH ROW EXECUTE FUNCTION messaging_guard_message();
    """)


def uninstall(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    schema_editor.execute("""
        DROP TRIGGER guard_message_frozen ON messaging_message;
        DROP FUNCTION messaging_guard_message();
    """)


class Migration(migrations.Migration):
    dependencies = [("messaging", "0001_initial")]
    operations = [migrations.RunPython(install, uninstall)]
