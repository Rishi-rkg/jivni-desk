"""Jivni as one program on the clinic's own computer.

    Jivni                      start the app, put its icon in the system tray, open the browser
    Jivni --no-browser         the same without opening a browser (used when starting with the computer)
    Jivni --no-tray            no tray icon: run until stopped (servers, Docker, automated tests)
    Jivni --data-dir D:\\Jivni-Data --port 8765

It keeps everything in one data folder (database, stored files, logs), serves the application and its
screens together on this computer only (127.0.0.1), and makes the scheduled backups while it runs.
The tray icon starts and stops the application, opens it, opens the admin console, and backs up on request.
Starting Jivni a second time just opens the browser on the copy that is already running.
"""

import argparse
import logging
import os
import secrets
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

APP_NAME = "Jivni"
VERSION = "0.2.0"
DEFAULT_PORT = 8765
BACKUP_CHECK_SECONDS = 300
log = logging.getLogger("jivni.launcher")


def say(message):
    """Print when there is a console; a windowed program has none."""
    if sys.stdout:
        print(message, flush=True)


def portable_data_dir():
    """A portable copy (one with portable.txt beside the program) keeps its data beside itself, for a USB drive."""
    if not getattr(sys, "frozen", False):
        return None
    program = Path(sys.executable).resolve().parent
    if sys.platform == "darwin" and program.name == "MacOS":
        program = program.parents[2]  # Jivni.app/Contents/MacOS -> the folder holding Jivni.app
    return program / "Jivni-Data" if (program / "portable.txt").is_file() else None


def default_data_dir():
    if os.environ.get("JIVNI_DATA_DIR"):
        return Path(os.environ["JIVNI_DATA_DIR"])
    if portable_data_dir():
        return portable_data_dir()
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


def knowledge_base():
    """The reference library shipped with the application."""
    packaged = bundle_dir() / "knowledge_base"
    return packaged if packaged.is_dir() else Path(__file__).resolve().parent.parent / "knowledge"


def icon_path():
    packaged = bundle_dir() / "icons" / "jivni-tray.png"
    return packaged if packaged.is_file() else Path(__file__).resolve().parent.parent / "packaging" / "icons" / "jivni-tray.png"


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
            "DJANGO_HTTPS": "false",  # this computer only; see the bind address in Server.start()
            "DJANGO_SECURE_COOKIES": "false",
            "DJANGO_ALLOWED_HOSTS": "127.0.0.1,localhost",
            "DJANGO_CSRF_TRUSTED_ORIGINS": f"http://127.0.0.1:{port},http://localhost:{port}",
            "DATA_PROTECTION_MODE": "development-only",
            "DATABASE_ENGINE": "sqlite",
            "DATABASE_PATH": str(data_dir / "clinic.sqlite3"),
            "PATIENT_STORAGE_ROOT": str(data_dir / "files"),
            "SERVE_FRONTEND": "true",
            "FRONTEND_DIST": str(frontend_dist()),
            "KNOWLEDGE_BASE_DIR": str(knowledge_base()),
            # What the clinic adds to the library, and what it has learned, stay with the clinic's data.
            "KNOWLEDGE_CLINIC_DIR": str(data_dir / "library"),
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


def open_path(path):
    """Show a folder or file with the system's own viewer."""
    if sys.platform == "win32":
        os.startfile(path)  # noqa: S606 - a path this program created
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])  # noqa: S603, S607


class Server:
    """The web application, which can be started and stopped any number of times while the program runs."""

    def __init__(self, port):
        self.port = port
        self._server = None
        self._thread = None
        self._lock = threading.Lock()

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def url(self, path=""):
        return f"http://127.0.0.1:{self.port}/{path}"

    def prepare(self):
        """Once per run: load the application and bring the database up to date."""
        import django
        from django.core.management import call_command

        django.setup()
        call_command("migrate", interactive=False, verbosity=0)

    def start(self):
        with self._lock:
            if self.running:
                return
            from waitress import create_server

            from config.wsgi import application

            # 127.0.0.1 only: nothing on the network can reach the application.
            self._server = create_server(application, host="127.0.0.1", port=self.port, threads=8, ident=APP_NAME)
            self._thread = threading.Thread(target=self._server.run, daemon=True, name="web")
            self._thread.start()
            log.info("%s is serving at %s", APP_NAME, self.url())

    def stop(self):
        with self._lock:
            if not self.running:
                return
            server = self._server
            for channel in list(server.active_channels.values()):
                channel.close()  # drop browsers that are still connected, so "stopped" means stopped
            server.close()  # stop listening; the serving loop notices within a second and ends
            self._thread.join(timeout=10)
            self._server = self._thread = None
            log.info("%s stopped serving", APP_NAME)

    def open(self, path=""):
        if self.running:
            webbrowser.open(self.url(path))


def run_backup_now(kind=None):
    """Returns a short sentence about what happened, safe to show in a notification."""
    from accounts.models import Clinic
    from vault import backup
    from vault.models import BackupRun

    clinic = Clinic.objects.first()
    if clinic is None:
        return "Set up the clinic first."
    try:
        run = backup.run_backup(clinic, kind or BackupRun.Kind.MANUAL)
    except backup.BackupError as error:
        return str(error)
    saved = sum(1 for place in run.places if place["ok"])
    return f"Backup saved to {saved} of {len(run.places)} places." if run.ok else "The backup could not be saved to any place."


