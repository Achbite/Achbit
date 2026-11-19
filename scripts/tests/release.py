#!/usr/bin/env python3
"""Real disposable Git effects with compiler/Docker/GitHub boundaries replaced, never a live release."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import release
import version

spec = importlib.util.spec_from_file_location('package_updates', ROOT / 'scripts/package-updates.py')
updates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updates)


def write(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(data, encoding='utf-8')
    return path


def git(root, *args):
    result = subprocess.run(['git', *args], cwd=root, text=True, capture_output=True, check=True)
    return result.stdout.rstrip('\n')


class Boundaries(release.Workflow):
    """Use real git/version/manifest code; replace only external services and compilers."""
    def __init__(self, *args, remote, **kwargs):
        super().__init__(*args, **kwargs)
        self.remote = remote
        self.calls = []
        self.fail_test = False
        self.wrong_mount = False
        self.bad_assets = False
        self.base_changed = False
        self.pr = None
        self.published = None
        self.uploaded = {}

    def run(self, command, env=None, pid_file=None):
        command = list(map(str, command))
        self.calls.append(command)
        if command[0] == 'make':
            return 'container=fixture-dev\nworkdir=/workspace'
        if command[:2] == ['docker', 'inspect']:
            source = str(self.root / 'wrong') if self.wrong_mount else str(self.root)
            return json.dumps({'running': True, 'mounts': [{'Source': source, 'Destination': '/workspace'}]})
        if command[:2] == ['docker', 'exec']:
            args = command[command.index('setsid') + 7:]
            if args[:2] == ['bash', '-c']:
                return '/usr/local/cargo/bin/cargo\n/usr/local/bin/pnpm\n/usr/local/bin/node\n/usr/bin/python3'
            if args == ['uname', '-m']:
                return 'x86_64'
            if args[:2] == ['python3', 'scripts/version.py']:
                return super().run([sys.executable, *args[1:]])
            if args == ['bash', './test.sh', 'required']:
                if self.fail_test:
                    raise release.WorkflowError('fixture test failure', 23)
                return 'fixture test command completed'
            if args[:2] == ['bash', './build.sh']:
                self.build_calls = getattr(self, 'build_calls', []) + [args]
                if any(a.startswith('package-') for a in args):
                    current = version.project_version(self.root)
                    for name in (f'Achbit-{current}-linux-x64.tar.gz', f'Achbit-{current}-linux-x64.AppImage'):
                        write(self.output, 'bin/' + name, 'compiler fixture asset')
                return 'fixture compiler completed'
            raise AssertionError(f'Unexpected container command: {args}')
        if command[:3] == ['python3', 'scripts/package-updates.py', 'sign']:
            for artifact in command[3:]:
                Path(artifact + '.sig').write_text('fixture signature\n')
            return 'fixture signer completed'
        if command[0] == 'gh':
            return self.github(command[1:])
        return super().run(command, env=env, pid_file=pid_file)

    def github(self, args):
        if '--repo' in args:
            args = args[:args.index('--repo')]
        if args[:2] == ['repo', 'view']:
            return json.dumps({'nameWithOwner': 'fixture/achbit', 'url': 'https://github.com/fixture/achbit'})
        if args == ['api', 'repos/fixture/achbit']:
            return json.dumps({'allow_merge_commit': True, 'delete_branch_on_merge': False})
        if args == ['api', 'repos/fixture/achbit/releases/latest']:
            return json.dumps({'tag_name': self.published['tagName']})
        if args[:2] == ['pr', 'list']:
            return '[]' if self.pr is None else '[{"number": 1}]'
        if args[:2] == ['pr', 'create']:
            self.pr = {'number': 1, 'url': 'https://github.com/fixture/achbit/pull/1',
                       'title': args[args.index('--title') + 1],
                       'body': Path(args[args.index('--body-file') + 1]).read_text(),
                       'baseRefName': self.data['base'], 'headRefName': self.data['branch'],
                       'headRefOid': git(self.remote, 'rev-parse', self.data['branch']),
                       'state': 'OPEN', 'statusCheckRollup': []}
            return self.pr['url']
        if args[:2] == ['pr', 'view']:
            return json.dumps(self.pr)
        if args[:2] == ['pr', 'merge']:
            head = git(self.remote, 'rev-parse', self.data['branch'])
            if head != args[args.index('--match-head-commit') + 1]:
                raise AssertionError('head mismatch')
            tree = git(self.remote, 'rev-parse', head + '^{tree}')
            if self.base_changed:
                tree = git(self.remote, 'rev-parse', 'main^{tree}')
            commit = git(self.remote, 'commit-tree', tree, '-p', 'main', '-p', head,
                         '-m', args[args.index('--subject') + 1])
            git(self.remote, 'update-ref', 'refs/heads/main', commit)
            self.pr.update(state='MERGED', mergeCommit={'oid': commit})
            return ''
        if args[:2] == ['release', 'list']:
            return '[]'
        if args[:2] == ['release', 'create']:
            self.published = {'tagName': args[2], 'name': args[args.index('--title') + 1],
                              'body': Path(args[args.index('--notes-file') + 1]).read_text(),
                              'isDraft': True, 'isPrerelease': '--prerelease' in args,
                              'assets': [], 'url': 'https://github.com/fixture/achbit/releases/tag/' + args[2]}
            return self.published['url']
        if args[:2] == ['release', 'upload']:
            self.uploaded = {Path(p).name: Path(p).read_bytes() for p in args[3:]}
            self.published['assets'] = [{'name': name, 'size': len(data)} for name, data in self.uploaded.items()]
            if self.bad_assets:
                self.published['assets'].pop()
            return ''
        if args[:2] == ['release', 'view']:
            return json.dumps(self.published)
        if args[:2] == ['release', 'edit']:
            self.published['isDraft'] = False
            return ''
        if args[:2] == ['release', 'download']:
            directory = Path(args[args.index('--dir') + 1])
            directory.mkdir()
            (directory / 'latest.json').write_bytes(self.uploaded['latest.json'])
            return ''
        raise AssertionError(f'Unexpected GitHub command: {args}')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix='achbit-release-')
        self.addCleanup(scratch.cleanup)
        self.directory = Path(scratch.name)
        self.root = self.directory / 'source'
        self.root.mkdir()
        self.remote = self.directory / 'origin.git'
        self.remote.mkdir()
        git(self.remote, 'init', '--bare', '--initial-branch=main')
        git(self.root, 'init', '--initial-branch=main')
        for repo in (self.root, self.remote):
            git(repo, 'config', 'user.email', 'fixture@example.invalid')
            git(repo, 'config', 'user.name', 'Release Fixture')
            git(repo, 'config', 'commit.gpgsign', 'false')
            git(repo, 'config', 'core.hooksPath', str(self.directory / 'no-hooks'))
            git(repo, 'config', 'core.untrackedCache', 'false')
        write(self.root, '.gitignore', '.task-artifacts/\n.build-cache/\nCargo.lock\n**/target/\n**/__pycache__/\n')
        write(self.root, 'Cargo.toml', '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\n')
        write(self.root, version.GUI_MANIFEST, '[workspace]\n\n[package]\nname = "achbit-gui-tauri-shell"\nversion = "0.1.0"\nedition = "2021"\n')
        write(self.root, version.GUI_MANIFEST.parent / 'src/lib.rs', '')
        for name in version.JSON_FILES:
            write(self.root, name, '{"version": "0.1.0"}\n')
        write(self.root, 'CITATION.cff', 'cff-version: 1.2.0\nversion: 0.1.0\n')
        subprocess.run(['cargo', 'generate-lockfile', '--offline', '--manifest-path', str(self.root / version.GUI_MANIFEST)], check=True, capture_output=True)
        for name in ('release.sh', 'release.py', 'version.py', 'package-updates.py'):
            write(self.root, 'scripts/' + name, (ROOT / 'scripts' / name).read_text())
        write(self.root, 'first.txt', 'old first\n')
        write(self.root, 'second.txt', 'old second\n')
        git(self.root, 'add', '.')
        git(self.root, 'commit', '-m', 'fixture initial')
        git(self.root, 'remote', 'add', 'origin', str(self.remote))
        git(self.root, 'push', 'origin', 'main')
        git(self.root, 'switch', '-c', 'test/automation')
        write(self.root, 'first.txt', 'new first\n')
        write(self.root, 'second.txt', 'new second\n')
        self.initial = git(self.root, 'rev-parse', 'HEAD')
        self.data = {'mode': 'local', 'branch': 'test/automation', 'commits': [
            {'message': 'feat: first change', 'paths': ['first.txt']},
            {'message': 'docs: second change', 'paths': ['second.txt']} ]}
        self.output = self.root / '.task-artifacts/run'
        self.environment = {k: v for k, v in os.environ.items() if k not in ('ACHBIT_BUILD_VERSION', 'ACHBIT_BUILD_KIND')}
        self.env_patch = patch.dict(os.environ, self.environment, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def workflow(self, mode='local'):
        self.data['mode'] = mode
        if mode != 'local':
            self.data.update(base='main', pr={'title': '修复：自动化提交', 'body': '## 变更\n保留实际换行\n\n## 验证\n由自动化运行。'})
        if mode == 'release':
            self.data.update(version='0.1.1', version_message='chore: version 0.1.1',
                             release={'title': 'Release 0.1.1', 'notes': '自动化提交与发布。\n保留公开说明。', 'platforms': ['linux']})
        path = write(self.root, '.task-artifacts/input.json', json.dumps(self.data, ensure_ascii=False))
        data = release.load_input(path)
        return Boundaries(self.root, data, self.output, remote=self.remote)

    def receipt(self):
        return json.loads((self.output / 'receipt.json').read_text())

    def test_public_entrypoint_without_confirm_is_read_only(self):
        self.workflow()
        before = git(self.root, 'status', '--porcelain')
        result = subprocess.run(['bash', 'scripts/release.sh', '--input', '.task-artifacts/input.json'],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)['execute'])
        self.assertEqual(git(self.root, 'status', '--porcelain'), before)
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.initial)
        self.assertFalse(self.output.exists())

    def test_local_groups_real_commits_and_uses_required_then_code_build(self):
        flow = self.workflow()
        flow.execute()
        self.assertEqual(git(self.root, 'status', '--porcelain'), '')
        self.assertEqual(git(self.root, 'log', '-2', '--format=%s'), 'docs: second change\nfeat: first change')
        self.assertEqual(git(self.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'second.txt')
        self.assertEqual(self.receipt()['status'], 'completed')
        self.assertEqual([s['name'] for s in self.receipt()['stages']], ['preflight', 'commit-1', 'commit-2', 'version', 'test', 'compile'])
        self.assertEqual(flow.build_calls, [['bash', './build.sh', '--stage', 'code']])
        self.assertFalse(any(call[0] == 'gh' or call[:2] == ['git', 'push'] for call in flow.calls))
        self.assertFalse((self.root / '.build-cache/release.lock').exists())
        self.assertTrue(all(b'\0' not in path.read_bytes() for path in self.output.glob('*.log')))

    def test_windows_packaging_inherits_explicit_timestamp_without_logging_url(self):
        flow = self.workflow()
        flow.container, flow.workdir = 'fixture-dev', '/workspace'
        git(self.root, 'commit', '-am', 'fixture source')
        for service in ('https://timestamp.example.invalid/fixture', ''):
            with self.subTest(service=service), patch.dict(os.environ, ACHBIT_WINDOWS_TIMESTAMP_URL=service):
                flow.build(['package-windows'])
                command = next(call for call in reversed(flow.calls) if call[:2] == ['docker', 'exec'])
                forwarded = [command[i + 1] for i, arg in enumerate(command[:-1]) if arg == '-e']
                self.assertIn('ACHBIT_WINDOWS_TIMESTAMP_URL', forwarded)
                if service:
                    self.assertNotIn(service, ' '.join(command))

    def test_failure_retains_commits_exit_status_and_stops_before_compile_push(self):
        flow = self.workflow('pr')
        flow.fail_test = True
        with self.assertRaises(release.WorkflowError) as error:
            flow.execute()
        self.assertEqual(error.exception.code, 23)
        self.assertEqual(self.receipt()['status'], 'failed')
        self.assertEqual(self.receipt()['stages'][-1]['name'], 'test')
        self.assertEqual(self.receipt()['stages'][-1]['exit_code'], 23)
        self.assertEqual(len(self.receipt()['commits']), 2)
        self.assertFalse(any(call[:2] == ['git', 'push'] for call in flow.calls))
        self.assertFalse(hasattr(flow, 'build_calls'))
        with self.assertRaisesRegex(release.WorkflowError, 'Output already exists'):
            flow.execute()

    def test_input_unlisted_changes_and_staged_content_are_not_committed(self):
        flow = self.workflow()
        write(self.root, 'unrelated.txt', 'unrelated\n')
        with self.assertRaisesRegex(release.WorkflowError, 'unlisted='):
            flow.check_source()
        (self.root / 'unrelated.txt').unlink()
        git(self.root, 'add', 'first.txt')
        with self.assertRaisesRegex(release.WorkflowError, 'Existing staged'):
            flow.check_source()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.initial)
        self.assertEqual(git(self.root, 'diff', '--cached', '--name-only'), 'first.txt')

    def test_mismatched_container_rejected_before_commits(self):
        flow = self.workflow()
        flow.wrong_mount = True
        with self.assertRaisesRegex(release.WorkflowError, 'another worktree'):
            flow.execute()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.initial)

    def test_invalid_manifest_and_unknown_fields_rejected(self):
        path = write(self.root, '.task-artifacts/bad.json', json.dumps({**self.data, 'skip_tests': True}))
        with self.assertRaisesRegex(release.WorkflowError, 'unknown fields'):
            release.load_input(path)
        self.data['commits'][1]['paths'] = ['first.txt']
        path.write_text(json.dumps(self.data))
        with self.assertRaisesRegex(release.WorkflowError, 'multiple groups'):
            release.load_input(path)
        self.data['commits'][1]['paths'] = ['.']
        path.write_text(json.dumps(self.data))
        with self.assertRaisesRegex(release.WorkflowError, 'source file'):
            release.load_input(path)

    def test_pr_scope_pushes_to_bare_remote_but_does_not_merge(self):
        flow = self.workflow('pr')
        flow.execute()
        self.assertEqual(git(self.remote, 'rev-parse', 'test/automation'), git(self.root, 'rev-parse', 'HEAD'))
        self.assertEqual(git(self.remote, 'rev-parse', 'main'), self.initial)
        self.assertEqual(flow.pr['body'], self.data['pr']['body'])
        self.assertEqual(self.receipt()['pr']['state'], 'OPEN')
        self.assertFalse(any(call[:3] == ['gh', 'pr', 'merge'] for call in flow.calls))

    def test_release_uses_merged_source_real_version_and_complete_draft(self):
        flow = self.workflow('release')
        flow.execute()
        receipt = self.receipt()
        head = git(self.root, 'rev-parse', 'HEAD')
        self.assertEqual(git(self.remote, 'rev-parse', 'main'), head)
        self.assertEqual(git(self.remote, 'rev-parse', 'test/automation'), head)
        self.assertEqual(git(self.remote, 'rev-parse', 'refs/tags/0.1.1'), head)
        self.assertEqual(version.check(self.root), '0.1.1')
        self.assertEqual(len(receipt['commits']), 3)
        self.assertEqual(receipt['release_head'], head)
        self.assertEqual(receipt['status'], 'completed')
        self.assertFalse(flow.published['isDraft'])
        self.assertEqual(flow.published['body'], self.data['release']['notes'])
        self.assertEqual(len(flow.uploaded), 4)
        self.assertEqual(json.loads(flow.uploaded['latest.json'])['version'], '0.1.1')
        package_call = next(call for call in flow.calls if 'package-linux' in call)
        self.assertIn('ACHBIT_BUILD_COMMIT=' + head, package_call)

    def test_changed_merge_tree_stops_before_package_or_tag(self):
        flow = self.workflow('release')
        flow.base_changed = True
        with self.assertRaisesRegex(release.WorkflowError, 'Merged tree differs'):
            flow.execute()
        self.assertEqual(git(self.remote, 'tag', '--list'), '')
        self.assertFalse(any('package-linux' in call for call in flow.calls))
        self.assertEqual(self.receipt()['merge']['state'], 'MERGED')

    def test_incomplete_upload_stays_draft_with_original_failure(self):
        flow = self.workflow('release')
        flow.bad_assets = True
        with self.assertRaisesRegex(release.WorkflowError, 'asset names/sizes differ'):
            flow.execute()
        self.assertTrue(flow.published['isDraft'])
        self.assertFalse(any(call[:3] == ['gh', 'release', 'edit'] for call in flow.calls))
        self.assertEqual(self.receipt()['stages'][-1]['name'], 'upload-draft')


class AppImageRuntimeTests(unittest.TestCase):
    def test_linux_producer_passes_cached_runtime_to_appimagetool(self):
        with tempfile.TemporaryDirectory(prefix='achbit-appimage-') as directory:
            root = Path(directory)
            write(root, 'stage/program', 'program')
            write(root, 'shells/achbit-gui/src-tauri/icons/icon.png', 'icon')
            cached = write(root, '.build-cache/prior/runtime-aarch64', 'runtime')
            with patch.object(updates, 'ROOT', root), patch.object(updates.platform, 'machine', return_value='aarch64'), \
                    patch.dict(os.environ, {'ACHBIT_APPIMAGE_RUNTIME': ''}), patch.object(updates.subprocess, 'run') as run:
                updates.linux(root / 'stage', root / 'out/program.AppImage')
                args = run.call_args.args[0]
                self.assertEqual(args[:4], ['appimagetool', '--no-appstream', '--runtime-file', str(cached)])
                self.assertTrue(run.call_args.kwargs['check'])

    def test_host_signer_honors_configured_container_mount(self):
        with tempfile.TemporaryDirectory(prefix='achbit-sign-') as directory:
            root = Path(directory)
            artifact = write(root, 'out/program.AppImage', 'artifact')
            actual_is_file = Path.is_file
            actual_exists = Path.exists
            def exists(path):
                return False if str(path) == '/.dockerenv' else actual_exists(path)
            def is_file(path):
                return True if str(path).endswith('.sig') else actual_is_file(path)
            with patch.object(updates, 'ROOT', root), patch.object(Path, 'exists', exists), \
                    patch.object(Path, 'is_file', is_file), patch.object(updates.subprocess, 'check_output', return_value=str(root)), \
                    patch.object(updates.subprocess, 'run') as run, patch.dict(os.environ, {
                        'TAURI_SIGNING_PRIVATE_KEY': 'fixture-key', 'WORKDIR_IN_CTNR': '/source', 'CONTAINER_NAME': 'fixture-dev'}):
                run.return_value.returncode = 0
                updates.sign(artifact)
                args = run.call_args.args[0]
                self.assertEqual(args[args.index('-w') + 1], '/source')
                self.assertEqual(args[-1], '/source/out/program.AppImage')
                self.assertNotIn('fixture-key', args)

    def test_explicit_runtime_then_arch_cache_then_existing_download_behavior(self):
        with tempfile.TemporaryDirectory(prefix='achbit-runtime-') as directory:
            root = Path(directory)
            cached = write(root, '.build-cache/prior/runtime-aarch64', 'cached runtime')
            explicit = write(root, 'chosen', 'explicit runtime')
            with patch.object(updates, 'ROOT', root), patch.object(updates.platform, 'machine', return_value='aarch64'):
                with patch.dict(os.environ, {'ACHBIT_APPIMAGE_RUNTIME': str(explicit)}):
                    self.assertEqual(updates.appimage_runtime(), explicit)
                with patch.dict(os.environ, {'ACHBIT_APPIMAGE_RUNTIME': ''}):
                    self.assertEqual(updates.appimage_runtime(), cached)
                    cached.unlink()
                    self.assertIsNone(updates.appimage_runtime())
                with patch.dict(os.environ, {'ACHBIT_APPIMAGE_RUNTIME': str(root / 'missing')}):
                    with self.assertRaises(FileNotFoundError):
                        updates.appimage_runtime()


if __name__ == '__main__':
    unittest.main()
