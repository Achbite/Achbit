import assert from 'node:assert/strict';
import test from 'node:test';
import { processResult, toolResultContent } from '../dist/local-agent/modelToolResult.js';

const modelResult = (toolName, input, output) => JSON.parse(toolResultContent({
  toolName, input, output, outcome: 'completed', preparedEffect: { origin: 'coreBuiltin' },
}, undefined, new Map()));

test('Brave model results expose an observed rewrite, but do not invent one', () => {
  const original = 'partical dynamics';
  const project = query => modelResult('web.search', { query: 'request text' }, { provider: 'brave-search', query, results: [] });
  assert.deepEqual(project({ original, altered: 'particle dynamics', diagnostics: 'private' }), {
    query: { original, altered: 'particle dynamics' }, results: [],
  });
  for (const query of [{ original }, { original, altered: original }, { altered: 'unpaired' }, undefined]) {
    assert.deepEqual(project(query), { results: [] });
  }
});

test('container status and wake use only the identities observed in exec/create results', () => {
  const engine = { context: 'remote-build', endpoint: 'unix:///fixture.sock' };
  const mounts = [{ Source: '/private/host', Destination: '/workspace' }];
  const job = { jobId: 'job:container', sessionId: 'session:c', runId: 'run:c', callId: 'call:c',
    revision: 2, toolName: 'container', command: 'fixture', targets: ['input-name-not-an-id'],
    status: 'completed', startedAt: '1', completedAt: '2',
    output: { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false } };
  for (const [native, expected] of [
    [{ container: { id: 'inspected-id', engine, mounts }, command: 'fixture' }, { containerId: 'inspected-id', engine }],
    [{ containerId: 'new-id', engine, projectPath: '/project', workPath: '/work', network: 'none', sessionPath: '/private/host' },
      { containerId: 'new-id', engine, projectPath: '/project', workPath: '/work', network: 'none' }],
    [{ containerId: 'id-only' }, { containerId: 'id-only' }],
    [{ container: { name: 'not-an-id', engine: { mounts }, mounts } }, {}],
  ]) {
    const actual = { ...job, result: native };
    const projected = { jobId: job.jobId, status: 'completed', ...expected };
    assert.deepEqual(modelResult('process', { action: 'status' }, { job: actual }), projected);
    assert.deepEqual(processResult(actual, 'notification'), projected);
  }
  const error = { code: 'container_execution_failed', message: 'No result from the engine.' };
  assert.deepEqual(processResult({ ...job, status: 'failed', error }, 'notification'), {
    jobId: job.jobId, status: 'failed', error,
  });
});
