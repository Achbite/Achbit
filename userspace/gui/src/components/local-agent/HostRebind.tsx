import { useEffect, useState } from 'react';
import type { HostWindowBinding, RunProjection } from '@achbit/protocol';
import { nativeHostBinding } from '../../services/nativeBrowser';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useUiLanguage } from '../../useUiLanguage';
import { t } from '../../i18n';

/** Offers a user decision; displaying a new GUI never changes the task's target. */
export function HostRebind({ run }: { run: RunProjection | null }) {
  const language = useUiLanguage();
  const rebind = useLocalAgentStore(state => state.rebindHost);
  const [current, setCurrent] = useState<HostWindowBinding>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setCurrent(undefined); setError('');
    if (run?.status === 'waiting' && run.hostBinding) {
      void nativeHostBinding().then(binding => { if (active) setCurrent(binding); })
        .catch(reason => { if (active) setError(String(reason)); });
    }
    return () => { active = false; };
  }, [run?.runId, run?.status, run?.hostBinding?.hostInstanceId, run?.hostBinding?.windowLabel]);
  if (error) return <p role="alert" className="local-agent__resource-error">{error}</p>;
  if (!current || !run?.hostBinding || run.status !== 'waiting'
    || current.hostInstanceId === run.hostBinding.hostInstanceId && current.windowLabel === run.hostBinding.windowLabel) return null;
  return <div className="local-agent__host-rebind">
    <span>{t(language, 'agent.hostRebind.description')}</span>
    <button type="button" disabled={busy} onClick={() => {
      setBusy(true);
      void rebind(current).catch(reason => setError(String(reason))).finally(() => setBusy(false));
    }}>{t(language, 'agent.hostRebind.action')}</button>
  </div>;
}
