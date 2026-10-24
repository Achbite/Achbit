import { useState } from 'react';
import ModalDialog from '../../components/shared/ModalDialog';
import AchbitShellIcon from '../../components/shared/AchbitShellIcon';
import { t, type UiLanguage } from '../../i18n';
import useAppStatusStore from '../../state/appStatusStore';
import { isRemoteHost, remoteHostLabel } from '../../services/hostTarget';
import { connectSsh, getSshTarget, openLocalWindow } from '../../services/runtimeAdapter';
import './sshConnection.css';

export default function SshConnection({ language }: { language: UiLanguage }) {
  const apiStatus = useAppStatusStore(state => state.apiStatus);
  const remote = isRemoteHost();
  const connected = remote && apiStatus === 'connected';
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [destination, setDestination] = useState(''), [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [remoteShell, setRemoteShell] = useState<'posix' | 'windows'>('posix');
  const [cliPath, setCliPath] = useState('achbit-cli'), [userRoot, setUserRoot] = useState('');
  const [identityFile, setIdentityFile] = useState(''), [configFile, setConfigFile] = useState('');
  const text = (key: string) => t(language, `achbitGui.ssh.${key}`);
  const connectionLabel = remote ? `SSH · ${t(language, `achbitGui.status.${apiStatus}`)}` : text('connect');
  const showConnection = () => {
    setOpen(true); setError('');
    void getSshTarget().then(target => {
      if (!target) return;
      const separator = target.destination.lastIndexOf('@');
      setUsername(separator >= 0 ? target.destination.slice(0, separator) : '');
      setDestination(separator >= 0 ? target.destination.slice(separator + 1) : target.destination);
      setPort(target.port?.toString() ?? '');
      setCliPath(target.cliPath); setUserRoot(target.userRoot ?? '');
      setRemoteShell(target.remoteShell ?? 'posix');
      setIdentityFile(target.identityFile ?? ''); setConfigFile(target.configFile ?? '');
    }).catch(reason => setError(String(reason)));
  };
  return <>
    <button type="button" className="reader-icon-button ssh-connection-button" data-connected={connected} title={connectionLabel}
      aria-label={remote ? `${connectionLabel} · ${text('details')}` : connectionLabel} aria-haspopup="dialog" aria-expanded={open} onClick={showConnection}>
      <AchbitShellIcon name="link" />
    </button>
    {open && <ModalDialog className="achbit-gui-text-dialog-backdrop" aria-label={text('connect')} busy={busy} onClose={() => setOpen(false)}>
      <form className="ssh-connection-dialog" onSubmit={event => {
        event.preventDefault(); setBusy(true); setError('');
        void connectSsh({ destination: username.trim() ? `${username.trim()}@${destination.trim()}` : destination.trim(), port: port ? Number(port) : undefined,
          cliPath: cliPath.trim(), userRoot: userRoot.trim() || undefined, remoteShell,
          identityFile: identityFile.trim() || undefined, configFile: configFile.trim() || undefined })
          .then(() => setOpen(false)).catch(reason => setError(String(reason))).finally(() => setBusy(false));
      }}>
        <h2>{isRemoteHost() ? text('details') : text('connect')}</h2>
        {isRemoteHost() && <p>{remoteHostLabel()}</p>}
        <label>{text('destination')}<input autoFocus required value={destination} onChange={e => setDestination(e.target.value)} placeholder="user@host" /></label>
        <label>{text('port')}<input type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} placeholder="22" /></label>
        <label>{text('username')}<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" /></label>
        <label>{text('remoteShell')}<select value={remoteShell} onChange={e => setRemoteShell(e.target.value as 'posix' | 'windows')}>
          <option value="posix">macOS / Linux</option><option value="windows">Windows (OpenSSH)</option>
        </select></label>
        <label>{text('cliPath')}<input required value={cliPath} onChange={e => setCliPath(e.target.value)} /></label>
        <details><summary>{text('advanced')}</summary>
          <label>{text('identityFile')}<input value={identityFile} onChange={e => setIdentityFile(e.target.value)} /></label>
          <label>{text('configFile')}<input value={configFile} onChange={e => setConfigFile(e.target.value)} /></label>
          <label>{text('userRoot')}<input value={userRoot} onChange={e => setUserRoot(e.target.value)} /></label>
        </details>
        <p>{text('authentication')}</p>
        {error && <p role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={() => {
          setBusy(true); void openLocalWindow().then(() => setOpen(false)).catch(reason => setError(String(reason))).finally(() => setBusy(false));
        }}>{text('newLocal')}</button><button type="button" disabled={busy} onClick={() => setOpen(false)}>{text('cancel')}</button><button disabled={busy}>{text('connect')}</button></footer>
      </form>
    </ModalDialog>}
  </>;
}
