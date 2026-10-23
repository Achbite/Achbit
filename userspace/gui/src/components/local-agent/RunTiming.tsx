import type { SessionProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';

type Timing = NonNullable<SessionProjection['runTimings']>[number];
function duration(value: number): string {
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
}
/** Values are Session measurements. Rendering never invents a start or settlement. */
export function RunTiming({ timing, language }: { timing: Timing | undefined; language: UiLanguage }) {
  if (timing?.responseElapsedMs === undefined) return null;
  return <span className="conversation-run-timing">{t(language, 'agent.timing.responseElapsed', { duration: duration(timing.responseElapsedMs) })}</span>;
}
