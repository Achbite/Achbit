#!/usr/bin/env python3
"""Basic product subagents through the actual CLI, Session and Kernel."""
from contextlib import closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import urllib.parse

spec = importlib.util.spec_from_file_location('deepcode_test_support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require
MARKER = 'subagent-real-kernel-read'
ANALYSIS_CAPABILITIES = dict(messaging=False, continuation=False, delegation=False)
COLLABORATION_CAPABILITIES = dict(messaging=True, continuation=True, delegation=True)
TRACKED_PATH = 'tracked.txt'
FIRST_CONTENT = 'first revision\n'
SECOND_CONTENT = 'second revision\n'
PRIVATE_PATH = 'private-note.txt'
PRIVATE_CONTENT = 'child private archive\n'
LANES = ('MAIN_BASIC', 'ANALYSIS_READ', 'MEMBER_INITIAL', 'NESTED_READ', 'MEMBER_FOLLOWUP',
         'MAIN_CANCEL', 'CHILD_CANCEL')


def events(daemon, session=None):
    with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
        rows = database.execute('SELECT session_id,sequence,run_id,event_type,payload_json FROM session_events'
            + (' WHERE session_id=?' if session else '') + ' ORDER BY session_id,sequence',
            (session,) if session else ()).fetchall()
    return [dict(sessionId=sid, sequence=seq, runId=run, type=kind, payload=json.loads(payload))
            for sid, seq, run, kind, payload in rows]


class State(fixture.ProviderState):
    def __init__(self, workspace, daemon):
        super().__init__(workspace)
        self.daemon = daemon
        self.session = None
        self.lanes = {}
        self.lock = threading.Lock()
        self.async_acknowledged = threading.Event()
        self.plan_decisions = []

    def record_failure(self, error):
        if self.failure is None:
            self.failure = error

    def inspect_request(self, body):
        lane = next((lane for message in reversed(body['messages']) if message.get('role') == 'user'
                     for lane in LANES if fixture.message_text(message.get('content')).endswith(lane)), None)
        require(lane is not None, 'Provider request has no known scenario task')
        journal = events(self.daemon)
        sid = self.session if lane.startswith('MAIN_') else next(
            event['payload']['agentSessionId'] for event in reversed(journal)
            if event['type'] == 'agent.task.created' and event['payload']['text'] == lane)
        receipts = [event for event in journal if event['sessionId'] == sid and event['type'] == 'context.composed']
        require(receipts, 'Context receipt was not committed before transport')
        receipt = receipts[-1]['payload']
        names = {tool['canonicalName']: tool['wireName'] for tool in receipt['tools']}
        require(set(names.values()) == {tool['function']['name'] for tool in body['tools']}, 'Wire directory differs from receipt')
        require(body.get('stream') is True, 'Provider request is not streaming')
        require(body['model'] == ('mock-main' if lane.startswith('MAIN_') else 'mock-agent'), 'Independent model binding lost')
        if not lane.startswith('MAIN_'):
            require(body.get('reasoning_effort') == 'xhigh', 'Independent child reasoning setting lost')
            require(not any(name.startswith(('computer.', 'browser.')) for name in names), 'Child exposes desktop tools')
        if lane in ('ANALYSIS_READ', 'NESTED_READ', 'CHILD_CANCEL'):
            require('agent' not in names, 'Child without messaging/delegation exposes agent controls')
        else:
            definition = next(tool['function']['parameters'] for tool in body['tools']
                              if tool['function']['name'] == names['agent'])
            # Operation contracts arrive in the models result; the wire schema stays a stable prefix.
            action = definition['properties']['action']
            require(action.get('type') == 'string' and 'enum' not in action and 'const' not in action,
                    'Agent control schema must not change with discovery')
        with self.lock:
            previous = self.lanes.setdefault(lane, [])
            if previous:
                prefix = previous[-1]['messages']
                require(body['messages'][:len(prefix)] == prefix, f'{lane}: already-sent prefix changed')
                require(body['tools'] == previous[-1]['tools'], f'{lane}: tool directory changed between requests')
            previous.append(body)
            ordinal = len(previous)
            self.requests.append(dict(lane=lane, ordinal=ordinal, sessionId=sid, receipt=receipt, body=body))
        results = {message['tool_call_id']: json.loads(message['content']) for message in body['messages']
                   if message.get('role') == 'tool'}
        if 'models' in results:
            operations = {operation['action'] for operation in results['models']['operations']}
            require(operations == {'models', 'spawn', 'send', 'wait', 'cancel', 'close'},
                    f'{lane}: discovered agent operations are incorrect: {sorted(operations)}')
        return lane, ordinal, names, results, sid


def delivered_results(body):
    return [payload for payload in fixture.json_payloads(body) if payload.get('type') == 'agent.result']


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            lane, ordinal, names, results, sid = state.inspect_request(body)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream; charset=utf-8')
            self.send_header('connection', 'close')
            self.end_headers()

            def agent(call_id, **operation):
                self._send_tool_calls([(call_id, names['agent'], operation)])

            if lane in ('MAIN_BASIC', 'MAIN_CANCEL', 'MEMBER_INITIAL'):
                if ordinal == 1:
                    agent('models', action='models')
                    return
                require(results['models']['models'], 'Discovery did not return model profiles')
                ordinal -= 1

            if lane == 'MAIN_BASIC':
                if ordinal == 1:
                    # This scenario needs a one-shot reader; the analysis template now keeps a continuable parent-messaging instance.
                    agent('analyze', action='spawn', preset='analysis', capabilities=ANALYSIS_CAPABILITIES,
                          task='ANALYSIS_READ', name='Reader', delivery='async')
                elif ordinal == 2:
                    acknowledgement = results['analyze']
                    require(set(acknowledgement) == {'taskId', 'agentId'}, 'Async call did not return just its task acknowledgement')
                    require(not delivered_results(body), 'Analysis finished before the parent could continue')
                    state.async_acknowledged.set()
                    agent('wait-analysis', action='wait', taskIds=[acknowledgement['taskId']])
                elif ordinal == 3:
                    task_id = results['analyze']['taskId']
                    require(results['wait-analysis']['completedTaskIds'] == [task_id], 'Analysis wait lost its task')
                    delivered = [item for item in delivered_results(body) if item['taskId'] == task_id]
                    require(len(delivered) == 1 and delivered[0]['result']['content'] == 'analysis-read-complete', 'Async result missing or duplicated')
                    agent('close-reader', action='close', agentId=results['analyze']['agentId'])
                elif ordinal == 4:
                    require(results['close-reader']['closed'] is True, 'Explicit reader cleanup failed')
                    agent('spawn', action='spawn', preset='collaboration', task='MEMBER_INITIAL', name='Collaborator', delivery='wait')
                elif ordinal == 5:
                    require(results['spawn']['outcome'] == 'completed' and results['spawn']['content'] == 'member-initial-complete', 'Member result missing')
                    agent('send', action='send', agentId=results['spawn']['agentId'], text='MEMBER_FOLLOWUP')
                elif ordinal == 6:
                    require(results['send']['agentId'] == results['spawn']['agentId'], 'Follow-up replaced the persistent member')
                    agent('wait-member', action='wait', taskIds=[results['send']['taskId']])
                elif ordinal == 7:
                    require(results['wait-member']['completedTaskIds'] == [results['send']['taskId']], 'Follow-up was not completed')
                    delivered = delivered_results(body)
                    require(len(delivered) == 2 and len({item['taskId'] for item in delivered}) == 2, 'Async evidence was repeated or wait result redelivered')
                    require(any(item['result']['content'] == 'member-followup-complete' for item in delivered), 'Follow-up evidence missing')
                    agent('close', action='close', agentId=results['spawn']['agentId'])
                elif ordinal == 8:
                    require(results['close']['closed'] is True, 'Continuing child did not close')
                    agent('over-limit', action='spawn', task='MUST_NOT_START', name='Over limit', delivery='async')
                elif ordinal == 9:
                    rejected = results['over-limit']
                    require(rejected.get('accepted') is False and rejected.get('executed') is False
                            and 'agent_run_call_limit' in json.dumps(rejected['error']), 'Configured call limit did not reject the request')
                    self._send_text('subagent-basic-complete')
                else:
                    raise AssertionError(f'Unexpected main request: {ordinal}')
            elif lane in ('ANALYSIS_READ', 'NESTED_READ'):
                if ordinal == 1:
                    if lane == 'ANALYSIS_READ':
                        require(state.async_acknowledged.wait(timeout=15), 'Parent did not continue after asynchronous delegation')
                    self._send_tool_calls([('read', names['fs.read'], {'path': 'probe.txt'})])
                else:
                    require(ordinal == 2 and results['read']['outcome'] == 'completed' and MARKER in json.dumps(results['read']), 'Child did not execute the actual read')
                    self._send_text('analysis-read-complete' if lane == 'ANALYSIS_READ' else 'nested-read-complete')
            elif lane == 'MEMBER_INITIAL':
                if ordinal == 1:
                    agent('nested', action='spawn', preset='collaboration', capabilities=ANALYSIS_CAPABILITIES,
                          task='NESTED_READ', name='Nested reader', delivery='wait')
                elif ordinal == 2:
                    require(results['nested']['outcome'] == 'completed'
                            and results['nested']['content'] == 'nested-read-complete', 'Nested result missing')
                    child = fixture.projection(state.daemon, sid)
                    private_id = child['sessionDirectoryIndexes'][0]['workspaceId']
                    index = next(index for index, binding in enumerate(child['run']['workspaceBindings'])
                                 if binding['workspaceId'] == private_id)
                    private_handle = 'primary' if index == 0 else f'workspace{index + 1}'
                    self._send_tool_calls([('plan-files', names['plan.publish'], {
                        'title': 'Create child work files', 'summary': 'Write one shared report and one private note.',
                        'steps': [{'stepId': 'files', 'title': 'Write files', 'details': 'Save the two requested files.'}],
                        'mutationManifest': [
                            {'workspace': 'primary', 'operation': 'fs.write', 'target': TRACKED_PATH},
                            {'workspace': private_handle, 'operation': 'fs.write', 'target': PRIVATE_PATH}],
                    })])
                elif ordinal == 3:
                    self._send_tool_calls([('write-first', names['fs.write'], {'path': TRACKED_PATH, 'content': FIRST_CONTENT})])
                elif ordinal == 4:
                    require(results['write-first']['outcome'] == 'completed', 'Child file creation failed')
                    child = fixture.projection(state.daemon, sid)
                    private_id = child['sessionDirectoryIndexes'][0]['workspaceId']
                    bindings = child['run']['workspaceBindings']
                    index = next(index for index, binding in enumerate(bindings) if binding['workspaceId'] == private_id)
                    handle = 'primary' if index == 0 else f'workspace{index + 1}'
                    self._send_tool_calls([('write-private', names['fs.write'],
                        {'workspace': handle, 'path': PRIVATE_PATH, 'content': PRIVATE_CONTENT})])
                else:
                    require(ordinal == 5 and results['write-private']['outcome'] == 'completed', 'Child private file creation failed')
                    self._send_text('member-initial-complete')
            elif lane == 'MEMBER_FOLLOWUP':
                require(any(message.get('content') == 'member-initial-complete'
                        for message in body['messages']), 'Persistent member lost its earlier conversation')
                if ordinal == 1:
                    self._send_tool_calls([('plan-followup', names['plan.publish'], {
                        'title': 'Update child report', 'summary': 'Save the reviewed shared report.',
                        'steps': [{'stepId': 'report', 'title': 'Update report', 'details': 'Write the requested revision.'}],
                        'mutationManifest': [{'workspace': 'primary', 'operation': 'fs.write', 'target': TRACKED_PATH}],
                    })])
                elif ordinal == 2:
                    self._send_tool_calls([('write-second', names['fs.write'], {'path': TRACKED_PATH, 'content': SECOND_CONTENT})])
                else:
                    require(ordinal == 3 and results['write-second']['outcome'] == 'completed', 'Child file update failed')
                    self._send_text('member-followup-complete')
            elif lane == 'MAIN_CANCEL':
                if ordinal == 1:
                    agent('cancel-child', action='spawn', preset='analysis', capabilities=ANALYSIS_CAPABILITIES,
                          task='CHILD_CANCEL', name='Waiting child', delivery='async')
                else:
                    require(ordinal == 2, 'Parent resumed unexpectedly before cancellation')
                    self._send_text('must-not-commit-before-child-finishes')
            elif lane == 'CHILD_CANCEL':
                require(ordinal == 1, 'Cancelled child requested another turn')
                self._send_tool_calls([('question', names['interaction.request'], {
                    'mode': 'wait', 'kind': 'question', 'prompt': 'Await the cancellation check.', 'allowFreeform': True,
                })])
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def configure(daemon, server):
    fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
        'agent.subagents.enabled': True, 'agent.subagents.profileId': 'e2e-agent',
        'agent.subagents.reasoningEffort': 'xhigh', 'agent.subagents.maxCallsPerRun': 3,
        # The family retains both the collaborator and its nested reader until explicit close.
        'agent.subagents.maxConcurrent': 4, 'agent.subagents.maxMembersPerSession': 2,
        'agent.subagents.allowMemberAnalysis': True,
    })
    path = daemon.config_root / 'config/user/local/settings/llm-profiles.json'
    profiles = json.loads(path.read_text(encoding='utf-8'))
    profiles['profiles'].append(dict(profiles['profiles'][0], id='e2e-agent', name='Child model',
                                    model='mock-agent', thinking='enabled', reasoningEffort='high'))
    path.write_text(json.dumps(profiles), encoding='utf-8')


