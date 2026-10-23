import UiIcon from '../../icons/registry';
import type { HostStartupStatusV1 } from '../../services/runtimeAdapter';
import { t, type UiLanguage } from '../../i18n';
import './hostStartupDiagnostic.css';

export function HostStartupDiagnostic({ status, workspaceError, language, onRetry, busy = false }: { status: HostStartupStatusV1 | null; workspaceError?: string | null; language: UiLanguage; onRetry?: () => void; busy?: boolean }) {
  const failedStatus = status && ['failed', 'blocked'].includes(status.phase) ? status : null;
  const ssh = failedStatus?.stage === 'ssh';
  const disconnected = failedStatus?.code === 'host_ssh_disconnected';
  if (!failedStatus && !workspaceError) return null;
  return <section className="host-startup-diagnostic" role="alert">
    <h3>{t(language, ssh ? (disconnected ? 'achbitGui.ssh.disconnectTitle' : 'achbitGui.ssh.failed') : failedStatus ? 'host.startup.failed' : 'workspace.error.load')}</h3>
    {failedStatus && <p>{disconnected ? t(language, 'achbitGui.ssh.disconnected') : failedStatus.code}</p>}
    <details open>
      <summary>{t(language, 'agent.tool.detail.error')}<UiIcon name="chevronDown" size={14} /></summary>
      {failedStatus && <pre tabIndex={0}>{failedStatus.message}</pre>}
      {workspaceError && <pre tabIndex={0}>{workspaceError}</pre>}
    </details>
    {failedStatus?.diagnosticRef && <div className="host-startup-diagnostic__log">
      <span>{t(language, 'host.startup.log')}</span><code>{failedStatus.diagnosticRef}</code>
    </div>}
    {failedStatus && onRetry && <button type="button" className="settings-button" disabled={busy} onClick={onRetry}>{t(language, busy ? 'achbitGui.statusAction.starting' : 'achbitGui.statusAction.retry')}</button>}
  </section>;
}
