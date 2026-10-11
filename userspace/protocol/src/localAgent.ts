import type { UserSettings } from './userSettings.js';
import type { ShellAuthorizationScope } from './permissions.js';
import type { LlmReasoningEffort, LlmThinkingMode } from './llm.js';

export const LOCAL_AGENT_PROTOCOL_VERSION = 'deepcode.local-agent' as const;
export const CONVERSATION_COMMAND_VERSION = 'deepcode.command.v3' as const;
export const COMMAND_REPLY_VERSION = 'deepcode.command-reply.v3' as const;
export const SESSION_EVENT_VERSION = 'deepcode.session-event.v5' as const;
export const SESSION_PROJECTION_VERSION = 'deepcode.session-projection.v6' as const;
export const PROVIDER_EVENT_VERSION = 'deepcode.provider-event' as const;
export const KERNEL_REQUEST_VERSION = 'deepcode.kernel-request' as const;
export const KERNEL_REPLY_VERSION = 'deepcode.kernel-reply' as const;
export const SESSION_CONTROL_INTERACTION_REQUEST = 'interaction.request' as const;
export const SESSION_CONTROL_PLAN_PUBLISH = 'plan.publish' as const;
export const SESSION_CONTROL_TODO_UPDATE = 'todo.update' as const;
export const SESSION_CONTROL_PLUGIN_ACTIVATE = 'plugin.activate' as const;
export const SESSION_CONTROL_ARTIFACT_PRESENT = 'artifact.present' as const;

export type JsonObject = Record<string, unknown>;

export interface ErrorDiagnostics {
  source: string;
  phase: string;
  category: string;
  retryable: boolean;
  causes: Array<{ message: string; kind?: string; osCode?: number }>;
  isConnect?: boolean;
  isTimeout?: boolean;
  isBody?: boolean;
  stopReason?: string;
  archivePath?: string;
  providerError?: { code?: string; type?: string; retryDirective?: string };
  secondary?: Array<{ code: string; message: string }>;
}

export interface LocalAgentError {
  code: string;
  message: string;
  /** Absent on historical records whose producer did not collect diagnostics. */
  diagnostics?: ErrorDiagnostics;
}

export interface ProviderAttemptFact {
  providerRequestId: string;
  providerAttemptId: string;
  attempt: number;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  phase: 'started' | 'completed' | 'failed' | 'retryWaiting';
  error?: LocalAgentError;
  retryAt?: string;
}

export interface RunFailureSnapshot {
  revision: number;
  phase: string;
  error: LocalAgentError;
  providerRequestId?: string;
  providerAttemptIds: string[];
  lastMessageId?: string;
  toolRecordIds: string[];
  pendingCallIds: string[];
  queuedMessageIds: string[];
  planRef: { planId: string; revision: number } | null;
}


/** Ordinary catalog and projection views deliberately omit canonicalRoot. */
export interface WorkspaceBindingDisplay {
  workspaceId: string;
  displayName: string;
}

/** Only the explicit workspace picker/management surface may consume this view. */
export interface WorkspaceManagementRecord extends WorkspaceBindingDisplay {
  canonicalRoot: string;
  createdAt: string;
}

export interface ConversationProject {
  id: string;
  title: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSessionSummary {
  id: string;
  title: string;
  projectId?: string;
  profileId?: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  createdAt: string;
  updatedAt: string;
}

/** Compact Session facts for navigation; reading these does not start a run. */
export interface ConversationSessionStatus {
  sessionId: string;
  revision: number;
  run: Pick<RunProjection, 'runId' | 'status' | 'waitingReason'> | null;
}

export interface ConversationCatalog {
  projects: ConversationProject[];
  sessions: ConversationSessionSummary[];
}

export interface ConversationCatalogManagement extends ConversationCatalog {
  workspaces: WorkspaceManagementRecord[];
}

/**
 * Message-level reference to a Host-resolved filesystem object. Host canonical paths remain
 * private; Provider requests receive the corresponding logical workspace handle and path.
 */
export type FilesystemReference = {
  referenceId: string;
  workspaceId: string;
  logicalPath: string;
  displayName: string;
} & (
  | {
      kind: 'file';
      mediaType: string;
      byteLength: number;
      source?: 'pastedText';
    }
  | {
      kind: 'directory';
      mediaType?: never;
      byteLength?: never;
    }
);

export type PluginUri = `plugin://${string}@${string}`;

export interface PluginCatalogItem {
  source: 'builtin' | 'mounted';
  category: 'functional' | 'reference';
  management?: {key: 'plugins.disabled' | 'plugins.sources' | 'mcp.servers' | 'skills.mounts'; id: string; path?: string};
  contributionKind: 'skill' | 'mcp' | 'cli' | 'host';
  discovery: 'default' | 'searchOnly';
  reference?: {toolName:'skill.read'|'doc.read';name:string};
  uri: PluginUri;
  displayName: string;
  shortDescription: string;
  iconRef?: string;
  activationMediaTypes: string[];
  enabled: boolean;
  available: boolean;
  error?: LocalAgentError;
}

export interface PluginCatalogProjection {
  revision: string;
  plugins: PluginCatalogItem[];
}

export interface GuidanceReference {
  referenceId: string; uri: string; label: string; toolName: 'skill.read' | 'doc.read'; name: string;
}

export interface PluginSelectionInput {
  selectionId: string;
  uri: PluginUri;
  label: string;
}

export interface SelectedPluginSnapshot {
  catalogRevision: string;
  plugins: Array<{
    uri: PluginUri;
    pluginArtifactRef: string;
    pluginInstanceRef: string;
    extensionGenerationRef: string;
    capabilityRefs: string[];
  }>;
}

export type PlanOperationName =
  | 'fs.write'
  | 'fs.edit'
  | 'document.render'
  | 'browser.capture'
  | 'fs.delete'
  | 'bash'
  | 'powershell';

export type PlanOperation =
  | {
      workspaceId: string;
      operation: Exclude<PlanOperationName, 'fs.delete' | 'bash' | 'powershell'>;
      target: string;
      /** Omitted/file covers this file; directoryTree covers files beneath this directory. */
      targetKind?: 'file' | 'directoryTree';
    }
  | {
      workspaceId: string;
      operation: 'fs.delete';
      target: string;
      targetKind: 'file' | 'directoryTree';
    }
  | {
      workspaceId: string;
      operation: 'bash' | 'powershell';
      /** Representative project entrypoint, for review; Kernel applies configured Shell permissions. */
      command?: string;
      /** Source paths and output directories this operation may modify. */
      writablePaths: Array<{ path: string; kind: 'file' | 'directory' }>;
      terminal?: { stdin: string };
    };

export interface ExecutionPlanStep {
  stepId: string;
  /** Inline Markdown for display; stepId remains the task identity. */
  title: string;
  details: string;
  verification?: string[];
}

export interface ExecutionPlan {
  planId: string;
  revision: number;
  /** Inline Markdown, never an execution or authorization input. */
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  mutationManifest: PlanOperation[];
}

export type PlanResponse =
  | { kind: 'confirm' }
  | { kind: 'requestRevision'; text: string }
  | { kind: 'cancel' };

export type MessageFeedback = 'up' | 'down';

export interface HostWindowBinding { hostInstanceId: string; windowLabel: string }

export type ConversationCommand =
  | { schemaVersion: typeof CONVERSATION_COMMAND_VERSION; type: 'run.host.rebind'; commandId: string; sessionId: string; runId: string; expectedHostBinding: HostWindowBinding; hostBinding: HostWindowBinding }
  | { schemaVersion: typeof CONVERSATION_COMMAND_VERSION; type: 'session.permissions.set'; commandId: string; sessionId: string; patches: UserSettings }
  | { schemaVersion: typeof CONVERSATION_COMMAND_VERSION; type: 'approval.revoke'; commandId: string; sessionId: string; runId: string; authorityId: string }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'session.model-settings.set';
      commandId: string;
      sessionId: string;
      settings: SessionModelSettings;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'session.directory-index.attach';
      commandId: string;
      sessionId: string;
      workspaceBinding: WorkspaceBindingDisplay;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'session.directory-index.detach';
      commandId: string;
      sessionId: string;
      workspaceId: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'message.submit';
      commandId: string;
      sessionId: string;
      runId?: string;
      text: string;
      filesystemReferences?: FilesystemReference[];
      profileId?: string;
      reasoningEffortOverride?: LlmReasoningEffort | null;
      pluginCatalogRevision?: string;
      pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
      hostBinding?: { hostInstanceId: string; windowLabel: string };
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'context.focus';
      commandId: string;
      sessionId: string;
      task: string;
      filesystemReferences?: FilesystemReference[];
      profileId?: string;
      reasoningEffortOverride?: LlmReasoningEffort | null;
      pluginCatalogRevision?: string;
      pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
      hostBinding?: { hostInstanceId: string; windowLabel: string };
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'message.edit';
      commandId: string;
      sessionId: string;
      messageId: string;
      expectedRevision: number;
      text: string;
      hostBinding?: { hostInstanceId: string; windowLabel: string };
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'message.feedback.set';
      commandId: string;
      sessionId: string;
      messageId: string;
      feedback: MessageFeedback | null;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'run.cancel';
      commandId: string;
      sessionId: string;
      runId: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'interaction.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      interactionId: string;
      response: string;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'approval.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      callId: string;
      approvalId: string;
      decision: 'allow' | 'deny';
      authorizationScope?: ShellAuthorizationScope;
    }
  | {
      schemaVersion: typeof CONVERSATION_COMMAND_VERSION;
      type: 'plan.respond';
      commandId: string;
      sessionId: string;
      runId: string;
      planId: string;
      revision: number;
      response: PlanResponse;
    };

