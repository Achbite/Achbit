#!/usr/bin/env python3
"""Verify user commands, delegated review and Kernel execution through the real CLI."""
from contextlib import ExitStack, closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import shlex
import time

spec = importlib.util.spec_from_file_location('achbit_test_support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
COMMAND = "[IO.File]::AppendAllText((Join-Path (Get-Location) 'approved.txt'), \"approved`n\")" if os.name == 'nt' else "printf 'approved\\n' >> approved.txt"


def title_request(body):
    messages = body.get('messages', [])
    return bool(messages and messages[0].get('content', '').startswith('Name this conversation from the user'))


def execution_review_request(body, *, decision_only=False):
    if body.get('model') != 'mock-reviewer':
        return False
    names = sorted(tool['function']['name'] for tool in body.get('tools', []))
    require(names == ([] if decision_only else ['fs_read', 'session_read']),
            f'Unexpected execution reviewer tool authority: {names}')
    if decision_only:
        response_format = body.get('response_format', {})
        require(response_format.get('type') == 'json_schema'
                and response_format.get('json_schema', {}).get('name') == 'execution_permission_decision',
                'The reviewer correction did not request a structured decision')
    return True


def configure_review(daemon, server, profile_id):
    fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {})
    settings_root = daemon.config_root / 'config/user/local/settings'
    profiles_path = settings_root / 'llm-profiles.json'
    profiles = json.loads(profiles_path.read_text(encoding='utf-8'))
    profiles['profiles'].append(dict(profiles['profiles'][0], id='e2e-reviewer', name='Approval reviewer',
                                    model='mock-reviewer', thinking='enabled', reasoningEffort='high'))
    profiles_path.write_text(json.dumps(profiles), encoding='utf-8')
    (settings_root / 'user-settings.json').write_text(json.dumps({
        'agent.approvalReview.profileId': profile_id, 'agent.approvalReview.reasoningEffort': 'xhigh',
    }), encoding='utf-8')


