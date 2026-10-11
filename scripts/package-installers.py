#!/usr/bin/env python3
"""Build installers from the same assembled runtime used by the archive."""
import argparse
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile


def macos(stage, output, version):
    with tempfile.TemporaryDirectory(prefix='pkg-', dir=output.parent) as directory:
        work = Path(directory)
        payload = work / 'payload'
        app = payload / 'Applications/DeepCode-GUI.app'
        shutil.copytree(stage / 'DeepCode-GUI.app', app, symlinks=True)
        shutil.copytree(stage / 'DeepCode Computer Use.app', payload / 'Applications/DeepCode Computer Use.app', symlinks=True)
        commands = payload / 'usr/local/bin'
        commands.mkdir(parents=True)
        for name, shell in [('deepcode', 'cli'), ('deepcode-cli', 'cli'), ('deepcode-tui', 'tui')]:
            launcher = commands / name
            launcher.write_text('#!/bin/sh\n'
                'APP_DIR="/Applications/DeepCode-GUI.app/Contents"\n'
                'export DEEPCODE_RUNTIME_DIR="$APP_DIR/Resources"\n'
                'export DEEPCODE_KERNEL_BIN="$APP_DIR/MacOS/deepcode-kernel"\n'
                f'exec "$APP_DIR/MacOS/deepcode-{shell}" "$@"\n')
            launcher.chmod(0o755)
        components = work / 'components.plist'
        components.write_bytes(plistlib.dumps([{
            'RootRelativeBundlePath': f'Applications/{name}',
            'BundleIsRelocatable': False,
            'BundleHasStrictIdentifier': True,
            'BundleOverwriteAction': 'upgrade',
        } for name in ['DeepCode-GUI.app', 'DeepCode Computer Use.app']]))
        subprocess.run(['pkgbuild', '--root', str(payload), '--component-plist', str(components),
            '--identifier', 'com.achbite.deepcode', '--version', version,
            '--install-location', '/', '--ownership', 'recommended', str(output)], check=True)


def windows(stage, output, version):
    with tempfile.TemporaryDirectory(prefix='nsis-', dir=output.parent) as directory:
        uninstall = Path(directory) / 'uninstall-files.nsh'
        lines = []
        for entry in sorted(stage.iterdir()):
            # Only installer-owned program entries; user data is outside this root.
            command = 'RMDir /r' if entry.is_dir() else 'Delete'
            lines.append(f'{command} "$INSTDIR\\{entry.name}"')
        uninstall.write_text('\n'.join(lines) + '\n')
        subprocess.run(['makensis', '-V2', f'-DSTAGE={stage.resolve()}',
            f'-DOUTPUT={output.resolve()}', f'-DVERSION={version}',
            f'-DUNINSTALL_FILES={uninstall}',
            str(Path(__file__).parent / 'installers/windows.nsi')], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=['macos-arm64', 'win64'])
    parser.add_argument('stage', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    resources = args.stage / 'DeepCode-GUI.app/Contents/Resources' if args.platform == 'macos-arm64' else args.stage
    version = json.loads((resources / 'BUILDINFO.json').read_text())['version']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    (macos if args.platform == 'macos-arm64' else windows)(args.stage, args.output, version)


if __name__ == '__main__':
    main()
