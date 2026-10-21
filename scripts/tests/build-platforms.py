#!/usr/bin/env python3
"""Current build entrypoint and publisher behavior with disposable compiler outputs."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import macos_signing

spec = importlib.util.spec_from_file_location('package_runtime', ROOT / 'scripts/package-runtime.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
bridge_spec = importlib.util.spec_from_file_location('macos_bridge', ROOT / 'scripts/macos-build-bridge.py')
bridge = importlib.util.module_from_spec(bridge_spec)
bridge_spec.loader.exec_module(bridge)
installer_spec = importlib.util.spec_from_file_location('package_installers', ROOT / 'scripts/package-installers.py')
installers = importlib.util.module_from_spec(installer_spec)
installer_spec.loader.exec_module(installers)

# These commands stand in for native compilers/host availability only. The real
# build.sh owns target selection, shared preparation, error handling and cleanup.
STEP = r'''import json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
config=json.loads((root/'fixture.json').read_text())
args=sys.argv[1:]
mac=Path(__file__).name=='macos-build-bridge.py'
action=args[0]
platform='macos' if mac else args[1] if action in ('--check','--check-runtime','--runtime','--package') else None
with (root/'calls.jsonl').open('a') as log:
    log.write(json.dumps({'action':action,'platform':platform})+'\n')
if action in ('--check','check','--check-runtime','check-runtime'):
    sys.exit(config.get('check',{}).get(platform,0))
if action=='--shared':
    target=Path(args[1]);target.mkdir(parents=True)
    (target/'input.txt').write_text(config.get('content','current'))
elif action in ('--runtime','runtime','--package','package'):
    shared=Path(args[args.index('--shared')+1] if mac else args[2])
    output=Path(args[args.index('--output')+1] if mac else args[3])
    status=config.get('build',{}).get(platform,0)
    if mac and status==130:(shared.parent/'macos-request').write_text('owned-request')
    if status:sys.exit(status)
    output.mkdir(parents=True,exist_ok=True)
    (output/(platform+'.txt')).write_text((shared/'input.txt').read_text())
elif action=='cancel':
    shared=Path(args[args.index('--shared')+1])
    assert shared.is_dir(), 'shared assets disappeared before host cancellation'
    sys.exit(config.get('cancel',0))
'''


def write(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def files(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}


class ProgramCleanupTests(unittest.TestCase):
    def test_dry_run_reads_program_ownership_without_removing_files(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-clean-dry-run-') as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            for name in ('clean-caches.sh', 'package-runtime.py', 'macos_signing.py', 'computer_use_package.py'):
                shutil.copy2(ROOT / 'scripts' / name, root / 'scripts' / name)
            write(root, 'bin/macos-arm64/deepcode-cli', b'program')
            write(root, 'bin/macos-arm64/config/settings.json', b'user settings')
            before = files(root)

            result = subprocess.run(
                ['bash', str(root / 'scripts/clean-caches.sh'), '--dry-run', '--skip-docker', '--skip-local'],
                cwd=root, text=True, capture_output=True, timeout=10,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn(str(root / 'bin/macos-arm64/deepcode-cli'), result.stdout)
            self.assertNotIn('config/settings.json', result.stdout)
            self.assertEqual(files(root), before)


class SharedResourcesTests(unittest.TestCase):
    def test_only_public_documentation_enters_runtime_resources(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-shared-resources-') as directory:
            root = Path(directory) / 'source'
            destination = Path(directory) / 'resources'
            for name in ('session-core', 'protocol'):
                write(root, f'userspace/{name}/package.json', json.dumps({
                    'name': f'@deepcode/{name}', 'version': '0.0.0', 'license': 'MIT',
                    'type': 'module', 'main': './dist/index.js',
                }).encode())
                write(root, f'userspace/{name}/dist/index.js', b'export {};')
            write(root, 'userspace/session-core/dist/debug/sessionServiceBridge.js', b'DEBUG_ONLY')
            write(root, 'userspace/gui/dist-deepcode-gui/index.html', b'GUI')
            write(root, 'plugins/chrome-devtools/node_modules/chrome-devtools-mcp/index.js', b'upstream')
            write(root, 'LICENSE', b'license')
            write(root, 'dependencies.json', b'[]')
            public = {
                'distribution.md': b'Installation',
                'product/operations.md': b'User operations',
                'product/images/example.svg': b'<svg/>',
            }
            for name, content in public.items():
                write(root, f'docs/{name}', content)
            for name in ('task-receipts/local/TCR.md', 'architecture/draft.md', 'build.log'):
                write(root, f'docs/{name}', b'local internal material')

            package.shared(root, destination, root / 'dependencies.json')

            self.assertEqual(files(destination / 'docs'), public)
            self.assertEqual((destination / 'session-core/dist/index.js').read_bytes(), b'export {};')
            self.assertFalse((destination / 'session-core/dist/debug').exists())

    def test_debug_js_is_only_published_when_explicitly_selected(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-debug-modules-') as directory:
            root = Path(directory)
            write(root, 'package.json', json.dumps({'name': 'example', 'version': '1', 'license': 'MIT', 'type': 'module', 'main': 'dist/index.js'}).encode())
            write(root, 'dist/index.js', b'export {};')
            write(root, 'dist/debug/entry.js', b'DEBUG_ONLY')
            package.copy_js_package(root, root / 'normal')
            package.copy_js_package(root, root / 'debug', debug=True)
            self.assertFalse((root / 'normal/dist/debug/entry.js').exists())
            self.assertEqual((root / 'debug/dist/debug/entry.js').read_bytes(), b'DEBUG_ONLY')


class CodeCompilationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='deepcode-code-build-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        for name in ('build.sh', 'scripts/source-identity.sh', 'scripts/build-platforms.sh'):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, destination)
        (self.root / 'commands').mkdir()
        # Only compilers are replaced. The public entrypoint and internal build
        # script run unchanged, without any packaging scripts in the fixture.
        compiler = '#!' + sys.executable + '\n' + r'''import json,os,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
name=Path(__file__).name
args=sys.argv[1:]
with (root/'calls.jsonl').open('a') as log:
    log.write(json.dumps({'name':name,'args':args})+'\n')
if os.environ.get('FAIL_COMPILER')==name:
    sys.exit(47)
def emit(relative):
    path=root/relative
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text('compiled')
if name=='pnpm':
    if 'install' in args or 'typecheck' in args: pass
    elif 'build:userspace-shared' in args:
        for package in ('protocol','presentation-core','session-core'):
            emit('userspace/'+package+'/dist/index.js')
    elif 'build:web' in args: emit('userspace/gui/dist-deepcode-gui/index.html')
    else: sys.exit('Unexpected non-compilation command: '+str(args))
elif '--manifest-path' in args:
    emit('target/release/DeepCode-GUI')
elif '--workspace' in args:
    for binary in ('deepcode-kernel-daemon','deepcode-first-party-provider','deepcode-host-web','deepcode-cli','deepcode-tui'):
        emit('target/release/'+binary)
else: sys.exit('Expected workspace compilation: '+str(args))
'''
        for name in ('cargo', 'pnpm'):
            command = self.root / 'commands' / name
            command.write_text(compiler)
            command.chmod(0o755)
        self.environment = {
            **os.environ,
            'PATH': str(self.root / 'commands') + os.pathsep + os.environ['PATH'],
            'DEEPCODE_BUILD_COMMIT': 'fixture',
            'DEEPCODE_OUTPUT_DIR': str(self.root / 'bin'),
            'DEEPCODE_DISABLE_SCCACHE': '1',
            'CARGO_TARGET_DIR': str(self.root / 'target'),
            'PNPM_STORE_DIR': str(self.root / 'store'),
        }

    def build(self, *arguments):
        return subprocess.run(['bash', str(self.root / 'build.sh'), *arguments],
                              env=self.environment, text=True, capture_output=True, timeout=20)

    def test_explicit_code_compiles_without_touching_packages(self):
        write(self.root, 'bin/macos-arm64/running-product', b'existing macOS')
        write(self.root, 'bin/win64/running-product', b'existing Windows')
        write(self.root, 'bin/DeepCode-existing.zip', b'existing archive')
        before = files(self.root / 'bin')
        for arguments in (['--stage', 'code'],):
            with self.subTest(arguments=arguments):
                result = self.build(*arguments)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('packages=0 updated="code"', result.stdout)
                self.assertEqual(files(self.root / 'bin'), before)
                self.assertFalse((self.root / '.build-cache/build.lock').exists())
                for package_name in ('protocol', 'presentation-core', 'session-core'):
                    self.assertTrue((self.root / f'userspace/{package_name}/dist/index.js').is_file())
                self.assertTrue((self.root / 'userspace/gui/dist-deepcode-gui/index.html').is_file())
                for binary in ('deepcode-kernel-daemon', 'deepcode-first-party-provider', 'deepcode-host-web',
                               'deepcode-cli', 'deepcode-tui', 'DeepCode-GUI'):
                    self.assertTrue((self.root / 'target/release' / binary).is_file())
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any('--target' in call['args'] for call in calls))
        self.assertFalse(any('list' in call['args'] for call in calls))
        self.assertTrue(all('--release' in call['args'] for call in calls if call['name'] == 'cargo'))

    def test_compiler_failure_stops_build_and_releases_owned_resources(self):
        for compiler, stage in (('pnpm', 'shared'), ('cargo', 'code')):
            with self.subTest(compiler=compiler):
                self.environment['FAIL_COMPILER'] = compiler
                (self.root / 'calls.jsonl').unlink(missing_ok=True)
                result = self.build('--stage', 'code')
                self.assertEqual(result.returncode, 47, result.stdout + result.stderr)
                self.assertIn(f'[FAILED]== stage={stage} exit=47', result.stderr)
                self.assertNotIn('[build][DONE]', result.stdout)
                self.assertFalse((self.root / 'bin').exists())
                self.assertEqual(list((self.root / '.build-cache').iterdir()), [])
                calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
                self.assertEqual(sum(call['name'] == compiler for call in calls), 1)
                self.assertEqual(calls[-1]['name'], compiler)


class BuildTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='deepcode-build-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / 'scripts').mkdir()
        for name in ['build.sh', 'scripts/source-identity.sh']:
            shutil.copy2(ROOT / name, self.root / name)
        (self.root / 'scripts/step.py').write_text(STEP)
        (self.root / 'scripts/macos-build-bridge.py').write_text(STEP)
        (self.root / 'scripts/build-platforms.sh').write_text('#!/usr/bin/env bash\nexec python3 "$(dirname "$0")/step.py" "$@"\n')
        self.environment = {**os.environ, 'DEEPCODE_OUTPUT_DIR': str(self.root / 'output')}

    def build(self, config, *arguments):
        (self.root / 'fixture.json').write_text(json.dumps(config))
        return subprocess.run(['bash', str(self.root / 'build.sh'), *arguments], env=self.environment,
                              text=True, capture_output=True, timeout=20)

    def test_default_updates_only_the_development_host_runtime(self):
        self.environment.pop('WSL_DISTRO_NAME', None)
        for host, platform in (('Darwin', 'macos'), ('Windows_NT', 'windows'), ('Linux', 'linux')):
            self.environment['DEEPCODE_BUILD_HOST_OS'] = host
            for content in ('first', 'changed'):
                with self.subTest(host=host, content=content):
                    (self.root / 'calls.jsonl').write_text('')
                    result = self.build({'content': content})
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(f'runtimes=1 packages=0 updated="{platform}"', result.stdout)
                    self.assertEqual((self.root / f'output/{platform}.txt').read_text(), content)
                    calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
                    self.assertEqual([call['platform'] for call in calls if call['platform']], [platform, platform])
                    self.assertEqual(sum(call['action'] == '--shared' for call in calls), 1)
                    self.assertTrue(any(call['action'] in ('runtime', '--runtime') for call in calls))
                    self.assertFalse(any(call['action'] in ('package', '--package') for call in calls))
                    self.assertFalse((self.root / '.build-cache/build.lock').exists())

    def test_default_macos_runtime_does_not_fall_back_when_host_is_unavailable(self):
        self.environment['DEEPCODE_BUILD_HOST_OS'] = 'Darwin'
        result = self.build({'check': {'macos': 3}})
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual(calls, [{'action': 'check-runtime', 'platform': 'macos'}])
        self.assertFalse((self.root / 'output').exists())

    def test_debug_uses_available_windows_and_macos_and_preserves_normal_outputs(self):
        self.environment.pop('DEEPCODE_OUTPUT_DIR')
        write(self.root, 'bin/macos-arm64/running-product', b'unchanged')
        write(self.root, 'bin/win64/running-product', b'unchanged')
        result = self.build({'content': 'debug'}, '-debug')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / 'bin/debug/macos.txt').read_text(), 'debug')
        self.assertEqual((self.root / 'bin/debug/windows.txt').read_text(), 'debug')
        self.assertEqual((self.root / 'bin/macos-arm64/running-product').read_bytes(), b'unchanged')
        self.assertEqual((self.root / 'bin/win64/running-product').read_bytes(), b'unchanged')
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual([c['platform'] for c in calls if c['action'] == 'package'], ['macos'])
        self.assertEqual([c['platform'] for c in calls if c['action'] == '--package'], ['windows'])
        self.assertEqual(sum(c['action'] == '--shared' for c in calls), 1)

    def test_debug_windows_build_needs_no_macos_host(self):
        self.environment.pop('DEEPCODE_OUTPUT_DIR')
        result = self.build({'check': {'macos': 3}}, '-debug', '--stage', 'package-windows')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / 'bin/debug/windows.txt').is_file())
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any(c['platform'] in ('macos', 'linux') for c in calls))

    def test_debug_rejects_output_conflict_and_unsupported_stage(self):
        result = self.build({}, '-debug')
        self.assertEqual(result.returncode, 2)
        self.assertIn('fixed at bin/debug', result.stderr)
        self.environment.pop('DEEPCODE_OUTPUT_DIR')
        result = self.build({}, '-debug', '--stage', 'package-linux')
        self.assertEqual(result.returncode, 2)
        self.assertIn('not supported', result.stderr)
        self.assertFalse((self.root / 'calls.jsonl').exists())

    def test_shared_content_is_prepared_once_and_changes_reach_selected_targets(self):
        for content in ['first', 'changed']:
            (self.root / 'calls.jsonl').write_text('')
            result = self.build({'content': content}, '--stage', 'package-linux', '--stage', 'package-macos')
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual((self.root / 'output/linux.txt').read_text(), content)
            self.assertEqual((self.root / 'output/macos.txt').read_text(), content)
            self.assertFalse((self.root / 'output/windows.txt').exists())
            calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
            self.assertEqual(sum(call['action'] == '--shared' for call in calls), 1)
            self.assertFalse((self.root / '.build-cache/build.lock').exists())

    def test_absent_platforms_and_host_failures_remain_distinct(self):
        result = self.build({'check': {'macos': 3}}, '--stage', 'package')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.root / 'output/linux.txt').exists())
        self.assertFalse((self.root / 'output/macos.txt').exists())
        for config, arguments in [
            ({'check': {'linux': 1, 'windows': 1, 'macos': 3}}, ['--stage', 'package']),
            ({'check': {'windows': 1}}, ['--stage', 'package-windows']),
            ({'check': {'macos': 1}}, ['--stage', 'package']),
            ({'build': {'linux': 7}}, ['--stage', 'package-linux']),
        ]:
            with self.subTest(config=config):
                self.assertNotEqual(self.build(config, *arguments).returncode, 0)

    def test_explicit_full_package_prepares_shared_resources_once_for_all_platforms(self):
        result = self.build({'content': 'current'}, '--stage', 'package')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('packages=3 updated="linux windows macos"', result.stdout)
        for platform in ('linux', 'windows', 'macos'):
            self.assertEqual((self.root / f'output/{platform}.txt').read_text(), 'current')
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertEqual(sum(call['action'] == '--shared' for call in calls), 1)
        self.assertFalse(any(call['action'] in ('--compile-shared', '--native') for call in calls))

    def test_cancellation_releases_staging_only_after_host_acknowledges(self):
        result = self.build({'build': {'macos': 130}}, '--stage', 'package-macos')
        self.assertEqual(result.returncode, 130, result.stderr)
        self.assertFalse((self.root / '.build-cache/build.lock').exists())
        result = self.build({'build': {'macos': 130}, 'cancel': 1}, '--stage', 'package-macos')
        self.assertNotEqual(result.returncode, 0)
        lock = self.root / '.build-cache/build.lock'
        self.assertTrue(lock.is_dir())
        transaction = Path((lock / 'transaction').read_text().strip())
        self.assertTrue((transaction / 'shared/input.txt').is_file())


class WindowsDebugPackageTests(unittest.TestCase):
    def test_debug_and_normal_packages_have_distinct_executable_and_control_launcher(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-win-debug-') as directory:
            root = Path(directory)
            native, shared = root / 'native', root / 'shared'
            shared.mkdir()
            for name in ('deepcode-kernel-daemon', 'deepcode-first-party-provider', 'deepcode-host-web',
                         'deepcode-cli', 'deepcode-tui', 'DeepCode-GUI', 'DeepCode-Computer-Use'):
                write(native, name + '.exe', name.encode())
            for name in ('node.exe', 'LICENSE', 'WebView2Loader.dll'):
                write(root, name, name.encode())
            def strip(command, **kwargs):
                self.assertEqual(command[:3], ['x86_64-w64-mingw32-strip', '--strip-unneeded', '-o'])
                shutil.copy2(command[4], command[3])
            for kind in ('normal', 'debug'):
                stage = root / kind
                args = SimpleNamespace(root=ROOT, stage=stage, platform='win64', native=native, shared=shared,
                                       node=root / 'node.exe', node_license=root / 'LICENSE', webview_loader=root / 'WebView2Loader.dll')
                with patch.object(package.subprocess, 'run', side_effect=strip), patch.object(package, 'windows_tui_resources'), \
                        patch.dict(os.environ, {'DEEPCODE_BUILD_KIND': kind, 'DEEPCODE_BUILD_TIME': 'fixture'}):
                    package.assemble(args)
                debug = kind == 'debug'
                self.assertEqual((stage / 'DeepCode-Debug.exe').exists(), debug)
                self.assertEqual((stage / 'DeepCode-GUI.exe').exists(), not debug)
                self.assertEqual((stage / 'deepcode-debug.cmd').exists(), debug)
                self.assertEqual(json.loads((stage / 'BUILDINFO.json').read_text())['debugControl'], debug)
                if debug:
                    launcher = (stage / 'deepcode-debug.cmd').read_text()
                    self.assertIn('"%~dp0deepcode-cli.exe" debug %*', launcher)
                    self.assertIn('exit /b %errorlevel%', launcher)
                    self.assertIn('DeepCode-Debug.exe', package.PROGRAM_ENTRIES)
                    self.assertIn('deepcode-debug.cmd', package.PROGRAM_ENTRIES)


class NativeMacArgumentsTests(unittest.TestCase):
    def test_normal_and_debug_cargo_arguments_under_system_bash(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-macos-arguments-') as directory:
            root = Path(directory).resolve()
            (root / 'scripts').mkdir()
            (root / 'commands').mkdir()
            (root / 'shared').mkdir()
            shutil.copy2(ROOT / 'scripts/package-macos.sh', root / 'scripts/package-macos.sh')
            write(root, 'package.json', b'{"version":"0.0.0"}')
            write(root, 'NODE-LICENSE', b'fixture license')
            stub = ('#!' + sys.executable + '\n' + r'''import json,os,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
name=Path(__file__).name
with (root/'calls.jsonl').open('a') as log:
    log.write(json.dumps({'name':name,'argv':sys.argv[1:],'tauriConfig':os.environ.get('TAURI_CONFIG')})+'\n')
if name=='uname': print('Darwin' if sys.argv[1]=='-s' else 'arm64')
''')
            for name in ('cargo', 'node', 'uname', 'xcrun', 'codesign', 'strip', 'pkgbuild'):
                write(root, 'commands/' + name, stub.encode())
                (root / 'commands' / name).chmod(0o755)
            (root / 'commands/python3').symlink_to(sys.executable)
            for name in ('macos_signing.py', 'package-runtime.py', 'package-installers.py'):
                write(root, 'scripts/' + name, stub.encode())
            environment = {
                **os.environ,
                'PATH': str(root / 'commands') + os.pathsep + os.environ['PATH'],
                'DEEPCODE_MACOS_CARGO': str(root / 'commands/cargo'),
                'DEEPCODE_MACOS_NODE_BIN': str(root / 'commands/node'),
                'DEEPCODE_MACOS_NODE_LICENSE': str(root / 'NODE-LICENSE'),
                'DEEPCODE_MACOS_CARGO_TARGET_DIR': str(root / 'target'),
            }
            environment.pop('TAURI_CONFIG', None)
            packages = ['-p', 'deepcode-kernel-daemon', '-p', 'deepcode-first-party-tools',
                        '-p', 'deepcode-host-web', '-p', 'deepcode-cli', '-p', 'deepcode-tui',
                        '-p', 'deepcode-computer-use']
            for kind, options in (('normal', []), ('debug', []), ('normal', ['--runtime'])):
                with self.subTest(kind=kind, options=options):
                    (root / 'calls.jsonl').write_text('')
                    result = subprocess.run(
                        ['/bin/bash', str(root / 'scripts/package-macos.sh'), *options,
                         str(root / 'shared'), str(root / 'output')],
                        cwd=root, env={**environment, 'DEEPCODE_BUILD_KIND': kind},
                        text=True, capture_output=True, timeout=20,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    calls = [json.loads(line) for line in (root / 'calls.jsonl').read_text().splitlines()]
                    cargo = [call for call in calls if call['name'] == 'cargo']
                    features = ['--features', 'deepcode-kernel-daemon/debug-control,deepcode-cli/debug-control'] if kind == 'debug' else []
                    gui_features = ['--features', 'debug-control'] if kind == 'debug' else []
                    self.assertEqual([call['argv'] for call in cargo], [
                        ['build', '--release', *features, *packages],
                        ['build', '--release', *gui_features, '--manifest-path',
                         str(root / 'shells/deepcode-gui/src-tauri/Cargo.toml')],
                    ])
                    config = {'productName': 'DeepCode-Debug', 'identifier': 'com.achbite.deepcode.debug'} if kind == 'debug' else None
                    self.assertEqual([json.loads(call['tauriConfig']) if call['tauriConfig'] else None
                                      for call in cargo], [config, config])
                    publication = [call for call in calls if call['name'] == 'package-runtime.py' and call['argv'][0] == 'publish']
                    self.assertEqual(len(publication), 1)
                    if options:
                        self.assertEqual(len(publication[0]['argv']), 3)
                        self.assertFalse(any(call['name'] == 'package-installers.py' for call in calls))
                    else:
                        self.assertGreaterEqual(len(publication[0]['argv']), 4)


class BridgeCleanupTests(unittest.TestCase):
    def test_runtime_request_transfers_current_resources_and_completes_its_transaction(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-runtime-request-') as directory:
            root = Path(directory).resolve()
            shared = root / 'transaction/shared'
            shared.mkdir(parents=True)
            channel = root / 'bridge'
            channel.mkdir()
            worker = channel / 'worker.json'
            worker.write_text(json.dumps({'workerId': 'owned-worker'}))
            captured = []
            write_json = bridge.write_json

            def accept_request(path, value):
                write_json(path, value)
                if path.name == 'request.json':
                    captured.append(value)
                    self.assertEqual((shared.parent / 'macos-request').read_text(), path.parent.name)
                    bridge.finish(path.parent, value, 0)

            with patch.object(bridge, 'ROOT', root), patch.object(bridge, 'BRIDGE', channel), \
                    patch.object(bridge, 'WORKER', worker), \
                    patch.object(bridge, 'write_json', side_effect=accept_request), \
                    patch.dict(os.environ, {'DEEPCODE_BUILD_COMMIT': 'current-source', 'DEEPCODE_BUILD_TIME': 'current-time'}):
                self.assertEqual(bridge.request_host('runtime', shared, root / 'bin'), 0)
            request, = captured
            self.assertEqual(request['operation'], 'runtime')
            self.assertEqual(request['shared'], 'transaction/shared')
            self.assertEqual(request['output'], 'bin')
            self.assertEqual(request['commit'], 'current-source')
            self.assertEqual(request['builtAt'], 'current-time')
            self.assertFalse((shared.parent / 'macos-request').exists())

    def test_request_forwards_explicit_signing_selection(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-signing-request-') as directory:
            root = Path(directory)
            worker = root / 'worker.json'
            worker.write_text(json.dumps({'workerId': 'owned-worker'}))
            captured = []
            write_json = bridge.write_json

            def record_request(path, value):
                captured.append(value)
                write_json(path, value)
                write_json(path.parent / 'result.json', {'exitCode': 0, 'message': ''})

            with patch.object(bridge, 'BRIDGE', root), patch.object(bridge, 'WORKER', worker), \
                    patch.object(bridge, 'write_json', side_effect=record_request), \
                    patch.dict(os.environ, {'DEEPCODE_MACOS_SIGN_IDENTITY': 'selected-certificate'}):
                self.assertEqual(bridge.request_host('check'), 0)
            self.assertEqual(captured, [{'workerId': 'owned-worker', 'operation': 'check',
                                         'buildKind': 'normal',
                                         'signingIdentity': 'selected-certificate'}])

    def test_worker_publication_failure_releases_watcher(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-worker-') as directory:
            root = Path(directory)
            watcher = Mock()
            watcher.poll.return_value = None
            with patch.object(bridge, 'BRIDGE', root), \
                    patch.object(bridge, 'WORKER', root / 'worker.json'), \
                    patch.object(bridge.subprocess, 'Popen', return_value=watcher), \
                    patch.object(bridge.signal, 'signal'), \
                    patch.object(bridge, 'write_json', side_effect=OSError('worker publication failed')):
                with self.assertRaisesRegex(OSError, 'worker publication failed'):
                    bridge.serve('owned-container')
            watcher.terminate.assert_called_once()
            watcher.wait.assert_called_once()

    @unittest.skipUnless(sys.platform == 'linux', 'owned orphan reaping fixture requires Linux')
    def test_exited_leader_does_not_leave_descendant_holding_output(self):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        previous = ctypes.c_int()
        self.assertEqual(libc.prctl(37, ctypes.byref(previous), 0, 0, 0), 0)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        process = None
        descendant = None
        try:
            process = subprocess.Popen([
                sys.executable, '-c',
                "import os,signal,time\n"
                "pid=os.fork()\n"
                "if pid:\n print(pid,flush=True);os._exit(7)\n"
                "signal.signal(signal.SIGINT,signal.SIG_IGN)\n"
                "print('ready',flush=True)\n"
                "time.sleep(30)\n",
            ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            lines = [process.stdout.readline().strip() for _ in range(2)]
            self.assertIn('ready', lines)
            descendant = int(next(line for line in lines if line.isdigit()))
            self.assertEqual(process.wait(timeout=3), 7)
            bridge.stop_process(process)
            output, _ = process.communicate(timeout=3)
            self.assertEqual(output, '')
            self.assertEqual(process.returncode, 7)
            _, status = os.waitpid(descendant, 0)
            descendant = None
            self.assertEqual(os.waitstatus_to_exitcode(status), -signal.SIGKILL)
            with self.assertRaises(ProcessLookupError):
                os.killpg(process.pid, 0)
            bridge.stop_process(process)  # Already gone is a valid completion race.
        finally:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=3)
                process.stdout.close()
            if descendant is not None:
                os.waitpid(descendant, 0)
            self.assertEqual(libc.prctl(36, previous.value, 0, 0, 0), 0)

    def test_cleanup_failure_retains_transaction_and_original_failure(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-bridge-') as directory:
            root = Path(directory)
            transaction = root / 'transaction'
            transaction.mkdir()
            marker = transaction / 'macos-request'
            marker.write_text(root.name)
            child = Mock(pid=42)
            child.poll.return_value = 7
            log = Mock()
            with patch.object(bridge.os, 'killpg', side_effect=PermissionError('owned group permission denied')):
                with self.assertRaisesRegex(PermissionError, 'owned group permission denied'):
                    bridge.finish_process(root, {'transaction': str(transaction)}, child, log)
            self.assertTrue(marker.exists())
            result = json.loads((root / 'result.json').read_text())
            self.assertEqual(result['exitCode'], 7)
            self.assertIn('owned group permission denied', result['message'])
            log.close.assert_called_once()


class MacosSigningTests(unittest.TestCase):
    def test_command_launcher_reuses_its_terminal_and_preserves_arguments_and_exit(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-command-') as directory:
            root = Path(directory) / 'package with spaces'
            native, shared, stage = root / 'native', root / 'shared', root / 'stage'
            shared.mkdir(parents=True)
            stub = b"""#!/bin/sh