def stored_events(daemon, session):
    with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
        return [(kind, json.loads(payload)) for kind, payload in database.execute(
            'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if title_request(body):
                self._send_text('Permission validation')
                return
            if execution_review_request(body):
                state.reviews += 1
                require(state.mode == 'review', 'Review ran without user delegation')
                require(body['model'] == 'mock-reviewer', 'The selected approval model was not used')
                require(body.get('reasoning_effort') == 'xhigh', 'The independent reviewer reasoning setting was not used')
                review = json.loads(body['messages'][-1]['content'])
                require(review['operation']['arguments']['command'] == COMMAND, 'Review did not receive the actual command')
                require(review['grant'] == 'thisCallOnly', 'Review changed the permission lifetime')
                require(review['reviewPolicy']['subject'] == 'shell' and review['reviewPolicy']['mode'] == 'review',
                        'Review did not receive the applicable Kernel Shell policy')
                require('networkEnvironment' not in review['requestedAccess']['environment'],
                        'Host network metadata created a second authorization binding')
                self._send_text(json.dumps({'decision': 'allow', 'reason': 'The user requested this exact file operation in the delegated environment.'}))
                return
            ordinal, names, results = state.inspect(body)
            if ordinal <= 2:
                if ordinal == 2:
                    first = results['first']
                    if state.mode == 'ask':
                        require(first.get('grantedScope') == 'runCommand', first)
                        first = first['result']
                    require(first['exitCode'] == 0, first)
                self._send_tool_calls([('first' if ordinal == 1 else 'repeat', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Write the file explicitly requested by the user.',
                    'requestNetworkPermission': 'Retain the redundant network request from the original Host approval regression.',
                })])
            else:
                require(results['repeat']['exitCode'] == 0, results['repeat'])
                self._send_text('permission-delegation-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_mode(mode):
    with tempfile.TemporaryDirectory(prefix=f'achbit-permission-{mode}-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.mode, state.reviews = mode, 0
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            configure_review(daemon, server, 'e2e-reviewer')
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': mode, 'agent.permissions.shellAccess': 'full',
            }))
            result = fixture.cli(daemon, session, 'Append approved to approved.txt twice, using the same command.', expected=5 if mode == 'ask' else 0)
            state.assert_healthy()
            if mode == 'ask':
                pending = fixture.projection(daemon, session)
                require(pending['pendingApproval'] is not None, 'No pending user approval')
                require(not (workspace / 'approved.txt').exists(), 'Command executed before user approval')
                require(state.reviews == 0, 'Ask unexpectedly invoked a reviewer')
                result = fixture.cli(daemon, session, '/reply 3')
            state.assert_healthy()
            require('permission-delegation-complete' in result.stdout, result.stdout)
            require((workspace / 'approved.txt').read_text() == 'approved\napproved\n', 'Actual command did not run exactly twice')
            done = fixture.projection(daemon, session)
            require(done['run']['status'] == 'completed' and not done['shellAuthorizations'], 'Run grant remained active after settlement')
            require(state.reviews == (2 if mode == 'review' else 0), f'Unexpected reviewer count: {state.reviews}')
            daemon.shutdown()
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
                events = [(kind, json.loads(payload)) for kind, payload in database.execute(
                    'SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            decisions = [payload for kind, payload in events if kind == 'approval.resolved']
            if mode == 'review':
                reviews = [payload for kind, payload in events if kind == 'context.composed' and payload['purpose'] == 'approvalReview']
                require(len(reviews) == 2 and all('reviewInput' in item for item in reviews), 'Exact review inputs were not retained')
                require(len(decisions) == 2 and all(decision['source'] == 'agent' and 'authorizationScope' not in decision for decision in decisions), 'Delegation did not remain limited to each call')
            elif mode == 'ask':
                require(len(decisions) == 1 and decisions[0]['source'] == 'user' and decisions[0]['authorizationScope'] == 'runCommand', 'Exact run grant was not reused')
            else:
                require(not decisions, 'Allow unexpectedly created an approval decision')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Runtime was not released')
            print(f'[permission-delegation-cli] PASS: {mode}, two actual executions, {state.reviews} reviews, correct authority and owned cleanup')
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
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Provider fixture did not exit')


class WebReadPolicyProvider(fixture.MockProviderHandler):
    def do_GET(self):
        self.provider_state.web_requests.append(self.path)
        super().do_GET()

    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if execution_review_request(body):
                packet = json.loads(body['messages'][1]['content'])
                subject = packet['reviewPolicy']['subject']
                state.review_subjects.append(subject)
                require(packet['grant'] == 'thisCallOnly', 'Web policy widened the review grant')
                require(packet['restrictions']['network'] == state.network_mode, 'Reviewer received stale network policy')
                if subject == 'network':
                    require(state.network_mode == 'review', 'Allowed Web reads unnecessarily invoked the reviewer')
                    decision = 'allow'
                else:
                    require(subject == 'shell', f'Unexpected approval domain: {subject}')
                    require(packet['reviewPolicy']['mode'] == 'review', 'Web access changed Shell review')
                    decision = 'deny'
                self._send_text(json.dumps({'decision': decision, 'reason':
                    'Read the requested Web resources; do not grant Host execution or Shell networking.'}))
                return
            ordinal, names, results = state.inspect(body)
            wire_names = {tool['function']['name'] for tool in body['tools']}
            require({'web_search', 'web_fetch'} <= wire_names, 'Web tools missing from the full Loop')
            if ordinal == 1:
                self._send_tool_calls([
                    ('local-read', names['read'], {'path': 'note.txt'}),
                    ('search', 'web_search', {'query': 'fixture', 'limit': 1}),
                    ('fetch', 'web_fetch', {'url': f'http://127.0.0.1:{self.server.server_port}/fixture-resource'}),
                ])
            elif ordinal == 2:
                require(results['local-read'] == 'local-read-ok', results['local-read'])
                require(results['search']['results'][0]['title'] == 'Fixture search result', results['search'])
                require(results['fetch']['content'] == 'web-fetch-ok', results['fetch'])
                self._send_tool_calls([
                    ('shell-network', names['bash'], {'command': 'echo separate-network-gate',
                        'requestNetworkPermission': 'Check that Web permission does not grant Shell networking.'}),
                    ('host', names['bash'], {'command': COMMAND,
                        'requestHostPermission': 'Check that Web permission does not grant Host execution.'}),
                ])
            elif ordinal == 3:
                require(results['shell-network']['status'] == 'denied', results['shell-network'])
                require(results['host']['status'] == 'denied', results['host'])
                self._send_tool_calls([('repeat-search', 'web_search', {'query': 'fixture follow-up', 'limit': 1})])
            else:
                require(ordinal == 4, f'Unexpected Web policy request: {ordinal}')
                require(results['repeat-search']['results'][0]['title'] == 'Fixture search result', results['repeat-search'])
                self._send_text('web-read-policy-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_web_read_policy(network_mode='allow'):
    """New preset and retained custom review both use the real permission owners."""
    with tempfile.TemporaryDirectory(prefix='achbit-web-read-policy-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        (workspace / 'note.txt').write_text('local-read-ok', encoding='utf-8')
        state = fixture.ProviderState(workspace)
        state.network_mode, state.review_subjects, state.web_requests = network_mode, [], []
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), WebReadPolicyProvider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            configure_review(daemon, server, 'e2e-reviewer')
            settings_file = daemon.config_root / 'config/user/local/settings/user-settings.json'
            settings = json.loads(settings_file.read_text(encoding='utf-8'))
            settings.update({'agent.web.search.endpointTemplate':
                f'http://127.0.0.1:{server.server_port}/search?q={{query}}&limit={{limit}}'})
            settings_file.write_text(json.dumps(settings), encoding='utf-8')
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': 'review', 'agent.permissions.shellAccess': 'workspace',
                'agent.permissions.networkRead': network_mode, 'agent.permissions.external': 'review',
            }))
            started = time.monotonic()
            result = fixture.cli(daemon, session,
                'Read note.txt, search and read the Web resource, then search again. Do not execute on the Host or grant Shell networking.',
                run_timeout_seconds=45)
            elapsed_ms = round((time.monotonic() - started) * 1000, 3)
            state.assert_healthy()
            require('web-read-policy-complete' in result.stdout, result.stdout)
            done = fixture.projection(daemon, session)
            require(done['run']['status'] == 'completed' and not done['pendingApproval'], 'Web policy task did not settle')
            require(not done['shellAuthorizations'], 'Web read policy left an execution grant')
            require(done['effectivePermissions']['agent.permissions.workspaceMutation'] == 'plan', 'Preset changed Plan policy')
            require(not (workspace / 'approved.txt').exists(), 'Web permission authorized the Host write')
            require((workspace / 'note.txt').read_text(encoding='utf-8') == 'local-read-ok', 'Read changed the workspace')
            events = stored_events(daemon, session)
            expected_network_reviews = 3 if network_mode == 'review' else 0
            require(state.review_subjects.count('network') == expected_network_reviews, state.review_subjects)
            require(state.review_subjects.count('shell') == 2, state.review_subjects)
            decisions = [payload for kind, payload in events if kind == 'approval.resolved']
            require(len(decisions) == expected_network_reviews + 2, decisions)
            require(sum(item['decision'] == 'deny' for item in decisions) == 2, decisions)
            require(all(item['source'] == 'agent' for item in decisions), 'Unexpected manual approval')
            records = [payload['record'] for kind, payload in events if kind == 'tool.completed']
            web_records = [record for record in records if record['toolName'] in ('web.search', 'web.fetch')]
            require(len(web_records) == 3 and all(record['outcome'] == 'completed' for record in web_records), web_records)
            require(len(state.web_requests) == 3, 'Web effects did not occur exactly once per call')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Web policy runtime was not released')
            report = dict(networkMode=network_mode, webReads=3, webReviews=expected_network_reviews,
                shellDenials=2, mainRequests=len(state.requests), reviewRequests=len(state.review_subjects),
                elapsedMs=elapsed_ms, runTimings=done.get('runTimings'), provider='deterministic fixture')
            daemon.shutdown()
            report['cleanupComplete'] = True
            print('[permission-delegation-cli] PASS: ' + json.dumps(report))
            return report
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
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Web policy Provider fixture did not exit')


