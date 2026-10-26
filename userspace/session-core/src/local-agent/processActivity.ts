import type { RunActivity } from './plugins.js';
import { pendingProcessWait } from './processWait.js';

/** Session-owned adapter. The fact feed is allocated lazily when a job exists. */
export function createProcessActivity(runId: string, sync: () => Promise<void>,
  wait: (signal: AbortSignal, jobIds?: string[], timeoutSeconds?: number) => Promise<void>): RunActivity {
  let revisions = new Map<string, number>();
  return {
    sync,
    async waitPending(snapshot, signal) {
      const pending = pendingProcessWait(snapshot.events, runId);
      if (pending) await wait(signal, pending.jobIds, pending.timeoutSeconds);
    },
    checkpoint(snapshot) {
      revisions = new Map(Object.values(snapshot.state.processes)
        .filter(job => job.runId === runId).map(job => [job.jobId, job.revision]));
    },
    needsContinuation(snapshot) {
      return Object.values(snapshot.state.processes).some(job => job.runId === runId
        && (job.status === 'active' || job.revision !== revisions.get(job.jobId)));
    },
    wait: signal => wait(signal),
    blocksFollowingCalls(snapshot, call) {
      const job = Object.values(snapshot.state.processes).find(job => job.callId === call.callId && job.status === 'active');
      const completed = snapshot.events.findLast(event => event.type === 'tool.completed' && event.callId === call.callId);
      const result = completed?.type === 'tool.completed' && 'output' in completed.payload.record
        ? completed.payload.record.output as {job?: {status?: string}} | null : null;
      const explicitWait = call.payload.toolName === 'process' && call.payload.input.action === 'wait' && result?.job?.status === 'active';
      return Boolean(job && call.payload.toolName !== 'process' || explicitWait && pendingProcessWait(snapshot.events, runId));
    },
  };
}
