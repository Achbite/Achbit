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
        app = payload / 'Applications/Achbit.app'
        shutil.copytree(stage / 'Achbit.app', app, symlinks=True)
        commands = payload / '.local/bin'
        commands.mkdir(parents=True)
        for name, shell in [('achbit', 'cli'), ('achbit-cli', 'cli'), ('achbit-tui', 'tui')]:
            launcher = commands / name
            launcher.write_text('#!/bin/sh\n'
                'APP_DIR="$HOME/Applications/Achbit.app/Contents"\n'
                'export ACHBIT_RUNTIME_DIR="$APP_DIR/Resources"\n'
                'export ACHBIT_KERNEL_BIN="$APP_DIR/MacOS/achbit-kernel"\n'
                + ('exec "$APP_DIR/Resources/node/bin/node" "$APP_DIR/Resources/tui/window.mjs" "$@"\n'
                   if shell == 'tui' else f'exec "$APP_DIR/MacOS/achbit-{shell}" "$@"\n'))
            launcher.chmod(0o755)
        components = work / 'components.plist'
        components.write_bytes(plistlib.dumps([{
            'RootRelativeBundlePath': f'Applications/{name}',
            'BundleIsRelocatable': False,
            'BundleHasStrictIdentifier': True,
            'BundleOverwriteAction': 'upgrade',
        } for name in ['Achbit.app']]))
        component = work / 'Achbit.pkg'
        subprocess.run(['pkgbuild', '--root', str(payload), '--component-plist', str(components),
            '--identifier', 'com.achbite.achbit', '--version', version,
            '--install-location', '/', '--ownership', 'recommended', str(component)], check=True)
        distribution = work / 'Distribution.xml'
        distribution.write_text('''<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Achbit</title>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <choices-outline><line choice="achbit"/></choices-outline>
  <choice id="achbit" visible="false" title="Achbit"><pkg-ref id="com.achbite.achbit"/></choice>
  <pkg-ref id="com.achbite.achbit" version="''' + version + '''">Achbit.pkg</pkg-ref>
</installer-gui-script>
''')
        subprocess.run(['productbuild', '--distribution', str(distribution),
            '--package-path', str(work), str(output)], check=True)


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
            f'-DINSTALL_RUNTIME={Path(__file__).parent / "installers/install-runtime.ps1"}',
            str(Path(__file__).parent / 'installers/windows.nsi')], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=['macos-arm64', 'win64'])
    parser.add_argument('stage', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    resources = args.stage / 'Achbit.app/Contents/Resources' if args.platform == 'macos-arm64' else args.stage
    version = json.loads((resources / 'BUILDINFO.json').read_text())['version']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    (macos if args.platform == 'macos-arm64' else windows)(args.stage, args.output, version)


if __name__ == '__main__':
    main()
