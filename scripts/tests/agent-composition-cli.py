#!/usr/bin/env python3
"""Composed root/child drivers and inherited Kernel gates through the actual CLI."""
from contextlib import closing
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require


def events(daemon):
    with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/session.sqlite3')) as db:
        return [dict(sessionId=sid, type=kind, payload=json.loads(payload)) for sid, kind, payload in db.execute(
            'SELECT session_id,event_type,payload_json FROM session_events ORDER BY rowid')]


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            lane = next((lane for message in reversed(body['messages']) if message.get('role') == 'user'
                         for lane in ['COMPOSE_CHILD', 'COMPOSE_RESUME', 'COMPOSE_ROOT', 'PERMISSION_ROOT',
                                      'PERMISSION_CONTINUE', 'PERMISSION_CHILD', 'PERMISSION_CHILD_RESUME']
                         if fixture.message_text(message.get('content')).endswith(lane)), None)
            require(lane is not None, 'Unknown Provider scenario')
            journal = events(state.daemon)
            if lane.startswith('PERMISSION_'):
                parent = next(event['sessionId'] for event in journal if event['type'] == 'session.created'
                              and event['payload'].get('recipe', {}).get('runner', {}).get('parameters', {}).get('label') == 'permission-root')
                child = next((event['payload']['agentSessionId'] for event in journal
                              if event['sessionId'] == parent and event['type'] == 'agent.task.created'), None)
                sid = child if lane.startswith('PERMISSION_CHILD') else parent
            else:
                sid = next(event['payload']['agentSessionId'] for event in journal if event['type'] == 'agent.task.created' and event['payload']['text'] == 'COMPOSE_CHILD') if lane == 'COMPOSE_CHILD' else next(
                    event['sessionId'] for event in journal if event['type'] == 'session.created')
            receipt = [event for event in journal if event['sessionId'] == sid and event['type'] == 'context.composed'][-1]['payload']
            names = {tool['canonicalName']: tool['wireName'] for tool in receipt['tools']}
            require('todo.update' not in names, 'Recipe controls were not selected')
            require(body['model'] == ('mock-child' if lane == 'COMPOSE_CHILD' or lane.startswith('PERMISSION_CHILD') else 'mock-main'), 'Recipe model binding lost')
            require(set(names.values()) == {tool['function']['name'] for tool in body['tools']}, 'Tool receipt mismatch')
            results = {message['tool_call_id']: json.loads(message['content']) for message in body['messages'] if message.get('role') == 'tool'}
            ordinal = state.ordinals.get(lane, 0) + 1
            state.ordinals[lane] = ordinal
            state.requests.append(body)
            if lane == 'PERMISSION_CHILD' and ordinal >= 3 or lane == 'PERMISSION_CHILD_RESUME':
                require('plan.publish' in names, 'Tightening permission did not restore the Plan tool')
                instructions = '\n'.join(fixture.message_text(message.get('content'))
                                         for message in body['messages'] if message.get('role') in ('system', 'developer'))
                require('it is confirmed automatically' not in instructions, 'Child Provider received stale automatic Plan instructions')
                require('Do not mutate' in instructions or 'confirmation' in instructions, 'Current Plan permission instructions missing')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()

            def call(call_id, name, arguments):
                self._send_tool_calls([(call_id, names[name], arguments)])

            if lane == 'COMPOSE_ROOT':
                if ordinal == 1:
                    call('discover', 'agent', {'action': 'models'})
                elif ordinal == 2:
                    choices = results['discover']
                    require({preset['id'] for preset in choices['presets']} == {'analysis', 'collaboration'}, 'Default templates missing')
                    require(any(item['id'] == 'fixture-driver' for item in choices['runners']), 'Registered driver not discoverable')
                    require(choices['fullConfiguration'] is True, 'Default composition choices are restricted')
                    call('widen', 'agent', dict(action='spawn', task='MUST_NOT_START', name='Rejected', delivery='wait',
                         permissions={'agent.permissions.workspaceMutation': 'allow'}))
                elif ordinal == 3:
                    require('agent_permission_not_grantable' in json.dumps(results['widen']), 'Child widened parent permission')
                    call('plan', 'plan.publish', dict(title='Write one report', summary='Only allowed.txt may change.',
                         steps=[dict(stepId='write', title='Write', details='Write the approved report.')],
                         mutationManifest=[dict(workspace='primary', operation='fs.write', target='allowed.txt')]))
                elif ordinal == 4:
                    call('spawn', 'agent', dict(action='spawn', preset='collaboration', task='COMPOSE_CHILD', name='Report specialist', delivery='wait',
                         profileId='e2e-child', runner=dict(id='fixture-driver', parameters=dict(label='child')),
                         capabilities=dict(messaging=False, continuation=False, delegation=False),
                         context=dict(id='journal'), loop=dict(compaction=dict(id='summary', parameters=dict(pressureRatio=0.8)),
                         controls=dict(id='standard', parameters=dict(optionalTools=[]))),
                         permissionPolicy=dict(id='workspace-only'), workspaceSandbox=dict(backendId='platform-default')))
                else:
                    require(ordinal == 5 and results['spawn'].get('outcome') == 'completed', json.dumps(results))
                    self._send_text('composition-complete')
            elif lane == 'COMPOSE_CHILD':
                if ordinal == 1:
                    call('write', 'fs.write', dict(path='allowed.txt', content='parent-authorized report\n'))
                elif ordinal == 2:
                    require(results['write'].get('outcome') == 'completed', json.dumps(results['write']))
                    call('outside', 'fs.write', dict(path='outside.txt', content='must not exist'))
                elif ordinal == 3:
                    require('plan_scope_required' in json.dumps(results['outside']), 'Out-of-scope write passed Kernel gate')
                    call('host', 'bash', dict(command='echo must-not-execute', requestHostPermission='Test restricted route'))
                elif ordinal == 4:
                    require('permission_policy_denied' in json.dumps(results['host']), 'Host execution bypassed recipe policy')
                    call('read', 'fs.read', dict(path='allowed.txt'))
                else:
                    require(ordinal == 5 and 'parent-authorized report' in json.dumps(results['read']), 'Actual Kernel read failed')
                    self._send_text('child-composition-complete')
            elif lane == 'PERMISSION_ROOT':
                if ordinal == 1:
                    call('permission-spawn', 'agent', dict(action='spawn', preset='collaboration', name='Continuing writer', task='PERMISSION_CHILD',
                         delivery='wait', profileId='e2e-child', capabilities=dict(messaging=True, continuation=True, delegation=True),
                         runner=dict(id='fixture-driver', parameters=dict(label='permission-child'))))
                else:
                    require(ordinal == 2 and results['permission-spawn']['outcome'] == 'completed', json.dumps(results))
                    self._send_text('tightening-complete')
            elif lane == 'PERMISSION_CONTINUE':
                if ordinal == 1:
                    call('continue-child', 'agent', dict(action='assign', agentId=child, task='PERMISSION_CHILD_RESUME'))
                elif ordinal == 2:
                    call('wait-child', 'agent', dict(action='wait', taskIds=[results['continue-child']['taskId']]))
                else:
                    require(ordinal == 3 and results['wait-child']['completedTaskIds'] == [results['continue-child']['taskId']], json.dumps(results))
                    self._send_text('tightening-restored')
            elif lane == 'PERMISSION_CHILD':
                if ordinal == 1:
                    require('plan.publish' not in names, 'Plan-off permission exposed a Plan approval tool')
                    call('before-tightening', 'fs.write', dict(path='before-tightening.txt', content='inherited write\n'))
                elif ordinal == 2:
                    require(results['before-tightening']['outcome'] == 'completed', json.dumps(results))
                    call('pause', 'interaction.request', dict(mode='wait', kind='question', prompt='Await parent permission change.', allowFreeform=True))
                elif ordinal == 3:
                    call('after-tightening', 'fs.write', dict(path='after-tightening.txt', content='must not exist'))
                elif ordinal == 4:
                    require('plan_scope_required' in json.dumps(results['after-tightening']), json.dumps(results))
                    call('new-plan', 'plan.publish', dict(title='Request a new write', summary='The parent withdrew automatic permission.',
                         steps=[dict(stepId='request', title='Write after confirmation', details='Await the user.')],
                         mutationManifest=[dict(workspace='primary', operation='fs.write', target='after-user-plan.txt')]))
                elif ordinal == 5:
                    call('user-authorized', 'fs.write', dict(path='after-user-plan.txt', content='explicit user permission\n'))
                else:
                    require(ordinal == 6 and results['user-authorized']['outcome'] == 'completed', json.dumps(results))
                    self._send_text('active-child-restricted')
            elif lane == 'PERMISSION_CHILD_RESUME':
                if ordinal == 1:
                    call('after-restart', 'fs.write', dict(path='after-restart.txt', content='must not exist'))
                elif ordinal == 2:
                    require('plan_scope_required' in json.dumps(results['after-restart']), json.dumps(results))
                    call('retained-read', 'fs.read', dict(path='before-tightening.txt'))
                else:
                    require(ordinal == 3 and 'inherited write' in json.dumps(results['retained-read']), json.dumps(results))
                    self._send_text('continued-child-restricted')
            elif ordinal == 1:
                call('restored-read', 'fs.read', dict(path='allowed.txt'))
            else:
                require(ordinal == 2 and 'parent-authorized report' in json.dumps(results['restored-read']), 'Restored session lost its file')
                self._send_text('restored-composition-complete')
        except BaseException as error:
            state.record_failure(error)
            self.close_connection = True