class ReadScopeProvider(fixture.MockProviderHandler):
    """Fixed operations; the real Kernel decides whether each needs a review."""
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if title_request(body):
                self._send_text('Read-scope validation')
                return
            if execution_review_request(body):
                packet = json.loads(body['messages'][1]['content'])
                kind = state.active_kind
                read_scope = kind.startswith('repeat-') or kind in ('sibling', 'after-revoke', 'repeat-after-revoke', 'next-run')
                expected = 'runFiles' if state.reuse and read_scope else 'thisCallOnly'
                require(packet['grant'] == expected, f'{kind}: unexpected grant {packet["grant"]}')
                state.read_reviews.append(kind)
                decision = 'deny' if kind in ('sibling', 'write', 'host', 'network') else 'allow'
                self._send_text(json.dumps({'decision': decision, 'reason':
                    'Only the supplied read-only reference directory is authorized for this task.'}))
                return
            _, names, results = state.inspect(body)
            if state.active_call is not None:
                result = results[state.active_call]
                kind = state.active_kind
                if kind in ('sibling', 'write', 'host', 'network'):
                    require(result.get('status') == 'denied', f'{kind} crossed its separate gate: {result}')
                elif kind == 'without-request' and not state.reuse:
                    require(result.get('error') and result['result']['exitCode'] != 0,
                            f'Baseline unexpectedly retained a call-only grant: {result}')
                else:
                    if isinstance(result, dict) and result.get('grantedScope'):
                        require(state.reuse and result['grantedScope'] == 'runFiles', result)
                        result = result['result']
                    if state.active_tool == 'read':
                        require(result == 'reference-ok', result)
                    else:
                        require(result['exitCode'] == 0 and result['stdout'] == 'reference-ok', result)
                state.active_call = None
            if state.read_index == len(state.read_calls):
                self._send_text('delegated-read-scope-complete')
                return
            kind, tool, args = state.read_calls[state.read_index]
            if kind == 'after-revoke':
                grants = fixture.projection(state.daemon, state.session)['shellAuthorizations']
                require(len(grants) == (1 if state.reuse else 0), grants)
                if grants:
                    grant = grants[0]
                    require(grant['scope'] == 'runFiles' and grant['context']['fileAccess']['write'] == [], grant)
                    response = fixture.api_json(state.daemon.base_url, f'/api/conversation/sessions/{state.session}/commands',
                        token=state.daemon.token, method='POST', body={
                            'schemaVersion': fixture.COMMAND_VERSION, 'type': 'approval.revoke', 'sessionId': state.session,
                            'commandId': 'command:revoke-read', 'runId': grant['runId'], 'authorityId': grant['authorityId'],
                        })
                    require(response['status'] == 'accepted', response)
                    require(not fixture.projection(state.daemon, state.session)['shellAuthorizations'], 'Revocation retained the grant')
            state.read_index += 1
            state.active_call = f'read-scope-{state.read_index}'
            state.active_kind, state.active_tool = kind, tool
            self._send_tool_calls([(state.active_call, names[tool], args)])
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_delegated_reads(*, reuse=True, daemon_factory=None, result_file=None, root_path=None):
    """Default is the current contract; an isolated baseline comparison may select call-only."""
    with ExitStack() as stack:
        root = Path(root_path) if root_path else Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='achbit-read-scope-')))
        root.mkdir(parents=True, exist_ok=True)
        workspace, outside, sibling = (root / name for name in ('workspace', 'references', 'sibling'))
        for directory in (workspace, outside, sibling):
            directory.mkdir()
        files = [outside / f'reference-{index}.txt' for index in range(3)]
        for path in files:
            path.write_text('reference-ok', encoding='utf-8')
        sibling_file = sibling / 'private.txt'
        sibling_file.write_text('not-authorized', encoding='utf-8')
        def read_command(path):
            if os.name == 'nt':
                quoted = str(path).replace("'", "''")
                return f"$ErrorActionPreference = 'Stop'; [Console]::Write([IO.File]::ReadAllText('{quoted}'))"
            return 'cat ' + shlex.quote(str(path))
        state = fixture.ProviderState(workspace)
        state.reuse, state.read_reviews = reuse, []
        state.active_call, state.active_kind, state.active_tool, state.read_index = None, None, None, 0
        request = {'read': [str(outside)], 'reason': 'Read the reference directory supplied for this task.'}
        state.read_calls = []
        for index in range(10):
            tool = 'read' if index % 3 == 1 else 'bash'
            args = {'path': str(files[index % 3])} if tool == 'read' else {'command': read_command(files[index % 3])}
            state.read_calls.append((f'repeat-{index}', tool, dict(args, requestFileAccess=request)))
        state.read_calls.extend([
            ('without-request', 'bash', {'command': read_command(files[0])}),
            ('sibling', 'read', {'path': str(sibling_file)}),
            ('write', 'write', {'path': str(files[0]), 'content': 'not authorized'}),
            ('host', 'bash', {'command': 'echo host-boundary', 'requestHostPermission': 'Check the independent Host gate.'}),
            ('network', 'bash', {'command': 'echo network-boundary', 'requestNetworkPermission': 'Check the independent network gate.'}),
            ('after-revoke', 'bash', {'command': read_command(files[1]), 'requestFileAccess': request}),
            ('repeat-after-revoke', 'read', {'path': str(files[2]), 'requestFileAccess': request}),
        ])
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ReadScopeProvider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = (daemon_factory or fixture.OwnedDaemon)(root / 'config')
        state.daemon = daemon
        try:
            configure_review(daemon, server, 'e2e-reviewer')
            daemon.start()
            state.session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, state.session, '/permissions ' + json.dumps({
                'agent.permissions.shell': 'review', 'agent.permissions.shellAccess': 'workspace',
                'agent.permissions.workspaceMutation': 'allow',
            }))
            start = time.monotonic()
            first = fixture.cli(daemon, state.session,
                'Read only the supplied reference directory. Do not modify files or use sibling files, Host execution or network.',
                run_timeout_seconds=45)
            state.assert_healthy()
            require('delegated-read-scope-complete' in first.stdout, first.stdout)
            first_projection = fixture.projection(daemon, state.session)
            require(first_projection['run']['status'] == 'completed' and not first_projection['shellAuthorizations'],
                    'Settled task retained a read grant')
            state.read_calls.append(('next-run', 'read', {'path': str(files[0])}))
            next_result = fixture.cli(daemon, state.session, 'Read the same supplied reference again in this new task.', run_timeout_seconds=45)
            state.assert_healthy()
            require('delegated-read-scope-complete' in next_result.stdout, next_result.stdout)
            final = fixture.projection(daemon, state.session)
            require(final['run']['status'] == 'completed' and final['run']['runId'] != first_projection['run']['runId'], 'No new task boundary')
            require(not final['shellAuthorizations'], 'Read grant survived the second task')
            require(all(path.read_text(encoding='utf-8') == 'reference-ok' for path in files), 'Read permission allowed writes')
            events = stored_events(daemon, state.session)
            resolutions = [payload for kind, payload in events if kind == 'approval.resolved']
            repeat_reviews = sum(kind.startswith('repeat-') and kind != 'repeat-after-revoke' for kind in state.read_reviews)
            require(repeat_reviews == (1 if reuse else 10), state.read_reviews)
            require(len(resolutions) == len(state.read_reviews) == (7 if reuse else 17), state.read_reviews)
            require(sum(item['decision'] == 'deny' for item in resolutions) == 4, resolutions)
            require(state.read_reviews.count('after-revoke') == 1 and state.read_reviews.count('next-run') == 1, state.read_reviews)
            require(all(item['source'] == 'agent' for item in resolutions), 'Unexpected manual authorization')
            require(all(item.get('authorizationScope') == ('runFiles' if reuse and item['decision'] == 'allow' else None)
                        for item in resolutions), 'Unexpected grant lifetime')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 2, 'Tasks did not release runtimes')
            records = [payload['record'] for kind, payload in events if kind == 'tool.completed']
            summary = {'sessionId': state.session, 'reusableReads': reuse, 'repeatedReads': 10,
                'repeatedReadReviews': repeat_reviews, 'totalReviews': len(resolutions), 'toolCalls': len(records),
                'toolFailures': sum(record['outcome'] == 'failed' for record in records),
                'boundaryDenials': 4, 'revocationRechecked': True if reuse else None, 'nextRunRechecked': True,
                'remainingGrants': len(final['shellAuthorizations']), 'elapsedSeconds': round(time.monotonic() - start, 3),
                'provider': 'deterministic fixture; no real-model cost measurement'}
            daemon.shutdown()
            summary['cleanupComplete'] = True
            if result_file:
                Path(result_file).write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
            print('[permission-delegation-cli] PASS: ' + json.dumps(summary))
            return summary
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
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Read-scope Provider fixture did not exit')