def confirm_requested_plans(state, stop):
    seen = set()
    try:
        while not stop.wait(.05):
            for sid in {event['sessionId'] for event in events(state.daemon) if event['type'] == 'run.started'}:
                current = fixture.projection(state.daemon, sid)
                plan = current.get('pendingPlan')
                if not plan or (sid, plan['planId'], plan['revision']) in seen:
                    continue
                require(current.get('agentContext', {}).get('capabilities', {}).get('continuation'),
                        'Only the assigned continuing child may request a file Plan')
                private = {item['workspaceId'] for item in current['sessionDirectoryIndexes']}
                allowed = {(item['workspaceId'], PRIVATE_PATH if item['workspaceId'] in private else TRACKED_PATH)
                           for item in current['run']['workspaceBindings']}
                require(plan['mutationManifest'] and all(item['operation'] == 'fs.write'
                        and (item['workspaceId'], item['target']) in allowed for item in plan['mutationManifest']),
                        'Plan exceeds the assigned two exact file targets')
                reply = fixture.api_json(state.daemon.base_url,
                    '/api/conversation/sessions/' + urllib.parse.quote(sid, safe='') + '/commands',
                    token=state.daemon.token, method='POST', body={
                        'schemaVersion': fixture.COMMAND_VERSION, 'type': 'plan.respond',
                        'commandId': f'confirm-files:{plan["planId"]}:{plan["revision"]}', 'sessionId': sid,
                        'runId': current['run']['runId'], 'planId': plan['planId'], 'revision': plan['revision'],
                        'response': {'kind': 'confirm'},
                    })
                require(reply['status'] == 'accepted', 'Child Plan confirmation was not accepted')
                seen.add((sid, plan['planId'], plan['revision']))
                state.plan_decisions.append(dict(sessionId=sid, planId=plan['planId'], revision=plan['revision']))
    except BaseException as error:
        state.record_failure(error)


