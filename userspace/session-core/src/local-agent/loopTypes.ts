import type {
  SessionEvent, RunSettlement, AgentOperation, JsonObject, SessionOperation, NewSessionEvent,
  AssistantDraftProjection, ToolExecutionProgress, ProviderTokenUsage, ProviderOutputBlock,
  ProviderToolCallInput, LocalAgentError, ModelInteractionRequest,
} from '@achbit/protocol';
import type { SessionState } from './reducer.js';
import type { AgentComposition, RunActivity } from './plugins.js';
import type { SessionCapabilityManager } from './sessionCapabilities.js';
import type { AgentWait } from './agentManager.js';
import type { ControlWait } from './sessionWake.js';
import type {
  SessionControlCall, ArtifactPresentationInput, PlanPublicationDraft, PlanScopeExtension,
} from './sessionControls.js';

export interface LoopSnapshot {
  journalEvents: readonly SessionEvent[];
  events: readonly SessionEvent[];
  state: SessionState;
}

export type LoopCommand =
  | { type: 'start'; runId: string }
  | { type: 'resume'; runId: string }
  | { type: 'recover'; runId: string }
  | { type: 'fail'; runId: string; error: unknown }
  | { type: 'cancel'; runId: string };

export type LoopResult =
  | { status: 'suspended'; runId: string }
  | {
      status: 'waiting';
      runId: string;
      reason: 'approval' | 'userInput' | 'plan';
      callId?: string;
      interactionId?: string;
      planId?: string;
    }
  | {
      status: 'settled';
      runId: string;
      outcome: 'completed' | 'failed' | 'cancelled' | 'indeterminate';
    }
  | {
      status: 'finishing';
      runId: string;
      settlement: RunSettlement;
    };

export interface AgentLoopDeps {
  composition: AgentComposition;
  capabilities?: SessionCapabilityManager;
  readSnapshot(): Promise<LoopSnapshot>;
  waitForChange?(revision: number, signal: AbortSignal, permissions?: SessionState['publishedPermissions']): Promise<void>;
  activity?: RunActivity;
  agents?: {
    execute(runId: string, callId: string, operation: AgentOperation, signal: AbortSignal): Promise<JsonObject>;
    wait(runId: string, signal: AbortSignal, acceptedWait?: AgentWait): Promise<void>;
  };
  sessionOperation?(runId: string, operation: SessionOperation, signal: AbortSignal): Promise<JsonObject>;
  waitForInput?(runId: string, wait: ControlWait, signal: AbortSignal): Promise<JsonObject>;
  commit(event: NewSessionEvent | readonly NewSessionEvent[] | ((current: LoopSnapshot) => readonly NewSessionEvent[])): Promise<LoopSnapshot>;
  takeQueuedInputs(runId: string): Promise<LoopSnapshot>;
  updateAssistantDraft(draft: AssistantDraftProjection | null): void;
  recordVisibleResponse?(runId: string): Promise<void>;
  resetReasoning?(): void;
  updateReasoning?(requestId: string, runId: string, text: string, kind: 'text' | 'summary'): void;
  updateToolProgress?(callId: string, progress: ToolExecutionProgress): void;
  nextId(kind: string): string;
}

type ProviderTurnCommon = {
  completion: ProviderTurnCompletion;
  narratives?: Array<{ narrativeId: string; content: string }>;
  contextUsage?: ProviderTokenUsage & {
    providerRequestId: string;
    providerRuntimeRef: string;
  };
};

export interface ProviderTurnCompletion {
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction' | 'approvalReview';
  providerRuntimeRef: string;
  orderedCallIds: string[];
  reasoningContent?: string;
  reasoningSignature?: string;
  hostedWebSearchCalls?: JsonObject[];
  orderedOutputBlocks?: ProviderOutputBlock[];
  toolCallInputs?: ProviderToolCallInput[];
}

export type DecodedProviderOutputBlock = {
  outputIndex: number;
  item: JsonObject;
} & (
  | { kind: 'reasoning'; content: string }
  | { kind: 'message'; content: string }
  | {
      kind: 'toolCall';
      providerCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: 'toolCallRejected';
      providerCallId: string;
      name: string;
      error: Extract<ProviderOutputBlock, { kind: 'toolCallRejected' }>['error'];
    }
  | { kind: 'providerHosted'; providerCallId: string }
);

export interface ExpectedToolRecordIdentity {
  sessionId: string;
  runId: string;
  extensionGenerationRef: string;
  kernelCatalogSnapshotRef: string;
  toolBindingRef: string;
  callId: string;
  attemptId: string;
  toolName: string;
  input: Record<string, unknown>;
}

type ProviderTodoUpdate = Extract<SessionControlCall, { kind: 'todoUpdate' }> & {
  providerCallId: string;
};

export interface ProviderControlRejection {
  callId: string;
  providerCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  error: LocalAgentError;
}

export type ProviderDispatchCall = {
  callId: string;
  providerCallId: string;
  name: string;
  input: Record<string, unknown>;
} & ({ owner: 'kernel' } | { owner: 'agent'; operation: AgentOperation } | { owner: 'rejected'; error: LocalAgentError });

export type ProviderTurn =
  | ({ kind: 'agent'; callId: string; providerCallId: string; operation: AgentOperation } & ProviderTurnCommon)
  | ({ kind: 'session'; callId: string; providerCallId: string; operation: SessionOperation } & ProviderTurnCommon)
  | ({ kind: 'artifactPresent'; callId: string; providerCallId: string; items: ArtifactPresentationInput[] } & ProviderTurnCommon)
  | ({ kind: 'pluginActivate'; callId: string; providerCallId: string; pluginUris: string[] } & ProviderTurnCommon)
  | ({ kind: 'answer'; content: string; messageId?: string } & ProviderTurnCommon)
  | ({ kind: 'continuation' } & ProviderTurnCommon)
  | {
      kind: 'interaction';
      interactionId: string;
      callId: string;
      providerCallId: string;
      request: ModelInteractionRequest;
      narrative?: string;
    } & ProviderTurnCommon
  | ({
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft | PlanScopeExtension;
      providerCallId: string;
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'tools';
      calls: ProviderDispatchCall[];
      progress?: ProviderTodoUpdate | {
        kind: 'controlRejected';
        rejection: ProviderControlRejection;
      };
      narrative?: string;
    } & ProviderTurnCommon)
  | ({
      kind: 'controlRejected';
      rejection: ProviderControlRejection;
      narrative?: string;
    } & ProviderTurnCommon);