def run():
    with tempfile.TemporaryDirectory(prefix='achbit-agent-composition-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        state = fixture.ProviderState(workspace)
        state.ordinals = {}
        daemon = fixture.OwnedDaemon(root / 'config')
        state.daemon = daemon
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        marker = root / 'mcp-started'
        sentinel = root / 'sentinel.py'
        sentinel.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("started")\n', encoding='utf-8')
        fixture.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
            'agent.subagents.enabled': True, 'agent.subagents.maxConcurrent': 2,
            'mcp.servers': json.dumps([dict(id='sentinel', name='Sentinel', transport='stdio', command=sys.executable,
                                          args=str(sentinel), enabled=True)]),
        })
        profile_file = daemon.config_root / 'config/user/local/settings/llm-profiles.json'
        profiles = json.loads(profile_file.read_text())
        profiles['profiles'].append(dict(profiles['profiles'][0], id='e2e-child', name='Child model', model='mock-child'))
        profile_file.write_text(json.dumps(profiles), encoding='utf-8')
        trace = root / 'drivers.jsonl'
        module = root / 'session-extension.mjs'
        reads = root / 'journal-reads.jsonl'
        lost_ack = root / 'lose-journal-ack'
        module.write_text('import { appendFileSync, existsSync, unlinkSync } from "node:fs";\n'
            + 'import { createSessionService as create, AgentLoopRegistry, builtinAgentLoops, runAgentLoop } from '
            + json.dumps((fixture.ROOT / 'userspace/session-core/dist/index.js').as_uri()) + ';\n'
            + 'export const createSessionService = async input => {const read=input.journal.read.bind(input.journal);'
            + 'input.journal.read=async function*(id,after=0){appendFileSync(' + json.dumps(str(reads))
            + ',JSON.stringify({id,after})+"\\n");yield* read(id,after);};'
            + 'const fetch=input.journal.fetchImpl;input.journal.fetchImpl=async (...args)=>{const response=await fetch(...args);'
            + 'if(String(args[0]).endsWith("/journal/commands")&&existsSync(' + json.dumps(str(lost_ack)) + '))'
            + '{unlinkSync(' + json.dumps(str(lost_ack)) + ');await response.arrayBuffer();throw Error("fixture_journal_ack_lost");}return response;};'
            + 'const service=await create({ ...input, loops: new AgentLoopRegistry([...builtinAgentLoops(), {\n'
            + 'id:"fixture-driver",description:"CLI test driver",parametersSchema:{type:"object",properties:{label:{type:"string"}}},\n'
            + 'validate(p){if(typeof p.label!=="string")throw Error("label_required");},create({label}){return {\n'
            + 'async run(...args){appendFileSync(' + json.dumps(str(trace))
            + ',JSON.stringify({label,sessionId:args[0].state.sessionId})+"\\n");return runAgentLoop(...args);}};}\n}]) });'
            + 'service.replaceCapabilities=undefined;return service;};\n', encoding='utf-8')
        previous_module = os.environ.get('ACHBIT_SESSION_SERVICE_MODULE')
        os.environ['ACHBIT_SESSION_SERVICE_MODULE'] = str(module)
        recipe = dict(profileId='e2e-main', runner=dict(id='fixture-driver', parameters=dict(label='root')),
                      configuration=dict(context=dict(id='journal'), compaction=dict(id='summary'),
                                         controls=dict(id='standard', parameters=dict(optionalTools=[]))),
                      permissionPolicy=dict(id='workspace-only'), workspaceSandbox=dict(backendId='platform-default'),
                      permissions={'agent.permissions.workspaceMutation': 'plan', 'agent.permissions.shell': 'allow',
                                   'agent.permissions.shellAccess': 'full'})

        def create_with_recipe(value, task='MUST_NOT_REACH_PROVIDER', extra=(), background=False):
            recipe_file = root / 'recipe.json'
            recipe_file.write_text(json.dumps(value), encoding='utf-8')
            command = [str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                       '-C', str(workspace), '--recipe', str(recipe_file), *extra, 'ask', task]
            if background:
                return subprocess.Popen(command, cwd=fixture.ROOT, env=fixture.shell_environment(daemon),
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            return subprocess.run(command, cwd=fixture.ROOT, env=fixture.shell_environment(daemon),
                                  capture_output=True, text=True, timeout=45)

        def settings(enabled):
            response = fixture.api_envelope(daemon.base_url, '/api/user-settings', token=daemon.token,
                                           method='PATCH', body={'patches': {'agent.subagents.enabled': enabled}})
            require(response['ok'] is True, json.dumps(response))

        def session_settings(sid, enabled, label):
            current = fixture.projection(daemon, sid)['subagentSettings']
            changed = dict(current, enabled=enabled)
            response = fixture.api_json(daemon.base_url, f'/api/conversation/sessions/{sid}/commands',
                token=daemon.token, method='POST', body={
                    'schemaVersion': fixture.COMMAND_VERSION, 'type': 'session.subagent-settings.set',
                    'sessionId': sid, 'commandId': f'subagent-settings:{label}', 'settings': changed})
            require(response['status'] == 'accepted', json.dumps(response))
            require(fixture.projection(daemon, sid)['subagentSettings'] == changed,
                    'Session did not persist its complete subagent configuration')
            defaults = fixture.api_json(daemon.base_url, '/api/user-settings', token=daemon.token)['settings']
            require(all(defaults[f'agent.subagents.{key}'] == value for key, value in changed.items()),
                    'Session configuration did not become the complete new-session defaults')

        try:
            daemon.start()
            initial = create_with_recipe(recipe, 'COMPOSE_ROOT')
            state.assert_healthy()
            require(initial.returncode == 5, f'Expected parent Plan confirmation: {initial.stdout}\n{initial.stderr}')
            session = next(event['sessionId'] for event in events(daemon) if event['type'] == 'session.created')
            require(not (workspace / 'allowed.txt').exists(), 'A file changed before parent confirmation')
            result = fixture.cli(daemon, session, '/reply 1')
            state.assert_healthy()
            require('composition-complete' in result.stdout, result.stdout)
            require((workspace / 'allowed.txt').read_text() == 'parent-authorized report\n', 'Authorized file write missing')
            require(not (workspace / 'outside.txt').exists(), 'Child expanded parent mutation scope')
            journal = events(daemon)
            task = next(event for event in journal if event['type'] == 'agent.task.created' and event['payload']['text'] == 'COMPOSE_CHILD')
            child = fixture.projection(daemon, task['payload']['agentSessionId'])
            require(child['recipe']['runner']['parameters']['label'] == 'child', 'Child driver not persisted')
            require(child['recipe']['configuration']['compaction']['parameters']['pressureRatio'] == 0.8, 'Child composition lost')
            with closing(fixture.sqlite_read_only(daemon.config_root / 'data/agent-runtime/tool-record.sqlite3')) as db:
                records = [json.loads(row[0]) for row in db.execute('SELECT record_json FROM tool_records')]
            write = next(record for record in records if record['toolName'] == 'fs.write' and record['outcome'] == 'completed')
            parent_plan = next(event['payload'] for event in journal if event['sessionId'] == session and event['type'] == 'plan.confirmed')
            require(write['authority']['authorityId'] == parent_plan['authorities'][0]['authorityId'], 'Write lost its original parent grant')
            require(not any(event['type'] == 'plan.confirmed' and event['sessionId'] == child['sessionId'] for event in journal), 'Child manufactured a Plan grant')
            daemon.shutdown()
            daemon.start()
            restored = fixture.cli(daemon, session, 'COMPOSE_RESUME')
            state.assert_healthy()
            require('restored-composition-complete' in restored.stdout, restored.stdout)
            require(fixture.projection(daemon, session)['recipe']['runner'] == recipe['runner'], 'Root recipe lost on restart')
            drivers = [json.loads(line) for line in trace.read_text().splitlines()]
            require(any(item['label'] == 'child' for item in drivers) and sum(item['label'] == 'root' for item in drivers) >= 3, 'Selected drivers did not run')
            broad = dict(recipe, runner=dict(id='fixture-driver', parameters=dict(label='permission-root')),
                         permissions={'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.shell': 'allow',
                                      'agent.permissions.shellAccess': 'full'})
            running = create_with_recipe(broad, 'PERMISSION_ROOT', background=True)
            try:
                def waiting_child():
                    state.assert_healthy()
                    journal = events(daemon)
                    parent = next((event['sessionId'] for event in journal if event['type'] == 'session.created'
                                   and event['payload'].get('recipe', {}).get('runner', {}).get('parameters', {}).get('label') == 'permission-root'), None)
                    task = next((event for event in journal if event['sessionId'] == parent and event['type'] == 'agent.task.created'), None)
                    if task:
                        child = fixture.projection(daemon, task['payload']['agentSessionId'])
                        if child.get('run', {}).get('status') == 'waiting':
                            return parent, child['sessionId']
                    return None
                parent, child = fixture.wait_until(waiting_child, 20, 'Child did not reach its permission-change pause')
                settings_path = daemon.config_root / 'config/user/local/settings/user-settings.json'
                saved_bytes = settings_path.read_bytes()
                previous_settings = fixture.api_json(daemon.base_url, '/api/user-settings', token=daemon.token)
                settings_path.unlink()
                settings_path.mkdir()
                try:
                    failed_save = fixture.api_envelope(daemon.base_url, '/api/user-settings', token=daemon.token,
                        method='PATCH', body={'patches': {'agent.subagents.enabled': False}})
                    require(failed_save.get('error') == 'write_settings_failed', json.dumps(failed_save))
                    unchanged = fixture.api_json(daemon.base_url, '/api/user-settings', token=daemon.token)
                    require(unchanged['settings'] == previous_settings['settings']
                            and unchanged['runtimeSettings'] == previous_settings['runtimeSettings'],
                            'Failed persistence published partial runtime settings')
                finally:
                    settings_path.rmdir()
                    settings_path.write_bytes(saved_bytes)
                settings(False)
                for sid in (parent, child):
                    require(fixture.projection(daemon, sid)['subagentSettings']['enabled'] is True,
                            'Changing new-session defaults altered an existing Session')
                future = fixture.api_json(daemon.base_url, '/api/conversation/sessions', token=daemon.token,
                    method='POST', body={'workspacePaths': [str(workspace)]})
                require(fixture.projection(daemon, future['sessionId'])['subagentSettings']['enabled'] is False,
                        'New Session did not copy current defaults')
                session_settings(parent, False, 'disable-parent')
                require(fixture.projection(daemon, child)['subagentSettings']['enabled'] is True
                        and fixture.projection(daemon, child)['run']['status'] == 'waiting',
                        'Disabling the parent changed or cancelled its waiting child')
                session_settings(parent, True, 'enable-parent')
                require((workspace / 'before-tightening.txt').read_text() == 'inherited write\n', 'Initial parent permission was not inherited')
                lost_ack.write_text('drop response after the parent permission commit')
                update = subprocess.run([str(fixture.CLI_BINARY), '--api', daemon.base_url, '--no-auto-start-kernel',
                    '--session', parent, '--plain', 'ask', '/permissions ' + json.dumps({'agent.permissions.workspaceMutation': 'plan',
                        'agent.permissions.shell': 'ask', 'agent.permissions.shellAccess': 'workspace'})],
                    cwd=fixture.ROOT, env=fixture.shell_environment(daemon), capture_output=True, text=True, timeout=25)
                require(update.returncode != 0 and 'fixture_journal_ack_lost' in update.stdout + update.stderr,
                        'Fixture did not lose the committed permission acknowledgement: ' + update.stdout + update.stderr)
                require(not lost_ack.exists(), 'Permission commit fault was not exercised')
                current = fixture.projection(daemon, child)
                require(current['effectivePermissions']['agent.permissions.workspaceMutation'] == 'plan'
                        and current['effectivePermissions']['agent.permissions.shellAccess'] == 'workspace',
                        'Projection producer published stale inherited permissions')
                require(not any(event['sessionId'] == child and event['type'] == 'session.permissions.updated'
                                for event in events(daemon)), 'Agent maintained a duplicate permission state')
                fixture.cli(daemon, child, '/reply Continue after tightening.', expected=5)
                current = fixture.projection(daemon, child)
                require(current['pendingPlan'] and current['run']['waitingReason'] == 'plan', 'Old runtime settings auto-confirmed a new Plan')
                require(not (workspace / 'after-user-plan.txt').exists(), 'New Plan ran without a user decision')
                fixture.cli(daemon, child, '/reply 1')
                fixture.wait_completed(daemon, state, parent, 'parent permission tightening')
                stdout, stderr = running.communicate(timeout=20)
                require(running.returncode in (0, 5), stdout + stderr)
                require(not (workspace / 'after-tightening.txt').exists(), 'Active child retained stale mutation permission')
            finally:
                if running.poll() is None:
                    running.kill()
                    running.communicate(timeout=10)
            session_settings(parent, False, 'disable-before-restart')
            daemon.shutdown()
            daemon.start()
            for sid in (parent, child):
                fixture.cli(daemon, sid, '/permissions ' + json.dumps({'agent.permissions.engineeringDecisions': 'ask'}))
                require(fixture.projection(daemon, sid)['subagentSettings']['enabled'] is (sid == child),
                        'Restart overwrote Session-specific subagent settings')
            session_settings(parent, True, 'enable-after-restart')
            resumed = fixture.cli(daemon, parent, 'PERMISSION_CONTINUE')
            state.assert_healthy()
            require('tightening-restored' in resumed.stdout, resumed.stdout)
            require(all(json.loads(line)['after'] == 0 for line in reads.read_text().splitlines()),
                    'Active Actor polled journal revisions instead of publishing its writes')
            require(not (workspace / 'after-restart.txt').exists(), 'Continuation restored the old permission ceiling')
            count = len(state.requests)
            for value, expected in [
                (dict(runner=dict(id='missing')), 'agent_loop_unavailable'),
                (dict(workspaceSandbox=dict(backendId='missing')), 'sandbox_backend_unknown'),
                (dict(workspaceSandbox=dict(backendId='windows-lpac' if os.name != 'nt' else 'bubblewrap')), 'sandbox_backend_unavailable'),
            ]:
                denied = create_with_recipe(value)
                require(denied.returncode != 0 and expected in denied.stdout + denied.stderr, denied.stdout + denied.stderr)
            denied = create_with_recipe(recipe, extra=('--plugin', 'plugin://sentinel@mcp'))
            require(denied.returncode != 0 and 'agent_plugin_isolation_required' in denied.stdout + denied.stderr, denied.stdout + denied.stderr)
            host_restricted = dict(recipe, permissionPolicy=dict(id='local-standard', parameters=dict(allowHostExecution=False)))
            denied = create_with_recipe(host_restricted, extra=('--plugin', 'plugin://sentinel@mcp'))
            require(denied.returncode != 0 and 'agent_plugin_isolation_required' in denied.stdout + denied.stderr, denied.stdout + denied.stderr)
            require(not marker.exists(), 'MCP process started before policy admission')
            require(len(state.requests) == count, 'Invalid composition reached Provider')
            print('[agent-composition-cli] PASS: root/child drivers, model choices, restart, parent Plan scope, active/continued child tightening and prompts, Session settings/default isolation and restart, lost parent commit acknowledgement, write publications, Host denial, MCP pre-start denial')
        except BaseException:
            print(daemon.log_tail())
            if state.failure:
                print('Provider assertion:', state.failure)
            raise
        finally:
            daemon.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
            if previous_module is None:
                os.environ.pop('ACHBIT_SESSION_SERVICE_MODULE', None)
            else:
                os.environ['ACHBIT_SESSION_SERVICE_MODULE'] = previous_module


if __name__ == '__main__':
    run()
