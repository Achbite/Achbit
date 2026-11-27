import React, { useState } from 'react';
import type { LocalAgentError, ProviderActivityProjection, ProviderAttemptFact, TranscriptRun, SessionProjection } from '@achbit/protocol';
import { providerNeedsContinuation, runFailureKind } from '@achbit/protocol';
import { localizedError, t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { Button, DisclosureSummary, UiIcon } from '../../ui-components';

function ErrorDetails({ error, language }: { error: LocalAgentError; language: UiLanguage }) {
  const d = error.diagnostics;
  return <details className="local-agent__error-details">
    <DisclosureSummary>{language === 'zh-CN' ? '诊断信息' : 'Diagnostics'}</DisclosureSummary>
    <code>{error.code}</code>
    <p>{error.message}</p>
    {d && <>
      <p>{d.source} · {d.phase} · {d.category}</p>
      <dl>{(['isConnect', 'isTimeout', 'isBody'] as const).map((key) => d[key] === undefined ? null : <React.Fragment key={key}><dt>{key}</dt><dd>{String(d[key])}</dd></React.Fragment>)}</dl>
      {d.stopReason && <p>{d.stopReason}</p>}
      {d.providerError && <dl>{(['httpStatus', 'code', 'type', 'status', 'retryDirective'] as const).map(key => d.providerError?.[key]
        ? <React.Fragment key={key}><dt>{key}</dt><dd><code>{d.providerError[key]}</code></dd></React.Fragment> : null)}</dl>}
      {d.causes.length > 0 && <ol>{d.causes.map((cause, index) => <li key={index}>{cause.message}{cause.kind && ` (${cause.kind})`}{cause.osCode !== undefined && ` [OS ${cause.osCode}]`}</li>)}</ol>}
      {d.archivePath && <p>{d.archivePath}</p>}
      {d.secondary?.map((secondary, index) => <p key={index}>{secondary.code}: {secondary.message}</p>)}
    </>}
  </details>;
}

function failureLabel(error: LocalAgentError | undefined, language: UiLanguage) {
  const labels = {
    overloaded: ['模型服务过载', 'Model service overloaded'],
    unavailable: ['模型服务过载或暂不可用', 'Model service overloaded or unavailable'],
    timeout: ['模型请求超时', 'Model request timed out'],
    connection: ['模型连接失败', 'Model connection failed'],
    rateLimit: ['模型请求受到限流', 'Model rate limit reached'],
    quota: ['模型服务额度或余额不足', 'Model service quota or balance exhausted'],
    authentication: ['模型服务认证失败', 'Model service authentication failed'],
    permission: ['模型服务访问被拒绝', 'Model service access denied'],
    providerInternal: ['模型服务内部错误', 'Model service internal error'],
    providerProtocol: ['模型响应格式异常', 'Invalid model response'],
    providerIncomplete: ['模型响应未完成', 'Model response incomplete'],
    providerRejected: ['模型服务拒绝了请求', 'Model service rejected the request'],
    providerFailure: ['模型请求失败', 'Model request failed'],
    contextLimit: ['上下文预算不足', 'Context budget exceeded'],
    loop: ['Loop 运行失败', 'Loop failed'],
    unclassified: ['任务未完成', 'Task incomplete'],
  };
  return labels[runFailureKind(error)][language === 'zh-CN' ? 0 : 1];
}

export function providerRetryAttempt(projection: TranscriptRun, activity?: ProviderActivityProjection) {
  const attempt = projection.providerAttempts?.at(-1);
  if (projection.run?.status !== 'running' || !attempt || attempt.runId !== projection.run.runId) return null;
  if (attempt.phase === 'retryWaiting') return attempt.attempt + 1;
  if (attempt.phase === 'started' && attempt.attempt > 1 && (!activity || activity.phase === 'waitingResponse')) return attempt.attempt;
  return null;
}

export function ProviderRetryStatus({ projection, language, activity }: {
  projection: TranscriptRun; language: UiLanguage; activity?: ProviderActivityProjection;
}) {
  const attempt = providerRetryAttempt(projection, activity);
  if (attempt === null) return null;
  const waiting = projection.providerAttempts?.at(-1);
  const deadline = waiting?.phase === 'retryWaiting' && waiting.error?.diagnostics?.category === 'provider'
    ? waiting.error.diagnostics.providerError?.retryAt : undefined;
  const label = deadline !== undefined
    ? `${failureLabel(waiting?.error, language)} · ${t(language, 'agent.retryAfter', { time: new Date(deadline).toLocaleTimeString(language) })}`
    : language === 'zh-CN' ? `正在重新连接 · 第 ${attempt} 次尝试` : `Reconnecting · attempt ${attempt}`;
  return <aside className="local-agent__retry-status" role="status">
    <p><UiIcon name="network" size={16} />{label}</p>
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
  projection: TranscriptRun; language: UiLanguage; onError(message: string | null): void;
}) {
  const busy = useLocalAgentStore(state => state.submitting);
  if (projection.run?.status !== 'cancelled' || projection.terminalError || projection.failureSnapshot?.error) return null;
  return <aside className="local-agent__continuity-line local-agent__stopped-status" role="status">
    <UiIcon name="stop" size={15} /><span>{language === 'zh-CN' ? '已停止' : 'Stopped'}</span>
    <Button size="compact" disabled={busy} onClick={() => {
      const store = useLocalAgentStore.getState();
      if (store.sessionId !== projection.sessionId) return;
      void store.sendMessage(t(language, 'agent.continue.input'))
        .then(() => onError(null), error => onError(String(error)));
    }}>{language === 'zh-CN' ? '继续' : 'Continue'}</Button>
  </aside>;
}

