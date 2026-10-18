import { permissionSettings, providerRuntimeForPurpose } from '@deepcode/protocol';
import { permissionInstructionText } from './skillPlugins.js';
import { prepareApprovalReview, decodeApprovalReview, ApprovalReviewFormatFailure } from './approvalReview.js';
import { withProviderAttempts } from './providerAttempts.js';
import { preparePlanReview } from './planReview.js';
import type {
  AgentOperation,
  SessionOperation,
  AssistantDraftBlockProjection,
  AssistantDraftProjection,
  JsonObject,
  KernelPort,
  LocalAgentError,
  ModelInteractionRequest,
  NewSessionEvent,
  PlanAuthority,
  ProviderTokenUsage,
  ProviderActivityProjection,
  ProviderEvent,
  ProviderOutputBlock,
  ProviderToolCallInput,
  ProviderRequest,
  RunSettlement,
  RunRuntimeSnapshot,
  SessionEvent,
  PreparedToolDescriptor,
  PreparedRunRuntime,
  PluginUri,
  ToolExecutionReply,
  ToolExecutionRecord,
  ToolInputRejection,
  ToolExecutionRequest,
  ToolExecutionProgress,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  KERNEL_REPLY_VERSION,
  KERNEL_REQUEST_VERSION,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_ARTIFACT_PRESENT,
  SESSION_CONTROL_AGENT,
  SESSION_CONTROL_SESSION,
} from '@deepcode/protocol';
import type { AgentComposition, SessionCapabilities } from './plugins.js';
import { createSessionCapabilities, type SessionCapabilityManager, type SessionCapabilityLease } from './sessionCapabilities.js';
import {
  pendingContextCompaction,
  type ContextCompactionRequestEvent,
} from './compaction.js';
import { errorFact, LoopFailure, ProviderCompletedFailure, ProviderReportedFailure } from './loopFailure.js';
import {
  canonicalJsonValue,
  decodeProviderToolInput,
  type ProviderToolCodec,
} from './providerToolCodec.js';
import { recoverSession, type SessionState } from './reducer.js';
import { activeConversationEvents } from './conversationHistory.js';
import { requestResourceBindings } from './workspaceBindings.js';
import { providerTextStreamId } from './streamIdentity.js';
import { PlanPreviewBuffer } from './planPreview.js';
import { confirmationFacts } from './planStage.js';
import { controlWait, pendingControlWait, type ControlWait } from './sessionWake.js';
import type { AgentWait } from './agentManager.js';
import type { ArtifactPresentationInput } from './sessionControls.js';
import {
  SessionControlError,
  type PlanPublicationDraft,
  type PlanScopeExtension,
  type SessionControlCall,
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
  syncProcesses?(): Promise<void>;
  waitProcesses?(signal: AbortSignal): Promise<void>;
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

interface ProviderTurnCompletion {
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

type DecodedProviderOutputBlock = {
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

interface ExpectedToolRecordIdentity {
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

interface ProviderControlRejection {
  callId: string;
  providerCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  error: LocalAgentError;
}

type ProviderDispatchCall = {
  callId: string;
  providerCallId: string;
  name: string;
  input: Record<string, unknown>;
} & ({ owner: 'kernel' } | { owner: 'agent'; operation: AgentOperation } | { owner: 'rejected'; error: LocalAgentError });

type ProviderTurn =
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

export async function runAgentLoop(
  initial: LoopSnapshot,
  command: LoopCommand,
  deps: AgentLoopDeps,
  signal: AbortSignal,
): Promise<LoopResult> {
  let snapshot = initial;
  const persist = deps.commit;
  deps = { ...deps, commit: async (event) => { snapshot = await persist(event); return snapshot; } };
  const runId = command.runId;
  const commit = async (
    event: NewSessionEvent | readonly NewSessionEvent[] | ((current: LoopSnapshot) => readonly NewSessionEvent[]),
  ): Promise<void> => {
    snapshot = await deps.commit(event);
  };

  if (hasSettlement(snapshot.events, runId)) return settlementResult(snapshot.events, runId);
  const interrupted = uncompletedProviderComposition(snapshot, runId);
  if (interrupted) {
    const settlement: RunSettlement = {
      outcome: 'indeterminate',
      error: {
        code: 'provider_turn_outcome_unknown',
        message: `Provider request ${interrupted.providerRequestId} 已组成上下文但没有持久化完成事实。`,
      },
    };
    await commit([
      providerTurnTerminalEvent(
        snapshot.state.sessionId,
        runId,
        interrupted,
        providerRuntimeForPurpose(runRuntimeSnapshot(snapshot, runId), interrupted.purpose).providerRuntimeRef,
        settlement,
      ),
      {
        type: 'run.finishing',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: settlement,
      },
    ]);
    return finishingResult(runId, settlement);
  }
  let runtime = runRuntimeSnapshot(snapshot, runId);
  try {
    if (command.type === 'fail') throw command.error;
    for (const requestEvent of pendingToolRequests(snapshot.events, runId)) {
      const existing = await deps.composition.kernel.readRecord(requestEvent.callId);
      if (existing) {
        await commitToolRecord(
          existing,
          expectedToolRecordIdentity(snapshot, requestEvent),
          commit,
        );
      }
    }

    if (command.type === 'recover') {
      const pending = pendingToolRequests(snapshot.events, runId);
      const unresolved = pending.find(request => {
        const approval = latestApproval(snapshot.events, runId, request.callId);
        return !approval.requested || approval.resolved;
      });
      if (unresolved) {
        await commit({
          type: 'run.finishing',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: {
            outcome: 'indeterminate',
            error: {
              code: 'tool_effect_outcome_unknown',
              message: `进程恢复时 Kernel 没有工具调用 ${unresolved.callId} 的确定记录。`,
            },
          },
        });
        return finishingResult(runId, {
          outcome: 'indeterminate',
          error: {
            code: 'tool_effect_outcome_unknown',
            message: `进程恢复时 Kernel 没有工具调用 ${unresolved.callId} 的确定记录。`,
          },
        });
      }
      if (pending.length) return { status: 'waiting', runId, reason: 'approval', callId: pending[0]!.callId };
    }

    if (command.type === 'cancel') return await cancelRun(snapshot, command, deps, commit);

    nextTurn: while (true) {
      throwIfAborted(signal);
      snapshot = await deps.readSnapshot();
      if (snapshot.state.pendingPlan?.review?.status === 'reviewing') {
        await reviewPendingPlan(deps, snapshot.state.pendingPlan, signal);
        snapshot = await deps.readSnapshot();
      }
      if (snapshot.state.pendingPlan) {
        const plan = snapshot.state.pendingPlan;
        if (snapshot.state.run?.status !== 'waiting') await commit({ type: 'run.waiting', sessionId: snapshot.state.sessionId, runId,
          payload: { reason: 'plan', detail: plan.title } });
        return { status: 'waiting', runId, reason: 'plan', planId: plan.planId };
      }
      const waiting = pendingControlWait(snapshot.events, runId);
      if (waiting) {
        const wait = controlWait(waiting.payload.result)!;
        if (waiting.type === 'session.control.completed') {
          if (!deps.waitForInput) throw new Error('session_operations_unavailable');
          await deps.waitForInput(runId, wait, signal);
        } else {
          if (!deps.agents) throw new Error('agent_manager_missing');
          const taskIds = waiting.payload.operation.action === 'spawn'
            ? [waiting.payload.result.taskId as string] : waiting.payload.operation.taskIds as string[] | undefined;
          await deps.agents.wait(runId, signal, { ...wait, ...(taskIds ? { taskIds } : {}) });
        }
        snapshot = await deps.readSnapshot();
      }
      const pendingCompaction = pendingContextCompaction(snapshot.events, runId);
      if (pendingCompaction) {
        await performContextCompaction(snapshot, pendingCompaction, runId, deps, signal, commit);
        continue;
      }
      const waitingForTools = await dispatchPendingTools(deps, runId, signal);
      if (waitingForTools) return waitingForTools;
      snapshot = await deps.readSnapshot();

      throwIfAborted(signal);
      snapshot = await deps.takeQueuedInputs(runId);
      runtime = runRuntimeSnapshot(snapshot, runId);
      throwIfAborted(signal);
      await deps.syncProcesses?.();
      snapshot = await deps.readSnapshot();
      try {
        await deps.composition.runPreparation.retireToolViews({
          sessionId: snapshot.state.sessionId, runId,
          keepKernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
        });
      } catch (error) {
        throw new ToolViewRetirementFailure(error);
      }
      const processRevisions = new Map(Object.values(snapshot.state.processes)
        .filter(job => job.runId === runId).map(job => [job.jobId, job.revision]));
      const agentEvidenceRevision = latestAgentEvidenceSequence(snapshot.events, runId);
      const lease = acquireCapabilities(deps);
      let requestFailure: { error: unknown } | undefined;
      try {
        const capabilities = lease.implementation;
        const preparedProviderRequest = await capabilities.context.prepare({
          sessionId: snapshot.state.sessionId,
          runId,
          runtime,
          events: snapshot.events,
          responseConstraint: 'normal',
          workspaceBindings: runWorkspaceBindings(snapshot, runId),
          providerRequestId: deps.nextId('provider-request'),
        }, signal);
        const pressureCutoff = capabilities.compaction.pressureCutoff(
          snapshot,
          runId,
          preparedProviderRequest.receipt,
          runtime,
        );
        if (pressureCutoff !== null) {
          throwIfAborted(signal);
          await commit({
            type: 'context.compaction.requested',
            sessionId: snapshot.state.sessionId,
            runId,
            payload: {
              compactionId: deps.nextId('compaction'),
              providerRequestId: deps.nextId('provider-request'),
              trigger: 'pressure',
              coveredThroughSequence: pressureCutoff,
            },
          });
          continue;
        }
        if (capabilities.compaction.estimateInput(snapshot, preparedProviderRequest.receipt, runtime) + runtime.provider.maxOutputTokens >= runtime.provider.contextWindowTokens) {
          throw new LoopFailure('context_input_budget_exceeded', '当前输入与工具定义加上输出预留已达到上下文预算；没有可继续压缩的历史。原始输入与资源保持完整。');
        }
        throwIfAborted(signal);
        await commit({
          type: 'context.composed',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: preparedProviderRequest.receipt,
        });
        const turn = await consumeProvider(
          preparedProviderRequest.request,
          preparedProviderRequest.toolCodec,
          runId,
          deps,
          signal,
          capabilities.controls,
        );
        const completionDerivedFacts: NewSessionEvent[] = [];
        const turnNarratives = [
          ...(turn.narratives ?? []),
          ...('narrative' in turn && turn.narrative
            ? [{ narrativeId: deps.nextId('narrative'), content: turn.narrative }]
            : []),
        ];
        for (const narrative of turnNarratives) {
          completionDerivedFacts.push({
            type: 'narrative.committed',
            sessionId: snapshot.state.sessionId,
            runId,
            payload: {
              narrativeId: narrative.narrativeId,
              content: narrative.content,
              providerRequestId: turn.completion.providerRequestId,
            },
          });
        }
        if (turn.contextUsage) {
          completionDerivedFacts.unshift({
            type: 'context.updated',
            sessionId: snapshot.state.sessionId,
            runId,
            payload: turn.contextUsage,
          });
        }
        switch (turn.kind) {
          case 'session': {
            let fact: NewSessionEvent;
            try {
              if (!deps.sessionOperation) throw new Error('session_operations_unavailable');
              const result = await deps.sessionOperation(runId, turn.operation, signal);
              fact = { type: 'session.control.completed', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
                payload: { providerCallId: turn.providerCallId, operation: { ...turn.operation }, result: turn.operation.action === 'wait'
                  ? { ...result, wait: { afterSequence: preparedProviderRequest.receipt.modelView!.throughSequence,
                    ...(turn.operation.timeoutSeconds === undefined ? {} : { deadline: Date.now() + Math.ceil(turn.operation.timeoutSeconds * 1000) }) } }
                  : result } };
            } catch (error) {
              signal.throwIfAborted();
              fact = controlRejectionFact(snapshot.state.sessionId, runId, { callId: turn.callId,
                providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_SESSION,
                input: { ...turn.operation }, error: localAgentError(error) });
            }
            await commit([fact, providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion), ...completionDerivedFacts]);
            break;
          }
          case 'agent': {
            const fact = await agentControlFact(deps, snapshot.state.sessionId, runId, runtime, turn,
              preparedProviderRequest.receipt.modelView!.throughSequence, signal);
            await commit([fact, providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion), ...completionDerivedFacts]);
            break;
          }
          case 'artifactPresent': {
            let fact: NewSessionEvent;
            try {
              fact = capabilities.controls.presentArtifacts(snapshot.state, runId, turn.callId, turn.providerCallId, turn.items, deps.nextId);
            } catch (error) {
              fact = controlRejectionFact(snapshot.state.sessionId, runId, { callId: turn.callId,
                providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_ARTIFACT_PRESENT,
                input: { items: turn.items }, error: localAgentError(error) });
            }
            await commit([fact, providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion), ...completionDerivedFacts]);
            break;
          }
          case 'pluginActivate': {
            let prepared: PreparedRunRuntime;
            try {
              const uris = [...new Set([...runtime.selectedPlugins.plugins.map(plugin => plugin.uri), ...turn.pluginUris])];
              prepared = await deps.composition.runPreparation.prepare({
                sessionId: snapshot.state.sessionId, runId, profileId: runtime.provider.profileId,
                environment: runtime.environment,
                ...(runtime.provider.reasoningEffortOverride ? { reasoningEffortOverride: runtime.provider.reasoningEffortOverride } : {}),
                pluginSelections: uris.map(uri => ({ selectionId: deps.nextId('plugin-selection'), uri: uri as PluginUri, label: uri.slice(0, 160) })),
              });
            } catch (error) {
              await commit([
                controlRejectionFact(snapshot.state.sessionId, runId, { callId: turn.callId,
                  providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_PLUGIN_ACTIVATE,
                  input: { pluginUris: turn.pluginUris }, error: localAgentError(error) }),
                providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
                ...completionDerivedFacts,
              ]);
              break;
            }
            const { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools,
              toolPromptContributions, providerToolAliases, selectedPlugins } = prepared.runtimeSnapshot;
            await commit([
              { type: 'session.plugins.activated', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
                payload: { providerCallId: turn.providerCallId, pluginUris: turn.pluginUris, kernelCatalogSnapshotRef } },
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
              { type: 'run.tools.prepared', sessionId: snapshot.state.sessionId, runId,
                payload: { toolView: { extensionGenerationRef, kernelCatalogSnapshotRef, instructions, tools,
                  toolPromptContributions, providerToolAliases, selectedPlugins } } },
            ]);
            break;
          }
          case 'continuation': {
            await commit([
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
            ]);
            break;
          }
          case 'interaction': {
            const interactionFact: NewSessionEvent = {
              type: 'interaction.requested',
              sessionId: snapshot.state.sessionId,
              runId,
              callId: turn.callId,
              payload: {
                interactionId: turn.interactionId,
                providerCallId: turn.providerCallId,
                ...turn.request,
              },
            };
            await commit([
              ...orderedProviderCallFacts(
                turn.completion,
                [interactionFact],
              ),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
              ...(turn.request.mode === 'continue' ? [] : [{
                type: 'run.waiting',
                sessionId: snapshot.state.sessionId,
                runId,
                payload: { reason: 'userInput', detail: turn.request.prompt },
              } as const]),
            ]);
            if (turn.request.mode === 'continue') break;
            return {
              status: 'waiting',
              runId,
              reason: 'userInput',
              interactionId: turn.interactionId,
            };
          }
          case 'plan': {
            let fact: NewSessionEvent = runRuntimeSnapshot(snapshot, runId).permissions['agent.permissions.workspaceMutation'] === 'allow'
              ? { type: 'session.control.rejected', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
                payload: { providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_PLAN_PUBLISH, input: { ...turn.draft },
                  error: { code: 'plan_disabled', message: 'Plan is off. Continue authorized work without publishing a Plan; execution permissions remain separate.' } } }
              : capabilities.controls.publishPlan(
                snapshot.state, runId, turn.callId, turn.providerCallId, turn.draft,
                runWorkspaceBindings(snapshot, runId).map((binding) => binding.workspaceId), deps.nextId,
              );
            let admission: Awaited<ReturnType<KernelPort['planAdmission']>> | undefined;
            if (fact.type === 'plan.published') {
              try {
                admission = await deps.composition.kernel.planAdmission({ sessionId: snapshot.state.sessionId,
                  runId, mutationManifest: fact.payload.mutationManifest });
                if (admission.workspaceRequests?.length) {
                  fact = { ...fact, payload: { ...fact.payload, workspaceRequests: admission.workspaceRequests } };
                }
              } catch (error) {
                if (!(error instanceof LoopFailure) || error.code !== 'plan_workspace_binding_invalid') throw error;
                fact = { type: 'session.control.rejected', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
                  payload: { providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_PLAN_PUBLISH,
                    input: { ...turn.draft }, error: errorFact(error) } };
              }
            }
            throwIfAborted(signal);
            // Publish the Plan and its admission together. Shells must never
            // observe an automatically accepted Plan as a pending user decision.
            await commit(current => [
              ...orderedProviderCallFacts(turn.completion, [fact]),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
              ...(fact.type !== 'plan.published' || !admission ? [] : admission.source === 'review'
                ? [{ type: 'plan.review.requested' as const, sessionId: current.state.sessionId, runId, callId: fact.callId,
                  payload: { planId: fact.payload.planId, revision: fact.payload.revision, providerRequestId: deps.nextId('provider-request') } }]
                : admission.source !== 'user'
                ? confirmationFacts(current.state, { ...fact.payload, runId, callId: fact.callId },
                  deps.nextId('plan-admission'), admission.source, deps.nextId, admission.authorities)
                : [{ type: 'run.waiting' as const, sessionId: current.state.sessionId, runId,
                  payload: { reason: 'plan' as const, detail: fact.payload.title } }]),
            ]);
            if (fact.type !== 'plan.published') break;
            if (admission?.source === 'review') continue nextTurn;
            if (snapshot.state.pendingPlan) return { status: 'waiting', runId, reason: 'plan', planId: fact.payload.planId };
            break;
          }
          case 'answer': {
            const messageId = turn.messageId ?? deps.nextId('message');
            const answerFacts: NewSessionEvent[] = [
              ...orderedProviderCallFacts(turn.completion, []),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
              { type: 'message.committed', sessionId: snapshot.state.sessionId, runId,
                payload: { messageId, role: 'assistant', content: turn.content,
                  providerRequestId: turn.completion.providerRequestId } },
            ];
            await deps.syncProcesses?.();
            snapshot = await deps.readSnapshot();
            const jobs = Object.values(snapshot.state.processes).filter(job => job.runId === runId);
            if (jobs.some(job => job.status === 'active' || job.revision !== processRevisions.get(job.jobId))) {
              await commit(answerFacts);
              await lease.release();
              await deps.waitProcesses?.(signal);
              continue nextTurn;
            }
            const settlement = { outcome: 'completed' as const, finalMessageId: messageId };
            let deferForAgents = false;
            await commit((current) => {
              deferForAgents = current.state.agentTasks.some(task => task.parentRunId === runId && task.status === 'running')
                || latestAgentEvidenceSequence(current.events, runId) !== agentEvidenceRevision;
              if (deferForAgents) return answerFacts;
              return [...answerFacts, ...(current.state.queuedInputs.some((input) => input.runId === runId) ? []
                : current.state.interactions.some(item => item.runId === runId && item.status === 'pending') ? [{
                  type: 'run.waiting', sessionId: current.state.sessionId, runId,
                  payload: { reason: 'userInput', detail: 'Independent work is complete; awaiting answers to open questions.' },
                } as const] : [{
                  type: 'run.finishing', sessionId: current.state.sessionId, runId, payload: settlement,
                } as const])];
            });
            if (deferForAgents) {
              await lease.release();
              if (snapshot.state.agentTasks.some(task => task.parentRunId === runId && task.status === 'running')) {
                if (!deps.agents) throw new LoopFailure('agent_manager_missing', '正在运行的子任务缺少管理入口。');
                await deps.agents.wait(runId, signal);
              }
              continue nextTurn;
            }
            if (snapshot.state.run?.status === 'waiting') return { status: 'waiting', runId, reason: 'userInput' };
            if (!snapshot.state.pendingRunSettlements[runId]) break;
            return finishingResult(runId, settlement);
          }
          case 'tools': {
            const seenCalls = new Set<string>();
            const callFacts: NewSessionEvent[] = [];
            // Commit reported progress before executing the accompanying ordinary calls.
            if (turn.progress) {
              callFacts.push(turn.progress.kind === 'todoUpdate'
                ? capabilities.controls.updateTodo(snapshot.state.sessionId, runId, snapshot.state.todoList, turn.progress.items, turn.progress)
                : controlRejectionFact(snapshot.state.sessionId, runId, turn.progress.rejection));
            }
            for (const call of turn.calls) {
              if (seenCalls.has(call.callId)) {
                throw new LoopFailure('provider_tool_call_duplicate', 'Provider 重复了工具调用标识。');
              }
              seenCalls.add(call.callId);
              if (call.owner === 'rejected') {
                callFacts.push(controlRejectionFact(snapshot.state.sessionId, runId, { ...call, toolName: call.name }));
                continue;
              }
              if (call.owner === 'agent') {
                callFacts.push(await agentControlFact(deps, snapshot.state.sessionId, runId, runtime, call,
                  preparedProviderRequest.receipt.modelView!.throughSequence, signal));
                continue;
              }
              callFacts.push({
                type: 'tool.requested',
                sessionId: snapshot.state.sessionId,
                runId,
                callId: call.callId,
                payload: {
                  providerCallId: call.providerCallId,
                  attemptId: deps.nextId('attempt'),
                  toolName: call.name,
                  input: call.input,
                },
              });
            }
            const events = orderedProviderCallFacts(turn.completion, callFacts);
            events.push(providerTurnSettledEvent(
              snapshot.state.sessionId,
              runId,
              turn.completion,
            ));
            events.push(...completionDerivedFacts);
            await commit(events);
            break;
          }
          case 'controlRejected': {
            const rejectionEvent = controlRejectionFact(snapshot.state.sessionId, runId, turn.rejection);
            await commit([
              ...orderedProviderCallFacts(
                turn.completion,
                [rejectionEvent],
              ),
              providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion),
              ...completionDerivedFacts,
            ]);
            break;
          }
        }
      } catch (error) {
        requestFailure = { error };
        throw error;
      } finally {
        await releaseCapabilities(lease, requestFailure);
      }
    }
  } catch (error) {
    snapshot = await deps.readSnapshot();
    // Finalization facts have already been admitted; cleanup errors cannot replace them.
    if (snapshot.state.pendingRunSettlements[runId]) throw error;
    const releaseFailed = error instanceof CapabilityReleaseFailure || error instanceof ToolViewRetirementFailure;
    const requestError = error instanceof CapabilityReleaseFailure && error.requestFailure ? error.requestFailure.error : error;
    const userCancelled = signal.aborted
      && (signal.reason === 'user_cancelled' || signal.reason === 'user_cancelled_plan');
    const pendingProvider = uncompletedProviderComposition(snapshot, runId);
    const completedAttempt = pendingProvider && Object.values(snapshot.state.providerAttempts).some((attempt) => (
      attempt.providerRequestId === pendingProvider.providerRequestId && attempt.phase === 'completed'
    ));
    if (requestError instanceof ProviderReportedFailure || requestError instanceof ProviderCompletedFailure
      || completedAttempt && !(signal.aborted && requestError === signal.reason)) {
      const failure = localAgentError(error);
      if (!hasSettlement(snapshot.events, runId)) {
        await commit([
          ...(pendingProvider
            ? [providerTurnTerminalEvent(
                snapshot.state.sessionId,
                runId,
                pendingProvider,
                providerRuntimeForPurpose(runRuntimeSnapshot(snapshot, runId), pendingProvider.purpose).providerRuntimeRef,
                { outcome: 'failed', error: failure },
              )]
            : []),
          {
            type: 'run.finishing',
            sessionId: snapshot.state.sessionId,
            runId,
            payload: { outcome: 'failed', error: failure },
          },
        ]);
      }
      return finishingResult(runId, { outcome: 'failed', error: failure });
    }
    const unknownTurn = pendingProvider;
    if (unknownTurn && !hasSettlement(snapshot.events, runId)) {
      const cause = localAgentError(error);
      const settlement: RunSettlement = {
        outcome: 'indeterminate',
        error: {
          code: 'provider_turn_outcome_unknown',
          message: userCancelled ? '已收到取消请求，本次生成未完成；Provider 最终完成结果未知。'
            : `Provider request ${unknownTurn.providerRequestId} 的完成结果不可判定；原始错误 ${cause.code}：${cause.message}`,
          diagnostics: { source: 'session', phase: 'provider', category: userCancelled ? 'cancelled' : 'unknown', retryable: false,
            causes: [{ message: `${cause.code}: ${cause.message}` }],
            ...(cause.diagnostics?.secondary ? { secondary: cause.diagnostics.secondary } : {}),
            ...(signal.aborted ? { stopReason: String(signal.reason) } : {}) },
        },
      };
      await commit([
        providerTurnTerminalEvent(
          snapshot.state.sessionId,
          runId,
          unknownTurn,
          providerRuntimeForPurpose(runRuntimeSnapshot(snapshot, runId), unknownTurn.purpose).providerRuntimeRef,
          settlement,
        ),
        {
          type: 'run.finishing',
          sessionId: snapshot.state.sessionId,
          runId,
          payload: settlement,
        },
      ]);
      return finishingResult(runId, settlement);
    }
    if (
      signal.aborted
      && signal.reason === 'session_service_stopped'
      && !releaseFailed
      && !(error instanceof LoopFailure && error.code === 'tool_cancel_cleanup_failed')
    ) {
      return { status: 'suspended', runId };
    }
    if (userCancelled
      && !releaseFailed
      && !(error instanceof LoopFailure && error.code === 'tool_cancel_cleanup_failed')) {
      return await cancelRun(snapshot, { type: 'cancel', runId }, deps, commit);
    }
    const failure = localAgentError(error);
    if (!hasSettlement(snapshot.events, runId)) {
      await commit({
        type: 'run.finishing',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: { outcome: 'failed', error: failure },
      });
    }
    return finishingResult(runId, { outcome: 'failed', error: failure });
  }
}

