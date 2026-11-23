import { useEffect, useRef, useState } from 'react';
import { watchConversationEvents } from '../../services/conversationEvents';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { getLocalAgentProjection } from '../../services/localAgentApi';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { conversationDisplay } from './conversationDisplay';

// Retain only the derived list, not child projections, subscriptions or DOM.
// Weak keys follow the six complete root views in this window. An event, gap
// or replacement Host invalidates results even at an unchanged root revision.
const recent = new WeakMap<SessionProjection, { observation: object; artifacts: ArtifactProjection[]; members: Set<string> }>();
const observation = () => useLocalAgentStore.getState().historyObservation();

export async function childDeliveries(root: SessionProjection, roots: readonly string[], signal: AbortSignal,
  read = getLocalAgentProjection, currentObservation = observation, activeMembers?: Set<string>): Promise<ArtifactProjection[]> {
  signal.throwIfAborted();
  const stamp = currentObservation(), held = recent.get(root);
  if (held && stamp === held.observation) {
    if (activeMembers) for (const id of held.members) activeMembers.add(id);
    return held.artifacts;
  }
  const visited = new Set([root.sessionId]), artifacts: ArtifactProjection[] = [];
  const visit = async (id: string) => {
    signal.throwIfAborted();
    if (visited.has(id)) return;
    visited.add(id);
    activeMembers?.add(id);
    const child = await read(id, signal);
    signal.throwIfAborted();
    artifacts.push(...conversationDisplay(child, new Set(), new Map()).artifacts);
    const started = new Set(child.agentTasks?.filter(task => task.childRunId).map(task => task.agentSessionId));
    for (const member of child.agentChildren ?? []) if (started.has(member.agentSessionId)) await visit(member.agentSessionId);
  };
  // The rail must not saturate transport with every descendant's full timeline.
  for (const id of roots) await visit(id);
  signal.throwIfAborted();
  if (stamp && currentObservation() === stamp && visited.size <= 256 && artifacts.length <= 256
    && !root.assistantDraft && (!root.run || root.run.status === 'completed') && !root.agentTasks?.some(t => t.status === 'running')) {
    recent.set(root, { observation: stamp, artifacts, members: visited });
  }
  return artifacts;
}

export function useAgentDeliveries(projection: SessionProjection | null) {
  const sessionId = projection?.sessionId;
  const tasks = new Map(projection?.agentTasks?.map(task => [task.agentSessionId, task]));
  const signature = JSON.stringify((projection?.agentChildren ?? []).map(child => [child.agentSessionId,
    tasks.get(child.agentSessionId)?.childRunId, tasks.get(child.agentSessionId)?.status]));
  const members = useRef(new Set<string>());
  const [revision, changed] = useState(0);
  const hasChildren = !!projection?.agentChildren?.length;
  // Keep the active output rail current even when only a descendant changed. This
  // subscribes to the same Host stream as the workbench, not another connection.
  useEffect(() => {
    if (!sessionId || !hasChildren) return;
    const controller = new AbortController();
    void watchConversationEvents(controller.signal, event => {
      if (event.type !== 'ready' && members.current.has(event.sessionId)) changed(n => n + 1);
    }).catch(() => { if (!controller.signal.aborted) changed(n => n + 1); }); // The workbench owns connection errors.
    return () => controller.abort();
  }, [sessionId, hasChildren]);
  const settledParent = projection?.run?.status === 'completed' ? projection : null;
  const [result, setResult] = useState<{ sessionId?: string; artifacts: ArtifactProjection[]; error?: string }>({ artifacts: [] });
  useEffect(() => {
    const controller = new AbortController();
    const roots = (JSON.parse(signature) as [string, string?, string?][])
      .filter(([, runId]) => runId).map(([id]) => id);
    if (!projection || !roots.length) { setResult({ sessionId, artifacts: [] }); return; }
    members.current = new Set(roots);
    void childDeliveries(projection, roots, controller.signal, getLocalAgentProjection, observation, members.current).then(artifacts => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts: [], error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [sessionId, signature, settledParent, revision]);
  const held = projection && recent.get(projection);
  if (held && held.observation === observation()) return { sessionId, artifacts: held.artifacts, error: undefined };
  return result.sessionId === sessionId ? result : { artifacts: [] };
}
