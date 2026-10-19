#!/usr/bin/env python3
"""Actual file/Shell effects through the CLI; deterministic Provider input only."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shlex
import tempfile
import threading
import urllib.request
import urllib.parse

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
WINDOWS = os.name == 'nt'


def powershell_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def child_read_command(path):
    if WINDOWS:
        script = "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))"
        return "$ErrorActionPreference = 'Stop'; & node -e " + powershell_quote(script) + " " + powershell_quote(path) + "; exit $LASTEXITCODE"
    return 'sh -c ' + shlex.quote(f'cat {shlex.quote(str(path))}')


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            messages = body.get('messages', [])
            if messages and messages[0].get('content', '').startswith('Name this conversation from the user'):
                # Auxiliary title requests are not Agent turns and have no tool catalog.
                require(len(messages) == 2 and messages[0]['role'] == 'system' and messages[1]['role'] == 'user'
                        and not body.get('tools'), 'Invalid auxiliary title request')
                self.send_response(200)
                self.send_header('content-type', 'text/event-stream')
                self.send_header('connection', 'close')
                self.end_headers()
                self._send_text('File access validation')
                return
            ordinal, names, results = state.inspect(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            if getattr(state, 'workspace_mode', None):
                self.workspace_turn(ordinal, names, results)
                return
            if getattr(state, 'reference_mode', False):
                state.reference_requests.append(body)
                self.reference_turn(len(state.reference_requests), names, results)
                return
            if ordinal == 1:
                self._send_tool_calls([('read-external', names['read'], {'path': str(state.external)})])
            elif ordinal == 2:
                require(results['read-external']['outcome'] == 'completed', results['read-external'])
                self._send_tool_calls([
                    ('shell-same-file', names['bash'], {'command': child_read_command(state.external)}),
                    ('shell-sibling', names['bash'], {'command': child_read_command(state.sibling)}),
                    ('git-denied', names['bash'], {'command': "$ErrorActionPreference = 'Stop'; Set-Content -LiteralPath .git/HEAD -Value changed" if WINDOWS else "printf changed > .git/HEAD"}),
                    ('private-temp', names['bash'], {'command': "$ErrorActionPreference = 'Stop'; $owned = Join-Path $env:TMPDIR 'owned'; [IO.File]::WriteAllText($owned, 'temp'); [Console]::Write([IO.File]::ReadAllText($owned) + ':' + $env:HOME)" if WINDOWS else 'printf temp > "$TMPDIR/owned"; cat "$TMPDIR/owned"; printf ":%s\\n" "$HOME"'}),
                ])
            elif ordinal == 3:
                require(results['shell-same-file']['outcome'] == 'completed', results['shell-same-file'])
                require(results['shell-same-file']['output']['stdout'] == 'external-ok', results['shell-same-file'])
                for call in ('shell-sibling', 'git-denied'):
                    require(results[call]['outcome'] == 'failed' and results[call]['output']['exitCode'] != 0, results[call])
                require(results['private-temp']['outcome'] == 'completed', results['private-temp'])
                temporary_output = results['private-temp']['output']['stdout']
                require(temporary_output.startswith('temp:') and temporary_output[5:].strip(), results['private-temp'])
                self._send_tool_calls([('external-write', names['write'], {
                    'path': str(state.external), 'content': 'updated',
                })])
            elif ordinal == 4:
                require(results['external-write']['outcome'] == 'completed', results['external-write'])
                self._send_tool_calls([('git-approved', names['write'], {
                    'path': '.git/HEAD', 'content': 'approved',
                    'requestFileAccess': {'write': [str(state.workspace / '.git/HEAD')]},
                })])
            elif ordinal == 5:
                require(results['git-approved']['outcome'] == 'completed', results['git-approved'])
                self._send_text('file-scope-complete')
            else:
                require(ordinal % 2 == 0 or f'read-{ordinal-1}' in results, results)
                if ordinal % 2 == 0:
                    self._send_tool_calls([(f'read-{ordinal}', names['read'], {'path': str(state.external)})])
                else:
                    require(results[f'read-{ordinal-1}']['outcome'] == ('denied' if ordinal == 11 else 'completed'), results)
                    self._send_text('file-scope-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True

    def workspace_turn(self, ordinal, names, results):
        state = self.provider_state
        if state.workspace_mode == 'project' and ordinal == 1:
            state.workspace_started.set()
            require(state.workspace_release.wait(30), 'Project update did not release the original request')
            self._send_tool_calls([('old-project-read', names['read'], {'path': '.git/HEAD'})])
            return
        step = ordinal - (1 if state.workspace_mode == 'project' else 0)
        if step == 1:
            if state.workspace_mode == 'project':
                require(results['old-project-read']['outcome'] == 'completed', results)
            self._send_tool_calls([('workspace-plan', names['plan'], {
                'title': 'Write supplied workspace result', 'summary': 'Modify only the declared file.',
                'steps': [{'stepId': 'write', 'title': 'Write', 'details': 'Write after the workspace and Plan are admitted.'}],
                'mutationManifest': [{'operation': 'fs.write', 'workspace': 'workspace3', 'target': state.workspace_file}],
            })])
        elif step == 2:
            self._send_tool_calls([('workspace-write', names['write'], {'workspace': 'workspace3', 'path': state.workspace_file, 'content': 'workspace-authorized'})])
        elif step == 3:
            require(results['workspace-write']['outcome'] == 'completed', results)
            self._send_text('workspace-permission-complete')
        else:
            raise AssertionError(f'Unexpected workspace request {ordinal}')

    def reference_turn(self, ordinal, names, results):
        state = self.provider_state
        if ordinal == 1:
            state.reference_started.set()
            require(state.reference_release.wait(30), 'Reference input did not release the held request')
            self._send_tool_calls([('project-before-references', names['read'], {'path': '.git/HEAD'})])
            return
        if ordinal == 2:
            first = state.reference_requests[0]['messages']
            require(state.reference_requests[1]['messages'][:len(first)] == first, 'Queued references changed the in-flight prefix')
            refs = []
            for message in state.reference_requests[-1]['messages']:
                content = message.get('content', '')
                if message['role'] == 'user' and isinstance(content, str) and '[{"referenceId"' in content:
                    refs.extend(json.loads(content[content.index('[{"referenceId"'):]))
            state.external_reference = next(ref for ref in refs if ref['kind'] == 'file')
            state.project_reference = next(ref for ref in refs if ref['displayName'] == 'referenced-src')
            directory = next(ref for ref in refs if ref['displayName'] == 'reference-folder')
            require(directory['workspace'] == state.external_reference['workspace'], 'File and parent directory lost their shared address identity')
            self._send_tool_calls([('reference-read', names['read'], {'workspace': directory['workspace'], 'path': 'target.txt'})])
        elif ordinal == 3:
            require(results['reference-read']['outcome'] == 'completed' and results['reference-read']['output']['content'] == 'original-reference', results)
            ref, inside = state.external_reference, state.project_reference
            self._send_tool_calls([('reference-plan', names['plan'], {
                'title': 'Update the added projects', 'summary': 'Write only the two requested results after approval.',
                'steps': [{'stepId': 'write', 'title': 'Write results', 'details': 'Modify the supplied file and add the project result.'}],
                'mutationManifest': [
                    {'operation': 'fs.write', 'workspace': ref['workspace'], 'target': ref['path']},
                    {'operation': 'fs.write', 'workspace': inside['workspace'], 'target': 'result.txt'},
                ],
            })])
        elif ordinal == 4:
            ref, inside = state.external_reference, state.project_reference
            self._send_tool_calls([
                ('reference-write', names['write'], {'workspace': ref['workspace'], 'path': ref['path'], 'content': 'modified-original'}),
                ('project-reference-write', names['write'], {'workspace': inside['workspace'], 'path': 'result.txt', 'content': 'project-write'}),
            ])
        elif ordinal == 5:
            require(results['reference-write']['outcome'] == 'completed', results)
            require(results['project-reference-write']['outcome'] == 'completed', results)
            self._send_text('reference-targets-complete')
        elif ordinal == 6:
            self._send_text('reference-bindings-retained')
        else:
            raise AssertionError(f'Unexpected reference request {ordinal}')


def check_queued_reference_targets(daemon, state, root, workspace):
    outside = root / 'reference-folder'
    outside.mkdir()
    target = outside / 'target.txt'
    target.write_text('original-reference')
    inside = workspace / 'referenced-src'
    inside.mkdir()
    state.reference_mode = True
    state.reference_requests = []
    state.reference_started = threading.Event()
    state.reference_release = threading.Event()
    session = fixture.create_session(daemon, workspace)['sessionId']
    fixture.cli(daemon, session, '/permissions ' + json.dumps({'agent.permissions.workspaceMutation': 'plan'}))
    endpoint = f'/api/conversation/sessions/{session}'
    def submit(command_id, text, **extra):
        reply = fixture.api_json(daemon.base_url, endpoint + '/commands', token=daemon.token, method='POST', body={
            'schemaVersion': fixture.COMMAND_VERSION, 'type': 'message.submit', 'sessionId': session,
            'commandId': command_id, 'text': text, **extra,
        })
        require(reply['status'] == 'accepted', reply)
    try:
        submit('command:reference-start', 'Inspect the project and use the references I supply.')
        require(state.reference_started.wait(20), 'Initial reference request did not start')
        before = fixture.projection(daemon, session)
        run_id = before['run']['runId']
        references = fixture.api_json(daemon.base_url, endpoint + '/filesystem-references/resolve', token=daemon.token, method='POST', body={
            'references': [{'path': str(outside), 'kind': 'directory'}, {'path': str(target), 'kind': 'file'}, {'path': str(inside), 'kind': 'directory'}],
        })
        require(fixture.projection(daemon, session)['workspaceBindings'] == before['workspaceBindings'], 'Merely selecting resources created bindings before submission')
        submit('command:reference-targets', 'Read and modify these targets.', runId=run_id, filesystemReferences=references)
        queued = fixture.projection(daemon, session)
        require(len(queued['queuedInputs']) == 1 and queued['run']['workspaceBindings'] == before['run']['workspaceBindings'], 'References changed the project working directories')
        state.reference_release.set()
        fixture.wait_until(lambda: fixture.projection(daemon, session).get('pendingPlan'), 20, 'Added-directory Plan did not reach normal confirmation')
        waiting = fixture.projection(daemon, session)
        require(waiting['pendingApproval'] is None, 'A formal project read was treated as an outside reference')
        expected = {binding['workspaceId'] for binding in before['run']['workspaceBindings']} | {reference['workspaceId'] for reference in references if reference['kind'] == 'directory'}
        require({binding['workspaceId'] for binding in waiting['run']['workspaceBindings']} == expected, 'Consumed directories were not formally bound to the same run')
        require(target.read_text() == 'original-reference' and not (inside / 'result.txt').exists(), 'Directory binding bypassed Plan confirmation')
        fixture.cli(daemon, session, '/reply 1')
        completed = fixture.wait_completed(daemon, state, session, 'reference-targets-complete')
        require(completed['run']['runId'] == run_id, 'Adding directories replaced the active Run')
        require({binding['workspaceId'] for binding in completed['workspaceBindings']} == expected, 'New directory bindings were not retained in Session')
        require(target.read_text() == 'modified-original', 'Approved write did not modify the original file')
        require((inside / 'result.txt').read_text() == 'project-write', 'Project subdirectory did not use its approved scope')
        fixture.cli(daemon, session, 'Verify the retained directory bindings in the next run.')
        later = fixture.wait_completed(daemon, state, session, 'reference-bindings-retained')
        require(later['run']['runId'] != run_id and {binding['workspaceId'] for binding in later['run']['workspaceBindings']} == expected, 'The next run lost added directory bindings')
        state.assert_healthy()
        print('[file-access-cli] PASS: same-run directory binding, unchanged in-flight prefix, normal Plan confirmation, real writes and next-run retention')
    finally:
        state.reference_release.set()


def check_project_workspace_and_permission(daemon, server, root, workspace):
    def api(path, body, method='POST'):
        return fixture.api_json(daemon.base_url, '/api/conversation/' + path, token=daemon.token, method=method, body=body)
    def project(title):
        catalog = api('projects', {'title': title, 'workspacePaths': [str(workspace)]})
        return next(item['id'] for item in catalog['projects'] if item['title'] == title)
    def session(project_id):
        return api('sessions', {'projectId': project_id})['sessionId']
    def ids(sid):
        return {item['workspaceId'] for item in fixture.projection(daemon, sid)['workspaceBindings']}
    def submit(sid, command_id, **fields):
        return api(f'sessions/{sid}/commands', {'schemaVersion': fixture.COMMAND_VERSION,
            'sessionId': sid, 'commandId': command_id, **fields})
    def state_for(mode, filename):
        state = fixture.ProviderState(workspace)
        state.workspace_mode, state.workspace_file = mode, filename
        state.workspace_started, state.workspace_release = threading.Event(), threading.Event()
        server.provider_state = state
        return state

    shared, other = project('Shared workspace fixture'), project('Unrelated project fixture')
    active, peer, unrelated = session(shared), session(shared), session(other)
    added = root / 'inflight-added'
    added.mkdir()
    original_peer, original_other = ids(peer), ids(unrelated)
    fixture.cli(daemon, active, '/permissions ' + json.dumps({'agent.permissions.workspaceMutation': 'plan'}))
    state = state_for('project', 'result.txt')
    try:
        require(submit(active, 'command:project-start', type='message.submit', text='Use the project workspace.')['status'] == 'accepted', 'Task was not accepted')
        require(state.workspace_started.wait(20), 'Initial request was not held')
        original_run = fixture.projection(daemon, active)['run']
        api(f'projects/{shared}', {'workspacePaths': [str(workspace), str(added)]}, 'PATCH')
        changed = ids(peer) - original_peer
        require(len(changed) == 1 and changed <= ids(active), 'Project change did not synchronize all existing project sessions')
        require(ids(unrelated) == original_other, 'Workspace change leaked into another project')
        require(fixture.projection(daemon, peer)['run'] is None, 'Metadata synchronization started an idle Agent')
        require(fixture.projection(daemon, active)['run']['runId'] == original_run['runId'], 'Project update replaced the run')
        state.workspace_release.set()
        fixture.wait_until(lambda: fixture.projection(daemon, active).get('pendingPlan'), 20, 'Project-added directory Plan did not reach confirmation')
        waiting = fixture.projection(daemon, active)
        require(not waiting['pendingPlan'].get('workspaceRequests'), 'An already bound project directory asked to be added again')
        require(not (added / 'result.txt').exists(), 'Binding bypassed the Plan')
        fixture.cli(daemon, active, '/reply 1')
        complete = fixture.wait_completed(daemon, state, active, 'workspace-permission-complete')
        require((added / 'result.txt').read_text() == 'workspace-authorized', 'Approved project write did not execute')
        ended_bindings = complete['run']['workspaceBindings']
        api(f'projects/{shared}', {'workspacePaths': [str(workspace)]}, 'PATCH')
        require(not (changed & ids(peer)) and not (changed & ids(active)), 'Removed project directory remained in base bindings')
        require(fixture.projection(daemon, active)['run']['workspaceBindings'] == ended_bindings, 'Removal rewrote a completed run')
        state.assert_healthy()
    finally:
        state.workspace_release.set()

    candidate = root / 'permission-candidate'
    candidate.mkdir()
    target = candidate / 'target.txt'
    target.write_text('unchanged')
    for decision in ('cancel', 'confirm'):
        state = state_for('permission', 'target.txt')
        sid = session(shared)
        fixture.cli(daemon, sid, '/permissions ' + json.dumps({'agent.permissions.workspaceMutation': 'plan'}))
        references = api(f'sessions/{sid}/filesystem-references/resolve', {'references': [{'kind': 'file', 'path': str(target)}]})
        requested_id = references[0]['workspaceId']
        require(submit(sid, f'command:permission-{decision}', type='message.submit', text='Modify the supplied file.', filesystemReferences=references)['status'] == 'accepted', 'File task was not accepted')
        fixture.wait_until(lambda: fixture.projection(daemon, sid).get('pendingPlan'), 20, 'Missing workspace did not produce a user decision')
        waiting = fixture.projection(daemon, sid)
        plan = waiting['pendingPlan']
        require(plan['workspaceRequests'] == [{'workspaceId': requested_id, 'rootPath': str(candidate.resolve())}], 'Permission request lost its actual path')
        require(requested_id not in ids(sid) and requested_id not in ids(peer), 'Unconfirmed request expanded bindings')
        require(target.read_text() == 'unchanged', 'Permission request changed the target before approval')
        if decision == 'cancel':
            require(submit(sid, 'command:cancel-workspace', type='plan.respond', runId=plan['runId'], planId=plan['planId'], revision=plan['revision'], response={'kind': 'cancel'})['status'] == 'accepted', 'Cancellation rejected')
            fixture.wait_until(lambda: fixture.projection(daemon, sid)['run']['status'] == 'cancelled', 20, 'Cancelled Plan did not settle')
            require(requested_id not in ids(peer) and target.read_text() == 'unchanged', 'Cancelling granted workspace access')
        else:
            fixture.cli(daemon, sid, '/reply 1')
            fixture.wait_completed(daemon, state, sid, 'workspace-permission-complete')
            require(requested_id in ids(sid) and requested_id in ids(peer), 'Explicit permission did not synchronize project sessions')
            require(requested_id not in ids(unrelated), 'Permission changed another project')
            require(target.read_text() == 'workspace-authorized', 'Explicitly approved write was not executed')
        state.assert_healthy()
    print('[file-access-cli] PASS: project-wide existing-session sync, in-flight request preservation, removal, known-directory permission prompt, cancel and explicit confirmation')


def check_resource_tree(daemon, session, workspace):
    base = f'/api/conversation/sessions/{urllib.parse.quote(session, safe="")}/resources/'
    roots = fixture.api_json(daemon.base_url, base + 'roots', token=daemon.token)
    project = next(root for root in roots if root['category'] == 'project')['resource']
    require(any(root['category'] == 'session' for root in roots), 'Missing session files root')
    request = urllib.request.Request(daemon.base_url + base + 'watch', method='POST',
        headers={'content-type': 'application/json', fixture.HOST_TOKEN_HEADER: daemon.token},
        data=json.dumps({'resources': [project]}).encode())
    def event(stream):
        name, data = '', ''
        while True:
            line = stream.readline().decode().strip()
            if not line and data: return name, json.loads(data)
            if line.startswith('event:'): name = line[6:].strip()
            if line.startswith('data:'): data = line[5:].strip()
    with fixture.URL_OPENER.open(request, timeout=5) as stream:
        require(event(stream)[0] == 'ready', 'Watch did not register')
        target = workspace / 'watched.txt'
        target.write_text('current')
        require(event(stream) == ('change', {'indices': [0]}), 'Directory change was not delivered')
        entries = fixture.api_json(daemon.base_url, base + 'list', token=daemon.token, method='POST', body=project)
        entry = next(entry for entry in entries if entry['name'] == 'watched.txt')
        read = fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=entry['resource'])
        require(read['content'] == 'current', 'Tree reference did not read current bytes')
        target.unlink()
        failure = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=entry['resource'])
        require(not failure['ok'], 'Deleted current file produced substitute content')


def main():
    # Keep external-file boundaries outside the OS temporary paths permitted by macOS.
    scratch = fixture.ROOT / '.build-cache'
    scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='deepcode-file-access-', dir=scratch) as directory:
        root = Path(directory)
        workspace = root / 'project'
        workspace.mkdir()
        (workspace / '.git').mkdir()
        (workspace / '.git/HEAD').write_text('ref: refs/heads/main\n')
        external, sibling = root / 'selected.txt', root / 'sibling.txt'
        external.write_text('external-ok')
        sibling.write_text('not-granted')
        state = fixture.ProviderState(workspace)
        state.external, state.sibling = external, sibling
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        daemon = fixture.OwnedDaemon(root / 'config')
        try:
            fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.permissions.workspaceMutation': 'allow',
                **({'agent.windows.shell': 'auto'} if WINDOWS else {}),
            })
            daemon.start()
            session = fixture.create_session(daemon, workspace)['sessionId']
            fixture.cli(daemon, session, 'Read the selected external file and check the file boundary.', expected=5)
            check_resource_tree(daemon, session, workspace)
            pending = fixture.projection(daemon, session)['pendingApproval']
            access = pending['preview']['fileAccess']
            require(len(access['read']) == 1 and external.samefile(access['read'][0]) and access['write'] == [], pending)
            fixture.cli(daemon, session, '/reply 5', expected=5, run_timeout_seconds=120 if WINDOWS else 15)
            state.assert_healthy()
            require(external.read_text() == 'external-ok', 'Read grant allowed a write')
            pending = fixture.projection(daemon, session)['pendingApproval']
            write_targets = pending['preview']['fileAccess']['write']
            require(len(write_targets) == 1 and external.samefile(write_targets[0]), pending)
            fixture.cli(daemon, session, '/reply 1', expected=5)
            require((workspace / '.git/HEAD').read_text() == 'ref: refs/heads/main\n', 'Git metadata changed without approval')
            pending = fixture.projection(daemon, session)['pendingApproval']
            require(pending['preview']['authorizationScopes'] == [], 'Git write offered a reusable grant')
            fixture.cli(daemon, session, '/reply 1')
            require(external.read_text() == 'updated', 'Approved external write did not execute')
            require((workspace / '.git/HEAD').read_text() == 'approved', 'Approved Git write did not execute')
            require(not fixture.projection(daemon, session)['shellAuthorizations'], 'Turn grant survived settlement')
            fixture.cli(daemon, session, 'Read that file again in a new turn.', expected=5)
            fixture.cli(daemon, session, '/reply 6')
            grant = fixture.projection(daemon, session)['shellAuthorizations'][0]
            require(grant['scope'] == 'sessionFiles', grant)
            base = f'/api/conversation/sessions/{urllib.parse.quote(session, safe="")}/resources/'
            roots = fixture.api_json(daemon.base_url, base + 'roots', token=daemon.token)
            selected = next(root for root in roots if root['category'] == 'resource')['resource']
            require(selected['fileGrant']['authorityId'] == grant['authorityId'], 'Tree grant identity changed')
            require(fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=selected)['content'] == 'updated', 'Granted resource not readable')
            edited = next(activity['tool'] for activity in fixture.projection(daemon, session)['activities'] if activity.get('tool', {}).get('fileChanges'))
            change = {'recordId': edited['recordId'], 'index': 0}
            recorded = {'change': change, 'logicalPath': '', 'format': 'path'}
            require(external.samefile(fixture.api_json(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=recorded)['path']), 'Diff did not resolve its associated file')
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body={**selected, 'logicalPath': '../sibling.txt'})
            require(not denied['ok'], 'Single-file grant exposed parent directory')
            fixture.cli(daemon, session, 'Read the conversation resource again.')
            fixture.cli(daemon, session, '/revoke ' + grant['authorityId'])
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=selected)
            require(not denied['ok'], 'Revoked tree resource remained readable')
            denied = fixture.api_envelope(daemon.base_url, base + 'read', token=daemon.token, method='POST', body=recorded)
            require(not denied['ok'], 'Historical diff bypassed current file access')
            external.unlink()
            history = fixture.api_json(daemon.base_url, base.replace('/resources/', '/changes/read'), token=daemon.token, method='POST', body=change)
            require(history['after'] == 'updated', 'Deleted current file invalidated recorded diff')
            external.write_text('updated')
            fixture.cli(daemon, session, 'Try the removed resource again.', expected=5)
            fixture.cli(daemon, session, '/reply 2')
            state.assert_healthy()
            state = fixture.ProviderState(workspace)
            server.provider_state = state
            check_queued_reference_targets(daemon, state, root, workspace)
            check_project_workspace_and_permission(daemon, server, root, workspace)
            daemon.shutdown()
            print('[file-access-cli] PASS: exact external file, shared fs/Shell grant, child-process isolation, external/Git write approval, private temp, turn expiry, session reuse and revocation')
        except BaseException:
            if state.failure is not None:
                print('Provider assertion:', state.failure, flush=True)
            if daemon.identity is not None:
                print(json.dumps(fixture.projection(daemon, session), ensure_ascii=False), flush=True)
            raise
        finally:
            try:
                daemon.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                require(not thread.is_alive(), 'Provider fixture did not exit')


if __name__ == '__main__':
    main()
