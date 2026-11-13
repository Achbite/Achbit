// Regression TCR: .task-artifacts/frontend-fixes-20261113/TCR.md.
// Actual GUI hooks/stores; bounded HTTP fixtures never change a real permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_USER_SETTINGS } from '../../protocol/dist/index.js';
import { loopSnapshot, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { createSession, readEvents } from '../../session-core/tests/local-agent-fixtures.mjs';
import { findReactElement, installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function exposeSsrState(store) { Object.assign(store.getInitialState(), store.getState()); }

for (const navigate of [false, true]) test(`approval rule save retains its Session owner (navigate=${navigate})`, { timeout: 20_000 }, async t => {
  const [{ useLocalAgentStore: store }, { useSettingsStore: settings }, { ComposerDecisionPanels }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts', '/src/components/local-agent/ComposerDecisionPanels.tsx',
  ]);
  const sessionA = 'session:rule-A', sessionB = 'session:rule-B';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionA); await createSession(journal, sessionB);
  const projectionA = projectSession(loopSnapshot(sessionA, await readEvents(journal, sessionA)).state);
  const projectionB = projectSession(loopSnapshot(sessionB, await readEvents(journal, sessionB)).state);
  const context = { command: 'printf rule-A', workspaceId: 'workspace:A',
    environment: { shell: '/bin/bash', executionScope: 'workspace' } };
  const approval = { approvalId: 'approval:A', runId: 'run:A', callId: 'call:A',
    preview: { summary: context.command, effects: ['process'], logicalTargets: ['.'],
      authorizationScope: 'runCommand', authorizationScopes: ['runCommand', 'sessionCommand'], authorizationContext: context } };
  const patchStarted = deferred(), finishPatch = deferred();
  t.after(() => finishPatch.resolve());
  let savedSettings = { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'en-US', 'agent.permissions.commandRules': '[]' };
  const commands = [], requests = [];
  installGuiFetch(t, async (url, init) => {
    requests.push(`${init.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/user-settings') {
      if (init.method === 'PATCH') {
        patchStarted.resolve(); await finishPatch.promise;
        const { patches } = JSON.parse(init.body);
        savedSettings = { ...savedSettings, ...patches };
        return Response.json({ ok: true, data: { settings: savedSettings, changedKeys: Object.keys(patches), activation: 'immediate' } });
      }
      return Response.json({ ok: true, data: { settings: savedSettings, runtimeSettings: savedSettings, storePath: '/fixture/settings.json' } });
    }
    for (const projection of [projectionA, projectionB]) {
      if (url.pathname === `/api/conversation/sessions/${encodeURIComponent(projection.sessionId)}/projection`)
        return Response.json({ ok: true, data: projection });
    }
    if (url.pathname.endsWith('/commands') && init.method === 'POST') {
      commands.push(JSON.parse(init.body));
      // Observe the real API destination, then reject: no fabricated acceptance or real permission change.
      return Response.json({ ok: false, error: 'fixture_stop_after_permission_capture' }, { status: 409 });
    }
    throw new Error(`unexpected_request:${init.method ?? 'GET'}:${url.pathname}`);
  });
  settings.setState({ effectiveSettings: savedSettings, userSettings: savedSettings, loading: false, errorMessage: null });
  store.setState({ sessionId: sessionA, projection: projectionA, loading: false, submitting: false,
    catalogBusy: false, runtimeReady: true, catalog: { projects: [], sessions: [
      { id: sessionA, title: 'A', projectId: null }, { id: sessionB, title: 'B', projectId: null },
    ] } });
  exposeSsrState(settings); exposeSsrState(store);
  let tree;
  function Probe() {
    tree = ComposerDecisionPanels({ language: 'en-US', composer: {
      pendingPlan: null, pendingScopeAddition: null, pendingInteraction: null, pendingApproval: approval,
      submitting: false, projection: projectionA,
      respondApproval: async () => assert.fail('saving a rule does not answer approval'),
      respondInteraction: async () => assert.fail('saving a rule does not answer interaction'),
      submitPlanDecision: async () => assert.fail('saving a rule does not answer Plan'),
    } });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const button = findReactElement(tree, node => node.props['data-ui-action'] === 'composer.decision.save-rule');
  assert.equal(button.props.disabled, false);
  button.props.onClick(); button.props.onClick(); // Synchronous duplicate admission must also be prevented.
  await patchStarted.promise;
  if (navigate) {
    assert.equal(store.getState().submitting, false);
    await store.getState().activateSession(sessionB);
    assert.equal(store.getState().projection.sessionId, sessionB);
  }
  finishPatch.resolve();
  await settings.getState().loadUserSettings(); await flush(); await flush();
  assert.equal(requests.filter(request => request === 'PATCH /api/user-settings').length, 1);
  assert.deepEqual(JSON.parse(settings.getState().effectiveSettings['agent.permissions.commandRules']), [{ decision: 'allow', context }]);
  assert.equal(commands.filter(command => command.sessionId === sessionB).length, 0);
  assert.equal(commands.length, navigate ? 0 : 1, 'navigation away drops only the obsolete local Session update');
  if (!navigate) assert.equal(commands[0].sessionId, sessionA);
});
