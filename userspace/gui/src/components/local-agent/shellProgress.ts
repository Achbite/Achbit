import type { ActivityProjection } from '@achbit/protocol';

export const isPendingShell = (activity: ActivityProjection): boolean =>
  Boolean(activity.tool?.shell || activity.tool?.process)
  && ['requested', 'active', 'waiting'].includes(activity.status);

export function shellCommandPreview(activity: ActivityProjection): string {
  const command = activity.tool?.shell?.command ?? activity.tool?.process?.command ?? activity.label;
  const first = command.split(/\r?\n/)[0] ?? '';
  return first.length > 180 || first.length < command.length ? `${first.slice(0, 180)}…` : first;
}
