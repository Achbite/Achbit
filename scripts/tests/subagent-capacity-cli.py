#!/usr/bin/env python3
"""Exercise one-dispatch subagent capacity through the real CLI, Host, Session and journal."""
from contextlib import closing
import http.server
import importlib.util
import json
from pathlib import Path
import tempfile
import threading

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
require = h.require
TASK = 'Independently check the north and south stations.'
REASON = 'The second checker must be independent of the first.'


class Provider(h.MockProviderHandler):
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
            model = body['model']
            if model == 'capacity-reviewer':
                state.reviews += 1
                packet = json.loads(body['messages'][-1]['content'])
                require(not body.get('tools') and body['response_format']['json_schema']['name'] == 'subagent_capacity_decision', 'review can only decide')
                require(state.mode in ('allow', 'deny', 'ask') and len(state.checked) == 1, 'unsolicited review or early child startup')
                require(packet['grant'] == 'thisDispatchOnly' and packet['operation']['requestCapacity'] == REASON, packet)
                require(any(m['content'] == TASK for m in packet['userMessages']), 'original human task missing')
                require(sorted((n['resource'], n['used'], n['limit'], n['requested']) for n in packet['capacity']['needs']) ==
                        [('callsThisRun', 1, 1, 2), ('openMembers', 1, 1, 2)], packet['capacity'])
                self._send_text(json.dumps({'decision': state.mode, 'reason': 'These checks require different reviewers.'})); return
            if model == 'capacity-worker':
                text = next(h.message_text(m['content']) for m in reversed(body['messages']) if m['role'] == 'user')
                require(text.endswith(('Verify north.', 'Verify south.')), text)
                state.checked.append(text.splitlines()[-1])
                self._send_text('Checked the station.'); return
            require(model == 'mock-main', model)
            state.turn += 1
            replies = {m['tool_call_id']: h.tool_content(m['content']) for m in body['messages'] if m['role'] == 'tool'}
            if state.turn == 1:
                self._send_tool_calls([('north', 'agent', {'action': 'spawn', 'name': 'North', 'task': 'Verify north.', 'delivery': 'wait'})]); return
            if state.turn == 2:
                require(replies['north']['outcome'] == 'completed', replies)
                self._send_tool_calls([('south', 'agent', {'action': 'spawn', 'name': 'South', 'task': 'Verify south.',
                                                          'delivery': 'wait', 'requestCapacity': REASON})]); return
            require(state.turn == 3 and 'capacityRequested' not in json.dumps(replies), 'internal ticket or duplicate turn')
            if state.mode == 'deny':
                require(replies['south']['executed'] is False and replies['south']['status'] == 'denied', replies)
            else:
                require(replies['south']['outcome'] == 'completed' and replies['south']['content'] == 'Checked the station.', replies)
            self._send_text('capacity-check-complete')
        except Exception as error:
            state.record_failure(error)
            self.close_connection = True


def restart_fixture(root, real_bridge):
    # Only the child Node Session process is replaced, immediately before forwarding the user's exact approval.
    # SQLite and the owning Kernel stay live; the proxy neither creates replies nor changes protocol frames.
    proxy = root / 'restart-session.cjs'
    preamble = f'const bridge = {json.dumps(str(real_bridge))}, receipt = {json.dumps(str(root / "restart.json"))};\n'
    proxy.write_text(preamble + r'''
const {spawn} = require('node:child_process'), {once} = require('node:events');
const {writeFileSync} = require('node:fs'), {createInterface} = require('node:readline');
const start = () => { const child = spawn(process.execPath, [bridge], {stdio:['pipe','inherit','inherit']}); return {child, exit:once(child,'exit')}; };
(async () => {
  let active = start(), restarted = false;
  try {
    for await (const line of createInterface({input:process.stdin})) {
      const req = JSON.parse(line);
      if (!restarted && req.operation === 'submit' && req.data.command.type === 'approval.respond') {
        const old = active.child.pid;
        active.child.kill('SIGKILL'); const [, signal] = await active.exit;
        if (signal !== 'SIGKILL') throw Error('owned Session did not exit as expected');
        active = start(); restarted = true;
        writeFileSync(receipt, JSON.stringify({old, replacement:active.child.pid, approvalId:req.data.command.approvalId}));
      }
      if (!active.child.stdin.write(line+'\n')) await once(active.child.stdin, 'drain');
      if (req.operation === 'shutdown') break;
    }
    active.child.stdin.end(); const [code] = await active.exit; process.exitCode = code ?? 1;
  } finally { if (active.child.exitCode === null && active.child.signalCode === null) { active.child.kill('SIGKILL'); await active.exit; } }
})().catch(error => { console.error(error); process.exitCode=1; });
''', encoding='utf-8')
    return proxy


