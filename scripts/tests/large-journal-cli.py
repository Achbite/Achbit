#!/usr/bin/env python3
"""Complete large canonical events through the real Session/HTTP/SQLite path."""
from contextlib import closing
import http.server
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import urllib.parse

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
LARGE_OUTPUT = 'output begins\n' + '保留原始结果。' * 170000 + '\noutput ends'


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            self.provider_state.requests.append(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream; charset=utf-8')
            self.send_header('connection', 'close')
            self.end_headers()
            content = LARGE_OUTPUT if len(self.provider_state.requests) == 1 else 'Host still serves the next run.'
            # Real Providers stream bounded frames; the assembled journal fact is large.
            for offset in range(0, len(content), 8192):
                self._send_payload({'choices': [{'index': 0, 'delta': {'content': content[offset:offset + 8192]},
                                                 'finish_reason': None}]})
            self._send_payload({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}],
                                'usage': fixture.provider_usage()})
            self._send_done()
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def run():
    require(len(LARGE_OUTPUT.encode()) > 2 * 1024 * 1024,
            'Regression must cross the former journal HTTP body limit')
    with tempfile.TemporaryDirectory(prefix='achbit-large-journal-') as directory:
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
            profiles_path = daemon.config_root / 'config/user/local/settings/llm-profiles.json'
            profiles = json.loads(profiles_path.read_text())
            profiles['profiles'][0]['contextWindowTokens'] = 4_194_304
            profiles_path.write_text(json.dumps(profiles))
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            path = '/api/conversation/sessions/' + urllib.parse.quote(session, safe='') + '/commands'
            reply = fixture.api_json(daemon.base_url, path, token=daemon.token, method='POST', timeout=30, body={
                'schemaVersion': fixture.COMMAND_VERSION, 'type': 'message.submit', 'commandId': 'command:large',
                'sessionId': session, 'text': 'Return the complete large result.', 'filesystemReferences': [], 'pluginSelections': [],
            })
            require(reply['status'] == 'accepted', 'Large command was rejected')
            fixture.wait_completed(daemon, state, session, 'large journal settlement')
            fixture.cli(daemon, session, 'Continue after the large result.', run_timeout_seconds=30)
            state.assert_healthy()
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as db:
                events = [(kind, json.loads(payload)) for kind, payload in db.execute(
                    'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            messages = [payload for kind, payload in events if kind == 'message.committed']
            require(any(payload.get('role') == 'assistant' and payload.get('content') == LARGE_OUTPUT for payload in messages),
                    'Large assistant content was not persisted exactly')
            require([p['outcome'] for kind, p in events if kind == 'run.settled'] == ['completed', 'completed'],
                    'Large journal writes prevented normal settlement or subsequent work')
            require(len(state.requests) == 2, 'Journal handling replayed a Provider request')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 2, 'Each run must release exactly once')
            print('[large-journal-cli] PASS: full >2 MiB results and subsequent context, two settled runs, no replay, live Host')
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    run()
