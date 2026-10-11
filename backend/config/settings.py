import os
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if len(SECRET_KEY) < 32:
    raise ImproperlyConfigured("Set DJANGO_SECRET_KEY to a locally generated secret of at least 32 characters.")
DEBUG = os.environ.get("DJANGO_DEBUG", "false").lower() == "true"
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",")
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "accounts",
    "records",
    "audit",
    "vault",
]
MIDDLEWARE = [
    "config.middleware.RequestIdMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "config.middleware.IdleTimeoutMiddleware",
    "vault.session.VaultMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "config.middleware.PrivateResponseMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
AUTH_USER_MODEL = "accounts.User"
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "clinic"),
        "USER": os.environ.get("POSTGRES_USER", "clinic"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
        "HOST": os.environ.get("POSTGRES_HOST", "db"),
        "PORT": os.environ.get("POSTGRES_PORT", "5432"),
        "CONN_MAX_AGE": 60,
    }
}
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
PASSWORD_HASHERS = ["django.contrib.auth.hashers.Argon2PasswordHasher", "django.contrib.auth.hashers.PBKDF2PasswordHasher"]
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
MEDIA_ROOT = Path(os.environ.get("PATIENT_STORAGE_ROOT", str(BASE_DIR / "media")))
STORAGES = {
    "default": {"BACKEND": os.environ.get("PATIENT_STORAGE_BACKEND", "django.core.files.storage.FileSystemStorage")},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
DATA_UPLOAD_MAX_MEMORY_SIZE = 6 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 1024 * 1024
CSRF_TRUSTED_ORIGINS = os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS") else []
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 8 * 60 * 60
SESSION_SAVE_EVERY_REQUEST = False
# Idle lock for shared clinic computers; the eight-hour limit above still applies.
SESSION_IDLE_SECONDS = max(60, int(os.environ.get("SESSION_IDLE_SECONDS", "900")))
SESSION_COOKIE_SECURE = os.environ.get("DJANGO_SECURE_COOKIES", "true").lower() == "true"
CSRF_COOKIE_SECURE = SESSION_COOKIE_SECURE
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["config.authentication.ClinicSessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 25,
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"user": "300/min"},
}
# Argon2id cost for sealing a clinic key under a password (RFC 9106, second recommended setting).
VAULT_KDF = {"time_cost": 3, "memory_cost": 64 * 1024, "parallelism": 4}
# Intentionally fail closed: an encrypted provider is a future implementation,
# not a flag that can falsely certify plaintext data as safe.
DATA_PROTECTION_MODE = os.environ.get("DATA_PROTECTION_MODE", "")
if DATA_PROTECTION_MODE != "development-only" or not DEBUG:
    raise ImproperlyConfigured(
        "Encrypted patient storage is not implemented. This MVP may run only with DEBUG=true and DATA_PROTECTION_MODE=development-only using synthetic data."
    )
