"""Create a portable local publisher identity and sign Windows PE files."""
import argparse
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile


REPOSITORY = Path(__file__).resolve().parents[1]
CONTAINER_IDENTITY = Path('/run/secrets/achbit-windows-signing')
HOST_IDENTITY = Path.home() / '.config/achbit/windows-signing'
PROFILE_ENV = 'ACHBIT_WINDOWS_SIGNING_DIR'
PFX = 'publisher.pfx'
PASSWORD = 'password'
CERTIFICATE = 'publisher.crt'


def external_directory(directory):
    resolved = directory.expanduser().resolve()
    if resolved == REPOSITORY or REPOSITORY in resolved.parents:
        raise ValueError(f'Keep the Windows signing identity outside the checkout: {resolved}')
    return resolved


def check_files(directory):
    for name in (PFX, PASSWORD, CERTIFICATE):
        if not (directory / name).is_file():
            raise ValueError(f'Missing Windows signing file: {directory / name}. '
                             'Restore the existing profile, or run windows_signing.py init on the first host.')


def configured_directory(default):
    configured = os.environ.get(PROFILE_ENV)
    if configured == '':
        raise ValueError(f'{PROFILE_ENV} must name a signing directory when set.')
    return default if configured is None else Path(configured)


def build_identity(required=False):
    directory = external_directory(configured_directory(CONTAINER_IDENTITY))
    if not required and PROFILE_ENV not in os.environ and not directory.exists():
        return None
    check_files(directory)
    if not shutil.which('osslsigncode'):
        raise ValueError('Missing osslsigncode in the development container. Refresh it with make shell.')
    return directory


def run(command, stdin=subprocess.DEVNULL):
    result = subprocess.run(command, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        raise RuntimeError(f'{command[0]} {command[1]} failed ({result.returncode}):\n{result.stdout.rstrip()}')


def initialize(directory):
    directory = external_directory(directory)
    if directory.exists() and any(directory.iterdir()):
        check_files(directory)
    else:
        directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.achbit-signing-', dir=directory.parent) as temp:
            scratch = Path(temp)
            profile = scratch / 'profile'
            profile.mkdir(mode=0o700)
            password = profile / PASSWORD
            password.touch(mode=0o600)
            password.write_text(secrets.token_hex(32), encoding='ascii')
            config = scratch / 'openssl.cnf'
            config.write_text('[req]\nprompt=no\ndistinguished_name=publisher\nx509_extensions=signing\n'
                              '[publisher]\nCN=Achbit Local Development\n'
                              '[signing]\nbasicConstraints=critical,CA:FALSE\n'
                              'keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n'
                              'subjectKeyIdentifier=hash\n')
            key = scratch / 'key.pem'
            passfile = f'file:{password}'
            run(['openssl', 'req', '-new', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '1825',
                 '-config', config, '-keyout', key, '-passout', passfile, '-out', profile / CERTIFICATE])
            with password.open('rb') as pass_input:
                run(['openssl', 'pkcs12', '-export', '-inkey', key, '-in', profile / CERTIFICATE,
                     '-passin', 'stdin', '-passout', passfile, '-keypbe', 'AES-256-CBC',
                     '-certpbe', 'AES-256-CBC', '-macalg', 'sha256', '-out', profile / PFX], stdin=pass_input)
            (profile / PFX).chmod(0o600)
            if directory.is_dir():
                directory.rmdir()  # Only an empty destination can be replaced.
            profile.rename(directory)
    print(f'Windows signing profile: {directory}', flush=True)
    subprocess.run(['openssl', 'x509', '-in', directory / CERTIFICATE, '-noout',
                    '-subject', '-fingerprint', '-sha256'], check=True)


def sign(path, directory):
    with tempfile.TemporaryDirectory(prefix='.authenticode-', dir=path.parent) as temp:
        signed = Path(temp) / 'signed.exe'
        command = ['osslsigncode', 'sign', '-pkcs12', directory / PFX, '-readpass', directory / PASSWORD,
                   '-h', 'sha256', '-n', 'Achbit']
        timestamp = os.environ.get('ACHBIT_WINDOWS_TIMESTAMP_URL')
        if timestamp:
            command.extend(['-ts', timestamp])
        run([*command, '-in', path, '-out', signed])
        run(['osslsigncode', 'verify', '-CAfile', directory / CERTIFICATE, '-in', signed])
        shutil.copymode(path, signed)
        signed.replace(path)
    print(f'Authenticode signed and verified: {path.name}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    init = actions.add_parser('init', help='Create once on the first host, or show the existing identity.')
    init.add_argument('directory', type=Path, nargs='?')
    actions.add_parser('check', help='Check the signing profile and tool inside the build container.')
    signer = actions.add_parser('sign', help='Sign and verify a staged Windows executable in place.')
    signer.add_argument('path', type=Path)
    arguments = parser.parse_args()
    try:
        if arguments.action == 'init':
            initialize(arguments.directory or configured_directory(HOST_IDENTITY))
        else:
            identity = build_identity(required=True)
            if arguments.action == 'sign':
                sign(arguments.path, identity)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Windows signing: {error}\n')
