import { isLlmReasoningEffort } from '@deepcode/protocol';
import { isProcessActivity } from '@deepcode/protocol';
import { isShellAuthorizationScope } from '@deepcode/protocol';
import { validatePermissionPatches } from '@deepcode/protocol';
import { isLocalAgentErrorValue } from '@deepcode/protocol';
import { decodeAgentContext } from '@deepcode/protocol';
import type {
  AssistantDraftBlockProjection,
  CommandReply,
  ConversationCatalog,
  ConversationCatalogManagement,
  ConversationCommand,
  ConversationSessionStatus,
  ContextCompositionMessageBlock,
  ContextCompositionTool,
  FilesystemReference,
  PluginCatalogProjection,
  SessionProjection,
} from '@deepcode/protocol';
import {
  COMMAND_REPLY_VERSION,
  RUN_PROJECTION_STATUSES,
  SESSION_PROJECTION_VERSION,
} from '@deepcode/protocol';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';
import { isShellActivityResult } from './shellActivityCodec';

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T | null;
  error?: string | null;
  message?: string | null;
}

const API_BASE = getKernelApiBase();

const CONTEXT_TOOL_ORIGINS: Readonly<Record<ContextCompositionTool['origin'], true>> = {
  coreBuiltin: true,
  extension: true,
  sessionControl: true,
  providerHosted: true,
};

const CONTEXT_MESSAGE_BLOCK_KINDS: Readonly<
  Record<ContextCompositionMessageBlock['kind'], true>
> = {
  text: true,
  reasoning: true,
  toolCall: true,
  toolResult: true,
  hostedWebSearch: true,
};

export interface ConversationResourceReadResult {
  workspaceId?: string | null;
  logicalPath: string;
  content: string;
  sizeBytes: number;
  startLine: number;
  endLine: number;
  nextByte?: number;
  truncated?: boolean;
}

export async function createLocalAgentSession(
  input: {
    workspacePaths?: string[];
    projectId?: string;
    profileId?: string;
  },
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
  return decodeProjection(projection);
}

export async function getConversationCatalog(
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/catalog`,
    { signal },
  ));
}

export async function getConversationStatuses(signal?: AbortSignal): Promise<ConversationSessionStatus[]> {
  const value = await request<unknown>(`${API_BASE}/conversation/statuses`, { signal });
  if (!Array.isArray(value) || !value.every((item) => (
    isExactRecord(item, ['sessionId', 'revision', 'run'])
    && isIdentifier(item.sessionId)
    && Number.isSafeInteger(item.revision) && Number(item.revision) >= 1
    && (item.run === null || (
      isExactRecord(item.run, ['runId', 'status'], ['waitingReason'])
      && isIdentifier(item.run.runId)
      && RUN_PROJECTION_STATUSES.includes(item.run.status as never)
      && (item.run.waitingReason === undefined
        || ['approval', 'userInput', 'plan'].includes(String(item.run.waitingReason)))
    ))
  ))) throw new Error('conversation_statuses_invalid');
  return value as ConversationSessionStatus[];
}

export async function getPluginCatalog(
  signal?: AbortSignal,
): Promise<PluginCatalogProjection> {
  return decodePluginCatalog(await request<unknown>(
    `${API_BASE}/conversation/plugins`,
    { signal },
  ));
}

export async function getConversationCatalogManagement(
  signal?: AbortSignal,
): Promise<ConversationCatalogManagement> {
  return decodeCatalogManagement(await request<unknown>(
    `${API_BASE}/conversation/catalog/manage`,
    { signal },
  ));
}

export async function createConversationProject(
  input: { title: string; workspacePaths?: string[] },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects`,
    { method: 'POST', body: JSON.stringify(input), signal },
  ));
}

export async function updateConversationProject(
  projectId: string,
  input: { title?: string; workspacePaths?: string[] },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects/${encodeURIComponent(projectId)}`,
    { method: 'PATCH', body: JSON.stringify(input), signal },
  ));
}

export async function deleteConversationProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/projects/${encodeURIComponent(projectId)}`,
    { method: 'DELETE', signal },
  ));
}

export async function updateConversationSession(
  sessionId: string,
  input: { title?: string; projectId?: string | null },
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'PATCH', body: JSON.stringify(input), signal },
  ));
}

export async function deleteConversationSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ConversationCatalog> {
  return decodeCatalog(await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', signal },
  ));
}

export async function attachConversationDirectoryIndex(
  sessionId: string,
  path: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/directory-indexes`,
    { method: 'POST', body: JSON.stringify({ path }), signal },
  );
  return decodeProjection(projection);
}

export async function resolveConversationFilesystemReferences(
  sessionId: string,
  references: Array<{ path: string; kind: 'file' | 'directory' }>,
  signal?: AbortSignal,
): Promise<FilesystemReference[]> {
  const value = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/filesystem-references/resolve`,
    { method: 'POST', body: JSON.stringify({ references }), signal },
  );
  if (!isArrayOf(value, isFilesystemReference)) {
    throw new Error('conversation_filesystem_references_response_invalid');
  }
  return value as FilesystemReference[];
}

export async function detachConversationDirectoryIndex(
  sessionId: string,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/directory-indexes/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE', signal },
  );
  return decodeProjection(projection);
}

export async function uploadConversationPastedText(
  sessionId: string, inputId: string, text: string, signal?: AbortSignal,
): Promise<FilesystemReference> {
  const saved = await request<{ reference: unknown }>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/input-resources/${encodeURIComponent(inputId)}`,
    { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, signal },
  );
  if (!isFilesystemReference(saved.reference)) throw new Error('conversation_input_resource_invalid');
  return saved.reference as FilesystemReference;
}

export async function submitLocalAgentCommand(
  command: ConversationCommand,
  signal?: AbortSignal,
): Promise<CommandReply> {
  if (command.type === 'message.edit') {
    const { nativeHostBinding } = await import('./nativeBrowser');
    const hostBinding = await nativeHostBinding();
    if (hostBinding) command = { ...command, hostBinding };
  }
  if (command.type === 'message.submit' || command.type === 'context.focus') {
    if (command.type === 'context.focus' || !command.runId) {
      const { nativeHostBinding } = await import('./nativeBrowser');
      const hostBinding = await nativeHostBinding();
      if (hostBinding) command = { ...command, hostBinding };
    }
    const content = command.type === 'message.submit' ? command.text : command.task;
    if (new TextEncoder().encode(content).byteLength > 32 * 1024) {
      const reference = await uploadConversationPastedText(command.sessionId, command.commandId, content, signal);
      const filesystemReferences = [...(command.filesystemReferences ?? []), reference];
      command = command.type === 'message.submit' ? { ...command, text: '', filesystemReferences }
        : { ...command, task: '请依据本条消息的粘贴文本聚焦上下文。', filesystemReferences };
    }
  }
  const reply = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(command.sessionId)}/commands`,
    {
      method: 'POST',
      body: JSON.stringify(command),
      signal,
    },
  );
  return decodeCommandReply(reply);
}

