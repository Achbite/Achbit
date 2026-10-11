"""The native plugin is a sibling App, so updating it does not reseal the GUI."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import tempfile

from macos_signing import require_same_identity, sign_app, signing_identity

APP_NAME = 'DeepCode Computer Use.app'


def assemble(root, native, destination, identity):
    app = destination / APP_NAME
    binaries = app / 'Contents/MacOS'
    resources = app / 'Contents/Resources'
    binaries.mkdir(parents=True)
    resources.mkdir()
    shutil.copy2(native / 'DeepCode-Computer-Use', binaries / 'DeepCode-Computer-Use')
    version = json.loads((root / 'package.json').read_text())['version']
    info = dict(CFBundleIdentifier='com.achbite.deepcode.computer-use', CFBundleExecutable='DeepCode-Computer-Use',
        CFBundleName='DeepCode Computer Use', CFBundleDisplayName='DeepCode Computer Use', CFBundlePackageType='APPL',
        CFBundleInfoDictionaryVersion='6.0', CFBundleVersion=version, CFBundleShortVersionString=version,
        LSMinimumSystemVersion='12.0', LSUIElement=True, NSHighResolutionCapable=True, NSPrincipalClass='NSApplication')
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
    args = parser.parse_args()
    update(Path(__file__).resolve().parents[1], args.native, args.output)
