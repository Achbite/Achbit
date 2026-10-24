import test from 'node:test';
import assert from 'node:assert/strict';
import { shellCommandIntents } from '../dist/local-agent/shellIntent.js';
import { emptySessionState, reduceSession, projectSession } from '../dist/local-agent/reducer.js';

test('literal searches distinguish query from file, directory and pipeline targets', () => {
  assert.deepEqual(shellCommandIntents(`rg -n -g '*.ts' 'read file' src tests; grep -n -e TODO README.md`), [
    { kind: 'search', query: 'read file', targets: ['src', 'tests'] },
    { kind: 'search', query: 'TODO', targets: ['README.md'] },
  ]);
  assert.deepEqual(shellCommandIntents('rg TODO'), [{ kind: 'search', query: 'TODO', targets: ['.'] }]);
  assert.deepEqual(shellCommandIntents('cat log.txt | grep error'), [
    { kind: 'read', targets: ['log.txt'] }, { kind: 'search', query: 'error', targets: [] },
  ]);
});
test('bounded reads preserve literal targets and do not invent reads for scripts or dynamic syntax', () => {
  assert.deepEqual(shellCommandIntents(`sed -n '1,50p' 'hello world.md'; head -n 10 src/main.ts`), [
    { kind: 'read', targets: ['hello world.md'] }, { kind: 'read', targets: ['src/main.ts'] },
  ]);
  for (const command of ['python inspect.py', 'cat "$FILE"', 'cd src && cat main.ts', 'sed -i s/a/b/ file', 'rg --files src', 'cat < input.txt']) {
    assert.deepEqual(shellCommandIntents(command), [], command);
  }
  assert.deepEqual(shellCommandIntents("Get-Content -LiteralPath 'hello world.txt' -TotalCount 10", 'powershell'),
    [{ kind: 'read', targets: ['hello world.txt'] }]);
  assert.deepEqual(shellCommandIntents(String.raw`Get-Content C:\work\notes.txt`, 'powershell'),
    [{ kind: 'read', targets: [String.raw`C:\work\notes.txt`] }]);
  assert.deepEqual(shellCommandIntents("Select-String -Path 'src/*.ts' -Pattern TODO", 'powershell'),
    [{ kind: 'search', targets: ['src/*.ts'], query: 'TODO' }]);
});
test('requested command intent survives start without implying completed reads', () => {
  const sessionId = 'session:intents', runId = 'run:intents', callId = 'call:intents';
  let state = emptySessionState(sessionId);
  state = reduceSession(state, { type: 'tool.requested', sessionId, runId, callId, sequence: 1, occurredAt: '2026-10-24T00:00:00Z',
    payload: { providerCallId: 'provider:intents', toolName: 'bash', input: { command: 'rg -n TODO src' } } });
  state = reduceSession(state, { type: 'tool.started', sessionId, runId, callId, sequence: 2, occurredAt: '2026-10-24T00:00:01Z',
    payload: { startedAt: '2026-10-24T00:00:01Z' } });
  const activity = Object.values(state.activities)[0];
  assert.equal(activity.status, 'active');
  assert.deepEqual(activity.tool.shellIntents, [{ kind: 'search', query: 'TODO', targets: ['src'] }]);
  assert.equal(activity.tool.shell.result, undefined);
  assert.deepEqual(activity.tool.resources, []);
});
