import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { assertRuntimeContract } from '../../session-core/tests/support/runtimeContract.mjs';
import { decodeGuiProjection, loadGuiModules } from './gui-projection-contract.mjs';

function active(callId, operation, blocking) {
  const output = { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false };
  return { activityId: `tool:${callId}`, kind: 'tool', status: 'active', label: operation, callId, runId: 'run:one', sequence: 1,
    tool: { operation, resources: [], process: { jobId: `job:${callId}`, command: `${operation} ${callId}`, output,
      ...(blocking === undefined ? {} : { blocking }) } } };
}

function projection(activities) {
  return { ...projectSession(emptySessionState('session:front')), revision: 2, activities,
    run: { runId: 'run:one', profileId: 'profile:test', status: 'running', workspaceBindings: [] },
    timeline: [{ kind: 'toolGroup', timelineId: 'group:one', providerRequestId: 'request:one', sequence: 1,
      activityIds: activities.map(a => a.activityId) }] };
}

test('only the active, awaited Shell moves from its own tool group to the current composer', async t => {
  const old = globalThis.self; globalThis.self = {};
  t.after(() => { if (old === undefined) delete globalThis.self; else globalThis.self = old; });
  const [{ blockingShells }, { ToolActivityGroup }, { BlockingShellPrompt }] = await loadGuiModules(t, [
    '/src/components/local-agent/shellProgress.ts', '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/BlockingShellPrompt.tsx']);
  const one = active('one', 'bash', true), two = active('two', 'powershell', true), peer = active('peer', 'bash'), plugin = active('other', 'plugin.tool', true);
  const p = projection([one, two, peer, plugin]);
  assertRuntimeContract('ProcessActivityProjection', one.tool.process);
  assert.deepEqual(await decodeGuiProjection(p), p);
  await assert.rejects(decodeGuiProjection(projection([active('wrong', 'bash', 'true')])), /conversation_projection_invalid/);
  const shells = blockingShells(p);
  assert.deepEqual(shells, [one, two]);
  for (const a of [{ ...one, status: 'completed' }, { ...one, runId: 'run:old' }, { ...one, callId: undefined }]) {
    assert.deepEqual(blockingShells({ ...p, activities: [a] }), []);
  }
  assert.deepEqual(blockingShells({ ...p, run: { ...p.run, status: 'releasing' } }), []);
  const group = (activities, foregroundShells = []) => renderToStaticMarkup(createElement(ToolActivityGroup, {
    activities, foregroundShells, language: 'zh-CN', onExpand() {}, onOpenWorkspaceResource() {} }));
  const marker = /aria-label="Shell 正在运行"/;
  assert.doesNotMatch(group([one], shells), marker);
  assert.match(group([one, peer], shells), marker, 'an independent peer remains visible in its group');
  assert.match(group([one]), marker, 'history without a composer retains its own marker');
  assert.doesNotMatch(group([plugin]), marker);
  const card = input => renderToStaticMarkup(createElement(BlockingShellPrompt, { sessionId: p.sessionId, shells: input, language: 'zh-CN' }));
  const html = card(shells);
  for (const label of [/等待 Shell 结果/, /bash one/, /下一条等待中的命令/, /停止此命令/, /查看输出/]) assert.match(html, label);
  assert.doesNotMatch(html, /bash peer|plugin.tool other/);
  assert.equal(card([]), '');
});
