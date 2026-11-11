#!/usr/bin/env python3
"""Confirmed manual update cancels a real waiting Session before Host shutdown."""
from contextlib import closing
import http.server
import importlib.util
import json
from pathlib import Path
import tempfile
import threading

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


if __name__ == '__main__':
    run()
