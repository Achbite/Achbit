// Independent review decisions must not appear in the main conversation stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionActor } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { fakeRunPreparation, emptyKernel, createSession, workspaceBinding, providerEvent,
  messageCommand, waitForProjection, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const shell = { toolBindingRef: 'binding:shell', name: 'bash', description: 'Run a command', origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: ['process'], inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } } };

for (const ordered of [false, true]) test(`independent review streams status, not decision JSON, into the conversation (ordered=${ordered})`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:review-stream-${ordered}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [shell, { ...shell, toolBindingRef: 'binding:read', name: 'fs.read', possibleEffects: ['workspaceRead'] }], permissions: { 'agent.permissions.shell': 'review' } });
  const observations = [];
  const decision = JSON.stringify({ decision: 'allow', reason: '允许读取测试文件。' });
  const progress = '我会先检查测试文件，再说明结果。';
  let turns = 0;
  const actor = new SessionActor(sessionId, journal, {
    runPreparation: preparation.port,
    provider: { async *stream(request) {
      if (request.purpose === 'approvalReview') {
        assert.ok(request.tools.some(tool => tool.name === 'fs_read'), 'exercise the evidence-capable review path');
        yield providerEvent(request.requestId, 'text.delta', { text: decision.slice(0, 15), ...(ordered ? { outputIndex: 0 } : {}) });
        yield providerEvent(request.requestId, 'text.delta', { text: decision.slice(15), ...(ordered ? { outputIndex: 0 } : {}) });
        if (ordered) yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: decision }] } });
        else yield providerEvent(request.requestId, 'assistant.message', { content: decision });
      } else if (++turns === 1) {
        yield providerEvent(request.requestId, 'text.delta', { text: progress });
        yield providerEvent(request.requestId, 'tool.call', { callId: 'provider:read', name: 'bash', input: { command: 'cat sample.txt' } });
      } else {
        yield providerEvent(request.requestId, 'text.delta', { text: '检查完成。' });
        yield providerEvent(request.requestId, 'assistant.message', { content: '检查完成。' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } },
    kernel: emptyKernel({ async execute(request) {
      if (request.nonWorkspaceAuthority) return completedExecutionReply(request, { output: 'test contents' });
      return { schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
        callId: request.callId, status: 'approvalRequired', preview: { summary: 'Read sample', effects: ['process'], logicalTargets: ['.'],
          approvalReviewer: 'agent', authorizationContext: { command: 'cat sample.txt' },
          reviewPolicy: { subject: 'shell', mode: 'review', reviewGrant: 'thisCallOnly' } } };
    } }), async dispose() {},
  }, { observation: { accept(value) { observations.push(structuredClone(value)); }, failed(_, error) { throw error; } } });
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', '读取测试文件并说明结果。'));
  const final = await waitForProjection(actor, value => ['completed', 'failed'].includes(value.run?.status));
  assert.equal(final.run.status, 'completed', JSON.stringify(final.terminalError));
  const drafts = observations.filter(value => value.kind === 'draft').map(value => value.draft);
  const reviews = drafts.filter(value => value.activity?.purpose === 'approvalReview');
  assert.ok(reviews.length > 0, 'review progress remains observable');
  assert.ok(reviews.every(value => value.blocks.length === 0 && !value.planPreview), 'review JSON must never enter the main assistant draft');
  assert.ok(drafts.some(value => value.activity?.purpose === 'agent' && value.blocks.some(block => block.content === progress)));
  assert.ok(final.narratives.some(value => value.content === progress));
  assert.equal(final.messages.at(-1).content, '检查完成。');
  const reviewed = (await readEvents(journal, sessionId)).find(value => value.type === 'approval.reviewed');
  assert.equal(reviewed.payload.reason, '允许读取测试文件。', 'decision is retained in its own review record');
});
