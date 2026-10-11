"""Backend for browser end-to-end tests: a fresh database, one synthetic clinic, then the dev server.

Started by Playwright (frontend/playwright.config.ts). Locally it uses the project database from
scripts/dev_db.py; in CI it uses the PostgreSQL service named by the POSTGRES_* environment variables.
The generated sign-in is written to .tools/e2e-credentials.json, which git ignores.
"""
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dev_db  # noqa: E402

DATABASE = "clinic_e2e"
PORT = os.environ.get("E2E_BACKEND_PORT", "8010")
ORIGIN = os.environ.get("E2E_ORIGIN", "http://127.0.0.1:5183")


def main():
    if os.environ.get("POSTGRES_HOST"):
        env = dict(os.environ)
    else:
        local = dev_db.read_env()
        dev_db.start(local)
        env = dev_db.django_env(local)
    env.pop("TEST_DATABASE", None)
    env.update({
        "POSTGRES_DB": DATABASE,
        "DJANGO_DEBUG": "true",
        "DATA_PROTECTION_MODE": "development-only",
        "DJANGO_SECURE_COOKIES": "false",
        "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
        "DJANGO_CSRF_TRUSTED_ORIGINS": ORIGIN,
    })
    env.setdefault("DJANGO_SECRET_KEY", secrets.token_urlsafe(64))
    if len(env["DJANGO_SECRET_KEY"]) < 32:
        env["DJANGO_SECRET_KEY"] = secrets.token_urlsafe(64)

    import psycopg
    with psycopg.connect(host=env["POSTGRES_HOST"], port=env.get("POSTGRES_PORT", "5432"), user=env["POSTGRES_USER"],
                         password=env["POSTGRES_PASSWORD"], dbname="postgres", autocommit=True) as connection:
        connection.execute(f'DROP DATABASE IF EXISTS "{DATABASE}" WITH (FORCE)')
        connection.execute(f'CREATE DATABASE "{DATABASE}"')

    manage = [sys.executable, "manage.py"]
    backend = ROOT / "backend"
    subprocess.run([*manage, "migrate", "--noinput", "-v", "0"], cwd=backend, env=env, check=True)
    credentials = {"username": "e2e-owner", "password": secrets.token_urlsafe(18)}
    subprocess.run([*manage, "bootstrap_clinic", "--clinic", "Synthetic E2E Clinic", "--username", credentials["username"], "-v", "0"],
                   cwd=backend, env={**env, "BOOTSTRAP_PASSWORD": credentials["password"]}, check=True, stdout=subprocess.DEVNULL)
    target = ROOT / ".tools" / "e2e-credentials.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(credentials), encoding="utf-8")
    raise SystemExit(subprocess.run([*manage, "runserver", f"127.0.0.1:{PORT}", "--noreload"], cwd=backend, env=env).returncode)


if __name__ == "__main__":
    main()
