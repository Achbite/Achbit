#!/usr/bin/env python3
"""Verified Host shutdown: active work, unknown activity and failed execution initialization."""
from contextlib import closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            ordinal, _, _ = self.provider_state.inspect(body)
            interactions = [tool['function']['name'] for tool in body['tools']
                            if {'mode', 'kind', 'prompt', 'allowFreeform'} <= tool['function']['parameters'].get('properties', {}).keys()]
            require(len(interactions) == 1, 'Expected one interaction tool in the current wire catalog')
            require(ordinal == 1, 'Update cancellation started another model request')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            self._send_tool_calls([('question', interactions[0], {
                'mode': 'wait', 'kind': 'question', 'prompt': 'Continue?', 'allowFreeform': True,
            })])
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def run():
    with tempfile.TemporaryDirectory(prefix='achbit-host-update-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'state')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {})
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Wait for my answer.', expected=5)
            state.assert_healthy()
            def update(action, **extra):
                return fixture.api_json(daemon.base_url, '/api/host/update', token=daemon.token, method='POST',
                                        body=dict(action=action, expectedIdentity=daemon.identity, **extra), timeout=90)
            require(update('status')['active'] is True, 'Waiting Session was reported idle')
            require(update('quitStatus') == {'status': 'ready', 'active': True}, 'Explicit quit did not report the waiting task')
            require(update('prepare')['prepared'] is False, 'Automatic update stopped a busy Host')
            require(update('prepare', manual=True)['reason'] == 'tasks', 'Unconfirmed manual update stopped work')
            prepared = update('prepare', manual=True, confirmed=True)
            require(prepared['prepared'] is True, 'Confirmed update was blocked by a persistent Host or pending question')
            require(update('abort', token=prepared['token'])['aborted'] is True, 'Preparation could not be cancelled')
            require(fixture.projection(daemon, session)['run']['status'] == 'waiting', 'Cancelled preparation ended the task')
            prepared = update('prepare', manual=True, confirmed=True)
            receipt = update('commit', token=prepared['token'])
            require(receipt['cleanupComplete'] is True and receipt['identity'] == daemon.identity, 'Update did not clean up its Host')
            require(daemon.process.wait(timeout=10) == 0, 'Host did not exit normally')
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as db:
                events = [(kind, json.loads(payload)) for kind, payload in db.execute(
                    'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            require([p['outcome'] for kind, p in events if kind == 'run.settled'] == ['cancelled'], 'Task shutdown was not settled as cancellation')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Runtime was not released exactly once')
            require(len(state.requests) == 1, 'Update replayed the model turn')
            state.assert_healthy()
            print('[host-update-cli] PASS: busy status, confirmation gate, reversible preparation, cancelled Session and clean Host exit')
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def failed_start_quit(via_cli):
    # Leave the catalog and discovery publication intact. Only the execution store fails to open.
    with tempfile.TemporaryDirectory(prefix='achbit-host-quit-failed-') as directory:
        root = Path(directory)
        (root / 'data/agent-runtime/tool-record.sqlite3').mkdir(parents=True)
        daemon = fixture.OwnedDaemon(root)
        try:
            with patch.dict(os.environ, {'ACHBIT_HOST_LIFETIME': 'automatic'}):
                daemon.start(wait_for_execution=False)
            def readiness():
                return fixture.api_json(daemon.base_url, '/api/host/readiness', token=daemon.token)
            failed = fixture.wait_until(lambda: (r if (r := readiness())['kernel'] == 'failed' else None), 10,
                                        'Failed execution never published its terminal initialization result')
            original = failed['runtimeError']
            require(original['code'] and original['message'] and failed['session'] == 'failed', 'No original failure')
            def update(action, identity):
                return fixture.api_envelope(daemon.base_url, '/api/host/update', token=daemon.token, method='POST',
                                            body={'action': action, 'expectedIdentity': identity})
            # Attach as a desktop (the GUI binds on catalog readiness), then close only its socket.
            request = urllib.request.Request(f'{daemon.base_url}/api/host/client?mode=client&desktop=true',
                                             headers={fixture.HOST_TOKEN_HEADER: daemon.token})
            with fixture.URL_OPENER.open(request, timeout=3) as stream:
                require(stream.readline().strip() == b'attached', 'Desktop was not registered')
            if via_cli:
                environment = {**os.environ, 'ACHBIT_USER_ROOT': str(root), 'ACHBIT_KERNEL_AUTO_START': '1'}
                command = [str(fixture.CLI_BINARY), '--host-data-dir', str(root / 'data')]
                ordinary = subprocess.run([*command, 'status'], capture_output=True, text=True, env=environment, timeout=10)
                require(ordinary.returncode != 0 and original['code'] in ordinary.stderr,
                        f'Ordinary CLI lost its original health gate: {ordinary.stderr}')
                stop = subprocess.run([*command, 'stop-host'], capture_output=True, text=True, env=environment, timeout=15)
                require(stop.returncode == 0 and original['code'] in stop.stderr,
                        f'stop-host could not close its failed instance while retaining the failure: {stop.stderr}')
            else:
                # Ordinary update admission still fails; quit management is explicitly separate.
                require(not update('status', daemon.identity)['ok'], 'Failed initialization was reported as idle')
                conflict = update('quitStatus', {**daemon.identity, 'pid': daemon.identity['pid'] + 1})
                require(conflict.get('error') == 'host_identity_conflict', 'Quit preflight accepted the wrong identity')
                checked = update('quitStatus', daemon.identity)
                require(checked.get('data') == {'status': 'initializationFailed', **original},
                        f'Explicit quit could not distinguish the failed runtime: {checked}')
                require(readiness()['runtimeError'] == original, 'Quit preflight stopped the Host or erased its error')
                receipt = fixture.api_json(daemon.base_url, '/api/host/shutdown?cancelActiveRuns=true', token=daemon.token,
                                           method='POST', body={'expectedIdentity': daemon.identity})
                require(receipt['accepted'] and receipt['identity'] == daemon.identity and receipt['cleanupComplete'] is True,
                        f'Incorrect shutdown receipt: {receipt}')
            require(daemon.process.wait(timeout=10) == 0, 'Failed Host did not exit normally')
            print(f"[host-quit] PASS: {'CLI' if via_cli else 'desktop control'} stopped the exact failed Host; {original['code']}")
        finally:
            daemon.close()


def unknown_quit_activity():
    # The real Session bridge's factory hook gives us a deterministic startup boundary, then
    # an ordinary activity failure from a successfully initialized service, not a failed Host.
    with tempfile.TemporaryDirectory(prefix='achbit-host-quit-unknown-') as directory:
        root = Path(directory)
        gate = root / 'start'
        module = root / 'service.mjs'
        module.write_text(f"""import {{ existsSync }} from 'node:fs';
import {{ setTimeout as delay }} from 'node:timers/promises';
import {{ createSessionService as real }} from {json.dumps((fixture.SESSION_BRIDGE.parent / 'local-agent/service.js').as_uri())};
export async function createSessionService(input) {{
  while (!existsSync({json.dumps(str(gate))})) await delay(10);
  const service = await real(input);
  service.activity = async () => {{ throw new Error('fixture_activity_unavailable'); }};
  return service;
}}
""")
        daemon = fixture.OwnedDaemon(root / 'state')
        try:
            with patch.dict(os.environ, {'ACHBIT_SESSION_SERVICE_MODULE': str(module)}):
                daemon.start(wait_for_execution=False)
            def preflight():
                return fixture.api_envelope(daemon.base_url, '/api/host/update', token=daemon.token, method='POST',
                                            body={'action': 'quitStatus', 'expectedIdentity': daemon.identity})
            starting = preflight()
            require(not starting['ok'] and 'still starting' in starting['message'], f'Quit admitted a starting Host: {starting}')
            gate.touch()
            require(fixture.api_json(daemon.base_url, '/api/health', token=daemon.token)['session'] == 'ready', 'Host did not become ready')
            unknown = preflight()
            require(not unknown['ok'] and 'fixture_activity_unavailable' in unknown['message'],
                    f'Quit turned an activity error into a known state: {unknown}')
            stop = subprocess.run([str(fixture.CLI_BINARY), '--host-data-dir', str(daemon.config_root / 'data'), 'stop-host'],
                                  capture_output=True, text=True, timeout=10)
            require(stop.returncode != 0 and 'fixture_activity_unavailable' in stop.stderr and daemon.process.poll() is None,
                    f'Activity failure was lost or stopped a running Host: {stop.stderr}')
            print('[host-quit] PASS: startup and activity failure stay errors; live Host was not stopped')
        finally:
            gate.touch(exist_ok=True)
            daemon.close()


if __name__ == '__main__':
    run()
    for cli_stop in [False, True]:
        failed_start_quit(cli_stop)
    unknown_quit_activity()
