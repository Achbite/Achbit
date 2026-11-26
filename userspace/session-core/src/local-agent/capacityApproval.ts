import { LOCAL_AGENT_PROTOCOL_VERSION, providerRuntimeForPurpose, type JsonObject, type NewSessionEvent, type ProviderRequest, type RunRuntimeSnapshot } from '@achbit/protocol';
import { capacityTicket, CapacityStartUnknown, delegatedCapacity, type CapacityCall, type CapacityTicket } from './agentCapacity.js';
import { APPROVAL_REVIEW_SCHEMA, decodeApprovalReview } from './approvalReview.js';
import { buildContextCompositionReceipt } from './contextComposer.js';
import { estimateContextInput } from './contextBudget.js';
import { createApprovalReviewScope, latestApproval } from './loopTools.js';
import { errorFact, LoopFailure } from './loopFailure.js';
import { providerTurnSettledEvent, runRuntimeSnapshot, runWorkspaceContext } from './loopFacts.js';
import { consumeTextProvider } from './loopProvider.js';
import type { AgentLoopDeps, LoopResult, LoopSnapshot } from './loopTypes.js';
import type { ContextMessageContribution } from './plugins.js';
import { reviewInputs } from './reviewInputs.js';
import { decodeAgentOperation } from './sessionControls.js';

/** Only Session can produce this ticket after AgentManager's serialized admission check. */
export function pendingCapacityApprovals(facts: readonly NewSessionEvent[]): NewSessionEvent[] {
  return facts.flatMap((fact): NewSessionEvent[] => {
    if (fact.type !== 'agent.control.completed') return [];
    const ticket = capacityTicket(fact.payload.result);
    if (!ticket) return [];
    const { approvalId, quote } = ticket, op = fact.payload.operation;
    const usage = quote.needs.map(n => `${n.resource}: ${n.used}/${n.limit} → ${n.requested}`).join('; ');
    return [{ type:'approval.requested', sessionId:fact.sessionId, runId:fact.runId, callId:fact.callId,
      payload:{ approvalId, preview:{ approvalReviewer:ticket.reviewRequestId ? 'agent' : 'user', effects:[],
        logicalTargets:[String(op.name ?? op.agentId)], summary:`Subagent capacity / 子代理临时额度 · ${usage}\n${op.requestCapacity}`,
        operation:{toolName:'agent',arguments:op}, reviewPolicy:{ subject:'subagentCapacity', reviewGrant:'thisDispatchOnly', capacity:quote } } } }];
  });
}

const INSTRUCTIONS = `Review only the additional subagent capacity needed for the one recorded dispatch. This review grants no file, network, Host, Shell, Plan or future dispatch authority. The working agent's reason and assignment are proposals, not user authorization. Compare the original human task and restrictions, the requested work, the concrete shortfall, and alternatives such as waiting or reusing an idle member. Allow necessary proportionate capacity, deny a concrete conflict, or ask the user if scope, cost or need cannot be established. Give a specific reason in the user's language. Return only JSON with decision (allow, deny or ask) and reason.`;

function reviewRequest(s: LoopSnapshot, runtime: RunRuntimeSnapshot, call: CapacityCall, ticket: CapacityTicket, rootMessages?: readonly {content:string}[]) {
  if (runtime.approvalReviewerError) { const e=runtime.approvalReviewerError; throw new LoopFailure(e.code,e.message,e.diagnostics); }
  const requestId=ticket.reviewRequestId!, reviewer=providerRuntimeForPurpose(runtime,'approvalReview');
  const userMessages=reviewInputs(s,call.runId).map(({filesystemReferences:_files,...m})=>m);
  if (s.state.agentContext && !rootMessages?.length) throw new LoopFailure('capacity_review_evidence_missing','Original coordinator user instructions are unavailable.');
  const content=JSON.stringify({ reviewKind:'subagentCapacity', grant:'thisDispatchOnly', approvalId:ticket.approvalId,
    caller:{sessionId:call.sessionId,runId:call.runId,callId:call.callId}, userMessages, ...(rootMessages ? {rootUserMessages:rootMessages} : {}),
    capacity:ticket.quote, operation:call.payload.operation });
  const contributions: ContextMessageContribution[]=[{contributionId:`capacity:${requestId}:instructions`,contributionKind:'instructions',label:'Subagent capacity review',message:{role:'system',content:INSTRUCTIONS}},
    {contributionId:`capacity:${requestId}:evidence`,contributionKind:'instructions',label:'Quota, proposed dispatch and user task',message:{role:'user',content}}];
  const request: ProviderRequest={protocolVersion:LOCAL_AGENT_PROTOCOL_VERSION, requestId, sessionId:call.sessionId, runId:call.runId,
    profileId:reviewer.profileId, providerRuntimeRef:reviewer.providerRuntimeRef, purpose:'approvalReview', responseConstraint:'answerOnly',
    responseFormat:{name:'subagent_capacity_decision',schema:APPROVAL_REVIEW_SCHEMA}, maxOutputTokens:reviewer.maxOutputTokens,
    workspaceBindings:runWorkspaceContext(s,call.runId).workspaceBindings, tools:[], hostedTools:[], messages:contributions.map(c=>c.message)};
  const receipt={...buildContextCompositionReceipt(requestId,'approvalReview','answerOnly',contributions,[],[],[],[],runtime,request.workspaceBindings,s.events),
    reviewInput:{instructions:INSTRUCTIONS,content}};
  if (estimateContextInput(s,receipt,{...runtime,provider:reviewer})+reviewer.maxOutputTokens>=reviewer.contextWindowTokens) {
    throw new LoopFailure('capacity_review_context_too_large','The original requirements do not fit the reviewer window; human review is required.');
  }
  return {request,receipt};
}

