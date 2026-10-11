import os
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings

import launcher


class LauncherTests(SimpleTestCase):
    def test_data_folder_follows_each_system_convention_and_can_be_overridden(self):
        with mock.patch.dict(os.environ, {"JIVNI_DATA_DIR": "/somewhere/else"}):
            self.assertEqual(launcher.default_data_dir(), Path("/somewhere/else"))
        clean = {key: value for key, value in os.environ.items() if key not in {"JIVNI_DATA_DIR", "XDG_DATA_HOME"}}
        with mock.patch.dict(os.environ, clean, clear=True):
            with mock.patch.object(launcher.sys, "platform", "darwin"):
                self.assertEqual(launcher.default_data_dir(), Path.home() / "Library" / "Application Support" / "Jivni")
            with mock.patch.object(launcher.sys, "platform", "linux"):
                self.assertEqual(launcher.default_data_dir(), Path.home() / ".local" / "share" / "jivni")
            with mock.patch.object(launcher.sys, "platform", "win32"), mock.patch.dict(os.environ, {"LOCALAPPDATA": "C:/Local"}):
                self.assertEqual(launcher.default_data_dir(), Path("C:/Local") / "Jivni")

    def test_a_portable_copy_keeps_its_data_beside_the_program(self):
        folder = Path(tempfile.mkdtemp(prefix="jivni-launcher-test-")).resolve()
        clean = {key: value for key, value in os.environ.items() if key != "JIVNI_DATA_DIR"}
        with mock.patch.dict(os.environ, clean, clear=True), mock.patch.object(launcher.sys, "executable", str(folder / "Jivni.exe")):
            self.assertIsNone(launcher.portable_data_dir())  # running from source is never portable
            with mock.patch.object(launcher.sys, "frozen", True, create=True):
                self.assertIsNone(launcher.portable_data_dir())  # an installed copy has no marker
                (folder / "portable.txt").write_text("portable", encoding="utf-8")
                self.assertEqual(launcher.portable_data_dir(), folder / "Jivni-Data")
                self.assertEqual(launcher.default_data_dir(), folder / "Jivni-Data")

    def test_the_signing_secret_is_made_once_and_reused(self):
        folder = Path(tempfile.mkdtemp(prefix="jivni-launcher-test-"))
        first = launcher.secret_key(folder)
        self.assertGreaterEqual(len(first), 64)
        self.assertEqual(launcher.secret_key(folder), first)
        self.assertNotEqual(launcher.secret_key(Path(tempfile.mkdtemp(prefix="jivni-launcher-test-"))), first)

    def test_nothing_is_reported_running_on_an_unused_port(self):
        self.assertFalse(launcher.already_running(1))

    def test_configuration_keeps_everything_in_the_data_folder_and_on_this_computer(self):
        folder = Path(tempfile.mkdtemp(prefix="jivni-launcher-test-"))
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(launcher.logging, "basicConfig"):
            launcher.configure(folder, 8765)
            self.assertEqual(os.environ["DATABASE_ENGINE"], "sqlite")
            self.assertEqual(Path(os.environ["DATABASE_PATH"]).parent, folder)
            self.assertEqual(Path(os.environ["PATIENT_STORAGE_ROOT"]).parent, folder)
            self.assertEqual(os.environ["DJANGO_ALLOWED_HOSTS"], "127.0.0.1,localhost")
            self.assertEqual(os.environ["DJANGO_DEBUG"], "false")
            self.assertEqual(os.environ["DATA_PROTECTION_MODE"], "development-only")


def free_port():
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@override_settings(ALLOWED_HOSTS=["127.0.0.1"])
class ServerStartStopTests(SimpleTestCase):
    databases = {"default"}

    def test_the_application_can_be_started_stopped_and_started_again(self):
        server = launcher.Server(free_port())
        self.assertFalse(server.running)
        self.assertFalse(launcher.already_running(server.port))
        try:
            server.start()
            server.start()  # asking twice is harmless
            self.assertTrue(server.running)
            self.assertTrue(launcher.already_running(server.port))
            server.stop()
            self.assertFalse(server.running)
            self.assertFalse(launcher.already_running(server.port))
            server.stop()  # stopping twice is harmless
            server.start()
            self.assertTrue(launcher.already_running(server.port))
        finally:
            server.stop()
        self.assertEqual(server.url("settings"), f"http://127.0.0.1:{server.port}/settings")

    def test_it_listens_on_this_computer_only(self):
        import socket

        server = launcher.Server(free_port())
        try:
            server.start()
            address = server._server.socket.getsockname()[0]
            self.assertEqual(address, "127.0.0.1")
            other = [
                info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET) if not info[4][0].startswith("127.")
            ]
            for host in other[:1]:
                with socket.socket() as probe:
                    probe.settimeout(1)
                    self.assertNotEqual(probe.connect_ex((host, server.port)), 0)
        finally:
            server.stop()


class FakeTray:
    """Just enough of the tray library to inspect the menu without a desktop."""

    class Menu:
        SEPARATOR = "---"

        def __init__(self, *items):
            self.items = items

    class MenuItem:
        def __init__(self, text, action, default=False, enabled=True, visible=True):
            self.text, self.action, self.default, self.enabled, self.visible = text, action, default, enabled, visible

        def label(self):
            return self.text(self) if callable(self.text) else self.text

        def shown(self):
            return self.visible(self) if callable(self.visible) else self.visible

        def usable(self):
            return self.enabled(self) if callable(self.enabled) else self.enabled


class TrayMenuTests(SimpleTestCase):
    def setUp(self):
        self.server = mock.Mock(port=8765, running=True)
        self.notes, self.quit = [], mock.Mock()
        self.menu = launcher.tray_menu(FakeTray, self.server, Path("data"), self.notes.append, self.quit)
        self.items = {item.label(): item for item in self.menu.items if item != "---"}

    def labels(self):
        return [item.label() for item in self.menu.items if item != "---" and item.shown()]

    def test_menu_while_running(self):
        self.assertEqual(
            self.labels(),
            [
                "Open Jivni",
                "Open admin console",
                "Open backups",
                "Running on this computer (port 8765)",
                "Stop Jivni",
                "Restart Jivni",
                "Back up now",
                "Open data folder",
                "Open log",
                "Quit Jivni",
            ],
        )
        self.assertTrue(self.items["Open Jivni"].default)
        self.items["Open Jivni"].action()
        self.items["Open admin console"].action()
        self.items["Open backups"].action()
        self.assertEqual([call.args for call in self.server.open.call_args_list], [(), ("settings",), ("backups",)])

    def test_menu_while_stopped(self):
        self.server.running = False
        self.assertIn("Stopped", self.labels())
        self.assertIn("Start Jivni", self.labels())
        self.assertNotIn("Stop Jivni", self.labels())
        self.assertFalse(self.items["Open Jivni"].usable())
        self.assertFalse(self.items["Open admin console"].usable())

    def test_quit_goes_through_the_callback(self):
        self.items["Quit Jivni"].action()
        self.quit.assert_called_once_with()

    def test_back_up_now_reports_in_plain_words(self):
        with mock.patch.object(launcher, "run_backup_now", return_value="Backup saved to 1 of 1 places."):
            with mock.patch.object(launcher.threading, "Thread") as thread:
                self.items["Back up now"].action()
                thread.call_args.kwargs["target"]()
        self.assertEqual(self.notes, ["Backup saved to 1 of 1 places."])
