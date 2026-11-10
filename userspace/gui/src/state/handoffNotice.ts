import type { SessionProjection } from '@achbit/protocol';
import type { UiLanguage } from '../i18n';
import type { UiEventInput } from './uiEvents';

/**
 * Notify only a newly observed ready transition. Initial history, repeated reads
 * and profile/locale refreshes are not new handoffs.
 */
export function runHandoffNotice(
  previous: SessionProjection | undefined,
  projection: SessionProjection,
  profileName: string | undefined,
  language: UiLanguage,
): UiEventInput | null {
  const handoff = projection.contextHandoff;
  const runId = projection.run?.runId;
  if (!previous || previous.sessionId !== projection.sessionId || projection.revision <= previous.revision
    || !runId || handoff?.status !== 'ready' || handoff.runId !== runId
    || (previous.contextHandoff?.runId === runId && previous.contextHandoff.status === 'ready')) return null;
  const name = profileName || handoff.profileId;
  return {
    key: `handoff:${projection.sessionId}:${runId}`,
    sessionId: projection.sessionId,
    tone: 'success',
    text: language === 'zh-CN' ? `已切换至 ${name}` : `Switched to ${name}`,
  };
}