def validate_journal(daemon, session, mode):
    journal = events(daemon)
    parent = [event for event in journal if event['sessionId'] == session]
    created = [event for event in journal if event['type'] == 'agent.task.created']
    require(len(created) == (4 if mode == 'basic' else 1), 'Unexpected task creation count')
    for task in created:
        completions = [event for event in journal if event['type'] == 'agent.task.completed'
                       and event['payload']['taskId'] == task['payload']['taskId']]
        require(len(completions) == 1, 'Task completion was omitted or recorded more than once')
        require(completions[0]['sessionId'] == task['sessionId'], 'Result was copied to another parent journal')
        require(completions[0]['payload']['result']['outcome'] == ('completed' if mode == 'basic' else 'cancelled'), 'Unexpected child outcome')
        owner_settle = next(event for event in journal if event['sessionId'] == task['sessionId']
                            and event['runId'] == task['runId'] and event['type'] == 'run.settled')
        require(completions[0]['sequence'] < owner_settle['sequence'], 'Parent settled before its child result')
    started = [event for event in journal if event['type'] == 'run.started']
    for start in started:
        run = [event for event in journal if event['sessionId'] == start['sessionId'] and event['runId'] == start['runId']]
        kinds = [event['type'] for event in run]
        require(kinds.count('run.runtime.released') == kinds.count('run.settled') == 1, 'Run lifecycle was not closed once')
        require('run.runtime.release_failed' not in kinds and kinds.index('run.runtime.released') < kinds.index('run.settled'), 'Runtime release failed or followed settlement')
    snapshots = {sid: fixture.projection(daemon, sid) for sid in {event['sessionId'] for event in started}}
    require(snapshots[session]['run']['status'] == ('completed' if mode == 'basic' else 'cancelled'), 'Parent outcome mismatch')
    for task in created:
        child = snapshots[task['payload']['agentSessionId']]
        require(child['agentContext']['ownerSessionId'] == session
                and child['agentContext']['parentSessionId'] == task['sessionId'], 'Child lineage changed')
        require(child['modelSettings']['profileId'] == 'e2e-agent'
                and child['modelSettings']['reasoningEffortOverride'] == 'xhigh', 'Child model settings were not retained')
        require(child['run']['status'] == ('completed' if mode == 'basic' else 'cancelled'), 'Child did not settle')
        require(child['agentContext']['capabilities'] == task['payload']['capabilities'], 'Task and child capabilities differ')
        require('role' not in task['payload'] and 'role' not in child['agentContext'], 'Removed role contract leaked into facts')
    if mode == 'basic':
        tasks = snapshots[session]['agentTasks']
        members = [task for task in tasks if task['capabilities']['continuation']]
        require(len(tasks) == 3 and len(members) == 2 and members[0]['agentSessionId'] == members[1]['agentSessionId']
                and members[0]['childRunId'] != members[1]['childRunId'], 'Member follow-up did not reuse its Session with a new run')
        member = snapshots[members[0]['agentSessionId']]
        require(len(member['agentTasks']) == 1 and member['agentTasks'][0]['capabilities'] == ANALYSIS_CAPABILITIES,
                'Explicit nested capabilities are not retained under their actual parent')
        children = snapshots[session]['agentChildren']
        require(len(children) == 2 and len(member['agentChildren']) == 1, 'Created agents are absent from agentChildren')
        require(all(child['closed'] for child in children)
                and member['agentChildren'][0]['closed'], 'Continuation/non-continuation child lifetime is incorrect')
        require(member['agentContext']['capabilities'] == COLLABORATION_CAPABILITIES, 'Collaboration preset was not applied')
        require([task['payload']['createsAgent'] for task in created if task['payload']['agentSessionId'] == member['sessionId']]
                == [True, False], 'Follow-up was incorrectly recorded as a new agent')
        require(all(task['payload']['createsAgent'] for task in created if task['payload']['agentSessionId'] != member['sessionId']),
                'A new agent was not marked as creating its instance')
        require(any(event['type'] == 'session.control.rejected' and 'agent_run_call_limit' in json.dumps(event['payload'])
                    for event in parent), 'Quota rejection is absent from the journal')
        with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/tool-record.sqlite3')) as database:
            records = [json.loads(row[0]) for row in database.execute('SELECT record_json FROM tool_records')]
        readers = {task['payload']['agentSessionId'] for task in created if task['payload']['text'] in ('ANALYSIS_READ', 'NESTED_READ')}
        reads = [record for record in records if record['toolName'] == 'fs.read']
        require(len(reads) == 2 and {record['sessionId'] for record in reads} == readers
                and all(record['toolName'] == 'fs.read' and record['outcome'] == 'completed'
                for record in reads), 'Expected two real Kernel reads')
        writes = [record for record in records if record['toolName'] == 'fs.write']
        require(len(records) == 5 and len(writes) == 3 and all(record['sessionId'] == member['sessionId']
                and record['outcome'] == 'completed' for record in writes), 'Expected three real writes by the continuing child')
    else:
        records = []
        premature = {event['payload']['messageId'] for event in parent if event['type'] == 'message.committed'
                     and event['payload'].get('content') == 'must-not-commit-before-child-finishes'}
        require(not any(event['type'] == 'run.settled' and event['payload'].get('finalMessageId') in premature
                        for event in parent), 'Parent prematurely committed a final answer')
    return journal, snapshots, records


