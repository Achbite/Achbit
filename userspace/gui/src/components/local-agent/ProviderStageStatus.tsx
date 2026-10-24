import React, { useEffect, useState } from 'react';
import type { ProviderActivityProjection, RunProjection } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ReasoningDetails } from './ReasoningDetails';

interface Props {
  run: RunProjection;
  activity?: ProviderActivityProjection;
  toolPending: boolean;
  language: UiLanguage;
  reasoning?: { sessionId: string; requestId: string };
}

const ProviderStageStatus: React.FC<Props> = ({ run, activity, toolPending, language, reasoning }) => {
  const [now, setNow] = useState(Date.now);
  const [hadReasoning, setHadReasoning] = useState(activity?.phase === 'reasoning');
  useEffect(() => { if (activity?.phase === 'reasoning') setHadReasoning(true); }, [activity?.phase]);
  useEffect(() => {
    if (!activity || run.status !== 'running') return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activity?.startedAt, run.status]);
  const startedAt = activity ? Date.parse(activity.startedAt) : NaN;
  const streaming = run.status === 'running' && Number.isFinite(startedAt);
  const phase = run.status === 'waiting' ? `waiting.${run.waitingReason}`
    : run.status !== 'running' ? run.status
      : activity?.purpose === 'contextCompaction' ? 'compacting'
        : activity?.purpose === 'approvalReview' ? 'reviewing'
        : activity?.phase ?? (toolPending ? 'tools' : 'preparing');
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const lastContentAt = activity?.lastContentAt ? Date.parse(activity.lastContentAt) : NaN;
  const activityDetail = Number.isFinite(lastContentAt)
    ? t(language, 'agent.activity.lastContent', { seconds: Math.max(0, Math.floor((now - lastContentAt) / 1000)) })
    : t(language, 'agent.activity.noContent');
  const status = (
    <span className={`local-agent__provider-stage local-agent__provider-stage--${run.status}`}>
      <span className={run.status === 'running' ? 'local-agent__run-spinner' : 'local-agent__stage-dot'} aria-hidden="true" />
      <span className="local-agent__stage-main">
        <span role="status" aria-live="polite">{t(language, `agent.activity.${phase}`)}</span>
        {streaming && <span className="local-agent__stage-time" title={activityDetail}>
          {t(language, 'agent.activity.elapsed', { seconds: elapsedSeconds })}
        </span>}
      </span>
    </span>
  );
  return reasoning && (hadReasoning || activity?.phase === 'reasoning')
    ? <ReasoningDetails {...reasoning} live summary={status} /> : status;
};

export default ProviderStageStatus;
