#!/usr/bin/env python3
"""Request-scoped project Skill discovery through an isolated Host, Session and Kernel."""
from contextlib import closing
import http.server
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from urllib.parse import quote

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
require = h.require
URI = 'plugin://saffron-added@project'
ORIGINAL = 'Original instruction snapshot.'
CHANGED = 'Changed during the first run.'
ENTRY = '---\nname: saffron-added\ndescription: |\n  Read the saffron\n  fixture guide.\n---\n\nRead reference.txt.\n'


class Provider(h.MockProviderHandler):
    def do_POST(self):
        s = self.provider_state
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            s.turn += 1
            messages = body['messages']
            instructions = '\n'.join(m['content'] for m in messages if m['role'] in ('system', 'developer'))
            results = {m['tool_call_id']: h.tool_content(m['content']) for m in messages if m['role'] == 'tool'}
            require((ORIGINAL if s.turn <= 8 else CHANGED) in instructions, 'wrong run instruction snapshot')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()

            def search(call):
                self._send_tool_calls([(call, 'plugin_search', {'query': 'saffron-added'})])

            if s.turn == 1:
                search('initial')
            elif s.turn == 2:
                require(results['initial']['plugins'] == [], results['initial'])
                before = h.projection(s.daemon, s.sid)['run']
                attached = h.api_json(s.daemon.base_url, s.indexes, method='POST', token=s.daemon.token, body={'path': str(s.added)})
                run = attached['run']
                added = {b['workspaceId'] for b in run['workspaceBindings']} - {b['workspaceId'] for b in before['workspaceBindings']}
                require(len(added) == 1 and before['runId'] == run['runId'], 'binding did not attach to this run')
                s.added_id = added.pop()
                (s.workspace / 'AGENTS.md').write_text(CHANGED)
                search('in-flight-before-attach')
            elif s.turn == 3:
                require(results['in-flight-before-attach']['plugins'] == [], 'changed an already-issued search binding')
                search('attached')
            elif s.turn == 4:
                require(results['attached']['plugins'] == [{'uri': URI, 'displayName': 'saffron-added',
                    'shortDescription': 'Read the saffron fixture guide.'}], results['attached'])
                self._send_tool_calls([('activate', 'plugin_activate', {'pluginUris': [URI]}),
                                       ('old-read', 'read', {'path': 'AGENTS.md'})])
            elif s.turn == 5:
                require(results['activate'].get('skillEntries') == [{'uri': URI, 'path': str(s.entry)}], results['activate'])
                require(results['old-read'] == CHANGED, results['old-read'])
                require(list(results)[-2:] == ['activate', 'old-read'], 'mixed results did not retain native call order')
                self._send_tool_calls([('entry', 'read', {'path': str(s.entry)}),
                                       ('reference', 'read', {'path': str(s.entry.parent / 'reference.txt')})])
            elif s.turn == 6:
                require(results['entry'] == ENTRY and results['reference'] == 'saffron reference', 'entry/reference read failed')
                h.api_json(s.daemon.base_url, s.indexes + '/' + quote(s.added_id, safe=''), method='DELETE', token=s.daemon.token)
                search('in-flight-before-detach')
            elif s.turn == 7:
                require([p['uri'] for p in results['in-flight-before-detach']['plugins']] == [URI], 'old search lost its root')
                search('detached')
            elif s.turn == 8 and 'detached' in results:
                require(results['detached']['plugins'] == [], 'detached project still discoverable')
                self._send_text('first run complete')
            elif s.turn == 9:
                self._send_text('next run complete')
            elif 10 <= s.turn <= 15:
                self.localized_activation(s, results)
            else:
                raise AssertionError(f'unexpected provider turn {s.turn}')
        except Exception as error:
            s.record_failure(error)
            self.close_connection = True

    def localized_activation(self, s, results):
        def activate(call, name):
            self._send_tool_calls([(call, 'plugin_activate', {'pluginUris': [s.uris[name]]})])

        def check_entry(call, name):
            require(results[call]['skillEntries'] == [{'uri': s.uris[name], 'path': str(s.entries[name])}], results[call])

        if s.turn == 10:
            self._send_tool_calls([('discover', 'plugin_search', {'query': 'orchid-localization-fixture'})])
        elif s.turn == 11:
            items = results['discover']['plugins']
            s.uris = {p['displayName']: p['uri'] for p in items}
            require(len(items) == 3 and s.uris.keys() == s.entries.keys(), items)
            require(len(set(s.uris.values())) == 3 and all(uri.isascii() for uri in s.uris.values()), s.uris)
            require(s.uris['plugin'] == 'plugin://plugin@project', s.uris)
            h.api_json(s.daemon.base_url, s.indexes + '/' + quote(s.added_id, safe=''), method='DELETE', token=s.daemon.token)
            activate('during-detach', '构建')  # Request still owns [A,B].
        elif s.turn == 12:
            check_entry('during-detach', '构建')
            h.api_json(s.daemon.base_url, s.indexes, method='POST', token=s.daemon.token, body={'path': str(s.added)})
            activate('during-attach', '发布')  # Request still owns [A].
        elif s.turn == 13:
            rejected = json.dumps(results['during-attach'], ensure_ascii=False)
            require('plugin_selection_unavailable' in rejected and s.uris['发布'] in rejected, rejected)
            activate('after-attach', '发布')
        elif s.turn == 14:
            check_entry('after-attach', '发布')
            activate('ascii', 'plugin')
        else:
            check_entry('ascii', 'plugin')
            self._send_text('localized activations complete')