function acquireCapabilities(deps: AgentLoopDeps): SessionCapabilityLease {
  if (deps.capabilities) return deps.capabilities.acquire();
  // Direct Loop callers own their composition. Actors always provide the manager.
  return {
    implementation: deps.composition.capabilities ?? createSessionCapabilities(),
    async release() {},
  };
}

async function releaseCapabilities(
  lease: SessionCapabilityLease,
  failure?: { error: unknown },
): Promise<void> {
  try {
    await lease.release();
  } catch (error) {
    throw new CapabilityReleaseFailure(failure?.error === error ? undefined : failure, error);
  }
}

/** Keeps request classification while reporting an additional implementation cleanup failure. */
class CapabilityReleaseFailure extends AggregateError {
  constructor(readonly requestFailure: { error: unknown } | undefined, releaseError: unknown) {
    super(requestFailure ? [requestFailure.error, releaseError] : [releaseError], 'session_capability_release_failed');
  }
}

/** Resource cleanup failure must remain visible even if cancellation arrives concurrently. */
class ToolViewRetirementFailure extends AggregateError {
  constructor(error: unknown) {
    super([error], 'tool_view_retire_failed');
  }
}

async function performContextCompaction(
  snapshot: LoopSnapshot,
  requestEvent: ContextCompactionRequestEvent,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  const lease = acquireCapabilities(deps);
  let requestFailure: { error: unknown } | undefined;
  try {
    const cutoff = requestEvent.payload.coveredThroughSequence;
    const runtime = runRuntimeSnapshot(snapshot, runId);
    const prepared = await lease.implementation.compaction.prepare({
      sessionId: snapshot.state.sessionId,
      runId,
      runtime,
      workspaceBindings: runWorkspaceBindings(snapshot, runId),
      events: snapshot.events,
      requestEvent,
    }, signal);
    throwIfAborted(signal);
    await commit({
      type: 'context.composed',
      sessionId: snapshot.state.sessionId,
      runId,
      payload: prepared.receipt,
    });
    const compacted = await consumeTextProvider(prepared.request, deps, signal);
    const facts: NewSessionEvent[] = [providerTurnSettledEvent(
      snapshot.state.sessionId,
      runId,
      compacted.completion,
    )];
    if (compacted.contextUsage) {
      facts.push({
        type: 'context.updated',
        sessionId: snapshot.state.sessionId,
        runId,
        payload: compacted.contextUsage,
      });
    }
    facts.push({
      type: 'context.compacted',
      sessionId: snapshot.state.sessionId,
      runId,
      payload: {
        compactionId: requestEvent.payload.compactionId,
        providerRequestId: requestEvent.payload.providerRequestId,
        trigger: requestEvent.payload.trigger,
        coveredThroughSequence: cutoff,
        summary: compacted.summary,
      },
    });
    await commit(facts);
  } catch (error) {
    requestFailure = { error };
    throw error;
  } finally {
    await releaseCapabilities(lease, requestFailure);
  }
}

