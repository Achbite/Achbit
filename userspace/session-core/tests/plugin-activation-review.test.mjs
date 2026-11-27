import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation, messageCommand,
  providerEvent, readEvents, waitForProjection, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

const uri = 'plugin://inspector@local';
const read = { name: 'fs.read', toolBindingRef: 'binding:read', description: 'Read a file.', origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['workspaceRead'], inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } };
const search = { ...read, name: 'plugin.search', toolBindingRef: 'binding:search', possibleEffects: ['localRead'],
  inputSchema: { type: 'object', properties: {} } };

test('a held agent review does not hide a finished sibling or start a second reviewer or activation', { timeout: 10_000 }, async t => {
  const sessionId = 'session:activation-review', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [search, read], contextWindowTokens: 32_000 });
  const releaseReview = Promise.withResolvers(), releaseSiblings = Promise.withResolvers();
  const main = [], reviews = [], attempts = [], effects = [], returned = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (request.purpose === 'approvalReview') {
      const path = JSON.parse(request.messages[1].content).operation.arguments.path;
      reviews.push(path);
      if (path === 'a') await releaseReview.promise;
      yield providerEvent(request.requestId, 'assistant.message', { content: JSON.stringify({ decision: path === 'a' ? 'deny' : 'ask', reason: `Review ${path}.` }) });
    } else {
      main.push(request);
      if (main.length === 1) for (const key of ['a', 'activate', 'b', 'c', 'd', 'e']) yield providerEvent(request.requestId, 'tool.call', { callId: `native:${key}`,
        name: key === 'activate' ? 'plugin_activate' : 'fs_read', input: key === 'activate' ? { pluginUris: [uri] } : { path: key } });
      else yield providerEvent(request.requestId, 'text.delta', { text: 'Done.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    const { path } = request.input;
    attempts.push(request);
    if (path !== 'a') await releaseSiblings.promise;
    if (['a', 'c'].includes(path) && !request.nonWorkspaceAuthority) {
      returned.push(`${path}:approval`);
      return { schemaVersion: 'achbit.kernel-reply', type: 'tool.execution', requestId: request.requestId,
        callId: request.callId, status: 'approvalRequired', preview: { summary: `Review ${path}`, effects: ['workspaceRead'],
          logicalTargets: [path], approvalReviewer: 'agent' } };
    }
    const reply = completedExecutionReply(request, { content: `read ${path}` });
    if (request.nonWorkspaceAuthority?.decision === 'deny') {
      reply.status = reply.record.outcome = 'denied'; delete reply.record.output;
      reply.record.authority = { decision: 'deny', source: 'user', authorityId: request.nonWorkspaceAuthority.authorityId };
    } else effects.push(path);
    returned.push(`${path}:${reply.status}`);
    return reply;
  } }), preparation.port, 'activation-review');
  t.after(async () => { releaseReview.resolve(); releaseSiblings.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:inspect', 'Read the files and load the inspector.'));
  await waitUntil(() => reviews.length === 1 && attempts.length >= 4, 'A is in review; B, C and D are independently in flight');
  assert.deepEqual(attempts.map(r => r.input.path), ['a', 'b', 'c', 'd'], 'E has not entered the four occupied slots');
  assert.deepEqual(reviews, ['a']);
  releaseSiblings.resolve();
  await waitUntil(() => returned.includes('b:completed') && returned.includes('c:approval'), 'B returned its record and C requested its own review');
  const id = path => attempts.find(r => r.input.path === path).callId;
  const activations = () => preparation.prepared.filter(input => input.modelActivation);
  await waitUntil(async () => (await readEvents(journal, sessionId)).some(e => e.type === 'tool.completed' && e.callId === id('b')),
    'B terminal in the journal while the A reviewer remains held');
  await waitUntil(async () => (await readEvents(journal, sessionId)).some(e => e.type === 'tool.completed' && e.payload.record.input.path === 'e'),
    'queued E to fill a released slot and commit while the A reviewer remains held');
  const held = await actor.snapshot();
  assert.ok(held.activities.some(a => a.callId === id('b') && a.tool?.recordId === `record:${id('b')}` && a.status === 'completed'));
  assert.ok(held.pendingApprovals.some(a => a.callId === id('a')));
  assert.deepEqual(reviews, ['a']);
  assert.deepEqual(effects.toSorted(), ['b', 'd', 'e']);
  assert.equal(main.length, 1);
  assert.equal(activations().length, 0);
  const during = await readEvents(journal, sessionId);
  assert.ok(!during.some(e => e.type === 'approval.resolved' || e.type === 'session.plugins.preparing'
    || e.type === 'tool.completed' && !['b', 'd', 'e'].includes(e.payload.record.input.path)));

  releaseReview.resolve();
  const pending = await waitForProjection(actor, p => p.pendingApprovals.some(a => a.callId === id('c') && a.preview.review?.decision === 'ask'));
  const { approvalId, runId, callId } = pending.pendingApprovals.find(a => a.callId === id('c'));
  assert.equal(activations().length, 0);
  assert.equal((await actor.submit({ schemaVersion: 'achbit.command.v3', type: 'approval.respond', sessionId,
    commandId: 'command:deny-c', runId, callId, approvalId, decision: 'deny' })).status, 'accepted');
  const final = await waitForProjection(actor, p => ['completed', 'failed', 'indeterminate', 'cancelled'].includes(p.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  assert.deepEqual(reviews, ['a', 'c']);
  assert.deepEqual(effects.toSorted(), ['b', 'd', 'e']);
  assert.equal(activations().length, 1);
  assert.equal(main.length, 2);
  const results = main[1].messages.filter(m => m.role === 'tool');
  assert.deepEqual(results.map(m => [m.providerCallId, m.toolOutcome]), [
    ['native:a', 'denied'], ['native:activate', 'completed'], ['native:b', 'completed'], ['native:c', 'denied'], ['native:d', 'completed'], ['native:e', 'completed']]);
  assert.deepEqual(JSON.parse(results[1].content).activated, [uri]);
  assert.equal(results[2].content, 'read b');
  const events = await readEvents(journal, sessionId), terminals = events.filter(e => e.type === 'tool.completed');
  assert.deepEqual(terminals.map(e => e.callId).sort(), ['a', 'b', 'c', 'd', 'e'].map(id).sort());
  const preparing = events.find(e => e.type === 'session.plugins.preparing');
  assert.ok(terminals.every(e => e.sequence < preparing.sequence));
  assert.deepEqual(events.filter(e => e.type === 'approval.resolved').map(e => [e.callId, e.payload.source, e.payload.decision]),
    [[id('a'), 'agent', 'deny'], [id('c'), 'user', 'deny']]);
  for (const key of ['a', 'c']) assert.deepEqual(attempts.filter(r => r.input.path === key).map(r => [r.callId, r.nonWorkspaceAuthority?.decision]),
    [[id(key), undefined], [id(key), 'deny']]);
  assert.equal(attempts.filter(r => r.input.path === 'b').length, 1);
});

test('a sibling journal failure stops the reviewer and drains its Provider stream and the other Kernel attempt', { timeout: 10_000 }, async t => {
  const sessionId = 'session:review-drain', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [read, search], contextWindowTokens: 32_000 });
  const sendB = Promise.withResolvers(), drainReview = Promise.withResolvers(), drainKernel = Promise.withResolvers();
  const records = new Map(), attempts = [], cancels = [];
  let reviewing, failedWrite = false, mainTurns = 0;
  const append = journal.append.bind(journal);
  journal.append = event => {
    if (!failedWrite && event.type === 'tool.completed' && event.payload.record.input.path === 'b') {
      failedWrite = true;
      throw new Error('cannot persist sibling B');
    }
    return append(event);
  };
  const actor = actorWith(journal, sessionId, { async *stream(request, signal) {
    if (request.purpose === 'approvalReview') {
      reviewing = signal;
      await drainReview.promise;
      signal.throwIfAborted();
      yield providerEvent(request.requestId, 'text.delta', { text: '{"decision":"ask","reason":"Held review."}' });
    } else {
      assert.equal(++mainTurns, 1);
      for (const path of ['a', 'b', 'c', 'activate']) yield providerEvent(request.requestId, 'tool.call', { callId: `native:${path}`,
        name: path === 'activate' ? 'plugin_activate' : 'fs_read', input: path === 'activate' ? { pluginUris: [uri] } : { path } });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) {
    attempts.push(request);
    const path = request.input.path;
    if (path === 'a') return { schemaVersion: 'achbit.kernel-reply', type: 'tool.execution', requestId: request.requestId,
      callId: request.callId, status: 'approvalRequired', preview: { summary: 'Review A', effects: ['workspaceRead'], logicalTargets: ['a'], approvalReviewer: 'agent' } };
    await (path === 'b' ? sendB : drainKernel).promise;
    const reply = completedExecutionReply(request, { content: `read ${path}` });
    records.set(request.callId, reply.record);
    return reply;
  }, async cancel(callId, attemptId) {
    cancels.push(callId);
    await drainKernel.promise;
    return { schemaVersion: 'achbit.kernel-reply', type: 'tool.cancelled', requestId: 'cancel:fixture', callId, attemptId, status: 'notFound' };
  }, async readRecord(callId) { return records.get(callId) ?? null; } }), preparation.port, 'review-drain');
  t.after(async () => { sendB.resolve(); drainKernel.resolve(); drainReview.resolve(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:read', 'Inspect the files.'));
  await waitUntil(() => reviewing && attempts.length === 3, 'review, B and C in flight');
  sendB.resolve();
  await waitUntil(() => failedWrite, 'B journal write failed');
  await waitUntil(() => reviewing.aborted && cancels.length, 'B failure to abort the held reviewer and cancel C before either drain');
  assert.deepEqual(cancels, [attempts.find(r => r.input.path === 'c').callId]);
  assert.equal(preparation.released.length, 0);
  drainKernel.resolve();
  await waitUntil(async () => (await readEvents(journal, sessionId)).some(e => e.type === 'tool.completed' && e.payload.record.input.path === 'c'),
    'C terminal to be retained while the reviewer still drains');
  assert.equal(preparation.released.length, 0);
  drainReview.resolve();
  const final = await waitForProjection(actor, p => ['failed', 'indeterminate', 'cancelled', 'completed'].includes(p.run?.status));
  assert.ok(['failed', 'indeterminate'].includes(final.run.status));
  assert.match(JSON.stringify(final.terminalError), /cannot persist sibling B/);
  assert.equal(preparation.released.length, 1);
  assert.equal(preparation.prepared.some(r => r.modelActivation), false);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(events.filter(e => e.type === 'tool.completed').map(e => e.payload.record.input.path), ['c', 'b']);
  assert.ok(events.some(e => e.type === 'tool.not-executed' && e.callId === attempts[0].callId),
    'A only returned a gate: stopping its reviewer cannot make an unstarted execution indeterminate');
  assert.deepEqual(attempts.map(r => r.input.path), ['a', 'b', 'c']);
});
