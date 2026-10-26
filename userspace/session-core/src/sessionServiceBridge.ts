import { SessionNotifications } from './sessionNotifications.js';
import type { SessionObservationSink } from './local-agent/observation.js';
import { LoopFailure } from './local-agent/loopFailure.js';
import { decodeAgentContext, decodeAgentSettings, isLlmReasoningEffort } from '@achbit/protocol';
import { isShellAuthorizationScope } from '@achbit/protocol';
import { stableCoreInstructions } from './local-agent/coreInstructions.js';
import type { ConversationCommand, CommandJournalPort } from '@achbit/protocol';
import { responseFrames } from './responseFrames.js';
import {
  CONVERSATION_COMMAND_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
  validatePermissionPatches,
} from '@achbit/protocol';
import {
  HttpCommandJournal,
  HttpAgentHostPort,
  HttpKernelPort,
  HttpProviderPort,
  HttpRunPreparationPort,
} from './local-agent/httpPorts.js';
import { decodeAgentRecipe } from '@achbit/protocol';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSessionService, SessionDeletionError, type SessionServiceFactory, type SessionServicePort } from './local-agent/service.js';

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: {
    write(value: string, callback?: (error?: Error | null) => void): boolean;
  };
  stderr: { write(value: string): boolean };
};

const MAX_REQUEST_BYTES = 1024 * 1024;

type BridgeRequest = {
  protocolVersion: typeof LOCAL_AGENT_PROTOCOL_VERSION;
  requestId: string;
  operation: string;
  data: Record<string, unknown>;
};

