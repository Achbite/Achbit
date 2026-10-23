import { useEffect, useRef, useState } from 'react';
import type { AuthFlow, ConnectionSummary, QuotaSnapshot } from '@achbit/protocol';
import { cancelModelAuth, getModelAuth, getModelQuota, logoutModelConnection, startModelAuth } from '../../../services/apiClient';
import { openExternalUrl } from '../../../services/runtimeAdapter';
import { data, Hint, message, useModelLanguage } from './shared';

export default function SubscriptionAuth({ connection, onChanged }: { connection: ConnectionSummary; onChanged(): Promise<void> }) {
  const { text, language } = useModelLanguage();
  const [flow, setFlow] = useState<AuthFlow | null>(null);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [error, setError] = useState('');
  const [quotaError, setQuotaError] = useState('');
  const [loading, setLoading] = useState(false);
  const [quotaRevision, setQuotaRevision] = useState(0);
  const pending = useRef<string | null>(null);
  const alive = useRef(true);
  const onChangedRef = useRef(onChanged); onChangedRef.current = onChanged;
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (pending.current) void cancelModelAuth(pending.current); }; }, []);
  useEffect(() => {
    setQuota(null); setQuotaError('');
    if (connection.authStatus !== 'ready') return;
    const controller = new AbortController();
    void getModelQuota(connection.id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      try { setQuota(data(result)); } catch (e) { setQuotaError(message(e)); }
    });
    return () => controller.abort();
  }, [connection.id, connection.authStatus, connection.account?.label, quotaRevision]);
  useEffect(() => {
    if (!flow || flow.status !== 'pending') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = data(await getModelAuth(flow.id, controller.signal));
        if (controller.signal.aborted) return;
        setFlow(result);
        if (result.status === 'pending') timer = setTimeout(poll, 1500);
        else {
          pending.current = null;
          if (result.status === 'complete') { await onChangedRef.current(); setQuotaRevision(n => n + 1); }
          if (result.status === 'failed') setError(result.error ?? text('登录失败', 'Sign-in failed'));
        }
      } catch (e) { if (!controller.signal.aborted) setError(message(e)); }
    };
    timer = setTimeout(poll, 1500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [flow?.id, flow?.status]);
  const login = async (method: 'browser' | 'deviceCode') => {
    setLoading(true); setError('');
    try {
      const next = data(await startModelAuth(connection.id, method));
      if (!alive.current) { await cancelModelAuth(next.id); return; }
      pending.current = next.id; setFlow(next);
      if (method === 'browser' && next.verificationUrl) await openExternalUrl(next.verificationUrl);
    } catch (e) { if (alive.current) setError(message(e)); }
    finally { if (alive.current) setLoading(false); }
  };
  return <section className="model-subscription">
    <div className="model-heading"><h3>{text('账号', 'Account')}</h3>{connection.authStatus === 'ready' && <button onClick={async () => {
      setError(''); try { data(await logoutModelConnection(connection.id)); setFlow(null); pending.current = null; await onChanged(); } catch (e) { setError(message(e)); }
    }}>{text('退出登录', 'Sign out')}</button>}</div>
    {connection.authStatus === 'ready' ? <div className="model-account"><strong>{connection.account?.label}</strong><span>{connection.account?.plan}</span></div> : flow?.status === 'pending' ? <div className="model-auth-pending">
      <span>{text('等待授权', 'Waiting for authorization')}</span>
      {flow.userCode && <code>{flow.userCode}</code>}
      <div className="model-actions"><button onClick={() => flow.verificationUrl && void openExternalUrl(flow.verificationUrl).catch(e => setError(message(e)))}>{text('打开登录页面', 'Open sign-in page')}</button>
        <button onClick={async () => { try { setFlow(data(await cancelModelAuth(flow.id))); pending.current = null; } catch (e) { setError(message(e)); } }}>{text('取消', 'Cancel')}</button></div>
    </div> : <div className="model-actions"><button className="model-primary" disabled={loading} onClick={() => void login('browser')}>{text('浏览器登录', 'Sign in with browser')}</button><button disabled={loading} onClick={() => void login('deviceCode')}>{text('设备码登录', 'Use device code')}</button><Hint>{text('由 Achbit 独立完成授权，不需要安装 Codex CLI。', 'Authorize directly in Achbit. No Codex CLI installation required.')}</Hint></div>}
    {error && <div className="settings-error" role="alert">{error}</div>}
    {connection.authStatus === 'ready' && <>
      <div className="model-heading"><h3>{text('套餐额度', 'Plan limits')}</h3><button onClick={() => setQuotaRevision(n => n + 1)}>{text('刷新', 'Refresh')}</button></div>
      {quotaError ? <div className="settings-error" role="alert">{quotaError}</div> : quota ? <div className="model-quota-grid">{quota.windows.map(window => <div key={window.id} className="model-quota">
        <div><strong>{window.label}</strong><Hint>{`${text('统计窗口', 'Window')}: ${window.windowDurationSeconds / 3600} h · ${text('读取于', 'Retrieved')} ${new Date(quota.capturedAt).toLocaleString(language)}`}</Hint><span className="model-push">{(100 - window.usedPercent).toFixed(0)}% {text('剩余', 'left')}</span></div>
        <meter min={0} max={100} value={100 - window.usedPercent} aria-label={window.label} />
        {window.resetsAt && <small>{text('重置于', 'Resets')} {new Date(window.resetsAt).toLocaleString(language)}</small>}
      </div>)}{quota.credits && <div>{quota.credits.unlimited ? text('额度不限', 'Unlimited credits') : `${text('额外额度', 'Additional credits')}: ${quota.credits.balance ?? '—'}`}</div>}</div> : <div role="status">{text('正在读取额度…', 'Loading limits…')}</div>}
    </>}
  </section>;
}