export interface CommandReply {
  schemaVersion: typeof COMMAND_REPLY_VERSION;
  commandId: string;
  sessionId: string;
  status: 'accepted' | 'replayed' | 'rejected';
  revision: number;
  error?: LocalAgentError;
}

interface SessionEventBase {
  schemaVersion: typeof SESSION_EVENT_VERSION;
  eventId: string;
  sessionId: string;
  sequence: number;
  occurredAt: string;
}

export type RunSettlement =
  | { outcome: 'completed'; finalMessageId: string }
  | { outcome: 'failed'; error: LocalAgentError }
  | { outcome: 'cancelled' }
  | { outcome: 'indeterminate'; error: LocalAgentError };

export type ProviderOutputBlock = {
  outputIndex: number;
  item: JsonObject;
} & (
  | { kind: 'reasoning' }
  | { kind: 'narrative'; narrativeId: string }
  | { kind: 'finalMessage'; messageId: string }
  | { kind: 'toolCall'; callId: string; providerCallId: string; toolName: string }
  | {
      /** Session rejected the original Provider input before requesting any effect. */
      kind: 'toolCallRejected';
      callId: string;
      providerCallId: string;
      /** Canonical name, or the original wire name when the tool is undeclared. */
      toolName: string;
      error: LocalAgentError & { issues: ToolInputIssue[] };
    }
  | {
      kind: 'providerHosted';
      activityId: string;
      providerCallId: string;
      providerToolType: 'web_search';
    }
);

/** Original aggregate Provider calls; rejected inputs never request a Kernel effect. */
export interface ProviderToolCallInput {
  callId: string;
  providerCallId: string;
  /** Canonical name, or the original wire name for provider_tool_alias_unknown. */
  toolName: string;
  arguments: string;
  error?: LocalAgentError & { issues: ToolInputIssue[] };
}

export type ProviderTurnSettlement = {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  providerRuntimeRef: string;
} & (
  | {
      outcome: 'completed';
      orderedCallIds: string[];
      reasoningContent?: string;
      reasoningSignature?: string;
      hostedWebSearchCalls?: JsonObject[];
      orderedOutputBlocks?: ProviderOutputBlock[];
      toolCallInputs?: ProviderToolCallInput[];
    }
  | {
      outcome: 'failed' | 'indeterminate';
      error: LocalAgentError;
    }
);

export interface RunRuntimeReleaseReceipt {
  runRuntimeSnapshotRef: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  providerRuntimeRef: string;
  pluginInstanceRefs: string[];
  alreadyReleased: boolean;
}

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ModelInteractionRequest {
  /** wait blocks immediately; continue leaves a question open during independent work. */
  mode?: 'wait' | 'continue';
  kind: 'question' | 'confirmation';
  prompt: string;
  options?: InteractionOption[];
  allowFreeform: boolean;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindowTokens: number;
  cacheReadInputTokens?: number;
  cacheMissInputTokens?: number;
}

export interface ContextUsageProjection extends ProviderTokenUsage {
  providerRequestId: string;
  providerRuntimeRef: string;
  runId: string;
  sequence: number;
  updatedAt: string;
}

export interface TokenUsageProjection {
  providerCallCount: number;
  reportedCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheMissInputTokens: number;
  cacheAvailable: boolean;
  cacheComplete: boolean;
  /** Known cache-read input tokens / all reported input tokens; coverage is cacheComplete. */
  cacheHitRatio: number | null;
}