export interface BridgeExtension {
  observation?: SessionObservationSink;
  operations: readonly string[];
  dispatch(service: SessionServicePort, operation: string, data: Record<string, unknown>, journal: CommandJournalPort): Promise<unknown>;
  dispose(): void;
}
export async function startSessionServiceBridge(extensionFactory?: (send: (value: unknown) => Promise<void>) => BridgeExtension): Promise<void> {
  const extension = extensionFactory?.(writeFrame);
  const notifications = new SessionNotifications(writeFrame);
  const observers = [notifications, ...(extension?.observation ? [extension.observation] : [])];
  const observation: SessionObservationSink = {
    accept(input) {
      for (const observer of observers) {
        try { observer.accept(input); }
        catch (error) { try { observer.failed(input.sessionId, error); } catch { /* Observers never own execution. */ } }
      }
    },
    failed(sessionId, error) {
      for (const observer of observers) { try { observer.failed(sessionId, error); } catch { /* Preserve producer isolation. */ } }
    },
  };
  const apiBase = requiredEnvironment('DEEPCODE_LOCAL_AGENT_API_BASE');
  const serviceToken = requiredEnvironment('DEEPCODE_LOCAL_AGENT_TOKEN');
  const journal = new HttpCommandJournal({ apiBase, serviceToken });
  const kernel = new HttpKernelPort({ apiBase, serviceToken });
  const provider = new HttpProviderPort({ apiBase, serviceToken });
  const runPreparation = new HttpRunPreparationPort({
    apiBase,
    serviceToken,
    stableCoreInstructions,
  });
  const factory = await loadSessionServiceFactory();
  const candidate: unknown = await factory({
    journal,
    observation,
    agentHost: new HttpAgentHostPort({ apiBase, serviceToken }),
    compositions: {
      create: async () => ({
        composition: { provider, kernel, runPreparation, async dispose() {} },
      }),
    },
  });
  let service: SessionServicePort;
  try {
    assertSessionServicePort(candidate);
    service = candidate;
  } catch (error) {
    if (isRecord(candidate) && typeof candidate.dispose === 'function') {
      try {
        await candidate.dispose();
      } catch (disposeError) {
        throw new AggregateError([error, disposeError], 'session_service_port_initialization_failed');
      }
    }
    throw error;
  }

  let shutdownRequest: BridgeRequest | undefined;
  const pending = new Set<Promise<void>>();
  try {
    for await (const line of readLines()) {
      const request = decodeRequest(line, extension?.operations);
      if (request.operation === 'shutdown') {
        shutdownRequest = request;
        break;
      }
      const task = (async () => {
        try {
          const data = extension?.operations.includes(request.operation)
            ? await extension.dispatch(service, request.operation, request.data, journal) : await dispatch(service, request);
          await writeFrame({
            protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
            requestId: request.requestId, ok: true, data,
          });
        } catch (error) {
          await writeFrame({
            protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
            requestId: request.requestId, ok: false, error: bridgeError(error),
          });
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => undefined);
    }
  } finally {
    extension?.dispose();
    await Promise.allSettled(pending);
    await service.dispose();
    await notifications.close();
    await outputTail;
  }
  if (!shutdownRequest) throw new Error('session_service_input_closed');
  await writeFrame({
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    requestId: shutdownRequest.requestId, ok: true, data: { stopped: true },
  });
}

async function dispatch(
  service: SessionServicePort,
  request: BridgeRequest,
): Promise<unknown> {
  switch (request.operation) {
    case 'activity':
      return await service.activity();
    case 'health':
      return { state: 'ready' };
    case 'createSession':
      return await service.createSession({
        sessionId: requiredString(request.data, 'sessionId'),
        displayTitle: requiredString(request.data, 'displayTitle'),
        workspaceBindings: decodeWorkspaceBindings(request.data.workspaceBindings),
        ...(request.data.subagentSettings !== undefined ? { subagentSettings: decodeAgentSettings(request.data.subagentSettings) } : {}),
        ...(request.data.recipe !== undefined ? { recipe: decodeAgentRecipe(request.data.recipe) } : {}),
        ...(request.data.agentContext ? { agentContext: decodeAgentContext(request.data.agentContext) } : {}),
        ...(optionalString(request.data, 'profileId')
          ? { profileId: optionalString(request.data, 'profileId') }
          : {}),
      });
    case 'deleteSession': {
      const { unstartedOnly } = request.data;
      if (unstartedOnly !== undefined && typeof unstartedOnly !== 'boolean') throw new Error('session_delete_options_invalid');
      return { deleted: true, ...await service.deleteSession(requiredString(request.data, 'sessionId'),
        unstartedOnly === undefined ? undefined : { unstartedOnly }) };
    }
    case 'submit': {
      return await service.submit(decodeCommand(request.data.command));
    }
    case 'snapshot':
      return await service.snapshot(requiredString(request.data, 'sessionId'));
    case 'resourceSnapshot': {
      const recordIds = request.data.recordIds ?? [];
      if (!Array.isArray(recordIds) || !recordIds.every(validId)) throw new Error('session_resource_query_invalid');
      return await service.resourceSnapshot(requiredString(request.data, 'sessionId'), recordIds);
    }
    case 'statuses': {
      const { sessionIds } = request.data;
      if (!Array.isArray(sessionIds) || !sessionIds.every(validId)) {
        throw new Error('conversation_status_query_invalid');
      }
      return await service.statuses(sessionIds);
    }
    case 'read':
      return await service.read(request.data);
    case 'contextComposition':
      return await service.contextComposition(
        requiredString(request.data, 'sessionId'), requiredString(request.data, 'providerRequestId'),
      );
    case 'shutdown':
      return { stopped: true };
    default: throw new Error('session_service_operation_invalid');
  }
}

async function loadSessionServiceFactory(): Promise<SessionServiceFactory> {
  const modulePath = process.env.DEEPCODE_SESSION_SERVICE_MODULE;
  if (modulePath === undefined) return createSessionService;
  if (!isAbsolute(modulePath)) throw new Error('session_service_module_path_invalid');
  const module: unknown = await import(pathToFileURL(modulePath).href);
  if (!isRecord(module) || typeof module.createSessionService !== 'function') {
    throw new Error('session_service_factory_missing');
  }
  return module.createSessionService as SessionServiceFactory;
}

/** Validate the loaded implementation once, before announcing readiness. */
function assertSessionServicePort(value: unknown): asserts value is SessionServicePort {
  if (!isRecord(value)) throw new Error('session_service_port_invalid:object');
  const methods = [
    'createSession', 'deleteSession', 'submit', 'snapshot', 'resourceSnapshot', 'statuses', 'activity',
    'contextComposition', 'read', 'replaceCapabilities', 'dispose',
  ] as const satisfies readonly (keyof SessionServicePort)[];
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new Error(`session_service_port_invalid:${method}`);
  }
}

function decodeCommand(value: unknown): ConversationCommand {
  if (
    !isRecord(value)
    || value.schemaVersion !== CONVERSATION_COMMAND_VERSION
    || !validId(value.commandId)
    || !validId(value.sessionId)
  ) throw new Error('conversation_command_invalid');
  switch (value.type) {
    case 'session.permissions.set':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'patches'])) throw new Error('conversation_command_invalid');
      validatePermissionPatches(value.patches);
      return value as unknown as ConversationCommand;
    case 'approval.revoke':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'authorityId'])
        || !validId(value.runId) || !validId(value.authorityId)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'session.subagent-settings.set':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'settings'])) throw new Error('conversation_command_invalid');
      return { ...value, settings: decodeAgentSettings(value.settings) } as unknown as ConversationCommand;
    case 'session.model-settings.set':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'settings'])
        || !isRecord(value.settings)
        || !hasExactKeys(value.settings, ['profileId', 'reasoningEffortOverride'])
        || !validId(value.settings.profileId)
        || !validReasoningOverride(value.settings.reasoningEffortOverride)) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'session.workspaces.set':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'workspaceBindings'])) throw new Error('conversation_command_invalid');
      return { ...value, workspaceBindings: decodeWorkspaceBindings(value.workspaceBindings) } as unknown as ConversationCommand;
    case 'session.directory-index.attach':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'workspaceBinding',
        ])
        || !isWorkspaceBinding(value.workspaceBinding)
      ) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'session.directory-index.detach':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'workspaceId',
        ])
        || !validId(value.workspaceId)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.submit':
      if (
        !hasExactKeys(
          value,
          ['schemaVersion', 'type', 'commandId', 'sessionId', 'text'],
          [
            'runId', 'filesystemReferences', 'profileId', 'reasoningEffortOverride', 'pluginCatalogRevision', 'pluginSelections', 'guidanceReferences', 'hostBinding',
          ],
        )
        || (value.runId !== undefined && !validId(value.runId))
        || typeof value.text !== 'string'
        || (value.filesystemReferences !== undefined
          && !isFilesystemReferenceArray(value.filesystemReferences))
        || (value.profileId !== undefined && !validId(value.profileId))
        || (value.reasoningEffortOverride !== undefined && !validReasoningOverride(value.reasoningEffortOverride))
        || !validPluginSelections(value.pluginCatalogRevision, value.pluginSelections)
        || !validGuidanceReferences(value.guidanceReferences)
        || !validHostBinding(value.hostBinding)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'context.focus':
      if (
        !hasExactKeys(
          value,
          ['schemaVersion', 'type', 'commandId', 'sessionId', 'task'],
          [
            'filesystemReferences', 'profileId', 'reasoningEffortOverride', 'pluginCatalogRevision', 'pluginSelections', 'guidanceReferences', 'hostBinding',
          ],
        )
        || typeof value.task !== 'string'
        || !value.task.trim()
        || (value.filesystemReferences !== undefined
          && !isFilesystemReferenceArray(value.filesystemReferences))
        || (value.profileId !== undefined && !validId(value.profileId))
        || (value.reasoningEffortOverride !== undefined && !validReasoningOverride(value.reasoningEffortOverride))
        || !validPluginSelections(value.pluginCatalogRevision, value.pluginSelections)
        || !validGuidanceReferences(value.guidanceReferences)
        || !validHostBinding(value.hostBinding)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.edit':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'messageId', 'expectedRevision', 'text'], ['hostBinding'])
        || !validId(value.messageId) || !positiveInteger(value.expectedRevision)
        || typeof value.text !== 'string' || !validHostBinding(value.hostBinding)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.feedback.set':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'messageId', 'feedback',
        ])
        || !validId(value.messageId)
        || value.feedback !== null && value.feedback !== 'up' && value.feedback !== 'down'
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'run.host.rebind':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'expectedHostBinding', 'hostBinding'])
        || !validId(value.runId) || !value.expectedHostBinding || !value.hostBinding
        || !validHostBinding(value.expectedHostBinding) || !validHostBinding(value.hostBinding)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'tool.cancel':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'callId'])
        || !validId(value.runId) || !validId(value.callId)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'run.cancel':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId',
        ])
        || !validId(value.runId)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'interaction.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'interactionId', 'response',
        ])
        || !validId(value.runId)
        || !validId(value.interactionId)
        || typeof value.response !== 'string'
        || !value.response.trim()
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'approval.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'callId', 'approvalId',
          'decision',
        ], ['authorizationScope'])
        || !validId(value.runId)
        || !validId(value.callId)
        || !validId(value.approvalId)
        || value.decision !== 'allow' && value.decision !== 'deny'
        || value.authorizationScope !== undefined
          && (!isShellAuthorizationScope(value.authorizationScope) || value.decision !== 'allow')
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'plan.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'planId', 'revision',
          'response',
        ])
        || !validId(value.runId)
        || !validId(value.planId)
        || !positiveInteger(value.revision)
        || !decodePlanResponse(value.response)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    default:
      throw new Error('conversation_command_invalid');
  }
}

