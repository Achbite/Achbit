import { useState } from 'react';
import { initializeWorkspaceSandbox } from '../../../services/apiClient';
import { useSettingsStore } from '../../../state/settingsStore';

export default function WorkspaceSandboxSettings({ chinese }: { chinese: boolean }) {
  const environment = useSettingsStore((state) => state.environment);
  const reload = useSettingsStore((state) => state.loadUserSettings);
  const sandbox = environment?.workspaceSandbox as { backend?: string; available?: boolean; reason?: string } | undefined;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialize = async () => {
    setPending(true); setError(null);
    try {
      const result = await initializeWorkspaceSandbox();
      if (!result.ok) throw new Error(result.message || result.error || 'Sandbox support check failed');
      await reload();
    } catch (error) { setError(String(error)); }
    finally { setPending(false); }
  };
  return <section className="settings-group">
    <h3 className="settings-card__title">{chinese ? '工作区 Shell' : 'Workspace Shell'}</h3>
    <div className="settings-card settings-card__body">
      <div className="settings-field settings-field--compact">
        <div className="settings-field__main">
          <div className="settings-field__label">{sandbox?.available ? (chinese ? '可用' : 'Available') : (chinese ? '尚不可用' : 'Unavailable')}{sandbox?.backend ? ` · ${sandbox.backend}` : ''}</div>
          {sandbox?.reason && <p className="settings-field__description">{sandbox.reason}</p>}
        </div>
        {environment?.os === 'windows' && !sandbox?.available && <button className="settings-button" disabled={pending} onClick={() => void initialize()}>{pending ? (chinese ? '正在检查…' : 'Checking…') : (chinese ? '检查 Windows 支持' : 'Check Windows support')}</button>}
      </div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div>
  </section>;
}
