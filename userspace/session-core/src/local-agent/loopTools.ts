import { KERNEL_REQUEST_VERSION, KERNEL_REPLY_VERSION } from '@achbit/protocol';
import type {
  SessionEvent, PlanAuthority, ToolExecutionRequest, LocalAgentError, NewSessionEvent, ToolExecutionReply,
  ToolExecutionRecord, ToolInputRejection, RunSettlement, RunRuntimeSnapshot, PreparedToolDescriptor,
} from '@achbit/protocol';
import type { LoopSnapshot, AgentLoopDeps, LoopResult, LoopCommand, ExpectedToolRecordIdentity } from './loopTypes.js';
import type { SessionState } from './reducer.js';
import {
  runRuntimeSnapshot, providerTurnSettledEvent, orderedProviderCallFacts, hasSettlement, settlementResult,
  finishingResult, localAgentError,
} from './loopFacts.js';
import { preparePlanReview } from './planReview.js';
import {
  decodeApprovalReview, MAX_APPROVAL_EVIDENCE_ROUNDS, prepareApprovalReview, ApprovalReviewFormatFailure,
} from './approvalReview.js';
import { LoopFailure, errorFact } from './loopFailure.js';
import { consumeTextProvider, consumeProvider } from './loopProvider.js';
import { confirmationFacts } from './planStage.js';
import { canonicalJsonValue } from './providerToolCodec.js';
import type { AgentComposition } from './plugins.js';

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