function validReasoningOverride(value: unknown): boolean {
  return value === null || isLlmReasoningEffort(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isWorkspaceBinding(value: unknown): value is {
  workspaceId: string;
  displayName: string;
} {
  return isRecord(value)
    && Object.keys(value).every((key) => ['workspaceId', 'displayName'].includes(key))
    && validId(value.workspaceId)
    && typeof value.displayName === 'string'
    && Boolean(value.displayName.trim())
    && value.displayName.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(value.displayName);
}

function isFilesystemReferenceArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  const referenceIds = new Set<string>();
  const targets = new Set<string>();
  return value.every((reference) => {
    if (!isRecord(reference)) return false;
    const commonKeys = ['referenceId', 'workspaceId', 'logicalPath', 'displayName', 'kind'];
    const allowedKeys = reference.kind === 'file'
      ? [...commonKeys, 'mediaType', 'byteLength']
      : commonKeys;
    if (
      !hasExactKeys(reference, allowedKeys, reference.kind === 'file' ? ['source'] : [])
      || (reference.source !== undefined && reference.source !== 'pastedText')
      || !validId(reference.referenceId)
      || referenceIds.has(reference.referenceId)
      || !isWorkspaceBinding({
        workspaceId: reference.workspaceId,
        displayName: reference.displayName,
      })
      || typeof reference.logicalPath !== 'string'
      || !validLogicalPath(reference.logicalPath)
    ) return false;
    const target = `${reference.workspaceId}\0${reference.logicalPath}`;
    if (targets.has(target)) return false;
    if (reference.kind === 'file') {
      if (
        reference.logicalPath === '.'
        || typeof reference.mediaType !== 'string'
        || !reference.mediaType.trim()
        || reference.mediaType.length > 128
        || typeof reference.byteLength !== 'number'
        || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0
      ) return false;
    } else if (reference.kind !== 'directory' || reference.logicalPath !== '.') {
      return false;
    }
    referenceIds.add(reference.referenceId);
    targets.add(target);
    return true;
  });
}

function validLogicalPath(value: string): boolean {
  if (!value || value.length > 4_096 || value.includes('\0') || value.includes('\\')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validHostBinding(value:unknown):boolean {
  return value===undefined || isRecord(value) && hasExactKeys(value,['hostInstanceId','windowLabel'])
    && validId(value.hostInstanceId) && validId(value.windowLabel);
}

function validGuidanceReferences(value:unknown):boolean {
  return value===undefined || Array.isArray(value) && value.length<=16 && value.every((reference)=>
    isRecord(reference) && hasExactKeys(reference,['referenceId','uri','label','toolName','name'])
    && ['referenceId','uri','label','name'].every((key)=>typeof reference[key]==='string' && Boolean(reference[key]))
    && ['skill.read','doc.read'].includes(String(reference.toolName)));
}

function validPluginSelections(revision: unknown, value: unknown): boolean {
  if (value === undefined) return revision === undefined || validId(revision);
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return revision === undefined || validId(revision);
  if (!validId(revision)) return false;
  const selectionIds = new Set<string>();
  const uris = new Set<string>();
  return value.every((selection) => {
    if (
      !isRecord(selection)
      || Object.keys(selection).some((key) => !['selectionId', 'uri', 'label'].includes(key))
      || !validId(selection.selectionId)
      || typeof selection.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(selection.uri)
      || typeof selection.label !== 'string'
      || !selection.label.trim()
      || selection.label.length > 160
      || selectionIds.has(selection.selectionId)
      || uris.has(selection.uri)
    ) return false;
    selectionIds.add(selection.selectionId);
    uris.add(selection.uri);
    return true;
  });
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeRequest(encoded: string, extensionOperations: readonly string[] = []): BridgeRequest {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('session_service_request_json_invalid');
  }
  if (
    !isRecord(value)
    || value.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !value.requestId
    || !['health', 'activity', 'createSession', 'deleteSession', 'submit', 'snapshot', 'resourceSnapshot', 'statuses', 'contextComposition', 'read', 'shutdown', ...extensionOperations].includes(String(value.operation))
    || !isRecord(value.data)
  ) {
    throw new Error('session_service_request_invalid');
  }
  return value as BridgeRequest;
}

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = chunkBytes(chunk);
    bytes += value.byteLength;
    buffered += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const raw = buffered.slice(0, newline);
      const line = raw.replace(/\r$/u, '');
      if (new TextEncoder().encode(line).byteLength > MAX_REQUEST_BYTES) throw new Error('session_service_request_too_large');
      buffered = buffered.slice(newline + 1);
      bytes -= new TextEncoder().encode(raw).byteLength + 1;
      if (!line) throw new Error('session_service_request_empty');
      yield line;
    }
    // One optional CR may precede the next LF; incomplete UTF-8 bytes still count.
    if (bytes > MAX_REQUEST_BYTES + (buffered.endsWith('\r') ? 1 : 0)) throw new Error('session_service_request_too_large');
  }
  buffered += decoder.decode();
  if (buffered) throw new Error('session_service_request_unterminated');
}

function chunkBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new Error('session_service_input_invalid');
}

let outputTail = Promise.resolve();

function writeFrame(value: unknown): Promise<void> {
  // Serialize the entire logical response in the output queue, including all chunks.
  const next = outputTail.then(async () => {
    for (const frame of responseFrames(value)) await writeLine(frame);
  });
  outputTail = next;
  return next;
}

function writeLine(encoded: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${encoded}\n`, (error) => error ? reject(error) : resolve());
  });
}

function bridgeError(error: unknown): { code: string; message: string; details?: SessionDeletionError['details'] } {
  const message = error instanceof Error ? error.message : String(error);
  const [candidate] = message.split(':', 1);
  const code = error instanceof LoopFailure ? error.code
    : candidate && /^[a-z][a-z0-9_.-]{0,127}$/u.test(candidate) ? candidate : 'session_service_failed';
  return { code, message, ...(error instanceof SessionDeletionError ? { details: error.details } : {}) };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`session_service_environment_missing:${name}`);
  delete process.env[name];
  return value;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate) {
    throw new Error(`session_service_field_invalid:${field}`);
  }
  return candidate;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error(`session_service_field_invalid:${field}`);
  }
  return candidate;
}

function decodeWorkspaceBindings(value: unknown): Array<{
  workspaceId: string;
  displayName: string;
}> {
  if (!Array.isArray(value)) throw new Error('session_service_field_invalid:workspaceBindings');
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).some((key) => !['workspaceId', 'displayName'].includes(key))
      || !validId(candidate.workspaceId)
      || typeof candidate.displayName !== 'string'
      || !candidate.displayName.trim()
      || seen.has(candidate.workspaceId)
    ) throw new Error('session_service_field_invalid:workspaceBindings');
    seen.add(candidate.workspaceId);
    return { workspaceId: candidate.workspaceId, displayName: candidate.displayName };
  });
}

function decodePlanResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'confirm' || value.kind === 'cancel') {
    return Object.keys(value).length === 1;
  }
  if (value.kind === 'requestRevision') {
    return Object.keys(value).length === 2
      && typeof value.text === 'string'
      && Boolean(value.text.trim());
  }
  return false;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function reportBridgeFailure(error: unknown): void {
  process.exitCode = 1;
  const diagnostic = {
    ...bridgeError(error),
    ...(error instanceof AggregateError ? { causes: error.errors.map(bridgeError) } : {}),
  };
  process.stderr.write(`[session-service] ${JSON.stringify(diagnostic)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startSessionServiceBridge().catch(reportBridgeFailure);
}