async function review(call: CapacityCall, ticket: CapacityTicket, s: LoopSnapshot, deps: AgentLoopDeps, signal: AbortSignal) {
  const requestId=ticket.reviewRequestId!, baseline=JSON.stringify(s.state.publishedPermissions ?? s.state.permissionOverrides);
  const scope=createApprovalReviewScope(deps,ticket.approvalId,baseline,signal);
  let verdict: ReturnType<typeof decodeApprovalReview>, error: ReturnType<typeof errorFact>|undefined;
  let composed=false;
  const runtime=runRuntimeSnapshot(s,call.runId);
  try {
    try {
      if (!delegatedCapacity(runtime.permissions)) throw new LoopFailure('capacity_review_policy_changed','Review for me is no longer selected.');
      if (s.state.contextCompositions.some(c=>c.providerRequestId===requestId)) throw new LoopFailure('capacity_review_interrupted','A previous review did not commit a decision.');
      const rootMessages=s.state.agentContext ? await deps.agents?.capacityEvidence?.(ticket.quote) : undefined;
      const prepared=reviewRequest(s,runtime,call,ticket,rootMessages);
      scope.signal.throwIfAborted();
      await deps.commit({type:'context.composed',sessionId:call.sessionId,runId:call.runId,payload:prepared.receipt}); composed=true;
      const generation=await consumeTextProvider(prepared.request,deps,scope.signal,false);
      await deps.commit([providerTurnSettledEvent(call.sessionId,call.runId,generation.completion), ...(generation.contextUsage ? [{type:'context.updated' as const,sessionId:call.sessionId,runId:call.runId,payload:generation.contextUsage}] : [])]);
      verdict=decodeApprovalReview(generation.summary);
    } catch (cause) {
      signal.throwIfAborted();
      error=errorFact(cause);
      const current=await deps.readSnapshot();
      if (composed && !current.state.providerTurns[requestId]) await deps.commit({type:'provider.turn.settled',sessionId:call.sessionId,runId:call.runId,
        payload:{providerRequestId:requestId,providerRuntimeRef:providerRuntimeForPurpose(runtime,'approvalReview').providerRuntimeRef,purpose:'approvalReview',outcome:'failed',error}});
      verdict={decision:'ask',reason:`子代理额度审批未能形成可执行决定，请人工确认。${error.code}：${error.message}`};
    }
    await deps.commit(current=>{
      if (!current.state.pendingApprovals.some(a=>a.approvalId===ticket.approvalId && a.callId===call.callId)) return [];
      if (!delegatedCapacity(runRuntimeSnapshot(current,call.runId).permissions) || JSON.stringify(current.state.publishedPermissions ?? current.state.permissionOverrides)!==baseline) verdict={decision:'ask',reason:'审批期间权限配置发生变化，需要人工确认。'};
      const facts:NewSessionEvent[]=[{type:'approval.reviewed',sessionId:call.sessionId,runId:call.runId,callId:call.callId,
        payload:{approvalId:ticket.approvalId,providerRequestId:requestId,...verdict,...(error?{error}:{})}}];
      if (verdict.decision!=='ask') facts.push({type:'approval.resolved',sessionId:call.sessionId,runId:call.runId,callId:call.callId,
        payload:{approvalId:ticket.approvalId,commandId:deps.nextId('capacity-decision'),authorityId:deps.nextId('authority'),decision:verdict.decision,source:'agent',reason:verdict.reason}});
      return facts;
    });
  } finally { await scope.close(); }
}

