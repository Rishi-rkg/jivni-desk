"""DocHP as one program on the clinic's own computer.

    python launcher.py                 start the app and open it in the browser
    python launcher.py --no-browser    start without opening a browser
    python launcher.py --data-dir D:\\DocHP-Data --port 8765

It keeps everything in one data folder (database, stored files, logs), serves the application and its
screens together on this computer only (127.0.0.1), and makes the scheduled backups while it runs.
Starting it a second time just opens the browser on the copy that is already running.
"""

import argparse
import logging
import os
import secrets
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_NAME = "DocHP"
DEFAULT_PORT = 8765
BACKUP_CHECK_SECONDS = 300
log = logging.getLogger("dochp.launcher")


def default_data_dir():
    if os.environ.get("DOCHP_DATA_DIR"):
        return Path(os.environ["DOCHP_DATA_DIR"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / APP_NAME.lower()


def bundle_dir():
    """Where the program's own files are: beside this file, or inside the packaged application."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def frontend_dist():
    packaged = bundle_dir() / "frontend_dist"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parent.parent / "frontend" / "dist"


def secret_key(data_dir):
    """The signing secret for sessions, made once per installation. It is not the clinic's encryption key."""
    path = data_dir / "secret.key"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(64), encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
    return path.read_text(encoding="utf-8").strip()


def configure(data_dir, port):
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "files").mkdir(exist_ok=True)
    (data_dir / "logs").mkdir(exist_ok=True)
    os.environ.update(
        {
            "DJANGO_SETTINGS_MODULE": "config.settings",
            "DJANGO_SECRET_KEY": secret_key(data_dir),
            "DJANGO_DEBUG": "false",
            "DJANGO_HTTPS": "false",  # this computer only; see the bind address in serve()
            "DJANGO_SECURE_COOKIES": "false",
            "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
            "DJANGO_CSRF_TRUSTED_ORIGINS": f"http://127.0.0.1:{port},http://localhost:{port}",
            "DATA_PROTECTION_MODE": "development-only",
            "DATABASE_ENGINE": "sqlite",
            "DATABASE_PATH": str(data_dir / "clinic.sqlite3"),
            "PATIENT_STORAGE_ROOT": str(data_dir / "files"),
            "SERVE_FRONTEND": "true",
            "FRONTEND_DIST": str(frontend_dist()),
        }
    )
    handler = RotatingFileHandler(data_dir / "logs" / "app.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler])


def already_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/", timeout=2) as response:  # noqa: S310 - fixed local address
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def backup_loop(stop):
    """Make the scheduled backup whenever one is due. Failures are logged and tried again later."""
    from accounts.models import Clinic
    from vault import backup
    from vault.models import BackupRun

    while not stop.wait(BACKUP_CHECK_SECONDS):
        try:
            clinic = Clinic.objects.first()
            if clinic and backup.is_due(clinic):
                run = backup.run_backup(clinic, BackupRun.Kind.AUTOMATIC)
                log.info("Scheduled backup %s", "saved" if run.ok else "FAILED")
        except Exception as error:  # noqa: BLE001 - the loop must survive anything and never log record contents
            log.warning("Scheduled backup could not run: %s", type(error).__name__)
        finally:
            from django.db import connections

            connections.close_all()


def serve(port, open_browser, stop=None):
    import django
    from django.core.management import call_command

    django.setup()
    call_command("migrate", interactive=False, verbosity=0)
    from waitress import create_server

    from config.wsgi import application

    # 127.0.0.1 only: nothing on the network can reach the application.
    server = create_server(application, host="127.0.0.1", port=port, threads=8, ident=APP_NAME)
    stop = stop or threading.Event()
    threading.Thread(target=backup_loop, args=(stop,), daemon=True, name="backups").start()
    url = f"http://127.0.0.1:{port}/"
    log.info("%s is running at %s", APP_NAME, url)
    print(f"{APP_NAME} is running at {url}  (close this window or press Ctrl+C to stop)", flush=True)
    if open_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        server.run()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=f"Run {APP_NAME} on this computer.")
    parser.add_argument("--data-dir", type=Path, default=None, help="Folder for the database, stored files and logs.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DOCHP_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-browser", action="store_true")
    options = parser.parse_args(argv)
    if already_running(options.port):
        if not options.no_browser:
            webbrowser.open(f"http://127.0.0.1:{options.port}/")
        print(f"{APP_NAME} is already running.")
        return
    sys.path.insert(0, str(bundle_dir()))
    configure((options.data_dir or default_data_dir()).resolve(), options.port)
    serve(options.port, not options.no_browser)


if __name__ == "__main__":
    main()