export function RunFailureDetails({ projection, language, onError }: {
  projection: TranscriptRun; language: UiLanguage; onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const run = projection.run;
  const snapshot = terminalSnapshot(projection);
  const error = projection.terminalError ?? snapshot?.error;
  if (run?.status === 'cancelled' && !error) return null;
  const scheduled = run?.continuation;
  if (scheduled && run.status === 'running' && !projection.providerAttempts?.some(item => item.runId === run.runId)) {
    const time = new Date(scheduled.retryAt).toLocaleTimeString(language);
    if (scheduled.retryAt > Date.now()) return <aside className="local-agent__continuity-line" role="status">
      <UiIcon name="network" size={15} />{language === 'zh-CN' ? `已安排，${time} 后继续` : `Scheduled to continue after ${time}`}
    </aside>;
  }
  const handoff = projection.contextHandoff;
  const reading = handoff?.status === 'reading';
  const switching = reading && run?.status === 'running';
  // A completed handoff is published as a transient notice; it is not a state this panel keeps.
  if (!run || (!error && !switching && !['cancelled', 'indeterminate', 'releasing', 'releaseFailed'].includes(run.status))) return null;
  const zh = language === 'zh-CN';
  const canContinue = !busy && ['failed', 'cancelled'].includes(run.status);
  const label = switching ? (zh ? '正在读取此前工作' : 'Reading previous work')
    : run.status === 'releasing' ? (zh ? '正在结束运行' : 'Finishing the run')
    : run.status === 'releaseFailed' ? (zh ? '资源释放失败' : 'Resource release failed')
    : run.status === 'indeterminate' ? (zh ? '结果待确认' : 'Outcome needs verification')
    : run.status === 'cancelled' ? (zh ? '已停止' : 'Stopped')
    : failureLabel(error, language);
  const providerContinuation = run.status === 'failed' && providerNeedsContinuation(error)
    && !snapshot?.pendingCallIds.length && projection.providerAttempts?.some(attempt => attempt.purpose !== 'approvalReview'
      && attempt.providerRequestId === snapshot?.providerRequestId && snapshot?.providerAttemptIds.includes(attempt.providerAttemptId));
  const deadline = error?.diagnostics?.providerError?.retryAt;
  const scheduledLabel = providerContinuation && deadline && deadline > Date.now()
    ? (zh ? `到 ${new Date(deadline).toLocaleTimeString(language)} 继续` : `Continue at ${new Date(deadline).toLocaleTimeString(language)}`) : null;
  const continueTask = async (inNewSession: boolean) => {
    setBusy(true);
    try {
      const store = useLocalAgentStore.getState();
      if (store.sessionId !== projection.sessionId) return;
      if (!inNewSession && providerContinuation) {
        await store.continueProvider(projection.sessionId, run.runId);
        onError(null);
        return;
      }
      if (inNewSession) {
        const projectId = store.catalog.sessions.find((item) => item.id === projection.sessionId)?.projectId;
        store.startNewSession(projectId ?? null);
      }
      await useLocalAgentStore.getState().sendMessage(inNewSession
        ? t(language, 'agent.handoff.input', { sessionId: projection.sessionId })
        : t(language, 'agent.continue.input'));
      onError(null);
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="local-agent__terminal-error">
    <div className="local-agent__continuity-line" role="status">
      <UiIcon name={switching ? 'network' : run.status === 'cancelled' ? 'stop' : error ? 'warning' : 'check'} size={15} />
      <span>{label}</span>
      {canContinue && <Button size="compact" disabled={busy} onClick={() => void continueTask(false)}>{scheduledLabel || (reading ? (zh ? '重试接手' : 'Retry handoff') : (zh ? '继续' : 'Continue'))}</Button>}
      {switching && <Button size="compact" disabled={busy} onClick={() => void useLocalAgentStore.getState().cancelRun().catch(cause => onError(String(cause)))}>{zh ? '停止' : 'Stop'}</Button>}
      {(error || snapshot) && <Button size="compact" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{zh ? '详情' : 'Details'}</Button>}
    </div>
    {error && <p className="local-agent__failure-reason" data-expanded={expanded || undefined}>{localizedError(language, error.message, error.code)}</p>}
    {expanded && <div className="local-agent__continuity-details">
      <RunFailureDiagnostics projection={projection} language={language} />
    {canContinue && <Button size="compact" disabled={busy} onClick={() => void continueTask(true)}>{zh ? '新会话接手' : 'Continue in a new session'}</Button>}
    </div>}
  </article>;
}

function terminalSnapshot(projection: TranscriptRun) {
  const status = projection.run?.status;
  return status && ['failed', 'cancelled', 'indeterminate', 'releaseFailed'].includes(status) ? projection.failureSnapshot : undefined;
}

export function RunFailureDiagnostics({ projection, language }: { projection: TranscriptRun; language: UiLanguage }) {
  const snapshot = terminalSnapshot(projection);
  const error = projection.terminalError ?? snapshot?.error;
  const requests = groupProviderAttempts((projection.providerAttempts ?? []).filter(attempt => snapshot?.providerAttemptIds.includes(attempt.providerAttemptId)));
  const zh = language === 'zh-CN';
  return <>
    {error && <ErrorDetails error={error} language={language} />}
    {snapshot && <details><DisclosureSummary>{zh ? '失败时的状态' : 'State at failure'}</DisclosureSummary>
      <p>{zh ? `会话版本 ${snapshot.revision} · ${snapshot.phase}` : `Session revision ${snapshot.revision} · ${snapshot.phase}`}</p>
      <p>{zh ? `${requests.length} 个模型请求，发送 ${snapshot.providerAttemptIds.length} 次；已记录工具结果 ${snapshot.toolRecordIds.length} 项，待确认调用 ${snapshot.pendingCallIds.length} 项。` : `${requests.length} model requests, ${snapshot.providerAttemptIds.length} sends; ${snapshot.toolRecordIds.length} tool records, ${snapshot.pendingCallIds.length} pending calls.`}</p>
      {snapshot.providerRequestId && <code>{snapshot.providerRequestId}</code>}
      {requests.map(request => <details key={request.providerRequestId}><DisclosureSummary>{providerPurposeLabel(request.purpose, language)} · {zh ? `发送 ${request.attempts.length} 次，重试 ${request.retries} 次` : `${request.attempts.length} sends, ${request.retries} retries`}{request.providerRequestId === snapshot.providerRequestId && ` · ${zh ? '失败请求' : 'Failed request'}`}</DisclosureSummary>
        <code>{request.providerRequestId}</code>
        {request.attempts.map(attempt => <details key={attempt.providerAttemptId}><DisclosureSummary>{zh ? `第 ${attempt.attempt} 次发送` : `Send ${attempt.attempt}`} · {attempt.phase}</DisclosureSummary><code>{attempt.providerAttemptId}</code>{attempt.error && <ErrorDetails error={attempt.error} language={language} />}</details>)}
      </details>)}
    </details>}
  </>;
}
