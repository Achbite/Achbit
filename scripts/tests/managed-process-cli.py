#!/usr/bin/env python3
"""Exercise run-owned process control through CLI, Session and real Kernel processes."""
from contextlib import ExitStack, closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

spec = importlib.util.spec_from_file_location('deepcode_test_support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
CONTAINER = os.environ.get('DEEPCODE_E2E_PROCESS_CONTAINER')
SHELL = 'container' if CONTAINER else 'powershell' if os.name == 'nt' else 'bash'
LONG_COMMAND = ('Write-Output "managed-pid:$PID"; Start-Sleep -Seconds 120' if os.name == 'nt'
                else 'printf "managed-pid:%s\\n" "$$"; trap "" TERM; while :; do sleep 1; done')
SHORT_COMMAND = ('Start-Sleep -Seconds 2; Write-Output "managed-complete"' if os.name == 'nt'
                 else 'sleep 2; printf "managed-complete\\n"')


def execution_input(command, timeout=None):
    value = {'command': command}
    if CONTAINER:
        value.update(action='exec', container=CONTAINER, reason='Verify control of this isolated test container.')
    else:
        value['requestHostPermission'] = 'Verify control of this owned test process.'
    if timeout is not None:
        value['timeout'] = timeout
    return value


def assert_stopped(job):
    require(job['status'] in ('cancelled', 'failed'), job)
    result = job['result']
    require(result['success'] is False, result)
    log = Path(result['fullOutput']['stdout']['path'])
    require(log.is_file() and 'managed-pid:' in log.read_text(), 'Cancelled output archive missing')
    pid = int(next(line.removeprefix('managed-pid:') for line in log.read_text().splitlines()
                   if line.startswith('managed-pid:')))
    assert_pid_stopped(pid, container=CONTAINER)


def assert_pid_stopped(pid, *, container=None):
    if container:
        result = subprocess.run(['docker', 'exec', container, 'sh', '-c', 'kill -0 "$1" 2>/dev/null', 'probe', str(pid)], capture_output=True, timeout=10)
        require(result.returncode == 1, 'Cancelled process is still alive in the container')
        result = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', container], capture_output=True, text=True, timeout=10)
        require(result.returncode == 0 and result.stdout.strip() == 'true', 'Kernel stopped the externally owned container')
    elif os.name == 'nt':
        import ctypes
        from ctypes import wintypes

        require(0 < pid <= 0xFFFFFFFF, f'Invalid managed process ID: {pid}')
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION; never signal or kill the PID.
        handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)
        if not handle:
            error = ctypes.get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER: the process no longer exists.
                return
            raise ctypes.WinError(error)
        try:
            status = kernel.WaitForSingleObject(handle, 0)
            if status == 0xFFFFFFFF:  # WAIT_FAILED
                raise ctypes.WinError(ctypes.get_last_error())
            require(status == 0, f'Cancelled process {pid} is still alive (wait status {status})')
        finally:
            if not kernel.CloseHandle(handle):
                raise ctypes.WinError(ctypes.get_last_error())
    else:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError(f'Cancelled process {pid} is still alive')


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            ordinal, _, results = state.inspect(body)
            name = next(tool['function']['name'] for tool in body['tools']
                        if tool['function']['parameters'].get('properties', {}).get('action', {}).get('enum')
                        == ['start', 'wait', 'status', 'cancel'])
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()

            def call(call_id, **arguments):
                self._send_tool_calls([(call_id, name, arguments)])

            if ordinal == 1:
                call('start-long', action='start', tool=SHELL, input=execution_input(LONG_COMMAND))
            elif ordinal == 2:
                job = results['start-long']['output']['job']
                require(job['status'] == 'active', 'Start receipt was treated as execution success')
                state.job_id = job['jobId']
                call('wait-checkpoint', action='wait', jobId=state.job_id, waitSeconds=1)
            elif ordinal == 3:
                job = results['wait-checkpoint']['output']['job']
                require(job['status'] == 'active' and 'managed-pid:' in job['output']['stdout'], job)
                if state.mode == 'user-stop':
                    self._send_text('process-progress')
                else:
                    call('cancel-long', action='cancel', jobId=state.job_id)
            elif ordinal == 4 and state.mode == 'complete':
                job = results['cancel-long']['output']['job']
                require(job['status'] == 'cancelled', job)
                assert_stopped(job)
                call('start-timeout', action='start', tool=SHELL, input=execution_input(LONG_COMMAND, timeout=1))
            elif ordinal == 5 and state.mode == 'complete':
                call('wait-timeout', action='wait', jobId=results['start-timeout']['output']['job']['jobId'])
            elif ordinal == 6 and state.mode == 'complete':
                job = results['wait-timeout']['output']['job']
                require(job['status'] == 'failed' and job['result']['timedOut'] is True, job)
                assert_stopped(job)
                call('start-short', action='start', tool=SHELL, input=execution_input(SHORT_COMMAND))
            elif ordinal == 7 and state.mode == 'complete':
                self._send_text('process-progress')
            elif ordinal == 8 and state.mode == 'complete':
                job_id = results['start-short']['output']['job']['jobId']
                updates = [value['process'] for value in fixture.json_payloads(body)
                           if value.get('type') == 'process.updated'
                           and value.get('process', {}).get('jobId') == job_id]
                require(updates, 'The completed process must have its own process.updated fact')
                job = updates[-1]
                require(job['status'] == 'completed' and 'managed-complete' in job['output']['stdout'], job)
                require(job['result']['exitCode'] == 0, job)
                self._send_text('managed-process-cli-complete')
            else:
                raise AssertionError(f'Unexpected model call {ordinal}: {state.mode}')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check(mode):
    with tempfile.TemporaryDirectory(prefix='deepcode-managed-cli-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.mode = mode
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'user')
        client = None
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {})
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': 'ask', 'agent.permissions.shellAccess': 'full',
            }))
            command = [str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                       '--session', session, '--plain', '--plugin', 'plugin://processes@builtin']
            if CONTAINER:
                command.extend(['--plugin', 'plugin://containers@builtin'])
            command.extend(['ask', 'Start and control the requested test processes.'])
            initial = subprocess.run(command, cwd=fixture.ROOT, env=fixture.shell_environment(daemon),
                                     capture_output=True, text=True, encoding='utf-8', timeout=30)
            state.assert_healthy()
            require(initial.returncode == 5, initial.stdout + initial.stderr)
            waiting = fixture.projection(daemon, session)
            require(waiting['pendingApproval'] and not any(activity.get('tool', {}).get('process')
                    for activity in waiting['activities']), 'Process started before permission')
            scope = 'allow-container-run' if CONTAINER else 'allow-host-run'
            reply = command[:7] + ['ask', '/reply ' + scope]
            client = subprocess.Popen(reply, cwd=fixture.ROOT, env=fixture.shell_environment(daemon),
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
            if mode == 'user-stop':
                def running():
                    state.assert_healthy()
                    current = fixture.projection(daemon, session)
                    return current if len(state.requests) == 3 and any(
                        message.get('content') == 'process-progress' for message in current['messages']) and any(
                        activity.get('tool', {}).get('process') and activity['status'] == 'active'
                        for activity in current['activities']) else None
                current = fixture.wait_until(running, 12, 'Managed process did not become observable')
                require(current['run']['status'] == 'running' and client.poll() is None,
                        'Generated text must not settle the run while its process is active')
                reply = fixture.api_json(daemon.base_url, f'/api/conversation/sessions/{session}/commands',
                    token=daemon.token, method='POST', timeout=15, body={
                        'schemaVersion': fixture.COMMAND_VERSION, 'type': 'run.cancel',
                        'commandId': 'command:stop-managed-run', 'sessionId': session, 'runId': current['run']['runId'],
                    })
                require(reply['status'] == 'accepted', reply)
            stdout, stderr = client.communicate(timeout=25)
            state.assert_healthy()
            require(client.returncode == (8 if mode == 'user-stop' else 0), stdout + stderr)
            done = fixture.projection(daemon, session)
            require(done['run']['status'] == ('cancelled' if mode == 'user-stop' else 'completed'), done['run'])
            processes = [activity for activity in done['activities'] if activity.get('tool', {}).get('process')]
            require(processes and all(activity['status'] != 'active' and not activity['tool'].get('projectionError')
                                      for activity in processes), processes)
            if mode == 'complete':
                require('managed-process-cli-complete' in stdout and len(state.requests) == 8, stdout)
            require(sum(message.get('content') == 'process-progress' for message in done['messages']) == 1,
                    'Valid generated text must persist while owned processes prevent settlement')
            daemon.shutdown()
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
                events = [(kind, json.loads(payload)) for kind, payload in database.execute(
                    'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            jobs = [payload['job'] for kind, payload in events if kind == 'process.updated']
            if mode == 'user-stop':
                assert_stopped(jobs[-1])
            release_indices = [index for index, (kind, _) in enumerate(events) if kind == 'run.runtime.released']
            settlement_indices = [index for index, (kind, _) in enumerate(events) if kind == 'run.settled']
            require(len(release_indices) == len(settlement_indices) == 1, 'Run must release and settle exactly once')
            terminal_indices = [index for index, (kind, payload) in enumerate(events)
                                if kind == 'process.updated' and payload['job']['status'] != 'active']
            require(terminal_indices and max(terminal_indices) < release_indices[0] < settlement_indices[0],
                    'Owned process termination must precede runtime release and settlement')
            if mode == 'complete':
                finishing_indices = [index for index, (kind, _) in enumerate(events) if kind == 'run.finishing']
                require(len(finishing_indices) == 1 and max(terminal_indices) < finishing_indices[0] < release_indices[0],
                        'Run must not finish before owned processes end')
                final_message_id = events[settlement_indices[0]][1]['finalMessageId']
                require(any(kind == 'message.committed' and payload.get('messageId') == final_message_id
                            and payload.get('content') == 'managed-process-cli-complete' for kind, payload in events),
                        'Settlement must reference the answer generated after the process result')
            print(f'[managed-process-cli] PASS: {mode}, actual process exit, archived output, shared projection, {len(state.requests)} model calls, owned shutdown')
        except BaseException:
            print(daemon.log_tail())
            state.assert_healthy()
            raise
        finally:
            with ExitStack() as cleanup:
                cleanup.callback(lambda: require(not thread.is_alive(), 'Provider fixture did not exit'))
                cleanup.callback(thread.join, timeout=3)
                cleanup.callback(server.server_close)
                cleanup.callback(server.shutdown)
                if client is not None and client.poll() is None:
                    cleanup.callback(client.wait, timeout=5)
                    cleanup.callback(client.terminate)
                cleanup.callback(daemon.close)


if __name__ == '__main__':
    check('complete')
    check('user-stop')
