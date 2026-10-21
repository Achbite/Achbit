import type { ActivityProjection } from '@deepcode/protocol';

export const isPendingShell = (activity: ActivityProjection): boolean =>
  Boolean(activity.tool?.shell || activity.tool?.process)
  && ['requested', 'active', 'waiting'].includes(activity.status);

/** A display-only tail. Keep streams separate: the projection does not carry interleaving order. */
export function shellOutputTail(text: string, lines = 3): string {
  return text.replace(/\r\n/g, '\n').split(/[\r\n]/).filter(line => line.length > 0).slice(-lines)
    .map(line => line.length > 240 ? `${line.slice(0, 240)}…` : line).join('\n');
}

export function shellCommandPreview(activity: ActivityProjection): string {
  const command = activity.tool?.shell?.command ?? activity.tool?.process?.command ?? activity.label;
  const first = command.split(/\r?\n/)[0] ?? '';
  return first.length > 180 || first.length < command.length ? `${first.slice(0, 180)}…` : first;
}
