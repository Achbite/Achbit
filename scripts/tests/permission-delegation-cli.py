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

spec = importlib.util.spec_from_file_location('deepcode_test_support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
COMMAND = "[IO.File]::AppendAllText((Join-Path (Get-Location) 'approved.txt'), \"approved`n\")" if os.name == 'nt' else "printf 'approved\\n' >> approved.txt"


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
            if not body.get('tools'):
                state.reviews += 1
                require(state.mode == 'review', 'Review ran without user delegation')
                require(body['model'] == 'mock-reviewer', 'The selected approval model was not used')
                require(body.get('reasoning_effort') == 'xhigh', 'The independent reviewer reasoning setting was not used')
                review = json.loads(body['messages'][-1]['content'])
                require(review['operation']['arguments']['command'] == COMMAND, 'Review did not receive the actual command')
                require(review['grant'] == 'thisCallOnly', 'Review changed the permission lifetime')
                self._send_text(json.dumps({'decision': 'allow', 'reason': 'The user requested this exact file operation in the delegated environment.'}))
                return
            ordinal, names, results = state.inspect(body)
            if ordinal <= 2:
                if ordinal == 2:
                    require(results['first']['outcome'] == 'completed', results['first'])
                self._send_tool_calls([('first' if ordinal == 1 else 'repeat', names['bash'], {
                    'command': COMMAND, 'requestHostPermission': 'Write the file explicitly requested by the user.',
                })])
            else:
                require(results['repeat']['outcome'] == 'completed', results['repeat'])
                self._send_text('permission-delegation-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_mode(mode):
    with tempfile.TemporaryDirectory(prefix=f'deepcode-permission-{mode}-') as directory:
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


class ReviewFailureProvider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if not body.get('tools'):
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
                require(results['probe']['outcome'] == 'denied', 'The human denial did not reach the model')
                self._send_text('reviewer-failure-check-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def check_review_failure(mode, scenario):
    with tempfile.TemporaryDirectory(prefix='deepcode-review-failure-') as directory:
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
            if not body.get('tools'):
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
                require(results['restricted']['outcome'] == 'denied', 'The delegated denial did not reach the model')
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
    with tempfile.TemporaryDirectory(prefix='deepcode-review-guidance-') as directory, ExitStack() as cleanup:
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
            environment['DEEPCODE_CLI_RUN_TIMEOUT_MS'] = '45000'
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


if __name__ == '__main__':
    for mode in ('ask', 'review', 'allow'):
        check_mode(mode)
    for mode in ('ask', 'allow'):
        check_review_failure(mode, 'unused')
    for mode in ('ask', 'review'):
        check_review_failure(mode, 'unavailable')
    check_review_failure('review', 'invalid-decision')
    check_previous_run_guidance()
