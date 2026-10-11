import assert from 'node:assert/strict';
import { PERMISSION_DEFAULTS } from '../../protocol/dist/index.js';
import { SessionActor, sessionControlToolDefinitions } from '../dist/index.js';
import { assertRuntimeContract } from './support/runtimeContract.mjs';

export const workspaceBinding = {
  workspaceId: 'workspace:test',
  displayName: 'Fixture workspace',
};

export function actorWith(
  journal,
  sessionId,
  provider,
  kernel,
  runPreparation,
  idPrefix,
  onDispose = () => {},
) {
  return new SessionActor(
    sessionId,
    journal,
    {
      provider: {
        async *stream(request, signal) {
          assertRuntimeContract('ProviderRequest', request);
          yield* provider.stream(request, signal);
        },
      },
      kernel,
      runPreparation,
      async dispose() { onDispose(); },
    },
    { nextId: idFactory(idPrefix) },
  );
}

export function fakeRunPreparation(options = {}) {
  const prepared = [];
  const retired = [];
  const released = [];
  const snapshots = [];
  return {
    prepared,
    retired,
    released,
    snapshots,
    port: {
      async retireToolViews(request) {
        retired.push(structuredClone(request));
      },
      async prepare(request) {
        prepared.push(structuredClone(request));
        const snapshot = runtimeSnapshot(request.runId, {
          environment: options.environment,
          permissions: options.permissions,
          profileId: request.profileId ?? options.profileId ?? 'profile:default',
          contextWindowTokens: options.contextWindowTokens,
          maxOutputTokens: options.maxOutputTokens,
          apiSurface: options.apiSurface,
          hostedWebSearch: options.hostedWebSearch,
          webSearch: options.webSearch,
          tools: options.tools,
          toolPromptContributions: options.toolPromptContributions,
          reasoningEffort: request.reasoningEffortOverride ?? options.reasoningEffort,
          reasoningEffortOverride: request.reasoningEffortOverride,
        });
        snapshot.selectedPlugins.plugins = (request.pluginSelections ?? []).map(selection => ({
          uri: selection.uri, pluginArtifactRef: `artifact:${selection.uri}`,
          pluginInstanceRef: `instance:${selection.uri}`, extensionGenerationRef: snapshot.extensionGenerationRef,
          capabilityRefs: [],
        }));
        snapshots.push(structuredClone(snapshot));
        return { runtimeSnapshot: snapshot };
      },
      async release(request) {
        released.push(structuredClone(request));
        return {
          kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
          alreadyReleased: false,
        };
      },
    },
  };
}

export function runtimeSnapshot(runId, options = {}) {
  const tools = (options.tools ?? []).map((tool) => structuredClone(tool));
  const provider = {
    providerRuntimeRef: 'provider-runtime:g1',
    profileId: options.profileId ?? 'profile:default',
    contextWindowTokens: options.contextWindowTokens ?? 4_096,
    maxOutputTokens: options.maxOutputTokens ?? 512,
    apiSurface: options.apiSurface ?? 'chatCompletions',
    hostedWebSearch: options.hostedWebSearch ?? 'none',
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.reasoningEffortOverride ? { reasoningEffortOverride: options.reasoningEffortOverride } : {}),
  };
  const webSearch = options.webSearch ?? (
    tools.some((tool) => tool.name === 'web.search' && tool.availability === 'callable')
      ? { owner: 'kernelAdapter', toolName: 'web.search' }
      : { owner: 'unavailable' }
  );
  const providerToolAliases = [
    ...tools.filter((tool) => tool.availability === 'callable').map((tool) => tool.name),
    ...sessionControlToolDefinitions().map((tool) => tool.name),
  ]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((canonicalName) => ({
      canonicalName,
      wireName: canonicalName.replace(/[.-]/gu, '_'),
    }));
  return {
    runRuntimeSnapshotRef: `runtime-snapshot:${runId}`,
    permissions: { ...PERMISSION_DEFAULTS, ...options.permissions },
    extensionGenerationRef: 'extension-generation:g1',
    kernelCatalogSnapshotRef: `kernel-catalog:${runId}`,
    provider,
    environment: structuredClone(options.environment ?? {
      os: 'fixture', arch: 'fixture', locale: null, responseLanguage: null, userShell: null,
      executionTarget: { kind: 'native' }, shell: { tool: 'bash', executable: 'bash', dialect: 'bash' },
      executionPath: 'fixture-bin', shellAvailable: true, workspaceShellSupported: true, developerCommands: [],
    }),
    webSearch,
    instructions: [{ id: 'deepcode.coding-agent', text: 'Stable core instruction.' }],
    tools,
    toolPromptContributions: (options.toolPromptContributions ?? [])
      .map((contribution) => structuredClone(contribution)),
    providerToolAliases,
    selectedPlugins: {
      catalogRevision: 'plugin-catalog:fixture',
      plugins: [],
    },
  };
}

