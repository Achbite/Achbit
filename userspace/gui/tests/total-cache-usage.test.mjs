import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loopSnapshot, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { createSession, readEvents, workspaceBinding } from '../../session-core/tests/local-agent-fixtures.mjs';
import { decodeGuiProjection, installGuiFetch, loadGuiModelStore, loadGuiModules } from './gui-projection-contract.mjs';

async function projectionFixture() {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:total-cache-ui';
  await createSession(journal, sessionId, [workspaceBinding]);
  return projectSession(loopSnapshot(sessionId, await readEvents(journal, sessionId)).state);
}
const usage = (inputTokens, hit) => ({ providerCallCount: 1, reportedCallCount: 1, inputTokens, outputTokens: 10,
  cacheReadInputTokens: hit, cacheMissInputTokens: inputTokens - hit, cacheAvailable: true,
  cacheComplete: true, cacheHitRatio: hit / inputTokens });

test('GUI total cache displays the Session tree aggregate and strictly decodes its facts', async t => {
  const projection = await projectionFixture();
  projection.tokenUsage = usage(100, 90);
  projection.totalTokenUsage = { ...usage(400, 150), providerCallCount: 2, reportedCallCount: 2 };
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const [{ default: TotalCacheUsage }] = await loadGuiModules(t,
    ['/src/components/local-agent/TotalCacheUsage.tsx']);
  const html = renderToStaticMarkup(createElement(TotalCacheUsage, { projection, language: 'zh-CN' }));
  assert.match(html, /37\.5%/u);
  assert.doesNotMatch(html, />90%/u);
  assert.match(html, /全部子代理/u);
  const missing = structuredClone(projection); delete missing.totalTokenUsage;
  await assert.rejects(decodeGuiProjection(missing), /conversation_projection_invalid/u);
  const wrong = structuredClone(projection); wrong.totalTokenUsage.cacheHitRatio = 0.9;
  await assert.rejects(decodeGuiProjection(wrong), /conversation_projection_invalid/u);
});

test('GUI accepts child usage while the parent is idle and its journal revision stays unchanged', async t => {
  const projection = await projectionFixture();
  projection.agentChildren = [{ agentSessionId: 'session:child', displayName: 'Child', closed: false,
    capabilities: { continuation: true, delegation: false, messaging: 'parent' } }];
  projection.tokenUsage = usage(100, 90);
  projection.totalTokenUsage = usage(100, 90);
  let incoming = projection;
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [{ sessionId: projection.sessionId,
      revision: projection.revision, run: projection.run }] });
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: incoming });
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId: projection.sessionId, projection, loading: false });
  await store.getState().refresh();
  incoming = { ...projection, totalTokenUsage: { ...usage(400, 150), providerCallCount: 2, reportedCallCount: 2 } };
  await store.getState().refresh();
  assert.deepEqual(store.getState().projection.totalTokenUsage, incoming.totalTokenUsage);
  assert.deepEqual(store.getState().projection.tokenUsage, projection.tokenUsage);
  assert.equal(store.getState().projection.revision, projection.revision);
});