export interface TokenUsageRoundProjection extends TokenUsageProjection {
  runId: string;
  inputMessageId: string;
  title: string;
  sequence: number;
  startedAt: string;
  completedAt?: string;
  outcome?: RunSettlement['outcome'];
}

export type ContextCompositionPartitionKind =
  | 'instructions'
  | 'workspaceBindings'
  | 'sessionControls'
  | 'journalMessages'
  | 'contextProviders'
  | 'filesystemReferences'
  | 'tools';

export interface ContextCompositionItem {
  itemId: string;
  label: string;
}

export interface ContextCompositionTool extends ContextCompositionItem {
  canonicalName: string;
  wireName: string;
  origin: 'coreBuiltin' | 'extension' | 'sessionControl' | 'providerHosted';
  availability: 'callable' | 'blocked';
  pluginUri?: PluginUri;
}

export type ContextCompositionMessageKind = Exclude<
  ContextCompositionPartitionKind,
  'filesystemReferences' | 'tools'
>;

export type ContextCompositionMessageBlock =
  | {
      blockIndex: number;
      kind: 'text' | 'reasoning';
    }
  | {
      blockIndex: number;
      kind: 'toolCall';
      callId: string;
      toolName: string;
    }
  | {
      blockIndex: number;
      kind: 'toolResult';
      resultForCallId: string;
    }
  | {
      blockIndex: number;
      kind: 'hostedWebSearch';
      providerCallId: string;
    };

export interface ContextCompositionMessage {
  messageIndex: number;
  contributionId: string;
  contributionKind: ContextCompositionMessageKind;
  label: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  blocks: ContextCompositionMessageBlock[];
  filesystemReferences: ContextCompositionItem[];
}

export interface ContextCompositionPartitionReceipt {
  kind: ContextCompositionPartitionKind;
  itemCount: number;
  requestShapeUnits: number;
}

export interface ContextCompositionPartitionProjection
  extends ContextCompositionPartitionReceipt {
  estimatedInputTokens?: number;
  tokenSource?: 'sessionEstimated';
}

export type ProviderResponseConstraint = 'normal' | 'answerOnly';

export interface ContextCompositionReceipt {
  kernelCatalogSnapshotRef?: string;
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  responseConstraint: ProviderResponseConstraint;
  dynamicInstructionBytes: number;
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionTool[];
  partitions: ContextCompositionPartitionReceipt[];
}

interface ContextCompositionProjectionBase {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  responseConstraint: ProviderResponseConstraint;
  runId: string;
  sequence: number;
  createdAt: string;
}

export interface ContextCompositionProjection extends ContextCompositionProjectionBase {
  kernelCatalogSnapshotRef?: string;
  dynamicInstructionBytes: number;
  messages: ContextCompositionMessage[];
  workspaceBindings: ContextCompositionItem[];
  tools: ContextCompositionTool[];
  partitions: ContextCompositionPartitionProjection[];
}

export type TodoStatus = 'pending' | 'inProgress' | 'completed' | 'blocked';

/** Agent-reported progress, independent of execution evidence and permission approval. */
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export interface TodoListProjection {
  runId: string;
  revision: number;
  items: TodoItem[];
  sequence: number;
  updatedAt: string;
}

export type ContextCompactionTrigger = 'pressure' | 'userFocus';

export type ContextCompactionRequestPayload = {
  compactionId: string;
  providerRequestId: string;
  coveredThroughSequence: number;
} & (
  | { trigger: 'pressure' }
  | { trigger: 'userFocus'; focus: string; commandId: string }
);

export interface ContextCompactedPayload {
  compactionId: string;
  providerRequestId: string;
  trigger: ContextCompactionTrigger;
  coveredThroughSequence: number;
  summary: string;
}

export interface ShellAuthorizationProjection {
  authorityId: string;
  runId: string;
  scope: ShellAuthorizationScope;
  summary: string;
  context: JsonObject;
}

export interface EffectPreview {
  approvalReviewer?: 'user' | 'agent';
  /** Exact Kernel-prepared operation; the agent's reason is not execution authority. */
  operation?: { toolName: string; arguments: JsonObject; workspaceRoot?: string; executionScope?: string };
  authorizationScopes?: ShellAuthorizationScope[];
  fileAccess?: { read: string[]; write: string[] };
  review?: { decision: 'allow' | 'deny' | 'ask'; reason: string };

  summary: string;
  effects: EffectKind[];
  logicalTargets: string[];
  /** An explicit browser grant applies to subsequent page operations in this Session. */
  authorizationScope?: 'sessionBrowser' | ShellAuthorizationScope;
  /** Kernel-owned binding for a reusable Host Shell grant. */
  authorizationContext?: JsonObject;
}