class ReviewFailureProvider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if title_request(body):
                self._send_text('Permission validation')
                return
            if execution_review_request(body, decision_only=state.reviews > 0):
                state.reviews += 1
                require(state.scenario == 'invalid-decision', 'An unavailable reviewer was replaced by another model')
                require(body['model'] == 'mock-reviewer', 'Selected reviewer was not used')
                self._send_text(json.dumps({'decision': ['ask'], 'reason': 'Ask the user before executing.'}))
                return
            ordinal, names, results = state.inspect(body)
            if state.scenario == 'unused':
                self._send_text('reviewer-failure-check-complete')
            elif ordinal == 1:
                self._send_tool_calls([('probe', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Verify human approval before the owned marker write.',
                })])
            else:
                require(results['probe']['status'] == 'denied', 'The human denial did not reach the model')
                self._send_text('reviewer-failure-check-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_review_failure(mode, scenario):
    with tempfile.TemporaryDirectory(prefix='achbit-review-failure-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.scenario, state.reviews = scenario, 0
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ReviewFailureProvider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            configure_review(daemon, server, 'e2e-reviewer' if scenario == 'invalid-decision' else 'removed-reviewer-profile')
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': mode, 'agent.permissions.shellAccess': 'full',
                'agent.permissions.workspaceMutation': 'allow',
            }))
            result = fixture.cli(daemon, session,
                'Reply without any tools.' if scenario == 'unused' else 'Request the test marker write once.',
                expected=0 if scenario == 'unused' else 5)
            state.assert_healthy()
            if scenario != 'unused':
                if mode == 'ask':
                    fixture.cli(daemon, session, '/permissions ' + json.dumps({'agent.permissions.shell': 'review'}))
                    state.assert_healthy()
                def review_waiting():
                    state.assert_healthy()
                    current = fixture.projection(daemon, session)
                    review = ((current.get('pendingApproval') or {}).get('preview', {}).get('review') or {})
                    return current if current['run']['status'] == 'waiting' and review.get('decision') == 'ask' else None

                pending = fixture.wait_until(review_waiting, 10, 'Review failure did not wait for human approval')
                require(not (workspace / 'approved.txt').exists(), 'Failed review executed the command')
                before = stored_events(daemon, session)
                reviewed = [payload for kind, payload in before if kind == 'approval.reviewed']
                require(reviewed and reviewed[-1]['decision'] == 'ask', 'Failed review did not produce an ask fact')
                expected_error = 'approval_review_invalid' if scenario == 'invalid-decision' else 'approval_reviewer_prepare_failed'
                require(expected_error in reviewed[-1]['reason'], 'The original reviewer failure was hidden')
                require(not any(kind in ('tool.started', 'approval.resolved') for kind, _ in before), 'Command crossed the approval boundary')
                result = fixture.cli(daemon, session, '/reply 2')
            state.assert_healthy()
            require('reviewer-failure-check-complete' in result.stdout, result.stdout)
            require(fixture.projection(daemon, session)['run']['status'] == 'completed', 'The conversation did not settle')
            require(not (workspace / 'approved.txt').exists(), 'The denied or unrequested marker was written')
            events = stored_events(daemon, session)
            runtime = next(payload['runtimeSnapshot'] for kind, payload in events if kind == 'run.started')
            if scenario != 'invalid-decision':
                require(runtime.get('approvalReviewerError', {}).get('code') == 'approval_reviewer_prepare_failed'
                        and 'approvalReviewer' not in runtime, 'Failed reviewer binding was not preserved')
            require(state.reviews == (2 if scenario == 'invalid-decision' else 0), 'Unexpected reviewer Provider request')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Runtime was not released')
            daemon.shutdown()
            print(f'[permission-delegation-cli] PASS: {mode}/{scenario}, real CLI, preserved error, human fallback or ordinary answer, no unauthorized write')
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
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Provider fixture did not exit')