async function consumeTextProvider(request: ProviderRequest, deps: AgentLoopDeps, signal: AbortSignal) {
  return withProviderAttempts(request, deps, signal, (attempt, onCompleted, onEvent) => (
    consumeTextAttempt(attempt, deps, signal, onCompleted, onEvent)
  ));
}

async function consumeTextAttempt(
  request: ProviderRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  onCompleted: () => void,
  onEvent: (event: ProviderEvent) => void,
): Promise<{
  summary: string;
  completion: ProviderTurnCompletion;
  contextUsage?: ProviderTokenUsage & {
    providerRequestId: string;
    providerRuntimeRef: string;
  };
}> {
  const activity = trackProviderActivity(request, deps);
  let deltas = '';
  let completeMessage: Extract<ProviderEvent, { type: 'assistant.message' }>['data'] | undefined;
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送文本事件。',
      );
    }
    onEvent(event);
    activity.observe(event);
    switch (event.type) {
      case 'text.delta':
        deltas += event.data.text;
        break;
      case 'reasoning.delta':
        break;
      case 'output.item.completed':
        if (
          orderedOutputItems.at(-1)?.outputIndex !== undefined
          && event.data.outputIndex <= orderedOutputItems.at(-1)!.outputIndex
        ) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            '文本决策请求 output item 没有按原生 output_index 递增返回。',
          );
        }
        if (event.data.item.type === 'function_call') {
          throw new LoopFailure(
            'context_compaction_tool_call_invalid',
            '文本决策请求请求不能调用工具或 Session control。',
          );
        }
        if (event.data.item.type === 'web_search_call') {
          throw new LoopFailure(
            'context_compaction_hosted_tool_invalid',
            '文本决策请求请求不能调用 Provider hosted search。',
          );
        }
        orderedOutputItems.push({
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        });
        break;
      case 'assistant.message':
        if (completeMessage !== undefined) {
          throw new LoopFailure(
            'provider_message_duplicate',
            '文本决策请求返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        break;
      case 'tool.call':
        throw new LoopFailure(
          'context_compaction_tool_call_invalid',
          '文本决策请求请求不能调用工具或 Session control。',
        );
      case 'hosted.web-search.completed':
        throw new LoopFailure(
          'context_compaction_hosted_tool_invalid',
          '文本决策请求请求不能调用 Provider hosted search。',
        );
      case 'completed':
        completed = true;
        onCompleted();
        contextUsage = decodeContextUsage(event.data);
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message, event.data.diagnostics);
    }
  }
  if (!completed) {
    throw new LoopFailure('provider_stream_incomplete', '文本决策请求 Provider 流未产生完成事件。');
  }
  if (orderedOutputItems.length > 0 && completeMessage !== undefined) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      '文本决策请求同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (completeMessage !== undefined && deltas && completeMessage.content !== deltas) {
    throw new LoopFailure('provider_message_mismatch', '文本决策请求最终消息与流式文本不一致。');
  }
  const orderedMessages = orderedOutputItems.flatMap((output) => (
    output.item.type === 'message'
      ? [providerOutputItemText(output.item, 'output_text', true)]
      : []
  ));
  if (orderedMessages.length > 1) {
    throw new LoopFailure(
      'context_compaction_message_count_invalid',
      '文本决策请求必须只产生一个最终消息。',
    );
  }
  const orderedSummary = orderedMessages[0];
  if (orderedSummary !== undefined && deltas && orderedSummary !== deltas) {
    throw new LoopFailure(
      'provider_output_text_mismatch',
      '文本决策请求有序 message item 与流式文本不一致。',
    );
  }
  const summary = (orderedSummary ?? completeMessage?.content ?? deltas).trim();
  if (!summary) {
    throw new LoopFailure('context_compaction_empty', '文本决策请求没有产生结果。');
  }
  return {
    summary,
    completion: {
      providerRequestId: request.requestId,
      purpose: request.purpose,
      providerRuntimeRef: request.providerRuntimeRef,
      orderedCallIds: [],
      ...(completeMessage?.reasoningContent !== undefined
        ? { reasoningContent: completeMessage.reasoningContent }
        : {}),
      ...(completeMessage?.reasoningSignature !== undefined
        ? { reasoningSignature: completeMessage.reasoningSignature }
        : {}),
    },
    ...(contextUsage
      ? {
          contextUsage: {
            ...contextUsage,
            providerRequestId: request.requestId,
            providerRuntimeRef: request.providerRuntimeRef,
          },
        }
      : {}),
  };
}

async function consumeProvider(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  controls: SessionCapabilities['controls'],
): Promise<ProviderTurn> {
  return withProviderAttempts(request, deps, signal, (attempt, onCompleted, onEvent) => (
    consumeProviderOutput(attempt, toolCodec, runId, deps, signal, onCompleted, controls, onEvent)
  ));
}