export async function reviewPendingPlan(deps: AgentLoopDeps, plan: NonNullable<SessionState['pendingPlan']>, signal: AbortSignal): Promise<void> {
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

/** A manual decision or permission change retires only this execution review. */
function createApprovalReviewScope(deps: AgentLoopDeps, approvalId: string, permissions: string, signal: AbortSignal) {
  const controller = new AbortController(), observer = new AbortController();
  const obsolete = new LoopFailure('approval_review_obsolete', '审批已由人工决定或权限变更替代。', {
    source: 'session', phase: 'approvalReview', category: 'cancelled', retryable: false, causes: [],
  });
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const watching = (async () => {
    while (!observer.signal.aborted && !controller.signal.aborted) {
      const current = await deps.readSnapshot();
      if (!current.state.pendingApprovals.some(item => item.approvalId === approvalId)
        || JSON.stringify(current.state.publishedPermissions ?? current.state.permissionOverrides) !== permissions) {
        controller.abort(obsolete);
        return;
      }
      if (!deps.waitForChange) return;
      await deps.waitForChange(current.state.revision, observer.signal, current.state.publishedPermissions);
    }
  })().catch(error => {
    if (!(observer.signal.aborted && error === observer.signal.reason)) controller.abort(error);
  });
  return { signal: controller.signal, obsolete, async close() {
    observer.abort();
    signal.removeEventListener('abort', onAbort);
    await watching;
  } };
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
    const previous = latestApproval(snapshot.events, runId, requestEvent.callId);
    if (previous.resolved && (!reply.preview.revalidation
      || reply.preview.revalidation.authorityId !== previous.resolved.payload.authorityId)) {
      throw new LoopFailure('approval_no_progress',
        '同一操作已有审批决定，但 Kernel 再次要求审批且未提供对应授权失效原因；未重复审查或执行。');
    }
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
      let reviewFailure: LocalAgentError | undefined;
      let verdict: ReturnType<typeof decodeApprovalReview> = { decision: 'ask', reason: '自动审查未完成。' };
      const evidenceEvents: SessionEvent[] = [];
      let formatRetried = false;
      const reviewScope = createApprovalReviewScope(deps, approvalId, baseline, signal);
      try {
        for (let round = 0; round <= MAX_APPROVAL_EVIDENCE_ROUNDS + 1; round++) {
          reviewRequestId = deps.nextId('provider-request');
          reviewRecorded = false;
          reviewFailure = undefined;
          let review: ReturnType<typeof prepareApprovalReview> | undefined;
          try {
            reviewScope.signal.throwIfAborted();
            review = prepareApprovalReview(reviewSnapshot, runtime, pending, reviewRequestId, formatRetried, evidenceEvents, round >= MAX_APPROVAL_EVIDENCE_ROUNDS);
            await commit({ type: 'context.composed', sessionId: snapshot.state.sessionId, runId, payload: review.receipt });
            let summary: string;
            if (review.request.tools.length) {
              const result = await consumeProvider(review.request, review.toolCodec, runId, deps, reviewScope.signal, { decode: () => null });
              if (result.kind !== 'tools' && result.kind !== 'answer') throw new LoopFailure('approval_review_read_scope', '审批返回了不支持的控制操作。');
              const facts: NewSessionEvent[] = result.kind === 'tools' ? result.calls.map(call => {
                if (call.owner !== 'kernel') throw new LoopFailure('approval_review_read_scope', '审批不能调用控制操作。');
                return { type: 'tool.requested', sessionId: snapshot.state.sessionId, runId, callId: call.callId,
                  payload: { providerCallId: call.providerCallId, attemptId: deps.nextId('attempt'), toolName: call.name, input: call.input } };
              }) : [];
              await commit([...orderedProviderCallFacts(result.completion, facts),
                providerTurnSettledEvent(snapshot.state.sessionId, runId, result.completion),
                ...(result.contextUsage ? [{ type: 'context.updated' as const, sessionId: snapshot.state.sessionId, runId, payload: result.contextUsage }] : [])]);
              if (result.kind === 'tools') {
                const dispatched = new Set<string>();
                let evidenceFailure: { error: unknown } | undefined;
                try {
                  for (const call of result.calls) {
                    const event = snapshot.events.find(event => event.type === 'tool.requested' && event.callId === call.callId) as ToolRequestEvent;
                    snapshot = await deps.readSnapshot();
                    const obsolete = !snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)
                      || JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) !== baseline;
                    if (obsolete) {
                      await commit({ type: 'tool.not-executed', sessionId: snapshot.state.sessionId, runId, callId: event.callId,
                        payload: { attemptId: event.payload.attemptId, reason: 'cancelled' } });
                      continue;
                    }
                    reviewScope.signal.throwIfAborted();
                    const execution = executionRequest(snapshot, event, deps);
                    dispatched.add(event.callId);
                    const evidenceReply = await executeUntilAbort(deps, execution, reviewScope.signal);
                    if (evidenceReply.callId !== event.callId) throw new LoopFailure('kernel_call_identity_mismatch', '审批读取返回了其他调用的结果。');
                    if (evidenceReply.status === 'approvalRequired') {
                      // No recursive review and no authority is granted for evidence collection.
                      await commit({ type: 'tool.not-executed', sessionId: snapshot.state.sessionId, runId, callId: event.callId,
                        payload: { attemptId: event.payload.attemptId, reason: 'approvalRequired' } });
                    } else if (evidenceReply.status === 'inputRejected') {
                      assertToolRecordIdentity(evidenceReply.rejection, expectedToolRecordIdentity(snapshot, event));
                      await commit({ type: 'tool.input-rejected', sessionId: snapshot.state.sessionId, runId, callId: event.callId,
                        payload: { rejection: evidenceReply.rejection } });
                    } else await commitToolRecord(evidenceReply.record, expectedToolRecordIdentity(snapshot, event), commit);
                  }
                } catch (error) {
                  evidenceFailure = { error };
                  throw error;
                } finally {
                  try {
                    const current = await deps.readSnapshot();
                    const unresolved = pendingToolRequests(current.events, runId);
                    const notDispatched = unresolved.filter(event => !dispatched.has(event.callId)
                      && result.calls.some(call => call.callId === event.callId));
                    if (notDispatched.length) await commit(notDispatched.map(event => ({
                      type: 'tool.not-executed', sessionId: event.sessionId, runId, callId: event.callId,
                      payload: { attemptId: event.payload.attemptId, reason: 'cancelled' },
                    })));
                  } catch (error) {
                    if (evidenceFailure && evidenceFailure.error !== error) {
                      throw new AggregateError([evidenceFailure.error, error], 'approval_review_call_cleanup_failed');
                    }
                    throw error;
                  }
                }
                reviewScope.signal.throwIfAborted();
                if (!snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)
                  || JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) !== baseline) return 'retry';
                // Include the exact composed request so persisted aliases and bindings
                // stay attached to their calls, including rejected Provider inputs.
                const evidenceCallIds = new Set(result.calls.map(call => call.callId));
                evidenceEvents.push(...snapshot.events.filter(event => (
                  (event.type === 'context.composed' || event.type === 'provider.turn.settled' || event.type === 'context.updated')
                    ? event.payload.providerRequestId === reviewRequestId
                    : event.type.startsWith('tool.') && 'callId' in event && typeof event.callId === 'string' && evidenceCallIds.has(event.callId)
                )));
                continue;
              }
              summary = result.content;
            } else {
              const result = await consumeTextProvider(review.request, deps, reviewScope.signal);
              await commit([providerTurnSettledEvent(snapshot.state.sessionId, runId, result.completion),
                ...(result.contextUsage ? [{ type: 'context.updated' as const,
                  sessionId: snapshot.state.sessionId, runId, payload: result.contextUsage }] : [])]);
              summary = result.summary;
            }
            if (!snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)) return 'retry';
            verdict = decodeApprovalReview(summary);
            break;
          } catch (error) {
            if (reviewScope.signal.aborted && error === reviewScope.obsolete) {
              snapshot = await deps.readSnapshot();
              if (review && !snapshot.state.providerTurns[review.request.requestId]) await commit({ type: 'provider.turn.settled',
                sessionId: snapshot.state.sessionId, runId, payload: { providerRequestId: review.request.requestId,
                  purpose: 'approvalReview', providerRuntimeRef: review.request.providerRuntimeRef, outcome: 'cancelled' } });
              return 'retry';
            }
            if (signal.aborted || reviewScope.signal.aborted) throw error;
            const fact = errorFact(error);
            reviewFailure = fact;
            if (review && !snapshot.state.providerTurns[review.request.requestId]) await commit({ type: 'provider.turn.settled',
              sessionId: snapshot.state.sessionId, runId, payload: { providerRequestId: review.request.requestId,
                purpose: 'approvalReview', providerRuntimeRef: review.request.providerRuntimeRef, outcome: 'failed', error: fact } });
            verdict = { decision: 'ask', reason: `自动审查无法完成，需要你决定是否执行。\n${fact.code}：${fact.message}` };
            const retryFormat = !formatRetried && error instanceof ApprovalReviewFormatFailure
              && JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) === baseline
              && snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId);
            if (error instanceof ApprovalReviewFormatFailure) {
              const response = fact.diagnostics?.causes.find(cause => cause.kind === 'response')?.message;
              verdict = { decision: 'ask', reason: `${retryFormat ? '审批结果格式无效，正在按原请求重试一次。' : '无法读取有效的审核结果，需要你决定是否执行。'}\n${fact.message}\n原始响应：${response}` };
              // Withhold authority without entering run.waiting during recovery.
              await commit({ type: 'approval.reviewed', sessionId: snapshot.state.sessionId, runId,
                callId: requestEvent.callId, payload: { approvalId, providerRequestId: reviewRequestId, ...verdict, error: fact } });
              reviewRecorded = true;
            }
            // Recording the failure yields to the Actor; a user decision or a
            // permission update during that commit must prevent the next review.
            if (!snapshot.state.pendingApprovals.some(item => item.approvalId === approvalId)) return 'retry';
            if (retryFormat && JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) === baseline) { formatRetried = true; continue; }
            break;
          }
        }
        if (!reviewRecorded) {
          await commit(current => {
            if (!current.state.pendingApprovals.some(item => item.approvalId === approvalId)
              || JSON.stringify(current.state.publishedPermissions ?? current.state.permissionOverrides) !== baseline) return [];
            const events: NewSessionEvent[] = [{ type: 'approval.reviewed', sessionId: current.state.sessionId, runId,
              callId: requestEvent.callId, payload: { approvalId, providerRequestId: reviewRequestId, ...verdict,
                ...(reviewFailure ? { error: reviewFailure } : {}) } }];
            if (verdict.decision !== 'ask') events.push({ type: 'approval.resolved', sessionId: current.state.sessionId, runId,
              callId: requestEvent.callId, payload: { approvalId, commandId: deps.nextId('agent-decision'),
                authorityId: deps.nextId('authority'), decision: verdict.decision, source: 'agent', reason: verdict.reason,
                ...(verdict.decision === 'allow' && reply.preview.reviewPolicy?.reviewGrant === 'runFiles'
                  ? { authorizationScope: 'runFiles' as const } : {}) } });
            return events;
          });
        }
        if (!snapshot.state.pendingApprovals.some(item => item.callId === requestEvent.callId)
          || JSON.stringify(snapshot.state.publishedPermissions ?? snapshot.state.permissionOverrides) !== baseline) return 'retry';
      } finally { await reviewScope.close(); }
    }
    return 'approval';
  }
  await commitToolRecord(reply.record, expectedToolRecordIdentity(snapshot, requestEvent), commit);
  return 'terminal';
}