exec "$DEEPCODE_TEST_PYTHON" -c 'import json,sys; print(json.dumps(sys.argv[1:])); sys.exit(23)' "$@"
"""
            for name in ['deepcode-kernel-daemon', 'deepcode-first-party-provider', 'deepcode-host-web',
                         'deepcode-cli', 'deepcode-tui', 'DeepCode-GUI']:
                write(native, name, stub)
                (native / name).chmod(0o755)
            write(root, 'node', stub)
            (root / 'node').chmod(0o755)
            write(root, 'LICENSE', b'fixture')
            args = SimpleNamespace(root=ROOT, stage=stage, platform='macos-arm64', native=native,
                                   shared=shared, node=root / 'node', node_license=root / 'LICENSE')
            with patch.object(package, 'subprocess'), patch.object(package, 'signing_identity', return_value='fixture'), \
                    patch.object(package, 'sign_app'), patch.object(package, 'assemble_computer_use'), \
                    patch.object(package, 'macos_tui_resources'), patch.dict(os.environ, {'DEEPCODE_BUILD_TIME': 'fixture'}):
                package.assemble(args)
            arguments = ['--session', 'session:test', 'argument with spaces', 'literal "$HOME"', '']
            for shell in ('CLI', 'TUI'):
                result = subprocess.run(['bash', str(stage / f'DeepCode-{shell}.command'), *arguments],
                                        env={**os.environ, 'DEEPCODE_TEST_PYTHON': sys.executable},
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 23, result.stderr)
                expected = ([str(stage / 'DeepCode-GUI.app/Contents/Resources/tui/window.mjs'), '--command-window']
                            if shell == 'TUI' else []) + arguments
                self.assertEqual(json.loads(result.stdout), expected)

    def test_macos_tui_resources_include_four_native_fonts_and_licenses(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-tui-resources-') as directory:
            resources = Path(directory)
            package.macos_tui_resources(ROOT, resources)
            for family in ('Reading', 'ReadingSans', 'MonoKai', 'Mono'):
                font = resources / 'tui/fonts' / f'DeepCodeQuietTerminal{family}SC-Regular.ttf'
                self.assertGreater(font.stat().st_size, 1_000_000)
                data = font.read_bytes()
                self.assertEqual(data[:4], b'\x00\x01\x00\x00')
                tables = {tag: offset for tag, _, offset, _ in struct.iter_unpack(
                    '>4sIII', data[12:12 + struct.unpack_from('>H', data, 4)[0] * 16])}
                self.assertEqual(struct.unpack_from('>I', data, tables[b'post'] + 12)[0], 1)
                self.assertEqual(struct.unpack_from('>h', data, tables[b'OS/2'] + 2)[0], 500)
                self.assertEqual(struct.unpack_from('>H', data, tables[b'head'] + 18)[0], 1000)
            for name in ('window.mjs', 'font-preferences.mjs', 'font-bridge.js'):
                self.assertTrue((resources / 'tui' / name).is_file())
            self.assertTrue((resources / 'tui/fonts/WenKai-OFL.txt').is_file())

    def test_windows_tui_fonts_fit_console_family_names_and_keep_all_four_faces(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-windows-tui-') as directory:
            resources = Path(directory)
            package.windows_tui_resources(ROOT, resources)
            self.assertTrue((resources / 'tui/font-config.mjs').is_file())
            self.assertTrue((resources / 'tui/macos/font-preferences.mjs').is_file())
            self.assertTrue((resources / 'tui/fonts/WenKai-OFL.txt').is_file())
            families = set()
            for font in (resources / 'tui/fonts').glob('*.ttf'):
                data = font.read_bytes()
                tables = {tag: (offset, length) for tag, _, offset, length in struct.iter_unpack(
                    '>4sIII', data[12:12 + struct.unpack_from('>H', data, 4)[0] * 16])}
                offset, length = tables[b'name']
                names = data[offset:offset + length]
                _, count, strings = struct.unpack_from('>HHH', names)
                for platform, _, _, name_id, size, position in struct.iter_unpack('>HHHHHH', names[6:6 + count * 12]):
                    if platform == 3 and name_id == 1:
                        family = names[strings + position:strings + position + size].decode('utf-16-be')
                        self.assertLess(len(family.encode('utf-16-le')), 64)
                        families.add(family)
            self.assertEqual(families, {'DeepCode TUI Reading SC', 'DeepCode TUI Reading Sans SC',
                                       'DeepCode TUI Mono Kai SC', 'DeepCode TUI Mono SC'})

    def test_identity_is_explicit_and_never_falls_back_to_ad_hoc(self):
        fingerprint = 'A' * 40
        listing = f'  1) {fingerprint} "DeepCode Local Development"\n  1 valid identities found\n'
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(macos_signing.subprocess, 'run', return_value=Mock(stdout=listing)) as command:
            self.assertEqual(macos_signing.signing_identity(), fingerprint)
            command.return_value.stdout = '0 valid identities found\n'
            with self.assertRaisesRegex(ValueError, 'found 0'):
                macos_signing.signing_identity()
            command.return_value.stdout = listing + f'  2) {"B" * 40} "DeepCode Local Development"\n'
            with self.assertRaisesRegex(ValueError, 'found 2'):
                macos_signing.signing_identity()
        with patch.dict(os.environ, {'DEEPCODE_MACOS_SIGN_IDENTITY': '-'}), \
                patch.object(macos_signing.subprocess, 'run') as command:
            with self.assertRaisesRegex(ValueError, 'ad-hoc'):
                macos_signing.signing_identity()
            command.assert_not_called()

    def test_native_components_have_stable_identifiers_and_vendor_node_is_preserved(self):
        import plistlib
        with tempfile.TemporaryDirectory(prefix='deepcode-native-sign-') as directory:
            app = Path(directory) / 'DeepCode-GUI.app'
            write(app, 'Contents/Info.plist', plistlib.dumps({
                'CFBundleIdentifier': 'com.achbite.deepcode.gui', 'CFBundleExecutable': 'DeepCode-GUI'}))
            for name in ('DeepCode-GUI', 'deepcode-kernel', 'deepcode-host-web'):
                write(app, 'Contents/MacOS/' + name, b'owned native binary')
            write(app, 'Contents/Resources/node/bin/node', b'vendor signed node')
            with patch.object(macos_signing.subprocess, 'run') as command:
                macos_signing.sign_app(app, 'certificate', native_components=True)
            commands = [call.args[0] for call in command.call_args_list]
            self.assertEqual([call[-1] for call in commands], [
                str(app / 'Contents/MacOS/deepcode-host-web'),
                str(app / 'Contents/MacOS/deepcode-kernel'), str(app), str(app)])
            self.assertIn('com.achbite.deepcode.gui.deepcode-host-web', commands[0])
            self.assertIn('com.achbite.deepcode.gui.deepcode-kernel', commands[1])
            self.assertTrue(all('--deep' not in call for call in commands[:-1]))
            self.assertIn('--verify', commands[-1])


class PublicationTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='deepcode-publish-')
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.stage, self.destination = self.root / 'stage', self.root / 'portable'
        self.archive = self.root / 'runtime.tar.gz'
        write(self.stage, 'web-deepcode-gui/index.html', b'current UI')
        write(self.stage, 'deepcode-cli', b'current CLI')
        write(self.destination, 'web-deepcode-gui/assets/obsolete.js', b'old chunk')
        write(self.destination, 'web/index.html', b'retired editor')
        write(self.destination, 'deepcode-cli', b'previous CLI')
        write(self.destination, 'config/settings.json', b'user settings')
        write(self.destination, 'runtime/session.sqlite3', b'user history')

    def test_runtime_update_preserves_user_data_and_existing_distribution_archive(self):
        expected = files(self.stage)
        self.archive.write_bytes(b'last distribution')
        package.publish(self.stage, self.destination)
        for name, data in expected.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertFalse((self.destination / 'web').exists())
        self.assertFalse((self.destination / 'web-deepcode-gui/assets/obsolete.js').exists())
        self.assertEqual((self.destination / 'config/settings.json').read_bytes(), b'user settings')
        self.assertEqual((self.destination / 'runtime/session.sqlite3').read_bytes(), b'user history')
        self.assertEqual(self.archive.read_bytes(), b'last distribution')
        self.assertEqual({path.name for path in self.root.iterdir()}, {'stage', 'portable', 'runtime.tar.gz'})

    def test_failed_runtime_update_restores_previous_complete_runtime(self):
        before = files(self.destination)
        rename = Path.rename
        def fail_install(path, target):
            if path == self.stage / 'deepcode-cli':
                raise OSError('destination busy')
            return rename(path, target)
        with patch.object(Path, 'rename', fail_install):
            with self.assertRaisesRegex(OSError, 'destination busy'):
                package.publish(self.stage, self.destination)
        self.assertEqual(files(self.destination), before)
        self.assertFalse(self.archive.exists())

    def test_daily_app_update_rejects_a_different_signer_before_replacement(self):
        write(self.stage, 'DeepCode-GUI.app/Contents/MacOS/DeepCode-GUI', b'current GUI')
        write(self.destination, 'DeepCode-GUI.app/Contents/MacOS/DeepCode-GUI', b'existing GUI')
        before = files(self.destination)
        with patch.object(package, 'signing_identity', return_value='selected-identity'), \
                patch.object(package, 'require_same_identity', side_effect=ValueError('different signing identity')) as same:
            with self.assertRaisesRegex(ValueError, 'different signing identity'):
                package.publish(self.stage, self.destination)
        same.assert_called_once_with(self.destination / 'DeepCode-GUI.app', 'selected-identity')
        self.assertEqual(files(self.destination), before)

    def test_complete_publication_removes_obsolete_programs_and_archives_only_programs(self):
        expected = files(self.stage)
        package.publish(self.stage, self.destination, self.archive)
        for name, data in expected.items():
            self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertFalse((self.destination / 'web').exists())
        self.assertFalse((self.destination / 'web-deepcode-gui/assets/obsolete.js').exists())
        self.assertEqual((self.destination / 'config/settings.json').read_bytes(), b'user settings')
        self.assertEqual((self.destination / 'runtime/session.sqlite3').read_bytes(), b'user history')
        with tarfile.open(self.archive) as archive:
            actual = {str(Path(entry.name).relative_to(self.destination.name)): archive.extractfile(entry).read()
                      for entry in archive.getmembers() if entry.isfile()}
        self.assertEqual(actual, expected)

    def test_failed_publication_restores_previous_programs_and_archive(self):
        before = files(self.destination)
        self.archive.write_bytes(b'previous archive')
        rename = Path.rename
        def fail_install(path, target):
            if path.parent == self.stage:
                raise OSError('destination busy')
            return rename(path, target)
        with patch.object(Path, 'rename', fail_install):
            with self.assertRaisesRegex(OSError, 'destination busy'):
                package.publish(self.stage, self.destination, self.archive)
        self.assertEqual(files(self.destination), before)
        self.assertEqual(self.archive.read_bytes(), b'previous archive')

    def test_installer_publication_failure_restores_program_archive_and_installer(self):
        before = files(self.destination)
        self.archive.write_bytes(b'previous archive')
        output = self.root / 'DeepCode-setup.exe'
        output.write_bytes(b'previous installer')
        source = self.root / 'transaction/DeepCode-setup.exe'
        write(self.root, 'transaction/DeepCode-setup.exe', b'current installer')
        replace = Path.replace
        def fail_installer(path, target):
            if path == source:
                raise OSError('installer destination busy')
            return replace(path, target)
        with patch.object(Path, 'replace', fail_installer):
            with self.assertRaisesRegex(OSError, 'installer destination busy'):
                package.publish(self.stage, self.destination, self.archive, source)
        self.assertEqual(files(self.destination), before)
        self.assertEqual(self.archive.read_bytes(), b'previous archive')
        self.assertEqual(output.read_bytes(), b'previous installer')
        package.publish(self.stage, self.destination, self.archive, source)
        self.assertEqual(output.read_bytes(), b'current installer')
        self.assertEqual((self.destination / 'runtime/session.sqlite3').read_bytes(), b'user history')

    @unittest.skipUnless(sys.platform == 'linux', 'mapped image fixture requires Linux')
    def test_mapped_windows_images_are_rejected_before_program_replacement(self):
        destination = self.root / 'win64'
        for name in ['node/bin/node.exe', 'deepcode-kernel.exe']:
            binary = destination / name
            binary.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(shutil.which('sleep'), binary)
            process = subprocess.Popen([str(binary), '30'])
            try:
                deadline = time.monotonic() + 5
                while Path(f'/proc/{process.pid}/exe').resolve() != binary:
                    if time.monotonic() >= deadline:
                        self.fail('owned process did not start')
                    time.sleep(0.01)
                before = files(destination)
                with self.assertRaises(OSError):
                    package.publish(self.stage, destination, self.archive)
                self.assertEqual(files(destination), before)
            finally:
                process.terminate()
                process.wait(timeout=5)


class InstallerTests(unittest.TestCase):
    def test_macos_payload_installs_cli_against_the_same_app_resources(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-pkg-') as directory:
            root = Path(directory) / 'fixture with spaces'
            root.mkdir()
            stage = root / 'stage'
            stub = b"""#!/bin/sh
