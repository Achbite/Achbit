"""The native plugin is a sibling App, so updating it does not reseal the GUI."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import time

from macos_signing import require_same_identity, sign_app, signing_identity

APP_NAME = 'DeepCode Computer Use.app'
WINDOWS_EXECUTABLE = 'DeepCode-Computer-Use.exe'
# The GUI Host deletes these after it has retired the process that mapped them.
WINDOWS_RETIRED = WINDOWS_EXECUTABLE + '.retired-'


def update_windows(native, destination, strip='x86_64-w64-mingw32-strip'):
    """Replace the executor beside DeepCode-GUI.exe while the old one may still run.

    Windows cannot overwrite a mapped image but can rename it. The Host notices
    the new file between calls, retires the old process, then starts this one.
    """
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / WINDOWS_EXECUTABLE
    staged = destination / ('.' + WINDOWS_EXECUTABLE + '.new')
    staged.unlink(missing_ok=True)
    if strip and shutil.which(strip):
        subprocess.run([strip, '--strip-unneeded', '-o', str(staged), str(native)], check=True)
    else:
        shutil.copy2(native, staged)
    retired = None
    if target.exists():
        retired = destination / f'{WINDOWS_RETIRED}{time.time_ns()}'
        target.rename(retired)
    try:
        staged.rename(target)
    except OSError:
        if retired is not None:
            retired.rename(target)
        raise
    for previous in destination.glob(WINDOWS_RETIRED + '*'):
        if previous != retired:
            try:
                previous.unlink()
            except OSError:
                pass  # Still mapped by a running helper; the Host removes it later.
    print(f'Updated {target}. The GUI Host retires its old helper between calls; observe again after updating.')


def assemble(root, native, destination, identity):
    debug = os.environ.get('DEEPCODE_BUILD_KIND', 'normal') == 'debug'
    app = destination / ('DeepCode Debug Computer Use.app' if debug else APP_NAME)
    binaries = app / 'Contents/MacOS'
    resources = app / 'Contents/Resources'
    binaries.mkdir(parents=True)
    resources.mkdir()
    shutil.copy2(native / 'DeepCode-Computer-Use', binaries / 'DeepCode-Computer-Use')
    version = json.loads((root / 'package.json').read_text())['version']
    info = dict(CFBundleIdentifier='com.achbite.deepcode.computer-use', CFBundleExecutable='DeepCode-Computer-Use',
        CFBundleName='DeepCode Computer Use', CFBundleDisplayName='DeepCode Computer Use', CFBundlePackageType='APPL',
        CFBundleInfoDictionaryVersion='6.0', CFBundleVersion=version, CFBundleShortVersionString=version,
        LSMinimumSystemVersion='15.2', LSUIElement=True, NSHighResolutionCapable=True, NSPrincipalClass='NSApplication')
    if debug:
        info.update(CFBundleIdentifier='com.achbite.deepcode.debug.computer-use',
                    CFBundleName='DeepCode Debug Computer Use', CFBundleDisplayName='DeepCode Debug Computer Use')
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    shutil.copytree(root / 'plugins/computer-use/native/resources', resources, dirs_exist_ok=True)
    (resources / 'BUILDINFO.json').write_text(json.dumps(dict(version=version,
        sourceCommit=os.environ.get('DEEPCODE_BUILD_COMMIT'), builtAt=os.environ.get('DEEPCODE_BUILD_TIME')), indent=2)+'\n')
    sign_app(app, identity)
    return app


def update(root, native, destination):
    identity = signing_identity()
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / APP_NAME
    if target.exists():
        require_same_identity(target, identity)
    with tempfile.TemporaryDirectory(prefix='.computer-use-', dir=destination) as directory:
        scratch = Path(directory)
        app = assemble(root, native, scratch, identity)
        previous = scratch / 'previous.app'
        if target.exists(): target.rename(previous)
        try:
            app.rename(target)
        except OSError:
            if previous.exists(): previous.rename(target)
            raise
    print(f'Updated {target}. The GUI Host retires its old helper between calls; observe again after updating.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--windows', action='store_true', help='Update DeepCode-Computer-Use.exe in a win64 runtime.')
    args = parser.parse_args()
    if args.windows:
        update_windows(args.native / WINDOWS_EXECUTABLE, args.output)
    else:
        update(Path(__file__).resolve().parents[1], args.native, args.output)
