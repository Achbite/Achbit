import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loopSnapshot, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { createSession, readEvents, workspaceBinding } from '../../session-core/tests/local-agent-fixtures.mjs';
import { decodeGuiProjection, installGuiFetch, loadGuiModules } from './gui-projection-contract.mjs';

test('computer history lists each operation collapsed and reveals only its archived evidence with accurate feedback', async t => {
  const [{ ComputerActivity, computerInterfaceText, computerActivitySummary }, { readConversationArtifact }, { ToolActivityGroup }, { ConversationVirtualRow }, { projectionItems }, { AgentConversationHistory }] = await loadGuiModules(t, [
    '/src/components/local-agent/ComputerActivity.tsx', '/src/services/localAgentApi.ts', '/src/components/local-agent/ToolActivityDetails.tsx',
    '/src/components/local-agent/ConversationVirtualRow.tsx',
    '/src/components/local-agent/conversationItems.ts',
    '/src/components/local-agent/AgentTasksPanel.tsx',
  ]);
  const journal = new InMemoryCommandJournal(), sessionId = 'session:computer-gui';
  await createSession(journal, sessionId, [workspaceBinding]);
  const projection = projectSession(loopSnapshot(sessionId, await readEvents(journal, sessionId)).state);
  const artifact = { artifactId: 'artifact:frame', sessionId, runId: 'run:history', callId: 'call:observe', recordId: 'record:observe',
    label: 'Observation.png', createdAt: '1', uri: 'artifact://artifact:frame', contentMode: 'fixed', contentType: 'image/png' };
  const computer = { action: 'observe', input: { action: 'observe', app: 'app:editor' }, app: 'app:editor',
    window: { title: 'Draft' }, observation: { observationId: 'observation:1', artifactIds: [artifact.artifactId],
      interface: { elements: [{ elementId: 'button:save', role: 'AXButton', title: 'Save draft' }] } } };
  const activity = { activityId: 'tool:observe', kind: 'tool', status: 'completed', runId: 'run:history', callId: 'call:observe',
    label: 'computer.control', sequence: 1, tool: { operation: 'computer.control', resources: [], computer } };
  const incoming = { ...projection, artifacts: [artifact], activities: [activity], timeline: [
    { kind: 'toolGroup', timelineId: 'timeline:history', sequence: 1, providerRequestId: 'provider:history', activityIds: [activity.activityId] },
  ] };
  assert.deepEqual(await decodeGuiProjection(incoming), incoming);
  const html = renderToStaticMarkup(createElement(ComputerActivity, { activity, computer, artifacts: [artifact],
    language: 'en-US', statusLabel: 'Completed', onExpand() {} }));
  assert.match(html, /Observe · Draft/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /computer-activity__image|<dialog|Save draft|button:save|<pre/);
  const savedArtifact = { ...artifact, artifactId: 'artifact:saved', callId: 'call:press', recordId: 'record:press' };
  const opened = { ...activity, activityId: 'tool:open', callId: 'call:open', sequence: 0,
    tool: { operation: 'browser.open', resources: [], computer: { action: 'open', input: { path: 'draft.html' }, page: { title: 'Draft' } } } };
  const approval = { activityId: 'approval:press', kind: 'approval', status: 'completed', runId: activity.runId,
    callId: 'call:press', sequence: 2, label: 'Allow press' };
  const pressed = { ...activity, activityId: 'tool:press', callId: 'call:press', sequence: 3, tool: { ...activity.tool,
    computer: { action: 'press', input: { elementId: 'button:save' }, dispatched: true,
      inputObservation: { observationId: 'observation:1', artifactIds: [artifact.artifactId], element: { title: 'Save draft' } },
      observation: { observationId: 'observation:2', artifactIds: [savedArtifact.artifactId], interface: { text: 'Saved successfully' } } } } };
  const ordinary = { ...activity, activityId: 'tool:status', callId: 'call:status',
    tool: { operation: 'plugin.status', resources: [] } };
  const activities = [opened, ordinary, activity, approval, pressed];
  const continuous = { ...projection, activities, timeline: [
    { kind: 'toolGroup', timelineId: 'timeline:first', sequence: 1, activityIds: [opened.activityId, ordinary.activityId] },
    { kind: 'toolGroup', timelineId: 'timeline:second', sequence: 2, activityIds: [activity.activityId, approval.activityId, pressed.activityId] },
  ] };
  const original = structuredClone(continuous);
  const items = projectionItems(continuous);
  assert.equal(items.length, 1, 'continuous calls stay in the same tool group, including ordinary tools and approvals');
  assert.equal(items[0].type, 'toolGroup');
  assert.deepEqual(items[0].values.map(item => item.activityId), activities.map(item => item.activityId));
  assert.deepEqual(continuous, original, 'displaying operation rows does not rewrite the Session timeline');
  const layout = { state: new Map([['tool-group:expanded', false]]) };
  const render = (children) => renderToStaticMarkup(createElement(ConversationVirtualRow, {
    rowKey: 'history', eager: true, virtualizer: { layout: () => layout }, children,
  }));
  const renderGroup = (language = 'en-US') => render(() => createElement(ToolActivityGroup, {
    activities: items[0].values, artifacts: [artifact, savedArtifact],
    language, onExpand() {}, onOpenWorkspaceResource() {},
  }));
  const group = renderGroup();
  assert.doesNotMatch(group, /local-agent__tool-group-summary|Used \d+ tools/,
    'computer operations have no enclosing tool-count disclosure');
  assert.equal((group.match(/aria-expanded="false"/g) ?? []).length, 5,
    'all three computer operations, the ordinary tool and the approval are individually visible and collapsed');
  assert.ok(group.indexOf('Open · Draft') < group.indexOf('Used tool plugin.status'));
  assert.ok(group.indexOf('Used tool plugin.status') < group.indexOf('Observe · Draft'));
  assert.ok(group.indexOf('Observe · Draft') < group.indexOf('Accepted'));
  assert.ok(group.indexOf('Accepted') < group.indexOf('Press · Save draft'), 'mixed approval order is preserved');
  assert.doesNotMatch(group, /computer-activity__image|<dialog|<pre|Input sent|Saved successfully/);
  for (const label of ['打开 · Draft', '观察 · Draft', '点击 · Save draft']) assert.ok(renderGroup('zh-CN').includes(label));
  layout.state.set(`computer:${activity.activityId}:details`, true);
  const observed = renderGroup();
  assert.equal((observed.match(/<dialog/g) ?? []).length, 1, 'only the selected observation mounts its archived image viewer');
  assert.match(observed, /Recognized content/);
  assert.match(observed, /button:save  AXButton  Save draft/);
  assert.doesNotMatch(observed, /Input sent|Saved successfully/);
  const childHistory = render(() => createElement(AgentConversationHistory, {
    projection: incoming, name: 'Computer reviewer', language: 'en-US', expanded: true,
  }));
  assert.match(childHistory, /computer-activity__image/,
    'the child history passes its own archived artifacts to the shared operation renderer');
  assert.doesNotMatch(childHistory, /Archived image unavailable/);
  assert.deepEqual(incoming.artifacts, [artifact], 'rendering child evidence preserves its Session artifacts');
  layout.state.set(`computer:${activity.activityId}:details`, false);
  layout.state.set(`computer:${pressed.activityId}:details`, true);
  const pressedHtml = renderGroup();
  assert.match(pressedHtml, /Input sent/);
  assert.match(pressedHtml, /Saved successfully/);
  assert.match(pressedHtml, /computer-activity__image/);
  assert.doesNotMatch(pressedHtml, /button:save  AXButton/, 'opening another operation leaves observation text folded');
  layout.state.set(`computer:${pressed.activityId}:details`, false);
  assert.equal(renderGroup(), group, 'folding each operation restores the concise rows without losing evidence');
  assert.match(computerInterfaceText(computer.observation.interface), /button:save  AXButton  Save draft/);
  assert.equal(computerInterfaceText({ elements: [{ selector: '#note', role: 'input', value: '' }] }), '#note  input  value=""',
    'an observed empty input remains visible, including when a dispatched setValue had no effect');
  assert.equal(computerInterfaceText({ elements: [{ elementId: 'tabs', role: 'AXTabGroup',
    value: { type: 'AXUIElement', role: 'AXRadioButton', title: 'Preview' } }] }),
    'tabs  AXTabGroup  value={"type":"AXUIElement","role":"AXRadioButton","title":"Preview"}');
  const unapplied = { ...activity, status: 'failed', tool: { ...activity.tool,
    error: { code: 'computer_value_not_applied', message: 'AX value remained empty' } } };
  const renderUnapplied = () => render(() => createElement(ComputerActivity, { activity: unapplied,
    computer: { ...computer, action: 'setValue', input: { text: 'updated' }, dispatched: true,
      result: { valueVerification: { expected: 'updated', actual: '', matched: false } } }, artifacts: [artifact],
    language: 'en-US', statusLabel: 'Failed', onExpand() {} }));
  assert.match(renderUnapplied(), />Failed</, 'a failed operation stays visibly failed while collapsed');
  assert.doesNotMatch(renderUnapplied(), /AX value remained empty|computer-activity__image/);
  layout.state.set(`computer:${activity.activityId}:details`, true);
  const unappliedHtml = renderUnapplied();
  assert.match(unappliedHtml, /AX value remained empty/);
  assert.match(unappliedHtml, /computer-activity__image/);
  assert.match(unappliedHtml, /&quot;matched&quot;: false/, 'value verification remains visible in the expanded feedback');
  assert.doesNotMatch(unappliedHtml, /following observation failed/);
  const failed = { ...activity, status: 'failed', tool: { ...activity.tool,
    error: { code: 'computer_observation_failed', message: 'The window closed.' } } };
  const input = { action: 'click', input: { action: 'click', x: 10, y: 20 }, dispatched: true };
  const failure = render(() => createElement(ComputerActivity, { activity: failed, computer: input, artifacts: [],
    language: 'en-US', statusLabel: 'Failed', onExpand() {} }));
  assert.match(failure, /Input sent, but the following observation failed/);
  assert.match(failure, /The window closed/);
  assert.doesNotMatch(failure, /<dialog|computer-activity__image/);
  assert.equal(computerActivitySummary(input, 'en-US'), 'Click · (10, 20)');
  assert.equal(computerActivitySummary({ action: 'press', input: { elementId: 'button:save' },
    inputObservation: { observationId: 'observation:1', artifactIds: [], element: { title: 'Save draft' } } }, 'en-US'), 'Press · Save draft');
  assert.equal(computerActivitySummary({ action: 'setValue', input: { elementId: 'input:note', text: 'new content' },
    inputObservation: { observationId: 'observation:1', artifactIds: [], element: { title: 'Retained note' } } }, 'en-US'), 'Fill · Retained note');
  const requests = [];
  installGuiFetch(t, async (url, init) => {
    requests.push([url.pathname, init.method ?? 'GET']);
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.artifactId)}/content`);
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
  });
  const blob = await readConversationArtifact(sessionId, artifact.artifactId);
  assert.equal(blob.type, 'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [137, 80, 78, 71]);
  assert.equal(requests.length, 1, 'reading a historical image only reads its archive');
});
