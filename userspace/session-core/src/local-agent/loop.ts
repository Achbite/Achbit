import type { LoopSnapshot, LoopCommand, AgentLoopDeps, LoopResult } from './loopTypes.js';
import { providerRuntimeForPurpose } from '@achbit/protocol';
import type { NewSessionEvent, RunSettlement } from '@achbit/protocol';
import {
  hasSettlement, settlementResult, uncompletedProviderComposition, providerTurnTerminalEvent,
  runRuntimeSnapshot, finishingResult, throwIfAborted, latestAgentEvidenceSequence, runWorkspaceContext,
  localAgentError,
} from './loopFacts.js';
import {
  pendingToolRequests, commitToolRecord, expectedToolRecordIdentity, latestApproval, cancelRun,
  dispatchPendingTools,
} from './loopTools.js';
import {
  acquireCapabilities, ToolViewRetirementFailure, releaseCapabilities, CapabilityReleaseFailure,
} from './loopCapabilities.js';
import { prepareControlTurn, settleProviderTurn } from './loopTurn.js';
import { pendingContextCompaction } from './compaction.js';
import { performContextCompaction, prepareTurnBudget } from './loopContext.js';
import { LoopFailure, ProviderReportedFailure, ProviderCompletedFailure } from './loopFailure.js';
import { modelContextEvents } from './modelContext.js';
import { stageForRequest } from './sessionCapabilities.js';
import { consumeProvider } from './loopProvider.js';
export type { LoopSnapshot } from './loopTypes.js';
export type { LoopCommand } from './loopTypes.js';
export type { LoopResult } from './loopTypes.js';
export type { AgentLoopDeps } from './loopTypes.js';
export { terminalToolEvents } from './loopTools.js';
export { pendingToolRequests } from './loopTools.js';
export { uncompletedProviderComposition } from './loopFacts.js';
export { providerTurnTerminalEvent } from './loopFacts.js';
export { loopSnapshot } from './loopFacts.js';

/** One durable request/tool/continuation loop; optional capabilities are leased per turn. */
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
  let lastRetainedCatalog: string | undefined;
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

    while (true) {
      throwIfAborted(signal);
      const lease = acquireCapabilities(deps);
      let requestFailure: { error: unknown } | undefined;
      try {
        const capabilities = lease.implementation;
        snapshot = await deps.readSnapshot();
        if (capabilities.controls) {
          const prepared = await prepareControlTurn(snapshot, deps, runId, signal);
          if ('status' in prepared) return prepared;
          snapshot = prepared;
        }
        const pendingCompaction = capabilities.compaction && pendingContextCompaction(snapshot.events, runId);
        if (pendingCompaction) {
          await performContextCompaction(snapshot, pendingCompaction, runId, deps, signal, commit);
          continue;
        }
        const waitingForTools = await dispatchPendingTools(deps, runId, signal);
        if (waitingForTools) return waitingForTools;
        if (deps.activity) await deps.activity.waitPending(await deps.readSnapshot(), signal);

        throwIfAborted(signal);
        snapshot = await deps.takeQueuedInputs(runId);
        if (deps.activity) {
          await deps.activity.sync();
          snapshot = await deps.readSnapshot();
        }
        runtime = runRuntimeSnapshot(snapshot, runId);
        if (snapshot.state.contextHandoff?.status === 'reading') {
          const failedRead = snapshot.events.findLast(event => event.type === 'tool.completed' && event.runId === runId
            && event.payload.record.toolName === 'session.read');
          if (failedRead?.type === 'tool.completed') throw new LoopFailure('model_handoff_read_failed',
            'error' in failedRead.payload.record ? (failedRead.payload.record.error?.message ?? '未获得完整的历史读取结果，接手未完成。') : '未获得完整的历史读取结果，接手未完成。');
        }
        throwIfAborted(signal);
        if (runtime.kernelCatalogSnapshotRef !== lastRetainedCatalog) {
          try {
            await deps.composition.runPreparation.retireToolViews({
              sessionId: snapshot.state.sessionId, runId,
              keepKernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
            });
            lastRetainedCatalog = runtime.kernelCatalogSnapshotRef;
          } catch (error) {
            throw new ToolViewRetirementFailure(error);
          }
        }
        deps.activity?.checkpoint(snapshot);
        const agentEvidenceRevision = capabilities.controls ? latestAgentEvidenceSequence(snapshot.events, runId) : 0;
        const preparedProviderRequest = await capabilities.context.prepare({
          sessionId: snapshot.state.sessionId,
          runId,
          runtime,
          events: modelContextEvents(snapshot.events),
          historyEvents: snapshot.events,
          responseConstraint: 'normal',
          toolGuidance: deps.composition.toolGuidance,
          toolStage: stageForRequest(capabilities, runtime, snapshot.state),
          ...runWorkspaceContext(snapshot, runId),
          providerRequestId: deps.nextId('provider-request'),
        }, signal);
        const request = prepareTurnBudget(snapshot, runId, runtime, preparedProviderRequest.receipt, capabilities, deps.nextId);
        if (request) {
          throwIfAborted(signal);
          await commit(request);
          continue;
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
        const result = await settleProviderTurn(snapshot, turn, preparedProviderRequest.receipt, runtime,
          capabilities, lease, agentEvidenceRevision, runId, deps, signal);
        if (result) return result;
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
    // Intentional cancellation is a local terminal outcome, not a failed generation.
    // Only the exact abort reason qualifies; independent errors and cleanup failures keep their facts.
    if (userCancelled && requestError === signal.reason && !releaseFailed) {
      if (pendingProvider) {
        await commit(providerTurnTerminalEvent(snapshot.state.sessionId, runId, pendingProvider,
          providerRuntimeForPurpose(runRuntimeSnapshot(snapshot, runId), pendingProvider.purpose).providerRuntimeRef,
          { outcome: 'cancelled' }));
        snapshot = await deps.readSnapshot();
      }
      return await cancelRun(snapshot, { type: 'cancel', runId }, deps, commit);
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
