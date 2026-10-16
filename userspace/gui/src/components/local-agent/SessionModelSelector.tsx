import { modelReasoningEfforts } from '@deepcode/protocol';
import React, { useEffect, useId, useRef, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection, LlmProviderProfile, ModelConnection, LlmReasoningEffort } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ContextUsageControl } from './ContextUsageControl';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { useDisplayTheme } from '../../ui-plugins/UiPlugins';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import SubagentQuickSettings from './SubagentQuickSettings';
import { useSettingsStore } from '../../state/settingsStore';

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
  const [open, setOpen] = useState(false);
  const [choosingModel, setChoosingModel] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  useEffect(() => {
    if (!requestedPanel) return;
    setCandidateId(null); setSubagentsOpen(false);
    setContextOpen(requestedPanel.kind === 'context');
    setOpen(requestedPanel.kind === 'model');
    setChoosingModel(requestedPanel.kind === 'model');
  }, [requestedPanel]);
  const settings = useSettingsStore(state => state.effectiveSettings);
  const rootRef = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId(), theme = useDisplayTheme(), chinese = language === 'zh-CN';
  const selected = profiles.find(profile => profile.id === selectedProfileId);
  const effectiveEffort = selected?.thinking === 'disabled' ? null : reasoningEffortOverride ?? selected?.reasoningEffort ?? null;
  const candidate = profiles.find(profile => profile.id === (candidateId ?? selectedProfileId));
  const candidateEffort = candidate?.thinking === 'disabled' ? null
    : candidate?.id === selectedProfileId ? effectiveEffort : candidate?.reasoningEffort ?? null;
  const subagentsEnabled = settings['agent.subagents.enabled'] === true;
  const subagentLabel = t(language, 'settings.subagents.configure');
  const title = (selected?.name ?? selectedProfileId ?? (chinese ? '选择模型' : 'Choose model')) + (selectedProfileId && !selected?.enabled ? ` · ${t(language, selected ? 'agent.profile.disabled' : 'agent.profile.missing')}` : '');
  const effortLabel = selected?.thinking === 'disabled'
    ? (chinese ? '不适用' : 'Not applicable')
    : effectiveEffort ? t(language, `settings.llm.effort.${effectiveEffort}`) : (chinese ? '选择强度' : 'Choose level');
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(subagentsOpen ? 'input[role="switch"]' : choosingModel
      ? 'button[aria-checked="true"]:not(:disabled),[role="menuitemradio"]:not(:disabled)'
      : '.deepcode-session-model__current')?.focus({ preventScroll: true });
  }, [open, choosingModel, subagentsOpen]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = async (effort: LlmReasoningEffort | null, profile = candidate) => {
    if (!profile?.enabled || busy) return;
    try { await onSelect(profile.id, effort); }
    finally { setCandidateId(null); }
  };
  return <div ref={rootRef} className="deepcode-session-model" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <ContextUsageControl language={language} contextUsage={contextUsage} contextCompositions={contextCompositions}
      contextOpen={contextOpen} setContextOpen={setContextOpen} rootRef={rootRef}
      onToggle={() => { setOpen(false); setContextOpen(value => !value); }} />
    <UiRegion slot="composer.model" input={{ kind: 'composer.model', profiles, connections, selectedProfileId,
      reasoningEffort: effectiveEffort, confirmed, busy, locale: language, theme }} actions={{ selectModel: onSelect }}>
      <button ref={triggerRef} type="button" className="deepcode-session-model__selector" disabled={busy}
        aria-label={`${title} · ${effortLabel}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => { setContextOpen(false); setCandidateId(null); setChoosingModel(false); setSubagentsOpen(false); setOpen(value => !value); }}>
        <span>{title}</span><span className="deepcode-session-model__selector-effort">{effortLabel}</span><DeepCodeShellIcon name="chevronDown" />
      </button>
      {open && <div id={menuId} ref={menuRef} role="dialog" className="deepcode-session-model__menu" data-native-overlay
        aria-label={chinese ? '模型与推理强度' : 'Model and reasoning'} onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            if (choosingModel) setChoosingModel(false); else if (subagentsOpen) setSubagentsOpen(false); else close();
          }
          const role = (event.target as HTMLElement).getAttribute('role');
          if (['menuitemradio', 'radio'].includes(role ?? '') && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(`button[role="${role}"]:not(:disabled)`) ?? [])];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }}>
        {subagentsOpen ? <>
          <button type="button" className="deepcode-session-model__menu-back" onClick={() => setSubagentsOpen(false)}>
            <DeepCodeShellIcon name="chevronLeft" size={16} />{t(language, 'settings.subagents.title')}
          </button>
          <SubagentQuickSettings profiles={profiles} connections={connections} mainProfileId={selectedProfileId} language={language} />
        </> : choosingModel ? <>
          <button type="button" className="deepcode-session-model__menu-back" onClick={() => setChoosingModel(false)}>
            <DeepCodeShellIcon name="chevronLeft" size={16} />{chinese ? '选择模型' : 'Choose model'}
          </button>
          <div className="deepcode-session-model__model-list" role="menu" aria-label={chinese ? '模型' : 'Models'}>
          {connections.filter(connection => profiles.some(profile => profile.enabled && profile.connectionId === connection.id)).map(connection => <React.Fragment key={connection.id}>
            <div className="deepcode-session-model__menu-title">{connection.name}</div>
            {profiles.filter(profile => profile.enabled && profile.connectionId === connection.id).map(profile => <button
              key={profile.id} type="button" role="menuitemradio" aria-checked={candidate?.id === profile.id} aria-disabled={busy}
              onClick={() => {
                if (busy) return;
                setCandidateId(profile.id);
                setChoosingModel(false);
                if (profile.id !== selectedProfileId && (profile.thinking === 'disabled' || profile.reasoningEffort)) {
                  void choose(profile.thinking === 'disabled' ? null : profile.reasoningEffort!, profile);
                }
              }}><span>{profile.name}</span>{candidate?.id === profile.id && <DeepCodeShellIcon name="check" />}</button>)}
          </React.Fragment>)}
          </div>
        </> : <>
          <div className="deepcode-session-model__heading">
            <button type="button" className="deepcode-session-model__subagents" aria-label={subagentLabel}
              title={subagentLabel} aria-pressed={subagentsEnabled}
              onClick={() => setSubagentsOpen(true)}><DeepCodeShellIcon name="subagents" size={19} /></button>
            <button type="button" className="deepcode-session-model__current" aria-haspopup="menu" onClick={() => setChoosingModel(true)}>
              <strong>{candidate?.thinking === 'disabled' ? t(language, 'agent.profile.thinkingDisabled')
                : candidateEffort ? t(language, `settings.llm.effort.${candidateEffort}`) : (chinese ? '选择强度' : 'Choose level')}</strong>
              <span>{candidate?.name ?? title}<DeepCodeShellIcon name="chevronRight" size={14} /></span>
            </button>
          </div>
          {candidate?.thinking !== 'disabled' && <div className="deepcode-session-model__efforts" role="radiogroup"
            aria-label={t(language, 'settings.llm.reasoningEffort')}>
            {modelReasoningEfforts(candidate).map(effort => <button
              key={effort} type="button" role="radio" aria-checked={confirmed && candidate?.id === selectedProfileId && effectiveEffort === effort}
              disabled={!candidate?.enabled} aria-disabled={busy || !candidate?.enabled} onClick={() => void choose(effort)}>{t(language, `settings.llm.effort.${effort}`)}</button>)}
          </div>}
        </>}
      </div>}
    </UiRegion>
  </div>;
}