async function consumeProviderOutput(
  request: ProviderRequest,
  toolCodec: ProviderToolCodec,
  runId: string,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  onCompleted: () => void,
  controls: SessionCapabilities['controls'],
  onEvent: (event: ProviderEvent) => void,
): Promise<ProviderTurn> {
  const activity = trackProviderActivity(request, deps);
  deps = { ...deps, updateAssistantDraft: activity.updateDraft };
  let deltas = '';
  let reasoningDeltas = '';
  let completeMessage: {
    messageId: string;
    content: string;
    reasoningContent?: string;
    reasoningSignature?: string;
  } | undefined;
  const providerCalls: Array<{
    providerCallId: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const aggregateCalls: Array<Extract<ProviderEvent, { type: 'tool.call' }>['data']> = [];
  const hostedWebSearchCalls: JsonObject[] = [];
  const orderedOutputItems: Array<{ outputIndex: number; item: JsonObject }> = [];
  const streamedTextByOutputIndex = new Map<number, string>();
  const completedDraftBlocks: NativeAssistantDraftBlock[] = [];
  const planPreview = new PlanPreviewBuffer(toolCodec.wireByCanonical.get(SESSION_CONTROL_PLAN_PUBLISH));
  let contextUsage: ProviderTokenUsage | undefined;
  let completed = false;
  for await (const event of deps.composition.provider.stream(request, signal)) {
    assertProviderEvent(event, request.requestId);
    if (completed) {
      throw new LoopFailure(
        'provider_event_after_completion',
        'Provider 在 completed 之后继续发送事件。',
      );
    }
    onEvent(event);
    activity.observe(event);
    switch (event.type) {
      case 'tool.call.delta': {
        if (event.data.outputIndex !== undefined && orderedOutputItems.some((item) => item.outputIndex === event.data.outputIndex)) {
          throw new LoopFailure('provider_output_delta_after_completion', '工具参数在完成后继续返回。');
        }
        const preview = planPreview.append(event.data);
        if (preview) activity.updatePlanPreview(preview);
        break;
      }
      case 'reasoning.delta': {
        if (event.data.kind !== 'summary') reasoningDeltas += event.data.text;
        break;
      }
      case 'text.delta': {
        if (event.data.text.trim()) await deps.recordVisibleResponse?.(runId);
        deltas += event.data.text;
        if (event.data.outputIndex !== undefined) {
          if (orderedOutputItems.some((output) => output.outputIndex === event.data.outputIndex)) {
            throw new LoopFailure(
              'provider_output_delta_after_completion',
              'Provider 在 output item 完成后继续发送该 item 的正文增量。',
            );
          }
          streamedTextByOutputIndex.set(
            event.data.outputIndex,
            `${streamedTextByOutputIndex.get(event.data.outputIndex) ?? ''}${event.data.text}`,
          );
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            blocks: assistantDraftBlocks(
              request,
              completedDraftBlocks,
              streamedTextByOutputIndex,
            ),
          });
        } else if (orderedOutputItems.length === 0) {
          deps.updateAssistantDraft({
            runId,
            turnId: request.requestId,
            blocks: aggregateDraftBlocks(request, deltas),
          });
        }
        break;
      }
      case 'output.item.completed': {
        const previous = orderedOutputItems.at(-1);
        if (previous && event.data.outputIndex <= previous.outputIndex) {
          throw new LoopFailure(
            'provider_output_item_order_invalid',
            'Provider output item 没有按原生 output_index 递增返回。',
          );
        }
        const output = {
          outputIndex: event.data.outputIndex,
          item: structuredClone(event.data.item),
        };
        orderedOutputItems.push(output);
        const completedDraftBlock = completedAssistantDraftBlock(request, output, toolCodec);
        if (completedDraftBlock) {
          completedDraftBlocks.push(completedDraftBlock);
          if (completedDraftBlock.kind !== 'providerHosted' && completedDraftBlock.content.trim()) await deps.recordVisibleResponse?.(runId);
        }
        streamedTextByOutputIndex.delete(event.data.outputIndex);
        const blocks = assistantDraftBlocks(
          request,
          completedDraftBlocks,
          streamedTextByOutputIndex,
        );
        deps.updateAssistantDraft({ runId, turnId: request.requestId, blocks });
        break;
      }
      case 'assistant.message':
        if (completeMessage) {
          throw new LoopFailure(
            'provider_message_duplicate',
            'Provider 同一 turn 返回了多个最终消息。',
          );
        }
        completeMessage = event.data;
        if (event.data.content.trim()) await deps.recordVisibleResponse?.(runId);
        break;
      case 'tool.call':
        aggregateCalls.push(event.data);
        break;
      case 'hosted.web-search.completed':
        hostedWebSearchCalls.push(structuredClone(event.data.item));
        break;
      case 'completed':
        completed = true;
        onCompleted();
        contextUsage = decodeContextUsage(event.data);
        break;
      case 'failed':
        throw new ProviderReportedFailure(event.data.code, event.data.message, event.data.diagnostics);
    }
  }
  if (!completed) throw new LoopFailure('provider_stream_incomplete', 'Provider 流未产生完成事件。');
  if (
    orderedOutputItems.length > 0
    && (completeMessage !== undefined || aggregateCalls.length > 0 || hostedWebSearchCalls.length > 0)
  ) {
    throw new LoopFailure(
      'provider_output_contract_mixed',
      'Provider 同一 turn 混用了有序 output item 与聚合完成事件。',
    );
  }
  if (completeMessage) {
    if (
      completeMessage.reasoningContent !== undefined
      && !completeMessage.reasoningContent.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_content_invalid',
        'Provider 返回了空的 reasoningContent。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && !completeMessage.reasoningSignature.trim()
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_invalid',
        'Provider 返回了空的 reasoningSignature。',
      );
    }
    if (
      completeMessage.reasoningSignature !== undefined
      && completeMessage.reasoningContent === undefined
    ) {
      throw new LoopFailure(
        'provider_reasoning_signature_without_content',
        'Provider reasoningSignature 缺少对应 reasoningContent。',
      );
    }
    if (deltas && completeMessage.content !== deltas) {
      throw new LoopFailure('provider_message_mismatch', 'Provider 最终消息与流式文本不一致。');
    }
    if (
      reasoningDeltas
      && completeMessage.reasoningContent !== reasoningDeltas
    ) {
      throw new LoopFailure(
        'provider_reasoning_message_mismatch',
        'Provider 最终 reasoningContent 与流式 reasoning 不一致。',
      );
    }
    if (!deltas) {
      deltas = completeMessage.content;
      if (deltas) {
        deps.updateAssistantDraft({
          runId,
          turnId: request.requestId,
          blocks: aggregateDraftBlocks(request, deltas),
        });
      }
    }
  }

  const decodedOutputBlocks = orderedOutputItems.map((output) => (
    decodeProviderOutputBlock(output, toolCodec)
  ));
  const aggregateBlocks = aggregateCalls.map((call, outputIndex) => (
    decodeProviderOutputBlock({
      outputIndex,
      item: {
        type: 'function_call',
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments ?? JSON.stringify(call.input),
      },
    }, toolCodec)
  ));
  // A conflicting control batch is rejected as a whole, before requesting any effect.
  const inputBlocks = [...decodedOutputBlocks, ...aggregateBlocks].filter((block) => (
    block.kind === 'toolCall' || block.kind === 'toolCallRejected'
  ));
  const conflict = inputBlocks.some((block) => (
    block.name === SESSION_CONTROL_INTERACTION_REQUEST || block.name === SESSION_CONTROL_PLAN_PUBLISH
      || block.name === SESSION_CONTROL_PLUGIN_ACTIVATE || block.name === SESSION_CONTROL_ARTIFACT_PRESENT
      || block.name === SESSION_CONTROL_SESSION
      || block.name === SESSION_CONTROL_AGENT && (block.kind !== 'toolCall' || block.input.action !== 'spawn' || block.input.delivery !== 'async'
        || inputBlocks.some(other => other.name !== SESSION_CONTROL_AGENT && other.name !== SESSION_CONTROL_TODO_UPDATE))
  )) && inputBlocks.length > 1
    ? '该控制调用需要独占一轮；仅多个异步 agent spawn 可以与一个 todo.update 一起提交。本批次未执行。'
    : inputBlocks.filter((block) => block.name === SESSION_CONTROL_TODO_UPDATE).length > 1
      ? '每个 Provider turn 最多包含一个 todo.update；本批次未执行，请合并步骤更新。'
      : undefined;
  if (conflict) {
    for (const blocks of [decodedOutputBlocks, aggregateBlocks]) {
      for (const [index, block] of blocks.entries()) {
        if (block.kind !== 'toolCall') continue;
        blocks[index] = {
          outputIndex: block.outputIndex,
          item: block.item,
          kind: 'toolCallRejected',
          providerCallId: block.providerCallId,
          name: block.name,
          error: {
            code: 'session_control_turn_conflict',
            message: conflict,
            issues: [{ path: '$', rule: 'control_turn', message: conflict }],
          },
        };
      }
    }
  }
  for (const block of aggregateBlocks) {
    if (block.kind === 'toolCall') {
      providerCalls.push({
        providerCallId: block.providerCallId,
        name: block.name,
        input: block.input,
      });
    }
  }
  if (decodedOutputBlocks.length > 0) {
    const outputText = decodedOutputBlocks
      .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
        block.kind === 'message'
      ))
      .map((block) => block.content)
      .join('');
    if (deltas && outputText !== deltas) {
      throw new LoopFailure(
        'provider_output_text_mismatch',
        'Provider 有序 message items 与流式文本不一致。',
      );
    }
    if (!deltas && outputText) {
      deltas = outputText;
    }
    for (const block of decodedOutputBlocks) {
      if (block.kind === 'toolCall') {
        providerCalls.push({
          providerCallId: block.providerCallId,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  const orderedReasoningContent = decodedOutputBlocks
    .filter((block): block is Extract<DecodedProviderOutputBlock, { kind: 'reasoning' }> => (
      block.kind === 'reasoning'
    ))
    .map((block) => block.content)
    .join('');
  const reasoningContent = completeMessage?.reasoningContent
    ?? (orderedReasoningContent || reasoningDeltas || undefined);

  const usage = contextUsage
    ? {
        contextUsage: {
          ...contextUsage,
          providerRequestId: request.requestId,
          providerRuntimeRef: request.providerRuntimeRef,
        },
      }
    : {};
  const narrative = decodedOutputBlocks.length === 0 && deltas.trim() ? deltas : undefined;
  const rejectedCalls = [...decodedOutputBlocks, ...aggregateBlocks].filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'toolCallRejected' }> => (
      block.kind === 'toolCallRejected'
    ),
  );
  const seenCalls = new Set<string>();
  for (const call of [...providerCalls, ...rejectedCalls]) {
    if (!call.providerCallId || seenCalls.has(call.providerCallId)) {
      throw new LoopFailure(
        'provider_tool_call_duplicate',
        'Provider 工具调用标识为空或重复。',
      );
    }
    seenCalls.add(call.providerCallId);
  }
  const seenHostedSearchCalls = new Set(seenCalls);
  for (const item of hostedWebSearchCalls) {
    const callId = typeof item.id === 'string' ? item.id : '';
    if (!callId || seenHostedSearchCalls.has(callId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(callId);
  }
  for (const block of decodedOutputBlocks) {
    if (block.kind !== 'providerHosted') continue;
    if (seenHostedSearchCalls.has(block.providerCallId)) {
      throw new LoopFailure(
        'provider_hosted_search_call_duplicate',
        'Provider hosted search 调用标识为空或重复。',
      );
    }
    seenHostedSearchCalls.add(block.providerCallId);
  }
  const logicalCallIds = new Set<string>();
  const calls = providerCalls.map((call) => {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure(
        'logical_call_identity_invalid',
        'Session 必须为每个 Provider call 生成非空、唯一且不复用原生值的 LogicalCallId。',
      );
    }
    logicalCallIds.add(callId);
    return {
      callId,
      providerCallId: call.providerCallId,
      name: call.name,
      input: call.input,
    };
  });
  const logicalCallByProviderCallId = new Map(calls.map((call) => (
    [call.providerCallId, call.callId] as const
  )));
  for (const call of rejectedCalls) {
    const callId = deps.nextId('call');
    if (!callId || callId === call.providerCallId || logicalCallIds.has(callId)) {
      throw new LoopFailure('logical_call_identity_invalid', 'Session 拒绝调用缺少独立且唯一的 LogicalCallId。');
    }
    logicalCallIds.add(callId);
    logicalCallByProviderCallId.set(call.providerCallId, callId);
  }
  const orderedMessageBlocks = decodedOutputBlocks.filter(
    (block): block is Extract<DecodedProviderOutputBlock, { kind: 'message' }> => (
      block.kind === 'message'
    ),
  );
  const hasCalls = calls.length + rejectedCalls.length > 0;
  const lastMessage = orderedMessageBlocks.at(-1);
  const finalOrderedMessage = !hasCalls && lastMessage
    && providerMessagePhase(lastMessage.item) !== 'commentary' ? lastMessage : undefined;
  const declaredFinalMessages = orderedMessageBlocks.filter((block) => (
    providerMessagePhase(block.item) === 'final_answer'
  ));
  if (declaredFinalMessages.some((block) => block !== finalOrderedMessage)) {
    throw new LoopFailure(
      'provider_output_message_phase_conflict',
      'Provider 最终答复之后仍有消息或待处理调用。',
    );
  }
  const isContinuation = request.purpose === 'agent' && !hasCalls
    && orderedMessageBlocks.length > 0
    && orderedMessageBlocks.every((block) => providerMessagePhase(block.item) === 'commentary');
  if (decodedOutputBlocks.length > 0 && !hasCalls && !finalOrderedMessage && !isContinuation) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider 有序 output items 没有产生最终答复消息。',
    );
  }
  const orderedNarratives: Array<{ narrativeId: string; content: string }> = [];
  let orderedFinalMessage: { messageId: string; content: string } | undefined;
  const orderedOutputBlocks = decodedOutputBlocks.map((block): ProviderOutputBlock => {
    switch (block.kind) {
      case 'reasoning':
        return {
          outputIndex: block.outputIndex,
          kind: 'reasoning',
          item: structuredClone(block.item),
        };
      case 'message': {
        if (block.outputIndex === finalOrderedMessage?.outputIndex) {
          const messageId = deps.nextId('message');
          orderedFinalMessage = { messageId, content: block.content };
          return {
            outputIndex: block.outputIndex,
            kind: 'finalMessage',
            messageId,
            item: structuredClone(block.item),
          };
        }
        const narrativeId = deps.nextId('narrative');
        orderedNarratives.push({ narrativeId, content: block.content });
        return {
          outputIndex: block.outputIndex,
          kind: 'narrative',
          narrativeId,
          item: structuredClone(block.item),
        };
      }
      case 'toolCall':
      case 'toolCallRejected': {
        const callId = logicalCallByProviderCallId.get(block.providerCallId);
        if (!callId) {
          throw new LoopFailure(
            'provider_turn_call_fact_mismatch',
            'Provider output toolCall 缺少对应的 Session LogicalCallId。',
          );
        }
        const callBlock = {
          outputIndex: block.outputIndex,
          callId,
          providerCallId: block.providerCallId,
          toolName: block.name,
          item: structuredClone(block.item),
        };
        return block.kind === 'toolCallRejected'
          ? { ...callBlock, kind: 'toolCallRejected', error: structuredClone(block.error) }
          : { ...callBlock, kind: 'toolCall' };
      }
      case 'providerHosted':
        return {
          outputIndex: block.outputIndex,
          kind: 'providerHosted',
          activityId: deps.nextId('activity'),
          providerCallId: block.providerCallId,
          providerToolType: 'web_search',
          item: structuredClone(block.item),
        };
    }
  });
  const completion: ProviderTurnCompletion = {
    providerRequestId: request.requestId,
    purpose: 'agent',
    providerRuntimeRef: request.providerRuntimeRef,
    orderedCallIds: calls.map((call) => call.callId),
    ...(aggregateBlocks.length > 0 ? {
      toolCallInputs: aggregateBlocks.map((block): ProviderToolCallInput => {
        if (block.kind !== 'toolCall' && block.kind !== 'toolCallRejected') {
          throw new LoopFailure('provider_tool_call_invalid', '聚合工具调用类型无效。');
        }
        return {
          callId: logicalCallByProviderCallId.get(block.providerCallId)!,
          providerCallId: block.providerCallId,
          toolName: block.name,
          arguments: block.item.arguments as string,
          ...(block.kind === 'toolCallRejected' ? { error: structuredClone(block.error) } : {}),
        };
      }),
    } : {}),
    ...(reasoningContent !== undefined
      ? { reasoningContent }
      : {}),
    ...(completeMessage?.reasoningSignature !== undefined
      ? { reasoningSignature: completeMessage.reasoningSignature }
      : {}),
    ...(hostedWebSearchCalls.length > 0
      ? { hostedWebSearchCalls }
      : {}),
    ...(orderedOutputBlocks.length > 0
      ? { orderedOutputBlocks }
      : {}),
  };

  const controlCalls: Array<SessionControlCall & { providerCallId: string }> = [];
  const dispatchCalls: ProviderDispatchCall[] = [];
  const agentBatch = calls.length > 1 && calls.every(call => call.name === SESSION_CONTROL_AGENT || call.name === SESSION_CONTROL_TODO_UPDATE);
  let progress: Extract<ProviderTurn, { kind: 'tools' }>['progress'];
  for (const call of calls) {
    try {
      const control = controls.decode(call.callId, call.name, call.input);
      if (control?.kind === 'todoUpdate') progress = { ...control, providerCallId: call.providerCallId };
      else if (control?.kind === 'agent' && agentBatch) dispatchCalls.push({ ...call, owner: 'agent', operation: control.operation });
      else if (control) controlCalls.push({ ...control, providerCallId: call.providerCallId });
      else dispatchCalls.push({ ...call, owner: 'kernel' });
    } catch (error) {
      if (!(error instanceof SessionControlError)) throw error;
      const rejection: ProviderControlRejection = {
        callId: call.callId,
        providerCallId: call.providerCallId,
        toolName: call.name,
        input: { ...call.input },
        error: { code: error.code, message: error.message },
      };
      if (call.name === SESSION_CONTROL_TODO_UPDATE) {
        progress = { kind: 'controlRejected', rejection };
        continue;
      }
      if (call.name === SESSION_CONTROL_AGENT && agentBatch) { dispatchCalls.push({ ...call, owner: 'rejected', error: rejection.error }); continue; }
      return {
        kind: 'controlRejected',
        rejection,
        ...(narrative ? { narrative } : {}),
        ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
        ...usage,
        completion,
      };
    }
  }
  const common = {
    ...usage,
    completion,
    ...(orderedNarratives.length > 0 ? { narratives: orderedNarratives } : {}),
  };
  const control = controlCalls[0];
  if (control?.kind === 'pluginActivate' || control?.kind === 'artifactPresent' || control?.kind === 'agent' || control?.kind === 'session') {
    return { ...control, providerCallId: control.providerCallId, ...common };
  }
  if (control?.kind === 'interaction') {
    const interactionId = deps.nextId('interaction');
    if (interactionId === control.callId || interactionId === control.providerCallId) {
      throw new LoopFailure(
        'interaction_identity_invalid',
        'InteractionId、LogicalCallId 与 ProviderCallId 必须是互不复用的独立身份。',
      );
    }
    return {
      kind: 'interaction',
      interactionId,
      callId: control.callId,
      providerCallId: control.providerCallId,
      request: control.request,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (control?.kind === 'plan') {
    return {
      kind: 'plan',
      callId: control.callId,
      draft: control.draft,
      providerCallId: control.providerCallId,
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (dispatchCalls.length > 0 || rejectedCalls.length > 0 || progress) {
    return {
      kind: 'tools',
      calls: dispatchCalls,
      ...(progress ? { progress } : {}),
      ...(narrative ? { narrative } : {}),
      ...common,
    };
  }
  if (isContinuation) return { kind: 'continuation', ...common };
  const answer = orderedFinalMessage ?? (narrative
    ? { content: narrative, messageId: completeMessage?.messageId }
    : undefined);
  if (!answer) {
    throw new LoopFailure(
      'provider_answer_empty',
      'Provider turn 正常结束，但没有产生最终答复文本。',
    );
  }
  return {
    kind: 'answer',
    content: answer.content,
    ...(answer.messageId ? { messageId: answer.messageId } : {}),
    ...common,
  };
}

function latestAgentEvidenceSequence(events: readonly SessionEvent[], runId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if ((event.type === 'agent.task.completed' || event.type === 'agent.message.received' || event.type === 'wake.triggered') && event.runId === runId) {
      return event.sequence;
    }
  }
  return 0;
}

function trackProviderActivity(request: ProviderRequest, deps: AgentLoopDeps): {
  updateDraft(draft: AssistantDraftProjection | null): void;
  updatePlanPreview(preview: NonNullable<AssistantDraftProjection['planPreview']>): void;
  observe(event: ProviderEvent): void;
} {
  let draft: AssistantDraftProjection = { runId: request.runId, turnId: request.requestId, blocks: [] };
  const activity: ProviderActivityProjection = {
    purpose: request.purpose, phase: 'waitingResponse', startedAt: new Date().toISOString(),
  };
  const publish = () => deps.updateAssistantDraft({ ...draft, providerAttemptId: request.providerAttemptId, activity: { ...activity } });
  publish();
  return {
    updateDraft(next) {
      draft = next ? { ...next, ...(draft.planPreview ? { planPreview: draft.planPreview } : {}) }
        : { runId: request.runId, turnId: request.requestId, blocks: [] };
      publish();
    },
    updatePlanPreview(preview) { draft = { ...draft, planPreview: preview }; publish(); },
    observe(event) {
      if (event.type === 'reasoning.delta' && event.data.text) {
        activity.phase = 'reasoning';
        deps.updateReasoning?.(request.requestId, request.runId, event.data.text, event.data.kind ?? 'text');
      }
      else if (event.type === 'text.delta' && event.data.text || event.type === 'tool.call.delta') activity.phase = 'generatingOutput';
      else if (event.type === 'assistant.message') activity.phase = 'generatingOutput';
      else if (event.type === 'output.item.completed') {
        activity.phase = event.data.item.type === 'message' ? 'generatingOutput' : 'awaitingOutput';
      } else if (event.type === 'tool.call' || event.type === 'hosted.web-search.completed') {
        activity.phase = 'awaitingOutput';
      } else return;
      activity.lastContentAt = new Date().toISOString();
      publish();
    },
  };
}

function decodeProviderOutputBlock(
  output: { outputIndex: number; item: JsonObject },
  toolCodec: ProviderToolCodec,
): DecodedProviderOutputBlock {
  const item = structuredClone(output.item);
  switch (item.type) {
    case 'reasoning':
      return {
        outputIndex: output.outputIndex,
        kind: 'reasoning',
        content: providerOutputItemText(item, 'reasoning_text', false),
        item,
      };
    case 'message': {
      if (item.role !== 'assistant') {
        throw new LoopFailure(
          'provider_output_message_invalid',
          'Provider output message 不是 assistant 消息。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'message',
        content: providerOutputItemText(item, 'output_text', true),
        item,
      };
    }
    case 'function_call': {
      const providerCallId = typeof item.call_id === 'string' ? item.call_id : '';
      const wireName = typeof item.name === 'string' ? item.name : '';
      const canonicalName = toolCodec.canonicalByWire.get(wireName);
      if (!providerCallId || !wireName || typeof item.arguments !== 'string') {
        throw new LoopFailure(
          'provider_tool_call_invalid',
          'Provider function_call 终态事实无效。',
        );
      }
      if (!canonicalName) {
        const message = `Tool ${wireName} is not available in this request. Use the currently declared tools; discover and activate a plugin in this run before calling its tools.`;
        return {
          outputIndex: output.outputIndex,
          kind: 'toolCallRejected',
          providerCallId,
          name: wireName,
          item,
          error: {
            code: 'provider_tool_alias_unknown',
            message,
            issues: [{ path: '$.name', rule: 'declared_tool', message }],
          },
        };
      }
      let input: unknown;
      const rejectInput = (message: string): DecodedProviderOutputBlock => ({
        outputIndex: output.outputIndex,
        kind: 'toolCallRejected',
        providerCallId,
        name: canonicalName,
        item,
        error: {
          code: 'provider_tool_call_arguments_invalid',
          message,
          issues: [{ path: '$', rule: 'json_object', message, expected: 'JSON object' }],
        },
      });
      try {
        input = JSON.parse(item.arguments);
      } catch {
        return rejectInput('Provider function_call arguments 不是有效 JSON。');
      }
      if (!isRecord(input)) {
        return rejectInput('Provider function_call arguments 必须是 JSON 对象。');
      }
      let decodedInput: JsonObject;
      try {
        decodedInput = decodeProviderToolInput(toolCodec, canonicalName, input);
      } catch (error) {
        if (!(error instanceof LoopFailure)) throw error;
        return {
          outputIndex: output.outputIndex,
          kind: 'toolCallRejected',
          providerCallId,
          name: canonicalName,
          item,
          error: {
            code: error.code,
            message: error.message,
            issues: [{ path: '$.workspace', rule: 'workspace_binding', message: error.message }],
          },
        };
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'toolCall',
        providerCallId,
        name: canonicalName,
        input: decodedInput,
        item,
      };
    }
    case 'web_search_call': {
      const providerCallId = typeof item.id === 'string' ? item.id : '';
      if (
        !providerCallId
        || item.status !== 'completed' && item.status !== 'failed'
        || item.action !== undefined && !isRecord(item.action)
      ) {
        throw new LoopFailure(
          'provider_hosted_search_item_invalid',
          'Provider hosted search 终态事实无效。',
        );
      }
      return {
        outputIndex: output.outputIndex,
        kind: 'providerHosted',
        providerCallId,
        item,
      };
    }
    default:
      throw new LoopFailure(
        'provider_output_item_type_unsupported',
        `Provider 返回了当前合同未支持的 output item 类型：${String(item.type)}`,
      );
  }
}

type NativeAssistantDraftBlock = AssistantDraftBlockProjection & { outputIndex: number };

/** The native phase has the same meaning while streaming and after settlement. */
function providerMessagePhase(item: JsonObject): 'commentary' | 'final_answer' | undefined {
  const phase = item.phase;
  if (phase === undefined || phase === null) return undefined;
  if (typeof phase !== 'string') {
    throw new LoopFailure('provider_output_message_phase_invalid', 'Provider output message 的 phase 不是字符串。');
  }
  if (phase !== 'commentary' && phase !== 'final_answer') {
    throw new LoopFailure(
      'provider_output_message_phase_unsupported',
      `Provider output message 返回了当前合同未支持的 phase：${phase}`,
    );
  }
  return phase;
}

function aggregateDraftBlocks(
  request: ProviderRequest,
  content: string,
): AssistantDraftBlockProjection[] {
  return content ? [{
    kind: 'message',
    content,
    streamId: providerTextStreamId(request.sessionId, request.runId, request.requestId),
  }] : [];
}

function completedAssistantDraftBlock(
  request: ProviderRequest,
  output: { outputIndex: number; item: JsonObject },
  toolCodec: ProviderToolCodec,
): NativeAssistantDraftBlock | null {
  // Draft presentation must not admit tool inputs or interrupt their native stream.
  if (output.item.type === 'function_call' || output.item.type === 'reasoning') return null;
  const block = decodeProviderOutputBlock(output, toolCodec);
  switch (block.kind) {
    case 'reasoning':
    case 'toolCall':
    case 'toolCallRejected':
      return null;
    case 'message': {
      const phase = providerMessagePhase(block.item);
      const kind = phase === 'commentary'
        ? 'narrative'
        : phase === 'final_answer'
          ? 'finalMessage'
          : 'message';
      return {
        outputIndex: block.outputIndex,
        kind,
        content: block.content,
        streamId: providerTextStreamId(
          request.sessionId, request.runId, request.requestId, block.outputIndex,
        ),
      };
    }
    case 'providerHosted': {
      const status = block.item.status;
      const action = block.item.action;
      if (
        status !== 'completed'
        && status !== 'failed'
        || action !== undefined && !isRecord(action)
      ) {
        throw new LoopFailure(
          'provider_hosted_search_item_invalid',
          'Provider hosted search 终态事实无效。',
        );
      }
      return {
        outputIndex: block.outputIndex,
        kind: 'providerHosted',
        providerCallId: block.providerCallId,
        providerToolType: 'web_search',
        status,
        ...(action === undefined ? {} : { action: structuredClone(action) }),
      };
    }
  }
}

function assistantDraftBlocks(
  request: ProviderRequest,
  completedBlocks: readonly NativeAssistantDraftBlock[],
  streamedTextByOutputIndex: ReadonlyMap<number, string>,
): NativeAssistantDraftBlock[] {
  const blocks = [...completedBlocks];
  for (const [outputIndex, content] of streamedTextByOutputIndex) {
    if (content) blocks.push({
      outputIndex, kind: 'message', content,
      streamId: providerTextStreamId(request.sessionId, request.runId, request.requestId, outputIndex),
    });
  }
  return blocks.sort((left, right) => left.outputIndex - right.outputIndex);
}

function providerOutputItemText(
  item: JsonObject,
  partType: 'output_text' | 'reasoning_text',
  required: boolean,
): string {
  const parts = item.content;
  if (!Array.isArray(parts)) {
    if (!required && parts === undefined) return '';
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output item content 不是数组。',
    );
  }
  let text = '';
  for (const part of parts) {
    if (!isRecord(part) || part.type !== partType) continue;
    if (typeof part.text !== 'string') {
      throw new LoopFailure(
        'provider_output_item_content_invalid',
        'Provider output item 文本 part 缺少 text。',
      );
    }
    text += part.text;
  }
  if (required && !text.trim()) {
    throw new LoopFailure(
      'provider_output_item_content_invalid',
      'Provider output message 没有可显示正文。',
    );
  }
  return text;
}

function selectedPlanAuthorities(events: readonly SessionEvent[], runId: string): PlanAuthority[] {
  const confirmed = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.confirmed' }> => (
      event.type === 'plan.confirmed' && event.runId === runId
    ),
  );
  if (!confirmed) return [];
  const inactive = events.some((event) => (
    event.sequence > confirmed.sequence
    && (
      event.type === 'plan.revision.requested'
      || event.type === 'plan.superseded'
      || event.type === 'plan.cancelled'
      || event.type === 'plan.invalidated'
    )
    && event.payload.planId === confirmed.payload.planId
    && event.payload.revision === confirmed.payload.revision
  ));
  const finishing = events.some(event => event.type === 'run.finishing' && event.runId === runId);
  return inactive || finishing ? [] : confirmed.payload.authorities.map(cloneAuthority);
}

function cloneAuthority(authority: PlanAuthority): PlanAuthority {
  return {
    ...authority,
    coveredOperations: authority.coveredOperations.map((operation) => ({ ...operation })),
  };
}

type ToolRequestEvent = Extract<SessionEvent, { type: 'tool.requested' }>;

function executionRequest(snapshot: LoopSnapshot, requestEvent: ToolRequestEvent, deps: AgentLoopDeps): ToolExecutionRequest {
  const runId = requestEvent.runId;
  const runtime = runtimeForToolRequest(snapshot, requestEvent);
  const approval = latestApproval(snapshot.events, runId, requestEvent.callId);
  const planAuthorities = selectedPlanAuthorities(snapshot.events, runId);
  return {
    schemaVersion: KERNEL_REQUEST_VERSION,
    type: 'tool.execute',
    requestId: deps.nextId('kernel-request'),
    sessionId: snapshot.state.sessionId,
    runId,
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: runtimeTool(runtime, requestEvent.payload.toolName).toolBindingRef,
    callId: requestEvent.callId,
    attemptId: requestEvent.payload.attemptId,
    toolName: requestEvent.payload.toolName,
    input: requestEvent.payload.input,
    workspaceBindings: contextForToolRequest(snapshot, requestEvent).workspaceBindings.map(binding => binding.itemId),
    ...(planAuthorities.length ? { planAuthorities } : {}),
    ...(approval.resolved
      ? {
          nonWorkspaceAuthority: {
            authorityId: approval.resolved.payload.authorityId,
            decision: approval.resolved.payload.decision,
          },
        }
      : {}),
  };
}

async function reviewPendingPlan(deps: AgentLoopDeps, plan: NonNullable<SessionState['pendingPlan']>, signal: AbortSignal): Promise<void> {
  let snapshot = await deps.readSnapshot();
  const requestId = plan.review!.providerRequestId;
  const runtime = runRuntimeSnapshot(snapshot, plan.runId);
  let review: ReturnType<typeof preparePlanReview> | undefined;
  let reviewError: LocalAgentError | undefined;
  let verdict: ReturnType<typeof decodeApprovalReview>;
  try {
    if (runtime.permissions['agent.permissions.workspaceMutation'] !== 'review') {
      throw new LoopFailure('plan_review_policy_changed', '审批方式已变化，未发起计划审批请求。');
    }
    review = preparePlanReview(snapshot, runtime, plan, requestId);
    snapshot = await deps.commit({ type: 'context.composed', sessionId: snapshot.state.sessionId, runId: plan.runId, payload: review.receipt });
    const result = await consumeTextProvider(review.request, deps, signal);
    snapshot = await deps.commit([providerTurnSettledEvent(snapshot.state.sessionId, plan.runId, result.completion),
      ...(result.contextUsage ? [{ type: 'context.updated' as const, sessionId: snapshot.state.sessionId, runId: plan.runId, payload: result.contextUsage }] : [])]);
    verdict = decodeApprovalReview(result.summary);
    if (verdict.decision === 'allow') {
      const admitted = await deps.composition.kernel.planAdmission({ sessionId: snapshot.state.sessionId, runId: plan.runId, mutationManifest: plan.mutationManifest });
      if (admitted.source !== 'review') verdict = { decision: 'ask', reason: '计划范围或审批方式已变化，需要人工确认。' };
    }
  } catch (error) {
    if (signal.aborted) throw error;
    reviewError = errorFact(error);
    snapshot = await deps.readSnapshot();
    if (review && !snapshot.state.providerTurns[requestId]) snapshot = await deps.commit({ type: 'provider.turn.settled',
      sessionId: snapshot.state.sessionId, runId: plan.runId, payload: { providerRequestId: requestId,
        purpose: 'approvalReview', providerRuntimeRef: review.request.providerRuntimeRef, outcome: 'failed', error: reviewError } });
    verdict = { decision: reviewError.code === 'plan_workspace_binding_invalid' ? 'deny' : 'ask',
      reason: `计划审批未完成。${reviewError.code}：${reviewError.message}` };
  }
  await deps.commit(current => {
    if (current.state.pendingPlan?.planId !== plan.planId || current.state.pendingPlan.revision !== plan.revision) return [];
    const mode = runRuntimeSnapshot(current, plan.runId).permissions['agent.permissions.workspaceMutation'];
    const result = mode === 'review' ? verdict : { decision: 'ask' as const, reason: '审批方式已变化，需要人工确认。' };
    const events: NewSessionEvent[] = [{ type: 'plan.reviewed', sessionId: current.state.sessionId, runId: plan.runId, callId: plan.callId,
      payload: { planId: plan.planId, revision: plan.revision, providerRequestId: requestId, ...result, ...(reviewError ? { error: reviewError } : {}) } }];
    if (result.decision === 'allow') events.push(...confirmationFacts(current.state, plan, deps.nextId('plan-review-decision'), 'agent', deps.nextId));
    else if (result.decision === 'deny') events.push({ type: 'plan.cancelled', sessionId: current.state.sessionId, runId: plan.runId, callId: plan.callId,
      payload: { planId: plan.planId, revision: plan.revision, commandId: deps.nextId('plan-review-denial') } });
    else events.push({ type: 'run.waiting', sessionId: current.state.sessionId, runId: plan.runId, payload: { reason: 'plan', detail: result.reason } });
    return events;
  });
}

async function acceptToolReply(deps: AgentLoopDeps, requestEvent: ToolRequestEvent, reply: ToolExecutionReply,
  signal: AbortSignal): Promise<'terminal' | 'approval' | 'retry'> {
  const runId = requestEvent.runId;
  let snapshot = await deps.readSnapshot();
  const commit = async (events: NewSessionEvent | readonly NewSessionEvent[] | ((current: LoopSnapshot) => readonly NewSessionEvent[])) => {
    snapshot = await deps.commit(events);
  };
  if (reply.callId !== requestEvent.callId) throw new LoopFailure('kernel_call_identity_mismatch', 'Kernel 返回了其他工具调用的结果。');
  if (reply.status === 'inputRejected') {
    assertToolRecordIdentity(reply.rejection, expectedToolRecordIdentity(snapshot, requestEvent));
    await commit({ type: 'tool.input-rejected', sessionId: snapshot.state.sessionId, runId,
      callId: requestEvent.callId, payload: { rejection: reply.rejection } });
    return 'terminal';
  }
  if (reply.status === 'approvalRequired') {
    const approvalId = deps.nextId('approval');
    await commit({ type: 'approval.requested', sessionId: snapshot.state.sessionId, runId,
      callId: requestEvent.callId, payload: { approvalId, preview: reply.preview } });
    if (reply.preview.approvalReviewer === 'agent') {
      const baseline = JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides);
      // Format recovery reviews the original operation and evidence, never a newer
      // target or expanded permission scope. It does not retry an execution.
      const reviewSnapshot = snapshot;
      const runtime = runRuntimeSnapshot(reviewSnapshot, runId);
      const pending = reviewSnapshot.state.pendingApprovals.find(item => item.callId === requestEvent.callId)!;
      let reviewRequestId = '';
      let reviewRecorded = false;
      let verdict: ReturnType<typeof decodeApprovalReview> = { decision: 'ask', reason: '自动审查未完成。' };
      for (let attempt = 0; attempt < 2; attempt++) {
        reviewRequestId = deps.nextId('provider-request');
        reviewRecorded = false;
        let review: ReturnType<typeof prepareApprovalReview> | undefined;
        try {
          review = prepareApprovalReview(reviewSnapshot, runtime, pending, reviewRequestId, attempt > 0);
          await commit({ type: 'context.composed', sessionId: snapshot.state.sessionId, runId, payload: review.receipt });
          const result = await consumeTextProvider(review.request, deps, signal);
          // The Provider completed even if its decision is malformed. Preserve its
          // completion and usage; interpretation errors belong to the review fact.
          await commit([providerTurnSettledEvent(snapshot.state.sessionId, runId, result.completion),
            ...(result.contextUsage ? [{ type: 'context.updated' as const,
            sessionId: snapshot.state.sessionId, runId, payload: result.contextUsage }] : [])]);
          if (!snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)) return 'retry';
          verdict = decodeApprovalReview(result.summary);
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          const fact = errorFact(error);
          if (review && !snapshot.state.providerTurns[review.request.requestId]) await commit({ type: 'provider.turn.settled',
            sessionId: snapshot.state.sessionId, runId, payload: { providerRequestId: review.request.requestId,
              purpose: 'approvalReview', providerRuntimeRef: review.request.providerRuntimeRef, outcome: 'failed', error: fact } });
          verdict = { decision: 'ask', reason: `自动审查无法完成，需要你决定是否执行。\n${fact.code}：${fact.message}` };
          const retryFormat = attempt === 0 && error instanceof ApprovalReviewFormatFailure
            && JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) === baseline
            && snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId);
          if (error instanceof ApprovalReviewFormatFailure) {
            const response = fact.diagnostics?.causes.find(cause => cause.kind === 'response')?.message;
            verdict = { decision: 'ask', reason: `${retryFormat ? '审批结果格式无效，正在按原请求重试一次。' : '无法读取有效的审核结果，需要你决定是否执行。'}\n${fact.message}\n原始响应：${response}` };
            // Withhold authority without entering run.waiting during recovery.
            await commit({ type: 'approval.reviewed', sessionId: snapshot.state.sessionId, runId,
              callId: requestEvent.callId, payload: { approvalId, providerRequestId: reviewRequestId, ...verdict } });
            reviewRecorded = true;
          }
          // Recording the failure yields to the Actor; a user decision or a
          // permission update during that commit must prevent the next review.
          if (!snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)) return 'retry';
          if (retryFormat && JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) === baseline) continue;
          break;
        }
      }
      if (!reviewRecorded) {
        await commit(current => {
          const events: NewSessionEvent[] = [{ type: 'approval.reviewed', sessionId: current.state.sessionId, runId,
            callId: requestEvent.callId, payload: { approvalId, providerRequestId: reviewRequestId, ...verdict } }];
          if (verdict.decision !== 'ask') events.push({ type: 'approval.resolved', sessionId: current.state.sessionId, runId,
            callId: requestEvent.callId, payload: { approvalId, commandId: deps.nextId('agent-decision'),
              authorityId: deps.nextId('authority'), decision: verdict.decision, source: 'agent', reason: verdict.reason } });
          return events;
        });
      }
      if (!snapshot.state.pendingApprovals.some(item => item.callId === requestEvent.callId)) return 'retry';
    }
    return 'approval';
  }
  await commitToolRecord(reply.record, expectedToolRecordIdentity(snapshot, requestEvent), commit);
  return 'terminal';
}

