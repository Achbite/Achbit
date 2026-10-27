import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentModelParameters } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest, cloneModelMessage } from '../dist/local-agent/contextComposer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { actorWith, completedExecutionReply, createSession, emptyKernel, fakeRunPreparation, messageCommand,
  providerEvent, readEvents, runtimeSnapshot, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const pdf = { referenceId: 'attachment:pdf', kind: 'file', workspaceId: workspaceBinding.workspaceId,
  logicalPath: 'report.pdf', mediaType: 'application/pdf', displayName: 'report.pdf', byteLength: 128 };
const logicalPdf = { workspaceId: pdf.workspaceId, logicalPath: pdf.logicalPath, mediaType: pdf.mediaType, displayName: pdf.displayName };
const fileRefs = request => request.messages.flatMap(message => message.files ?? []);
const pdfRuntime = runId => {
  const runtime = runtimeSnapshot(runId, { contextWindowTokens: 32768 });
  runtime.provider.fileInputMediaTypes = ['application/pdf'];
  return runtime;
};

test('native PDFs remain with selected user messages across completed requests and disappear only after their message leaves context', async () => {
  const sessionId = 'session:pdf-context', runId = 'run:pdf-context';
  const events = [];
  const append = (type, payload, extra = {}) => {
    const event = { type, sessionId, runId, eventId: `event:${events.length + 1}`, sequence: events.length + 1,
      occurredAt: '2026-10-26T00:00:00.000Z', payload, ...extra };
    events.push(event); return event;
  };
  append('session.created', { displayTitle: 'PDF context', workspaceBindings: [workspaceBinding] }, { runId: undefined });
  append('message.committed', { role: 'user', messageId: 'message:pdf', content: 'Compare the PDF with the image.', filesystemReferences: [pdf,
    { ...pdf, referenceId: 'attachment:image', logicalPath: 'image.png', mediaType: 'image/png', displayName: 'image.png' }] }, { runId: undefined });
  const runtime = pdfRuntime(runId);
  append('run.started', { inputMessageId: 'message:pdf', workspaceBindings: [workspaceBinding], runtimeSnapshot: runtime });
  const build = async (id, currentRunId = runId, currentRuntime = runtime) => {
    const value = await buildAgentProviderRequest({ sessionId, runId: currentRunId, runtime: currentRuntime,
      events, workspaceBindings: [workspaceBinding], providerRequestId: id, responseConstraint: 'normal' });
    assertRuntimeContract('ProviderRequest', value.request);
    assertRuntimeContract('ContextCompositionReceipt', value.receipt);
    return value;
  };
  const first = await build('request:first');
  assert.deepEqual(fileRefs(first.request), [logicalPdf]);
  assert.equal(first.request.messages.find(message => message.files)?.role, 'user');
  assert.equal(first.request.messages.flatMap(message => message.images ?? []).length, 1);
  assert.ok(first.receipt.modelView.additions.every(contribution => !contribution.message.files));
  append('context.composed', first.receipt);
  append('message.committed', { role: 'assistant', messageId: 'final:first', content: 'Initial comparison complete.', providerRequestId: 'request:first' });
  append('provider.turn.settled', { providerRequestId: 'request:first', purpose: 'agent', outcome: 'completed', orderedCallIds: [],
    narrativeIds: [], finalMessageId: 'final:first' });
  const second = await build('request:second');
  assert.deepEqual(fileRefs(second.request), [logicalPdf], 'success does not consume a task document');
  assert.deepEqual(second.request.messages.flatMap(message => message.images ?? []), [], 'existing image lifetime remains unchanged');
  const noFiles = structuredClone(runtime); delete noFiles.provider.fileInputMediaTypes;
  assert.deepEqual(fileRefs((await build('request:no-native-files', runId, noFiles)).request), [], 'omitted capability means no native file transport');
  const coveredThroughSequence = events.at(-1).sequence;
  const nextRunId = 'run:pdf-followup', nextRuntime = pdfRuntime(nextRunId);
  append('message.committed', { role: 'user', messageId: 'message:followup', content: 'Explain the prior result.' }, { runId: undefined });
  append('run.started', { inputMessageId: 'message:followup', workspaceBindings: [workspaceBinding], runtimeSnapshot: nextRuntime }, { runId: nextRunId });
  assert.deepEqual(fileRefs((await build('request:followup', nextRunId, nextRuntime)).request), [logicalPdf]);
  append('context.compacted', { compactionId: 'compaction:pdf', coveredThroughSequence, summary: 'The prior PDF comparison is summarized.' }, { runId: nextRunId });
  assert.deepEqual(fileRefs((await build('request:compacted', nextRunId, nextRuntime)).request), []);
  assert.deepEqual(events[1].payload.filesystemReferences[0], pdf, 'compaction does not delete the original attachment fact');
  assert.doesNotMatch(JSON.stringify(events), /file_data|file_id|base64/);
});

