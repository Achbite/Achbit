import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../ui-components';
import { getHostConnectionHeaders, getKernelApiBase } from '../../../services/hostTarget';
import { openExternalUrl } from '../../../services/runtimeAdapter';

interface AccountStatus { account: string | null; pending: boolean; code: string | null; error: string | null }

async function request(resource: 'account' | 'login', method = 'GET', signal?: AbortSignal): Promise<AccountStatus> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins/github/${resource}`, { method, signal, headers: getHostConnectionHeaders() });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? `GitHub: ${response.status}`);
  return result.data;
}

export default function GitHubPluginAccount({ chinese }: { chinese: boolean }) {
  const title = (zh: string, en: string) => chinese ? zh : en;
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const opened = useRef<string | null>(null);
  const pending = status?.pending ?? false;
  const verifyUrl = 'https://github.com/login/device';

  useEffect(() => {
    if (busy) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await request('account', 'GET', abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        setStatusError('');
        if (next.pending) timer = setTimeout(() => void refresh(), 1000);
      } catch (e) {
        if (!abort.signal.aborted) {
          setStatusError(String(e));
          if (pending) timer = setTimeout(() => void refresh(), 3000);
        }
      }
    };
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [busy, pending, refreshKey]);

  useEffect(() => {
    if (!status?.pending || !status.code || opened.current === status.code) return;
    opened.current = status.code;
    void openExternalUrl(verifyUrl).catch(e => setError(String(e)));
  }, [status?.pending, status?.code]);

  const manage = async (resource: 'account' | 'login', method: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try { setStatus(await request(resource, method)); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="plugin-manager__service">
    {status?.account && <strong>@{status.account}</strong>}
    <p>{title('登录会切换当前 Host 上的 GitHub CLI 账号。GitHub 授权包含私库写权限，插件只调用读取接口。', 'Signing in switches the active GitHub CLI account on the connected Host. GitHub grants private repository write access to the CLI. The plugin uses read endpoints only.')}</p>
    {status?.pending && <p role="status">{status.code ? <>{title('在 GitHub 输入一次性代码 ', 'Enter this code on GitHub ')}<strong>{status.code}</strong></> : title('正在等待 GitHub…', 'Waiting for GitHub…')}</p>}
    <div className="settings-actions">
      {!status && statusError && <Button onClick={() => setRefreshKey(value => value + 1)}>{title('重新获取状态', 'Retry connection status')}</Button>}
      {status?.pending ? <>
        {status.code && <Button onClick={() => void openExternalUrl(verifyUrl).catch(e => setError(String(e)))}>{title('打开 GitHub', 'Open GitHub')}</Button>}
        <Button disabled={busy} onClick={() => void manage('login', 'DELETE')}>{title('取消', 'Cancel')}</Button>
      </> : <Button variant="secondary" disabled={busy || !status} onClick={() => void manage('login', 'POST')}>{status?.account ? title('重新连接', 'Reconnect') : title('连接 GitHub', 'Connect GitHub')}</Button>}
      {status?.account && !status.pending && <>
        <Button onClick={() => void openExternalUrl('https://github.com/settings/applications').catch(e => setError(String(e)))}>{title('管理 GitHub 授权', 'Manage GitHub authorization')}</Button>
        <Button disabled={busy} onClick={() => void manage('account', 'DELETE')}>{title('断开插件连接', 'Disconnect plugin')}</Button>
      </>}
    </div>
    {(error || statusError || status?.error) && <p role="alert" className="settings-error">{error || statusError || status?.error}</p>}
  </div>;
}