def read_child_changes(daemon, session, snapshots, records, workspace, output):
    writes = sorted((record for record in records if record['toolName'] == 'fs.write'),
                    key=lambda record: [FIRST_CONTENT, SECOND_CONTENT, PRIVATE_CONTENT].index(record['input']['content']))
    archived = []
    for record in writes:
        sid = record['sessionId']
        require(sid != session and record['recordId'] not in {
            item.get('tool', {}).get('recordId') for item in snapshots[session]['activities']},
            'Child ToolRecord was copied into the root projection')
        activity = next(item for item in snapshots[sid]['activities']
                        if item.get('tool', {}).get('recordId') == record['recordId'])
        require(len(activity['tool']['fileChanges']) == 1, 'Child projection lost its file change')
        change = fixture.api_json(daemon.base_url,
            '/api/conversation/sessions/' + urllib.parse.quote(sid, safe='') + '/changes/read',
            token=daemon.token, method='POST', body={'recordId': record['recordId'], 'index': 0})
        archived.append(dict(sessionId=sid, recordId=record['recordId'], **change))
    require([(item['before'], item['after']) for item in archived] ==
            [(None, FIRST_CONTENT), (FIRST_CONTENT, SECOND_CONTENT), (None, PRIVATE_CONTENT)],
            'Archived child diffs changed with later workspace writes')
    private = writes[-1]
    require(private['input']['path'] == PRIVATE_PATH and private['preparedEffect']['workspaceId'] in {
        binding['workspaceId'] for binding in snapshots[private['sessionId']]['sessionDirectoryIndexes']},
        'Child private file did not use its sessionDirectory binding')
    require((workspace / TRACKED_PATH).read_text() == SECOND_CONTENT, 'Shared workspace lacks final child content')
    catalog = fixture.api_json(daemon.base_url, '/api/conversation/catalog', token=daemon.token)
    require({item['id'] for item in catalog['sessions']} == {session}, 'Child Sessions appeared as independent top-level conversations')
    if output:
        (output / 'child-file-changes.json').write_text(json.dumps(archived, indent=2) + '\n', encoding='utf-8')
    return archived