export type SessionEvent =
  | (SessionEventBase & { type: 'artifacts.presented'; runId: string; callId: string; payload: {
      providerCallId: string;
      items: Array<{ artifactId: string; label: string; deliveryId: string }>;
    } })
  | (SessionEventBase & { type: 'session.permissions.updated'; payload: { commandId: string; patches: UserSettings } })
  | (SessionEventBase & { type: 'approval.revoked'; runId: string; payload: { commandId: string; authorityId: string } })
  | (SessionEventBase & { type: 'approval.reviewed'; runId: string; callId: string; payload: { approvalId: string; providerRequestId: string; decision: 'allow' | 'deny' | 'ask'; reason: string } })
  | (SessionEventBase & { type: 'provider.attempt.updated'; runId: string; payload: ProviderAttemptFact })
  | (SessionEventBase & { type: 'run.failure.recorded'; runId: string; payload: RunFailureSnapshot })
  | (SessionEventBase & {
      type: 'conversation.revised';
      payload: { commandId: string; messageId: string; fromSequence: number; throughSequence: number };
    })
  | (SessionEventBase & {
      type: 'session.model-settings.updated';
      payload: { commandId: string; settings: SessionModelSettings };
    })
  | (SessionEventBase & {
      type: 'session.created';
      payload: {
        displayTitle: string;
        workspaceBindings: WorkspaceBindingDisplay[];
        profileId?: string;
      };
    })
  | (SessionEventBase & {
      type: 'session.directory-index.attached';
      payload: { workspaceBinding: WorkspaceBindingDisplay; commandId: string };
    })
  | (SessionEventBase & {
      type: 'session.directory-index.detached';
      payload: { workspaceId: string; commandId: string };
    })
  | (SessionEventBase & {
      type: 'input.queued';
      runId: string;
      payload: {
        interactionId?: string;
        pluginCatalogRevision?: string;
        commandId: string;
        messageId: string;
        text: string;
        filesystemReferences?: FilesystemReference[];
        pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
      };
    })
  | (SessionEventBase & {
      type: 'input.accepted';
      payload: {
        commandId: string;
        messageId: string;
        text: string;
        pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
      };
    })
  | (SessionEventBase & {
      type: 'run.host.rebound';
      runId: string;
      payload: { commandId: string; previousBinding: HostWindowBinding; hostBinding: HostWindowBinding; toolView: PreparedRequestToolView };
    })
  | (SessionEventBase & {
      type: 'run.tools.prepared';
      runId: string;
      payload: { toolView: PreparedRequestToolView };
    })
  | (SessionEventBase & {
      type: 'run.started';
      runId: string;
      payload: {
        inputMessageId: string;
        workspaceBindings: WorkspaceBindingDisplay[];
        runtimeSnapshot: RunRuntimeSnapshot;
      };
    })
  | (SessionEventBase & {
      type: 'message.committed';
      runId: string;
      callId?: string;
      payload: {
        messageId: string;
        role: 'assistant';
        content: string;
        filesystemReferences?: FilesystemReference[];
        pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
        providerRequestId: string;
      };
    })
  | (SessionEventBase & {
      type: 'message.committed';
      runId?: string;
      callId?: string;
      payload: {
        messageId: string;
        role: 'user' | 'tool' | 'system';
        content: string;
        filesystemReferences?: FilesystemReference[];
        pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
      };
    })
  | (SessionEventBase & {
      type: 'message.feedback.updated';
      payload: {
        commandId: string;
        messageId: string;
        feedback: MessageFeedback | null;
      };
    })
  | (SessionEventBase & {
      type: 'narrative.committed';
      runId: string;
      payload: { narrativeId: string; content: string; providerRequestId: string };
    })
  | (SessionEventBase & {
      type: 'interaction.requested';
      runId: string;
      callId: string;
      payload: ModelInteractionRequest & { interactionId: string; providerCallId: string };
    })
  | (SessionEventBase & {
      type: 'interaction.resolved';
      runId: string;
      payload: { interactionId: string; commandId: string; response: string };
    })
  | (SessionEventBase & {
      type: 'plan.published';
      runId: string;
      callId: string;
      payload: ExecutionPlan & { providerCallId: string };
    })
  | (SessionEventBase & {
      type: 'plan.confirmed';
      runId: string;
      callId: string;
      payload: {
        planId: string;
        revision: number;
        commandId: string;
        decisionId: string;
        source?: 'user' | 'agent';
        authorities: PlanAuthority[];
      };
    })
  | (SessionEventBase & {
      type: 'plan.revision.requested';
      runId: string;
      callId: string;
      payload: { planId: string; revision: number; commandId: string; text: string };
    })
  | (SessionEventBase & {
      type: 'plan.superseded';
      runId: string;
      payload: {
        planId: string;
        revision: number;
        supersededByPlanId: string;
        supersededByRevision: number;
      };
    })
  | (SessionEventBase & {
      type: 'plan.cancelled';
      runId: string;
      callId: string;
      payload: { planId: string; revision: number; commandId: string };
    })
  | (SessionEventBase & {
      type: 'plan.invalidated';
      runId: string;
      payload: { planId: string; revision: number; reason: string; sourceFactRef: string };
    })
  | (SessionEventBase & {
      type: 'todo.updated';
      runId: string;
      callId?: string;
      payload: {
        providerCallId?: string;
        revision: number;
        items: TodoItem[];
      };
    })
  | (SessionEventBase & {
      type: 'tool.requested';
      runId: string;
      callId: string;
      payload: {
        providerCallId: string;
        attemptId: string;
        toolName: string;
        input: JsonObject;
      };
    })
  | (SessionEventBase & {
      type: 'tool.started';
      runId: string;
      callId: string;
      payload: { attemptId: string; startedAt: string };
    })
  | (SessionEventBase & {
      type: 'approval.requested';
      runId: string;
      callId: string;
      payload: { approvalId: string; preview: EffectPreview };
    })
  | (SessionEventBase & {
      type: 'approval.resolved';
      runId: string;
      callId: string;
      payload: {
        approvalId: string;
        commandId: string;
        decision: 'allow' | 'deny';
        authorityId: string;
        source?: 'user' | 'agent';
        reason?: string;
        authorizationScope?: ShellAuthorizationScope;
      };
    })
  | (SessionEventBase & {
      type: 'tool.input-rejected';
      runId: string;
      callId: string;
      payload: { rejection: ToolInputRejection };
    })
  | (SessionEventBase & {
      type: 'tool.interrupted';
      runId: string;
      callId: string;
      /** Session disposition after runtime release; it does not assert a Kernel effect outcome. */
      payload: { attemptId: string; error: LocalAgentError };
    })
  | (SessionEventBase & {
      type: 'process.updated';
      runId: string;
      callId: string;
      payload: { job: ManagedProcessSnapshot };
    })
  | (SessionEventBase & {
      type: 'tool.completed';
      runId: string;
      callId: string;
      payload: { record: ToolExecutionRecord };
    })
  | (SessionEventBase & {
      type: 'session.plugins.activated';
      runId: string;
      callId: string;
      payload: { providerCallId: string; pluginUris: string[] };
    })
  | (SessionEventBase & {
      type: 'session.control.rejected';
      runId: string;
      callId: string;
      payload: {
        providerCallId: string;
        toolName: string;
        input: JsonObject;
        error: LocalAgentError;
      };
    })
  | (SessionEventBase & {
      type: 'context.compaction.requested';
      runId: string;
      payload: ContextCompactionRequestPayload;
    })
  | (SessionEventBase & {
      type: 'context.compacted';
      runId: string;
      payload: ContextCompactedPayload;
    })
  | (SessionEventBase & {
      type: 'context.composed';
      runId: string;
      payload: ContextCompositionReceipt;
    })
  | (SessionEventBase & {
      type: 'provider.turn.settled';
      runId: string;
      payload: ProviderTurnSettlement;
    })
  | (SessionEventBase & {
      type: 'context.updated';
      runId: string;
      payload: ProviderTokenUsage & { providerRequestId: string; providerRuntimeRef: string };
    })
  | (SessionEventBase & {
      type: 'run.waiting';
      runId: string;
      payload: { reason: 'approval' | 'userInput' | 'plan'; detail?: string };
    })
  | (SessionEventBase & {
      type: 'run.finishing';
      runId: string;
      payload: RunSettlement;
    })
  | (SessionEventBase & {
      type: 'run.runtime.released';
      runId: string;
      payload: RunRuntimeReleaseReceipt;
    })
  | (SessionEventBase & {
      type: 'run.runtime.release_failed';
      runId: string;
      payload: {
        runRuntimeSnapshotRef: string;
        extensionGenerationRef: string;
        kernelCatalogSnapshotRef: string;
        providerRuntimeRef: string;
        error: LocalAgentError;
      };
    })
  | (SessionEventBase & {
      type: 'run.settled';
      runId: string;
      payload: RunSettlement;
    });

