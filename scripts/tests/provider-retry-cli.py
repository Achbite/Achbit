#!/usr/bin/env python3
"""Truncated HTTP bodies -> Session retries -> Kernel approval -> one CLI run."""
from contextlib import closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
COMMAND = "[IO.File]::AppendAllText((Join-Path (Get-Location) 'approved.txt'), \"approved`n\")" if os.name == 'nt' else "printf 'approved\\n' >> approved.txt"
PARTIAL_COMMAND = "Set-Content partial.txt unexpected" if os.name == 'nt' else "printf unexpected > partial.txt"


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            ordinal, names, results = state.inspect(body)
            require(ordinal <= 4, 'Retry or continuation sent an extra Agent request')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            if ordinal <= 2:
                # A valid HTTP chunk followed by EOF without its terminating zero chunk.
                # This exercises the real transport diagnostic, not a mocked retry flag.
                self.send_header('transfer-encoding', 'chunked')
                self.end_headers()
                payload = {'choices': [{'index': 0, 'delta': {
                    'content': 'Discard this incomplete answer.',
                    'tool_calls': [{'index': 0, 'id': f'partial-{ordinal}', 'type': 'function', 'function': {
                        'name': names['bash'], 'arguments': json.dumps({'command': PARTIAL_COMMAND}),
                    }}],
                }, 'finish_reason': None}]}
                chunk = ('data: ' + json.dumps(payload) + '\n\n').encode()
                self.wfile.write(f'{len(chunk):x}\r\n'.encode() + chunk + b'\r\n')
                self.wfile.flush()
                self.close_connection = True
            elif ordinal == 3:
                self.end_headers()
                self._send_tool_calls([('approved-command', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Append the requested line after user approval.',
                })])
            else:
                self.end_headers()
                require(set(results) == {'approved-command'}, 'Incomplete attempts entered tool history')
                require(results['approved-command']['outcome'] == 'completed', results)
                self._send_text('retry-approval-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def events(daemon, session):
    with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
        return [dict(sequence=seq, runId=run, callId=call, type=kind, payload=json.loads(payload))
                for seq, run, call, kind, payload in database.execute(
                    'SELECT sequence,run_id,call_id,event_type,payload_json FROM session_events '
                    'WHERE session_id=? ORDER BY sequence', (session,))]


def run():
    with tempfile.TemporaryDirectory(prefix='deepcode-provider-retry-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {})
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': 'ask', 'agent.permissions.shellAccess': 'full',
            }))
            fixture.cli(daemon, session, 'Append approved to approved.txt once after permission is granted.', expected=5)
            state.assert_healthy()
            waiting = fixture.projection(daemon, session)
            run_id = waiting['run']['runId']
            require(waiting['run']['status'] == 'waiting' and waiting['run']['waitingReason'] == 'approval',
                    'Retry success or pending permission was treated as a failed/finished run')
            approval = waiting['pendingApproval']
            require(approval is not None, 'The recovered command bypassed user approval')
            require(not (workspace / 'approved.txt').exists() and not (workspace / 'partial.txt').exists(),
                    'A partial attempt or unapproved command executed')
            require(len(state.requests) == 3, 'The second network failure prematurely stopped retries')
            for request in state.requests[1:]:
                require(request['messages'] == state.requests[0]['messages']
                        and request['tools'] == state.requests[0]['tools'], 'Retry changed the logical request')

            journal = events(daemon, session)
            require(not any(event['type'] in ('tool.started', 'run.runtime.released', 'run.settled') for event in journal),
                    'Waiting for approval started a tool or terminated the Loop')
            attempts = [event['payload'] for event in journal if event['type'] == 'provider.attempt.updated']
            started = [attempt for attempt in attempts if attempt['phase'] == 'started']
            require([attempt['attempt'] for attempt in started] == [1, 2, 3], 'Missing retry attempt')
            require(len({attempt['providerRequestId'] for attempt in started}) == 1
                    and len({attempt['providerAttemptId'] for attempt in started}) == 3,
                    'Retries lost their shared request or distinct attempt identity')
            failures = [attempt for attempt in attempts if attempt['phase'] == 'failed']
            retries = [attempt for attempt in attempts if attempt['phase'] == 'retryWaiting']
            require(len(failures) == len(retries) == 2, 'Network failure or retry facts were lost')
            for failure, retry in zip(failures, retries):
                error = failure['error']
                diagnostics = error['diagnostics']
                require(error['code'] == 'provider_stream_read_failed' and diagnostics['phase'] == 'responseBody'
                        and diagnostics['category'] == 'network' and diagnostics['retryable'] is True
                        and any(cause.get('kind') == 'UnexpectedEof' for cause in diagnostics['causes']),
                        'Truncated response lost the original transient EOF diagnostic')
                require(retry['error'] == error, 'Retry replaced the original error')

            reply = fixture.cli(daemon, session, '/reply 1')
            state.assert_healthy()
            done = fixture.projection(daemon, session)
            require(done['run']['runId'] == run_id and done['run']['status'] == 'completed',
                    'Approval failed to resume and complete the same run')
            require(done['pendingApproval'] is None and not done.get('failureSnapshot'), 'Stale wait or failure remained')
            require('retry-approval-complete' in reply.stdout and len(state.requests) == 4,
                    'The CLI did not receive the post-tool answer exactly once')
            require((workspace / 'approved.txt').read_text() == 'approved\n' and not (workspace / 'partial.txt').exists(),
                    'Tool effects were missing, duplicated or included an incomplete attempt')
            require(all('Discard this incomplete answer.' not in message['content'] for message in done['messages']),
                    'Incomplete Provider text entered the completed conversation')

            daemon.shutdown()
            state.assert_healthy()
            journal = events(daemon, session)
            def single(kind):
                matching = [event for event in journal if event['type'] == kind]
                require(len(matching) == 1, f'Expected exactly one {kind}, got {len(matching)}')
                return matching[0]
            require(single('run.started')['runId'] == run_id, 'Approval restarted the Loop')
            require(single('approval.requested')['callId'] == approval['callId'], 'An incomplete attempt requested approval')
            require(single('approval.resolved')['sequence'] < single('tool.started')['sequence']
                    < single('run.runtime.released')['sequence'] < single('run.settled')['sequence'],
                    'Approval, execution, release and settlement were out of order')
            require(single('tool.requested')['callId'] == approval['callId'], 'Incomplete tools were dispatched')
            require(len(state.title_requests) == 1, 'Auxiliary title request was not independently served')
            print('[provider-retry-cli] PASS: two real HTTP EOF failures, three attempts on one request, no partial effects, '
                  'CLI waits for approval, one execution and same-run settlement with owned cleanup')
        except BaseException:
            print(daemon.log_tail())
            state.assert_healthy()
            raise
        finally:
            try:
                daemon.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == '__main__':
    run()
