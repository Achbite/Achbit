#!/usr/bin/env python3
"""One stable signing identity for native packages and updates to their resources."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile


DEFAULT_IDENTITY = 'Achbit Local Development'
IDENTITY_ENV = 'ACHBIT_MACOS_SIGN_IDENTITY'
SIGNING_PROFILE = Path.home() / 'Library/Application Support/Achbit-build/macos-signing.json'


def signing_profile():
    """Optional Mac-host settings; neither this file nor its password enters Docker."""
    try:
        profile = json.loads(SIGNING_PROFILE.read_text())
    except FileNotFoundError:
        if os.path.lexists(SIGNING_PROFILE):
            raise
        return None
    if not isinstance(profile, dict) or any(
            not isinstance(profile.get(field), str) or not profile[field].strip()
            for field in ('identity', 'keychain', 'passwordFile')):
        raise ValueError(f'Invalid local signing profile: {SIGNING_PROFILE}')
    for field in ('keychain', 'passwordFile'):
        if not Path(profile[field]).expanduser().is_absolute():
            raise ValueError(f'Local signing {field} must be an absolute path')
    return profile


def security_command_input(arguments):
    """Encode one command for security's interactive parser, not a POSIX shell."""
    if any(character in value for value in arguments for character in ('\0', '\r', '\n')):
        raise ValueError('security interactive arguments must not contain NUL, CR or LF')
    return ' '.join('"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
                    for value in arguments) + '\n'


def prepare_signing_keychain(profile):
    if profile is None:
        return None
    keychain = Path(profile['keychain']).expanduser()
    password_file = Path(profile['passwordFile']).expanduser()
    info = password_file.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f'Signing password file must be owned by the current user with owner-only permissions (recommended mode 0600): {password_file}')
    password = password_file.read_text().removesuffix('\n')
    if not password or '\n' in password or '\r' in password:
        raise ValueError('Signing keychain password must be one nonempty line')
    # security's single-command interactive mode keeps the password off argv.
    # A failed unlock is final: do not continue through the login search list.
    result = subprocess.run(['security', '-i'],
                            input=security_command_input(['unlock-keychain', '-p', password, str(keychain)]),
                            text=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    if result.returncode:
        detail = result.stderr.strip().replace(password, '[redacted]')
        raise ValueError(f'Cannot unlock signing keychain {keychain} (exit {result.returncode}): {detail}')
    return str(keychain)


def codesign_keychain_args():
    keychain = prepare_signing_keychain(signing_profile())
    return ['--keychain', keychain] if keychain else []


def signing_identity():
    profile = signing_profile()
    selected = os.environ.get(IDENTITY_ENV, profile['identity'] if profile else DEFAULT_IDENTITY).strip()
    if not selected or selected == '-':
        raise ValueError('macOS packages require a persistent code-signing identity; ad-hoc signing cannot retain permissions.')
    keychain = prepare_signing_keychain(profile)
    result = subprocess.run(['security', 'find-identity', '-v', '-p', 'codesigning']
                            + ([keychain] if keychain else []),
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
        subprocess.run(['codesign', '--force', '--sign', identity, *codesign_keychain_args(), str(probe)], check=True)
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


@contextmanager
def app_update_lock(directory):
    # The directory inode persists across replacements by full builds and partial updates.
    import fcntl
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


@contextmanager
def staged_app_update(app):
    """Edit and verify a complete sibling bundle before touching the installed one."""
    with app_update_lock(app.parent):
        scratch = Path(tempfile.mkdtemp(prefix='.app-update-', dir=app.parent))
        staged, previous = scratch / app.name, scratch / 'previous.app'
        published = False
        try:
            if sys.platform == 'darwin':
                # APFS clones keep this inexpensive and preserve xattrs, ACLs and symlinks.
                subprocess.run(['/bin/cp', '-ac', str(app), str(staged)], check=True)
            else:
                shutil.copytree(app, staged, symlinks=True)
            yield staged
            if sys.platform == 'darwin':
                # renamex_np(RENAME_SWAP) atomically exchanges the two nonempty bundles.
                import ctypes
                import errno
                libc = ctypes.CDLL(None, use_errno=True)
                if libc.renamex_np(os.fsencode(staged), os.fsencode(app), 2) == 0:
                    published = True
                    return
                error = ctypes.get_errno()
                if error != errno.ENOTSUP:
                    raise OSError(error, os.strerror(error), str(app))
            # Filesystems lacking exchange can move the verified bundle into place.
            app.rename(previous)
            try:
                staged.rename(app)
            except BaseException:
                try:
                    previous.rename(app)
                except OSError as recovery_error:
                    print(f'Original App retained at {previous}: {recovery_error}', file=sys.stderr)
                raise
            published = True
        finally:
            if published or not previous.exists():
                shutil.rmtree(scratch)


def sign_app(app, identity, *, native_components=False):
    keychain_args = codesign_keychain_args()
    if native_components:
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        for binary in sorted((app / 'Contents/MacOS').iterdir()):
            if binary.name != info['CFBundleExecutable']:
                subprocess.run(['codesign', '--force', '--sign', identity, '--identifier',
                                f"{info['CFBundleIdentifier']}.{binary.name}", *keychain_args, str(binary)], check=True)
        # Bundled Node retains its vendor signature and runtime entitlements.
    subprocess.run(['codesign', '--force', '--sign', identity, *keychain_args, str(app)], check=True)
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
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f'macOS signing preflight failed: {error}\n'
                         'The signing identity was not replaced. Check the current macOS keychain/private-key access before retrying.')