export type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'sequence' | 'occurredAt'>
    : never
  : never;

export interface SourceReferences {
  citations: Array<{ url: string; title: string }>;
  unresolved: boolean;
}

interface ProjectionMessageBase {
  messageId: string;
  content: string;
  /** Session-derived citation display. Original Provider text remains in content. */
  displayContent?: string;
  sourceReferences?: SourceReferences;
  filesystemReferences: FilesystemReference[];
  pluginSelections: PluginSelectionInput[];
  guidanceReferences?: GuidanceReference[];
  feedback: MessageFeedback | null;
  sequence: number;
  createdAt: string;
  /** Derived from the matching input command and resolved interaction in the Session journal. */
  replyToInteraction?: { interactionId: string; prompt: string };
}

export type ProjectionMessage = ProjectionMessageBase & (
  | {
      role: 'assistant';
      runId: string;
      providerRequestId: string;
    }
  | {
      role: 'user' | 'tool' | 'system';
      runId?: string;
      providerRequestId?: never;
    }
);

export interface NarrativeProjection {
  narrativeId: string;
  runId: string;
  providerRequestId: string;
  content: string;
  displayContent?: string;
  sourceReferences?: SourceReferences;
  sequence: number;
  createdAt: string;
}

export type SessionTimelineItem =
  | {
      kind: 'message';
      timelineId: string;
      sequence: number;
      messageId: string;
      /** Required for assistant text; absent for user messages. */
      streamId?: string;
      outputIndex?: number;
    }
  | {
      kind: 'narrative';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      narrativeId: string;
      streamId: string;
      outputIndex?: number;
    }
  | {
      kind: 'plan';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      planId: string;
      revision: number;
    }
  | {
      kind: 'toolGroup';
      timelineId: string;
      sequence: number;
      providerRequestId: string;
      activityIds: string[];
    };

export interface InteractionProjection extends ModelInteractionRequest {
  status: 'pending' | 'answered' | 'closed';
  response?: string;
  interactionId: string;
  runId: string;
  callId: string;
  sequence: number;
  createdAt: string;
}

export interface ApprovalProjection {
  approvalId: string;
  runId: string;
  callId: string;
  preview: EffectPreview;
  sequence: number;
  createdAt: string;
}

export type AssistantDraftBlockProjection =
  | {
      kind: 'narrative' | 'finalMessage' | 'message';
      content: string;
      /** Stable prefix while a Provider citation is awaiting its final annotations. */
      displayContent?: string;
      /** Opaque Session-owned identity shared with the committed timeline text. */
      streamId: string;
      /** Present only when the Provider supplied a native output index. */
      outputIndex?: number;
    }
  | {
      outputIndex: number;
      kind: 'providerHosted';
      providerCallId: string;
      providerToolType: 'web_search';
      status: 'completed' | 'failed';
      /** Present only when supplied by the Provider. */
      action?: JsonObject;
    };

/** Session-owned, non-durable presentation for the one Provider turn currently streaming. */
export interface AssistantDraftProjection {
  runId: string;
  turnId: string;
  /** Session orders these blocks. An empty list can still carry Provider activity. */
  blocks: AssistantDraftBlockProjection[];
  activity?: ProviderActivityProjection;
  /** Display only; not a published plan or authority to execute. */
  planPreview?: PlanPreviewProjection;
}

export interface PlanPreviewProjection {
  callIndex: number;
  providerCallId: string;
  outputIndex?: number;
  title: string;
  summary: string;
  steps: string[];
  truncated: boolean;
}

export interface ProviderActivityProjection {
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  phase: 'waitingResponse' | 'reasoning' | 'awaitingOutput' | 'generatingOutput';
  startedAt: string;
  lastContentAt?: string;
}

export type PlanProjectionStatus =
  | 'published'
  | 'revisionRequested'
  | 'confirmed'
  | 'superseded'
  | 'cancelled'
  | 'invalidated';