export function emptyKernel(overrides = {}) {
  return {
    async prepareCatalog() { throw new Error('unexpected_prepare_catalog'); },
    async releaseCatalog() { throw new Error('unexpected_release_catalog'); },
    async execute() { throw new Error('unexpected_tool_execution'); },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
    async readProcesses() { throw new Error('unexpected_process_read'); },
    ...overrides,
  };
}

export function completedExecutionReply(request, output) {
  return {
    schemaVersion: 'deepcode.kernel-reply',
    type: 'tool.execution',
    requestId: request.requestId,
    callId: request.callId,
    status: 'completed',
    record: {
      recordId: `record:${request.callId}`,
      sessionId: request.sessionId,
      runId: request.runId,
      extensionGenerationRef: request.extensionGenerationRef,
      kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
      toolBindingRef: request.toolBindingRef,
      callId: request.callId,
      attemptId: request.attemptId,
      toolName: request.toolName,
      input: structuredClone(request.input),
      preparedEffect: {
        callId: request.callId,
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        runId: request.runId,
        extensionGenerationRef: request.extensionGenerationRef,
        kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
        toolBindingRef: request.toolBindingRef,
        contributionRef: 'contribution:fixture',
        providerRef: 'provider:fixture',
        origin: 'coreBuiltin',
        toolName: request.toolName,
        workspaceId: request.input.workspaceId,
        operation: request.toolName,
        logicalTargets: typeof request.input.path === 'string' ? [request.input.path]
          : typeof request.input.url === 'string' ? [request.input.url] : [],
        canonicalInvocation: {
          toolName: request.toolName,
          arguments: structuredClone(request.input),
        },
      },
      authority: request.planAuthorities?.length
        ? {
            decision: 'allow',
            source: 'plan',
            workspaceId: request.input.workspaceId,
            authorityId: request.planAuthorities[0].authorityId,
            planId: request.planAuthorities[0].planId,
            revision: request.planAuthorities[0].revision,
            decisionId: request.planAuthorities[0].decisionId,
          }
        : {
            decision: 'allow',
            source: 'workspaceBinding',
            workspaceId: request.input.workspaceId,
          },
      startedAt: '2026-08-30T00:00:00.000Z',
      completedAt: '2026-08-30T00:00:01.000Z',
      outcome: 'completed',
      output,
    },
  };
}

export function failedExecutionReply(request, output, error) {
  const reply = completedExecutionReply(request, output);
  reply.status = 'failed';
  reply.record.outcome = 'failed';
  reply.record.error = structuredClone(error);
  return reply;
}

export function indeterminateExecutionRecord(request) {
  const record = completedExecutionReply(request, {}).record;
  delete record.output;
  record.outcome = 'indeterminate';
  record.error = {
    code: 'tool_effect_outcome_unknown',
    message: 'Fixture execution crossed the effect boundary before cancellation.',
  };
  return record;
}

