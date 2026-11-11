import type { LoopSnapshot, ProviderTurn, AgentLoopDeps, LoopResult } from './loopTypes.js';
import {
  SESSION_CONTROL_SESSION, SESSION_CONTROL_ARTIFACT_PRESENT, SESSION_CONTROL_PLUGIN_ACTIVATE,
  SESSION_CONTROL_PLAN_PUBLISH, SESSION_CONTROL_AGENT,
} from '@achbit/protocol';
import type {
  ContextCompositionReceipt, RunRuntimeSnapshot, NewSessionEvent, PreparedRunRuntime, KernelPort,
  AgentOperation,
} from '@achbit/protocol';
import type { SessionCapabilities } from './plugins.js';
import { stageForRequest } from './sessionCapabilities.js';
import type { SessionCapabilityLease } from './sessionCapabilities.js';
import {
  providerTurnSettledEvent, controlRejectionFact, localAgentError, throwIfAborted, orderedProviderCallFacts,
  runRuntimeSnapshot, runWorkspaceContext, preparingRequestedPlan, latestAgentEvidenceSequence,
  finishingResult,
} from './loopFacts.js';
import { LoopFailure, errorFact } from './loopFailure.js';
import { installedControls } from './loopCapabilities.js';
import { confirmationFacts } from './planStage.js';
import { scheduledContextCompaction, pendingContextCompaction } from './compaction.js';
import { modelContextEvents } from './modelContext.js';
import { boundaryCompactionEvent, performContextCompaction } from './loopContext.js';
import { reviewPendingPlan } from './loopTools.js';
import { pendingControlWait, controlWait } from './sessionWake.js';