export interface PlanProjection extends ExecutionPlan {
  runId: string;
  callId: string;
  status: PlanProjectionStatus;
  confirmationSource?: 'user' | 'agent';
  decisionId?: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface PendingPlanProjection extends PlanProjection {
  status: 'published';
  responseMode: 'confirmReviseOrCancel';
}

export const RUN_PROJECTION_STATUSES = [
  'running',
  'waiting',
  'releasing',
  'releaseFailed',
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
] as const;

export type RunProjectionStatus = typeof RUN_PROJECTION_STATUSES[number];

export interface RunProjection {
  runId: string;
  /** Current GUI target, changed only by an explicit user rebind command. */
  hostBinding?: HostWindowBinding;
  profileId: string;
  reasoningEffort?: LlmReasoningEffort;
  thinking?: LlmThinkingMode;
  waitingReason?: 'approval' | 'userInput' | 'plan';
  /** Immutable effective directory set captured by run.started. */
  workspaceBindings: WorkspaceBindingDisplay[];
  status: RunProjectionStatus;
}

export interface ActivityProjection {
  activityId: string;
  kind: 'run' | 'tool' | 'providerHosted' | 'approval' | 'plan' | 'interaction';
  status:
    | 'active'
    | 'requested'
    | 'waiting'
    | 'completed'
    | 'denied'
    | 'rejected'
    | 'failed'
    | 'cancelled'
    | 'indeterminate';
  label: string;
  runId: string;
  callId?: string;
  sequence: number;
  startedAt?: string;
  /** Bounded live output, absent after settlement and never persisted in journal. */
  liveOutput?: ToolOutputProjection;
  tool?: ToolActivityProjection;
  inputRejection?: ToolInputRejection['error'];
  interruption?: LocalAgentError;
  providerHosted?: ProviderHostedActivityProjection;
}

export interface ToolOutputProjection {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
}

export interface ProviderHostedActivityProjection {
  providerToolType: 'web_search';
  providerCallId: string;
  /** Present only when supplied by the Provider. */
  action?: JsonObject;
}

export interface ActivityResourceProjection {
  kind: 'workspacePath' | 'url' | 'logicalTarget';
  label: string;
  workspaceId?: string;
  logicalPath?: string;
  uri?: string;
}

export interface ToolActivityProjection {
  recordId?: string;
  error?: LocalAgentError;
  /** Detail decoding failed; the execution status and original record are unchanged. */
  projectionError?: LocalAgentError;
  operation: string;
  resources: ActivityResourceProjection[];
  shell?: ShellActivityProjection;
  process?: ProcessActivityProjection;
  fileChanges?: FileChangeProjection[];
}

export interface FileChangeSide {
  exists: boolean;
  contentRef?: string;
  sizeBytes?: number;
  error?: string;
}
export interface FileChangeProjection {
  workspaceId: string;
  path: string;
  kind: 'create' | 'modify' | 'delete';
  before: FileChangeSide;
  after: FileChangeSide;
}

export interface ShellActivityProjection {
  command: string;
  cwd: string;
  executionScope: 'workspace' | 'host';
  terminal: boolean;
  result?: ShellActivityResultProjection;
}

export interface ShellActivityResultProjection {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  timedOut: boolean;
  truncated: boolean;
  capturedBytes: number;
  durationMs: number;
  environment: ShellExecutionEnvironmentProjection;
}

export interface ShellExecutionEnvironmentProjection {
  shell: string;
  interactive: boolean;
  executionScope: 'workspace' | 'host';
  terminal: boolean;
  /** Diagnostic recorded by the producer, preserved verbatim when reading history. */
  pathSource: string;
  /** Recorded diagnostic, not an authorization for a later invocation. */
  writeScope: string;
  homeWritable: boolean;
  networkAccess: boolean;
}

export interface ArtifactProjection {
  artifactId: string;
  label: string;
  sessionId: string;
  runId: string;
  callId: string;
  recordId: string;
  contentType: string;
  contentMode: 'fixed' | 'live';
  /** Kernel-observed content modification, when available. */
  modifiedAt?: string;
  resourceKey?: string;
  createdAt: string;
  sourcePage?: JsonObject;
  workspaceId?: string;
  logicalPath?: string;
  uri?: string;
}

export interface DeliverableProjection extends ArtifactProjection {
  deliveryId: string;
  presentationRunId: string;
  presentedAt: string;
  updatedAt: string;
  sequence: number;
}

export interface SessionDisplayProjection {
  creationTitle: string;
}

export interface SessionModelSettings {
  profileId: string;
  reasoningEffortOverride: LlmReasoningEffort | null;
}

export interface QueuedInputProjection {
  interactionId?: string;
  pluginCatalogRevision?: string;
  commandId: string;
  messageId: string;
  runId: string;
  text: string;
  filesystemReferences: FilesystemReference[];
  pluginSelections: PluginSelectionInput[];
  guidanceReferences?: GuidanceReference[];
  sequence: number;
  createdAt: string;
  /** A terminal run retains unconsumed input visibly without starting another run. */
  status: 'queued' | 'notApplied';
}

export interface SessionProjection {
  permissionOverrides: UserSettings;
  effectivePermissions: UserSettings | null;
  shellAuthorizations: ShellAuthorizationProjection[];
  providerAttempts?: Array<ProviderAttemptFact & { runId: string; updatedAt: string }>;
  failureSnapshot?: RunFailureSnapshot;
  modelSettings: SessionModelSettings | null;
  schemaVersion: typeof SESSION_PROJECTION_VERSION;
  sessionId: string;
  revision: number;
  display: SessionDisplayProjection;
  /** Current effective set: immutable creation bindings plus attached directory indexes. */
  workspaceBindings: WorkspaceBindingDisplay[];
  /** Session-private directory indexes that the user may detach for future runs. */
  sessionDirectoryIndexes: WorkspaceBindingDisplay[];
  messages: ProjectionMessage[];
  queuedInputs: QueuedInputProjection[];
  narratives: NarrativeProjection[];
  /** Session-owned semantic transcript order. Shells render this list without re-sorting it. */
  timeline: SessionTimelineItem[];
  assistantDraft: AssistantDraftProjection | null;
  interactions: InteractionProjection[];
  /** Current reply target, derived from interactions. Only run.status indicates whether the Loop waits. */
  pendingInteraction: InteractionProjection | null;
  pendingApproval: ApprovalProjection | null;
  plans: PlanProjection[];
  activePlanRef: { planId: string; revision: number } | null;
  pendingPlan: PendingPlanProjection | null;
  todoList: TodoListProjection | null;
  contextUsage: ContextUsageProjection | null;
  /** Composition for the displayed Agent usage plus the latest composition; history is read on demand. */
  contextCompositions: ContextCompositionProjection[];
  tokenUsage: TokenUsageProjection;
  tokenUsageHistory: TokenUsageRoundProjection[];
  run: RunProjection | null;
  activities: ActivityProjection[];
  fileChangeRounds?: Array<{ runId: string; recordIds: string[] }>;
  artifacts: ArtifactProjection[];
  deliverables: DeliverableProjection[];
  terminalError: LocalAgentError | null;
}

export interface ConversationPort {
  submit(command: ConversationCommand): Promise<CommandReply>;
  /** Read persisted history or a live snapshot without opening an Actor or writing events. */
  snapshot(sessionId: string): Promise<SessionProjection>;
  /** Read sidebar status without resuming a conversation. */
  statuses(sessionIds: readonly string[]): Promise<ConversationSessionStatus[]>;
  contextComposition(sessionId: string, providerRequestId: string): Promise<ContextCompositionProjection>;
  read(query: ConversationReadQuery): Promise<ConversationReadResult>;
}

export interface ConversationReadQuery {
  sessionId: string;
  view?: 'summary' | 'messages' | 'tools' | 'plans' | 'context' | 'reasoning' | 'images';
  imageIds?: string[];
  offset?: number;
  before?: number;
  limit?: number;
  recordId?: string;
  providerRequestId?: string;
}

/** A bounded journal read. Reading does not open/recover an Actor or run a Provider. */
export interface ConversationReadResult {
  sessionId: string;
  revision: number;
  view: NonNullable<ConversationReadQuery['view']>;
  summary?: JsonObject;
  items: JsonObject[];
  nextBefore: number | null;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Immutable sources; Kernel resolves bytes at the Provider transport boundary. */
  toolImages?: readonly { callId: string; artifactId: string }[];
  images?: readonly { workspaceId: string; logicalPath: string; mediaType: string }[];
  reasoningContent?: string;
  reasoningSignature?: string;
  toolCallId?: string;
  providerCallId?: string;
  toolCalls?: readonly ModelToolCall[];
  providerItems?: readonly JsonObject[];
  providerOutputBlocks?: readonly ProviderOutputBlock[];
}

export interface ModelToolCall {
  callId: string;
  providerCallId: string;
  name: string;
  input: JsonObject | string;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface ProviderRuntimeSnapshot {
  providerRuntimeRef: string;
  profileId: string;
  reasoningEffort?: LlmReasoningEffort;
  reasoningEffortOverride?: LlmReasoningEffort;
  thinking?: LlmThinkingMode;
  contextWindowTokens: number;
  maxOutputTokens: number;
  apiSurface: 'chatCompletions' | 'responses' | 'anthropicMessages' | 'ollamaChat';
  hostedWebSearch: 'none' | 'web_search';
}

export type WebSearchBinding =
  | { owner: 'providerHosted'; providerToolType: 'web_search' }
  | { owner: 'kernelAdapter'; toolName: 'web.search' }
  | { owner: 'unavailable' };

export interface ProviderHostedToolDefinition {
  type: 'webSearch';
  providerToolType: 'web_search';
}

export interface ProviderRequest {
  providerAttemptId?: string;
  attempt?: number;
  protocolVersion: typeof LOCAL_AGENT_PROTOCOL_VERSION;
  requestId: string;
  sessionId: string;
  runId: string;
  providerRuntimeRef: string;
  profileId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  responseConstraint: ProviderResponseConstraint;
  maxOutputTokens: number;
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  messages: readonly ModelMessage[];
  tools: readonly ProviderToolDefinition[];
  hostedTools: readonly ProviderHostedToolDefinition[];
}

export type ProviderEvent = { providerAttemptId?: string } & (
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'tool.call.delta';
      data: { callIndex: number; callId: string; name: string; argumentsDelta: string; outputIndex?: number };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'text.delta';
      data: { text: string; outputIndex?: number };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'reasoning.delta';
      data: { text: string; outputIndex?: number; kind?: 'text' | 'summary' };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'output.item.completed';
      data: { outputIndex: number; item: JsonObject };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'assistant.message';
      data: {
        messageId: string;
        content: string;
        reasoningContent?: string;
        reasoningSignature?: string;
      };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'tool.call';
      data: { callId: string; name: string } & ({ input: JsonObject; arguments?: never } | { arguments: string; input?: never });
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'hosted.web-search.completed';
      data: { item: JsonObject };
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'completed';
      data: JsonObject;
    }
  | {
      schemaVersion: typeof PROVIDER_EVENT_VERSION;
      requestId: string;
      type: 'failed';
      data: LocalAgentError;
    });

export interface ProviderPort {
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export type EffectKind =
  | 'localRead'
  | 'workspaceRead'
  | 'workspaceMutation'
  | 'process'
  | 'network'
  | 'external';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonObject;
  possibleEffects: EffectKind[];
  availability: 'callable' | 'blocked';
}

export interface PreparedToolDescriptor extends ToolDescriptor {
  toolBindingRef: string;
  origin: 'coreBuiltin' | 'extension';
  pluginUri?: PluginUri;
}

export interface ToolPromptContribution {
  contributionRef: string;
  canonicalToolName: string;
  promptSnippet?: string;
  usageGuidelines: string[];
}

export type ToolPromptProviderSnapshot = {
  providerRef: string;
  contributions: ToolPromptContribution[];
} & (
  | {
      origin: 'coreBuiltin';
      pluginUri?: never;
    }
  | {
      origin: 'extension';
      pluginUri: PluginUri;
    }
);

export type PreparedToolPromptContribution = ToolPromptContribution & {
  preparedToolBindingRef: string;
} & (
  | {
      origin: 'coreBuiltin';
      pluginUri?: never;
    }
  | {
      origin: 'extension';
      pluginUri: PluginUri;
    }
);

export interface ProviderToolAlias {
  canonicalName: string;
  wireName: string;
}

export interface RunRuntimeSnapshot {
  permissions: UserSettings;
  environment: JsonObject;
  runRuntimeSnapshotRef: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  provider: ProviderRuntimeSnapshot;
  /** Frozen execution-permission reviewer, independent of the conversation request. */
  approvalReviewer?: ProviderRuntimeSnapshot;
  /** Frozen preparation failure, reported only when this run needs delegated review. */
  approvalReviewerError?: LocalAgentError;
  webSearch: WebSearchBinding;
  instructions: { id: string; text: string }[];
  tools: PreparedToolDescriptor[];
  toolPromptContributions: PreparedToolPromptContribution[];
  providerToolAliases: ProviderToolAlias[];
  selectedPlugins: SelectedPluginSnapshot;
}

export function providerRuntimeForPurpose(runtime: RunRuntimeSnapshot,
  purpose: ProviderRequest['purpose']): ProviderRuntimeSnapshot {
  return purpose === 'approvalReview' ? runtime.approvalReviewer ?? runtime.provider : runtime.provider;
}

/** Immutable tool contribution view; Provider and workspace settings remain run-owned. */
export type PreparedRequestToolView = Pick<RunRuntimeSnapshot,
  'extensionGenerationRef' | 'kernelCatalogSnapshotRef' | 'instructions' | 'tools'
  | 'toolPromptContributions' | 'providerToolAliases' | 'selectedPlugins'>;

export interface PrepareRunRuntimeRequest {
  rebindHost?: { commandId: string; expectedBinding: HostWindowBinding; hostBinding: HostWindowBinding };
  /** Refresh previously selected sources; disabled/removed sources withdraw at this request boundary. */
  refreshPlugins?: boolean;
  environment?: JsonObject;
  hostBinding?: { hostInstanceId: string; windowLabel: string };
  restoreEnvironment?: boolean;
  sessionId: string;
  runId: string;
  profileId?: string;
  reasoningEffortOverride?: LlmReasoningEffort;
  pluginCatalogRevision?: string;
  pluginSelections?: PluginSelectionInput[];
      guidanceReferences?: GuidanceReference[];
}

export interface PreparedRunRuntime {
  runtimeSnapshot: RunRuntimeSnapshot;
}

export interface ReleaseRunRuntimeRequest {
  sessionId: string;
  runId: string;
  kernelCatalogSnapshotRef: string;
}

export interface ReleaseRunRuntimeResult {
  kernelCatalogSnapshotRef: string;
  alreadyReleased: boolean;
}

/** Host composition root owns atomic run preparation across Provider and Kernel generations. */
export interface RunPreparationPort {
  prepare(request: PrepareRunRuntimeRequest): Promise<PreparedRunRuntime>;
  release(request: ReleaseRunRuntimeRequest): Promise<ReleaseRunRuntimeResult>;
}

export interface PlanAuthority {
  authorityId: string;
  planId: string;
  revision: number;
  decisionId: string;
  sessionId: string;
  runId: string;
  workspaceId: string;
  coveredOperations: PlanOperation[];
}

export interface PreparedEffectProjection {
  callId: string;
  attemptId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  contributionRef: string;
  providerRef: string;
  origin: 'coreBuiltin' | 'extension';
  pluginInstanceRef?: string;
  toolName: string;
  workspaceId?: string;
  processWorkspaceMode?: 'read' | 'write';
  processExecutionScope?: 'workspace' | 'host';
  operation: string;
  logicalTargets: string[];
  canonicalInvocation: {
    toolName: string;
    arguments: JsonObject;
  };
}

export interface ToolExecutionRequest {
  schemaVersion: typeof KERNEL_REQUEST_VERSION;
  type: 'tool.execute';
  requestId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: JsonObject;
  workspaceBindings: string[];
  planAuthorities?: PlanAuthority[];
  nonWorkspaceAuthority?: {
    authorityId: string;
    decision: 'allow' | 'deny';
  };
}

export type WorkspaceAuthorityDecision =
  | { decision: 'allow'; source: 'workspaceBinding'; workspaceId: string }
  | {
      decision: 'allow';
      source: 'plan';
      workspaceId: string;
      authorityId: string;
      planId: string;
      revision: number;
      decisionId: string;
      writablePaths?: Array<{ path: string; kind: 'file' | 'directory' }>;
    }
  | {
      decision: 'allow';
      source: 'userSetting';
      authorityId: string;
      workspaceId: string;
    };

export type NonWorkspaceAuthorityDecision =
  | { decision: 'allow'; source: 'user' | 'agent' | 'userSetting'; authorityId: string; authorizationScope?: 'sessionBrowser' | ShellAuthorizationScope }
  | { decision: 'deny'; source: 'user'; authorityId: string }
  | { decision: 'deny'; source: 'kernel' | 'userSetting'; reason: string };

export type AuthorityDecision =
  | { decision: 'allow'; source: 'localRead' }
  | WorkspaceAuthorityDecision
  | NonWorkspaceAuthorityDecision
  | {
      decision: 'allow' | 'deny';
      source: 'composite';
      workspaceAuthority: WorkspaceAuthorityDecision;
      externalAuthority: NonWorkspaceAuthorityDecision;
    };

interface ToolExecutionRecordBase {
  recordId: string;
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: JsonObject;
  preparedEffect: PreparedEffectProjection;
  authority: AuthorityDecision;
  startedAt: string;
  completedAt: string;
}

export type ToolExecutionRecord =
  | (ToolExecutionRecordBase & { outcome: 'completed'; output: unknown })
  | (ToolExecutionRecordBase & { outcome: 'denied'; error?: LocalAgentError })
  | (ToolExecutionRecordBase & { outcome: 'failed'; output?: unknown; error: LocalAgentError })
  | (ToolExecutionRecordBase & { outcome: 'cancelled' })
  | (ToolExecutionRecordBase & { outcome: 'indeterminate'; output?: unknown; error: LocalAgentError });

export interface ToolInputIssue {
  path: string;
  rule: string;
  message: string;
  expected?: unknown;
}

/** Kernel input rejection before effect preparation or execution; journaled by Session. */
export interface ToolInputRejection extends Omit<ToolExecutionRecordBase, 'recordId' | 'preparedEffect' | 'authority' | 'startedAt' | 'completedAt'> {
  rejectedAt: string;
  error: LocalAgentError & { issues: ToolInputIssue[] };
}

export type ToolExecutionReply =
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.execution';
      requestId: string;
      callId: string;
      status: 'inputRejected';
      rejection: ToolInputRejection;
    }
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.execution';
      requestId: string;
      callId: string;
      status: 'approvalRequired';
      approvalId: string;
      preview: EffectPreview;
    }
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.execution';
      requestId: string;
      callId: string;
      status: ToolExecutionRecord['outcome'];
      record: ToolExecutionRecord;
    };