test('queued PDF input uses the running capability snapshot and enters the next Provider request on its own user message', async t => {
  const sessionId = 'session:queued-pdf', journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const requests = [];
  const preparation = fakeRunPreparation({ contextWindowTokens: 32768, tools: [{ toolBindingRef: 'binding:read', name: 'fs.read',
    description: 'Read source.', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin' }] });
  const port = { ...preparation.port, async prepare(input) {
    const result = await preparation.port.prepare(input);
    result.runtimeSnapshot.provider.fileInputMediaTypes = ['application/pdf'];
    return result;
  } };
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      entered(); await gate;
      yield providerEvent(request.requestId, 'tool.call', { callId: 'call:source', name: 'fs_read', input: { workspace: 'primary', path: 'source.txt' } });
    } else yield providerEvent(request.requestId, 'text.delta', { text: 'The document input is attached.' });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute(request) { return completedExecutionReply(request, { content: 'Source.' }); } }), port, 'queued-pdf');
  t.after(async () => { release(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:first', 'Read the source.'));
  await started;
  const before = await actor.snapshot();
  assert.deepEqual(before.run.fileInputMediaTypes, ['application/pdf']);
  before.run.fileInputMediaTypes.length = 0;
  assert.deepEqual((await actor.snapshot()).run.fileInputMediaTypes, ['application/pdf'], 'UI projections cannot mutate the frozen capability');
  const queued = await actor.submit({ ...messageCommand(sessionId, 'command:pdf', 'Also inspect this PDF.'),
    runId: before.run.runId, filesystemReferences: [pdf] });
  assert.equal(queued.status, 'accepted');
  release();
  const finished = await waitForProjection(actor, snapshot => snapshot.run?.status === 'completed');
  assert.deepEqual(finished.run.fileInputMediaTypes, ['application/pdf']);
  assert.deepEqual(fileRefs(requests[0]), []);
  assert.deepEqual(fileRefs(requests[1]), [logicalPdf]);
  assert.match(requests[1].messages.find(message => message.files)?.content, /Also inspect this PDF/);
  const events = await readEvents(journal, sessionId);
  assert.ok(events.some(event => event.type === 'input.queued' && event.payload.filesystemReferences?.[0].referenceId === pdf.referenceId));
  assert.doesNotMatch(JSON.stringify(events), /file_data|file_id|base64/);
});

test('native file protocol declares PDF capability explicitly and rejects binary or provider-owned file identities', () => {
  const parameters = { adapterId: 'openai', kind: 'openaiCompatible', providerFlavor: 'openai', contextWindowTokens: 32768,
    maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null };
  assert.deepEqual(decodeAgentModelParameters(parameters).fileInputMediaTypes, []);
  assert.deepEqual(decodeAgentModelParameters({ ...parameters, fileInputMediaTypes: ['application/pdf'] }).fileInputMediaTypes, ['application/pdf']);
  for (const extra of [{ fileInputMediaTypes: 'application/pdf' }, { fileInputMediaTypes: ['application/pdf', 'application/pdf'] },
    { fileInputMediaTypes: ['text/plain'] }, { kind: 'responses', fileInputMediaTypes: ['application/pdf'] }]) {
    assert.throws(() => decodeAgentModelParameters({ ...parameters, ...extra }), /agent_model_parameters_invalid/);
  }
  const message = { role: 'user', content: 'Read the file.', files: [logicalPdf] };
  assertRuntimeContract('ModelMessage', message);
  assert.throws(() => assertRuntimeContract('ModelMessage', { ...message, role: 'system' }));
  assert.throws(() => assertRuntimeContract('ModelMessage', { ...message, files: [{ ...logicalPdf, file_data: 'data:application/pdf;base64,eA==' }] }));
  assert.throws(() => assertRuntimeContract('ModelMessage', { ...message, files: [{ ...logicalPdf, file_id: 'upstream-id' }] }));
  const runtime = pdfRuntime('run:contract');
  assertRuntimeContract('ProviderRuntimeSnapshot', runtime.provider);
  assert.throws(() => assertRuntimeContract('ProviderRuntimeSnapshot', { ...runtime.provider, apiSurface: 'responses' }));
  const clone = cloneModelMessage(message);
  clone.files[0].displayName = 'Other.pdf';
  assert.equal(message.files[0].displayName, 'report.pdf');
});
