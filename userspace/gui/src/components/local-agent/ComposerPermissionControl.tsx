import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { permissionSettings } from '@deepcode/protocol';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { AgentComposer } from './useAgentComposer';

type PermissionRow = { key: string; label: string; values: readonly (readonly [string, string])[] };
const askAllowDeny = [['ask', 'agent.permission.ask'], ['allow', 'agent.permission.allow'], ['deny', 'agent.permission.deny']] as const;
const rows: PermissionRow[] = [
  { key: 'agent.permissions.workspaceMutation', label: 'agent.permission.workspaceMutation', values: [['plan', 'agent.permission.workspaceMutationPlan'], ['review', 'agent.permission.workspaceMutationReview'], ['allow', 'agent.permission.workspaceMutationAllow']] },
  { key: 'agent.permissions.engineeringDecisions', label: 'agent.permission.engineeringDecisions', values: [['ask', 'agent.permission.ask'], ['delegate', 'agent.permission.delegate']] },
  { key: 'agent.permissions.shell', label: 'agent.permission.shell', values: [['ask', 'agent.permission.ask'], ['review', 'agent.permission.review'], ['allow', 'agent.permission.allow']] },
  { key: 'agent.permissions.shellAccess', label: 'agent.permission.shellAccess', values: [['workspace', 'agent.permission.workspaceScope'], ['full', 'agent.permission.fullScope']] },
  { key: 'agent.permissions.networkRead', label: 'agent.permission.networkRead', values: askAllowDeny },
  { key: 'agent.permissions.external', label: 'agent.permission.externalEffects', values: askAllowDeny },
];

