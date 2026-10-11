import os
import tempfile
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase

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
