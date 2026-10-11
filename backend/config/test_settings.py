import os
import tempfile

os.environ.setdefault("DJANGO_SECRET_KEY", "synthetic-test-secret-never-use-outside-tests-123456")
os.environ.setdefault("DJANGO_DEBUG", "true")
os.environ.setdefault("DATA_PROTECTION_MODE", "development-only")
from .settings import *  # noqa: F403

if os.environ.get("TEST_DATABASE", "sqlite") == "sqlite":
    DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}
MEDIA_ROOT = tempfile.mkdtemp(prefix="clinic-tests-")
ALLOWED_HOSTS = ["testserver", "localhost"]
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