export async function settleProviderTurn(
  initial: LoopSnapshot, turn: ProviderTurn, receipt: ContextCompositionReceipt, runtime: RunRuntimeSnapshot,
  capabilities: SessionCapabilities, lease: SessionCapabilityLease, agentEvidenceRevision: number,
  runId: string, deps: AgentLoopDeps, signal: AbortSignal,
): Promise<LoopResult | undefined> {
  let snapshot = initial;
  const commit = async (event: Parameters<AgentLoopDeps['commit']>[0]): Promise<void> => {
    snapshot = await deps.commit(event);
  };
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
  if (snapshot.state.contextHandoff?.status === 'reading' && turn.kind === 'answer') {
    await commit([providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion), ...completionDerivedFacts]);
    throw new LoopFailure('model_handoff_read_required', '模型未读取此前工作，接手未完成。');
  }
  switch (turn.kind) {
    case 'session': {
      let fact: NewSessionEvent;
      try {
        if (!deps.sessionOperation) throw new Error('session_operations_unavailable');
        const result = await deps.sessionOperation(runId, turn.operation, signal);
        fact = { type: 'session.control.completed', sessionId: snapshot.state.sessionId, runId, callId: turn.callId,
          payload: { providerCallId: turn.providerCallId, operation: { ...turn.operation }, result: turn.operation.action === 'wait'
            ? { ...result, wait: { afterSequence: receipt.modelView!.throughSequence,
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
        receipt.modelView!.throughSequence, signal);
      await commit([fact, providerTurnSettledEvent(snapshot.state.sessionId, runId, turn.completion), ...completionDerivedFacts]);
      break;
    }
    case 'artifactPresent': {
      let fact: NewSessionEvent;
      try {
        fact = installedControls(capabilities.controls).presentArtifacts(snapshot.state, runId, turn.callId, turn.providerCallId, turn.items, deps.nextId);
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
        throwIfAborted(signal);
        prepared = await installedControls(capabilities.controls).preparePlugins({
          sessionId: snapshot.state.sessionId, runId, runtime, pluginUris: turn.pluginUris,
          nextId: deps.nextId, preparation: deps.composition.runPreparation,
        });
        // An admitted preparation must drain before the run releases its resources.
        throwIfAborted(signal);
      } catch (error) {
        throwIfAborted(signal);
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
        : installedControls(capabilities.controls).publishPlan(
          snapshot.state, runId, turn.callId, turn.providerCallId, turn.draft,
          runWorkspaceContext(snapshot, runId).workspaceBindings.map((binding) => binding.workspaceId), deps.nextId,
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
      if (admission?.source === 'review') return;
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
      if (capabilities.controls && preparingRequestedPlan(snapshot, runId)) {
        await commit(answerFacts);
        throw new LoopFailure('requested_plan_missing', '本次任务缺少可供确认的计划。');
      }
      if (deps.activity) {
        await deps.activity.sync();
        snapshot = await deps.readSnapshot();
        if (deps.activity.needsContinuation(snapshot)) {
          await commit(answerFacts);
          await lease.release();
          await deps.activity.wait(signal);
          return;
        }
      }
      const settlement = { outcome: 'completed' as const, finalMessageId: messageId };
      await commit(answerFacts);
      const canCompact = capabilities.compaction && !snapshot.state.agentTasks.some(task => task.parentRunId === runId && task.status === 'running')
        && latestAgentEvidenceSequence(snapshot.events, runId) === agentEvidenceRevision
        && !snapshot.state.queuedInputs.some(input => input.runId === runId)
        && !snapshot.state.interactions.some(item => item.runId === runId && item.status === 'pending');
      if (capabilities.compaction && canCompact && (capabilities.compaction.settings(runtime).enabled || scheduledContextCompaction(snapshot.events))) {
        const completedContext = await capabilities.context.prepare({
          sessionId: snapshot.state.sessionId, runId, runtime, events: modelContextEvents(snapshot.events), historyEvents: snapshot.events,
          responseConstraint: 'normal', ...runWorkspaceContext(snapshot, runId),
          toolGuidance: deps.composition.toolGuidance,
          toolStage: stageForRequest(capabilities, runtime, snapshot.state),
          providerRequestId: deps.nextId('provider-request'),
        }, signal);
        const boundaryCompaction = boundaryCompactionEvent(snapshot, runId, runtime, completedContext.receipt,
          capabilities, 'idle', deps.nextId);
        if (boundaryCompaction) {
          await commit(boundaryCompaction);
          await performContextCompaction(snapshot, pendingContextCompaction(snapshot.events, runId)!, runId, deps, signal, commit);
        }
      }
      let deferForAgents = false;
      await commit((current) => {
        deferForAgents = Boolean(capabilities.controls && (current.state.agentTasks.some(task => task.parentRunId === runId && task.status === 'running')
          || latestAgentEvidenceSequence(current.events, runId) !== agentEvidenceRevision));
        if (deferForAgents || current.state.queuedInputs.some(input => input.runId === runId)) return [];
        return current.state.interactions.some(item => item.runId === runId && item.status === 'pending') ? [{
          type: 'run.waiting', sessionId: current.state.sessionId, runId,
          payload: { reason: 'userInput', detail: 'Independent work is complete; awaiting answers to open questions.' },
        }] : [{ type: 'run.finishing', sessionId: current.state.sessionId, runId, payload: settlement }];
      });
      if (deferForAgents) {
        await lease.release();
        if (snapshot.state.agentTasks.some(task => task.parentRunId === runId && task.status === 'running')) {
          if (!deps.agents) throw new LoopFailure('agent_manager_missing', '正在运行的子任务缺少管理入口。');
          await deps.agents.wait(runId, signal);
        }
        return;
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
          ? installedControls(capabilities.controls).updateTodo(snapshot.state.sessionId, runId, snapshot.state.todoList, turn.progress.items, turn.progress)
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
            receipt.modelView!.throughSequence, signal));
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
}

export async function prepareControlTurn(
  snapshot: LoopSnapshot, deps: AgentLoopDeps, runId: string, signal: AbortSignal,
): Promise<LoopSnapshot | Extract<LoopResult, { status: 'waiting' }>> {
  if (snapshot.state.pendingPlan?.review?.status === 'reviewing') {
    await reviewPendingPlan(deps, snapshot.state.pendingPlan, signal);
    snapshot = await deps.readSnapshot();
  }
  if (snapshot.state.pendingPlan) {
    const plan = snapshot.state.pendingPlan;
    if (snapshot.state.run?.status !== 'waiting') await deps.commit({ type: 'run.waiting', sessionId: snapshot.state.sessionId, runId,
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
    return deps.readSnapshot();
  }
  return snapshot;
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