/** Execution is concurrent; all facts still pass through the Actor's serial commit port. */
async function dispatchPendingTools(deps: AgentLoopDeps, runId: string, signal: AbortSignal): Promise<LoopResult | undefined> {
  let snapshot = await deps.readSnapshot();
  const pending = pendingToolRequests(snapshot.events, runId);
  const isRead = (event: ToolRequestEvent) => event.payload.toolName === 'fs.read';
  const isFile = (event: ToolRequestEvent) => event.payload.toolName === 'fs.write' || event.payload.toolName === 'fs.edit';
  let enteredSegmentEnd = 0;
  try {
    for (let offset = 0; offset < pending.length;) {
      signal.throwIfAborted();
      const first = pending[offset]!;
      let end = offset + 1;
      if (isFile(first)) while (end < pending.length && isFile(pending[end]!)) end += 1;
      else if (isRead(first)) while (end < pending.length && isRead(pending[end]!)) end += 1;
      const segment = pending.slice(offset, end);
      const dependencies = new Map<string, string[]>();
      if (isFile(first)) {
        snapshot = await deps.readSnapshot();
        const preparation = await deps.composition.kernel.prepareFileCalls({ requests: segment.map(event => executionRequest(snapshot, event, deps)) });
        if (preparation.calls.length !== segment.length || preparation.calls.some((item, index) => item.callId !== segment[index]!.callId
          || item.conflictsWith.some(id => !segment.slice(0, index).some(event => event.callId === id)))) {
          throw new LoopFailure('tool_preparation_identity_mismatch', 'Kernel 文件准备结果与原始调用顺序不一致。');
        }
        for (const item of preparation.calls) {
          dependencies.set(item.callId, item.conflictsWith);
          if (item.rejection) await acceptToolReply(deps, segment.find(event => event.callId === item.callId)!, {
            schemaVersion: KERNEL_REPLY_VERSION, type: 'tool.execution', requestId: deps.nextId('kernel-request'),
            callId: item.callId, status: 'inputRejected', rejection: item.rejection,
          }, signal);
        }
      }
      enteredSegmentEnd = end;
      const waiting = await executeToolSegment(deps, segment, dependencies, signal);
      if (waiting) return waiting;
      offset = end;
    }
  } catch (error) {
    // Later order barriers were never submitted, even if the current segment failed.
    const current = await deps.readSnapshot();
    const unresolved = new Set(pendingToolRequests(current.events, runId).map(event => event.callId));
    for (const event of pending.slice(enteredSegmentEnd)) if (unresolved.has(event.callId)) await deps.commit({
      type: 'tool.not-executed', sessionId: event.sessionId, runId, callId: event.callId,
      payload: { attemptId: event.payload.attemptId, reason: 'cancelled' },
    });
    throw error;
  }
  return undefined;
}