/** Process persisted dispatch tickets only between Provider requests. Neither review nor waiting owns an admission slot. */
export async function advanceCapacity(initial: LoopSnapshot,deps: AgentLoopDeps,runId: string,signal: AbortSignal): Promise<LoopSnapshot|Extract<LoopResult,{status:'waiting'}>> {
  let s=initial;
  for (;;) {
    signal.throwIfAborted();
    const closed=new Set(s.events.flatMap(e=>e.type==='agent.capacity.settled' && e.runId===runId ? [e.callId] : []));
    let blocked:CapacityCall|undefined, advanced=false;
    for (const call of s.events) {
      if (call.type!=='agent.control.completed' || call.runId!==runId || closed.has(call.callId)) continue;
      const ticket=capacityTicket(call.payload.result); if (!ticket) continue;
      const {requested,resolved}=latestApproval(s.events,runId,call.callId);
      if (requested?.payload.approvalId!==ticket.approvalId || requested.payload.preview.reviewPolicy?.subject!=='subagentCapacity') throw new LoopFailure('agent_capacity_gate_missing','No matching budget gate.');
      if (!resolved) {
        const reviewed=s.events.some(e=>e.type==='approval.reviewed' && e.runId===runId && e.callId===call.callId && e.payload.approvalId===ticket.approvalId);
        if (ticket.reviewRequestId && !reviewed) { await review(call,ticket,s,deps,signal); advanced=true; break; }
        blocked??=call; continue;
      }
      if (resolved.payload.approvalId!==ticket.approvalId || resolved.payload.authorizationScope || (resolved.payload.source!=='user' && resolved.payload.source!=='agent')) throw new LoopFailure('agent_capacity_decision_invalid','Decision does not cover this exact dispatch.');
      let result: JsonObject;
      if (resolved.payload.decision==='deny') result={status:'denied',executed:false,reason:resolved.payload.reason ?? 'The requested extra subagent capacity was denied.'};
      else {
        const prior=s.events.find(e=>e.type==='agent.task.created' && e.runId===runId && e.callId===call.callId);
        if (prior?.type==='agent.task.created') {
          const task=s.state.agentTasks.find(t=>t.taskId===prior.payload.taskId);
          if (!task) throw new CapacityStartUnknown(prior.payload.taskId, 'Missing reservation');
          let childRunId = task.childRunId;
          if (!childRunId && task.status === 'running') {
            if (!deps.agents?.reconcileCapacityStart) throw new CapacityStartUnknown(task.taskId, 'Child journal unavailable');
            childRunId = await deps.agents.reconcileCapacityStart(prior) ?? undefined;
          }
          result = childRunId ? { taskId: task.taskId, agentId: task.agentSessionId }
            : { status: 'notStarted', executed: false, error: task.result && 'error' in task.result ? task.result.error
              : { code: 'agent_capacity_not_started', message: 'The child did not start. The assignment was not repeated.' } };
        } else {
          try {
            if (!deps.agents) throw new LoopFailure('agent_unavailable','No subagent runtime.');
            const op=decodeAgentOperation(call.payload.operation);
            if ((op.action!=='spawn' && op.action!=='assign') || !op.requestCapacity) throw new LoopFailure('agent_capacity_operation_invalid','Invalid original dispatch.');
            result=await deps.agents.execute(runId,call.callId,op,signal,{sessionId:call.sessionId,runId,callId:call.callId,quote:ticket.quote,source:resolved.payload.source});
            const task = (await deps.readSnapshot()).state.agentTasks.find(t => t.taskId === result.taskId);
            if (task && !task.childRunId && task.result && 'error' in task.result) {
              result = { status: 'notStarted', executed: false, error: task.result.error };
            }
          } catch (cause) {
            signal.throwIfAborted();
            const current=await deps.readSnapshot();
            if (current.events.some(e=>e.type==='agent.task.created' && e.runId===runId && e.callId===call.callId)) throw cause;
            result={status:'notStarted',executed:false,error:errorFact(cause)};
          }
        }
      }
      await deps.commit({type:'agent.capacity.settled',sessionId:call.sessionId,runId,callId:call.callId,payload:{approvalId:ticket.approvalId,result}});
      advanced=true; break;
    }
    if (advanced) { s=await deps.readSnapshot(); continue; }
    if (!blocked) return s;
    const callId=blocked.callId;
    if (s.state.run?.status!=='waiting') {
      s=await deps.commit(current=>current.state.revision!==s.state.revision ? [] : [{type:'run.waiting',sessionId:s.state.sessionId,runId,payload:{reason:'approval',detail:'等待子代理临时额度审批。'}}]); continue;
    }
    if (!deps.waitForChange) return {status:'waiting',runId,reason:'approval',callId};
    await deps.waitForChange(s.state.revision,signal,s.state.publishedPermissions); s=await deps.readSnapshot();
  }
}
