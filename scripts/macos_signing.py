#!/usr/bin/env python3
"""One stable signing identity for native packages and updates to their resources."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile


DEFAULT_IDENTITY = 'Achbit Local Development'
IDENTITY_ENV = 'ACHBIT_MACOS_SIGN_IDENTITY'


def signing_identity():
    selected = os.environ.get(IDENTITY_ENV, DEFAULT_IDENTITY).strip()
    if not selected or selected == '-':
        raise ValueError('macOS packages require a persistent code-signing identity; ad-hoc signing cannot retain permissions.')
    result = subprocess.run(['security', 'find-identity', '-v', '-p', 'codesigning'],
                            check=True, stdout=subprocess.PIPE, text=True)
    identities = re.findall(r'^\s*\d+\) ([0-9A-Fa-f]{40}) "([^"]+)"', result.stdout, re.MULTILINE)
    matches = {fingerprint.upper() for fingerprint, name in identities
               if selected == name or selected.upper() == fingerprint.upper()}
    if len(matches) != 1:
        raise ValueError(f'Expected one usable signing identity for {selected!r}, found {len(matches)}. '
                         f'Run bash scripts/setup-macos-signing.sh on the Mac, or set {IDENTITY_ENV} '
                         'to an existing certificate fingerprint.')
    return matches.pop()


def check_private_key_access(identity):
    """Identity enumeration can succeed while the login session cannot use its private key."""
    with tempfile.TemporaryDirectory(prefix='achbit-signing-check-') as directory:
        probe = Path(directory) / 'signing-probe'
        shutil.copyfile('/usr/bin/true', probe)
        subprocess.run(['codesign', '--force', '--sign', identity, str(probe)], check=True)
        subprocess.run(['codesign', '--verify', '--strict', str(probe)], check=True)


def require_same_identity(app, identity):
    """An in-place product update must not silently switch the existing app's signer."""
    with tempfile.TemporaryDirectory(prefix='achbit-signing-') as directory:
        prefix = Path(directory) / 'certificate-'
        subprocess.run(['codesign', '--display', f'--extract-certificates={prefix}', str(app)],
                       check=True)
        leaf = Path(str(prefix) + '0')
        if not leaf.is_file() or hashlib.sha1(leaf.read_bytes()).hexdigest().upper() != identity:
            raise ValueError('The installed App uses a different signing identity. '
                             'Use explicit full macOS packaging to change signing identities.')


def sign_app(app, identity, *, native_components=False):
    if native_components:
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        for binary in sorted((app / 'Contents/MacOS').iterdir()):
            if binary.name != info['CFBundleExecutable']:
                subprocess.run(['codesign', '--force', '--sign', identity, '--identifier',
                                f"{info['CFBundleIdentifier']}.{binary.name}", str(binary)], check=True)
        # Bundled Node retains its vendor signature and runtime entitlements.
    subprocess.run(['codesign', '--force', '--sign', identity, str(app)], check=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-private-key', action='store_true',
                        help='Sign and verify a temporary program before starting a native build.')
    args = parser.parse_args()
    try:
        identity = signing_identity()
        if args.check_private_key:
            check_private_key_access(identity)
        print(identity)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'macOS signing preflight failed: {error}\n'
                         'The signing identity was not replaced. Check the current macOS keychain/private-key access before retrying.')