async function executeToolSegment(deps: AgentLoopDeps, segment: ToolRequestEvent[], dependencies: Map<string, string[]>,
  signal: AbortSignal): Promise<LoopResult | undefined> {
  const runId = segment[0]!.runId;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  type Completion = { event: ToolRequestEvent; permissions: string; reply?: ToolExecutionReply; error?: unknown };
  const active = new Map<string, Promise<Completion>>();
  const approvals = new Map<string, { permissions: string }>();
  let failure: { error: unknown } | undefined;
  const markNotExecuted = async (event: ToolRequestEvent, predecessorCallId?: string) => {
    await deps.commit({ type: 'tool.not-executed', sessionId: event.sessionId, runId, callId: event.callId,
      payload: { attemptId: event.payload.attemptId, reason: predecessorCallId ? 'dependencyFailed' : 'cancelled',
        ...(predecessorCallId ? { predecessorCallId } : {}) } });
  };
  try {
    while (true) {
      let snapshot = await deps.readSnapshot();
      const pending = new Set(pendingToolRequests(snapshot.events, runId).map(event => event.callId));
      const remaining = segment.filter(event => pending.has(event.callId));
      if (!remaining.length && !active.size) break;
      for (const event of remaining) {
        if (active.has(event.callId)) continue;
        if (controller.signal.aborted) { await markNotExecuted(event); approvals.delete(event.callId); continue; }
        const predecessors = dependencies.get(event.callId) ?? [];
        const failed = predecessors.find(id => !pending.has(id) && snapshot.state.activities[`tool:${id}`]?.status !== 'completed');
        if (failed) { await markNotExecuted(event, failed); continue; }
        if (predecessors.some(id => pending.has(id))) continue;
        const waiting = approvals.get(event.callId);
        if (waiting) {
          const approval = latestApproval(snapshot.events, runId, event.callId);
          if (!approval.resolved && JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) === waiting.permissions) continue;
          approvals.delete(event.callId);
        }
        if (active.size >= 4) continue;
        const request = executionRequest(snapshot, event, deps);
        const permissions = JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides);
        active.set(event.callId, executeUntilAbort(deps, request, controller.signal)
          .then(reply => ({ event, permissions, reply }), error => ({ event, permissions, error })));
      }
      snapshot = await deps.readSnapshot();
      if (!active.size) {
        const stillPending = segment.filter(event => pendingToolRequests(snapshot.events, runId).some(item => item.callId === event.callId));
        if (!stillPending.length) break;
        if (controller.signal.aborted) continue;
        if (!approvals.size) continue; // A predecessor terminal was committed during this pass.
        if (snapshot.state.run?.status !== 'waiting') snapshot = await deps.commit({ type: 'run.waiting', sessionId: snapshot.state.sessionId,
          runId, payload: { reason: 'approval', detail: '等待工具执行审批。' } });
        if (!deps.waitForChange) return { status: 'waiting', runId, reason: 'approval', callId: approvals.keys().next().value! };
        await deps.waitForChange(snapshot.state.revision, controller.signal, snapshot.state.publishedPermissions);
        continue;
      }
      const waitController = new AbortController();
      const wakeAbort = () => waitController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', wakeAbort, { once: true });
      let completed: Completion | undefined;
      try {
        const changed = deps.waitForChange && approvals.size && !controller.signal.aborted
          ? deps.waitForChange(snapshot.state.revision, waitController.signal, snapshot.state.publishedPermissions).then(() => undefined, () => undefined) : undefined;
        completed = await Promise.race([...active.values(), ...(changed ? [changed] : [])]);
      } finally {
        waitController.abort();
        controller.signal.removeEventListener('abort', wakeAbort);
      }
      if (!completed) continue;
      active.delete(completed.event.callId);
      if ('error' in completed) {
        failure ??= { error: completed.error };
        controller.abort(completed.error);
        // The dispatched call remains unresolved until Kernel runtime release proves its final result.
        segment = segment.filter(event => event.callId !== completed!.event.callId);
        continue;
      }
      if (completed.reply!.status === 'approvalRequired' && controller.signal.aborted) {
        await markNotExecuted(completed.event);
        continue;
      }
      try {
        const accepted = await acceptToolReply(deps, completed.event, completed.reply!, controller.signal);
        if (accepted === 'approval') {
          approvals.set(completed.event.callId, { permissions: completed.permissions });
        }
      } catch (error) {
        failure ??= { error }; controller.abort(error);
        segment = segment.filter(event => event.callId !== completed!.event.callId);
      }
    }
  } catch (error) {
    failure ??= { error }; controller.abort(error);
    // Broadcast abort first; each execution owner receives cancellation before any drain is awaited.
    const completed = await Promise.all(active.values());
    for (const item of completed) if (item.reply) {
      if (item.reply.status === 'approvalRequired') await markNotExecuted(item.event);
      else await acceptToolReply(deps, item.event, item.reply, controller.signal);
    }
    const current = await deps.readSnapshot();
    for (const event of segment) if (!active.has(event.callId)
      && pendingToolRequests(current.events, runId).some(item => item.callId === event.callId)
      && !current.events.some(item => item.type === 'tool.started' && item.callId === event.callId)) await markNotExecuted(event);
  } finally { signal.removeEventListener('abort', onAbort); }
  if (failure) throw failure.error;
  signal.throwIfAborted();
  return undefined;
}

