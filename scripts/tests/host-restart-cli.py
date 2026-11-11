#!/usr/bin/env python3
"""Automatic Host shutdown and bare CLI startup serialize without losing conversation turns."""
from contextlib import closing
import fcntl
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location('support', Path(__file__).with_name('support.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
require = fixture.require


class Provider(fixture.MockProviderHandler):
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if self.respond_to_title(body):
                return
            state = self.provider_state
            state.requests.append(body)
            ordinal = len(state.requests)
            for previous in range(1, ordinal):
                require(any(message['role'] == 'assistant' and f'bare-cli-turn-{previous}' in fixture.message_text(message.get('content'))
                            for message in body['messages']), 'Prior completed answer was lost across Host restart')
            if ordinal == 1:
                self.server.first_request.set()
                require(self.server.finish_first.wait(20), 'First-turn barrier was not released')
            elif ordinal == 2:
                self.server.second_request.set()
                require(self.server.finish_second.wait(20), 'Second-turn barrier was not released')
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('connection', 'close')
            self.end_headers()
            self._send_text(f'bare-cli-turn-{ordinal}')
        except BaseException as error:
            self.provider_state.record_failure(error)
            self.close_connection = True


def run():
    with tempfile.TemporaryDirectory(prefix='achbit-host-restart-') as directory:
        root = Path(directory)
        workspace = root / 'workspace'
        workspace.mkdir()
        user = root / 'state'
        state = fixture.ProviderState(workspace)
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        server.provider_state = state
        server.first_request, server.finish_first = threading.Event(), threading.Event()
        server.second_request, server.finish_second = threading.Event(), threading.Event()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        fixture.write_configuration(user, f'http://127.0.0.1:{server.server_port}/v1', {})
        gate = root / 'finish-shutdown'
        marker = root / 'shutdown-started'
        bridge = root / 'delayed-shutdown.cjs'
        bridge.write_text("""const {spawn} = require('node:child_process');
const fs = require('node:fs');
const readline = require('node:readline');
const child = spawn(process.execPath, [process.env.ACHBIT_TEST_REAL_BRIDGE], {stdio:['pipe','inherit','inherit']});
child.on('exit', code => process.exit(code === null ? 1 : code));
(async () => {
  for await (const line of readline.createInterface({input:process.stdin})) {
    if (JSON.parse(line).operation === 'shutdown') {
      fs.writeFileSync(process.env.ACHBIT_TEST_SHUTDOWN_MARKER, String(process.ppid));
      while (!fs.existsSync(process.env.ACHBIT_TEST_SHUTDOWN_GATE)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.stdin.write(line + '\\n');
  }
  child.stdin.end();
})().catch(error => { console.error(error); process.exit(1); });
""")
        environment = os.environ.copy()
        for key in list(environment):
            if key in {'ACHBIT_API_URL', 'ACHBIT_PORT', 'ACHBIT_HOST_SHELL_TOKEN', 'ACHBIT_HOST_INSTANCE_ID',
                       'ACHBIT_KERNEL_AUTO_START', 'ACHBIT_HOST_LIFETIME'} or key.lower() in {'http_proxy', 'https_proxy', 'all_proxy'}:
                environment.pop(key, None)
        environment.update(ACHBIT_USER_ROOT=str(user), ACHBIT_KERNEL_BIN=str(fixture.DAEMON_BINARY),
                           ACHBIT_NODE=shutil.which('node'), ACHBIT_SESSION_BRIDGE=str(bridge),
                           ACHBIT_TEST_REAL_BRIDGE=str(fixture.SESSION_BRIDGE),
                           ACHBIT_TEST_SHUTDOWN_MARKER=str(marker), ACHBIT_TEST_SHUTDOWN_GATE=str(gate),
                           ACHBIT_LLM_API_KEY='e2e-key', ACHBIT_CLI_RUN_TIMEOUT_MS='20000',
                           NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
        clients = []
        connection_file = user / 'data/agent-runtime/host-connection.json'
        startup_lock = None

        def cli(*args):
            client = subprocess.Popen([str(fixture.CLI_BINARY), 'ask', *args], cwd=fixture.ROOT,
                                      env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            clients.append(client)
            return client

        def completed(client, ordinal):
            out, err = client.communicate(timeout=30)
            state.assert_healthy()
            require(client.returncode == 0, f'CLI {ordinal} exit={client.returncode}\n{out}\n{err}')
            require(f'bare-cli-turn-{ordinal}' in out and ': completed' in out, f'CLI {ordinal} lost completion: {out}')
            return out + err

        try:
            first = cli('-C', str(workspace), 'First bare CLI turn.')
            require(server.first_request.wait(15), 'First CLI did not reach the Provider')
            first_connection = json.loads(connection_file.read_text())
            startup_lock = (user / 'data/agent-runtime/host-start.lock').open('r+b')
            fcntl.flock(startup_lock, fcntl.LOCK_EX)
            server.finish_first.set()
            output = completed(first, 1)
            session = re.search(r'session: (session:[a-f0-9]+)', output)[1]
            # Allow two automatic lifetime observations while a connecting shell owns admission.
            time.sleep(.7)
            health = fixture.api_envelope(first_connection['identity']['address'], '/api/health',
                                          token=first_connection['shellToken'])
            require(health.get('ok') is True, f'Host tore down Session while startup was locked: {health}')
            require(not marker.exists(), 'Host entered shutdown while another shell owned startup')
            gate.touch()
            second = cli('--session', session, 'Second bare CLI turn.')
            fcntl.flock(startup_lock, fcntl.LOCK_UN)
            startup_lock.close()
            startup_lock = None
            require(server.second_request.wait(15), 'Second CLI did not reach the Provider')
            gate.unlink()
            marker.unlink(missing_ok=True)
            server.finish_second.set()
            completed(second, 2)
            # The next CLI starts inside a deterministic, real Session shutdown window.
            fixture.wait_until(marker.exists, 10, 'Automatic Host did not begin shutdown')
            third = cli('--session', session, 'Third bare CLI turn after closing Host.')
            time.sleep(.2)
            require(third.poll() is None, 'CLI failed instead of waiting for the closing Host')
            gate.touch()
            completed(third, 3)
            fourth = cli('--session', session, 'Fourth bare CLI turn immediately after exit.')
            completed(fourth, 4)
            fixture.wait_until(lambda: not connection_file.exists(), 15, 'Final automatic Host did not release its connection')
            with closing(fixture.sqlite_read_only(user / 'data/agent-runtime/session.sqlite3')) as db:
                events = [(kind, run, json.loads(payload)) for kind, run, payload in db.execute(
                    'SELECT event_type,run_id,payload_json FROM session_events WHERE session_id=? ORDER BY sequence', (session,))]
            settlements = [payload['outcome'] for kind, _, payload in events if kind == 'run.settled']
            require(settlements == ['completed'] * 4, f'Unexpected run settlements: {settlements}')
            releases = [run for kind, run, _ in events if kind == 'run.runtime.released']
            require(len(releases) == 4 and len(set(releases)) == 4, 'Runtime was not released exactly once per run')
            require(len(state.requests) == 4, 'Host handoff duplicated a model request')
            state.assert_healthy()
            print('[host-restart-cli] PASS: startup lock protects live Session, closing Host hands off, '
                  'four bare CLI turns preserve history, exactly four requests/releases, automatic cleanup')
        finally:
            server.finish_first.set()
            server.finish_second.set()
            gate.touch()
            if startup_lock is not None:
                startup_lock.close()
            for client in clients:
                if client.poll() is None:
                    client.terminate()
                    client.communicate(timeout=5)
            # Automatic Hosts own their shutdown; this fixture only releases its barriers.
            if connection_file.exists():
                fixture.wait_until(lambda: not connection_file.exists(), 15, 'Owned Host cleanup did not finish')
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    run()
