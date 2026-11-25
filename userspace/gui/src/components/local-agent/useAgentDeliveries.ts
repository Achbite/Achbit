import { useEffect, useRef, useState } from 'react';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { readTranscriptOverview } from '../../services/localAgentApi';
import { useLocalAgentStore } from '../../state/localAgentStore';

export async function childDeliveries(root: SessionProjection, roots: readonly string[], signal: AbortSignal,
  read = readTranscriptOverview, activeMembers?: Set<string>, refresh?: () => void): Promise<ArtifactProjection[]> {
  signal.throwIfAborted();
  const index = useLocalAgentStore.getState().childOutputs;
  const held = index.get(root, activeMembers);
  if (held) return held;
  // A grandchild can publish during the first read, before its identity is known to the rail.
  const changes = new Set<string | null>();
  const stop = index.subscribe(id => { changes.add(id); });
  try {
    const summary = await read(root.sessionId, signal);
    signal.throwIfAborted();
    const artifacts = summary.childDeliverables;
    const visited = new Set([...roots, ...summary.memberIds]);
    visited.delete(root.sessionId);
    const missedChange = [...visited].some(id => changes.has(id) && !activeMembers?.has(id));
    if (activeMembers) for (const id of visited) activeMembers.add(id);
    index.save(root, visited, artifacts, changes);
    if (missedChange) refresh?.();
    return artifacts;
  } finally { stop(); }
}

export function useAgentDeliveries(projection: SessionProjection | null) {
  const sessionId = projection?.sessionId;
  const tasks = new Map(projection?.agentTasks?.map(task => [task.agentSessionId, task]));
  const signature = JSON.stringify((projection?.agentChildren ?? []).map(child => [child.agentSessionId,
    tasks.get(child.agentSessionId)?.childRunId, tasks.get(child.agentSessionId)?.status]));
  const members = useRef(new Set<string>());
  const [revision, changed] = useState(0);
  const hasChildren = !!projection?.agentChildren?.length;
  const index = useLocalAgentStore(state => state.childOutputs);
  useEffect(() => {
    if (!sessionId || !hasChildren) return;
    return index.subscribe(id => {
      if (id === null ? index.connected : members.current.has(id)) changed(n => n + 1);
    });
  }, [index, sessionId, hasChildren]);
  const settledParent = projection?.run?.status === 'completed' ? projection : null;
  const [result, setResult] = useState<{ sessionId?: string; artifacts: ArtifactProjection[]; error?: string }>({ artifacts: [] });
  useEffect(() => {
    const controller = new AbortController();
    const roots = (JSON.parse(signature) as [string, string?, string?][])
      .filter(([, runId]) => runId).map(([id]) => id);
    if (!projection || !roots.length) { setResult({ sessionId, artifacts: [] }); return; }
    members.current = new Set(roots);
    void childDeliveries(projection, roots, controller.signal, readTranscriptOverview, members.current, () => changed(n => n + 1)).then(artifacts => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts: [], error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [sessionId, signature, settledParent, revision]);
  const held = projection && index.get(projection);
  if (held) return { sessionId, artifacts: held, error: undefined };
  return result.sessionId === sessionId ? result : { artifacts: [] };
}
