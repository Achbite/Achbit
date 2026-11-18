import { connectedModelReasoningEfforts } from '@achbit/protocol';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection, LlmProviderProfile, ModelConnection, LlmReasoningEffort } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ContextUsageControl } from './ContextUsageControl';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useDisplayTheme } from '../../ui-plugins/UiPlugins';
import { UiIcon as AchbitShellIcon, IconButton } from '../../ui-components';
import { useInterfaceReloadGuard } from '../../services/interfaceReload';
import ReasoningEffortSlider from './ReasoningEffortSlider';
import { REASONING_CONTROL_SETTING, reasoningControlStyle, type ReasoningControlStyle } from './reasoningControlStyle';
import { useOpenModelSettings } from '../settings-center/modelSettingsNavigation';
import { useSettingsHelp } from '../settings-center/SettingsHelp';
import { useSettingsStore } from '../../state/settingsStore';
import { focusOpenedPanel, returnFocusTo, useInteractionFocus } from '../shared/interactionFocus';
import { useViewportBounds } from '../shared/useViewportBounds';
import { useDismissibleLayer } from '../shared/useDismissibleLayer';
import { nextEnabledIndex } from '../shared/keyboardNavigation';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  connections?: readonly ModelConnection[];
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  confirmed: boolean;
  requestedPanel?: { kind: 'model' | 'context'; sequence: number } | null;
  onSelect(profileId: string, effort: LlmReasoningEffort | null): Promise<void>;
}

