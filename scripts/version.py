#!/usr/bin/env python3
"""Read and synchronize the project version owned by Cargo.toml."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GUI_MANIFEST = Path('shells/achbit-gui/src-tauri/Cargo.toml')
GUI_LOCK = GUI_MANIFEST.with_name('Cargo.lock')
# Only release metadata belongs here; dependency and protocol versions have other owners.
JSON_FILES = (
    'package.json',
    'userspace/gui/package.json',
    'userspace/protocol/package.json',
    'userspace/session-core/package.json',
    'shells/achbit-gui/package.json',
    'plugins/chrome-devtools/package.json',
    'shells/achbit-gui/src-tauri/tauri.conf.json',
)
SEMVER = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'
                    r'(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?'
                    r'(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?')


def valid_version(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) else None
    if not match or (match[4] and any(part.isdigit() and len(part) > 1 and part[0] == '0'
                                    for part in match[4].split('.'))):
        raise ValueError(f'Expected a semantic version such as 1.2.3 or 1.2.3-rc.1, got {value!r}')
    return value


def field(text, pattern, label):
    matches = list(re.finditer(pattern, text, re.MULTILINE))
    if len(matches) != 1:
        raise ValueError(f'{label}: expected exactly one version field, found {len(matches)}')
    return matches[0]


def toml_version(text, section, label):
    # These manifests use one scalar version in a named table. Preserve their comments/layout.
    table = field(text, r'^\[' + re.escape(section) + r'\][ \t]*(?:#.*)?\n(?P<body>[\s\S]*?)(?=^\[|\Z)', label)
    value = field(table['body'], r'^version[ \t]*=[ \t]*["\'](?P<value>[^"\'\n]+)["\'][ \t]*(?:#.*)?$', label)
    start = table.start('body') + value.start('value')
    return value['value'], start, start + len(value['value'])


def project_version(root=ROOT):
    path = root / 'Cargo.toml'
    value, _, _ = toml_version(path.read_text(), 'workspace.package', str(path))
    return valid_version(value)


def build_version(root=ROOT):
    base = project_version(root)
    selected = valid_version(os.environ.get('ACHBIT_BUILD_VERSION', base))
    if selected != base and os.environ.get('ACHBIT_BUILD_KIND') != 'debug':
        raise ValueError('ACHBIT_BUILD_VERSION is only supported for isolated Debug builds.')
    return selected


def lock_versions(root):
    path = root / GUI_LOCK
    result = {}
    for block in re.split(r'^\[\[package\]\]\s*$', path.read_text(), flags=re.MULTILINE)[1:]:
        name = re.search(r'^name = "([^"]+)"', block, re.MULTILINE)
        if name and name[1].startswith('achbit-') and not re.search(r'^source\s*=', block, re.MULTILINE):
            version = field(block, r'^version = "(?P<value>[^"]+)"$', f'{path}: {name[1]}')
            result[name[1]] = version['value']
    if 'achbit-gui-tauri-shell' not in result:
        raise ValueError(f'{path}: missing local achbit-gui-tauri-shell package')
    return result


def plan(root, version):
    """Read and validate all mirrored fields before any file is written."""
    changes = {}
    for relative, section in [('Cargo.toml', 'workspace.package'), (GUI_MANIFEST, 'package')]:
        path = root / relative
        text = path.read_text()
        current, start, end = toml_version(text, section, str(path))
        valid_version(current)
        if current != version:
            changes[path] = text[:start] + version + text[end:]
    for relative in JSON_FILES:
        path = root / relative
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or 'version' not in data:
            raise ValueError(f'{path}: missing top-level version')
        valid_version(data['version'])
        if data['version'] != version:
            data['version'] = version
            changes[path] = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    path = root / 'CITATION.cff'
    text = path.read_text()
    match = field(text, r'^version:[ \t]*(?P<value>[^\s#]+)[ \t]*(?:#.*)?$', str(path))
    valid_version(match['value'])
    if match['value'] != version:
        changes[path] = text[:match.start('value')] + version + text[match.end('value'):]
    stale_lock = [name for name, value in lock_versions(root).items() if value != version]
    return changes, stale_lock


def check(root=ROOT):
    version = project_version(root)
    changes, stale_lock = plan(root, version)
    mismatches = [str(path.relative_to(root)) + ': version' for path in changes]
    mismatches += [f'{GUI_LOCK}: {name}' for name in stale_lock]
    if mismatches:
        raise ValueError(f'Version {version} is not synchronized:\n  ' + '\n  '.join(mismatches)
                         + '\nRun python3 scripts/version.py sync in the development container.')
    return version


def sync(root=ROOT, version=None):
    version = project_version(root) if version is None else valid_version(version)
    changes, stale_lock = plan(root, version)
    if stale_lock and not shutil.which('cargo'):
        raise ValueError('Cargo is required to synchronize the GUI lockfile; use the development container.')
    for path, text in changes.items():
        path.write_text(text)
        print(f'Updated {path.relative_to(root)}')
    if stale_lock:
        # Cargo owns dependency resolution; --workspace retains unrelated locked dependencies.
        subprocess.run(['cargo', 'update', '--workspace', '--offline', '--manifest-path', str(root / GUI_MANIFEST)],
                       cwd=root, check=True)
    check(root)
    print(f'Version synchronized: {version}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('show', 'sync', 'check'):
        commands.add_parser(name)
    commands.add_parser('set').add_argument('version')
    args = parser.parse_args()
    try:
        if args.command == 'show':
            print(project_version())
        elif args.command == 'check':
            print(f'Version consistent: {check()}')
        else:
            sync(version=args.version if args.command == 'set' else None)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Version update failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