def main():
    with tempfile.TemporaryDirectory(prefix='project-skills-cli-') as tmp:
        root = Path(tmp)
        project = root / 'base'; project.mkdir()
        added = root / 'second' / 'project'; added.mkdir(parents=True)
        # The selected bundle is an ancestor resource, outside either bound workspace.
        entry = added.parent / '.agents/skills/saffron/SKILL.md'; entry.parent.mkdir(parents=True)
        entry.write_text(ENTRY); (entry.parent / 'reference.txt').write_text('saffron reference')
        (project / 'AGENTS.md').write_text(ORIGINAL)
        daemon = h.OwnedDaemon(root / 'host')
        state = h.ProviderState(project); state.daemon = daemon; state.turn = 0; state.added = added; state.entry = entry
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider) as server:
            server.provider_state = state
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                h.write_configuration(daemon.config_root, f'http://127.0.0.1:{server.server_port}/v1', {'agent.subagents.enabled': False})
                daemon.start()
                session = h.api_json(daemon.base_url, '/api/conversation/sessions', method='POST', token=daemon.token,
                    body={'workspacePaths': [str(project)], 'recipe': {'tools': {'kernel': ['fs.read', 'plugin.search'],
                          'controls': ['plugin.activate'], 'plugins': True}}})
                state.sid = session['sessionId']; state.indexes = '/api/conversation/sessions/' + quote(state.sid, safe='') + '/directory-indexes'
                for message in ['Check the project guidance.', 'Check the next instruction snapshot.']:
                    try:
                        h.cli(daemon, state.sid, message, run_timeout_seconds=25)
                    finally:
                        state.assert_healthy()
                with closing(h.sqlite_read_only(daemon.config_root/'data/agent-runtime/session.sqlite3')) as db:
                    rows = [(kind, rid, json.loads(raw)) for kind, rid, raw in db.execute(
                        'SELECT event_type,run_id,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (state.sid,))]
                runs = [(rid, p['runtimeSnapshot']) for kind,rid,p in rows if kind == 'run.started']
                require(len(runs) == 2 and all(not v['selectedPlugins']['plugins'] for _,v in runs), 'unexpected initial selection')
                views = [p['toolView'] for kind,rid,p in rows if kind == 'run.tools.prepared' and rid == runs[0][0]]
                require(any([p['uri'] for p in v['selectedPlugins']['plugins']] == [URI] and
                            v['kernelCatalogSnapshotRef'] != runs[0][1]['kernelCatalogSnapshotRef'] for v in views), 'activation reused initial identity')
                require(views and not views[-1]['selectedPlugins']['plugins'], 'selection was not withdrawn')
                for rid,_ in runs:
                    require([kind for kind,r,p in rows if r == rid and kind in ('run.runtime.released','run.settled')] ==
                            ['run.runtime.released','run.settled'], 'run did not release and settle once')
                activation = next(p for k, rid, p in rows if k == 'session.plugins.requested' and p['providerCallId'] == 'activate')
                steps = [(k, p) for k, rid, p in rows if rid == runs[0][0]]
                ordered = [next(i for i, (k, p) in enumerate(steps) if k == kind and match(p)) for kind, match in [
                    ('provider.turn.settled', lambda p: p['providerRequestId'] == activation['providerRequestId']),
                    ('tool.completed', lambda p: p['record']['toolName'] == 'fs.read' and p['record']['input'].get('path') == 'AGENTS.md'),
                    ('session.plugins.preparing', lambda p: True),
                    ('session.plugins.activated', lambda p: p['providerCallId'] == 'activate')]]
                require(ordered == sorted(ordered), 'published plugin view before independent read completed')
                require(state.turn == 9, 'missing fixture request')
                print('[project-skills-cli] PASS 2 runs, 9 provider requests: attach/detach, captured searches, activation, ancestor reads, frozen instructions, release')

                state.entries = {}
                for stem, name in [('build', '构建'), ('release', '发布'), ('ascii', 'plugin')]:
                    path = entry.parent.parent / (stem + '.md')
                    path.write_text(f'---\nname: {name}\ndescription: orchid-localization-fixture\n---\n{stem} body.\n', encoding='utf-8')
                    state.entries[name] = path
                before = {b['workspaceId'] for b in h.projection(daemon, state.sid)['sessionDirectoryIndexes']}
                attached = h.api_json(daemon.base_url, state.indexes, method='POST', token=daemon.token, body={'path': str(added)})
                new_indexes = {b['workspaceId'] for b in attached['sessionDirectoryIndexes']} - before
                require(len(new_indexes) == 1, new_indexes)
                state.added_id = new_indexes.pop()
                try:
                    h.cli(daemon, state.sid, 'Activate the three localized fixture skills.', run_timeout_seconds=25)
                finally:
                    state.assert_healthy()
                require(state.turn == 15, 'missing in-flight activation request')
                print('[project-skills-cli] PASS 1 additional run, 6 requests: localized discovery and per-entry activation across in-flight detach and attach')
            finally:
                try:
                    daemon.close()
                finally:
                    server.shutdown(); thread.join()


if __name__ == '__main__':
    main()
