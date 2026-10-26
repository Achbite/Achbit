import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationCommand, SessionProjection } from '@achbit/protocol';
import { getLocalAgentProjection, submitLocalAgentCommand } from '../../services/localAgentApi';
import { watchConversationChanges } from '../../services/conversationEvents';
import useAppStatusStore from '../../state/appStatusStore';

export type ChildDecisionCommand = Extract<ConversationCommand, {
  type: 'interaction.respond' | 'approval.respond' | 'plan.respond' | 'session.permissions.set';
}>;

/** This is a view of a child Session, not a child execution owner. */
export function useAgentChildConversation(sessionId: string, expanded: boolean) {
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
    if (deciding.current) throw new Error('child_decision_in_flight');
    deciding.current = true;
    setSubmitting(true);
    setCommandError(null);
    const controller = lifetime.current;
    try {
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
  }, [sessionId, read]);

  return { projection: projection?.sessionId === sessionId ? projection : null,
    readError: watchError ?? readError, commandError, submitting,
    refresh: async () => {
      if (watchError) setWatchAttempt(value => value + 1);
      else await refresh();
    }, submit };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
