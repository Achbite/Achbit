#!/usr/bin/env python3
"""Canonical version updates and package consumers, using disposable Cargo workspaces."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import version


def write(root, relative, content):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def snapshot(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob('*') if path.is_file() and '__pycache__' not in path.parts}


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='achbit-version-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in ('ACHBIT_BUILD_KIND', 'ACHBIT_BUILD_VERSION')}
        write(self.root, 'Cargo.toml', '[workspace]\nmembers = ["crates/achbit-kernel-abi"]\n'
              'resolver = "2"\n\n[workspace.package] # Release version\nversion = "0.1.0"\n')
        write(self.root, 'crates/achbit-kernel-abi/Cargo.toml',
              '[package]\nname = "achbit-kernel-abi"\nversion.workspace = true\nedition = "2021"\n')
        write(self.root, 'crates/achbit-kernel-abi/src/lib.rs', '')
        write(self.root, version.GUI_MANIFEST,
              '[workspace]\n\n[package]\nname = "achbit-gui-tauri-shell"\nversion = "0.1.0"\nedition = "2021"\n'
              '\n[dependencies]\nachbit-kernel-abi = { path = "../../../crates/achbit-kernel-abi" }\n'
              'wry = { path = "../../../third-party/wry" }\n')
        write(self.root, version.GUI_MANIFEST.parent / 'src/lib.rs', '')
        write(self.root, 'third-party/wry/Cargo.toml',
              '[workspace]\n\n[package]\nname = "wry"\nversion = "9.8.7"\nedition = "2021"\n')
        write(self.root, 'third-party/wry/src/lib.rs', '')
        for relative in version.JSON_FILES:
            write(self.root, relative, json.dumps({'version': '0.1.0', 'dependencies': {'third-party': '9.8.7'}}, indent=2) + '\n')
        write(self.root, 'CITATION.cff', 'cff-version: 1.2.0\nversion: 0.1.0\n')
        write(self.root, 'HISTORY.md', 'Historical release 0.1.0\n')
        for name in ('version.py', 'package-updates.py'):
            write(self.root, 'scripts/' + name, (ROOT / 'scripts' / name).read_text())
        result = subprocess.run(['cargo', 'generate-lockfile', '--offline', '--manifest-path',
                                 str(self.root / version.GUI_MANIFEST)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def command(self, *args, script='version.py', env=None):
        return subprocess.run([sys.executable, '-B', str(self.root / 'scripts' / script), *args],
                              cwd=self.root, env=env or self.env, capture_output=True, text=True)

    def success(self, *args, **kwargs):
        result = self.command(*args, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def assert_mirrors(self, expected):
        self.assertIn(f'version = "{expected}"', (self.root / 'Cargo.toml').read_text())
        self.assertIn(f'version = "{expected}"', (self.root / version.GUI_MANIFEST).read_text())
        for relative in version.JSON_FILES:
            data = json.loads((self.root / relative).read_text())
            self.assertEqual(data['version'], expected, relative)
            self.assertEqual(data['dependencies'], {'third-party': '9.8.7'}, relative)
        self.assertIn(f'version: {expected}', (self.root / 'CITATION.cff').read_text())
        lock = (self.root / version.GUI_LOCK).read_text()
        for name in ('achbit-gui-tauri-shell', 'achbit-kernel-abi'):
            self.assertIn(f'name = "{name}"\nversion = "{expected}"', lock)
        self.assertIn('name = "wry"\nversion = "9.8.7"', lock)
        self.assertEqual((self.root / 'HISTORY.md').read_text(), 'Historical release 0.1.0\n')

    def test_set_updates_registered_versions_and_cargo_lock_only(self):
        self.success('set', '1.2.3-rc.1')
        self.assert_mirrors('1.2.3-rc.1')
        self.assertIn('consistent: 1.2.3-rc.1', self.success('check'))
        before = snapshot(self.root)
        self.success('set', '1.2.3-rc.1')
        self.success('sync')
        self.success('show')
        self.assertEqual(snapshot(self.root), before)

    def test_sync_reads_manually_changed_canonical_version(self):
        path = self.root / 'Cargo.toml'
        path.write_text(path.read_text().replace('"0.1.0"', '"2.0.0"'))
        self.assertEqual(self.success('show'), '2.0.0')
        self.success('sync')
        self.assert_mirrors('2.0.0')

    def test_check_reports_stale_mirrors_and_lock_without_writing(self):
        write(self.root, 'userspace/gui/package.json', '{"version": "0.0.9"}\n')
        path = self.root / version.GUI_LOCK
        path.write_text(path.read_text().replace('name = "achbit-kernel-abi"\nversion = "0.1.0"',
                                                'name = "achbit-kernel-abi"\nversion = "0.0.9"'))
        before = snapshot(self.root)
        result = self.command('check')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('userspace/gui/package.json', result.stderr)
        self.assertIn('achbit-kernel-abi', result.stderr)
        self.assertEqual(snapshot(self.root), before)

    def test_invalid_version_and_missing_field_fail_before_writes(self):
        before = snapshot(self.root)
        for invalid in ('v1.2.3', '1.2', '1.02.3', '1.2.3-01', ''):
            with self.subTest(invalid=invalid):
                result = self.command('set', invalid)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(snapshot(self.root), before)
        write(self.root, 'CITATION.cff', 'cff-version: 1.2.0\n')
        before = snapshot(self.root)
        result = self.command('set', '1.2.3')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('CITATION.cff', result.stderr)
        self.assertEqual(snapshot(self.root), before)

    def test_cargo_failure_is_visible_and_sync_can_finish_after_repair(self):
        write(self.root, 'tools/cargo', '#!/bin/sh\necho "fixture cargo failure" >&2\nexit 19\n')
        (self.root / 'tools/cargo').chmod(0o755)
        result = self.command('set', '1.2.3', env={**self.env, 'PATH': str(self.root / 'tools') + os.pathsep + self.env['PATH']})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fixture cargo failure', result.stderr)
        self.assertIn('19', result.stderr)
        self.assertNotIn('Version synchronized', result.stdout)
        self.assertNotEqual(self.command('check').returncode, 0)
        self.success('sync')
        self.assert_mirrors('1.2.3')

    def test_package_version_reads_cargo_and_preserves_debug_override(self):
        write(self.root, 'package.json', '{"version": "9.9.9"}\n')
        self.assertEqual(self.success('version', script='package-updates.py'), '0.1.0')
        self.assertEqual(json.loads(self.success('config', script='package-updates.py'))['version'], '0.1.0')
        debug = {**self.env, 'ACHBIT_BUILD_KIND': 'debug', 'ACHBIT_BUILD_VERSION': '0.1.0-debug.1'}
        self.assertEqual(self.success('version', script='package-updates.py', env=debug), '0.1.0-debug.1')
        self.assertEqual(json.loads(self.success('config', script='package-updates.py', env=debug))['version'], '0.1.0-debug.1')
        result = self.command('version', script='package-updates.py',
                              env={**self.env, 'ACHBIT_BUILD_VERSION': '0.1.0-debug.1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('isolated Debug', result.stderr)
        with patch.dict(os.environ, self.env, clear=True):
            self.assertEqual(version.build_version(self.root), '0.1.0')

    def test_update_manifest_defaults_to_canonical_version_and_accepts_explicit_version(self):
        write(self.root, 'bin/app.tar.gz', 'fixture artifact')
        write(self.root, 'bin/app.tar.gz.sig', 'fixture signature')
        args = ('manifest', '--base-url', 'https://example.invalid/releases/0.1.0',
                '--artifact', 'darwin-aarch64=bin/app.tar.gz', '--output', 'bin/latest.json')
        self.success(*args, script='package-updates.py')
        manifest = json.loads((self.root / 'bin/latest.json').read_text())
        self.assertEqual(manifest['version'], '0.1.0')
        self.assertEqual(manifest['platforms']['darwin-aarch64'],
                         {'url': 'https://example.invalid/releases/0.1.0/app.tar.gz', 'signature': 'fixture signature'})
        self.success(*args, '--version', '0.1.0-debug.1', script='package-updates.py')
        self.assertEqual(json.loads((self.root / 'bin/latest.json').read_text())['version'], '0.1.0-debug.1')
        before = (self.root / 'bin/latest.json').read_bytes()
        result = self.command(*args, '--version', '', script='package-updates.py')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'bin/latest.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