async function cancelRun(
  snapshot: LoopSnapshot,
  command: Extract<LoopCommand, { type: 'cancel' }>,
  deps: AgentLoopDeps,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<LoopResult> {
  if (hasSettlement(snapshot.events, command.runId)) {
    return settlementResult(snapshot.events, command.runId);
  }
  // The scheduler drains dispatched calls before cancellation settles the run.
  // Their uncertain outcomes must survive after they leave the pending set.
  const uncertain = snapshot.events.find(event => event.type === 'tool.completed'
    && event.runId === command.runId && event.payload.record.outcome === 'indeterminate');
  let indeterminate: LocalAgentError | undefined = uncertain?.type === 'tool.completed' && uncertain.payload.record.outcome === 'indeterminate'
    ? uncertain.payload.record.error : undefined;
  const pending = pendingToolRequests(snapshot.events, command.runId);
  const replies = await Promise.allSettled(pending.map(current => deps.composition.kernel.cancel(current.callId, current.payload.attemptId)));
  let cleanupFailure: unknown;
  for (const [index, result] of replies.entries()) {
    const current = pending[index]!;
    if (result.status === 'rejected') { cleanupFailure ??= result.reason; continue; }
    const reply = result.value;
    if (reply.status !== 'notFound') {
      await commitToolRecord(reply.record, expectedToolRecordIdentity(snapshot, current), commit);
      if (reply.record.outcome === 'indeterminate') indeterminate = reply.record.error;
    } else if (latestApproval(snapshot.events, command.runId, current.callId).requested) {
      await commit({ type: 'tool.not-executed', sessionId: snapshot.state.sessionId, runId: command.runId,
        callId: current.callId, payload: { attemptId: current.payload.attemptId, reason: 'cancelled' } });
    } else {
      indeterminate = { code: 'tool_effect_outcome_unknown', message: '取消时 Kernel 没有该调用的确定记录。' };
    }
  }
  if (cleanupFailure) throw cleanupFailure;

  if (indeterminate) {
    await commit({
      type: 'run.finishing',
      sessionId: snapshot.state.sessionId,
      runId: command.runId,
      payload: { outcome: 'indeterminate', error: indeterminate },
    });
    return finishingResult(command.runId, { outcome: 'indeterminate', error: indeterminate });
  }
  await commit({
    type: 'run.finishing',
    sessionId: snapshot.state.sessionId,
    runId: command.runId,
    payload: { outcome: 'cancelled' },
  });
  return finishingResult(command.runId, { outcome: 'cancelled' });
}

async function executeUntilAbort(
  deps: AgentLoopDeps,
  request: ToolExecutionRequest,
  signal: AbortSignal,
): Promise<ToolExecutionReply> {
  if (signal.aborted) {
    await cancelExecutingAttempt(deps, request);
    throw signal.reason ?? new Error('run_cancelled');
  }
  let observing = true;
  const execution = deps.composition.kernel.execute(request, async (progress) => {
    if (!observing) return;
    if (progress.type === 'started') {
      await deps.commit({ type: 'tool.started', sessionId: request.sessionId, runId: request.runId,
        callId: request.callId, payload: { attemptId: request.attemptId, startedAt: progress.startedAt } });
    }
    if (observing) deps.updateToolProgress?.(request.callId, progress);
  });
  void execution.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const winner = await Promise.race([
      execution.then((reply) => ({ type: 'execution' as const, reply })),
      aborted.then(() => ({ type: 'abort' as const })),
    ]);
    if (winner.type === 'execution') return winner.reply;
    const cancelled = await cancelExecutingAttempt(deps, request);
    if (cancelled.status === 'notFound') return await execution;
    return {
      schemaVersion: KERNEL_REPLY_VERSION,
      type: 'tool.execution',
      requestId: request.requestId,
      callId: request.callId,
      status: cancelled.status,
      record: cancelled.record,
    };
  } finally {
    observing = false;
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function cancelExecutingAttempt(
  deps: AgentLoopDeps,
  request: ToolExecutionRequest,
) {
  try {
    return await deps.composition.kernel.cancel(request.callId, request.attemptId);
  } catch (error) {
    throw new LoopFailure(
      'tool_cancel_cleanup_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function commitToolRecord(
  record: ToolExecutionRecord,
  expected: ExpectedToolRecordIdentity,
  commit: (event: NewSessionEvent | readonly NewSessionEvent[]) => Promise<void>,
): Promise<void> {
  assertToolRecordIdentity(record, expected);
  await commit({
    type: 'tool.completed',
    sessionId: record.sessionId,
    runId: expected.runId,
    callId: expected.callId,
    payload: { record },
  });
}

function expectedToolRecordIdentity(
  snapshot: LoopSnapshot,
  requestEvent: Extract<SessionEvent, { type: 'tool.requested' }>,
): ExpectedToolRecordIdentity {
  const runtime = runtimeForToolRequest(snapshot, requestEvent);
  return {
    sessionId: snapshot.state.sessionId,
    runId: requestEvent.runId,
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: runtimeTool(runtime, requestEvent.payload.toolName).toolBindingRef,
    callId: requestEvent.callId,
    attemptId: requestEvent.payload.attemptId,
    toolName: requestEvent.payload.toolName,
    input: requestEvent.payload.input,
  };
}

function assertToolRecordIdentity(
  record: ToolExecutionRecord | ToolInputRejection,
  expected: ExpectedToolRecordIdentity,
): void {
  if (
    record.sessionId !== expected.sessionId
    || record.runId !== expected.runId
    || record.extensionGenerationRef !== expected.extensionGenerationRef
    || record.kernelCatalogSnapshotRef !== expected.kernelCatalogSnapshotRef
    || record.toolBindingRef !== expected.toolBindingRef
    || record.callId !== expected.callId
    || record.attemptId !== expected.attemptId
    || record.toolName !== expected.toolName
    || JSON.stringify(canonicalJsonValue(record.input))
      !== JSON.stringify(canonicalJsonValue(expected.input))
  ) {
    throw new LoopFailure(
      'kernel_record_identity_mismatch',
      'Kernel 记录不属于当前 run 固定的工具 binding 或调用事实。',
    );
  }
}

/** Called only after Kernel runtime release has drained owned attempts. */
export async function terminalToolEvents(
  snapshot: LoopSnapshot,
  runId: string,
  kernel: AgentComposition['kernel'],
  settlement: RunSettlement,
): Promise<NewSessionEvent[]> {
  const events: NewSessionEvent[] = [];
  for (const request of pendingToolRequests(snapshot.events, runId)) {
    let record: ToolExecutionRecord | null = null;
    let lookupError: LocalAgentError | undefined;
    try {
      record = await kernel.readRecord(request.callId);
    } catch (error) {
      lookupError = localAgentError(error);
    }
    if (record) {
      assertToolRecordIdentity(record, expectedToolRecordIdentity(
        snapshot, request,
      ));
      events.push({
        type: 'tool.completed', sessionId: snapshot.state.sessionId, runId,
        callId: request.callId, payload: { record },
      });
    } else {
      const cause = 'error' in settlement ? settlement.error : undefined;
      events.push({
        type: 'tool.interrupted', sessionId: snapshot.state.sessionId, runId,
        callId: request.callId,
        payload: {
          attemptId: request.payload.attemptId,
          error: {
            code: 'tool_result_unknown',
            message: `Runtime 已释放；调用 ${request.callId}（attempt ${request.payload.attemptId}）没有可确认的 Kernel 结果。执行与副作用未知，请先检查实际状态，勿自动重复执行。`
              + (cause ? ` 原始错误 ${cause.code}: ${cause.message}` : ` Run ${settlement.outcome}。`)
              + (lookupError ? ` 结果读取失败 ${lookupError.code}: ${lookupError.message}` : ''),
          },
        },
      });
    }
  }
  return events;
}

export function pendingToolRequests(
  events: readonly SessionEvent[],
  runId: string,
): Array<Extract<SessionEvent, { type: 'tool.requested' }>> {
  const completed = new Set(events.flatMap((event) => (
    (event.type === 'tool.completed' || event.type === 'tool.input-rejected' || event.type === 'tool.interrupted' || event.type === 'tool.not-executed')
      && event.runId === runId ? [event.callId] : []
  )));
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool.requested' }> => (
      event.type === 'tool.requested'
      && event.runId === runId
      && !completed.has(event.callId)
    ),
  );
}

function latestApproval(
  events: readonly SessionEvent[],
  runId: string,
  callId: string,
): {
  requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
  resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
} {
  const result: {
    requested?: Extract<SessionEvent, { type: 'approval.requested' }>;
    resolved?: Extract<SessionEvent, { type: 'approval.resolved' }>;
  } = {};
  for (const event of events) {
    if (event.type === 'approval.requested' && event.runId === runId && event.callId === callId) {
      result.requested = event;
      delete result.resolved;
    }
    if (event.type === 'approval.resolved' && event.runId === runId && event.callId === callId) {
      result.resolved = event;
    }
  }
  return result;
}

function decodeContextUsage(data: Record<string, unknown>): ProviderTokenUsage | undefined {
  const value = data.usage;
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的 usage 不是对象。');
  }
  const inputTokens = positiveOrZeroInteger(value.inputTokens);
  const outputTokens = positiveOrZeroInteger(value.outputTokens);
  const contextWindowTokens = positiveInteger(value.contextWindowTokens);
  const cacheReadPresent = Object.hasOwn(value, 'cacheReadInputTokens');
  const cacheMissPresent = Object.hasOwn(value, 'cacheMissInputTokens');
  const cacheReadInputTokens = !cacheReadPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheReadInputTokens);
  const cacheMissInputTokens = !cacheMissPresent
    ? undefined
    : positiveOrZeroInteger(value.cacheMissInputTokens);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || contextWindowTokens === undefined
    || inputTokens + outputTokens > contextWindowTokens
    || cacheReadPresent !== cacheMissPresent
    || cacheReadPresent && (cacheReadInputTokens === undefined || cacheMissInputTokens === undefined)
    || cacheReadInputTokens !== undefined && cacheMissInputTokens !== undefined
      && cacheReadInputTokens + cacheMissInputTokens !== inputTokens
  ) {
    throw new LoopFailure('provider_usage_invalid', 'Provider 完成事件中的上下文计数无效。');
  }
  return {
    inputTokens,
    outputTokens,
    contextWindowTokens,
    ...(cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens, cacheMissInputTokens: cacheMissInputTokens! }),
  };
}

