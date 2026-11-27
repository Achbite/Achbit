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
  dispatchPendingTools, interruptedApprovalReviews,
} from './loopTools.js';
import {
  acquireCapabilities, ToolViewRetirementFailure, releaseCapabilities, CapabilityReleaseFailure,
} from './loopCapabilities.js';
import { prepareControlTurn, settleProviderTurn } from './loopTurn.js';
import { continueCompaction, pendingContextCompaction } from './compaction.js';
import { performContextCompaction, prepareTurnBudget } from './loopContext.js';
import { LoopFailure, ProviderReportedFailure, ProviderCompletedFailure } from './loopFailure.js';
import { waitForRetryAt } from './providerAttempts.js';
import { modelContextEvents } from './modelContext.js';
import { stageForRequest } from './sessionCapabilities.js';
import { consumeProvider } from './loopProvider.js';
import { capacityTicket, CapacityStartUnknown } from './agentCapacity.js';
import { TruncatedToolOutput } from './truncatedOutput.js';
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
        message: `Provider request ${interrupted.providerRequestId} has a composed context and no recorded completion.`,
      },
    };
    const turn = providerTurnTerminalEvent(snapshot.state.sessionId, runId, interrupted,
      providerRuntimeForPurpose(runRuntimeSnapshot(snapshot, runId), interrupted.purpose).providerRuntimeRef, settlement);
    // Only this exact tool-free request can end indeterminately without making the original dispatch unknown.
    // advanceCapacity will ask a human on the same gate; do not resend the review or disturb Kernel recovery.
    if (interrupted.purpose === 'approvalReview' && interrupted.responseConstraint === 'answerOnly' && !interrupted.tools.length
      && snapshot.events.some(e => e.type === 'agent.control.completed' && e.runId === runId
        && capacityTicket(e.payload.result)?.reviewRequestId === interrupted.providerRequestId)) {
      await commit(turn);
    } else {
      await commit([turn, { type: 'run.finishing', sessionId: snapshot.state.sessionId, runId, payload: settlement }]);
      return finishingResult(runId, settlement);
    }
  }
  let runtime = runRuntimeSnapshot(snapshot, runId);
  let lastRetainedCatalog: string | undefined;
  let restoreApprovals: 'resume' | 'recover' | undefined = command.type === 'resume' || command.type === 'recover' ? command.type : undefined;
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
        // An answer arriving during this Actor's record lookups is not an unknown
        // dispatch by the old executor. Classify only work outstanding at restart.
        const { requested, resolved } = latestApproval(initial.events, runId, request.callId);
        return !requested || resolved || initial.events.some(event => event.type === 'tool.started'
          && event.runId === runId && event.callId === request.callId && event.sequence > requested.sequence);
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
              message: `During recovery the Kernel had no conclusive execution record for tool call ${unresolved.callId}.`,
            },
          },
        });
        return finishingResult(runId, {
          outcome: 'indeterminate',
          error: {
            code: 'tool_effect_outcome_unknown',
            message: `During recovery the Kernel had no conclusive execution record for tool call ${unresolved.callId}.`,
          },
        });
      }
      if (pending.length) await commit(current => interruptedApprovalReviews(current, runId, deps.nextId));
    }

    if (command.type === 'cancel') return await cancelRun(snapshot, command, deps, commit);
    const continuation = snapshot.state.run?.continuation;
    if (continuation && !snapshot.state.contextCompositions.some(item => item.runId === runId)) {
      await waitForRetryAt(continuation.retryAt, signal);
      const compaction = continueCompaction(snapshot, continuation.providerRequestId, runId, deps.nextId);
      if (compaction.length) await commit(compaction);
    }

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
        const waitingForTools = await dispatchPendingTools(snapshot, deps, runId, signal, restoreApprovals);
        restoreApprovals = undefined;
        if (waitingForTools) return waitingForTools;
        if (deps.activity) await deps.activity.waitPending(await deps.readSnapshot(), signal);

        throwIfAborted(signal);
        snapshot = await deps.takeQueuedInputs(runId);
        // Keep the directories published with the prepared catalog, not a later activity snapshot.
        const workspaceContext = runWorkspaceContext(snapshot, runId);
        const requestDirectoryIds = workspaceContext.directoryBindings.map(binding => binding.workspaceId);
        if (deps.activity) {
          await deps.activity.sync();
          snapshot = await deps.readSnapshot();
        }
        runtime = runRuntimeSnapshot(snapshot, runId);
        if (snapshot.state.contextHandoff?.status === 'reading') {
          const failedRead = snapshot.events.findLast(event => event.type === 'tool.completed' && event.runId === runId
            && event.payload.record.toolName === 'session.read');
          if (failedRead?.type === 'tool.completed') throw new LoopFailure('model_handoff_read_failed',
            'error' in failedRead.payload.record ? (failedRead.payload.record.error?.message ?? 'Model handoff could not finish because the history read was incomplete.') : 'Model handoff could not finish because the history read was incomplete.');
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
          ...workspaceContext,
          providerRequestId: deps.nextId('provider-request'),
        }, signal);
        const request = prepareTurnBudget(snapshot, runId, runtime, preparedProviderRequest.receipt, capabilities, deps.nextId);
        if (request) {
          throwIfAborted(signal);
          await commit(request);
          continue;
        }
        throwIfAborted(signal);
        let directoriesChanged = false;
        await commit(current => {
          // An edit can land during activity sync, view retirement or context composition.
          // Before issuing the request, retry with a matching catalog and workspace receipt.
          // After this commit, activation must use the captured list regardless of later edits.
          const run = current.state.run;
          directoriesChanged = run?.runId === runId && (run.workspaceBindings.length !== requestDirectoryIds.length
            || run.workspaceBindings.some((binding, i) => binding.workspaceId !== requestDirectoryIds[i]));
          return directoriesChanged ? [] : [{ type: 'context.composed', sessionId: current.state.sessionId,
            runId, payload: preparedProviderRequest.receipt }];
        });
        if (directoriesChanged) continue;
        let turn;
        try {
          turn = await consumeProvider(preparedProviderRequest.request, preparedProviderRequest.toolCodec,
            runId, deps, signal, capabilities.controls, Boolean(continuation && !Object.values(snapshot.state.providerTurns).some(turn => turn.runId === runId && turn.purpose === 'agent')));
        } catch (error) {
          if (!(error instanceof TruncatedToolOutput) || signal.aborted) throw error;
          await commit({ type: 'provider.turn.settled', sessionId: snapshot.state.sessionId, runId,
            payload: { providerRequestId: preparedProviderRequest.request.requestId, purpose: 'agent',
              providerRuntimeRef: runtime.provider.providerRuntimeRef, outcome: 'failed',
              error: error.failure, toolCallInputs: error.calls } });
          continue;
        }
        const result = await settleProviderTurn(snapshot, turn, preparedProviderRequest.receipt, runtime,
          capabilities, lease, agentEvidenceRevision, runId, requestDirectoryIds, deps, signal);
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
          message: userCancelled ? 'Cancellation was requested before generation finished. The final provider outcome is unknown.'
            : `Provider request ${unknownTurn.providerRequestId} has an unknown outcome. Original error: ${cause.code}: ${cause.message}`,
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
    const failure: RunSettlement = { outcome: error instanceof CapacityStartUnknown ? 'indeterminate' : 'failed', error: localAgentError(error) };
    if (!hasSettlement(snapshot.events, runId)) {
      await commit({ type: 'run.finishing', sessionId: snapshot.state.sessionId, runId, payload: failure });
    }
    return finishingResult(runId, failure);
  }
}