export type ToolCancelReply =
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.cancelled';
      requestId: string;
      callId: string;
      attemptId: string;
      status: 'notFound';
    }
  | {
      schemaVersion: typeof KERNEL_REPLY_VERSION;
      type: 'tool.cancelled';
      requestId: string;
      callId: string;
      attemptId: string;
      status: ToolExecutionRecord['outcome'];
      record: ToolExecutionRecord;
    };

export type ToolExecutionProgress =
  | { type: 'started'; startedAt: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; offset: number; bytes: number[] };

/** Current-run execution facts published by Kernel, independent of the start receipt. */
export interface ManagedProcessSnapshot {
  jobId: string;
  sessionId: string;
  runId: string;
  callId: string;
  revision: number;
  toolName: 'bash' | 'powershell' | 'container';
  command: string;
  targets: string[];
  status: 'active' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  lastOutputAt?: string;
  completedAt?: string;
  output: ToolOutputProjection;
  result?: unknown;
  error?: LocalAgentError;
}

export interface ProcessActivityProjection {
  jobId: string;
  command: string;
  output: ToolOutputProjection;
  result?: { exitCode: number | null; durationMs: number; timedOut: boolean };
}

export interface ProcessReadRequest {
  sessionId: string;
  runId: string;
  revisions?: Record<string, number>;
  waitMs?: number;
  cancel?: boolean;
}

