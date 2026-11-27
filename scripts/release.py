#!/usr/bin/env python3
"""Automated local commits, PRs, merges and releases from an explicit text manifest."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import signal
import subprocess
import sys

from version import GUI_LOCK, plan as version_plan, project_version, valid_version

ROOT = Path(__file__).resolve().parents[1]
MODES = ('local', 'pr', 'merge', 'release')


class WorkflowError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def require(condition, message):
    if not condition:
        raise WorkflowError(message)


def now():
    return datetime.now(timezone.utc).isoformat()


def failure_code(error):
    return 130 if isinstance(error, KeyboardInterrupt) else getattr(error, 'code', 1)


def terminated(_signum, _frame):
    raise WorkflowError('Terminated', 143)


def text(value, label):
    require(isinstance(value, str) and value.strip() and '\0' not in value, f'{label}: nonempty text required')
    return value


def keys(value, allowed, label):
    require(isinstance(value, dict), f'{label}: expected an object')
    require(not (set(value) - set(allowed)), f'{label}: unknown fields {sorted(set(value) - set(allowed))}')


def load_input(path):
    data = json.loads(path.read_text(encoding='utf-8'))
    keys(data, ('mode', 'branch', 'base', 'version', 'version_message', 'commits', 'pr', 'release',
                'allow_remote_branch_deletion'), 'input')
    require(data.get('mode') in MODES, f'mode must be one of {MODES}')
    text(data.get('branch'), 'branch')
    require(isinstance(data.get('commits'), list), 'commits: expected a list (use [] for already committed changes)')
    seen = set()
    for group in data['commits']:
        keys(group, ('message', 'paths'), 'commit')
        text(group.get('message'), 'commit.message')
        require(isinstance(group.get('paths'), list) and group['paths'], 'commit.paths: explicit file list required')
        for name in group['paths']:
            text(name, 'commit.path')
            p = PurePosixPath(name)
            require(p.parts and not p.is_absolute() and str(p) == name and '..' not in p.parts and
                    p.parts[0] not in ('.git', '.task-artifacts', '.build-cache', 'bin') and name != '.',
                    f'commit path must be a source file relative to the checkout: {name}')
            require(name not in seen, f'file belongs to multiple groups: {name}')
            seen.add(name)
    if 'version' in data:
        valid_version(data['version'])
        text(data.get('version_message'), 'version_message')
    else:
        require('version_message' not in data, 'version_message requires version')
    deletion = data.get('allow_remote_branch_deletion', False)
    require(isinstance(deletion, bool), 'allow_remote_branch_deletion must be boolean')
    if data['mode'] != 'local':
        text(data.get('base'), 'base')
        require(data['base'] != data['branch'], 'source branch must differ from base')
        keys(data.get('pr'), ('title', 'body'), 'pr')
        text(data['pr'].get('title'), 'pr.title')
        text(data['pr'].get('body'), 'pr.body')
    else:
        require(not any(k in data for k in ('base', 'pr', 'release', 'allow_remote_branch_deletion')),
                'local mode does not accept remote operations')
    if data['mode'] == 'release':
        keys(data.get('release'), ('title', 'notes', 'platforms', 'prerelease'), 'release')
        release = data['release']
        if 'title' in release:  # Older manifests supplied a display title.
            text(release['title'], 'release.title')
        text(release.get('notes'), 'release.notes')
        platforms = release.get('platforms')
        require(isinstance(platforms, list) and platforms and
                all(p in ('macos', 'windows', 'linux') for p in platforms) and len(set(platforms)) == len(platforms),
                'release.platforms: unique explicit macos/windows/linux list required')
        require(isinstance(release.get('prerelease', False), bool), 'release.prerelease must be boolean')
    else:
        require('release' not in data, 'release inputs require release mode')
    return data


class Workflow:
    def __init__(self, root, data, output):
        self.root = root.resolve()
        self.data = data
        self.output = output.resolve()
        self.container = None
        self.workdir = None
        self.repo = None
        self.repo_url = None
        self.log = None
        self.counter = 0
        self.cleanup_pending = False
        self.receipt = {'status': 'planned', 'started_at': now(), 'mode': data['mode'],
                        'branch': data['branch'], 'stages': [], 'commits': []}

    def save(self):
        path = self.output / 'receipt.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)

    def run(self, command, env=None, pid_file=None):
        """Keep original output/exit status and own both host and Docker children."""
        command = [str(item) for item in command]
        print('+ ' + shlex.join(command), flush=True)
        process = subprocess.Popen(command, cwd=self.root, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, start_new_session=True)
        output = []
        try:
            for line in process.stdout:
                output.append(line)
                display = line.replace('\0', '\\0')
                print(display, end='', flush=True)
                if self.log:
                    self.log.write(display)
                    self.log.flush()
            code = process.wait()
        except BaseException:
            # Killing docker exec alone does not terminate the container process.
            if pid_file:
                try:
                    pid = pid_file.read_text().strip()
                    require(pid.isdigit(), f'Invalid container process evidence: {pid_file}')
                    stop = subprocess.run(['docker', 'exec', self.container, 'bash', '-c',
                        'kill -TERM -- "-$1" 2>/dev/null || exit 0; '
                        'for n in $(seq 1 30); do kill -0 -- "-$1" 2>/dev/null || exit 0; sleep 1; done; '
                        'echo "Container process group still active: $1" >&2; exit 1', 'bash', pid],
                        timeout=35, check=False)
                    self.cleanup_pending = stop.returncode != 0
                    if not self.cleanup_pending:
                        pid_file.unlink(missing_ok=True)
                except (OSError, WorkflowError, subprocess.TimeoutExpired) as cleanup_error:
                    self.cleanup_pending = True
                    print(f'Cleanup not confirmed: {cleanup_error}', file=sys.stderr)
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
            raise
        finally:
            process.stdout.close()
        if pid_file:
            pid_file.unlink(missing_ok=True)
        if code:
            raise WorkflowError(f'Command exited {code}: {shlex.join(command)}', code if code > 0 else 128 - code)
        return ''.join(output).rstrip('\n')

    def git(self, *args):
        return self.run(['git', *args])

    def gh(self, *args):
        return self.run(['gh', *args, '--repo', self.repo])

    def container_run(self, *args, environment=None):
        self.counter += 1
        pid_file = self.output / f'process-{self.counter}.pid'
        container_pid = self.container_path(pid_file)
        command = ['docker', 'exec', '-w', self.workdir]
        for name, value in (environment or {}).items():
            command += ['-e', name if value is None else f'{name}={value}']
        command += [self.container, 'setsid', '--wait', 'bash', '-c',
                    'export PATH="/usr/local/cargo/bin:/root/.local/share/pnpm:$PATH"; '
                    'printf "%s\n" "$$" > "$1"; shift; exec "$@"', 'bash', container_pid, *args]
        return self.run(command, pid_file=pid_file)

    def container_path(self, path):
        return self.workdir.rstrip('/') + '/' + path.relative_to(self.root).as_posix()

    def changed(self):
        # Disabling rename detection makes each old/new path explicit in the manifest.
        raw = self.git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')
        return {item[3:] for item in raw.split('\0') if item}

    def clean(self):
        require(self.git('branch', '--show-current') == self.data['branch'], 'Source branch changed during the workflow')
        expected = self.receipt.get('release_head', self.receipt.get('source_head'))
        if expected:
            require(self.git('rev-parse', 'HEAD') == expected, 'Source commit changed during the workflow')
        require(not self.changed(), 'Worktree changed during the workflow; refusing to publish unverified source')

    @contextmanager
    def stage(self, name):
        record = {'name': name, 'status': 'running', 'started_at': now()}
        self.receipt['stages'].append(record)
        self.save()
        print(f'==[release][START]== {name}', flush=True)
        with (self.output / f'{len(self.receipt["stages"]):02d}-{name}.log').open('w', encoding='utf-8') as log:
            self.log = log
            try:
                yield
            except BaseException as error:
                record.update(status='failed', error=str(error) or type(error).__name__, exit_code=failure_code(error))
                raise
            else:
                record['status'] = 'completed'
            finally:
                record['finished_at'] = now()
                self.log = None
                self.save()
        print(f'==[release][DONE]== {name}', flush=True)

    def check_source(self):
        require(Path(self.git('rev-parse', '--show-toplevel')).resolve() == self.root, 'Wrong Git checkout')
        require(self.git('branch', '--show-current') == self.data['branch'], 'Current branch differs from input.branch')
        require(self.data['branch'] not in ('main', 'dev-main'), 'Use a non-protected source/test branch')
        self.git('check-ref-format', '--branch', self.data['branch'])
        require(not self.git('diff', '--cached', '--name-only'), 'Existing staged changes must be resolved before activation')
        require(not self.git('ls-files', '-u'), 'Unmerged index entries are not supported')
        paths = {name for group in self.data['commits'] for name in group['paths']}
        changed = self.changed()
        require(paths == changed, f'Commit groups must cover exactly the changes; unlisted={sorted(changed - paths)}, '
                                 f'unchanged={sorted(paths - changed)}')
        for name in paths:
            require(not (self.root / name).is_dir(), f'Commit path is a directory, not a file: {name}')
        self.git('diff', '--check')
        return self.git('rev-parse', 'HEAD')

    def preflight(self):
        self.receipt['initial_head'] = self.check_source()
        require(not os.environ.get('ACHBIT_BUILD_VERSION') and os.environ.get('ACHBIT_BUILD_KIND', 'normal') == 'normal',
                'Release workflow cannot use a Debug version override')
        settings = dict(line.split('=', 1) for line in self.run(['make', '--no-print-directory', '-s', 'docker-info']).splitlines() if '=' in line)
        self.container = settings['container']
        self.workdir = settings['workdir']
        info = json.loads(self.run(['docker', 'inspect', '--format',
                                    '{"running":{{json .State.Running}},"mounts":{{json .Mounts}}}', self.container]))
        require(info['running'], 'Development container is stopped; use make shell')
        mount = next((m['Source'] for m in info['mounts'] if m['Destination'] == self.workdir), None)
        require(mount is not None and Path(mount).resolve() == self.root,
                'Development container mounts another worktree; use the matching make shell configuration')
        self.container_run('bash', '-c', 'command -v cargo && command -v pnpm && command -v node && command -v python3')
        self.receipt['version'] = self.data.get('version', project_version(self.root))
        if self.data['mode'] == 'local':
            return
        self.git('check-ref-format', '--branch', self.data['base'])
        remote = self.git('remote', 'get-url', 'origin')
        repository = json.loads(self.run(['gh', 'repo', 'view', remote, '--json', 'nameWithOwner,url']))
        self.repo, self.repo_url = repository['nameWithOwner'], repository['url']
        self.receipt['repository'] = self.repo
        policy = json.loads(self.run(['gh', 'api', f'repos/{self.repo}']))
        if self.data['mode'] in ('merge', 'release'):
            require(policy['allow_merge_commit'], 'Repository does not allow merge commits; no merge-method fallback')
            require(not policy['delete_branch_on_merge'] or self.data.get('allow_remote_branch_deletion', False),
                    'Repository deletes source branches on merge; explicitly authorize that policy in the input')
        self.git('fetch', 'origin', self.data['base'])
        self.base_head = self.git('rev-parse', 'FETCH_HEAD')
        self.git('merge-base', '--is-ancestor', self.base_head, 'HEAD')
        remote_branch = self.git('ls-remote', '--heads', 'origin', f'refs/heads/{self.data["branch"]}')
        if remote_branch:
            self.git('fetch', 'origin', self.data['branch'])
            self.git('merge-base', '--is-ancestor', 'FETCH_HEAD', 'HEAD')
        if self.data['mode'] == 'release':
            version = self.receipt['version']
            require(not self.git('tag', '--list', version), f'Local tag already exists: {version}')
            require(not self.git('ls-remote', '--tags', 'origin', f'refs/tags/{version}'), f'Remote tag already exists: {version}')
            releases = json.loads(self.gh('release', 'list', '--limit', '1000', '--json', 'tagName'))
            require(not any(r['tagName'] == version for r in releases), f'Release already exists: {version}')

    def commit(self, paths, message):
        self.git('--literal-pathspecs', 'add', '--', *paths)
        staged = set(self.git('diff', '--cached', '--no-renames', '--name-only', '-z').split('\0')) - {''}
        require(staged == set(paths), 'Staged paths do not match the intended group')
        self.git('diff', '--cached', '--check')
        self.git('commit', '-m', message)
        sha = self.git('rev-parse', 'HEAD')
        self.receipt['commits'].append({'sha': sha, 'message': message, 'paths': paths})
        self.save()

    def prepare_commits(self):
        for index, group in enumerate(self.data['commits'], 1):
            with self.stage(f'commit-{index}'):
                self.commit(group['paths'], group['message'])
        with self.stage('version'):
            self.clean()
            if 'version' in self.data:
                changes, stale_lock = version_plan(self.root, self.data['version'])
                expected = {str(p.relative_to(self.root)) for p in changes}
                if stale_lock:
                    expected.add(str(GUI_LOCK))
                self.container_run('python3', 'scripts/version.py', 'set', self.data['version'])
                changed = self.changed()
                require(changed <= expected, f'Unexpected files changed by version synchronization: {sorted(changed - expected)}')
                if changed:
                    self.commit(sorted(changed), self.data['version_message'])
            self.container_run('python3', 'scripts/version.py', 'check')
            self.clean()
            self.receipt['source_head'] = self.git('rev-parse', 'HEAD')
            self.receipt['source_tree'] = self.git('rev-parse', 'HEAD^{tree}')

    def build(self, stages):
        environment = {'ACHBIT_BUILD_COMMIT': self.git('rev-parse', 'HEAD'),
                       'ACHBIT_OUTPUT_DIR': self.container_path(self.output / 'bin')}
        if 'package-windows' in stages and 'ACHBIT_WINDOWS_TIMESTAMP_URL' in os.environ:
            # Docker inherits the value by name, keeping the service URL out of release logs.
            environment['ACHBIT_WINDOWS_TIMESTAMP_URL'] = None
        runtime = os.environ.get('ACHBIT_APPIMAGE_RUNTIME')
        if runtime:
            environment['ACHBIT_APPIMAGE_RUNTIME'] = self.container_path(Path(runtime).resolve())
        command = ['bash', './build.sh']
        for stage in stages:
            command += ['--stage', stage]
        self.container_run(*command, environment=environment)
        self.clean()

    def pull_request(self):
        with self.stage('push-pr'):
            self.clean()
            head = self.receipt['source_head']
            self.git('push', '--set-upstream', 'origin', f'HEAD:refs/heads/{self.data["branch"]}')
            require(self.git('ls-remote', '--heads', 'origin', f'refs/heads/{self.data["branch"]}').split()[0] == head,
                    'Pushed branch does not match validated source')
            prs = json.loads(self.gh('pr', 'list', '--state', 'open', '--base', self.data['base'],
                                    '--head', self.data['branch'], '--json', 'number'))
            require(len(prs) <= 1, 'Multiple matching PRs; choose the intended PR before continuing')
            body = self.output / 'PR.md'
            body.write_text(self.data['pr']['body'], encoding='utf-8')
            if prs:
                number = str(prs[0]['number'])
                self.gh('pr', 'edit', number, '--title', self.data['pr']['title'], '--body-file', str(body))
            else:
                url = self.gh('pr', 'create', '--base', self.data['base'], '--head', self.data['branch'],
                              '--title', self.data['pr']['title'], '--body-file', str(body))
                number = url.splitlines()[-1].rstrip('/').split('/')[-1]
                require(number.isdigit(), 'PR creation did not return a PR URL')
            fields = 'number,url,title,body,baseRefName,headRefName,headRefOid,state,statusCheckRollup'
            pr = json.loads(self.gh('pr', 'view', number, '--json', fields))
            require(pr['title'] == self.data['pr']['title'] and pr['body'] == self.data['pr']['body'], 'Stored PR text differs from input')
            require(pr['baseRefName'] == self.data['base'] and pr['headRefName'] == self.data['branch'] and
                    pr['headRefOid'] == head and pr['state'] == 'OPEN', 'PR source/target/state changed')
            self.receipt['pr'] = pr
        if self.data['mode'] == 'pr':
            return
        with self.stage('merge'):
            # The server enforces required checks/queues. A queued request is not a completed merge.
            self.gh('pr', 'merge', number, '--merge', '--match-head-commit', head,
                    '--subject', self.data['pr']['title'], '--body-file', str(self.output / 'PR.md'))
            merged = json.loads(self.gh('pr', 'view', number, '--json', 'state,mergeCommit,url'))
            self.receipt['merge'] = merged
            self.save()
            require(merged['state'] == 'MERGED' and merged.get('mergeCommit'),
                    'PR is not confirmed MERGED (possibly queued); no tag or publication was attempted')
            merge_sha = merged['mergeCommit']['oid']
            self.git('fetch', 'origin', self.data['base'])
            self.git('merge-base', '--is-ancestor', merge_sha, 'FETCH_HEAD')
            require(self.git('rev-parse', f'{merge_sha}^{{tree}}') == self.receipt['source_tree'],
                    'Merged tree differs from validated source; stop before release and validate the new source')
            # Advance only the selected source branch; never switch or rewrite unrelated local branches.
            self.git('merge', '--ff-only', merge_sha)
            self.receipt['release_head'] = self.git('rev-parse', 'HEAD')
            self.clean()
            if not self.data.get('allow_remote_branch_deletion', False):
                self.git('push', 'origin', f'HEAD:refs/heads/{self.data["branch"]}')
                require(self.git('ls-remote', '--heads', 'origin', f'refs/heads/{self.data["branch"]}').split()[0] == merge_sha,
                        'Source branch synchronization was not confirmed')

    def artifact_paths(self):
        version = self.receipt['version']
        output = self.output / 'bin'
        artifacts, updates = [], {}
        for platform in self.data['release']['platforms']:
            prefix = f'Achbit-{version}-'
            if platform == 'macos':
                names = [prefix + 'macos-arm64.tar.gz', prefix + 'macos-arm64.pkg', prefix + 'macos-arm64.app.tar.gz']
                target = 'darwin-aarch64'
            elif platform == 'windows':
                names = [prefix + 'win64.zip', prefix + 'win64-setup.exe']
                target = 'windows-x86_64'
            else:
                arch = self.container_run('uname', '-m').splitlines()[-1]
                require(arch in ('aarch64', 'x86_64'), f'Unsupported Linux architecture: {arch}')
                suffix, target = ('arm64', 'linux-aarch64') if arch == 'aarch64' else ('x64', 'linux-x86_64')
                names = [prefix + f'linux-{suffix}.tar.gz', prefix + f'linux-{suffix}.AppImage']
            selected = [output / name for name in names]
            require(all(p.is_file() and p.stat().st_size for p in selected), f'Missing or empty {platform} artifacts: {names}')
            artifacts += selected
            updates[target] = selected[-1]
        return artifacts, updates

    def release_view(self):
        return json.loads(self.gh('release', 'view', self.receipt['version'], '--json',
                                 'tagName,name,body,isDraft,isPrerelease,assets,url'))

    def verify_release(self, view, artifacts, draft):
        desired = self.data['release']
        require(view['tagName'] == self.receipt['version'] and view['name'] == self.receipt['version'] and
                view['body'] == desired['notes'], 'Stored Release text/tag differs from input')
        require(view['isDraft'] == draft and view['isPrerelease'] == desired.get('prerelease', False),
                'Unexpected Release publication state')
        expected = {p.name: p.stat().st_size for p in artifacts}
        actual = {a['name']: a['size'] for a in view['assets']}
        require(actual == expected, f'Release asset names/sizes differ: expected={expected}, actual={actual}')

    def publish(self):
        with self.stage('package'):
            self.build(['package-' + p for p in self.data['release']['platforms']])
        with self.stage('sign-feed'):
            artifacts, updates = self.artifact_paths()
            env = {**os.environ, 'CONTAINER_NAME': self.container, 'WORKDIR_IN_CTNR': self.workdir}
            self.run(['python3', 'scripts/package-updates.py', 'sign', *updates.values()], env=env)
            base_url = self.repo_url + '/releases/download/' + self.receipt['version']
            command = ['python3', 'scripts/package-updates.py', 'manifest', '--base-url', base_url,
                       '--output', self.output / 'bin/latest.json']
            for target, artifact in updates.items():
                command += ['--artifact', f'{target}={artifact}']
            self.run(command)
            artifacts += [Path(str(p) + '.sig') for p in updates.values()]
            artifacts.append(self.output / 'bin/latest.json')
            self.receipt['assets'] = [{'name': p.name, 'size': p.stat().st_size} for p in artifacts]
        with self.stage('tag'):
            self.clean()
            version, head = self.receipt['version'], self.receipt['release_head']
            require(self.git('rev-parse', 'HEAD') == head, 'Source moved after packaging')
            self.git('tag', version, head)
            self.git('push', 'origin', f'refs/tags/{version}')
            require(self.git('ls-remote', '--tags', 'origin', f'refs/tags/{version}').split()[0] == head,
                    'Remote tag does not match packaged source')
        with self.stage('upload-draft'):
            notes = self.output / 'RELEASE.md'
            notes.write_text(self.data['release']['notes'], encoding='utf-8')
            command = ['release', 'create', version, '--verify-tag', '--draft', '--title',
                       version, '--notes-file', str(notes)]
            if self.data['release'].get('prerelease', False):
                command.append('--prerelease')
            self.gh(*command)
            self.gh('release', 'upload', version, *map(str, artifacts))
            self.verify_release(self.release_view(), artifacts, draft=True)
        with self.stage('publish-verify'):
            latest = 'false' if self.data['release'].get('prerelease', False) else 'true'
            self.gh('release', 'edit', version, '--draft=false', '--latest=' + latest)
            view = self.release_view()
            self.verify_release(view, artifacts, draft=False)
            download = self.output / 'remote-feed'
            self.gh('release', 'download', version, '--pattern', 'latest.json', '--dir', str(download))
            require(json.loads((download / 'latest.json').read_text()) ==
                    json.loads((self.output / 'bin/latest.json').read_text()), 'Published updater feed differs from built feed')
            if latest == 'true':
                current = json.loads(self.run(['gh', 'api', f'repos/{self.repo}/releases/latest']))
                require(current['tag_name'] == version, 'Published stable Release is not the latest release')
            self.receipt['release'] = view

    def execute(self):
        require(self.output.is_relative_to(self.root / '.task-artifacts'), 'Output must be under this worktree/.task-artifacts')
        require(not self.output.exists(), f'Output already exists: {self.output}; inspect its receipt, do not blindly replay')
        lock = self.root / '.build-cache/release.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        try:
            lock.mkdir()
        except FileExistsError as error:
            raise WorkflowError(f'Another submission owns {lock}; do not remove an active lock') from error
        try:
            self.output.mkdir(parents=True)
            (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'output': str(self.output)}) + '\n')
            (self.output / 'input.json').write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            self.receipt['status'] = 'running'
            self.save()
            with self.stage('preflight'):
                self.preflight()
            self.prepare_commits()
            with self.stage('test'):
                self.container_run('bash', './test.sh', 'required')
                self.clean()
            with self.stage('compile'):
                self.build(['code'])
            if self.data['mode'] != 'local':
                self.pull_request()
            if self.data['mode'] == 'release':
                self.publish()
            self.receipt['final_head'] = self.git('rev-parse', 'HEAD')
            self.receipt['status'] = 'completed'
        except BaseException as error:
            self.receipt.update(status='failed', error=str(error) or type(error).__name__, exit_code=failure_code(error))
            raise
        finally:
            self.receipt['finished_at'] = now()
            if self.output.is_dir():
                self.save()
            if self.cleanup_pending:
                print(f'Cleanup remains unverified; retained lock: {lock}', file=sys.stderr)
            else:
                (lock / 'owner.json').unlink(missing_ok=True)
                lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path, help='UTF-8 JSON with scope, commit groups and PR/Release text')
    parser.add_argument('--output', type=Path, help='New receipt directory under .task-artifacts (default: unique timestamp)')
    parser.add_argument('--confirm', action='store_true', help='Execute the selected scope; without this flag only print the plan')
    args = parser.parse_args()
    try:
        data = load_input(args.input)
        output = args.output or ROOT / '.task-artifacts' / ('submission-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        if not output.is_absolute():
            output = ROOT / output
        print(json.dumps({'mode': data['mode'], 'branch': data['branch'], 'base': data.get('base'),
                          'version': data.get('version'), 'commit_groups': len(data['commits']),
                          'tests': 'test.sh required', 'compile': 'build.sh --stage code',
                          'release_platforms': data.get('release', {}).get('platforms', []),
                          'output': str(output), 'execute': args.confirm}, ensure_ascii=False, indent=2))
        if not args.confirm:
            return 0
        signal.signal(signal.SIGTERM, terminated)
        Workflow(ROOT, data, output).execute()
        print(f'==[release][COMPLETED]== receipt={output / "receipt.json"}')
        return 0
    except KeyboardInterrupt:
        print('Submission interrupted; inspect the receipt before another activation.', file=sys.stderr)
        return 130
    except (WorkflowError, OSError, ValueError, KeyError) as error:
        print(f'Submission failed: {error}', file=sys.stderr)
        return getattr(error, 'code', 1)


if __name__ == '__main__':
    sys.exit(main())
