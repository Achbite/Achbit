import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationCommand, SessionProjection } from '@deepcode/protocol';
import { getLocalAgentProjection, submitLocalAgentCommand } from '../../services/localAgentApi';
import { startProjectionPolling } from './useProjectionPolling';

export type ChildDecisionCommand = Extract<ConversationCommand, {
  type: 'interaction.respond' | 'approval.respond' | 'plan.respond' | 'session.permissions.set';
}>;

/** This is a view of a child Session, not a child execution owner. */
export function useAgentChildConversation(sessionId: string, taskRevision: string, running: boolean, expanded: boolean) {
  const [projection, setProjection] = useState<SessionProjection | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const reads = useRef<Promise<void>>(Promise.resolve());
  const deciding = useRef(false);
  const latest = useRef<SessionProjection | null>(null);

  const read = useCallback((minimumRevision = 0) => {
    const controller = lifetime.current;
    const request = reads.current.then(async () => {
      if (!controller) throw new Error('child_conversation_view_disposed');
      controller.signal.throwIfAborted();
      const snapshot = await getLocalAgentProjection(sessionId, controller.signal);
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
      if (controller && !controller.signal.aborted) setReadError(errorText(error));
      throw error;
    });
    reads.current = request.then(() => undefined, () => undefined);
    return request;
  }, [sessionId]);

  const refresh = useCallback(async () => {
    try { await read(); } catch { /* The view retains the original read error. */ }
  }, [read]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { controller.abort(); lifetime.current = null; };
  }, [sessionId]);
  useEffect(() => { void refresh(); }, [refresh, taskRevision]);
  const live = running || Boolean(projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status))
    || Boolean(projection?.agentTasks?.some(task => task.status === 'running'));
  useEffect(() => {
    if (live) return startProjectionPolling(expanded, refresh);
  }, [live, expanded, refresh]);

  const submit = useCallback(async (command: ChildDecisionCommand) => {
    if (command.sessionId !== sessionId) throw new Error('child_decision_session_mismatch');
    if (deciding.current) throw new Error('child_decision_in_flight');
    deciding.current = true;
    setSubmitting(true);
    setCommandError(null);
    const controller = lifetime.current;
    try {
      const reply = await submitLocalAgentCommand(command);
      const rejection = reply.status === 'rejected' ? reply.error?.message ?? 'conversation_command_rejected' : null;
      try { await read(reply.revision); }
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
      deciding.current = false;
      if (controller && !controller.signal.aborted) setSubmitting(false);
    }
  }, [sessionId, read]);

  return { projection, readError, commandError, submitting, refresh, submit };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