export async function getLocalAgentProjection(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionProjection> {
  const projection = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/projection`,
    { signal },
  );
  return decodeProjection(projection);
}

export async function resolveConversationResource(sessionId: string, workspaceId: string, logicalPath: string): Promise<{path: string; kind: 'file' | 'directory'}> {
  const result = await request<{path: string; kind: 'file' | 'directory'}>(`${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/resources/read`, {
    method: 'POST', body: JSON.stringify({workspaceId, logicalPath, format:'path'}),
  });
  if (typeof result.path !== 'string' || !['file', 'directory'].includes(result.kind)) throw new Error('conversation_resource_path_invalid');
  return result;
}

export async function readConversationArtifact(sessionId: string, artifactId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`, {
    signal, headers: getHostConnectionHeaders(),
  });
  if (!response.ok || response.headers.get('content-type')?.startsWith('application/json')) {
    const detail = await response.text();
    let message = detail;
    try { const error = JSON.parse(detail) as ApiEnvelope<never>; message = error.message ?? error.error ?? detail; } catch { /* Keep the original response. */ }
    throw new Error(message || `artifact_read_failed:HTTP ${response.status}`);
  }
  return response.blob();
}

export async function readConversationImage(sessionId: string, workspaceId: string, logicalPath: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/resources/read`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() },
    body: JSON.stringify({ workspaceId, logicalPath, format: 'image' }),
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
    const error = await response.json() as ApiEnvelope<never>;
    throw new Error(error.message ?? error.error ?? `conversation_image_read_failed:HTTP ${response.status}`);
  }
  return response.blob();
}

export class ConversationRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message === code ? code : `${code}:${message}`);
    this.name = 'ConversationRequestError';
  }
}

export function isBinaryFileChange(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && error.code === 'file_change_binary_content';
}

export async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...getHostConnectionHeaders(),
      ...init.headers,
    },
  });
  let envelope: ApiEnvelope<T>;
  try {
    envelope = await response.json() as ApiEnvelope<T>;
  } catch {
    throw new Error(`conversation_response_invalid:HTTP ${response.status}`);
  }
  if (!response.ok || !envelope.ok || envelope.data === undefined || envelope.data === null) {
    throw new ConversationRequestError(
      envelope.error ?? 'conversation_request_failed', envelope.message ?? `HTTP ${response.status}`,
    );
  }
  return envelope.data;
}

function decodeProjection(value: unknown): SessionProjection {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'sessionId',
      'revision',
      'display',
      'modelSettings', 'permissionOverrides', 'effectivePermissions', 'shellAuthorizations',
      'workspaceBindings',
      'sessionDirectoryIndexes',
      'timeline',
      'messages',
      'queuedInputs',
      'narratives',
      'assistantDraft',
      'interactions',
      'pendingInteraction',
      'pendingApproval',
      'plans',
      'activePlanRef',
      'pendingPlan',
      'todoList',
      'contextUsage',
      'contextCompositions',
      'tokenUsage',
      'totalTokenUsage',
      'tokenUsageHistory',
      'run',
      'activities',
      'artifacts',
      'deliverables',
      'terminalError',
    ], ['fileChangeRounds', 'providerAttempts', 'failureSnapshot', 'agentContext', 'agentTasks', 'agentChildren', 'pendingAgentDecisions', 'pendingApprovals'])
    || (value.agentContext !== undefined && !isAgentContext(value.agentContext))
    || (value.agentTasks !== undefined && !isArrayOf(value.agentTasks, isAgentTask))
    || (value.agentChildren !== undefined && !isArrayOf(value.agentChildren, isAgentChild))
    || (value.pendingAgentDecisions !== undefined && !isArrayOf(value.pendingAgentDecisions, isPendingAgentDecision))
    || (value.providerAttempts !== undefined && !isArrayOf(value.providerAttempts, isProviderAttempt))
    || (value.failureSnapshot !== undefined && !isFailureSnapshot(value.failureSnapshot))
    || (value.fileChangeRounds !== undefined && !isArrayOf(value.fileChangeRounds, (round) => isRecord(round) && isIdentifier(round.runId) && isArrayOf(round.recordIds, isIdentifier)))
    || value.schemaVersion !== SESSION_PROJECTION_VERSION
    || !isIdentifier(value.sessionId)
    || !isNaturalNumber(value.revision)
    || !isSessionDisplay(value.display)
    || !isPermissionSettings(value.permissionOverrides)
    || !isNullable(value.effectivePermissions, isPermissionSettings)
    || !isArrayOf(value.shellAuthorizations, item => isExactRecord(item, ['authorityId', 'runId', 'scope', 'summary', 'context'])
      && isIdentifier(item.authorityId) && isIdentifier(item.runId) && isShellAuthorizationScope(item.scope)
      && isNonEmptyText(item.summary) && isRecord(item.context))
    || !isNullable(value.modelSettings, isModelSettings)
    || !isWorkspaceBindings(value.workspaceBindings)
    || !isWorkspaceBindings(value.sessionDirectoryIndexes)
    || !isArrayOf(value.timeline, isTimelineItem)
    || !isArrayOf(value.messages, isProjectionMessage)
    || !isArrayOf(value.queuedInputs, isQueuedInput)
    || !isArrayOf(value.narratives, isNarrative)
    || !isNullable(value.assistantDraft, isAssistantDraft)
    || !isArrayOf(value.interactions, isInteraction)
    || !isNullable(value.pendingInteraction, isInteraction)
    || !isNullable(value.pendingApproval, isApproval)
    || (value.pendingApprovals !== undefined && !isArrayOf(value.pendingApprovals, isApproval))
    || !isArrayOf(value.plans, isPlanProjection)
    || !isNullable(value.activePlanRef, isPlanReference)
    || !isNullable(value.pendingPlan, isPendingPlan)
    || !isNullable(value.todoList, isTodoList)
    || !isNullable(value.contextUsage, isContextUsage)
    || !isArrayOf(value.contextCompositions, isContextComposition)
    || !isTokenUsage(value.tokenUsage)
    || !isTokenUsage(value.totalTokenUsage)
    || !isTokenUsageHistory(value.tokenUsageHistory)
    || !isNullable(value.run, isRun)
    || !isArrayOf(value.activities, isActivity)
    || !isArrayOf(value.artifacts, isArtifact)
    || !isArrayOf(value.deliverables, isDeliverable)
    || !isNullable(value.terminalError, isLocalAgentError)
  ) {
    throw new Error('conversation_projection_invalid');
  }
  const plans = value.plans as Array<{planId: string; revision: number}>;
  const activePlanRef = value.activePlanRef as {planId: string; revision: number} | null;
  const pendingPlan = value.pendingPlan as {planId: string; revision: number} | null;
  const timeline = value.timeline as Array<Record<string, unknown>>;
  const projectionRevision = value.revision as number;
  const messages = value.messages as Array<Record<string, unknown>>;
  const narratives = value.narratives as Array<Record<string, unknown>>;
  const activities = value.activities as Array<Record<string, unknown>>;
  const planKeys = plans.map((plan) => planReferenceKey(plan));
  if (
    new Set(planKeys).size !== planKeys.length
    || (activePlanRef !== null
      && !planKeys.includes(planReferenceKey(activePlanRef)))
    || (pendingPlan !== null
      && !planKeys.includes(planReferenceKey(pendingPlan)))
    || timeline.some((item) => (item.sequence as number) > projectionRevision)
    || !timelineReferencesAreValid(timeline, messages, narratives, plans, activities)
  ) {
    throw new Error('conversation_projection_invalid');
  }
  return value as unknown as SessionProjection;
}

function isAgentCapabilities(value: unknown): boolean {
  return isExactRecord(value, ['messaging', 'continuation', 'delegation'])
    && (typeof value.messaging === 'boolean' || value.messaging === 'parent') && typeof value.continuation === 'boolean' && typeof value.delegation === 'boolean';
}

function isPendingAgentDecision(value: unknown): boolean {
  return isExactRecord(value, ['agentSessionId', 'displayName', 'runId', 'interactionIds'], ['plan', 'approval'])
    && isIdentifier(value.agentSessionId) && isNonEmptyText(value.displayName) && isIdentifier(value.runId)
    && isArrayOf(value.interactionIds, isIdentifier)
    && (value.plan === undefined || isPlanReference(value.plan))
    && (value.approval === undefined || isExactRecord(value.approval, ['approvalId', 'callId'])
      && isIdentifier(value.approval.approvalId) && isIdentifier(value.approval.callId))
    && (value.plan !== undefined || value.approval !== undefined || value.interactionIds.length > 0);
}

function isAgentContext(value: unknown): boolean {
  try {
    const context = decodeAgentContext(value);
    return [context.ownerSessionId, context.parentSessionId, context.parentRunId, context.parentCallId].every(isIdentifier);
  } catch { return false; }
}

function isAgentTaskResult(value: unknown): boolean {
  return isExactRecord(value, ['outcome'], ['content', 'error', 'finalMessageId'])
    && (value.outcome === 'completed' || value.outcome === 'failed' || value.outcome === 'cancelled' || value.outcome === 'indeterminate')
    && (value.content === undefined || typeof value.content === 'string')
    && (value.error === undefined || isLocalAgentError(value.error))
    && (value.finalMessageId === undefined || isIdentifier(value.finalMessageId));
}

function isAgentTask(value: unknown): boolean {
  return isExactRecord(value, ['taskId', 'agentSessionId', 'capabilities', 'displayName', 'text', 'delivery', 'parentRunId', 'status'], ['childRunId', 'result'])
    && isIdentifier(value.taskId) && isIdentifier(value.agentSessionId) && isAgentCapabilities(value.capabilities)
    && isNonEmptyText(value.displayName) && isNonEmptyText(value.text)
    && (value.delivery === 'wait' || value.delivery === 'async') && isIdentifier(value.parentRunId)
    && (value.childRunId === undefined || isIdentifier(value.childRunId))
    && (value.status === 'running' || value.status === 'completed' || value.status === 'failed' || value.status === 'cancelled' || value.status === 'indeterminate')
    && (value.result === undefined || isAgentTaskResult(value.result));
}

function isAgentChild(value: unknown): boolean {
  return isExactRecord(value, ['agentSessionId', 'displayName', 'capabilities', 'closed'])
    && isIdentifier(value.agentSessionId) && isNonEmptyText(value.displayName) && isAgentCapabilities(value.capabilities)
    && typeof value.closed === 'boolean';
}

function isTimelineItem(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.timelineId) || !isPositiveNaturalNumber(value.sequence)) {
    return false;
  }
  switch (value.kind) {
    case 'message':
      return isExactRecord(
        value,
        ['kind', 'timelineId', 'sequence', 'messageId'],
        ['outputIndex', 'streamId'],
      )
        && isIdentifier(value.messageId)
        && (value.streamId === undefined || isStreamId(value.streamId))
        && (value.outputIndex === undefined || isNaturalNumber(value.outputIndex));
    case 'narrative':
      return isExactRecord(
        value,
        ['kind', 'timelineId', 'sequence', 'providerRequestId', 'narrativeId', 'streamId'],
        ['outputIndex'],
      )
        && isIdentifier(value.providerRequestId)
        && isIdentifier(value.narrativeId)
        && isStreamId(value.streamId)
        && (value.outputIndex === undefined || isNaturalNumber(value.outputIndex));
    case 'plan':
      return isExactRecord(value, [
        'kind', 'timelineId', 'sequence', 'providerRequestId', 'planId', 'revision',
      ])
        && isIdentifier(value.providerRequestId)
        && isIdentifier(value.planId)
        && isPositiveNaturalNumber(value.revision);
    case 'toolGroup':
      return isExactRecord(value, [
        'kind', 'timelineId', 'sequence', 'activityIds',
      ], ['providerRequestId'])
        && (value.providerRequestId === undefined || isIdentifier(value.providerRequestId))
        && Array.isArray(value.activityIds)
        && value.activityIds.length > 0
        && value.activityIds.every(isIdentifier);
    default:
      return false;
  }
}

function isQueuedInput(value: unknown): boolean {
  return isExactRecord(value, ['commandId', 'messageId', 'runId', 'text', 'filesystemReferences', 'pluginSelections', 'sequence', 'createdAt', 'status'], ['pluginCatalogRevision','guidanceReferences','interactionId'])
    && (value.interactionId === undefined || isIdentifier(value.interactionId))
    && isIdentifier(value.commandId) && isIdentifier(value.messageId) && isIdentifier(value.runId)
    && typeof value.text === 'string'
    && isArrayOf(value.filesystemReferences, isFilesystemReference)
    && isArrayOf(value.pluginSelections, isPluginSelection)
    && isPositiveNaturalNumber(value.sequence) && isNonEmptyText(value.createdAt)
    && (value.status === 'queued' || value.status === 'notApplied');
}

function timelineReferencesAreValid(
  timeline: Array<Record<string, unknown>>,
  messages: Array<Record<string, unknown>>,
  narratives: Array<Record<string, unknown>>,
  plans: Array<{ planId: string; revision: number }>,
  activities: Array<Record<string, unknown>>,
): boolean {
  const timelineIds = new Set<string>();
  const messageIds = new Set<string>();
  const narrativeIds = new Set<string>();
  const planRefs = new Set<string>();
  const activityIds = new Set<string>();
  const addUnique = (values: Set<string>, value: string): boolean => {
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  const valid = timeline.every((item) => {
    const timelineId = item.timelineId as string;
    if (!addUnique(timelineIds, timelineId)) return false;
    switch (item.kind) {
      case 'message': {
        const messageId = item.messageId as string;
        return addUnique(messageIds, messageId)
          && messages.some((message) => (
            message.messageId === messageId
            && ['user', 'assistant'].includes(String(message.role))
            && (message.role === 'assistant'
              ? isStreamId(item.streamId)
              : item.streamId === undefined)
          ));
      }
      case 'narrative': {
        const narrativeId = item.narrativeId as string;
        return addUnique(narrativeIds, narrativeId)
          && narratives.some((narrative) => (
            narrative.narrativeId === narrativeId
            && narrative.providerRequestId === item.providerRequestId
          ));
      }
      case 'plan': {
        const reference = planReferenceKey({
          planId: item.planId as string,
          revision: item.revision as number,
        });
        return addUnique(planRefs, reference)
          && plans.some((plan) => planReferenceKey(plan) === reference);
      }
      case 'toolGroup':
        return (item.activityIds as string[]).every((activityId) => (
          addUnique(activityIds, activityId)
          && activities.some((activity) => (
            activity.activityId === activityId
            && ['tool', 'providerHosted', 'approval', 'interaction', 'agent'].includes(String(activity.kind))
            && (item.providerRequestId !== undefined || activity.kind === 'agent')
          ))
        ));
      default:
        return false;
    }
  });
  return valid
    && messageIds.size === messages.filter((message) => (
      ['user', 'assistant'].includes(String(message.role))
    )).length
    && narrativeIds.size === narratives.length
    && planRefs.size === plans.length
    && activityIds.size === activities.filter((activity) => (
      ['tool', 'providerHosted', 'approval', 'interaction', 'agent'].includes(String(activity.kind))
    )).length;
}

function decodeCommandReply(value: unknown): CommandReply {
  if (
    !isRecord(value)
    || value.schemaVersion !== COMMAND_REPLY_VERSION
    || typeof value.commandId !== 'string'
    || typeof value.sessionId !== 'string'
    || !Number.isSafeInteger(value.revision)
    || !['accepted', 'replayed', 'rejected'].includes(String(value.status))
  ) {
    throw new Error('conversation_command_reply_invalid');
  }
  return value as unknown as CommandReply;
}

function decodeCatalog(value: unknown): ConversationCatalog {
  if (!isRecord(value) || !Array.isArray(value.projects) || !Array.isArray(value.sessions)) {
    throw new Error('conversation_catalog_invalid');
  }
  for (const project of value.projects) {
    if (
      !isRecord(project)
      || typeof project.id !== 'string'
      || typeof project.title !== 'string'
      || typeof project.createdAt !== 'string'
      || typeof project.updatedAt !== 'string'
      || !isWorkspaceBindings(project.workspaceBindings)
    ) throw new Error('conversation_catalog_invalid');
  }
  for (const session of value.sessions) {
    if (
      !isExactRecord(
        session,
        ['id', 'title', 'workspaceBindings', 'createdAt', 'updatedAt'],
        ['projectId', 'profileId'],
      )
      || typeof session.id !== 'string'
      || typeof session.title !== 'string'
      || typeof session.createdAt !== 'string'
      || typeof session.updatedAt !== 'string'
      || (session.projectId !== undefined && typeof session.projectId !== 'string')
      || (session.profileId !== undefined && typeof session.profileId !== 'string')
      || !isWorkspaceBindings(session.workspaceBindings)
    ) throw new Error('conversation_catalog_invalid');
  }
  return value as unknown as ConversationCatalog;
}

function decodePluginCatalog(value: unknown): PluginCatalogProjection {
  if (
    !isExactRecord(value, ['revision', 'plugins'])
    || !isIdentifier(value.revision)
    || !Array.isArray(value.plugins)
  ) throw new Error('plugin_catalog_invalid');
  const uris = new Set<string>();
  for (const plugin of value.plugins) {
    if (
      !isExactRecord(
        plugin,
        [
          'uri', 'displayName', 'shortDescription', 'activationMediaTypes',
          'enabled', 'available', 'source', 'category', 'contributionKind', 'discovery',
        ],
        ['iconRef', 'error', 'reference', 'management'],
      )
      || typeof plugin.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plugin.uri)
      || uris.has(plugin.uri)
      || !isNonEmptyText(plugin.displayName)
      || !isNonEmptyText(plugin.shortDescription)
      || (plugin.iconRef !== undefined && !isNonEmptyText(plugin.iconRef))
      || !isArrayOf(plugin.activationMediaTypes, isMediaType)
      || new Set(plugin.activationMediaTypes).size !== plugin.activationMediaTypes.length
      || !['builtin', 'mounted'].includes(String(plugin.source))
      || !['functional', 'reference'].includes(String(plugin.category))
      || !['skill', 'mcp', 'cli', 'host'].includes(String(plugin.contributionKind))
      || !['default', 'searchOnly'].includes(String(plugin.discovery))
      || (plugin.management !== undefined && (!isRecord(plugin.management) || !['plugins.disabled','plugins.sources','mcp.servers','skills.mounts'].includes(String(plugin.management.key)) || !isNonEmptyText(plugin.management.id)))
      || typeof plugin.enabled !== 'boolean'
      || typeof plugin.available !== 'boolean'
      || (plugin.error !== undefined && !isLocalAgentError(plugin.error))
    ) throw new Error('plugin_catalog_invalid');
    uris.add(plugin.uri);
  }
  return value as unknown as PluginCatalogProjection;
}

function decodeCatalogManagement(value: unknown): ConversationCatalogManagement {
  const catalog = decodeCatalog(value);
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error('conversation_catalog_management_invalid');
  }
  for (const workspace of value.workspaces) {
    if (
      !isRecord(workspace)
      || typeof workspace.workspaceId !== 'string'
      || typeof workspace.displayName !== 'string'
      || typeof workspace.canonicalRoot !== 'string'
      || typeof workspace.createdAt !== 'string'
    ) throw new Error('conversation_catalog_management_invalid');
  }
  return { ...catalog, workspaces: value.workspaces } as ConversationCatalogManagement;
}

function isWorkspaceBindings(value: unknown): boolean {
  return Array.isArray(value) && value.every((binding) => (
    isExactRecord(binding, ['workspaceId', 'displayName'])
    && isIdentifier(binding.workspaceId)
    && isNonEmptyText(binding.displayName)
  ));
}

function isSessionDisplay(value: unknown): boolean {
  return isExactRecord(value, ['creationTitle'])
    && typeof value.creationTitle === 'string';
}

function isProjectionMessage(value: unknown): boolean {
  if (!isExactRecord(value, [
    'messageId', 'role', 'content', 'filesystemReferences',
    'pluginSelections', 'feedback', 'sequence', 'createdAt',
  ], ['runId', 'providerRequestId', 'replyToInteraction', 'guidanceReferences', 'sourceReferences', 'displayContent'])) return false;
  const hasRunId = value.runId !== undefined;
  const hasProviderRequestId = value.providerRequestId !== undefined;
  return isIdentifier(value.messageId)
    && (value.replyToInteraction === undefined || value.role === 'user'
      && isExactRecord(value.replyToInteraction, ['interactionId', 'prompt'])
      && isIdentifier(value.replyToInteraction.interactionId) && isNonEmptyText(value.replyToInteraction.prompt))
    && ['user', 'assistant', 'tool', 'system'].includes(String(value.role))
    && typeof value.content === 'string'
    && (value.displayContent === undefined || value.role === 'assistant' && typeof value.displayContent === 'string')
    && (value.sourceReferences === undefined || value.role === 'assistant' && isSourceReferences(value.sourceReferences))
    && isArrayOf(value.filesystemReferences, isFilesystemReference)
    && isArrayOf(value.pluginSelections, isPluginSelection)
    && (value.feedback === null || ['up', 'down'].includes(String(value.feedback)))
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && (!hasRunId || isIdentifier(value.runId))
    && (!hasProviderRequestId || isIdentifier(value.providerRequestId))
    && (value.role === 'assistant'
      ? hasRunId && hasProviderRequestId
      : !hasProviderRequestId);
}

function isPluginSelection(value: unknown): boolean {
  return isExactRecord(value, ['selectionId', 'uri', 'label'])
    && isIdentifier(value.selectionId)
    && typeof value.uri === 'string'
    && /^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.uri)
    && isNonEmptyText(value.label);
}

function isFilesystemReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const common = ['referenceId', 'workspaceId', 'logicalPath', 'displayName', 'kind'];
  const keys = value.kind === 'file' ? [...common, 'mediaType', 'byteLength'] : common;
  if (!isExactRecord(value, keys, value.kind === 'file' ? ['source'] : [])) return false;
  if (value.source !== undefined && value.source !== 'pastedText') return false;
  const commonValid = isIdentifier(value.referenceId)
    && isIdentifier(value.workspaceId)
    && isNonEmptyText(value.logicalPath)
    && isNonEmptyText(value.displayName);
  if (!commonValid) return false;
  if (value.kind === 'directory') return value.logicalPath === '.';
  return value.kind === 'file'
    && value.logicalPath !== '.'
    && isMediaType(value.mediaType)
    && isNaturalNumber(value.byteLength);
}

function isMediaType(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(value);
}

function isNarrative(value: unknown): boolean {
  return isExactRecord(value, [
    'narrativeId', 'runId', 'providerRequestId', 'content', 'sequence', 'createdAt',
  ], ['sourceReferences', 'displayContent'])
    && isIdentifier(value.narrativeId)
    && isIdentifier(value.runId)
    && isIdentifier(value.providerRequestId)
    && isNonEmptyText(value.content)
    && (value.displayContent === undefined || typeof value.displayContent === 'string')
    && (value.sourceReferences === undefined || isSourceReferences(value.sourceReferences))
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isSourceReferences(value: unknown): boolean {
  return isExactRecord(value, ['citations', 'unresolved']) && typeof value.unresolved === 'boolean'
    && isArrayOf(value.citations, source => isExactRecord(source, ['url', 'title'])
      && isNonEmptyText(source.title) && typeof source.url === 'string' && /^https?:\/\//u.test(source.url));
}

function isAssistantDraft(value: unknown): boolean {
  if (!isExactRecord(
    value,
    ['runId', 'turnId', 'blocks'],
    ['activity', 'planPreview'],
  )
    || !isIdentifier(value.runId)
    || !isIdentifier(value.turnId)
    || !isArrayOf(value.blocks, isAssistantDraftBlock)
    || value.activity !== undefined && !isProviderActivity(value.activity)
    || value.planPreview !== undefined && !isPlanPreview(value.planPreview)
  ) return false;
  const streams = new Set<string>();
  const blockCount = value.blocks.length;
  let previousOutputIndex = -1;
  return value.blocks.every((block) => {
    if (block.outputIndex === undefined && blockCount !== 1) return false;
    if (block.outputIndex !== undefined) {
      if (block.outputIndex <= previousOutputIndex) return false;
      previousOutputIndex = block.outputIndex;
    }
    if (block.kind === 'providerHosted') return true;
    if (streams.has(block.streamId)) return false;
    streams.add(block.streamId);
    return true;
  });
}

function isPlanPreview(value: unknown): boolean {
  return isExactRecord(value, ['callIndex', 'providerCallId', 'title', 'summary', 'steps', 'truncated'], ['outputIndex'])
    && Number.isSafeInteger(value.callIndex) && Number(value.callIndex) >= 0
    && isIdentifier(value.providerCallId)
    && (value.outputIndex === undefined || Number.isSafeInteger(value.outputIndex) && Number(value.outputIndex) >= 0)
    && typeof value.title === 'string' && value.title.length <= 256
    && typeof value.summary === 'string' && value.summary.length <= 4096
    && isArrayOf(value.steps, (step) => typeof step === 'string' && step.length <= 256) && value.steps.length <= 12
    && typeof value.truncated === 'boolean';
}

function isProviderActivity(value: unknown): boolean {
  return isExactRecord(value, ['purpose', 'phase', 'startedAt'], ['lastContentAt'])
    && ['agent', 'contextCompaction', 'approvalReview'].includes(String(value.purpose))
    && ['waitingResponse', 'reasoning', 'awaitingOutput', 'generatingOutput'].includes(String(value.phase))
    && isNonEmptyText(value.startedAt) && Number.isFinite(Date.parse(value.startedAt))
    && (value.lastContentAt === undefined || isNonEmptyText(value.lastContentAt) && Number.isFinite(Date.parse(value.lastContentAt)));
}

function isAssistantDraftBlock(value: unknown): value is AssistantDraftBlockProjection {
  if (!isRecord(value)) return false;
  if (value.kind === 'narrative' || value.kind === 'finalMessage' || value.kind === 'message') {
    return isExactRecord(value, ['kind', 'content', 'streamId'], ['outputIndex', 'displayContent'])
      && typeof value.content === 'string' && value.content.length > 0
      && (value.displayContent === undefined || typeof value.displayContent === 'string')
      && isStreamId(value.streamId)
      && (value.outputIndex === undefined || isNaturalNumber(value.outputIndex));
  }
  return value.kind === 'providerHosted'
    && isExactRecord(value, [
      'outputIndex', 'kind', 'providerCallId', 'providerToolType', 'status',
    ], ['action'])
    && isIdentifier(value.providerCallId)
    && isNaturalNumber(value.outputIndex)
    && value.providerToolType === 'web_search'
    && (value.status === 'completed' || value.status === 'failed')
    && (value.action === undefined || isRecord(value.action));
}

function isInteraction(value: unknown): boolean {
  return isExactRecord(
    value,
    [
      'kind', 'prompt', 'allowFreeform', 'interactionId', 'runId', 'callId', 'sequence',
      'createdAt', 'status',
    ],
    ['options', 'mode', 'response'],
  )
    && ['pending', 'answered', 'closed'].includes(String(value.status))
    && (value.mode === undefined || ['wait', 'continue'].includes(String(value.mode)))
    && (value.response === undefined || isNonEmptyText(value.response))
    && ['question', 'confirmation'].includes(String(value.kind))
    && isNonEmptyText(value.prompt)
    && typeof value.allowFreeform === 'boolean'
    && isIdentifier(value.interactionId)
    && isIdentifier(value.runId)
    && isIdentifier(value.callId)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && (value.options === undefined || isArrayOf(value.options, isInteractionOption));
}

function isInteractionOption(value: unknown): boolean {
  return isExactRecord(value, ['id', 'label'], ['description'])
    && isIdentifier(value.id)
    && isNonEmptyText(value.label)
    && (value.description === undefined || isNonEmptyText(value.description));
}

function isApproval(value: unknown): boolean {
  return isExactRecord(
    value,
    ['approvalId', 'runId', 'callId', 'preview', 'sequence', 'createdAt'],
  )
    && isIdentifier(value.approvalId)
    && isIdentifier(value.runId)
    && isIdentifier(value.callId)
    && isEffectPreview(value.preview)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt);
}

function isEffectPreview(value: unknown): boolean {
  const effects = ['localRead', 'workspaceRead', 'workspaceMutation', 'process', 'network', 'external'];
  return isExactRecord(value, ['summary', 'effects', 'logicalTargets'], ['authorizationScope', 'authorizationContext', 'authorizationScopes', 'approvalReviewer', 'review', 'fileAccess', 'operation'])
    && (value.operation === undefined || isExactRecord(value.operation, ['toolName', 'arguments'], ['workspaceRoot', 'executionScope'])
      && isNonEmptyText(value.operation.toolName) && isRecord(value.operation.arguments)
      && (value.operation.workspaceRoot === undefined || isNonEmptyText(value.operation.workspaceRoot))
      && (value.operation.executionScope === undefined || isNonEmptyText(value.operation.executionScope)))
    && (value.authorizationScope === undefined || value.authorizationScope === 'sessionBrowser' || isShellAuthorizationScope(value.authorizationScope))
    && (!isShellAuthorizationScope(value.authorizationScope) || isRecord(value.authorizationContext))
    && (value.fileAccess === undefined || (isRecord(value.fileAccess) && isArrayOf(value.fileAccess.read, isNonEmptyText) && isArrayOf(value.fileAccess.write, isNonEmptyText)))
    && (value.authorizationScopes === undefined || isArrayOf(value.authorizationScopes, scope => isShellAuthorizationScope(scope)))
    && (value.approvalReviewer === undefined || ['user', 'agent'].includes(String(value.approvalReviewer)))
    && (value.review === undefined || isExactRecord(value.review, ['decision', 'reason'])
      && ['allow', 'deny', 'ask'].includes(String(value.review.decision)) && isNonEmptyText(value.review.reason))
    && isNonEmptyText(value.summary)
    && Array.isArray(value.effects)
    && value.effects.every((effect) => effects.includes(String(effect)))
    && Array.isArray(value.logicalTargets)
    && value.logicalTargets.every(isNonEmptyText);
}

const PLAN_STATUSES = [
  'published',
  'revisionRequested',
  'confirmed',
  'superseded',
  'cancelled',
  'invalidated',
] as const;

const PLAN_FIELDS = [
  'planId',
  'revision',
  'title',
  'summary',
  'steps',
  'mutationManifest',
  'runId',
  'callId',
  'status',
  'sequence',
  'createdAt',
  'updatedAt',
] as const;

function isPlanProjection(value: unknown): value is Record<string, unknown> & {
  planId: string;
  revision: number;
} {
  return isExactRecord(value, PLAN_FIELDS, ['decisionId', 'confirmationSource'])
    && isPlanProjectionFields(value);
}

function isPendingPlan(value: unknown): boolean {
  return isExactRecord(value, [...PLAN_FIELDS, 'responseMode'], ['decisionId', 'confirmationSource'])
    && isPlanProjectionFields(value)
    && value.status === 'published'
    && value.responseMode === 'confirmReviseOrCancel';
}

function isPlanProjectionFields(value: Record<string, unknown>): boolean {
  if (value.confirmationSource !== undefined && !['user', 'agent', 'parent'].includes(String(value.confirmationSource))) return false;
  if (
    !isIdentifier(value.planId)
    || !isPositiveNaturalNumber(value.revision)
    || !isNonEmptyText(value.title)
    || !isNonEmptyText(value.summary)
    || !isIdentifier(value.runId)
    || !isIdentifier(value.callId)
    || !PLAN_STATUSES.includes(value.status as typeof PLAN_STATUSES[number])
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.createdAt)
    || !isNonEmptyText(value.updatedAt)
    || (value.decisionId !== undefined && !isIdentifier(value.decisionId))
    || !isArrayOf(value.steps, isPlanStep)
    || value.steps.length < 1
    || !isArrayOf(value.mutationManifest, isPlanOperation)
  ) return false;
  return new Set(value.steps.map((step) => step.stepId)).size === value.steps.length;
}

function isPlanStep(value: unknown): value is Record<string, unknown> & { stepId: string } {
  return isExactRecord(value, ['stepId', 'title', 'details'], ['verification'])
    && isIdentifier(value.stepId)
    && isNonEmptyText(value.title)
    && isNonEmptyText(value.details)
    && (value.verification === undefined
      || (Array.isArray(value.verification) && value.verification.every(isNonEmptyText)));
}

function isPlanOperation(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifier(value.workspaceId)) {
    return false;
  }
  if ((value.operation === 'bash' || value.operation === 'powershell')) {
    return isExactRecord(
      value,
      ['workspaceId', 'operation', 'writablePaths'],
      ['command', 'terminal'],
    )
      && (value.command === undefined || isNonEmptyText(value.command))
      && isArrayOf(value.writablePaths, (entry) => (
        isExactRecord(entry, ['path', 'kind']) && isNonEmptyText(entry.path) && ['file', 'directory'].includes(String(entry.kind))
      )) && value.writablePaths.length > 0
      && (value.terminal === undefined || (
        isExactRecord(value.terminal, ['stdin'])
        && typeof value.terminal.stdin === 'string'
        && new TextEncoder().encode(value.terminal.stdin).byteLength <= 65_536
      ));
  }
  if (!isNonEmptyText(value.target)) return false;
  if (value.operation === 'fs.delete') {
    return isExactRecord(value, ['workspaceId', 'operation', 'target', 'targetKind'])
      && ['file', 'directoryTree'].includes(String(value.targetKind));
  }
  return isExactRecord(value, ['workspaceId', 'operation', 'target'], ['targetKind'])
    && (value.targetKind === undefined || ['file', 'directoryTree'].includes(String(value.targetKind)))
    && ['fs.write', 'fs.edit', 'document.render', 'browser.capture']
      .includes(String(value.operation));
}

function isPlanReference(value: unknown): value is { planId: string; revision: number } {
  return isExactRecord(value, ['planId', 'revision'])
    && isIdentifier(value.planId)
    && isPositiveNaturalNumber(value.revision);
}

function planReferenceKey(value: { planId: string; revision: number }): string {
  return `${value.planId}\u0000${value.revision}`;
}

function isTodoList(value: unknown): boolean {
  return isExactRecord(value, ['runId', 'revision', 'items', 'sequence', 'updatedAt'])
    && isIdentifier(value.runId)
    && isPositiveNaturalNumber(value.revision)
    && isPositiveNaturalNumber(value.sequence)
    && isNonEmptyText(value.updatedAt)
    && isArrayOf(value.items, isTodoItem);
}

function isTodoItem(value: unknown): boolean {
  return isExactRecord(value, ['text', 'status'])
    && isNonEmptyText(value.text)
    && typeof value.status === 'string'
    && ['pending', 'inProgress', 'completed', 'blocked'].includes(value.status);
}

function isContextUsage(value: unknown): boolean {
  if (!isExactRecord(
    value,
    [
      'providerRequestId',
      'providerRuntimeRef',
      'runId',
      'sequence',
      'updatedAt',
      'inputTokens',
      'outputTokens',
      'contextWindowTokens',
    ],
    ['cacheReadInputTokens', 'cacheMissInputTokens'],
  )) return false;
  if (
    !isIdentifier(value.providerRequestId)
    || !isIdentifier(value.providerRuntimeRef)
    || !isIdentifier(value.runId)
    || !isNaturalNumber(value.sequence)
    || !isNonEmptyText(value.updatedAt)
    || !isNaturalNumber(value.inputTokens)
    || !isNaturalNumber(value.outputTokens)
    || !isPositiveNaturalNumber(value.contextWindowTokens)
    || value.inputTokens + value.outputTokens > value.contextWindowTokens
  ) return false;
  const hasRead = value.cacheReadInputTokens !== undefined;
  const hasMiss = value.cacheMissInputTokens !== undefined;
  return hasRead === hasMiss
    && (!hasRead || (
      isNaturalNumber(value.cacheReadInputTokens)
      && isNaturalNumber(value.cacheMissInputTokens)
      && value.cacheReadInputTokens + value.cacheMissInputTokens === value.inputTokens
    ));
}

function isContextComposition(value: unknown): boolean {
  return isExactRecord(value, [
    'providerRequestId',
    'purpose',
    'responseConstraint',
    'dynamicInstructionBytes',
    'runId',
    'messages',
    'workspaceBindings',
    'tools',
    'partitions',
    'sequence',
    'createdAt',
  ], ['kernelCatalogSnapshotRef'])
    && (value.kernelCatalogSnapshotRef === undefined || isIdentifier(value.kernelCatalogSnapshotRef))
    && isIdentifier(value.providerRequestId)
    && ['agent', 'contextCompaction', 'approvalReview'].includes(String(value.purpose))
    && ['normal', 'answerOnly'].includes(String(value.responseConstraint))
    && isNaturalNumber(value.dynamicInstructionBytes)
    && isIdentifier(value.runId)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.createdAt)
    && Array.isArray(value.messages)
    && value.messages.every((message, index) => isContextMessage(message, index))
    && isArrayOf(value.workspaceBindings, isContextItem)
    && isArrayOf(value.tools, isContextTool)
    && contextPartitionsAreValid(value.partitions);
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'filesystemReferences',
] as const;

function contextPartitionsAreValid(value: unknown): boolean {
  if (
    !Array.isArray(value)
    || value.length !== CONTEXT_PARTITION_ORDER.length
    || value.some((partition, index) => !isContextPartition(
      partition,
      CONTEXT_PARTITION_ORDER[index],
    ))
    || value.every((partition) => partition.requestShapeUnits === 0)
  ) return false;
  const first = value[0] as Record<string, unknown>;
  const hasEstimates = first.estimatedInputTokens !== undefined;
  return value.every((partition) => (
    (partition as Record<string, unknown>).estimatedInputTokens !== undefined
  ) === hasEstimates);
}

function isContextPartition(value: unknown, kind: string): boolean {
  if (!isExactRecord(
    value,
    ['kind', 'itemCount', 'requestShapeUnits'],
    ['estimatedInputTokens', 'tokenSource'],
  )) return false;
  const hasEstimate = value.estimatedInputTokens !== undefined;
  return value.kind === kind
    && isNaturalNumber(value.itemCount)
    && isNaturalNumber(value.requestShapeUnits)
    && (hasEstimate
      ? isNaturalNumber(value.estimatedInputTokens) && value.tokenSource === 'sessionEstimated'
      : value.tokenSource === undefined);
}

function isContextMessage(value: unknown, messageIndex: number): boolean {
  const kinds = [
    'instructions',
    'workspaceBindings',
    'sessionControls',
    'journalMessages',
    'contextProviders',
  ];
  return isExactRecord(value, [
    'messageIndex',
    'contributionId',
    'contributionKind',
    'label',
    'role',
    'blocks',
    'filesystemReferences',
  ])
    && value.messageIndex === messageIndex
    && isIdentifier(value.contributionId)
    && kinds.includes(String(value.contributionKind))
    && isNonEmptyText(value.label)
    && ['system', 'user', 'assistant', 'tool'].includes(String(value.role))
    && Array.isArray(value.blocks)
    && value.blocks.every((block, index) => isContextMessageBlock(block, index))
    && isArrayOf(value.filesystemReferences, isContextItem);
}

function isContextMessageBlock(value: unknown, blockIndex: number): boolean {
  if (!isRecord(value) || value.blockIndex !== blockIndex) return false;
  if (!Object.hasOwn(CONTEXT_MESSAGE_BLOCK_KINDS, String(value.kind))) return false;
  if (value.kind === 'text' || value.kind === 'reasoning') {
    return isExactRecord(value, ['blockIndex', 'kind']);
  }
  if (value.kind === 'toolCall') {
    return isExactRecord(value, ['blockIndex', 'kind', 'callId', 'toolName'])
      && isIdentifier(value.callId)
      && isNonEmptyText(value.toolName);
  }
  if (value.kind === 'toolResult') {
    return isExactRecord(value, ['blockIndex', 'kind', 'resultForCallId'])
      && isIdentifier(value.resultForCallId);
  }
  if (value.kind === 'hostedWebSearch') {
    return isExactRecord(value, ['blockIndex', 'kind', 'providerCallId'])
      && isIdentifier(value.providerCallId);
  }
  return false;
}

function isContextItem(value: unknown): boolean {
  return isExactRecord(value, ['itemId', 'label'])
    && isIdentifier(value.itemId)
    && isNonEmptyText(value.label);
}

function isContextTool(value: unknown): boolean {
  return isExactRecord(
    value,
    ['itemId', 'label', 'canonicalName', 'wireName', 'origin', 'availability'],
    ['pluginUri'],
  )
    && isIdentifier(value.itemId)
    && isNonEmptyText(value.label)
    && isNonEmptyText(value.canonicalName)
    && isNonEmptyText(value.wireName)
    && Object.hasOwn(CONTEXT_TOOL_ORIGINS, String(value.origin))
    && ['callable', 'blocked'].includes(String(value.availability))
    && (value.pluginUri === undefined
      || typeof value.pluginUri === 'string'
        && /^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u
          .test(value.pluginUri));
}

function isTokenUsage(value: unknown): boolean {
  return isExactRecord(value, [
    'providerCallCount',
    'reportedCallCount',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheAvailable',
    'cacheComplete',
    'cacheHitRatio',
  ])
    && isTokenUsageFields(value);
}

function isTokenUsageHistory(value: unknown): boolean {
  if (!isArrayOf(value, isTokenUsageRound)) return false;
  return value.every((round, index) => index === 0 || value[index - 1].sequence >= round.sequence);
}

function isTokenUsageRound(value: unknown): value is Record<string, unknown> & { sequence: number } {
  return isExactRecord(value, [
    'runId',
    'inputMessageId',
    'title',
    'sequence',
    'startedAt',
    'providerCallCount',
    'reportedCallCount',
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheMissInputTokens',
    'cacheAvailable',
    'cacheComplete',
    'cacheHitRatio',
  ], ['completedAt', 'outcome'])
    && isIdentifier(value.runId)
    && isIdentifier(value.inputMessageId)
    && isNonEmptyText(value.title)
    && isNaturalNumber(value.sequence)
    && isNonEmptyText(value.startedAt)
    && (value.completedAt === undefined || isNonEmptyText(value.completedAt))
    && (value.outcome === undefined
      || ['completed', 'failed', 'cancelled', 'indeterminate'].includes(String(value.outcome)))
    && isTokenUsageFields(value);
}

function isTokenUsageFields(value: Record<string, unknown>): boolean {
  if (!(isNaturalNumber(value.providerCallCount)
    && isNaturalNumber(value.reportedCallCount)
    && isNaturalNumber(value.inputTokens)
    && isNaturalNumber(value.outputTokens)
    && isNaturalNumber(value.cacheReadInputTokens)
    && isNaturalNumber(value.cacheMissInputTokens)
    && typeof value.cacheAvailable === 'boolean'
    && typeof value.cacheComplete === 'boolean'
    && isCacheHitRatio(value.cacheHitRatio)
    && value.reportedCallCount <= value.providerCallCount
    && Number.isSafeInteger(value.inputTokens + value.outputTokens)
    && Number.isSafeInteger(value.cacheReadInputTokens + value.cacheMissInputTokens)
    && value.cacheReadInputTokens + value.cacheMissInputTokens <= value.inputTokens)) {
    return false;
  }
  const expectedRatio = value.reportedCallCount > 0 && value.inputTokens > 0
    ? value.cacheReadInputTokens / value.inputTokens
    : null;
  return value.cacheAvailable === (value.reportedCallCount > 0)
    && value.cacheComplete === (
      value.providerCallCount > 0
      && value.reportedCallCount === value.providerCallCount
    )
    && (expectedRatio === null
      ? value.cacheHitRatio === null
      : typeof value.cacheHitRatio === 'number'
        && Math.abs(value.cacheHitRatio - expectedRatio) <= Number.EPSILON * 8);
}

function isCacheHitRatio(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isRun(value: unknown): boolean {
  return isExactRecord(
    value,
    ['runId', 'profileId', 'workspaceBindings', 'status'],
    ['waitingReason', 'reasoningEffort', 'thinking', 'hostBinding'],
  )
    && isIdentifier(value.runId)
    && isIdentifier(value.profileId)
    && (value.hostBinding === undefined || (isExactRecord(value.hostBinding, ['hostInstanceId', 'windowLabel'])
      && isIdentifier(value.hostBinding.hostInstanceId) && isIdentifier(value.hostBinding.windowLabel)))
    && (value.reasoningEffort === undefined || isReasoningEffort(value.reasoningEffort))
    && (value.thinking === undefined || ['enabled', 'disabled'].includes(String(value.thinking)))
    && isWorkspaceBindings(value.workspaceBindings)
    && RUN_PROJECTION_STATUSES.includes(
      value.status as typeof RUN_PROJECTION_STATUSES[number],
    )
    && (value.waitingReason === undefined
      || ['approval', 'userInput', 'plan'].includes(String(value.waitingReason)));
}

function isReasoningEffort(value: unknown): boolean {
  return isLlmReasoningEffort(value);
}

function isModelSettings(value: unknown): boolean {
  return isExactRecord(value, ['profileId', 'reasoningEffortOverride']) && isIdentifier(value.profileId)
    && (value.reasoningEffortOverride === null || isReasoningEffort(value.reasoningEffortOverride));
}

function isActivity(value: unknown): boolean {
  return isExactRecord(
    value,
    ['activityId', 'kind', 'status', 'label', 'runId', 'sequence'],
    ['callId', 'tool', 'providerHosted', 'inputRejection', 'interruption', 'notExecuted', 'startedAt', 'liveOutput', 'agent'],
  )
    && isIdentifier(value.activityId)
    && ['run', 'tool', 'providerHosted', 'approval', 'plan', 'interaction', 'agent']
      .includes(String(value.kind))
    && ['active', 'requested', 'waiting', 'completed', 'denied', 'rejected', 'failed', 'cancelled', 'indeterminate']
      .includes(String(value.status))
    && isNonEmptyText(value.label)
    && isIdentifier(value.runId)
    && (value.callId === undefined || isIdentifier(value.callId))
    && isNaturalNumber(value.sequence)
    && (value.startedAt === undefined || value.kind === 'tool' && isNonEmptyText(value.startedAt)
      && /^\d+$/u.test(value.startedAt) && Number.isSafeInteger(Number(value.startedAt)))
    && (value.liveOutput === undefined || value.kind === 'tool' && value.status === 'active'
      && value.startedAt !== undefined && isLiveToolOutput(value.liveOutput))
    && (value.tool === undefined || isToolActivity(value.tool, String(value.status)))
    && (value.providerHosted === undefined || isProviderHostedActivity(value.providerHosted))
    && (value.kind === 'tool'
      ? value.notExecuted !== undefined ? isNotExecuted(value.notExecuted) && value.tool === undefined
          && value.inputRejection === undefined && value.interruption === undefined
          && value.status === (value.notExecuted.reason === 'cancelled' ? 'cancelled' : 'rejected')
        : value.status === 'rejected' ? value.tool === undefined && isInputRejection(value.inputRejection)
        : value.status === 'requested' || value.status === 'active' && value.startedAt !== undefined || value.tool !== undefined
          || value.status === 'indeterminate' && isLocalAgentError(value.interruption)
      : value.tool === undefined)
    && (value.notExecuted === undefined || value.kind === 'tool')
    && (value.status === 'rejected' && value.kind === 'tool' && value.notExecuted === undefined) === (value.inputRejection !== undefined)
    && (value.interruption === undefined || value.kind === 'tool' && value.status === 'indeterminate' && value.tool === undefined && isLocalAgentError(value.interruption))
    && (value.kind === 'providerHosted') === (value.providerHosted !== undefined)
    && (value.kind === 'agent' ? isExactRecord(value.agent, ['agentSessionId', 'phase'], ['taskId'])
      && isIdentifier(value.agent.agentSessionId)
      && (value.agent.phase === 'updated' ? value.agent.taskId === undefined
        : ['started', 'completed'].includes(String(value.agent.phase)) && isIdentifier(value.agent.taskId)) : value.agent === undefined);
}

function isNotExecuted(value: unknown): value is { reason: 'cancelled' | 'dependencyFailed'; predecessorCallId?: string } {
  return isExactRecord(value, ['reason'], ['predecessorCallId'])
    && ['cancelled', 'dependencyFailed'].includes(String(value.reason))
    && (value.predecessorCallId === undefined || isIdentifier(value.predecessorCallId));
}

function isLiveToolOutput(value: unknown): boolean {
  return isExactRecord(value, ['stdout', 'stderr', 'stdoutBytes', 'stderrBytes', 'truncated'])
    && typeof value.stdout === 'string' && typeof value.stderr === 'string'
    && isNaturalNumber(value.stdoutBytes) && isNaturalNumber(value.stderrBytes)
    && typeof value.truncated === 'boolean';
}

function isInputRejection(value: unknown): boolean {
  return isExactRecord(value, ['code', 'message', 'issues'], ['diagnostics'])
    && isLocalAgentError({ code: value.code, message: value.message,
      ...(value.diagnostics === undefined ? {} : { diagnostics: value.diagnostics }) })
    && Array.isArray(value.issues) && value.issues.length > 0
    && value.issues.every((issue) => isExactRecord(issue, ['path', 'rule', 'message'], ['expected'])
      && isNonEmptyText(issue.path) && isNonEmptyText(issue.rule) && isNonEmptyText(issue.message));
}

function isProviderHostedActivity(value: unknown): boolean {
  return isExactRecord(value, ['providerToolType', 'providerCallId'], ['action'])
    && value.providerToolType === 'web_search'
    && isIdentifier(value.providerCallId)
    && (value.action === undefined || isRecord(value.action));
}

function isToolActivity(value: unknown, activityStatus: string): boolean {
  return isExactRecord(value, ['operation', 'resources'], ['shell', 'process', 'fileChanges', 'recordId', 'error', 'projectionError'])
    && (value.error === undefined || isLocalAgentError(value.error))
    && (value.projectionError === undefined || isLocalAgentError(value.projectionError))
    && (value.recordId === undefined || isIdentifier(value.recordId))
    && isNonEmptyText(value.operation)
    && isArrayOf(value.resources, isActivityResource)
    && (value.fileChanges === undefined || isArrayOf(value.fileChanges, (change) => isRecord(change)
      && isIdentifier(change.workspaceId) && isNonEmptyText(change.path)
      && ['create', 'modify', 'delete'].includes(String(change.kind))
      && [change.before, change.after].every((side) => isRecord(side) && typeof side.exists === 'boolean'
        && (!side.exists || typeof side.contentRef === 'string' || typeof side.error === 'string'))))
    && (value.process === undefined || isProcessActivity(value.process))
    && (value.process !== undefined ? value.shell === undefined : (value.operation === 'bash' || value.operation === 'powershell')
      ? value.shell === undefined && value.projectionError !== undefined || isShellActivity(value.shell, activityStatus)
      : value.shell === undefined);
}

function isShellActivity(value: unknown, activityStatus: string): boolean {
  const resultValid = isRecord(value) && value.result !== undefined
    ? isShellActivityResult(value.result)
    : false;
  const resultMatchesShell = !isRecord(value) || value.result === undefined || (
    isRecord(value.result)
    && isRecord(value.result.environment)
    && value.result.environment.executionScope === value.executionScope
    && value.result.environment.terminal === value.terminal
  );
  return isExactRecord(value, ['command', 'cwd', 'executionScope', 'terminal'], ['result'])
    && isNonEmptyText(value.command)
    && isNonEmptyText(value.cwd)
    && (value.executionScope === 'workspace' || value.executionScope === 'host')
    && typeof value.terminal === 'boolean'
    && resultMatchesShell
    && (activityStatus === 'completed'
      ? resultValid
      : activityStatus === 'failed' || activityStatus === 'indeterminate'
        ? value.result === undefined || resultValid
        : value.result === undefined);
}

function isActivityResource(value: unknown): boolean {
  return isExactRecord(value, ['kind', 'label'], ['workspaceId', 'logicalPath', 'uri'])
    && ['workspacePath', 'url', 'logicalTarget'].includes(String(value.kind))
    && isNonEmptyText(value.label)
    && (value.workspaceId === undefined || isIdentifier(value.workspaceId))
    && (value.logicalPath === undefined || isNonEmptyText(value.logicalPath))
    && (value.uri === undefined || isNonEmptyText(value.uri));
}

function isArtifact(value: unknown): boolean {
  return isExactRecord(value, ['artifactId', 'label', 'sessionId', 'runId', 'callId', 'recordId', 'contentType', 'contentMode', 'createdAt'], ['workspaceId', 'logicalPath', 'uri', 'sourcePage', 'modifiedAt', 'resourceKey'])
    && isIdentifier(value.artifactId)
    && isNonEmptyText(value.label)
    && ['sessionId', 'runId', 'callId', 'recordId'].every((key) => isIdentifier(value[key]))
    && isNonEmptyText(value.contentType)
    && (value.contentMode === 'fixed' || value.contentMode === 'live')
    && isNonEmptyText(value.createdAt)
    && (value.modifiedAt === undefined || isNonEmptyText(value.modifiedAt))
    && (value.resourceKey === undefined || isIdentifier(value.resourceKey))
    && (value.sourcePage === undefined || isRecord(value.sourcePage))
    && (value.workspaceId === undefined || isIdentifier(value.workspaceId))
    && (value.logicalPath === undefined || isNonEmptyText(value.logicalPath))
    && (value.uri === undefined || isNonEmptyText(value.uri));
}

function isDeliverable(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { deliveryId, presentationRunId, presentedAt, updatedAt, sequence, ...artifact } = value;
  return isArtifact(artifact) && isIdentifier(deliveryId) && isIdentifier(presentationRunId)
    && isNonEmptyText(presentedAt) && isNonEmptyText(updatedAt) && isPositiveNaturalNumber(sequence);
}

function isLocalAgentError(value: unknown): boolean {
  return isLocalAgentErrorValue(value);
}

function isNullable(value: unknown, predicate: (candidate: unknown) => boolean): boolean {
  return value === null || predicate(value);
}

function isArrayOf<T>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is T[];
function isArrayOf(value: unknown, predicate: (candidate: unknown) => boolean): value is unknown[];
function isArrayOf(value: unknown, predicate: (candidate: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(predicate);
}

function isExactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStreamId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNaturalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveNaturalNumber(value: unknown): value is number {
  return isNaturalNumber(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readConversation(sessionId: string, query: Omit<import('@deepcode/protocol').ConversationReadQuery, 'sessionId'>, signal?: AbortSignal) {
  return await request<import('@deepcode/protocol').ConversationReadResult>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/read`,
    { method: 'POST', body: JSON.stringify(query), signal },
  );
}
export async function readFileChange(sessionId: string, recordId: string, index: number, signal?: AbortSignal) {
  const value = await request<unknown>(
    `${API_BASE}/conversation/sessions/${encodeURIComponent(sessionId)}/changes/read`,
    { method: 'POST', body: JSON.stringify({ recordId, index }), signal },
  );
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.workspaceId !== 'string'
    || ![value.before, value.after].every((side) => side === null || typeof side === 'string')
    || (value.before === null && value.after === null)) throw new Error('file_change_response_invalid');
  return value as { before: string | null; after: string | null; path: string; workspaceId: string };
}

