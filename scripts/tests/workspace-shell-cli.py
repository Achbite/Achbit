#!/usr/bin/env python3
"""Focused CLI/Plan/workspace Shell check on macOS, Linux or LPAC-capable Windows.

Uses the existing local-agent fixture only for deterministic Provider input and
owned Host lifecycle. Commands, Plan confirmation and outputs use the real CLI.
Exit 77 means the OS probe reports that sandbox capability is unavailable; it is
not a passing isolation check. Probe command/response errors and tool failures fail.
"""
import csv
import http.server
from contextlib import ExitStack, closing
import importlib.util
import json
import os
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

spec = importlib.util.spec_from_file_location("deepcode_test_support", Path(__file__).with_name("support.py"))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
WINDOWS = os.name == 'nt'
MACOS = sys.platform == 'darwin'
SHELL = 'powershell' if WINDOWS else 'bash'
UNAVAILABLE_EXIT = 77


def command(bash, powershell):
    return powershell if WINDOWS else bash

class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            ordinal, names, results = self.provider_state.inspect(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            def shell(call, command, **extra):
                return (call, names['bash'], {'command': command, **extra})
            if ordinal == 1:
                read_command = "set -e; printf 'workspace-cli 中文\\n'; git branch --show-current; node --version; cat README.txt"
                if MACOS:
                    read_command += "; /usr/bin/git --version; /usr/bin/xcrun --find git"
                self._send_tool_calls([
                    shell('read', command(read_command, "$ErrorActionPreference = 'Stop'; Write-Output 'workspace-cli 中文'; Write-Output ('shell-version:' + $PSVersionTable.PSVersion); git branch --show-current; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; node --version; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; Get-ChildItem -Force; Get-Content -LiteralPath README.txt -Encoding UTF8")),
                ])
            elif ordinal == 2:
                require(results['read']['outcome'] == 'completed', results['read'])
                require('workspace-cli 中文' in results['read']['output']['stdout'], 'Unicode output missing')
                require('workspace-read-ok' in results['read']['output']['stdout'], 'Workspace file was not read')
                require('workspace-test' in results['read']['output']['stdout'], 'Git did not read the workspace branch')
                if WINDOWS:
                    require('shell-version:' in results['read']['output']['stdout'], 'Shell version evidence missing')
                    print('[workspace-shell-cli] shell:', results['read']['output']['environment']['shell'])
                    print('[workspace-shell-cli] version:', next(line for line in results['read']['output']['stdout'].splitlines() if line.startswith('shell-version:')))
                if MACOS:
                    require('git version ' in results['read']['output']['stdout'], 'System Git did not execute')
                    require(any(line.endswith('/usr/bin/git') for line in results['read']['output']['stdout'].splitlines()), 'xcrun did not resolve the active Git tool')
                    require(not results['read']['output']['stderr'], results['read']['output']['stderr'])
                self._send_tool_calls([('plan', names['plan'], {
                    'title': 'Generate an output file', 'summary': 'Write only within build, then verify command results.',
                    'steps': [{'stepId': 'generate', 'title': 'Generate and verify', 'details': 'Exercise the workspace Shell.', 'verification': ['Output exists; unrelated paths remain unchanged.']}],
                    'mutationManifest': [{'workspace': 'primary', 'operation': SHELL, 'command': 'generate build output', 'writablePaths': [{'path': 'build', 'kind': 'directory'}]}],
                })])
            elif ordinal == 3:
                self._send_tool_calls([shell('write', command("mkdir -p build && printf 'generated 中文\\n' > build/output.txt && cat build/output.txt", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Directory -Force build | Out-Null; [IO.File]::WriteAllText((Join-Path (Get-Location) 'build/output.txt'), \"generated 中文`n\"); Get-Content build/output.txt")),
                    shell('readonly', command('printf unexpected > readonly.txt', "$ErrorActionPreference = 'Stop'; Set-Content readonly.txt unexpected")),
                ])
            elif ordinal == 4:
                require(results['write']['outcome'] == 'completed', results['write'])
                require(results['readonly']['outcome'] == 'failed', results['readonly'])
                require(results['readonly']['output']['exitCode'] != 0, 'Unapproved workspace path was writable')
                self._send_tool_calls([
                    shell('outside', command("printf unexpected > ../outside.txt", "$ErrorActionPreference = 'Stop'; Set-Content ../outside.txt unexpected")),
                    *([shell('outside_list', "$ErrorActionPreference = 'Stop'; Get-ChildItem ..")] if WINDOWS else []),
                    shell('outside_read', command("cat ../private.txt", "$ErrorActionPreference = 'Stop'; Get-Content ../private.txt")),
                ])
            elif ordinal == 5:
                require(results['outside']['outcome'] == 'failed', results['outside'])
                require(results['outside']['output']['exitCode'] != 0, 'Outside write reported success')
                if WINDOWS:
                    require(results['outside_list']['outcome'] == 'failed' and results['outside_list']['output']['exitCode'] != 0, 'Parent metadata grant allowed directory listing')
                require(results['outside_read']['outcome'] == 'failed', results['outside_read'])
                require(results['outside_read']['output']['exitCode'] != 0, 'Unapproved outside file was readable')
                require('outside-private-data' not in results['outside_read']['output']['stdout'], 'Outside contents were exposed')
                self._send_tool_calls([
                    shell('nonzero', command("printf 'expected-failure\\n'; exit 7", "Write-Output 'expected-failure'; exit 7")),
                    shell('pty', command('read -r value; printf "PTY:%s\\n" "$value"; test -t 0', "$value = [Console]::ReadLine(); Write-Output \"PTY:$value\"; if ([Console]::IsInputRedirected) { exit 9 }"), terminal={'stdin': 'hello-terminal\n'}),
                    shell('network', command(f"python3 - <<'PY'\nimport socket\ntry:\n    socket.create_connection(('127.0.0.1', {self.server.server_port}), timeout=2)\nexcept PermissionError:\n    print('offline-workspace')\nelse:\n    raise AssertionError('workspace connection was allowed')\nPY", f"$ErrorActionPreference = 'Stop'; $client = $null; try {{ $client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', {self.server.server_port}); throw 'workspace network was allowed' }} catch {{ if ($_.Exception.GetBaseException() -isnot [Net.Sockets.SocketException] -or $_.Exception.GetBaseException().SocketErrorCode -ne [Net.Sockets.SocketError]::AccessDenied) {{ throw }}; Write-Output 'offline-workspace' }} finally {{ if ($null -ne $client) {{ $client.Dispose() }} }}")),
                    shell('timeout', command('sleep 30 & wait', 'Start-Sleep -Seconds 30'), timeout=1),
                ])
            elif ordinal == 6:
                require(results['nonzero']['output']['exitCode'] == 7, results['nonzero'])
                require(results['pty']['outcome'] == 'completed' and results['pty']['output']['terminal'] is True, results['pty'])
                require('PTY:hello-terminal' in results['pty']['output']['stdout'], results['pty'])
                require(results['network']['outcome'] == 'completed', results['network'])
                require('offline-workspace' in results['network']['output']['stdout'], results['network'])
                require(results['timeout']['output']['timedOut'] is True, results['timeout'])
                self._send_tool_calls([('complete-stage', names['progress'], {
                    'items': [{'text': 'Generate and verify', 'status': 'completed'}],
                })])
            elif ordinal == 7:
                require(results['complete-stage'] == {'accepted': True}, 'Progress update was not accepted')
                self._send_text('workspace-shell-cli-complete')
            else:
                raise AssertionError(f'Unexpected Provider request {ordinal}')
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


class ShutdownProvider(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            ordinal, names, _ = self.provider_state.inspect(body)
            require(ordinal == 1, 'Shutdown must cancel the active Shell before another model call')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            self._send_tool_calls([('long-shell', names['bash'], {'command': command(
                'printf "managed-pid:%s\\n" "$$"; sleep 120',
                'Write-Output "managed-pid:$PID"; Start-Sleep -Seconds 120')})])
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def check_active_shutdown():
    require(WINDOWS, 'This PID probe verifies native Windows processes only')
    # Share the existing OS-level PID assertion, including its Windows handle probe.
    process_spec = importlib.util.spec_from_file_location('managed_process_check', Path(__file__).with_name('managed-process-cli.py'))
    process_check = importlib.util.module_from_spec(process_spec)
    process_spec.loader.exec_module(process_check)
    with tempfile.TemporaryDirectory(prefix='workspace-shutdown-', dir=fixture.ROOT / '.build-cache') as directory, ExitStack() as cleanup:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ShutdownProvider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cleanup.callback(lambda: require(not thread.is_alive(), 'Shutdown Provider fixture did not exit'))
        cleanup.callback(thread.join, timeout=3)
        cleanup.callback(server.server_close)
        cleanup.callback(server.shutdown)
        daemon = fixture.OwnedDaemon(root / 'config')
        cleanup.callback(daemon.close)
        fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
            **({'agent.windows.shell': 'auto'} if WINDOWS else {}),
        })
        daemon.start()
        session = fixture.create_session(daemon, workspace)['sessionId']
        environment = fixture.shell_environment(daemon)
        environment['DEEPCODE_CLI_RUN_TIMEOUT_MS'] = '180000'
        client = subprocess.Popen([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
            '--session', session, '--plain', 'ask', 'Run the long workspace Shell to verify owned Host shutdown.'],
            cwd=fixture.ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)

        def close_client():
            try:
                if client.poll() is None:
                    client.terminate()
                    client.wait(timeout=5)
            finally:
                client.stdout.close()
                client.stderr.close()
        cleanup.callback(close_client)

        def running_output():
            state.assert_healthy()
            for path in (daemon.config_root / 'data/agent-runtime/tool-record.outputs').rglob('stdout.log'):
                if 'managed-pid:' in path.read_text(encoding='utf-8'):
                    return path
            return None
        fixture.wait_until(running_output, 60 if WINDOWS else 15, 'Workspace Shell did not actually start')
        stop = subprocess.run([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel', 'stop-host'],
            cwd=fixture.ROOT, env=environment, capture_output=True, text=True, encoding='utf-8', timeout=100,
            creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
        require(stop.returncode == 0, stop.stdout + stop.stderr + daemon.log_tail())
        require(daemon.process.wait(timeout=10) == 0, daemon.log_tail())
        # The waiting CLI may observe the cancelled run or the closed connection.
        # Durable records and the OS process state are the settlement evidence.
        client.communicate(timeout=10)
        state.assert_healthy()
        with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
            events = [(kind, json.loads(payload)) for kind, payload in database.execute(
                'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
        records = [payload['record'] for kind, payload in events if kind == 'tool.completed']
        require(len(records) == 1 and records[0]['outcome'] == 'indeterminate'
                and records[0]['error']['code'] == 'tool_effect_outcome_unknown', records)
        require(records[0]['output']['executionScope'] == 'workspace', records[0])
        output = records[0]['output']
        require(output['success'] is False and output['timedOut'] is False, output)
        pid = int(next(line.removeprefix('managed-pid:') for line in output['stdout'].splitlines() if line.startswith('managed-pid:')))
        process_check.assert_pid_stopped(pid)
        # Stopping the service suspends the logical run for recovery; it does not
        # issue a user cancellation or manufacture a successful settlement.
        require(not any(kind == 'run.settled' and payload['outcome'] == 'completed' for kind, payload in events),
                'Stopped work was falsely reported as completed')
        print('[workspace-shell-cli] PASS: CLI stop-host during a running workspace Shell, physical PID exit, saved indeterminate effect and Host exit 0')


def main():
    status = json.loads(subprocess.check_output([str(fixture.DAEMON_BINARY), '--workspace-sandbox-status'], text=True, encoding='utf-8'))
    require(isinstance(status, dict) and isinstance(status.get('available'), bool), f'Invalid sandbox probe response: {status}')
    backend = status.get('backend')
    require(isinstance(backend, str) and backend.strip(), f'Sandbox probe backend is missing: {status}')
    if WINDOWS:
        require(backend == 'windows-lpac', f'LPAC launch/token check did not run: {status}')
    if not status['available']:
        reason = status.get('reason')
        require(isinstance(reason, str) and reason.strip(), f'Unavailable sandbox probe lacks its reason: {status}')
        print(f'[workspace-shell-cli] UNAVAILABLE ({backend}): {reason}', flush=True)
        return UNAVAILABLE_EXIT
    require(status.get('reason') is None, f'Available sandbox probe unexpectedly reported an error: {status}')
    # OS scratch is deliberately writable by macOS tools. Exercise project
    # boundaries outside that grant, while retaining disposable fixture ownership.
    scratch = fixture.ROOT / '.build-cache'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='workspace-shell-', dir=scratch) as directory:
        root = Path(directory); workspace = root / 'workspace'; workspace.mkdir()
        (root / 'private.txt').write_text('outside-private-data', encoding='utf-8')
        (workspace / 'README.txt').write_text('workspace-read-ok\n', encoding='utf-8')
        subprocess.run(['git', 'init', '-q', '-b', 'workspace-test', str(workspace)], check=True)
        if WINDOWS:
            # Elevated Windows creates Administrators-owned directories. The
            # LPAC intentionally disables that group; make the disposable Git
            # fixture belong to this user without changing Git's trust policy.
            identity = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], text=True)
            user_sid = next(csv.reader(identity.strip().splitlines()))[1]
            subprocess.run(['icacls', str(workspace), '/setowner', '*' + user_sid, '/T', '/Q'],
                           check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.external': 'ask',
                **({'agent.windows.shell': 'auto'} if WINDOWS else {}),
            })
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Inspect this workspace and generate the authorized output.', expected=5,
                        run_timeout_seconds=60 if WINDOWS else 15)
            state.assert_healthy()
            waiting = fixture.projection(daemon, session)
            require(waiting['pendingApproval'] is None and waiting['pendingPlan'] is not None, 'Read-only Shell should continue directly to the Plan')
            require(len(state.requests) == 2, 'Provider did not advance after the read-only Shell')
            require(not (workspace / 'build/output.txt').exists(), 'Output created before Plan confirmation')
            result = fixture.cli(daemon, session, '/reply 1', run_timeout_seconds=240 if WINDOWS else 15)
            state.assert_healthy()
            require('workspace-shell-cli-complete' in result.stdout, result.stdout)
            require((workspace / 'build/output.txt').read_text(encoding='utf-8') == 'generated 中文\n', 'Output file mismatch')
            require(not (root / 'outside.txt').exists(), 'Outside file was modified')
            require(not (workspace / 'readonly.txt').exists(), 'Plan sandbox allowed an undeclared workspace file')
            projection = fixture.projection(daemon, session)
            require(projection['run']['status'] == 'completed', projection['run'])
            require(projection['todoList']['items'] == [{'text': 'Generate and verify', 'status': 'completed'}],
                    'Projection did not preserve the submitted progress')
            with closing(sqlite3.connect(f'{(daemon.config_root / "data/agent-runtime/session.sqlite3").as_uri()}?mode=ro', uri=True)) as database:
                require(database.execute("select count(*) from session_events where event_type='approval.requested'").fetchone()[0] == 0, 'Sandboxed reads and Plan-authorized writes must not request Host approval')
                runtime = json.loads(database.execute("select payload_json from session_events where event_type='run.started' order by sequence limit 1").fetchone()[0])['runtimeSnapshot']
                print('[workspace-shell-cli] selected environment:', json.dumps(runtime['environment']['shell']))
            daemon.shutdown()
            print('[workspace-shell-cli] PASS: read-only Shell without approval, confirmed directory grant, unapproved workspace path rejection, Unicode write, outside read/write rejection, exit 7, real PTY, offline policy, timeout, final settlement and owned Host shutdown; 7 fixture Provider requests.')
        except BaseException:
            print(daemon.log_tail())
            store = daemon.config_root / 'data/agent-runtime/session.sqlite3'
            if store.exists():
                with closing(sqlite3.connect(f'{store.as_uri()}?mode=ro', uri=True)) as database:
                    for kind, payload in database.execute("select event_type,payload_json from session_events where event_type in ('tool.requested','tool.started','tool.completed','run.settled') order by sequence"):
                        print(kind, payload[:4000])
            state.assert_healthy()
            raise
        finally:
            try:
                daemon.close()
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=3)
                require(not thread.is_alive(), 'Provider fixture did not exit')

    if WINDOWS:
        check_active_shutdown()


if __name__ == '__main__':
    raise SystemExit(main())
