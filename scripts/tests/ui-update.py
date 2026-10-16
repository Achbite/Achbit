#!/usr/bin/env python3
"""Publish one GUI bundle through the real updater, preserving native files and user data."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "update-ui.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("ui_update", SCRIPT)
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


def write(root, name, content):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


def files(root):
    return {str(path.relative_to(root)): path.read_bytes() for path in root.rglob("*") if path.is_file()}


class UiUpdateTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="deepcode-ui-publish-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        identity = patch.object(updater, 'signing_identity', return_value='A' * 40)
        same_identity = patch.object(updater, 'require_same_identity')
        self.identity = identity.start()
        self.same_identity = same_identity.start()
        self.addCleanup(identity.stop)
        self.addCleanup(same_identity.stop)
        self.assets, self.package = self.root / "assets", self.root / "package"
        self.target = self.package / "web-deepcode-gui"
        write(self.assets, "index.html", b'<script type="module" src="assets/current.js"></script>')
        write(self.assets, "assets/current.js", b"new frontend")
        write(self.assets, "pdfjs/wasm/decoder.wasm", b"local renderer asset")
        write(self.target, "index.html", b"previous frontend")
        write(self.target, "assets/obsolete.js", b"old chunk")
        for name in ["deepcode-kernel", "session-core/dist/sessionServiceBridge.js", "config/user-settings.json", "data/agent-runtime/session.sqlite3"]:
            write(self.package, name, f"keep original {name}".encode())

    def test_command_replaces_complete_gui_and_retains_other_files(self):
        before = files(self.package)
        subprocess.run([sys.executable, str(SCRIPT), "--assets", str(self.assets), "--package", str(self.package)], check=True)
        self.assertEqual(files(self.target), files(self.assets))
        for name, content in before.items():
            if not name.startswith("web-deepcode-gui/"):
                self.assertEqual((self.package / name).read_bytes(), content)
        self.assertFalse((self.target / "assets/obsolete.js").exists())

    def test_incomplete_source_leaves_package_untouched(self):
        before = files(self.package)
        (self.assets / "index.html").unlink()
        with self.assertRaisesRegex(ValueError, "index.html"):
            updater.replace_ui(self.assets, self.target)
        self.assertEqual(files(self.package), before)

    def test_signing_failure_restores_app_resources(self):
        app = self.package / "DeepCode-GUI.app"
        target = app / "Contents/Resources/web-deepcode-gui"
        write(target, "index.html", b"previous app resources")
        before = files(app)
        with patch.object(updater, "sign_app", side_effect=[OSError("signing failed"), None]):
            with self.assertRaisesRegex(OSError, "signing failed"):
                updater.replace_ui(self.assets, target, app)
        self.assertEqual(files(app), before)
        self.assertFalse(any(self.package.glob(".ui-update-*")))

    def test_signing_preflight_failure_does_not_modify_the_app(self):
        app = self.package / 'DeepCode-GUI.app'
        target = app / 'Contents/Resources/web-deepcode-gui'
        write(target, 'index.html', b'previous app resources')
        before = files(app)
        for check in (self.identity, self.same_identity):
            with self.subTest(check=check):
                check.side_effect = ValueError('signing identity unavailable or changed')
                with self.assertRaisesRegex(ValueError, 'signing identity'):
                    updater.replace_ui(self.assets, target, app)
                self.assertEqual(files(app), before)
                self.assertFalse(any(self.package.glob('.ui-update-*')))
                check.side_effect = None

    def test_app_and_standalone_command_destinations(self):
        app = self.package / "DeepCode-GUI.app"
        target = app / "Contents/Resources/web-deepcode-gui"
        write(target, "index.html", b"previous app resources")
        for argument, destination in [("--package", app), ("--output", self.root / "standalone")]:
            with patch.object(sys, "argv", [str(SCRIPT), "--assets", str(self.assets), argument, str(destination)]), patch.object(updater, "sign_app"):
                self.assertEqual(updater.main(), 0)
            published = target if argument == "--package" else destination
            self.assertEqual(files(published), files(self.assets))


if __name__ == "__main__":
    unittest.main()