INITIAL_REQUEST = 'Append approved to approved.txt, then summarize.'
LATER_RESTRICTION = 'Do not create or modify approved.txt. Keep it absent and report only.'
CONTINUATION = 'Continue the task.'


class PreviousRunGuidanceProvider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if title_request(body):
                self._send_text('Permission validation')
                return
            if execution_review_request(body):
                state.reviews += 1
                require(body['model'] == 'mock-reviewer', 'The selected reviewer was not used for prior-run guidance')
                require(body.get('reasoning_effort') == 'xhigh', 'The configured reviewer effort was not used')
                review = json.loads(body['messages'][-1]['content'])
                require(review['operation']['arguments']['command'] == COMMAND, 'Review did not receive the proposed marker write')
                require(review['grant'] == 'thisCallOnly', 'Review changed the permission lifetime')
                require({'messageId': state.guidance_message_id, 'content': LATER_RESTRICTION} in review['userMessages'],
                        'Review lost the original user restriction consumed by the preceding run')
                contents = [message['content'] for message in review['userMessages']]
                require(INITIAL_REQUEST in contents and CONTINUATION in contents, 'Review lost the selected run inputs')
                require(contents.index(LATER_RESTRICTION) < contents.index(CONTINUATION), 'Review reordered the user restriction')
                self._send_text(json.dumps({'decision': 'deny', 'reason': 'The later user instruction forbids writing approved.txt.'}))
                return
            ordinal, names, results = state.inspect(body)
            user_messages = [fixture.message_text(message.get('content')) for message in body['messages'] if message['role'] == 'user']
            if ordinal == 1:
                require(any(INITIAL_REQUEST in content for content in user_messages), 'Initial CLI input did not reach the Provider')
                state.initial_started.set()
                require(state.release_initial.wait(timeout=30), 'Queued CLI guidance was not confirmed before releasing the first response')
                self._send_text('The initial task is recorded; apply the pending guidance.')
            elif ordinal == 2:
                require(any(LATER_RESTRICTION in content for content in user_messages), 'Queued guidance did not reach the next Provider request')
                self._send_text('previous-run-guidance-recorded')
            elif ordinal == 3:
                require(any(CONTINUATION in content for content in user_messages), 'Continuation did not reach the Provider')
                self._send_tool_calls([('restricted', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Attempt the owned marker write for this permission regression.',
                })])
            elif ordinal == 4:
                require(results['restricted']['status'] == 'denied', 'The delegated denial did not reach the model')
                self._send_text('previous-run-guidance-review-complete')
            else:
                raise AssertionError(f'Unexpected Provider request after prior-run guidance: {ordinal}')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def close_cli(process):
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    finally:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def check_previous_run_guidance():
    with tempfile.TemporaryDirectory(prefix='achbit-review-guidance-') as directory, ExitStack() as cleanup:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.reviews, state.guidance_message_id = 0, None
        state.initial_started, state.release_initial = threading.Event(), threading.Event()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), PreviousRunGuidanceProvider)
        server.daemon_threads = False
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def close_provider():
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
            require(not thread.is_alive(), 'Prior-run guidance Provider fixture did not exit')

        cleanup.callback(close_provider)
        daemon = fixture.OwnedDaemon(root / 'config')
        cleanup.callback(daemon.close)
        cleanup.callback(state.release_initial.set)

        def start_cli_input(session, text):
            environment = fixture.shell_environment(daemon)
            environment['ACHBIT_CLI_RUN_TIMEOUT_MS'] = '45000'
            process = subprocess.Popen([
                str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                '--session', session, '--plain', 'ask', text,
            ], cwd=fixture.ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            cleanup.callback(close_cli, process)
            return process

        def facts(session):
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
                return [{'sequence': sequence, 'type': kind, 'runId': run_id, 'callId': call_id, 'payload': json.loads(payload)}
                        for sequence, kind, run_id, call_id, payload in database.execute(
                            'SELECT sequence,event_type,run_id,call_id,payload_json FROM session_events WHERE session_id=? ORDER BY sequence',
                            (session,))]

        try:
            configure_review(daemon, server, 'e2e-reviewer')
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.shell': 'review', 'agent.permissions.shellAccess': 'full',
                'agent.permissions.workspaceMutation': 'allow',
            }))
            initial = start_cli_input(session, INITIAL_REQUEST)

            def first_request_started():
                state.assert_healthy()
                require(initial.poll() is None, 'Initial CLI exited before the controlled Provider request')
                return state.initial_started.is_set()

            fixture.wait_until(first_request_started, 15, 'Initial Provider request did not start')
            preceding_run_id = fixture.projection(daemon, session)['run']['runId']
            guidance = start_cli_input(session, LATER_RESTRICTION)

            def guidance_queued():
                state.assert_healthy()
                queued = [event for event in facts(session)
                          if event['type'] == 'input.queued' and event['payload']['text'] == LATER_RESTRICTION]
                if not queued:
                    require(guidance.poll() is None, 'Guidance CLI exited before its input was queued')
                    return None
                require(len(queued) == 1 and queued[0]['runId'] == preceding_run_id, 'Guidance was not queued once in the initial run')
                return queued[0]

            queued = fixture.wait_until(guidance_queued, 10, 'The second CLI input did not enter the current run queue')
            state.guidance_message_id = queued['payload']['messageId']
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
                command_json, reply_json = database.execute(
                    'SELECT command_json,reply_json FROM session_commands WHERE session_id=? AND command_id=?',
                    (session, queued['payload']['commandId'])).fetchone()
            command, reply = json.loads(command_json), json.loads(reply_json)
            require(command['type'] == 'message.submit' and command['runId'] == preceding_run_id
                    and command['text'] == LATER_RESTRICTION and reply['status'] == 'accepted',
                    'Guidance did not pass through the actual accepted message.submit command')
            state.release_initial.set()
            for process in (initial, guidance):
                stdout, stderr = process.communicate(timeout=20)
                require(process.returncode == 0, f'CLI guidance run exited {process.returncode}: {stdout} {stderr}')
                require('previous-run-guidance-recorded' in stdout, 'CLI did not display the consumed guidance result')
            state.assert_healthy()
            prior = facts(session)
            accepted = [event for event in prior if event['type'] == 'input.accepted'
                        and event['payload']['commandId'] == queued['payload']['commandId']]
            committed = [event for event in prior if event['type'] == 'message.committed'
                         and event['payload']['messageId'] == state.guidance_message_id]
            require(len(accepted) == 1 and len(committed) == 1, 'Queued guidance was not consumed exactly once')
            require(committed[0]['runId'] == preceding_run_id and committed[0]['payload']['role'] == 'user'
                    and committed[0]['payload']['content'] == LATER_RESTRICTION, 'The original guidance lost its prior-run identity')
            require(queued['sequence'] < accepted[0]['sequence'] < committed[0]['sequence'], 'Queue consumption facts are out of order')
            require(sum(event['type'] == 'run.started' for event in prior) == 1, 'Guidance incorrectly opened another run')
            require(any(event['type'] == 'run.runtime.released' and event['runId'] == preceding_run_id for event in prior),
                    'The preceding run runtime was not released before continuation')
            require(not (workspace / 'approved.txt').exists(), 'The first run wrote the prohibited marker')
            result = fixture.cli(daemon, session, CONTINUATION)
            state.assert_healthy()
            require('previous-run-guidance-review-complete' in result.stdout, result.stdout)
            done = fixture.projection(daemon, session)
            require(done['run']['status'] == 'completed' and done['pendingApproval'] is None, 'Continuation did not settle after delegated denial')
            current_run_id = done['run']['runId']
            require(current_run_id != preceding_run_id, 'Continuation did not open the next run')
            require(not (workspace / 'approved.txt').exists(), 'Delegated denial still wrote the marker')
            events = facts(session)
            decisions = [event for event in events if event['type'] == 'approval.resolved']
            require(len(decisions) == 1 and decisions[0]['runId'] == current_run_id
                    and decisions[0]['payload']['source'] == 'agent' and decisions[0]['payload']['decision'] == 'deny'
                    and 'authorizationScope' not in decisions[0]['payload'], 'The denial was not recorded as a single-call Agent decision')
            require(not any(event['type'] == 'tool.started' for event in events), 'The denied command began execution')
            require(state.reviews == 1 and len(state.requests) == 4, 'Unexpected Provider work in the prior-run guidance regression')
            starts = [event for event in events if event['type'] == 'run.started']
            require(len(starts) == 2, 'The regression did not use exactly two actual runs')
            for run_id in (preceding_run_id, current_run_id):
                require(sum(event['type'] == 'run.runtime.released' and event['runId'] == run_id for event in events) == 1,
                        'A run runtime was not released exactly once')
            daemon.shutdown()
            print('[permission-delegation-cli] PASS: previous-run guidance, two real CLI inputs queue/consume in one run, next-run review denies, no write, both runtimes released')
        except BaseException:
            print(daemon.log_tail())
            state.assert_healthy()
            raise


