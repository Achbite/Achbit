import type { ActivityProjection } from '@achbit/protocol';
import { deferredShell } from '../services/desktopHistory';
import type { UiPluginInput } from './types';

export function pluginHistorySource(input: UiPluginInput) {
  if (input.kind === 'tool.result') return deferredShell(input.activity)?.fullProjection;
  if (input.kind === 'region' && input.data?.kind === 'activities') {
    for (const activity of input.data.activities) {
      const source = deferredShell(activity);
      if (source) return source.fullProjection;
    }
  }
}
export function completePluginInput(input: UiPluginInput, records: ReadonlyMap<string, ActivityProjection>): UiPluginInput {
  const complete = (activity: ActivityProjection): ActivityProjection => {
    const shell = activity.tool?.shell;
    if (!shell || !deferredShell(activity)) return activity;
    const full = records.get(activity.activityId);
    if (!full?.tool?.shell?.result || full.runId !== activity.runId || full.callId !== activity.callId
      || full.tool.recordId !== activity.tool?.recordId) throw new Error('shell_output_not_found');
    return { ...activity, tool: { ...activity.tool!, shell: { ...shell, result: full.tool.shell.result } } };
  };
  if (input.kind === 'tool.result') return { ...input, activity: complete(input.activity) };
  if (input.kind === 'region' && input.data?.kind === 'activities') {
    return { ...input, data: { ...input.data, activities: input.data.activities.map(complete) } };
  }
  return input;
}