export function ComposerPermissionControl({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const { permissionControlRef, permissionMenuRef, permissionMenuOpen, setPermissionMenuOpen, setAttachmentMenuOpen } = composer;
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const patchDefault = useSettingsStore(state => state.patchUserSetting);
  const settingsError = useSettingsStore(state => state.errorMessage);
  const sessionId = useLocalAgentStore(state => state.sessionId);
  const projection = useLocalAgentStore(state => state.projection);
  const setPermissions = useLocalAgentStore(state => state.setPermissions);
  const revoke = useLocalAgentStore(state => state.revokeAuthorization);
  const taskError = useLocalAgentStore(state => state.error);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<PermissionRow | 'grants' | null>(null);
  const detail = typeof page === 'object' ? page : null;
  const grants = projection?.shellAuthorizations ?? [];
  const heading = page === 'grants' ? 'agent.permission.runGrants' : detail?.label ?? 'settings.nav.permissions';
  const [position, setPosition] = useState<React.CSSProperties>({});
  const settings = projection?.effectivePermissions ?? permissionSettings({ ...defaults, ...projection?.permissionOverrides });
  const summary = `${t(language, 'agent.permission.shell')}: ${t(language, `agent.permission.${settings['agent.permissions.shell']}`)}`;
  useLayoutEffect(() => {
    if (!permissionMenuOpen) { setPage(null); return; }
    const place = () => {
      const anchor = permissionControlRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(380, window.innerWidth - 24);
      const above = anchor.top >= window.innerHeight - anchor.bottom;
      setPosition({ width, left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)),
        ...(above ? { bottom: window.innerHeight - anchor.top + 8, top: 'auto', maxHeight: Math.max(80, anchor.top - 20) }
          : { top: anchor.bottom + 8, bottom: 'auto', maxHeight: Math.max(80, window.innerHeight - anchor.bottom - 20) }) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [permissionMenuOpen, permissionControlRef]);
  useLayoutEffect(() => {
    if (permissionMenuOpen) permissionMenuRef.current?.querySelector<HTMLElement>(detail ? '[aria-checked="true"]' : 'button')?.focus({ preventScroll: true });
  }, [permissionMenuOpen, page, permissionMenuRef]);
  const close = () => { setPermissionMenuOpen(false); permissionControlRef.current?.querySelector('button')?.focus(); };
  const change = async (key: string, value: string) => {
    setBusy(true);
    try {
      if (sessionId) await setPermissions({ [key]: value });
      // Keep the current Session control and the shared preference in sync.
      const activation = await patchDefault(key, value);
      if (activation !== null) setPage(null);
    }
    catch { /* Stores expose the original command error. */ }
    finally { setBusy(false); }
  };
  return <div ref={permissionControlRef} className="local-agent__permission-control">
    <button type="button" className="local-agent__permission-summary" aria-label={t(language, 'settings.nav.permissions')}
      title={summary} aria-expanded={permissionMenuOpen} onClick={() => { setPermissionMenuOpen(open => !open); setAttachmentMenuOpen(false); }}>
      <DeepCodeShellIcon name="shield" /><span>{summary}</span>
    </button>
    {permissionMenuOpen && createPortal(<div ref={permissionMenuRef} className="local-agent__permission-menu" style={position}
      data-native-overlay role="dialog" aria-label={t(language, heading)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (page) setPage(null); else close(); }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"], .local-agent__permission-row')];
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          if (options.length) { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
        }
      }}>
      <header className="local-agent__permission-heading">
        {page && <button type="button" aria-label={t(language, 'agent.permission.back')} onClick={() => setPage(null)}><DeepCodeShellIcon name="chevronLeft" /></button>}
        <strong>{t(language, heading)}</strong>
        <button type="button" aria-label={t(language, 'agent.permission.close')} onClick={close}><DeepCodeShellIcon name="close" /></button>
      </header>
      {page === 'grants' ? <div className="local-agent__permission-grants">
        {grants.map(grant => <div key={grant.authorityId}>
          <span title={grant.summary}>{grant.scope === 'runHostShell' || grant.scope === 'sessionHostShell' ? t(language, `agent.permission.scope.${grant.scope}`)
            : grant.scope === 'runFiles' || grant.scope === 'sessionFiles' ? <>
              <b>{t(language, grant.scope === 'runFiles' ? 'agent.permission.file.run' : 'agent.permission.file.session')}</b>
              {Object.entries((grant.context.fileAccess ?? {}) as Record<string, unknown>).map(([access, paths]) => Array.isArray(paths) && paths.length > 0 && <span key={access}>
                {t(language, `agent.permission.file.${access}`)}{paths.map(path => <code key={String(path)} title={String(path)}>{String(path)}</code>)}
              </span>)}
            </> : String(grant.context.command)}</span>
          <button type="button" disabled={busy} onClick={async () => { setBusy(true); try { await revoke(grant.authorityId); } catch {} finally { setBusy(false); } }}>{t(language, 'agent.permission.revoke')}</button>
        </div>)}
      </div> : detail ? <div role="radiogroup" aria-label={t(language, detail.label)}>
        {detail.values.map(([value, label]) => <button key={value} type="button" className="local-agent__permission-option" role="radio"
          aria-checked={settings[detail.key] === value} disabled={busy} onClick={() => void change(detail.key, value)}>
          <span className="local-agent__permission-radio" aria-hidden="true" /><span>{t(language, label)}
            {detail.key === 'agent.permissions.shell' && value === 'review' && <small>{t(language, 'agent.permission.reviewHelp')}</small>}
            {detail.key === 'agent.permissions.shellAccess' && value === 'full' && <small>{t(language, 'agent.permission.fullHelp')}</small>}
          </span>
        </button>)}
      </div> : <>
        <div className="local-agent__permission-invariant"><span>{t(language, 'agent.permission.workspaceRead')}</span><strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong></div>
        {rows.map(row => <button key={row.key} type="button" className="local-agent__permission-row" disabled={busy} onClick={() => setPage(row)}>
          <span>{t(language, row.label)}</span><span>{t(language, row.values.find(([value]) => value === settings[row.key])![1])}<DeepCodeShellIcon name="chevronRight" /></span>
        </button>)}
        {grants.length > 0 && <button type="button" className="local-agent__permission-row" onClick={() => setPage('grants')}>
          <span>{t(language, 'agent.permission.runGrants')}</span><span>{grants.length}<DeepCodeShellIcon name="chevronRight" /></span>
        </button>}
      </>}
      {(taskError || settingsError) && <div className="local-agent__error" role="alert">{taskError || settingsError}</div>}
    </div>, document.body)}
  </div>;
}
