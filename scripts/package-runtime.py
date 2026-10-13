#!/usr/bin/env python3
"""Assemble runtime resources and publish owned program files, preserving user data."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile

from macos_signing import sign_app, signing_identity
from computer_use_package import assemble as assemble_computer_use, APP_NAME as COMPUTER_USE_APP

# The GUI Host resolves this name next to DeepCode-GUI.exe.
WINDOWS_COMPUTER_USE = 'DeepCode-Computer-Use.exe'


def copy_js_package(source, target):
    target.mkdir(parents=True)
    package = json.loads((source / 'package.json').read_text())
    runtime = {key: package[key] for key in ('name', 'version', 'license', 'type', 'main')}
    runtime['exports'] = {'.': './dist/index.js'}
    (target / 'package.json').write_text(json.dumps(runtime, indent=2) + '\n')
    for file in (source / 'dist').rglob('*.js'):
        destination = target / file.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(file, destination)


def shared(root, destination, dependency_list):
    copy_js_package(root / 'userspace/session-core', destination / 'session-core')
    copy_js_package(root / 'userspace/protocol', destination / 'node_modules/@deepcode/protocol')
    shutil.copytree(root / 'userspace/gui/dist-deepcode-gui', destination / 'web-deepcode-gui')
    shutil.copytree(root / 'docs', destination / 'docs')
    shutil.copy2(root / 'LICENSE', destination / 'LICENSE')
    # The upstream package bundles its runtime dependencies. Keep its public
    # entrypoint and licenses intact; no host npm installation or downloads.
    chrome = (root / 'plugins/chrome-devtools/node_modules/chrome-devtools-mcp').resolve()
    shutil.copytree(chrome, destination / 'chrome-devtools')
    dependencies = {}

    def collect(items):
        for item in items.values():
            if 'path' in item and 'version' in item:
                path = Path(item['path']).resolve()
                if (path / 'package.json').is_file():
                    dependencies[path] = json.loads((path / 'package.json').read_text())
            collect(item.get('dependencies', {}))

    for project in json.loads(dependency_list.read_text()):
        collect(project.get('dependencies', {}))
    notices = []
    for path, package in sorted(dependencies.items()):
        label = package['name'].replace('/', '_') + '@' + package['version']
        licenses = [file for file in path.iterdir() if file.is_file() and file.name.lower().startswith(('license', 'licence', 'copying', 'notice'))]
        for file in licenses:
            target = destination / 'licenses' / label / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
        notices.append({key: package[key] for key in ('name', 'version', 'license', 'homepage') if key in package})
    (destination / 'THIRD-PARTY.json').write_text(json.dumps(notices, ensure_ascii=False, indent=2) + '\n')


def assemble(args):
    root, stage = args.root, args.stage
    version = json.loads((root / 'package.json').read_text())['version']
    macos = args.platform == 'macos-arm64'
    windows = args.platform == 'win64'
    identity = signing_identity() if macos else None
    app = stage / 'DeepCode-GUI.app'
    binaries = app / 'Contents/MacOS' if macos else stage
    resources = app / 'Contents/Resources' if macos else stage
    binaries.mkdir(parents=True, exist_ok=True)
    shutil.copytree(args.shared, resources, dirs_exist_ok=True)
    suffix = '.exe' if windows else ''
    names = {'deepcode-kernel-daemon': 'deepcode-kernel', 'deepcode-first-party-provider': 'deepcode-first-party-provider', 'deepcode-host-web': 'deepcode-host-web', 'deepcode-cli': 'deepcode-cli', 'deepcode-tui': 'deepcode-tui', 'DeepCode-GUI': 'DeepCode-GUI'}
    if windows:
        # macOS ships the executor as a separately signed App; Windows uses a sibling program.
        names['DeepCode-Computer-Use'] = WINDOWS_COMPUTER_USE.removesuffix('.exe')
    for source, target in names.items():
        destination = binaries / (target + suffix)
        if windows:
            # Avoid strip's in-place copy-back on Windows-mounted staging directories.
            subprocess.run(['x86_64-w64-mingw32-strip', '--strip-unneeded', '-o', str(destination), str(args.native / (source + suffix))], check=True)
        else:
            shutil.copy2(args.native / (source + suffix), destination)
            subprocess.run(['strip', '-x' if macos else '--strip-unneeded', str(destination)], check=True)
    node = resources / 'node/bin' / ('node.exe' if windows else 'node')
    node.parent.mkdir(parents=True)
    shutil.copy2(args.node, node)
    shutil.copy2(args.node_license, node.parent.parent / 'LICENSE')
    if args.platform.startswith('linux-'):
        shutil.copy2(shutil.which('bwrap'), binaries / 'bwrap')
    if windows:
        (stage / 'libexec').mkdir()
        shutil.copy2(root / 'scripts/installers/windows-environment.ps1', stage / 'libexec/windows-environment.ps1')
        (stage / 'deepcode.cmd').write_text('@echo off\ncall "%~dp0deepcode-cli.bat" %*\nexit /b %errorlevel%\n')
        shutil.copy2(args.webview_loader, binaries / 'WebView2Loader.dll')
        for shell in ('cli', 'tui'):
            launcher = stage / f'deepcode-{shell}.bat'
            launcher.write_text('@echo off\nsetlocal\nset "DEEPCODE_RUNTIME_DIR=%~dp0"\nset "DEEPCODE_KERNEL_BIN=%~dp0deepcode-kernel.exe"\n"%~dp0deepcode-' + shell + '.exe" %*\nexit /b %errorlevel%\n')
    metadata = {'version': version, 'platform': args.platform, 'sourceCommit': os.environ.get('DEEPCODE_BUILD_COMMIT', 'unknown'), 'builtAt': os.environ['DEEPCODE_BUILD_TIME']}
    (resources / 'BUILDINFO.json').write_text(json.dumps(metadata, indent=2) + '\n')
    if macos:
        info = {'CFBundleDevelopmentRegion': 'en', 'CFBundleDisplayName': 'DeepCode-GUI', 'CFBundleExecutable': 'DeepCode-GUI', 'CFBundleIdentifier': 'com.achbite.deepcode.gui', 'CFBundleInfoDictionaryVersion': '6.0', 'CFBundleName': 'DeepCode-GUI', 'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': version, 'CFBundleVersion': version, 'LSMinimumSystemVersion': '12.0', 'NSHighResolutionCapable': True, 'NSPrincipalClass': 'NSApplication'}
        (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        for shell in ('CLI', 'TUI'):
            launcher = stage / f'DeepCode-{shell}.command'
            launcher.write_text('''#!/usr/bin/env bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_DIR="$PACKAGE_DIR/DeepCode-GUI.app/Contents"
export DEEPCODE_RUNTIME_DIR="$APP_DIR/Resources"
export DEEPCODE_KERNEL_BIN="$APP_DIR/MacOS/deepcode-kernel"
exec "$APP_DIR/MacOS/deepcode-''' + shell.lower() + '''" "$@"
''')
            launcher.chmod(0o755)
        sign_app(app, identity, native_components=True)
        assemble_computer_use(root, args.native, stage, identity)
    documentation = 'DeepCode-GUI.app/Contents/Resources/docs/' if macos else 'docs/'
    (stage / 'README.md').write_text((root / 'docs/distribution.md').read_text().replace('(product/', '(' + documentation + 'product/'))


# Only program entries belong to the publisher. config/runtime/logs/sessions and
# other user-created entries are never copied, removed or put into the archive.
PROGRAM_ENTRIES = {
    COMPUTER_USE_APP, WINDOWS_COMPUTER_USE,
    'DeepCode.app', 'DeepCode-GUI.app', 'DeepCode', 'DeepCode.exe', 'DeepCode-GUI', 'DeepCode-GUI.exe',
    'DeepCode-CLI.command', 'DeepCode-TUI.command', 'deepcode', 'libexec',
    'deepcode-cli.bat', 'deepcode-tui.bat', 'deepcode.cmd',
    'deepcode-kernel', 'deepcode-kernel.exe', 'deepcode-first-party-provider', 'deepcode-first-party-provider.exe',
    'deepcode-host-web', 'deepcode-host-web.exe', 'deepcode-cli', 'deepcode-cli.exe', 'deepcode-tui', 'deepcode-tui.exe',
    'node', 'node_modules', 'session-core', 'web', 'web-deepcode-gui', 'bwrap', 'WebView2Loader.dll',
    'BUILDINFO.json', 'build-info.json', 'build-info.txt', 'README.md', 'README.txt', 'LICENSE', 'licenses', 'THIRD-PARTY.json', 'docs',
}


def publish(stage, destination, archive, installer=None):
    destination.mkdir(parents=True, exist_ok=True)
    # Windows locks mapped images. Detect this before replacing any entries.
    if destination.name == 'win64':
        for file in [*destination.glob('*.exe'), *destination.glob('*.dll'), destination / 'node/bin/node.exe']:
            if file.is_file():
                with file.open('r+b'):
                    pass
    temporary = Path(tempfile.mkdtemp(prefix='.publish-', dir=destination.parent))
    previous = temporary / 'previous'
    previous.mkdir()
    published = False
    try:
        packaged = temporary / archive.name
        if archive.suffix == '.zip':
            with zipfile.ZipFile(packaged, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
                for file in sorted(stage.rglob('*')):
                    if file.is_file():
                        output.write(file, str(Path(destination.name) / file.relative_to(stage)))
        else:
            with tarfile.open(packaged, 'w:gz', compresslevel=6) as output:
                output.add(stage, arcname=destination.name)
        artifacts = [(packaged, archive)]
        if installer is not None:
            artifacts.append((installer, destination.parent / installer.name))
        previous_artifacts = temporary / 'artifacts'
        previous_artifacts.mkdir()
        moved_artifacts, installed_artifacts = [], []
        moved, installed = [], []
        try:
            for name in sorted(PROGRAM_ENTRIES | {entry.name for entry in stage.iterdir()}):
                target = destination / name
                if target.exists() or target.is_symlink():
                    target.rename(previous / name)
                    moved.append(name)
            for entry in stage.iterdir():
                entry.rename(destination / entry.name)
                installed.append(entry.name)
            for source, target in artifacts:
                if target.exists():
                    target.rename(previous_artifacts / target.name)
                    moved_artifacts.append(target)
                source.replace(target)
                installed_artifacts.append(target)
            published = True
        except BaseException:
            for target in reversed(installed_artifacts):
                target.unlink()
            for target in reversed(moved_artifacts):
                (previous_artifacts / target.name).rename(target)
            for name in reversed(installed):
                (destination / name).rename(stage / name)
            for name in reversed(moved):
                (previous / name).rename(destination / name)
            raise
    finally:
        if published or not any(previous.iterdir()):
            shutil.rmtree(temporary)
        else:
            print(f'Original program files retained at {previous}', file=sys.stderr)
    print(f'Published {destination}\nArchive {archive} ({archive.stat().st_size:,} bytes)')
    if installer is not None:
        print(f'Installer {destination.parent / installer.name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    common = sub.add_parser('shared')
    common.add_argument('root', type=Path)
    common.add_argument('destination', type=Path)
    common.add_argument('dependency_list', type=Path)
    assembly = sub.add_parser('assemble')
    for name in ('root', 'stage', 'shared', 'native', 'node', 'node-license'):
        assembly.add_argument('--' + name, type=Path, required=True)
    assembly.add_argument('--platform', required=True)
    assembly.add_argument('--webview-loader', type=Path)
    publication = sub.add_parser('publish')
    for name in ('stage', 'destination', 'archive'):
        publication.add_argument(name, type=Path)
    publication.add_argument('--installer', type=Path)
    args = parser.parse_args()
    if args.action == 'shared':
        shared(args.root, args.destination, args.dependency_list)
    elif args.action == 'assemble':
        assemble(args)
    else:
        publish(args.stage, args.destination, args.archive, args.installer)


if __name__ == '__main__':
    main()
