import { useEffect, useState } from 'react';
import type { ArtifactProjection, SessionProjection } from '@achbit/protocol';
import { getLocalAgentProjection } from '../../services/localAgentApi';
import { conversationDisplay } from './conversationDisplay';

/** Read canonical child deliveries when a task settles, retaining the actual executor identity. */
export function useAgentDeliveries(projection: SessionProjection | null) {
  const sessionId = projection?.sessionId;
  const tasks = new Map(projection?.agentTasks?.map(task => [task.agentSessionId, task]));
  const children = projection?.agentChildren ?? [];
  const signature = JSON.stringify(children.map(child => [child.agentSessionId,
    tasks.get(child.agentSessionId)?.childRunId, tasks.get(child.agentSessionId)?.status]));
  const [result, setResult] = useState<{ sessionId?: string; artifacts: ArtifactProjection[]; error?: string }>({ artifacts: [] });
  useEffect(() => {
    const controller = new AbortController();
    const roots = (JSON.parse(signature) as [string, string?, string?][])
      .filter(([, runId]) => runId).map(([id]) => id);
    if (!sessionId || !roots.length) { setResult({ sessionId, artifacts: [] }); return; }
    const visited = new Set<string>();
    const read = async (id: string): Promise<ArtifactProjection[]> => {
      if (visited.has(id)) return [];
      visited.add(id);
      const child = await getLocalAgentProjection(id, controller.signal);
      const artifacts = conversationDisplay(child, new Set(), new Map()).artifacts;
      const started = new Set(child.agentTasks?.filter(task => task.childRunId).map(task => task.agentSessionId));
      const descendants = await Promise.all((child.agentChildren ?? [])
        .filter(member => started.has(member.agentSessionId)).map(member => read(member.agentSessionId)));
      return [...artifacts, ...descendants.flat()];
    };
    void Promise.all(roots.map(read)).then(groups => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts: groups.flat() });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ sessionId, artifacts: [], error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [sessionId, signature]);
  return result.sessionId === sessionId ? result : { artifacts: [] };
}