export interface KernelPort {
  readProcesses(request: ProcessReadRequest, signal?: AbortSignal): Promise<ManagedProcessSnapshot[]>;
  execute(request: ToolExecutionRequest, onProgress?: (progress: ToolExecutionProgress) => Promise<void>): Promise<ToolExecutionReply>;
  cancel(callId: string, attemptId: string): Promise<ToolCancelReply>;
  readRecord(callId: string): Promise<ToolExecutionRecord | null>;
}

export interface JournalPort {
  append(event: NewSessionEvent): Promise<SessionEvent>;
  appendBatch(events: readonly NewSessionEvent[]): Promise<SessionEvent[]>;
  read(sessionId: string, afterSequence?: number): AsyncIterable<SessionEvent>;
}

export interface StoredCommand {
  command: ConversationCommand;
  reply: CommandReply;
}

export interface SessionCreationInput {
  sessionId: string;
  displayTitle: string;
  workspaceBindings: WorkspaceBindingDisplay[];
  profileId?: string;
}

/** Session journal owns atomic command admission; it is not a second state machine. */
export interface CommandJournalPort extends JournalPort {
  createSession(input: SessionCreationInput): Promise<SessionEvent>;
  deleteSession(sessionId: string): Promise<void>;
  readCommand(sessionId: string, commandId: string): Promise<StoredCommand | null>;
  commitCommand(
    command: ConversationCommand,
    events: readonly NewSessionEvent[],
    reply: Omit<CommandReply, 'revision'>,
  ): Promise<CommandReply>;
}