/** Execution is concurrent; all facts still pass through the Actor's serial commit port. */
export async function dispatchPendingTools(deps: AgentLoopDeps, runId: string, signal: AbortSignal): Promise<LoopResult | undefined> {
  let snapshot = await deps.readSnapshot();
  const pending = pendingToolRequests(snapshot.events, runId);
  const isRead = (event: ToolRequestEvent) => event.payload.toolName === 'fs.read';
  const isFile = (event: ToolRequestEvent) => event.payload.toolName === 'fs.write' || event.payload.toolName === 'fs.edit';
  const isCommand = (event: ToolRequestEvent) => ['bash', 'powershell'].includes(event.payload.toolName)
    || event.payload.toolName === 'process' && event.payload.input.action === 'start'
    || event.payload.toolName === 'container' && ['create', 'exec'].includes(String(event.payload.input.action));
  let enteredSegmentEnd = 0;
  try {
    for (let offset = 0; offset < pending.length;) {
      signal.throwIfAborted();
      let end = offset;
      let filePhase: 'read' | 'mutation' | undefined;
      // Commands may overlap the neighboring file phase. Their foreground
      // receipt (including an automatically managed job) is not a dependency
      // of unrelated sibling calls. Keep file read/write ordering and leave
      // other tool families on their existing single-call boundaries.
      while (end < pending.length) {
        const event = pending[end]!;
        if (isCommand(event)) { end += 1; continue; }
        const phase = isRead(event) ? 'read' : isFile(event) ? 'mutation' : undefined;
        if (!phase || filePhase && phase !== filePhase) break;
        filePhase = phase;
        end += 1;
      }
      if (end === offset) end += 1;
      const segment = pending.slice(offset, end);
      const files = segment.filter(isFile);
      const dependencies = new Map<string, string[]>();
      if (files.length) {
        snapshot = await deps.readSnapshot();
        const preparation = await deps.composition.kernel.prepareFileCalls({ requests: files.map(event => executionRequest(snapshot, event, deps)) });
        if (preparation.calls.length !== files.length || preparation.calls.some((item, index) => item.callId !== files[index]!.callId
          || item.conflictsWith.some(id => !files.slice(0, index).some(event => event.callId === id)))) {
          throw new LoopFailure('tool_preparation_identity_mismatch', 'Kernel 文件准备结果与原始调用顺序不一致。');
        }
        for (const item of preparation.calls) {
          dependencies.set(item.callId, item.conflictsWith);
          if (item.rejection) await acceptToolReply(deps, files.find(event => event.callId === item.callId)!, {
            schemaVersion: KERNEL_REPLY_VERSION, type: 'tool.execution', requestId: deps.nextId('kernel-request'),
            callId: item.callId, status: 'inputRejected', rejection: item.rejection,
          }, signal);
        }
      }
      enteredSegmentEnd = end;
      const waiting = await executeToolSegment(deps, segment, dependencies, signal);
      if (waiting) return waiting;
      // Explicit waits are applied by RunActivity after this batch's actual
      // tool replies have been collected; no sibling needs model resubmission.
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
  const fileGrants = (snapshot: LoopSnapshot) => JSON.stringify(snapshot.state.shellAuthorizations
    .filter(grant => grant.scope === 'runFiles' || grant.scope === 'sessionFiles').map(grant => grant.authorityId));
  type Completion = { event: ToolRequestEvent; permissions: string; fileGrants: string; reply?: ToolExecutionReply; error?: unknown };
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
        const grantedFiles = fileGrants(snapshot);
        active.set(event.callId, executeUntilAbort(deps, request, controller.signal)
          .then(reply => ({ event, permissions, fileGrants: grantedFiles, reply }),
            error => ({ event, permissions, fileGrants: grantedFiles, error })));
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
        // An approvalRequired reply proves this attempt did not execute. Another
        // concurrent read may since have granted its files: ask Kernel to admit
        // it again rather than review a stale request or infer coverage here.
        if (completed.reply!.status === 'approvalRequired'
          && completed.fileGrants !== fileGrants(await deps.readSnapshot())) continue;
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

export async function cancelRun(
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

export async function commitToolRecord(
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

export function expectedToolRecordIdentity(
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

export function latestApproval(
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
