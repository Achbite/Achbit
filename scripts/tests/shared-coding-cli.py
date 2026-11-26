#!/usr/bin/env python3
"""Actual Linux Host/Session/Kernel, synthetic documents and a loopback Provider only."""
import argparse
from contextlib import closing
import hashlib
import http.server
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading
from urllib.parse import quote

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
require = h.require
CORE = ['read', 'bash', 'edit', 'write']
KERNEL = ['fs.read', 'bash', 'fs.edit', 'fs.write']
LONG = 'a' * 4095 + '中' + 'b' * 61500 + '🙂\n'
RULE_HASH = 'a76fd1919fac7e0043d44a316be682b881bd74676f99a6bc59aed339918a89ce'
INTRO_HASH = 'd2a7862631cc65f606a2cb669722c8fb9eceaa31ce7cd2c585e0726445752caa'


class Provider(h.MockProviderHandler):
    def do_POST(self):
        state = self.provider_state
        headers_sent = False
        try:
            require(self.path.endswith('/chat/completions'), self.path)
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            state.turn += 1
            defs = [tool['function'] for tool in body['tools']]
            names = [tool['name'] for tool in defs]
            text = '\n'.join(m['content'] for m in body['messages'] if m['role'] in ('system', 'developer'))
            intro = text.splitlines()[0]
            rules = re.search(r'<tools>\n.*?</rules>', text, re.S)
            require(rules is not None and text.count('<tools>') == 1, 'missing/duplicate core rules')
            require(hashlib.sha256(intro.encode()).hexdigest() == INTRO_HASH and
                    hashlib.sha256(rules.group().encode()).hexdigest() == RULE_HASH, 'core source changed')
            require(names[:4] == CORE and not set(names) & {'fs_read', 'fs_edit', 'fs_write', 'powershell'}, names)
            require(text.count('Prefer a fenced Mermaid diagram') == (state.lane == 'selected'), 'product slice selection')
            require('Match your approach to the requested task and stage' not in text and '<response>' not in text,
                    'a default Full prose component leaked into the shared prefix')
            if state.baseline is None:
                state.baseline = defs[:4]
            require(defs[:4] == state.baseline, 'the same bindings must not change definitions after mode/activation')
            if state.turn == 1 and state.capture:
                (state.capture / (state.lane + '-first.json')).write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n')
            results = {m['tool_call_id']: h.tool_content(m['content']) for m in body['messages'] if m['role'] == 'tool'}
            self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.send_header('connection', 'close'); self.end_headers()
            headers_sent = True
            if state.turn == 1:
                if state.lane == 'default':
                    require('process' in names and 'plugin_search' in names and 'document_render' not in names, names)
                    self._send_text('shared-default-ok'); return
                require(('plugin_activate' in names) == (state.lane == 'selected'), names)
                require('document_render' not in names, 'undiscovered extension was declared')
                calls = [('long', 'read', {'path': 'long.txt'}), ('page', 'read', {'path': 'long.txt', 'maxBytes': 4096}),
                         ('directory', 'read', {'path': 'items', 'offset': 1, 'limit': 1}),
                         ('line', 'read', {'path': 'lines', 'offset': 2, 'limit': 1}), ('fifth', 'read', {'path': 'fifth'}),
                         ('shell-only', 'bash', {'command': 'cat shell-a shell-b'}),
                         ('bad-field', 'read', {'path': 'does-not-exist', 'endLine': 2})]
                if state.lane == 'selected':
                    calls.append(('search', 'plugin_search', {'query': 'documents'}))
                self._send_tool_calls(calls); return
            page, directory = results['page'], results['directory']
            require(results['long'] == LONG and results['fifth'] == 'fifth\n', 'default byte window or fifth read lost')
            require(results['line']['content'] == 'second\n' and results['line']['nextStartLine'] == 3, 'line window')
            require(page['content'] == 'a' * 4095 and page['nextByte'] == 4095, 'UTF-8 cursor split or wrong window')
            require(directory['entries'] == [{'name':'one','kind':'file'}] and directory['nextStartLine'] == 2, directory)
            require(results['shell-only']['stdout'] == 'A\nB\n' and results['shell-only']['exitCode'] == 0, 'Shell is an independent reader')
            bad = results['bad-field']
            require(bad['executed'] is False and bad['error']['code'] == 'tool_input_invalid' and
                    bad['error']['issues'][0]['path'] == '$.endLine', bad)
            if state.turn == 2 and state.lane == 'selected':
                found = [row['uri'] for row in results['search']['plugins'] if row['uri'] == 'plugin://documents@builtin']
                require(len(found) == 1, results['search'])
                uri = found[0]
                self._send_tool_calls([('activate', 'plugin_activate', {'pluginUris':[uri]})]); return
            if state.turn == (3 if state.lane == 'selected' else 2):
                calls = [('rest', 'read', {'path':'long.txt','startByte':page['nextByte'],'maxBytes':1048576}),
                         ('entries', 'read', {'path':'items','offset':directory['nextStartLine']})]
                if state.lane == 'selected':
                    require('document_render' in names and 'activate' in results, names)
                    calls.append(('render', 'document_render', {'format':'markdown','path':'result.md','content':'# Verified\n'}))
                self._send_tool_calls(calls); return
            require(state.turn == (4 if state.lane == 'selected' else 3), 'extra Provider turn')
            require(page['content'] + results['rest'] == LONG, 'two pages must recover the original bytes')
            require(results['entries']['entries'] == [{'name':'two','kind':'file'}], 'directory cursor')
            if state.lane == 'selected':
                require((state.workspace / 'result.md').read_text() == '# Verified\n', 'extension was not executed')
            self._send_text('shared-core-ok')
        except Exception as exc:
            state.record_failure(exc)
            if headers_sent:
                self._send_text('fixture-failed')
            else:
                self.send_error(400, 'fixture assertion')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--capture', type=Path, help='new directory for synthetic first requests')
    args = parser.parse_args()
    if args.capture:
        args.capture.mkdir()
    with tempfile.TemporaryDirectory(prefix='shared-coding-') as tmp:
        root = Path(tmp); project = root / 'project'; project.mkdir(); (project/'items').mkdir()
        for path, text in {'long.txt':LONG, 'lines':'first\nsecond\nthird\n', 'fifth':'fifth\n',
                           'shell-a':'A\n','shell-b':'B\n','items/one':'1','items/two':'2'}.items():
            (project/path).write_text(text, encoding='utf-8')
        state = h.ProviderState(project); state.capture = args.capture; state.baseline = None
        daemon = h.OwnedDaemon(root/'host')
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider) as server:
            server.provider_state = state
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                h.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {
                    'agent.permissions.workspaceMutation':'allow', 'agent.permissions.shell':'allow',
                    'agent.permissions.shellAccess':'workspace', 'agent.permissions.networkRead':'deny',
                    'agent.permissions.external':'deny','agent.subagents.enabled':False})
                daemon.start()
                for lane in ('minimal', 'bare', 'default', 'selected'):
                    state.lane, state.turn = lane, 0
                    recipe = {'permissionPolicy':{'id':'workspace-only'}}
                    if lane != 'default':
                        recipe['tools'] = {'kernel':KERNEL + (['plugin.search'] if lane == 'selected' else []),
                                           'controls':['plugin.activate'] if lane == 'selected' else [], 'plugins':lane == 'selected'}
                    if lane == 'selected':
                        recipe['productComponents'] = ['achbit.rich-replies']
                    session = h.api_json(daemon.base_url, '/api/conversation/sessions', method='POST', token=daemon.token,
                                         body={'workspacePaths':[str(project)], 'recipe':recipe})
                    sid = session['sessionId']
                    if lane == 'minimal':
                        command = {'schemaVersion':h.COMMAND_VERSION, 'commandId':'mode:fixture', 'type':'session.mode.set','mode':'minimal','sessionId':sid}
                        ack = h.api_json(daemon.base_url, '/api/conversation/sessions/'+quote(sid,safe='')+'/commands', method='POST', token=daemon.token, body=command)
                        require(ack['status'] == 'accepted', ack)
                    try:
                        h.cli(daemon, sid, 'Check the synthetic fixtures.', run_timeout_seconds=25)
                    finally:
                        state.assert_healthy()
                    with closing(h.sqlite_read_only(daemon.config_root/'data/agent-runtime/session.sqlite3')) as db:
                        rows = [(kind,json.loads(data)) for kind,data in db.execute('SELECT event_type,payload_json FROM session_events WHERE session_id=? ORDER BY sequence',(sid,))]
                    rt = next(payload['runtimeSnapshot'] for kind,payload in rows if kind == 'run.started')
                    require(rt['mode'] == ('minimal' if lane == 'minimal' else 'full') and rt['coreToolInterface'] == 'shared', 'recorded interface/mode')
                    require(any(kind == 'run.runtime.released' for kind,_ in rows), 'runtime not released')
                    if lane != 'default':
                        calls = {p['providerCallId']:p for k,p in rows if k == 'tool.requested'}
                        require('bad-field' not in calls and 'maxBytes' not in calls['long']['input'] and calls['rest']['input']['maxBytes'] == 1048576, 'dispatch or byte budget mismatch')
                    print(f'[shared-coding-cli] PASS {lane}: {state.turn} real Provider requests, actual Kernel binding and release', flush=True)
            finally:
                try:
                    daemon.close()
                finally:
                    server.shutdown(); thread.join()


if __name__ == '__main__':
    main()
