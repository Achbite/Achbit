import type { ProcessWaitState, SessionEvent } from '@achbit/protocol';

// Runtime policy seam; the model does not schedule repeated reviews.
export const PROCESS_WAIT_REVIEW_MS = 120_000;

export function activeProcessWait(events: readonly SessionEvent[], runId: string): ProcessWaitState | undefined {
  const event = events.findLast(event => event.type === 'process.wait.changed' && event.runId === runId);
  return event?.type === 'process.wait.changed' && event.payload.phase !== 'released' ? event.payload : undefined;
}

/** A process.wait result remains a barrier until the next model request consumes it. */
export function pendingProcessWait(events: readonly SessionEvent[], runId: string): {jobIds: string[]; timeoutSeconds?: number} | undefined {
  let pending: ReturnType<typeof pendingProcessWait>;
  for (const event of events) {
    if (!('runId' in event) || event.runId !== runId) continue;
    if (event.type === 'tool.completed' && event.payload.record.toolName === 'process'
      && event.payload.record.input.action === 'wait' && 'output' in event.payload.record) {
      const output = event.payload.record.output as {wait?: {jobId?: unknown; timeoutSeconds?: unknown}} | null;
      if (typeof output?.wait?.jobId === 'string') pending = {jobIds: [output.wait.jobId],
        ...(typeof output.wait.timeoutSeconds === 'number' ? {timeoutSeconds: output.wait.timeoutSeconds} : {})};
    }
    if (event.type === 'context.composed' && event.payload.purpose === 'agent'
      || event.type === 'run.finishing' || event.type === 'run.settled') pending = undefined;
  }
  return pending;
}
