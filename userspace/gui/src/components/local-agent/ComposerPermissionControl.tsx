import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { permissionSettings } from '@achbit/protocol';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { CloseButton, IconButton, NativeSelect, PanelHeader } from '../../ui-components';
import { settingText, t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { AgentComposer } from './useAgentComposer';
import { returnFocusTo, useInteractionFocus } from '../shared/interactionFocus';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { currentPermissionPreset, PERMISSION_PRESETS } from './permissionPresets';

type PermissionRow = { key: string; label: string; values: readonly (readonly [string, string])[] };
const approvalModes = [['ask', 'agent.permission.ask'], ['review', 'agent.permission.review'], ['allow', 'agent.permission.allow']] as const;
type PermissionGroup = 'workflow' | 'access';
const groups: Record<PermissionGroup, PermissionRow[]> = {
  workflow: [
    { key: 'agent.permissions.workspaceMutation', label: 'agent.permission.workspaceMutation', values: [['plan', 'agent.permission.workspaceMutationPlan'], ['review', 'agent.permission.workspaceMutationReview'], ['allow', 'agent.permission.workspaceMutationAllow']] },
    { key: 'agent.permissions.engineeringDecisions', label: 'agent.permission.engineeringDecisions', values: [['ask', 'agent.permission.ask'], ['delegate', 'agent.permission.delegate']] },
  ],
  access: [
    { key: 'agent.permissions.shell', label: 'agent.permission.shell', values: approvalModes },
    { key: 'agent.permissions.shellAccess', label: 'agent.permission.shellAccess', values: [['workspace', 'agent.permission.workspaceScope'], ['full', 'agent.permission.fullScope']] },
    { key: 'agent.permissions.networkRead', label: 'agent.permission.networkRead', values: approvalModes },
    { key: 'agent.permissions.external', label: 'agent.permission.externalEffects', values: approvalModes },
  ],
};

export function ComposerPermissionControl({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const interaction = useInteractionFocus();
  const { permissionControlRef, permissionMenuRef, permissionMenuOpen, setPermissionMenuOpen, setAttachmentMenuOpen } = composer;
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const patchDefaults = useSettingsStore(state => state.patchUserSettingsBatch);
  const settingsError = useSettingsStore(state => state.errorMessage);
  const sessionId = useLocalAgentStore(state => state.sessionId);
  const identity = useUiOwner('composer.permissions', undefined, { sessionId });
  const projection = useLocalAgentStore(state => state.projection);
  const setPermissions = useLocalAgentStore(state => state.setPermissions);
  const revoke = useLocalAgentStore(state => state.revokeAuthorization);
  const taskError = useLocalAgentStore(state => state.error);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<'details' | 'grants' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const grants = projection?.shellAuthorizations ?? [];
  const back = () => setPage(null);
  const heading = page === 'grants' ? 'agent.permission.runGrants'
    : page === 'details' ? 'agent.permission.details' : 'agent.permission.menuTitle';
  const [position, setPosition] = useState<React.CSSProperties>({});
  const settings = projection?.effectivePermissions ?? permissionSettings({ ...defaults, ...projection?.permissionOverrides });
  const preset = currentPermissionPreset(settings);
  const summary = t(language, preset?.label ?? 'agent.permission.custom');
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
    if (!permissionMenuOpen) return;
    const menu = permissionMenuRef.current;
    const selected = menu?.querySelector<HTMLElement>(page === 'details' ? 'select' : '[aria-checked="true"]');
    (selected ?? menu?.querySelector<HTMLElement>('[role="radio"], button'))?.focus({ preventScroll: true });
  }, [permissionMenuOpen, page, permissionMenuRef]);
  const close = () => { setPermissionMenuOpen(false); returnFocusTo(permissionControlRef.current?.querySelector('button'), interaction, permissionMenuRef.current); };
  const change = async (patches: Record<string, string>) => {
    setBusy(true); setActionError(null);
    try {
      if (sessionId) await setPermissions(patches);
      // Publish a preset as one patch to each existing owner, never four independent updates.
      await patchDefaults(patches);
    }
    catch (reason) { setActionError(String(reason)); }
    finally { setBusy(false); }
  };
  if (!sessionId && defaults['agent.minimalMode'] === true) {
    const mode = settingText(language, 'agent.minimalMode');
    return <span className="local-agent__permission-summary" title={mode?.description}>
      <AchbitShellIcon name="shield" /><span>{mode?.label}</span>
    </span>;
  }
  return <div ref={permissionControlRef} className="local-agent__permission-control">
    <button {...identity.action('toggle', 'click')} type="button" className="local-agent__permission-summary" aria-label={t(language, 'agent.permission.menuTitle')}
      title={summary} aria-expanded={permissionMenuOpen} onClick={() => { setPermissionMenuOpen(open => !open); setAttachmentMenuOpen(false); }}>
      <AchbitShellIcon name="shield" /><span>{summary}</span>
    </button>
    {permissionMenuOpen && createPortal(<div ref={permissionMenuRef} className="local-agent__permission-menu" style={position}
      data-native-overlay role="dialog" aria-label={t(language, heading)} aria-busy={busy}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (page) back(); else close(); }
        if (!(event.target instanceof HTMLSelectElement) && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled), button.local-agent__permission-row:not(:disabled)')];
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          if (options.length) { event.preventDefault(); options[(index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length].focus(); }
        }
      }}>
      <PanelHeader className="local-agent__permission-heading">
        {page && <IconButton {...identity.action('back', 'click')} icon="chevronLeft" aria-label={t(language, 'agent.permission.back')} onClick={back} />}
        <strong>{t(language, heading)}</strong>
        <CloseButton {...identity.action('close', 'click')} aria-label={t(language, 'agent.permission.close')} onClick={close} />
      </PanelHeader>
      {page === 'grants' ? <div className="local-agent__permission-grants">
        {grants.map(grant => <div key={grant.authorityId}>
          <span title={grant.summary}>{grant.scope === 'runHostShell' || grant.scope === 'sessionHostShell' ? t(language, `agent.permission.scope.${grant.scope}`)
            : grant.scope === 'runFiles' || grant.scope === 'sessionFiles' ? <>
              <b>{t(language, grant.scope === 'runFiles' ? 'agent.permission.file.run' : 'agent.permission.file.session')}</b>
              {Object.entries((grant.context.fileAccess ?? {}) as Record<string, unknown>).map(([access, paths]) => Array.isArray(paths) && paths.length > 0 && <span key={access}>
                {t(language, `agent.permission.file.${access}`)}{paths.map(path => <code key={String(path)} title={String(path)}>{String(path)}</code>)}
              </span>)}
            </> : String(grant.context.command)}</span>
          <button {...identity.action('revoke', 'click', { authorityId: grant.authorityId })} type="button" disabled={busy} onClick={async () => { setBusy(true); try { await revoke(grant.authorityId); } catch {} finally { setBusy(false); } }}>{t(language, 'agent.permission.revoke')}</button>
        </div>)}
      </div> : page === 'details' ? <>
        {(['access', 'workflow'] as const).map(group => <section key={group} aria-label={t(language, `agent.permission.${group}`)}>
          <div className="local-agent__permission-group"><strong>{t(language, `agent.permission.${group}`)}</strong></div>
          {group === 'access' && <div className="local-agent__permission-invariant"><span>{t(language, 'agent.permission.workspaceRead')}</span><strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong></div>}
          {groups[group].map(row => <label key={row.key} className="local-agent__permission-row">
            <span>{t(language, row.label)}</span>
            <NativeSelect {...identity.action('select', 'select', { setting: row.key })} className="settings-field__select"
              aria-label={t(language, row.label)} title={settingText(language, row.key)?.description}
              value={String(settings[row.key])} disabled={busy} onChange={event => void change({ [row.key]: event.target.value })}>
              {!row.values.some(([value]) => value === settings[row.key]) && <option value={String(settings[row.key])} disabled>
                {settingText(language, row.key)?.options?.[String(settings[row.key])] ?? String(settings[row.key])}
              </option>}
              {row.values.map(([value, label]) => <option key={value} value={value}>{t(language, label)}</option>)}
            </NativeSelect>
          </label>)}
        </section>)}
      </> : <>
        <div role="radiogroup" aria-label={t(language, 'agent.permission.preset')}>
          {PERMISSION_PRESETS.map(option => <button {...identity.action('preset', 'click', { value: option.id })} key={option.id} type="button"
            className="local-agent__permission-option" role="radio" aria-checked={preset?.id === option.id} disabled={busy}
            onClick={() => void change(option.patches)}>
            <span className="local-agent__permission-radio" aria-hidden="true" /><span>{t(language, option.label)}<small>{t(language, option.help)}</small></span>
          </button>)}
        </div>
        <button {...identity.action('details', 'click')} type="button" className="local-agent__permission-row" onClick={() => setPage('details')}>
          <span>{t(language, 'agent.permission.details')}</span><AchbitShellIcon name="chevronRight" />
        </button>
        {grants.length > 0 && <button {...identity.action('grants', 'click')} type="button" className="local-agent__permission-row" onClick={() => setPage('grants')}>
          <span>{t(language, 'agent.permission.runGrants')}</span><span>{grants.length}<AchbitShellIcon name="chevronRight" /></span>
        </button>}
      </>}
      {(actionError || taskError || settingsError) && <div className="local-agent__error" role="alert">{actionError || taskError || settingsError}</div>}
    </div>, document.body)}
  </div>;
}