export default function SessionModelSelector({ language, profiles, connections = [], selectedProfileId,
  reasoningEffortOverride, contextUsage, contextCompositions, busy = false, confirmed, requestedPanel, onSelect }: SessionModelSelectorProps) {
  const identity = useUiOwner('composer.modelSelector');
  const [open, setOpen] = useState(false);
  const interaction = useInteractionFocus();
  const [choosingModel, setChoosingModel] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const openModelSettings = useOpenModelSettings();
  useEffect(() => {
    if (!requestedPanel) return;
    setCandidateId(null);
    setContextOpen(requestedPanel.kind === 'context');
    setOpen(requestedPanel.kind === 'model');
    setChoosingModel(requestedPanel.kind === 'model');
  }, [requestedPanel]);
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const defaultsLoading = useSettingsStore(state => state.loading);
  const [subagentBusy, setSubagentBusy] = useState(false);
  useInterfaceReloadGuard(false, t(language, 'settings.subagents.title'), subagentBusy);
  let controlStyle: ReasoningControlStyle | null = null, styleError: string | null = null;
  try { controlStyle = reasoningControlStyle(defaults[REASONING_CONTROL_SETTING]); } catch (cause) { styleError = String(cause); }
  const rootRef = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  useViewportBounds(menuRef, open);
  const menuId = useId(), theme = useDisplayTheme(), chinese = language === 'zh-CN';
  const selected = profiles.find(profile => profile.id === selectedProfileId);
  const effectiveEffort = selected?.thinking === 'disabled' ? null : reasoningEffortOverride ?? selected?.reasoningEffort ?? null;
  const candidate = profiles.find(profile => profile.id === (candidateId ?? selectedProfileId));
  const candidateEffort = candidate?.thinking === 'disabled' ? null
    : candidate?.id === selectedProfileId ? effectiveEffort : candidate?.reasoningEffort ?? null;
  const subagentsEnabled = defaults['agent.subagents.enabled'] === true;
  const subagentLabel = t(language, subagentsEnabled ? 'settings.subagents.disable' : 'settings.subagents.enable');
  const subagentHelp = useSettingsHelp(open && !choosingModel
    ? `${subagentLabel} · ${t(language, 'settings.subagents.activation')}` : undefined, { compact: true });
  const efforts = connectedModelReasoningEfforts(candidate, connections);
  const toggleSubagents = async () => {
    if (subagentBusy || defaultsLoading) return;
    setActionError(null); setSubagentBusy(true);
    try {
      const store = useSettingsStore.getState();
      const saved = await store.patchUserSettingsBatch({ 'agent.subagents.enabled': !store.effectiveSettings['agent.subagents.enabled'] });
      if (!saved) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSubagentBusy(false); }
  };
  const title = (selected?.name ?? selectedProfileId ?? (chinese ? '选择模型' : 'Choose model')) + (selectedProfileId && !selected?.enabled ? ` · ${t(language, selected ? 'agent.profile.disabled' : 'agent.profile.missing')}` : '');
  const effortLabel = selected?.thinking === 'disabled'
    ? (chinese ? '不适用' : 'Not applicable')
    : effectiveEffort ? t(language, `settings.llm.effort.${effectiveEffort}`) : connectedModelReasoningEfforts(selected, connections).length === 0 ? t(language, 'settings.llm.serviceDefault') : (chinese ? '选择强度' : 'Choose level');
  const close = () => { setOpen(false); returnFocusTo(triggerRef.current, interaction, menuRef.current); };
  useEffect(() => {
    const panel = menuRef.current;
    if (!open || !panel) return;
    focusOpenedPanel(panel, panel.querySelector<HTMLElement>(choosingModel
      ? 'button[aria-checked="true"]:not(:disabled),[role="menuitemradio"]:not(:disabled)'
      : '.achbit-session-model__current'), interaction);
  }, [open, choosingModel, interaction]);
  useDismissibleLayer({ open, roots: [rootRef], trigger: triggerRef, onDismiss: () => setOpen(false) });
  const choose = async (effort: LlmReasoningEffort | null, profile = candidate) => {
    if (!profile?.enabled || busy) return;
    setActionError(null);
    try { await onSelect(profile.id, effort); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCandidateId(null); }
  };
  return <div {...identity.part('root')} ref={rootRef} className="achbit-session-model">
    <ContextUsageControl language={language} contextUsage={contextUsage} contextCompositions={contextCompositions}
      contextOpen={contextOpen} setContextOpen={setContextOpen} rootRef={rootRef}
      onToggle={() => { setOpen(false); setContextOpen(value => !value); }} />
    <UiRegion slot="composer.model" input={{ kind: 'composer.model', profiles, connections, selectedProfileId,
      reasoningEffort: effectiveEffort, confirmed, busy, locale: language, theme }}
      debugActions={{ selectModel: { unavailableReason: busy ? 'model_settings_busy' : null } }}
      actions={{ selectModel: async (id, effort) => {
        if (busy) throw new Error('model_settings_busy');
        if (!profiles.some(profile => profile.id === id && profile.enabled)) throw new Error('model_profile_unavailable');
        await onSelect(id, effort);
      } }}>
      <button {...identity.action('trigger', 'click')} ref={triggerRef} type="button" className="achbit-session-model__selector" disabled={busy}
        aria-label={`${title} · ${effortLabel}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => { setContextOpen(false); setCandidateId(null); setChoosingModel(false); setActionError(null); setOpen(value => !value); }}>
        <span>{title}</span><span className="achbit-session-model__selector-effort">{effortLabel}</span><AchbitShellIcon name="chevronDown" />
      </button>
      {open && <div {...identity.part('menu')} id={menuId} ref={menuRef} role="dialog" tabIndex={-1} className="achbit-session-model__menu" data-native-overlay
        aria-label={chinese ? '模型与推理强度' : 'Model and reasoning'} onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (choosingModel) setChoosingModel(false); else close();
          }
          const role = (event.target as HTMLElement).getAttribute('role');
          const groupRole = ['menuitemradio', 'radio'].includes(role ?? '') ? role
            : event.target === event.currentTarget ? (choosingModel ? 'menuitemradio' : 'radio') : null;
          if (groupRole && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(`button[role="${groupRole}"]:not(:disabled)`) ?? [])];
            if (!buttons.length) return;
            event.preventDefault();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = nextEnabledIndex(buttons.map(() => true), index, event.key);
            buttons[next]?.focus();
          }
        }}>
        {choosingModel ? <>
          <button {...identity.action('back', 'click')} type="button" className="achbit-session-model__menu-back" onClick={() => setChoosingModel(false)}>
            <AchbitShellIcon name="chevronLeft" size={16} />{chinese ? '选择模型' : 'Choose model'}
          </button>
          <div className="achbit-session-model__model-list" role="menu" aria-label={chinese ? '模型' : 'Models'}>
          {connections.filter(connection => profiles.some(profile => profile.enabled && profile.connectionId === connection.id)).map(connection => <React.Fragment key={connection.id}>
            <div className="achbit-session-model__menu-title">{connection.name}</div>
            {profiles.filter(profile => profile.enabled && profile.connectionId === connection.id).map(profile => <button
              {...identity.action('select-profile', 'click', { profileId: profile.id })}
              key={profile.id} type="button" role="menuitemradio" aria-checked={candidate?.id === profile.id} aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                setCandidateId(profile.id);
                setChoosingModel(false);
                const fixedEffort = connectedModelReasoningEfforts(profile, connections).length === 0;
                if (profile.id !== selectedProfileId && (profile.thinking === 'disabled' || fixedEffort || profile.reasoningEffort)) {
                  void choose(profile.thinking === 'disabled' || fixedEffort ? null : profile.reasoningEffort!, profile);
                }
              }}><span>{profile.name}</span>{candidate?.id === profile.id && <AchbitShellIcon name="check" />}</button>)}
          </React.Fragment>)}
          </div>
        </> : <>
          <div className="achbit-session-model__heading">
            <IconButton {...identity.action('subagents', 'click')} {...subagentHelp.helpEvents} icon="subagents" className="achbit-session-model__subagents" aria-label={subagentLabel}
              title="" aria-describedby={subagentHelp.helpId} aria-pressed={subagentsEnabled}
              disabled={subagentBusy || defaultsLoading} onClick={() => void toggleSubagents()} />
            {subagentHelp.help}
            <button {...identity.action('models', 'click')} type="button" className="achbit-session-model__current" aria-haspopup="menu" onClick={() => setChoosingModel(true)}>
              <strong>{candidate?.thinking === 'disabled' ? t(language, 'agent.profile.thinkingDisabled')
                : candidateEffort ? t(language, `settings.llm.effort.${candidateEffort}`) : connectedModelReasoningEfforts(candidate, connections).length === 0 ? t(language, 'settings.llm.serviceDefault') : (chinese ? '选择强度' : 'Choose level')}</strong>
              <span><b>{candidate?.name ?? title}</b><AchbitShellIcon name="chevronRight" size={14} /></span>
            </button>
            <IconButton {...identity.action('settings', 'click')} icon="settings" className="achbit-session-model__settings"
              aria-label={t(language, 'settings.llm.openOverview')} disabled={!openModelSettings}
              onClick={() => {
                if (!openModelSettings) return;
                close();
                openModelSettings({ kind: 'overview' });
              }} />
          </div>
          {candidate?.thinking !== 'disabled' && efforts.length > 0 && controlStyle === 'slider' && <ReasoningEffortSlider
            key={candidate?.id} efforts={efforts} value={candidateEffort} disabled={busy || !candidate?.enabled}
            language={language} subagentsEnabled={subagentsEnabled && confirmed && candidate?.id === selectedProfileId}
            onSelect={effort => choose(effort)} />}
          {candidate?.thinking !== 'disabled' && efforts.length > 0 && controlStyle === 'segments' && <div className="achbit-session-model__efforts" role="radiogroup"
            aria-label={t(language, 'settings.llm.reasoningEffort')}>
            {efforts.map(effort => <button
              {...identity.action('select-effort', 'click', { profileId: candidate?.id, effort })}
              key={effort} type="button" role="radio" aria-checked={confirmed && candidate?.id === selectedProfileId && effectiveEffort === effort}
              disabled={!candidate?.enabled} aria-disabled={busy || !candidate?.enabled} onClick={() => void choose(effort)}>{t(language, `settings.llm.effort.${effort}`)}</button>)}
          </div>}
        </>}
        {(actionError || styleError) && <p className="achbit-session-model__error" role="alert">{actionError || styleError}</p>}
      </div>}
    </UiRegion>
  </div>;
}
