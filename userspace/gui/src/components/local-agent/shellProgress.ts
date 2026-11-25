import type { ActivityProjection, ProcessActivityProjection, SessionProjection } from '@achbit/protocol';

export const isPendingShell = (activity: ActivityProjection): boolean =>
  Boolean(activity.tool?.shell || activity.tool?.process)
  && ['requested', 'active', 'waiting'].includes(activity.status);

/** An asynchronous plugin/container job is not necessarily a Shell command. */
export function isRunningShell(a: ActivityProjection): boolean {
  return a.kind === 'tool' && a.status === 'active' && Boolean(a.tool?.shell
    || a.tool?.process && (a.tool.operation === 'bash' || a.tool.operation === 'powershell'));
}

export type BlockingShell = ActivityProjection & { callId: string; tool: NonNullable<ActivityProjection['tool']> & { process: ProcessActivityProjection } };

export function blockingShells(projection: Pick<SessionProjection, 'run' | 'activities'> | null): BlockingShell[] {
  if (projection?.run?.status !== 'running') return [];
  const runId = projection.run.runId;
  return projection.activities.filter((a): a is BlockingShell => a.runId === runId && !!a.callId
    && isRunningShell(a) && a.tool?.process?.blocking === true);
}

export function shellCommandPreview(activity: ActivityProjection): string {
  const command = activity.tool?.shell?.command ?? activity.tool?.process?.command ?? activity.label;
  const first = command.split(/\r?\n/)[0] ?? '';
  return first.length > 180 || first.length < command.length ? `${first.slice(0, 180)}…` : first;
}
