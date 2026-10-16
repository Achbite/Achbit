import assert from 'node:assert/strict';
import test from 'node:test';
import { loopSnapshot, projectSession } from '../dist/index.js';
import { projectComputerActivity } from '../dist/local-agent/computerActivity.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, completedExecutionReply, failedExecutionReply,
  providerEvent, messageCommand, waitForProjection, readEvents, workspaceBinding } from './local-agent-fixtures.mjs';

const image = id => ({ artifactId: id, label: 'Observation.png', uri: `artifact://${id}`, contentMode: 'fixed', contentType: 'image/png' });

test('computer history replays exact input observations, archived images and dispatched failures after run release', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:computer-history';
  await createSession(journal, sessionId, [workspaceBinding]);
  const app = 'app:editor', element = { elementId: 'button:save', role: 'AXButton', title: 'Save' };
  const calls = [
    ['computer.control', { action: 'observe', app, windowId: 12 }, { app, window: { windowId: 12, title: 'Draft' },
      observationId: 'observation:before', elements: [element], accessibility: { complete: true, errors: [] }, artifacts: [image('artifact:before')] }],
    ['computer.control', { action: 'press', app, observationId: 'observation:before', elementId: 'button:save' },
      { app, dispatched: true, observationId: 'observation:after', elements: [{ ...element, title: 'Saved' }], artifacts: [image('artifact:after')] }],
    ['computer.control', { action: 'click', app, observationId: 'observation:after', x: 21, y: 34 },
      { app, dispatched: true, observationError: { message: 'Window closed before observation.' } }],
    ['browser.observe', { previewId: 'page:1' }, { sourcePage: { previewId: 'page:1', url: 'https://example.test' },
      observation: { title: 'Preview', text: 'Counter: 1', elements: [{ selector: '#add', role: 'button', text: 'Add' }] },
      artifacts: [image('artifact:browser')] }],
    ['browser.page', { action: 'act', operation: 'inspect', previewId: 'page:1' },
      { page: { previewId: 'page:1' }, result: { text: 'Counter: 2', elements: [] } }],
    ['browser.page', { action: 'act', operation: 'click', previewId: 'page:1', selector: '#add' },
      { page: { previewId: 'page:1' }, result: { clicked: true } }],
    ['browser.open', { path: 'index.html' }, { previewId: 'page:2', url: 'http://localhost/index.html', status: 'ready' }],
    ['computer.control', { action: 'setValue', app, observationId: 'observation:after', elementId: 'field:note', text: 'updated' },
      { app, dispatched: true, observationId: 'observation:unapplied',
        valueVerification: { expected: 'updated', actual: '', matched: false },
        actionError: { message: 'AX value remained empty' },
        elements: [{ elementId: 'field:note', role: 'AXTextField', value: '' },
          { elementId: 'tabs', role: 'AXTabGroup', value: { type: 'AXUIElement', role: 'AXRadioButton', title: 'Preview' } }],
        artifacts: [image('artifact:unapplied')] }],
    ['browser.page', { action: 'activate', previewId: 'page:2' },
      { previewId: 'page:2', status: 'ready', readiness: {
        navigation: { readyState: 'complete', url: 'http://localhost/index.html' },
        accessibility: { status: 'connected', remoteChildren: 1 },
      } }],
  ];
  let turns = 0, executed = 0;
  const records = [];
  const preparation = fakeRunPreparation({ contextWindowTokens: 65536, tools: [...new Set(calls.map(call => call[0]))].map(name => ({
    toolBindingRef: `binding:${name}`, name, description: name, inputSchema: { type: 'object' },
    possibleEffects: ['external'], availability: 'callable', origin: 'coreBuiltin',
  })) });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    assert.ok(turns <= calls.length, 'bounded provider sequence');
    const call = calls[turns++];
    if (call) yield providerEvent(request.requestId, 'tool.call', {
      callId: `provider:${turns}`, name: call[0].replaceAll('.', '_'), input: call[1],
    });
    else yield providerEvent(request.requestId, 'text.delta', { text: 'Finished checking the interface.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    const output = calls[executed++][2];
    const reply = output.actionError ? failedExecutionReply(request, output,
      { code: 'computer_value_not_applied', message: output.actionError.message }) : output.observationError ? failedExecutionReply(request, output,
      { code: 'computer_observation_failed', message: output.observationError.message }) : completedExecutionReply(request, output);
    records.push(reply.record);
    return reply;
  } }), preparation.port, 'computer-history');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:history', 'Inspect and operate the test windows.'));
  const projection = await waitForProjection(actor, state => state.run?.status === 'completed');
  const steps = projection.activities.filter(activity => activity.tool?.computer);
  assert.equal(steps.length, calls.length);
  assert.equal(steps[1].tool.computer.inputObservation.element.title, 'Save', 'the target name comes from the input frame, not Saved in the returned frame');
  assert.deepEqual(steps[1].tool.computer.inputObservation.artifactIds, ['artifact:before']);
  assert.deepEqual(steps[1].tool.computer.observation.artifactIds, ['artifact:after']);
  assert.equal(steps[2].status, 'failed');
  assert.equal(steps[2].tool.computer.dispatched, true);
  assert.equal(steps[2].tool.computer.observation, undefined, 'a failed capture cannot reuse the preceding screenshot as its result');
  assert.equal(steps[2].tool.error.message, 'Window closed before observation.');
  assert.equal(steps[3].tool.computer.observation.interface.text, 'Counter: 1');
  assert.deepEqual(steps[3].tool.computer.observation.artifactIds, ['artifact:browser']);
  assert.equal(steps[4].tool.computer.observation.interface.text, 'Counter: 2');
  assert.deepEqual(steps[4].tool.computer.observation.artifactIds, [], 'DOM inspection alone has no screenshot');
  assert.equal(steps[5].tool.computer.observation, undefined);
  assert.equal(steps[5].tool.computer.dispatched, undefined, 'desktop dispatch is not inferred for browser results');
  assert.deepEqual(steps[6].tool.computer.page, { previewId: 'page:2', url: 'http://localhost/index.html', status: 'ready' });
  assert.equal(steps[7].status, 'failed');
  assert.equal(steps[7].tool.computer.dispatched, true);
  assert.deepEqual(steps[7].tool.computer.result.valueVerification, { expected: 'updated', actual: '', matched: false });
  assert.equal(steps[7].tool.computer.observation.interface.elements[0].value, '');
  assert.deepEqual(steps[7].tool.computer.observation.interface.elements[1].value,
    { type: 'AXUIElement', role: 'AXRadioButton', title: 'Preview' });
  assert.deepEqual(steps[7].tool.computer.observation.artifactIds, ['artifact:unapplied'], 'failed input verification retains its actual post-action image');
  assert.deepEqual(steps[8].tool.computer.result.readiness, calls[8][2].readiness, 'native readiness facts survive replay independently of navigation status');
  assert.equal(steps[6].tool.computer.result.readiness, undefined, 'navigation ready alone does not imply AX readiness');
  assert.deepEqual(steps[0].tool.computer.observation.interface.accessibility, { complete: true, errors: [] });
  assert.equal(steps[0].tool.computer.result?.readiness, undefined, 'a complete traversal does not invent page readiness');
  assert.equal(projection.artifacts.length, 4);
  assert.equal(projection.deliverables.length, 0, 'observations are not user deliverables');
  assertRuntimeContract('SessionProjection', projection);
  const events = await readEvents(journal, sessionId), frozen = structuredClone(events);
  const replayed = projectSession(loopSnapshot(sessionId, events).state);
  assert.deepEqual(replayed.activities, projection.activities);
  assert.deepEqual(replayed.artifacts, projection.artifacts);
  assert.deepEqual(events, frozen);
  const ordered = projection.timeline.filter(item => item.kind === 'toolGroup').flatMap(item => item.activityIds);
  for (const step of steps) assert.equal(ordered.filter(id => id === step.activityId).length, 1);
  assert.ok(events.findIndex(event => event.type === 'run.runtime.released') < events.findIndex(event => event.type === 'run.settled'));
  assert.equal(preparation.released.length, 1);
  assert.deepEqual(await readEvents(journal, sessionId), events, 'history projection has no execution side effects');
  for (const mismatched of [{ ...steps[0], runId: 'run:other' },
    { ...steps[0], tool: { ...steps[0].tool, computer: { ...steps[0].tool.computer, app: 'app:other' } } }]) {
    const detail = projectComputerActivity(records[1], [], { other: mismatched });
    assert.equal(detail.inputObservation, undefined, 'another run/app cannot supply an input frame or element label');
  }
});