def backup_loop(stop):
    """Make the scheduled backup whenever one is due. Failures are logged and tried again later."""
    from django.db import connections

    from accounts.models import Clinic
    from vault import backup
    from vault.models import BackupRun

    while not stop.wait(BACKUP_CHECK_SECONDS):
        try:
            clinic = Clinic.objects.first()
            if clinic and backup.is_due(clinic):
                run = backup.run_backup(clinic, BackupRun.Kind.AUTOMATIC)
                log.info("Scheduled backup %s", "saved" if run.ok else "FAILED")
        except Exception as error:  # the loop must survive anything and never log record contents
            log.warning("Scheduled backup could not run: %s", type(error).__name__)
        finally:
            connections.close_all()


def tray_menu(pystray, server, data_dir, notify, quit_app):
    """The menu behind the tray icon. Kept separate from the icon so it can be tested without a desktop."""

    def in_background(work):
        return lambda *_: threading.Thread(target=work, daemon=True).start()

    def restart():
        server.stop()
        server.start()

    def back_up():
        from django.db import connections

        try:
            notify(run_backup_now())
        finally:
            connections.close_all()

    def running(_item):
        return server.running

    def stopped(_item):
        return not server.running

    item, separator = pystray.MenuItem, pystray.Menu.SEPARATOR
    return pystray.Menu(
        item(f"Open {APP_NAME}", lambda *_: server.open(), default=True, enabled=running),
        item("Open admin console", lambda *_: server.open("settings"), enabled=running),
        item("Open backups", lambda *_: server.open("backups"), enabled=running),
        separator,
        item(lambda _item: f"Running on this computer (port {server.port})" if server.running else "Stopped", None, enabled=False),
        item(f"Start {APP_NAME}", in_background(server.start), visible=stopped),
        item(f"Stop {APP_NAME}", in_background(server.stop), visible=running),
        item(f"Restart {APP_NAME}", in_background(restart), visible=running),
        separator,
        item("Back up now", in_background(back_up)),
        item("Open data folder", lambda *_: open_path(data_dir)),
        item("Open log", lambda *_: open_path(data_dir / "logs" / "app.log")),
        separator,
        item(f"Quit {APP_NAME}", lambda *_: quit_app()),
    )


def run_with_tray(server, data_dir, open_browser, stop):
    """Returns False if this computer has no usable system tray, so the caller can run without one."""
    try:
        import pystray
        from PIL import Image

        image = Image.open(icon_path())
    except Exception as error:  # no desktop, or the tray library is unavailable on this system
        log.info("No system tray available (%s); running without one", type(error).__name__)
        return False

    icon = None

    def notify(message):
        try:
            icon.notify(message, APP_NAME)
        except Exception:  # notifications are a nicety; some desktops have none
            log.info("Notification: %s", message)

    def quit_app():
        stop.set()
        server.stop()
        icon.stop()

    icon = pystray.Icon(APP_NAME, image, APP_NAME, tray_menu(pystray, server, data_dir, notify, quit_app))

    def ready(tray):
        tray.visible = True
        server.start()
        if open_browser:
            server.open()

    icon.run(setup=ready)
    return True


def run_without_tray(server, open_browser, stop):
    server.start()
    say(f"{APP_NAME} is running at {server.url()}  (press Ctrl+C to stop)")
    if open_browser:
        threading.Timer(1.0, server.open).start()
    try:
        while not stop.wait(0.5):
            if not server.running:
                break
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.stop()


def report_fatal(error):
    log.exception("%s could not start", APP_NAME)
    message = f"{APP_NAME} could not start: {type(error).__name__}. See the log in the data folder."
    if sys.platform == "win32" and not sys.stdout:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, message, APP_NAME, 0x10)
    else:
        say(message)


def main(argv=None):
    parser = argparse.ArgumentParser(prog=APP_NAME, description=f"Run {APP_NAME} on this computer.")
    parser.add_argument("--data-dir", type=Path, default=None, help="Folder for the database, stored files and logs.")
    parser.add_argument("--port", type=int, default=int(os.environ.get("JIVNI_PORT", DEFAULT_PORT)))
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser on start.")
    parser.add_argument("--no-tray", action="store_true", help="Run without a tray icon until stopped.")
    parser.add_argument("--version", action="version", version=f"{APP_NAME} {VERSION}")
    options = parser.parse_args(argv)
    if already_running(options.port):
        if not options.no_browser:
            webbrowser.open(f"http://127.0.0.1:{options.port}/")
        say(f"{APP_NAME} is already running.")
        return
    sys.path.insert(0, str(bundle_dir()))
    data_dir = (options.data_dir or default_data_dir()).resolve()
    configure(data_dir, options.port)
    server, stop = Server(options.port), threading.Event()
    try:
        server.prepare()
        threading.Thread(target=backup_loop, args=(stop,), daemon=True, name="backups").start()
        if options.no_tray or not run_with_tray(server, data_dir, not options.no_browser, stop):
            run_without_tray(server, not options.no_browser, stop)
    except Exception as error:  # last resort: tell the person instead of vanishing
        report_fatal(error)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