def run(mode):
    with tempfile.TemporaryDirectory(prefix='achbit-capacity-') as temp, http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider) as server:
        root = Path(temp); project = root / 'project'; project.mkdir()
        daemon = h.OwnedDaemon(root / 'host')
        state = h.ProviderState(project); state.mode = mode; state.turn = state.reviews = 0; state.checked = []
        server.provider_state = state
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            h.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                'agent.subagents.enabled': True, 'agent.subagents.profileId': 'worker', 'agent.subagents.maxCallsPerRun': 1,
                'agent.subagents.maxMembersPerSession': 1, 'agent.subagents.maxConcurrent': 1,
                'agent.approvalReview.profileId': 'unavailable' if mode == 'unavailable' else 'reviewer',
                'agent.permissions.shell': 'ask' if mode == 'manual' else 'review', 'agent.permissions.shellAccess': 'workspace',
                'agent.permissions.networkRead': 'allow', 'agent.permissions.external': 'review',
            })
            path = daemon.config_root / 'config/user/local/settings/llm-profiles.json'
            profiles = json.loads(path.read_text()); main = profiles['profiles'][0]
            profiles['profiles'] += [dict(main, id=key, name=key, model='capacity-' + suffix) for key, suffix in [('reviewer', 'reviewer'), ('worker', 'worker')]]
            path.write_text(json.dumps(profiles), encoding='utf-8')
            real_bridge = h.SESSION_BRIDGE
            try:
                if mode == 'ask': h.SESSION_BRIDGE = restart_fixture(root, real_bridge)
                daemon.start()
            finally: h.SESSION_BRIDGE = real_bridge
            sid = h.create_session(daemon, project)['sessionId']
            human = mode in ('ask', 'manual', 'unavailable')
            reply = h.cli(daemon, sid, TASK, expected=5 if human else 0, run_timeout_seconds=25)
            state.assert_healthy()
            if human:
                pending = h.projection(daemon, sid)['pendingApproval']
                require(pending['preview']['reviewPolicy']['subject'] == 'subagentCapacity' and len(state.checked) == 1, pending)
                if mode != 'manual':
                    require(pending['preview']['review']['decision'] == 'ask', pending)
                require(not pending['preview'].get('authorizationScopes'), 'Not a Shell approval')
                reply = h.cli(daemon, sid, '/reply --approval ' + pending['approvalId'] + ' 1', run_timeout_seconds=25)
                if mode == 'ask':
                    observed = json.loads((root / 'restart.json').read_text())
                    require(observed['old'] != observed['replacement'] and observed['approvalId'] == pending['approvalId'], observed)
                    print(f'[subagent-capacity-cli] Session process {observed["old"]} -> {observed["replacement"]}; original human gate resumed')
            state.assert_healthy(); require('capacity-check-complete' in reply.stdout, reply.stdout)
            view = h.projection(daemon, sid)
            require(view['run']['status'] == 'completed' and not view.get('shellAuthorizations') and view['subagentSettings']['maxCallsPerRun'] == 1, 'configuration/authority changed')
            with closing(h.sqlite_read_only(daemon.config_root/'data/agent-runtime/session.sqlite3')) as db:
                rows = [(seq, kind, call, json.loads(data)) for seq, kind, call, data in db.execute(
                    'SELECT sequence,event_type,call_id,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (sid,))]
            [(gate_seq, _, call_id, gate)] = [r for r in rows if r[1] == 'approval.requested']
            [(decision_seq, _, decided, decision)] = [r for r in rows if r[1] == 'approval.resolved']
            [(settled_seq, _, settled, end)] = [r for r in rows if r[1] == 'agent.capacity.settled']
            require(call_id == decided == settled and gate['approvalId'] == decision['approvalId'] == end['approvalId'], 'mismatched dispatch identity')
            require(gate_seq < decision_seq < settled_seq and decision['source'] == ('user' if human else 'agent'), decision)
            require('authorizationScope' not in decision and state.reviews == (0 if mode in ('manual', 'unavailable') else 1), 'wrong decision scope or reviewer count')
            starts = [seq for seq, kind, call, _ in rows if kind == 'agent.task.created' and call == call_id]
            require(len(starts) == (0 if mode == 'deny' else 1) and all(decision_seq < seq < settled_seq for seq in starts), starts)
            expected = ['Verify north.'] + ([] if mode == 'deny' else ['Verify south.'])
            require(state.checked == expected and len(view['agentTasks']) == len(expected), state.checked)
            require(sum(r[1] == 'run.runtime.released' for r in rows) == 1, 'missing release')
            daemon.shutdown()
            if mode == 'allow':
                old_pid = daemon.process.pid; daemon.start()
                restored = h.projection(daemon, sid)
                require(daemon.process.pid != old_pid and restored['run']['status'] == 'completed' and restored['agentTasks'] == view['agentTasks'],
                        'completed work did not survive the owned Host restart')
                require(len(state.checked) == 2 and state.turn == 3 and state.reviews == 1, 'history lookup restarted work')
                daemon.shutdown()
                print('[subagent-capacity-cli] completed Host restarted; archived tasks and original limits retained, zero redispatch')
            print(f'[subagent-capacity-cli] PASS: {mode}; reviews={state.reviews}, original={len(starts)} extra dispatch, decision={decision["source"]}, unchanged limits')
        except BaseException:
            print(daemon.log_tail()); state.assert_healthy(); raise
        finally:
            try: daemon.close()
            finally: server.shutdown(); worker.join(timeout=5)


if __name__ == '__main__':
    for scenario in ('allow', 'deny', 'ask', 'manual', 'unavailable'):
        run(scenario)
