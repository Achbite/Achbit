import React, { useState } from 'react';
import type { LocalAgentError, ProviderActivityProjection, ProviderAttemptFact, SessionProjection } from '@achbit/protocol';
import type { UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { Button, UiIcon } from '../../ui-components';

function ErrorDetails({ error, language }: { error: LocalAgentError; language: UiLanguage }) {
  const d = error.diagnostics;
  return <details className="local-agent__error-details">
    <summary>{language === 'zh-CN' ? '诊断信息' : 'Diagnostics'}</summary>
    <code>{error.code}</code>
    {d && <>
      <p>{d.source} · {d.phase} · {d.category}</p>
      <dl>{(['isConnect', 'isTimeout', 'isBody'] as const).map((key) => d[key] === undefined ? null : <React.Fragment key={key}><dt>{key}</dt><dd>{String(d[key])}</dd></React.Fragment>)}</dl>
      {d.stopReason && <p>{d.stopReason}</p>}
      {d.providerError && <dl>{(['code', 'type', 'retryDirective'] as const).map(key => d.providerError?.[key]
        ? <React.Fragment key={key}><dt>{key}</dt><dd><code>{d.providerError[key]}</code></dd></React.Fragment> : null)}</dl>}
      {d.causes.length > 0 && <ol>{d.causes.map((cause, index) => <li key={index}>{cause.message}{cause.kind && ` (${cause.kind})`}{cause.osCode !== undefined && ` [OS ${cause.osCode}]`}</li>)}</ol>}
      {d.archivePath && <p>{d.archivePath}</p>}
      {d.secondary?.map((secondary, index) => <p key={index}>{secondary.code}: {secondary.message}</p>)}
    </>}
  </details>;
}

export function providerRetryAttempt(projection: SessionProjection, activity?: ProviderActivityProjection) {
  const attempt = projection.providerAttempts?.at(-1);
  if (projection.run?.status !== 'running' || !attempt) return null;
  if (attempt.phase === 'retryWaiting') return attempt.attempt + 1;
  if (attempt.phase === 'started' && attempt.attempt > 1 && (!activity || activity.phase === 'waitingResponse')) return attempt.attempt;
  return null;
}

export function ProviderRetryStatus({ projection, language, activity }: {
  projection: SessionProjection; language: UiLanguage; activity?: ProviderActivityProjection;
}) {
  const attempt = providerRetryAttempt(projection, activity);
  if (attempt === null) return null;
  return <aside className="local-agent__retry-status" role="status">
    <p><AchbitShellIcon name="network" size={16} />{language === 'zh-CN' ? `正在重新连接 ${attempt}/5` : `Reconnecting ${attempt}/5`}</p>
  </aside>;
}

export function groupProviderAttempts(attempts: readonly ProviderAttemptFact[]) {
  const groups = new Map<string, { providerRequestId: string; purpose: ProviderAttemptFact['purpose']; attempts: ProviderAttemptFact[] }>();
  for (const attempt of attempts) {
    let group = groups.get(attempt.providerRequestId);
    if (!group) {
      group = { providerRequestId: attempt.providerRequestId, purpose: attempt.purpose, attempts: [] };
      groups.set(attempt.providerRequestId, group);
    }
    group.attempts.push(attempt);
  }
  return Array.from(groups.values()).map(group => ({ ...group, retries: Math.max(0, group.attempts.length - 1) }));
}

function providerPurposeLabel(purpose: ProviderAttemptFact['purpose'], language: UiLanguage) {
  const zh = language === 'zh-CN';
  return purpose === 'approvalReview' ? (zh ? '权限审查' : 'Permission review')
    : purpose === 'contextCompaction' ? (zh ? '上下文整理' : 'Context compaction') : (zh ? '任务模型' : 'Task model');
}

export function StoppedRunStatus({ projection, language, onError }: {
  projection: SessionProjection; language: UiLanguage; onError(message: string | null): void;
}) {
  const busy = useLocalAgentStore(state => state.submitting);
  if (projection.run?.status !== 'cancelled' || projection.terminalError || projection.failureSnapshot?.error) return null;
  return <aside className="local-agent__continuity-line local-agent__stopped-status" role="status">
    <UiIcon name="stop" size={15} /><span>{language === 'zh-CN' ? '已停止' : 'Stopped'}</span>
    <Button size="compact" disabled={busy} onClick={() => {
      const store = useLocalAgentStore.getState();
      if (store.sessionId !== projection.sessionId) return;
      void store.sendMessage('继续当前任务。请先核对已经执行的工具结果和未完成计划，再继续处理。')
        .then(() => onError(null), error => onError(String(error)));
    }}>{language === 'zh-CN' ? '继续' : 'Continue'}</Button>
  </aside>;
}

export function RunFailureDetails({ projection, language, onError }: {
  projection: SessionProjection; language: UiLanguage; onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const profiles = useLocalAgentStore(state => state.profiles);
  const run = projection.run;
  const snapshot = run && ['failed', 'cancelled', 'indeterminate', 'releaseFailed'].includes(run.status) ? projection.failureSnapshot : undefined;
  const error = projection.terminalError ?? snapshot?.error;
  if (run?.status === 'cancelled' && !error) return null;
  const handoff = projection.contextHandoff;
  const reading = handoff?.status === 'reading';
  const switching = reading && run?.status === 'running';
  const switched = handoff?.status === 'ready' && handoff.runId === run?.runId;
  if (!run || (!error && !switching && !switched && !['cancelled', 'indeterminate', 'releasing', 'releaseFailed'].includes(run.status))) return null;
  const zh = language === 'zh-CN';
  const canContinue = !busy && ['failed', 'cancelled'].includes(run.status);
  const targetName = profiles.find(item => item.id === handoff?.profileId)?.name ?? handoff?.profileId;
  const label = switching ? (zh ? '正在读取此前工作' : 'Reading previous work')
    : run.status === 'releasing' ? (zh ? '正在结束运行' : 'Finishing the run')
    : run.status === 'releaseFailed' ? (zh ? '资源释放失败' : 'Resource release failed')
    : run.status === 'indeterminate' ? (zh ? '结果待确认' : 'Outcome needs verification')
    : run.status === 'cancelled' ? (zh ? '已停止' : 'Stopped')
    : reading ? (zh ? '接手未完成' : 'Handoff incomplete')
    : error ? (zh ? '运行失败' : 'Run failed')
    : (zh ? `已切换至 ${targetName}` : `Switched to ${targetName}`);
  const requests = groupProviderAttempts((projection.providerAttempts ?? [])
    .filter(attempt => snapshot?.providerAttemptIds.includes(attempt.providerAttemptId)));
  const continueTask = async (inNewSession: boolean) => {
    setBusy(true);
    try {
      const store = useLocalAgentStore.getState();
      if (store.sessionId !== projection.sessionId) return;
      if (inNewSession) {
        const projectId = store.catalog.sessions.find((item) => item.id === projection.sessionId)?.projectId;
        store.startNewSession(projectId ?? null);
      }
      await useLocalAgentStore.getState().sendMessage(inNewSession
        ? `接手来源会话 ${projection.sessionId}。先通过 session 工具读取该会话的目标、计划和相关工具结果，确认已完成事实后继续未完成的任务。`
        : '继续当前任务。请先核对已经执行的工具结果和未完成计划，再继续处理。');
      onError(null);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="local-agent__terminal-error">
    <div className="local-agent__continuity-line" role="status">
      <UiIcon name={switching ? 'network' : run.status === 'cancelled' ? 'stop' : error ? 'warning' : 'check'} size={15} />
      <span>{label}</span>
      {canContinue && <Button size="compact" disabled={busy} onClick={() => void continueTask(false)}>{reading ? (zh ? '重试接手' : 'Retry handoff') : (zh ? '继续' : 'Continue')}</Button>}
      {switching && <Button size="compact" disabled={busy} onClick={() => void useLocalAgentStore.getState().cancelRun().catch(cause => onError(String(cause)))}>{zh ? '停止' : 'Stop'}</Button>}
      {(error || snapshot) && <Button size="compact" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{zh ? '详情' : 'Details'}</Button>}
    </div>
    <div hidden={!expanded} className="local-agent__continuity-details">
    {error && <><p>{error.message}</p><ErrorDetails error={error} language={language} /></>}
    {snapshot && <details><summary>{zh ? '失败时的状态' : 'State at failure'}</summary>
      <p>{zh ? `会话版本 ${snapshot.revision} · ${snapshot.phase}` : `Session revision ${snapshot.revision} · ${snapshot.phase}`}</p>
      <p>{zh ? `${requests.length} 个模型请求，发送 ${snapshot.providerAttemptIds.length} 次；已记录工具结果 ${snapshot.toolRecordIds.length} 项，待确认调用 ${snapshot.pendingCallIds.length} 项。` : `${requests.length} model requests, ${snapshot.providerAttemptIds.length} sends; ${snapshot.toolRecordIds.length} tool records, ${snapshot.pendingCallIds.length} pending calls.`}</p>
      {snapshot.providerRequestId && <code>{snapshot.providerRequestId}</code>}
      {requests.map(request => <details key={request.providerRequestId}><summary>{providerPurposeLabel(request.purpose, language)} · {zh ? `发送 ${request.attempts.length} 次，重试 ${request.retries} 次` : `${request.attempts.length} sends, ${request.retries} retries`}{request.providerRequestId === snapshot.providerRequestId && ` · ${zh ? '失败请求' : 'Failed request'}`}</summary>
        <code>{request.providerRequestId}</code>
        {request.attempts.map(attempt => <details key={attempt.providerAttemptId}><summary>{zh ? `第 ${attempt.attempt} 次发送` : `Send ${attempt.attempt}`} · {attempt.phase}</summary><code>{attempt.providerAttemptId}</code>{attempt.error && <ErrorDetails error={attempt.error} language={language} />}</details>)}
      </details>)}
    </details>}
    {canContinue && <Button size="compact" disabled={busy} onClick={() => void continueTask(true)}>{zh ? '新会话接手' : 'Continue in a new session'}</Button>}
    </div>
  </article>;
}
