import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalProjection, ConversationCommand, PendingAgentDecision, SessionProjection } from '@achbit/protocol';
import { selectPendingApproval } from './composerDecisions';
import { getLocalAgentProjection, submitLocalAgentCommand } from '../../services/localAgentApi';
import { watchConversationChanges } from '../../services/conversationEvents';
import useAppStatusStore from '../../state/appStatusStore';

export type ChildDecisionCommand = Extract<ConversationCommand, {
  type: 'interaction.respond' | 'approval.respond' | 'plan.respond' | 'session.permissions.set';
}>;

export type ChildReviewTarget = { kind: 'plan' | 'approval'; decision: PendingAgentDecision }
  | { kind: 'interaction'; decision: PendingAgentDecision; interactionId: string };

/** A published ID is only a route; the current child run must still own an unanswered item. */
export function pendingChildInteraction(projection: SessionProjection | null,
  id: Pick<SessionProjection['interactions'][number], 'runId' | 'interactionId'>, route: PendingAgentDecision) {
  if (!projection?.run || projection.sessionId !== route.agentSessionId || projection.run.runId !== id.runId
    || route.runId !== id.runId || !['running', 'waiting'].includes(projection.run.status)
    || !route.interactionIds.includes(id.interactionId)) return null;
  return projection.interactions.find(item => item.status === 'pending' && item.runId === id.runId && item.interactionId === id.interactionId) ?? null;
}

export function pendingChildApproval(projection: SessionProjection | null, id: Pick<ApprovalProjection, 'runId' | 'callId' | 'approvalId'>,
  route?: PendingAgentDecision) {
  if (route && (route.agentSessionId !== projection?.sessionId || route.runId !== id.runId
    || route.approval?.approvalId !== id.approvalId || route.approval?.callId !== id.callId)) return null;
  return selectPendingApproval(projection, id);
}

/** This is a view of a child Session, not a child execution owner. */
export function useAgentChildConversation(sessionId: string, expanded: boolean, route?: ChildReviewTarget) {
  const hostReady = useAppStatusStore(state => state.apiStatus === 'connected');
  const [projection, setProjection] = useState<SessionProjection | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchAttempt, setWatchAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const reads = useRef<Promise<void>>(Promise.resolve());
  const deciding = useRef(false);
  const latest = useRef<SessionProjection | null>(null);

  const read = useCallback((minimumRevision = 0, viewSignal?: AbortSignal) => {
    const controller = lifetime.current;
    const signal = viewSignal ?? controller?.signal;
    const request = reads.current.then(async () => {
      if (!controller) throw new Error('child_conversation_view_disposed');
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      const snapshot = await getLocalAgentProjection(sessionId, signal);
      signal?.throwIfAborted();
      controller.signal.throwIfAborted();
      if (snapshot.sessionId !== sessionId) throw new Error('child_conversation_session_mismatch');
      if (snapshot.revision < minimumRevision) {
        throw new Error(`conversation_projection_behind_command_reply:${snapshot.revision}:${minimumRevision}`);
      }
      if (!latest.current || snapshot.revision >= latest.current.revision) {
        latest.current = snapshot;
        setProjection(snapshot);
      }
      setReadError(null);
      return snapshot;
    }).catch((error: unknown) => {
      if (controller && !controller.signal.aborted && !signal?.aborted) setReadError(errorText(error));
      throw error;
    });
    reads.current = request.then(() => undefined, () => undefined);
    return request;
  }, [sessionId]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try { await read(0, signal); } catch { /* The view retains the original read error. */ }
  }, [read]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    latest.current = null;
    reads.current = Promise.resolve();
    deciding.current = false;
    setProjection(null);
    setReadError(null);
    setWatchError(null);
    setCommandError(null);
    setSubmitting(false);
    return () => { controller.abort(); if (lifetime.current === controller) lifetime.current = null; };
  }, [sessionId]);
  useEffect(() => {
    if (!expanded || !hostReady) return;
    const controller = new AbortController();
    setWatchError(null);
    void watchConversationChanges(sessionId, controller.signal, () => refresh(controller.signal)).catch(error => {
      if (!controller.signal.aborted) setWatchError(errorText(error));
    });
    return () => controller.abort();
  }, [sessionId, expanded, hostReady, refresh, watchAttempt]);

  const submit = useCallback(async (command: ChildDecisionCommand) => {
    if (command.sessionId !== sessionId) throw new Error('child_decision_session_mismatch');
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted) throw new Error('child_conversation_view_disposed');
    if (deciding.current) throw new Error('child_decision_in_flight');
    deciding.current = true;
    setSubmitting(true);
    setCommandError(null);
    try {
      if (route?.kind === 'interaction' && (command.type !== 'interaction.respond' || route.interactionId !== command.interactionId
        || !pendingChildInteraction(latest.current, command, route.decision))) throw new Error('interaction_response_missing');
      if (command.type === 'approval.respond' && !pendingChildApproval(latest.current, command, route?.kind === 'approval' ? route.decision : undefined)) {
        throw new Error('approval_response_missing');
      }
      const reply = await submitLocalAgentCommand(command);
      const rejection = reply.status === 'rejected' ? reply.error?.message ?? 'conversation_command_rejected' : null;
      try { await read(reply.revision, controller?.signal); }
      catch (error) {
        const reconciliation = `conversation_projection_reconcile_failed:${errorText(error)}`;
        throw new Error(rejection ? `${rejection};${reconciliation}` : reconciliation);
      }
      if (rejection) throw new Error(rejection);
      return reply;
    } catch (error) {
      if (controller && !controller.signal.aborted) setCommandError(errorText(error));
      throw error;
    } finally {
      if (controller && lifetime.current === controller && !controller.signal.aborted) {
        deciding.current = false;
        setSubmitting(false);
      }
    }
  }, [sessionId, read, route]);

  return { projection: projection?.sessionId === sessionId ? projection : null,
    readError: watchError ?? readError, commandError, submitting,
    refresh: async () => {
      if (watchError) setWatchAttempt(value => value + 1);
      else await refresh();
    }, submit };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
