import { isSessionAuthorizationScope } from '@deepcode/protocol';
import type {
  ResourceJournalEvent, ResourceJournalRead, SessionEvent, SessionProjection,
  SessionResourceProjection, ToolExecutionRecord, WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { activeConversationEvents } from './conversationHistory.js';

type WorkspaceEvent = Extract<ResourceJournalEvent, { type: 'session.created' | 'session.workspaces.updated'
  | 'session.directory-index.attached' | 'session.directory-index.detached' }>;
export interface WorkspaceState {
  creationWorkspaceBindings: WorkspaceBindingDisplay[];
  sessionDirectoryIndexes: WorkspaceBindingDisplay[];
  workspaceBindings: WorkspaceBindingDisplay[];
}

/** Shared by full replay and the resource field projection, not a second membership rule. */
export function reduceWorkspaceBindings(previous: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  let base = previous.creationWorkspaceBindings;
  let indexes = previous.sessionDirectoryIndexes;
  switch (event.type) {
    case 'session.created': base = event.payload.workspaceBindings.map(binding => ({ ...binding })); indexes = []; break;
    case 'session.workspaces.updated': base = structuredClone(event.payload.baseBindings); break;
    case 'session.directory-index.attached':
      if (previous.workspaceBindings.some(binding => binding.workspaceId === event.payload.workspaceBinding.workspaceId)) {
        throw new Error('session_directory_index_duplicate');
      }
      indexes = [...indexes, { ...event.payload.workspaceBinding }];
      break;
    case 'session.directory-index.detached':
      indexes = indexes.filter(binding => binding.workspaceId !== event.payload.workspaceId);
      if (indexes.length === previous.sessionDirectoryIndexes.length) throw new Error('session_directory_index_missing');
      break;
  }
  const workspaceBindings = [...new Map([...base, ...indexes].map(binding => [binding.workspaceId, { ...binding }])).values()];
  if (event.type === 'session.workspaces.updated'
    && JSON.stringify(workspaceBindings) !== JSON.stringify(event.payload.workspaceBindings)) throw new Error('session_workspace_bindings_mismatch');
  return { creationWorkspaceBindings: base, sessionDirectoryIndexes: indexes, workspaceBindings };
}

type Approval = Pick<NonNullable<SessionProjection['pendingApproval']>, 'approvalId' | 'runId' | 'callId'>
  & { preview: Pick<NonNullable<SessionProjection['pendingApproval']>['preview'], 'summary' | 'authorizationContext'> };
type Resolution = Extract<ResourceJournalEvent, { type: 'approval.resolved' }>;
export function resolvedFileAuthorization(approval: Approval | undefined, event: Resolution): SessionProjection['shellAuthorizations'][number] | null {
  if (!approval || approval.approvalId !== event.payload.approvalId
    || approval.callId !== event.callId || approval.runId !== event.runId) throw new Error('approval_request_missing');
  return event.payload.decision === 'allow' && event.payload.authorizationScope && approval.preview.authorizationContext
    ? { authorityId: event.payload.authorityId, runId: event.runId, scope: event.payload.authorizationScope,
      summary: approval.preview.summary, context: structuredClone(approval.preview.authorizationContext) } : null;
}
export function authorizationsAfterSettlement(grants: SessionProjection['shellAuthorizations'], runId: string) {
  return grants.filter(grant => grant.runId !== runId || isSessionAuthorizationScope(grant.scope));
}

/** Field projection used by in-process adapters; the SQLite reader selects the same fields. */
export function projectResourceEvent(event: SessionEvent, recordIds: readonly string[] = []): ResourceJournalEvent | null {
  const base = { sessionId: event.sessionId, sequence: event.sequence };
  switch (event.type) {
    case 'session.created': return { ...base, type: event.type, payload: { workspaceBindings: structuredClone(event.payload.workspaceBindings) } };
    case 'session.workspaces.updated': return { ...base, type: event.type, payload: {
      baseBindings: structuredClone(event.payload.baseBindings), workspaceBindings: structuredClone(event.payload.workspaceBindings) } };
    case 'session.directory-index.attached': return { ...base, type: event.type, payload: { workspaceBinding: { ...event.payload.workspaceBinding } } };
    case 'session.directory-index.detached': return { ...base, type: event.type, payload: { workspaceId: event.payload.workspaceId } };
    case 'message.committed': return { ...base, type: event.type, payload: { filesystemReferences: structuredClone(event.payload.filesystemReferences ?? []) } };
    case 'approval.requested': return { ...base, type: event.type, runId: event.runId, callId: event.callId,
      payload: { approvalId: event.payload.approvalId, preview: { summary: event.payload.preview.summary,
        ...(event.payload.preview.authorizationContext ? { authorizationContext: structuredClone(event.payload.preview.authorizationContext) } : {}) } } };
    case 'approval.resolved': return { ...base, type: event.type, runId: event.runId, callId: event.callId,
      payload: { approvalId: event.payload.approvalId, decision: event.payload.decision, authorityId: event.payload.authorityId,
        ...(event.payload.authorizationScope ? { authorizationScope: event.payload.authorizationScope } : {}) } };
    case 'approval.revoked': return { ...base, type: event.type, runId: event.runId, payload: { authorityId: event.payload.authorityId } };
    case 'tool.completed': return { ...base, type: event.type, runId: event.runId, callId: event.callId,
      payload: recordIds.includes(event.payload.record.recordId) ? { record: structuredClone(event.payload.record) } : {} };
    case 'tool.input-rejected': case 'tool.not-executed':
      return { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: {} };
    case 'process.updated': return recordIds.length ? { ...base, type: event.type, runId: event.runId, callId: event.callId, payload: { job: { callId: event.payload.job.callId } } } : null;
    case 'run.settled': return { ...base, type: event.type, runId: event.runId, payload: {} };
    case 'conversation.revised': return { ...base, type: event.type, payload: {
      fromSequence: event.payload.fromSequence, throughSequence: event.payload.throughSequence } };
    default: return null;
  }
}

export function projectSessionResources(read: ResourceJournalRead, recordIds: readonly string[],
  projectTool: (record: ToolExecutionRecord) => SessionResourceProjection['activities'][number]['tool']): SessionResourceProjection {
  if (!Number.isSafeInteger(read.revision) || read.revision < 1 || read.events[0]?.type !== 'session.created'
    || read.events[0].sequence !== 1) throw new Error('session_creation_event_missing');
  let sequence = 0;
  for (const event of read.events) {
    if (event.sessionId !== read.sessionId) throw new Error('session_event_identity_mismatch');
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= sequence || event.sequence > read.revision) throw new Error('session_event_sequence_gap');
    sequence = event.sequence;
  }
  let workspace: WorkspaceState = { creationWorkspaceBindings: [], sessionDirectoryIndexes: [], workspaceBindings: [] };
  let grants: SessionProjection['shellAuthorizations'] = [];
  const approvals = new Map<string, Approval>();
  const messages: SessionResourceProjection['messages'] = [];
  const processes = new Set<string>();
  const selected = new Map<string, { callId: string; tool: SessionResourceProjection['activities'][number]['tool'] }>();
  const requested = new Set(recordIds);
  for (const event of activeConversationEvents(read.events)) {
    switch (event.type) {
      case 'session.created': case 'session.workspaces.updated':
      case 'session.directory-index.attached': case 'session.directory-index.detached':
        workspace = reduceWorkspaceBindings(workspace, event); break;
      case 'message.committed': messages.push({ filesystemReferences: (event.payload.filesystemReferences ?? []).map(reference => ({ ...reference })) }); break;
      case 'approval.requested': approvals.set(event.callId, { approvalId: event.payload.approvalId,
        runId: event.runId, callId: event.callId, preview: event.payload.preview }); break;
      case 'approval.resolved': {
        const grant = resolvedFileAuthorization(approvals.get(event.callId), event);
        if (grant) grants.push(grant);
        approvals.delete(event.callId); break;
      }
      case 'approval.revoked': grants = grants.filter(grant => grant.authorityId !== event.payload.authorityId); break;
      case 'run.settled': grants = authorizationsAfterSettlement(grants, event.runId); approvals.clear(); break;
      case 'tool.completed':
        approvals.delete(event.callId);
        if (event.payload.record && requested.has(event.payload.record.recordId) && !selected.has(event.payload.record.recordId)) {
          const tool = projectTool(event.payload.record);
          if (processes.has(event.callId)) delete tool.fileChanges;
          selected.set(event.payload.record.recordId, { callId: event.callId, tool });
        }
        break;
      case 'tool.input-rejected': case 'tool.not-executed': approvals.delete(event.callId); break;
      case 'process.updated':
        processes.add(event.payload.job.callId);
        for (const item of selected.values()) if (item.callId === event.payload.job.callId) delete item.tool.fileChanges;
        break;
    }
  }
  return { sessionId: read.sessionId, revision: read.revision, workspaceBindings: workspace.workspaceBindings,
    messages, shellAuthorizations: grants, activities: [...selected.values()].map(({ tool }) => ({ tool })) };
}