def delete_family(daemon, session, snapshots, workspace, output):
    family = set(snapshots)
    catalog_path = daemon.config_root / 'data/agent-runtime/catalog.sqlite3'
    with closing(fixture.sqlite_read_only(catalog_path)) as database:
        catalog_ids = {row[0] for row in database.execute('SELECT session_id FROM session_catalog')}
        workdirs = [dict(sessionId=owner, workspaceId=identity, path=path) for owner, identity, path in database.execute(
            'SELECT w.owner_session_id,w.workspace_id,w.canonical_root FROM workspaces w '
            'JOIN session_workdirs d USING(workspace_id)') if owner in family]
        shared_ids = [identity for identity, path in database.execute(
            'SELECT workspace_id,canonical_root FROM workspaces WHERE owner_session_id IS NULL')
            if Path(path).samefile(workspace)]
    require(family <= catalog_ids, 'Family was missing from the Host catalog before deletion')
    require(len(workdirs) == len(family) and {row['sessionId'] for row in workdirs} == family,
            'Each family Session must own its private working directory')
    require(all(Path(row['path']).is_dir() and any(parent.samefile(daemon.config_root)
                for parent in Path(row['path']).parents) for row in workdirs),
            'Private working directory is absent or outside the owned runtime')
    require(len(shared_ids) == 1, 'Shared workspace identity is absent or ambiguous')
    before = {'sessionIds': sorted(family), 'privateWorkdirs': workdirs}
    if output:
        (output / 'family-delete-before.json').write_text(json.dumps(before, indent=2) + '\n', encoding='utf-8')
    reply = fixture.api_json(daemon.base_url, '/api/conversation/sessions/' + urllib.parse.quote(session, safe=''),
                             token=daemon.token, method='DELETE', timeout=20)
    require(not family.intersection(item['id'] for item in reply['sessions']), 'Deleted family remains in the public catalog')
    with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as database:
        for sid in family:
            require(database.execute('SELECT COUNT(*) FROM sessions WHERE session_id=?', (sid,)).fetchone()[0] == 0,
                    f'Deleted Session remains stored: {sid}')
            require(database.execute('SELECT COUNT(*) FROM session_events WHERE session_id=?', (sid,)).fetchone()[0] == 0,
                    f'Deleted journal remains stored: {sid}')
    with closing(fixture.sqlite_read_only(catalog_path)) as database:
        for sid in family:
            require(database.execute('SELECT COUNT(*) FROM session_catalog WHERE session_id=?', (sid,)).fetchone()[0] == 0,
                    f'Deleted Session remains in the Host catalog: {sid}')
            require(database.execute('SELECT COUNT(*) FROM workspaces WHERE owner_session_id=?', (sid,)).fetchone()[0] == 0,
                    f'Deleted Session retains private catalog entries: {sid}')
        require(database.execute('SELECT COUNT(*) FROM workspaces WHERE workspace_id=? AND owner_session_id IS NULL',
                                 (shared_ids[0],)).fetchone()[0] == 1, 'Shared workspace catalog entry was removed')
    require(all(not Path(row['path']).exists() for row in workdirs), 'Deleted family retains private working directories')
    require(workspace.is_dir() and (workspace / 'probe.txt').read_bytes() == (MARKER + '\n').encode(),
            'Family deletion changed the shared workspace probe')
    require((workspace / TRACKED_PATH).read_text() == SECOND_CONTENT, 'Family deletion removed the child-created shared work file')
    receipt = {**before, 'publicReply': reply, 'journalRemoved': True, 'catalogRemoved': True,
               'privateWorkdirsRemoved': True, 'sharedWorkspacePreserved': True}
    if output:
        (output / 'family-delete.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return receipt


def check_mode(mode):
    receipts_root = os.environ.get('DEEPCODE_SUBAGENT_RECEIPTS')
    output = Path(receipts_root) / mode if receipts_root else None
    if output:
        output.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix=f'deepcode-subagent-{mode}-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        (workspace / 'probe.txt').write_text(MARKER + '\n', encoding='utf-8')
        daemon = fixture.OwnedDaemon(root / 'user')
        state = State(workspace, daemon)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        client = None
        decision_stop = threading.Event()
        decision_thread = None
        report = {'scenario': mode, 'status': 'failed'}
        thread.start()
        try:
            configure(daemon, server)
            daemon.start()
            state.session = fixture.create_session(daemon, workspace)['sessionId']
            report.update(sessionId=state.session, hostPid=daemon.process.pid, hostPort=daemon.port, providerPort=server.server_port)
            if mode == 'basic':
                decision_thread = threading.Thread(target=confirm_requested_plans, args=(state, decision_stop), daemon=True)
                decision_thread.start()
                environment = fixture.shell_environment(daemon)
                environment['DEEPCODE_CLI_RUN_TIMEOUT_MS'] = '45000'
                result = subprocess.run([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                    '--session', state.session, '--plain', 'ask', 'MAIN_BASIC'], cwd=fixture.ROOT, env=environment,
                    capture_output=True, text=True, encoding='utf-8', timeout=75)
                # A one-shot CLI may observe the pending child Plan before the
                # fixture's explicit user confirmation reaches the producer.
                require(result.returncode in (0, 5), result.stdout + result.stderr)
                stdout, stderr = result.stdout, result.stderr
                def completed():
                    state.assert_healthy()
                    current = fixture.projection(daemon, state.session)
                    require(current['run']['status'] not in ('failed', 'cancelled', 'indeterminate'), current)
                    return current if current['run']['status'] == 'completed' else None
                fixture.wait_until(completed, 45, 'Parent did not complete after explicit child Plan confirmations')
                decision_stop.set()
                decision_thread.join(timeout=8)
                history = subprocess.run([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                    '--session', state.session, '--plain', 'read', '--view', 'messages'], cwd=fixture.ROOT,
                    env=environment, capture_output=True, text=True, encoding='utf-8', timeout=15)
                require(history.returncode == 0, history.stdout + history.stderr)
                stdout += history.stdout
                stderr += history.stderr
                require('subagent-basic-complete' in stdout, 'CLI final answer missing')
                require(len(state.plan_decisions) == 2, 'Expected an explicit child Plan confirmation in both file-writing runs')
            else:
                command = [str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                           '--session', state.session, '--plain', 'ask', 'MAIN_CANCEL']
                client = subprocess.Popen(command, cwd=fixture.ROOT, env=fixture.shell_environment(daemon),
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')

                def ready_to_cancel():
                    state.assert_healthy()
                    parent = fixture.projection(daemon, state.session)
                    tasks = parent.get('agentTasks', [])
                    if len(tasks) != 1 or not tasks[0].get('childRunId'):
                        return None
                    child = fixture.projection(daemon, tasks[0]['agentSessionId'])
                    settled_turns = [event for event in events(daemon, state.session) if event['type'] == 'provider.turn.settled']
                    return parent if child['run']['status'] == 'waiting' and len(settled_turns) == 3 else None

                current = fixture.wait_until(ready_to_cancel, 15, 'Parent did not defer final answer for its waiting child')
                cancelled = subprocess.run([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                    '--session', state.session, '--plain', 'cancel', current['run']['runId']], cwd=fixture.ROOT,
                    env=fixture.shell_environment(daemon), capture_output=True, text=True, encoding='utf-8', timeout=25)
                require(cancelled.returncode == 8, cancelled.stdout + cancelled.stderr)
                stdout, stderr = client.communicate(timeout=20)
                # The first one-shot observer may have already reported the child
                # question. The explicit cancellation CLI must observe exit 8.
                require(client.returncode in (5, 8), stdout + stderr)
                if client.returncode == 5:
                    require('Await the cancellation check.' in stdout, stdout + stderr)
                stdout += cancelled.stdout
                stderr += cancelled.stderr
            state.assert_healthy()
            journal, snapshots, records = validate_journal(daemon, state.session, mode)
            if output:
                for name, value in (('events', journal), ('projections', snapshots), ('tool-records', records)):
                    (output / f'{name}.json').write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                (output / 'cli.log').write_text(stdout + stderr, encoding='utf-8')
            if mode == 'basic':
                report['archivedFileChanges'] = read_child_changes(daemon, state.session, snapshots, records, workspace, output)
                report['familyDeleteRequested'] = True
                deletion = delete_family(daemon, state.session, snapshots, workspace, output)
                report.update(deletedSessionIds=deletion['sessionIds'], familyDeletionPassed=True)
            daemon.shutdown()
            report.update(status='passed', providerRequests=len(state.requests), ownedTasks=4 if mode == 'basic' else 1)
        except BaseException as error:
            report['error'] = str(error)
            print(daemon.log_tail())
            if state.failure is not None:
                print('Provider assertion:', state.failure)
            raise
        finally:
            state.async_acknowledged.set()
            decision_stop.set()
            if decision_thread is not None:
                decision_thread.join(timeout=8)
            try:
                if client is not None and client.poll() is None:
                    client.terminate()
                    try:
                        client.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        client.kill()
                        client.communicate(timeout=5)
                if output:
                    (output / 'daemon.log').write_text(daemon.log_tail(), encoding='utf-8')
                    if (daemon.config_root / 'data/agent-runtime/session.sqlite3').is_file():
                        name = ('post-delete-events.json' if report.get('familyDeleteRequested') else 'final-events.json') \
                            if (output / 'events.json').exists() else 'events.json'
                        (output / name).write_text(json.dumps(events(daemon), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                daemon.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                report.update(hostReleased=daemon.process is None or daemon.process.poll() is not None,
                              providerReleased=not thread.is_alive(), cliReleased=client is None or client.poll() is not None)
                report['planDecisions'] = state.plan_decisions
                report['decisionWorkerReleased'] = decision_thread is None or not decision_thread.is_alive()
                if state.failure is not None:
                    report['fixtureError'] = repr(state.failure)
                if output:
                    (output / 'provider-requests.json').write_text(json.dumps(state.requests, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                    (output / 'receipt.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                require(all(report[key] for key in ('hostReleased', 'providerReleased', 'cliReleased', 'decisionWorkerReleased')), report)
        print(f'[subagent-cli] PASS: {mode}, actual CLI/Kernel, child ownership and owned cleanup')


if __name__ == '__main__':
    check_mode('basic')
    check_mode('cancel')