export function cancelNotFound(callId, attemptId) {
  return {
    schemaVersion: 'deepcode.kernel-reply',
    type: 'tool.cancelled',
    requestId: 'kernel-cancel:fixture',
    callId,
    attemptId,
    status: 'notFound',
  };
}

export function* todoUpdateEvents(request, status = 'completed', native = false) {
  const tool = request.tools.find((candidate) => candidate.name === 'todo_update');
  const payloads = request.messages.map(jsonMessagePayload);
  const todo = payloads.findLast((payload) => payload?.type === 'todo.current');
  assert.ok(tool && todo, 'progress uses the control and current Todo without execution evidence');
  const callId = `provider-call:progress:${request.requestId}`;
  const input = { items: todo.items.map((item) => ({ text: item.text, status })) };
  yield native
    ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
      item: { type: 'function_call', call_id: callId, name: tool.name, arguments: JSON.stringify(input), status: 'completed' } })
    : providerEvent(request.requestId, 'tool.call', { callId, name: tool.name, input });
  yield providerEvent(request.requestId, 'completed', {});
}

export function providerEvent(requestId, type, data) {
  return {
    schemaVersion: 'deepcode.provider-event',
    requestId,
    type,
    data,
  };
}

export function messageCommand(sessionId, commandId, text, profileId) {
  return {
    schemaVersion: 'deepcode.command.v3',
    type: 'message.submit',
    commandId,
    sessionId,
    text,
    ...(profileId ? { profileId } : {}),
  };
}

export function jsonMessagePayload(message) {
  if (typeof message.content !== 'string') return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

export function forwardingJournal(delegate, read) {
  return {
    createSession: (input) => delegate.createSession(input),
    deleteSession: (sessionId) => delegate.deleteSession(sessionId),
    append: (event) => delegate.append(event),
    appendBatch: (events) => delegate.appendBatch(events),
    read,
    readCommand: (sessionId, commandId) => delegate.readCommand(sessionId, commandId),
    commitCommand: (command, events, reply) => delegate.commitCommand(command, events, reply),
  };
}

export async function createSession(journal, sessionId, workspaceBindings = []) {
  await journal.createSession({
    sessionId,
    displayTitle: 'Fixture session',
    workspaceBindings,
  });
}

export async function readEvents(journal, sessionId) {
  const events = [];
  for await (const event of journal.read(sessionId)) events.push(event);
  return events;
}

export function singleEvent(events, type) {
  const matches = events.filter((event) => event.type === type);
  assert.equal(matches.length, 1, `expected exactly one ${type} event`);
  return matches[0];
}

export function assertEventOrder(...events) {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(
      events[index - 1].sequence < events[index].sequence,
      `${events[index - 1].type} must precede ${events[index].type}`,
    );
  }
}

export function assertSuccessfulCompactionOrder(events, request, expectedSummary) {
  const composition = events.find((event) => (
    event.type === 'context.composed'
    && event.payload.providerRequestId === request.payload.providerRequestId
  ));
  const completion = events.find((event) => (
    event.type === 'provider.turn.settled'
    && event.payload.providerRequestId === request.payload.providerRequestId
  ));
  const checkpoint = events.find((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === request.payload.compactionId
  ));
  assert.ok(composition, 'compaction composition must be durable');
  assert.ok(completion, 'successful summary Provider turn must be durable');
  assert.ok(checkpoint, 'successful summary must create a checkpoint');
  assert.equal(completion.payload.purpose, 'contextCompaction');
  assert.deepEqual(completion.payload.orderedCallIds, []);
  assert.equal(checkpoint.payload.summary, expectedSummary);
  assertEventOrder(request, composition, completion, checkpoint);
}

export function idFactory(prefix) {
  let next = 0;
  return (kind) => `${prefix}:${kind}:${++next}`;
}

export async function waitForProjection(actor, predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await actor.snapshot();
    assertRuntimeContract('SessionProjection', projection);
    if (predicate(projection)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for Session projection: ${JSON.stringify(await actor.snapshot())}`);
}

export async function waitUntil(predicate, label) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

export async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