class PlanProvider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if title_request(body):
                self._send_text('Plan permission validation')
                return
            if not body.get('tools'):
                state.reviews += 1
                require(state.mode == 'review' and body['model'] == 'mock-reviewer', 'Plan review did not use its selected independent model')
                require(len(body['messages']) == 2, 'Plan review inherited a transcript')
                review = json.loads(body['messages'][1]['content'])
                require(review['reviewKind'] == 'plan' and review['grant'] == 'thisPlanRevisionOnly', 'Wrong Plan review context')
                require('operation' not in review and 'observedTarget' not in review, 'Shell review context leaked into Plan review')
                require('You do not approve Plans' not in body['messages'][0]['content'], 'Plan reused Shell reviewer instructions')
                require(review['proposedPlan']['mutationManifest'][0]['target'] == 'result.txt', 'Plan scope changed before review')
                state.review_ready.set()
                require(state.release_review.wait(15), 'Plan reviewer was not released')
                self._send_text(json.dumps({'decision': state.verdict, 'reason': 'The independent Plan scope decision.'}))
                return
            if state.delegate_pending and state.mode == 'review':
                if not state.after_delegation.requests:
                    first = state.requests[0]
                    require(body['tools'] == first['tools'], 'Delegating Plan approval changed the tool catalog')
                    before, after = first['messages'], body['messages'][:len(first['messages'])]
                    changed = [(old, new) for old, new in zip(before, after) if old != new]
                    require(len(after) == len(before) and len(changed) == 1, 'Delegation changed more than the permission instruction')
                    old, new = changed[0]
                    require(old['role'] == new['role'] == 'system'
                        and 'call plan_publish and wait for confirmation' in old['content']
                        and 'An independent Plan reviewer decides the proposed scope' in new['content'],
                        'Delegation did not replace manual confirmation guidance with independent review guidance')
                ordinal, names, results = state.after_delegation.inspect(body)
                ordinal += len(state.requests)
            else:
                ordinal, names, results = state.inspect(body)
            if state.mode == 'allow':
                require('plan' not in names, 'Plan off still exposed its schema')
                if ordinal == 1:
                    self._send_tool_calls([('write', names['write'], {'path': 'result.txt', 'content': 'approved-plan-write'})])
                else:
                    require(results['write']['changed'] is True, results)
                    self._send_text('plan-mode-complete')
            elif ordinal == 1:
                require('plan' in names, 'Enabled Plan tool was missing')
                self._send_tool_calls([('plan', names['plan'], {
                    'title': 'Write requested result', 'summary': 'Change only result.txt.',
                    'steps': [{'stepId': 'write', 'title': 'Write', 'details': 'Write the requested file after approval.'}],
                    'mutationManifest': [{'workspace': 'primary', 'operation': 'fs.write', 'target': 'result.txt'}],
                })])
            elif ordinal == 2 and state.verdict == 'deny':
                require(results['plan']['response']['kind'] == 'cancel', 'Plan rejection did not reach the Agent')
                self._send_text('plan-mode-complete')
            elif ordinal == 2:
                require(results['plan']['response']['kind'] == 'confirm', 'Write was requested before Plan confirmation')
                self._send_tool_calls([('write', names['write'], {'path': 'result.txt', 'content': 'approved-plan-write'})])
            else:
                require(results['write']['changed'] is True, results)
                self._send_text('plan-mode-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_plan_mode(mode, verdict='allow', *, delegate_pending=False):
    with tempfile.TemporaryDirectory(prefix='achbit-plan-review-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.mode, state.verdict, state.reviews = mode, verdict, 0
        state.delegate_pending = delegate_pending
        state.after_delegation = fixture.ProviderState(workspace)
        state.review_ready, state.release_review = threading.Event(), threading.Event()
        if not delegate_pending:
            state.release_review.set()
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), PlanProvider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'state')
        try:
            configure_review(daemon, server, 'e2e-reviewer')
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, '/permissions ' + json.dumps({
                'agent.permissions.workspaceMutation': mode, 'agent.permissions.shell': 'review',
            }))
            result = fixture.cli(daemon, session, 'Write the requested result to result.txt.', expected=5 if mode == 'plan' else 0)
            state.assert_healthy()
            if mode == 'plan':
                require(not (workspace / 'result.txt').exists(), 'Manual mode wrote before confirmation')
                require(state.reviews == 0, 'Manual mode invoked a Plan reviewer')
                if delegate_pending:
                    waiting = fixture.projection(daemon, session)
                    state.mode = 'review'
                    fixture.cli(daemon, session, '/permissions ' + json.dumps({'agent.permissions.workspaceMutation': 'review'}))
                    require(state.review_ready.wait(15), 'Waiting Plan did not start its delegated review')
                    reviewing = fixture.projection(daemon, session)
                    require(reviewing['run']['status'] == 'running', 'Plan review retained the manual waiting state')
                    require(reviewing['run']['runId'] == waiting['run']['runId'], 'Delegation replaced the pending run')
                    require(reviewing['pendingPlan']['planId'] == waiting['pendingPlan']['planId'], 'Delegation replaced the pending Plan')
                    statuses = fixture.api_json(daemon.base_url, '/api/conversation/statuses', token=daemon.token)
                    compact = next(item for item in statuses if item['sessionId'] == session)
                    require(compact['run']['status'] == 'running' and compact['run']['runId'] == waiting['run']['runId'],
                        'Compact navigation retained the manual waiting state')
                    state.release_review.set()
                else:
                    result = fixture.cli(daemon, session, '/reply 1')
            if not delegate_pending:
                require('plan-mode-complete' in result.stdout, result.stdout)
            state.assert_healthy()
            done = fixture.wait_completed(daemon, state, session, 'delegated pending Plan') if delegate_pending else fixture.projection(daemon, session)
            require(done['run']['status'] == 'completed', 'Plan mode task did not settle')
            require(done['effectivePermissions']['agent.permissions.shell'] == 'review', 'Plan mode changed Shell approval')
            require(state.reviews == (1 if state.mode == 'review' else 0), 'Unexpected Plan reviewer requests')
            if verdict == 'deny':
                require(not (workspace / 'result.txt').exists(), 'Denied Plan granted write authority')
                require(done['plans'][0]['review']['decision'] == 'deny', 'Plan denial was not retained')
            else:
                require((workspace / 'result.txt').read_text() == 'approved-plan-write', 'Approved file write did not execute')
            if mode == 'allow':
                require(not done['plans'], 'Off mode still generated Plans')
            elif verdict == 'allow':
                require(done['plans'][0]['confirmationSource'] == ('agent' if state.mode == 'review' else 'user'), 'Wrong confirmation owner')
            events = stored_events(daemon, session)
            require(sum(kind == 'plan.reviewed' for kind, _ in events) == (1 if state.mode == 'review' else 0), 'Missing or duplicated Plan review fact')
            require(not any(kind == 'approval.resolved' for kind, _ in events), 'Plan review borrowed a Shell approval')
            require(sum(kind == 'run.started' for kind, _ in events) == 1, 'Plan approval created another run')
            require(sum(kind == 'run.runtime.released' for kind, _ in events) == 1, 'Plan run did not release its runtime once')
            daemon.shutdown()
            label = f'{mode}->review' if delegate_pending else mode
            print(f'[permission-delegation-cli] PASS: Plan {label}/{verdict}, independent scope review, correct owner, real file effect and unchanged Shell policy')
        finally:
            state.release_review.set()
            try:
                daemon.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Plan Provider fixture did not exit')


if __name__ == '__main__':
    for network_mode in ('review', 'allow'):
        check_web_read_policy(network_mode)
    for plan_mode in ('plan', 'review', 'allow'):
        check_plan_mode(plan_mode)
    check_plan_mode('review', 'deny')
    check_plan_mode('plan', delegate_pending=True)
    for mode in ('ask', 'review', 'allow'):
        check_mode(mode)
    for mode in ('ask', 'allow'):
        check_review_failure(mode, 'unused')
    for mode in ('ask', 'review'):
        check_review_failure(mode, 'unavailable')
    check_review_failure('review', 'invalid-decision')
    check_previous_run_guidance()
    check_delegated_reads()