exec "$DEEPCODE_TEST_PYTHON" -c 'import json,os,sys; print(json.dumps({"argv":sys.argv[1:],"runtime":os.environ.get("DEEPCODE_RUNTIME_DIR"),"kernel":os.environ.get("DEEPCODE_KERNEL_BIN"),"user":os.environ.get("DEEPCODE_USER_ROOT")})); sys.exit(23)' "$@"
"""
            write(stage, 'DeepCode-GUI.app/Contents/MacOS/deepcode-cli', stub)
            (stage / 'DeepCode-GUI.app/Contents/MacOS/deepcode-cli').chmod(0o755)
            write(stage, 'DeepCode-GUI.app/Contents/Resources/node/bin/node', stub)
            (stage / 'DeepCode-GUI.app/Contents/Resources/node/bin/node').chmod(0o755)
            write(stage, 'DeepCode-GUI.app/Contents/Resources/session-core/dist/index.js', b'Session')
            write(stage, 'DeepCode Computer Use.app/Contents/MacOS/DeepCode-Computer-Use', b'Computer Use')
            def inspect(command, **kwargs):
                self.assertEqual(command[0], 'pkgbuild')
                payload = Path(command[command.index('--root') + 1])
                app = payload / 'Applications/DeepCode-GUI.app'
                self.assertEqual((app / 'Contents/MacOS/deepcode-cli').read_bytes(), stub)
                self.assertEqual((payload / 'Applications/DeepCode Computer Use.app/Contents/MacOS/DeepCode-Computer-Use').read_bytes(), b'Computer Use')
                arguments = ['--session', 'session:launcher', 'argument with spaces', 'literal "$HOME"', '']
                for name in ('deepcode', 'deepcode-tui'):
                    launcher = (payload / 'usr/local/bin' / name).read_text()
                    # Relocate only the installation root; execute the remaining launcher unchanged.
                    install_root = '/Applications/DeepCode-GUI.app'
                    self.assertIn(install_root, launcher, 'Cannot safely relocate the installer fixture')
                    relocated = root / name
                    relocated.write_text(launcher.replace(install_root, str(app)))
                    expected_args = ([str(app / 'Contents/Resources/tui/window.mjs')]
                                     if name == 'deepcode-tui' else []) + arguments
                    for user_root in (None, str(root / 'independent user data')):
                        environment = {**os.environ, 'DEEPCODE_TEST_PYTHON': sys.executable,
                                       'DEEPCODE_RUNTIME_DIR': 'stale-runtime', 'DEEPCODE_KERNEL_BIN': 'stale-kernel'}
                        environment.pop('DEEPCODE_USER_ROOT', None)
                        if user_root is not None:
                            environment['DEEPCODE_USER_ROOT'] = user_root
                        launched = subprocess.run(['sh', str(relocated), *arguments], env=environment,
                                                  capture_output=True, text=True, timeout=10)
                        self.assertEqual(launched.returncode, 23, launched.stdout + launched.stderr)
                        observed = json.loads(launched.stdout)
                        self.assertEqual(observed['argv'], expected_args)
                        self.assertEqual(observed['runtime'], str(app / 'Contents/Resources'))
                        self.assertEqual(observed['kernel'], str(app / 'Contents/MacOS/deepcode-kernel'))
                        self.assertEqual(observed['user'], user_root)
                self.assertFalse((payload / 'Users').exists())
                return subprocess.CompletedProcess(command, 0)
            # Patch only the packager's module reference, so the launcher uses real subprocess.run.
            with patch.object(installers, 'subprocess') as packager:
                packager.run.side_effect = inspect
                installers.macos(stage, root / 'DeepCode.pkg', '0.6.2')
                packager.run.assert_called_once()

    def test_windows_computer_use_update_renames_the_running_image_aside(self):
        import computer_use_package
        with tempfile.TemporaryDirectory(prefix='deepcode-cu-update-') as directory:
            root = Path(directory)
            native = root / 'native.exe'
            native.write_bytes(b'new executor')
            destination = root / 'win64'
            write(destination, computer_use_package.WINDOWS_EXECUTABLE, b'old executor')
            stale = destination / (computer_use_package.WINDOWS_RETIRED + '1')
            stale.write_bytes(b'no longer mapped')
            computer_use_package.update_windows(native, destination, strip=None)
            self.assertEqual((destination / computer_use_package.WINDOWS_EXECUTABLE).read_bytes(), b'new executor')
            retired = list(destination.glob(computer_use_package.WINDOWS_RETIRED + '*'))
            self.assertEqual([path.read_bytes() for path in retired], [b'old executor'])
            self.assertFalse(stale.exists())
            self.assertFalse(any(path.name.endswith('.new') for path in destination.iterdir()))

    def test_windows_setup_compiles_from_current_runtime(self):
        with tempfile.TemporaryDirectory(prefix='deepcode-nsis-') as directory:
            root = Path(directory)
            stage = root / 'stage'
            write(stage, 'DeepCode-GUI.exe', b'disposable native compiler output')
            write(stage, 'libexec/windows-environment.ps1', b'exit 0')
            output = root / 'DeepCode-setup.exe'
            installers.windows(stage, output, '0.6.2')
            self.assertEqual(output.read_bytes()[:2], b'MZ')


if __name__ == '__main__':
    unittest.main()
