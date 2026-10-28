#!/usr/bin/env python3
"""Tauri updater artifacts and a static feed built from the existing assembled runtime."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]


def version():
    base = json.loads((ROOT / 'package.json').read_text())['version']
    selected = os.environ.get('ACHBIT_BUILD_VERSION', base)
    if selected != base and os.environ.get('ACHBIT_BUILD_KIND') != 'debug':
        raise ValueError('ACHBIT_BUILD_VERSION is only supported for isolated Debug builds.')
    return selected


def config():
    value = {'version': version()}
    if os.environ.get('ACHBIT_BUILD_KIND') == 'debug':
        value.update(productName='Achbit-Debug', identifier='com.achbite.achbit.debug',
                     plugins={'updater': {'dangerousInsecureTransportProtocol': True}})
    print(json.dumps(value))


def macos(app, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix='.tar.gz', delete=False) as file:
        temporary = Path(file.name)
    try:
        with tarfile.open(temporary, 'w:gz', compresslevel=6) as archive:
            archive.add(app, arcname=app.name)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f'Updater bundle {output}')


def linux(stage, output):
    with tempfile.TemporaryDirectory(prefix='appimage-', dir=output.parent) as temporary:
        appdir = Path(temporary) / 'Achbit.AppDir'
        binaries = appdir / 'usr/bin'
        shutil.copytree(stage, binaries, symlinks=True)
        (appdir / 'achbit.desktop').write_text('[Desktop Entry]\\nType=Application\\nName=Achbit\\nExec=Achbit\\nIcon=achbit\\nCategories=Development;\\n'.replace('\\n', '\n'))
        shutil.copy2(ROOT / 'shells/achbit-gui/src-tauri/icons/icon.png', appdir / 'achbit.png')
        launcher = appdir / 'AppRun'
        launcher.write_text("""#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export ACHBIT_RUNTIME_DIR="$root/usr/bin"
export ACHBIT_KERNEL_BIN="$root/usr/bin/achbit-kernel"
case "${1:-}" in
  --cli) shift; exec "$root/usr/bin/achbit-cli" "$@" ;;
  --tui) shift; exec "$root/usr/bin/achbit-tui" "$@" ;;
  *) exec "$root/usr/bin/Achbit" "$@" ;;
esac
""")
        launcher.chmod(0o755)
        subprocess.run(['appimagetool', '--no-appstream', str(appdir), str(output)], check=True)
    print(f'Updater AppImage {output}')


def sign(artifact):
    environment = os.environ.copy()
    if not environment.get('TAURI_SIGNING_PRIVATE_KEY'):
        key = Path(environment.get('TAURI_SIGNING_PRIVATE_KEY_PATH',
            str(Path.home() / 'Library/Application Support/Achbit-build/updater.key')))
        environment['TAURI_SIGNING_PRIVATE_KEY'] = key.read_text().strip()
    environment.setdefault('TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '')
    command = ['pnpm', '--filter', '@achbit/achbit-gui-shell', 'exec', 'tauri', 'signer', 'sign']
    if Path('/.dockerenv').exists():
        command.append(str(artifact.resolve()))
    else:
        relative = artifact.resolve().relative_to(ROOT)
        container = environment.get('CONTAINER_NAME', 'achbit-dev')
        mount = subprocess.check_output(['docker', 'inspect', '-f',
            '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}', container], text=True).strip()
        if Path(mount).resolve() != ROOT:
            raise ValueError('Signing container mounts another worktree.')
        command = ['docker', 'exec', '-e', 'TAURI_SIGNING_PRIVATE_KEY',
            '-e', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', '-w', '/workspace', container,
            *command, '/workspace/' + str(relative)]
    # Signer output may contain key setup hints; only print the public artifact path.
    result = subprocess.run(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        raise RuntimeError(f'Tauri signing failed for {artifact.name}: {result.stderr}')
    if not Path(str(artifact) + '.sig').is_file():
        raise RuntimeError('Tauri did not create the update signature.')
    print(f'Signed {artifact.name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('config')
    sub.add_parser('version')
    for name in ('macos', 'linux'):
        command = sub.add_parser(name)
        command.add_argument('source', type=Path)
        command.add_argument('output', type=Path)
    signing = sub.add_parser('sign')
    signing.add_argument('artifacts', type=Path, nargs='+')
    feed = sub.add_parser('manifest')
    feed.add_argument('--version', required=True)
    feed.add_argument('--base-url', required=True)
    feed.add_argument('--artifact', action='append', required=True, help='target=path')
    feed.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'version': print(version())
    elif args.command == 'config': config()
    elif args.command in ('macos', 'linux'): globals()[args.command](args.source, args.output)
    elif args.command == 'sign':
        for artifact in args.artifacts: sign(artifact)
    else:
        entries = {}
        for spec in args.artifact:
            target, path = spec.split('=', 1)
            artifact = Path(path)
            if target in entries: raise ValueError(f'Duplicate updater target: {target}')
            if not artifact.is_file(): raise FileNotFoundError(artifact)
            signature = Path(str(artifact) + '.sig').read_text().strip()
            if not signature: raise ValueError(f'Empty signature: {artifact}')
            entries[target] = {'url': args.base_url.rstrip('/') + '/' + quote(artifact.name),
                               'signature': signature}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'version': args.version, 'platforms': entries}, indent=2) + '\n')
        print(f'Update manifest {args.output}')


if __name__ == '__main__':
    main()
