"""Database-level safeguards for messages, on both supported databases.

- a message is never deleted (discarding is a status);
- once a message is sent, and for a reply from the moment it is noted, its wording, its patient and the
  number it went to never change.

SQLite gets these from here after every migrate; PostgreSQL gets them from messaging migration 0002.
`messaging/tests/test_guards.py` checks both.
"""

FROZEN_MESSAGE = "A sent message cannot be changed"
KEPT_MESSAGE = "A message is never deleted"

# Migration 0002 lists the same columns for PostgreSQL.
FROZEN = ["clinic_id", "patient_id", "kind", "title", "body", "to_number", "sent_at", "sent_by_id"]


def sqlite_statements(existing):
    if "messaging_message" not in existing:
        return
    changed = " OR ".join(f"NEW.{column} IS NOT OLD.{column}" for column in FROZEN)
    yield (
        "CREATE TRIGGER IF NOT EXISTS guard_message_frozen BEFORE UPDATE ON messaging_message "
        f"WHEN (OLD.sent_at IS NOT NULL OR OLD.source = 'reply') AND ({changed}) "
        f"BEGIN SELECT RAISE(ABORT, '{FROZEN_MESSAGE}'); END"
    )
    yield (
        "CREATE TRIGGER IF NOT EXISTS guard_message_kept BEFORE DELETE ON messaging_message "
        f"BEGIN SELECT RAISE(ABORT, '{KEPT_MESSAGE}'); END"
    )