function isProviderAttempt(value: unknown): boolean {
  return isExactRecord(value, ['providerRequestId', 'providerAttemptId', 'attempt', 'purpose', 'phase', 'runId', 'updatedAt'], ['error', 'retryAt'])
    && ['providerRequestId', 'providerAttemptId', 'runId'].every((key) => isIdentifier(value[key]))
    && Number.isInteger(value.attempt) && Number(value.attempt) >= 1 && Number(value.attempt) <= 5
    && ['agent', 'contextCompaction', 'approvalReview'].includes(String(value.purpose))
    && ['started', 'completed', 'failed', 'retryWaiting'].includes(String(value.phase))
    && isNonEmptyText(value.updatedAt)
    && (['failed', 'retryWaiting'].includes(String(value.phase)) ? isLocalAgentError(value.error) : value.error === undefined)
    && (value.phase === 'retryWaiting' ? isNonEmptyText(value.retryAt) && Number.isFinite(Number(value.retryAt)) : value.retryAt === undefined);
}

function isFailureSnapshot(value: unknown): boolean {
  return isExactRecord(value, ['revision', 'phase', 'error', 'providerAttemptIds', 'toolRecordIds', 'pendingCallIds', 'queuedMessageIds', 'planRef'], ['providerRequestId', 'lastMessageId'])
    && isNaturalNumber(value.revision) && isNonEmptyText(value.phase) && isLocalAgentError(value.error)
    && ['providerAttemptIds', 'toolRecordIds', 'pendingCallIds', 'queuedMessageIds'].every((key) => isArrayOf(value[key], isIdentifier))
    && ['providerRequestId', 'lastMessageId'].every((key) => value[key] === undefined || isIdentifier(value[key]))
    && isNullable(value.planRef, isPlanReference);
}

function isPermissionSettings(value: unknown): boolean {
  try { validatePermissionPatches(value); return true; } catch { return false; }
}