function assertProviderEvent(event: ProviderEvent, requestId: string): void {
  if (event.requestId !== requestId) {
    throw new LoopFailure('provider_request_identity_mismatch', 'Provider 事件属于其他请求。');
  }
}

async function agentControlFact(
  deps: AgentLoopDeps,
  sessionId: string,
  runId: string,
  runtime: RunRuntimeSnapshot,
  call: { callId: string; providerCallId: string; operation: AgentOperation },
  afterSequence: number,
  signal: AbortSignal,
): Promise<NewSessionEvent> {
  try {
    if (!deps.agents || !runtime.agentToolsEnabled
      || !(runtime.agentCapabilities.messaging || runtime.agentCapabilities.delegation)) {
      throw new LoopFailure('agent_unavailable', '当前任务未启用子代理能力。');
    }
    const result = await deps.agents.execute(runId, call.callId, call.operation, signal);
    const waits = call.operation.action === 'wait' || call.operation.action === 'spawn' && call.operation.delivery === 'wait';
    return { type: 'agent.control.completed', sessionId, runId, callId: call.callId,
      payload: { providerCallId: call.providerCallId, operation: { ...call.operation },
        result: waits ? { ...result, wait: { afterSequence } } : result } };
  } catch (error) {
    return controlRejectionFact(sessionId, runId, { callId: call.callId,
      providerCallId: call.providerCallId, toolName: SESSION_CONTROL_AGENT,
      input: { ...call.operation }, error: localAgentError(error) });
  }
}

function controlRejectionFact(
  sessionId: string,
  runId: string,
  rejection: ProviderControlRejection,
): NewSessionEvent {
  return {
    type: 'session.control.rejected', sessionId, runId, callId: rejection.callId,
    payload: {
      providerCallId: rejection.providerCallId,
      toolName: rejection.toolName,
      input: { ...rejection.input },
      error: { ...rejection.error },
    },
  };
}

function hasSettlement(events: readonly SessionEvent[], runId: string): boolean {
  return events.some((event) => event.type === 'run.settled' && event.runId === runId);
}

export function uncompletedProviderComposition(
  snapshot: LoopSnapshot,
  runId: string,
): SessionState['contextCompositions'][number] | null {
  return snapshot.state.contextCompositions.find((receipt) => (
    receipt.runId === runId
    && snapshot.state.providerTurns[receipt.providerRequestId] === undefined
  )) ?? null;
}

function runRuntimeSnapshot(snapshot: LoopSnapshot, runId: string): RunRuntimeSnapshot {
  const runtime = snapshot.state.runRuntimeSnapshots[runId];
  if (!runtime) throw new LoopFailure('run_runtime_snapshot_missing', '当前 run 缺少运行时快照。');
  const view = { ...runtime, ...snapshot.state.runToolViews[runId] };
  if (snapshot.state.run?.runId === runId && snapshot.state.run.hostBinding) {
    view.environment = { ...view.environment, hostBinding: { ...snapshot.state.run.hostBinding } };
  }
  const permissions = snapshot.state.publishedPermissions ?? permissionSettings({ ...runtime.permissions, ...snapshot.state.permissionOverrides });
  return { ...view, permissions, instructions: view.instructions.map(instruction => instruction.id === 'deepcode.workspace-autonomy'
    ? { ...instruction, text: permissionInstructionText(permissions,
      view.providerToolAliases.find(alias => alias.canonicalName === SESSION_CONTROL_INTERACTION_REQUEST)?.wireName,
      view.providerToolAliases.find(alias => alias.canonicalName === SESSION_CONTROL_PLAN_PUBLISH)?.wireName) } : instruction) };
}

function contextForToolRequest(snapshot: LoopSnapshot, request: Extract<SessionEvent, { type: 'tool.requested' }>) {
  const turn = Object.values(snapshot.state.providerTurns).find(turn => turn.runId === request.runId && turn.orderedCallIds?.includes(request.callId));
  const receipt = snapshot.state.contextCompositions.find(item => item.runId === request.runId && item.providerRequestId === turn?.providerRequestId);
  if (!receipt) throw new LoopFailure('tool_request_binding_missing', '工具调用缺少所属 Provider 请求视图。');
  return receipt;
}

function runtimeForToolRequest(snapshot: LoopSnapshot, request: Extract<SessionEvent, { type: 'tool.requested' }>): RunRuntimeSnapshot {
  const receipt = contextForToolRequest(snapshot, request);
  const base = snapshot.state.runRuntimeSnapshots[request.runId];
  if (!base) throw new LoopFailure('tool_request_binding_missing', '工具调用缺少所属 run。');
  if (!receipt.kernelCatalogSnapshotRef || receipt.kernelCatalogSnapshotRef === base.kernelCatalogSnapshotRef) return base;
  const prepared = snapshot.events.find((event) => (event.type === 'run.tools.prepared' || event.type === 'run.host.rebound')
    && event.runId === request.runId && event.payload.toolView.kernelCatalogSnapshotRef === receipt.kernelCatalogSnapshotRef);
  if (prepared?.type !== 'run.tools.prepared' && prepared?.type !== 'run.host.rebound') throw new LoopFailure('tool_request_binding_missing', '工具请求引用的准备视图不存在。');
  return { ...base, ...prepared.payload.toolView };
}

function runtimeTool(runtime: RunRuntimeSnapshot, name: string): PreparedToolDescriptor {
  const tool = runtime.tools.find((candidate) => candidate.name === name);
  if (!tool || tool.availability !== 'callable') {
    throw new LoopFailure('run_tool_binding_missing', `当前 run 缺少可调用工具 binding：${name}`);
  }
  return tool;
}

function providerTurnSettledEvent(
  sessionId: string,
  runId: string,
  completion: ProviderTurnCompletion,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: completion.providerRequestId,
      purpose: completion.purpose,
      providerRuntimeRef: completion.providerRuntimeRef,
      outcome: 'completed',
      orderedCallIds: [...completion.orderedCallIds],
      ...(completion.reasoningContent !== undefined
        ? { reasoningContent: completion.reasoningContent }
        : {}),
      ...(completion.reasoningSignature !== undefined
        ? { reasoningSignature: completion.reasoningSignature }
        : {}),
      ...(completion.hostedWebSearchCalls !== undefined
        ? {
            hostedWebSearchCalls: completion.hostedWebSearchCalls
              .map((item) => structuredClone(item)),
          }
        : {}),
      ...(completion.toolCallInputs ? { toolCallInputs: structuredClone(completion.toolCallInputs) } : {}),
      ...(completion.orderedOutputBlocks !== undefined
        ? {
            orderedOutputBlocks: completion.orderedOutputBlocks.map((block) => ({
              ...block,
              item: structuredClone(block.item),
            })),
          }
        : {}),
    },
  };
}

export function providerTurnTerminalEvent(
  sessionId: string,
  runId: string,
  composition: SessionState['contextCompositions'][number],
  providerRuntimeRef: string,
  settlement: Extract<RunSettlement, { outcome: 'failed' | 'indeterminate' }>,
): NewSessionEvent {
  return {
    type: 'provider.turn.settled',
    sessionId,
    runId,
    payload: {
      providerRequestId: composition.providerRequestId,
      purpose: composition.purpose,
      providerRuntimeRef,
      outcome: settlement.outcome,
      error: { ...settlement.error },
    },
  };
}

function orderedProviderCallFacts(
  completion: ProviderTurnCompletion,
  facts: readonly NewSessionEvent[],
): NewSessionEvent[] {
  const byCallId = new Map<string, NewSessionEvent>();
  for (const fact of facts) {
    if (!('callId' in fact) || !fact.callId || byCallId.has(fact.callId)) {
      throw new LoopFailure(
        'provider_turn_call_fact_invalid',
        'Provider turn 的调用事实缺少或重复 LogicalCallId。',
      );
    }
    byCallId.set(fact.callId, fact);
  }
  if (
    byCallId.size !== completion.orderedCallIds.length
    || completion.orderedCallIds.some((callId) => !byCallId.has(callId))
  ) {
    throw new LoopFailure(
      'provider_turn_call_fact_mismatch',
      'Provider turn 完成事实与本 turn 的调用事实集合不一致。',
    );
  }
  return completion.orderedCallIds.map((callId) => byCallId.get(callId)!);
}

function settlementResult(events: readonly SessionEvent[], runId: string): LoopResult {
  const event = events.findLast(
    (candidate): candidate is Extract<SessionEvent, { type: 'run.settled' }> => (
      candidate.type === 'run.settled' && candidate.runId === runId
    ),
  );
  if (!event) throw new Error('run_settlement_missing');
  return { status: 'settled', runId, outcome: event.payload.outcome };
}

function finishingResult(runId: string, settlement: RunSettlement): LoopResult {
  return {
    status: 'finishing',
    runId,
    settlement: settlement.outcome === 'completed'
      ? { ...settlement }
      : settlement.outcome === 'failed' || settlement.outcome === 'indeterminate'
        ? { outcome: settlement.outcome, error: { ...settlement.error } }
        : { outcome: 'cancelled' },
  };
}

export function loopSnapshot(sessionId: string, events: readonly SessionEvent[]): LoopSnapshot {
  return { journalEvents: [...events], events: activeConversationEvents(events), state: recoverSession(sessionId, events) };
}

function runWorkspaceBindings(
  snapshot: LoopSnapshot,
  runId: string,
): WorkspaceBindingDisplay[] {
  const run = snapshot.state.run;
  if (!run || run.runId !== runId) {
    throw new LoopFailure('run_workspace_snapshot_missing', '当前 run 缺少已记录的工作区绑定。');
  }
  return requestResourceBindings(run.workspaceBindings, snapshot.events);
}

function positiveOrZeroInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error('run_cancelled');
}

function localAgentError(error: unknown): LocalAgentError {
  if (error instanceof LoopFailure) return errorFact(error);
  if (error instanceof SessionControlError) return { code: error.code, message: error.message };
  return errorFact(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
