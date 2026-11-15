import { useState, type CSSProperties } from 'react';
import type { LlmReasoningEffort } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useUiOwner } from '../../ui-ownership/useUiOwner';

/** Native range over the profile's discrete capabilities. Dragging previews; release commits once. */
export default function ReasoningEffortSlider({ efforts, value, disabled, language, subagentsEnabled = false, onSelect }: {
  efforts: readonly LlmReasoningEffort[]; value: LlmReasoningEffort | null; disabled: boolean;
  language: UiLanguage; subagentsEnabled?: boolean; onSelect(effort: LlmReasoningEffort): Promise<void>;
}) {
  const identity = useUiOwner('composer.reasoningSlider');
  const [draft, setDraft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = value === null ? -1 : efforts.indexOf(value);
  const index = draft ?? selected;
  const label = index < 0 ? t(language, 'settings.reasoningControl.choose') : t(language, `settings.llm.effort.${efforts[index]}`);
  const locked = disabled || saving;
  const energized = subagentsEnabled && selected >= 0 && selected === efforts.length - 1 && index === selected;
  const commit = async (next: number) => {
    if (locked || !efforts[next]) return;
    setSaving(true);
    try { await onSelect(efforts[next]); }
    finally { setSaving(false); setDraft(null); }
  };
  return <div className="achbit-reasoning-slider" data-unset={index < 0 || undefined} data-energized={energized || undefined}
    style={{ '--effort-progress': `${Math.max(0, index) / Math.max(1, efforts.length - 1) * 100}%` } as CSSProperties}>
    <div className="achbit-reasoning-slider__control">
      <div className="achbit-reasoning-slider__bar" aria-hidden="true"><div className="achbit-reasoning-slider__fill" /></div>
      <div className="achbit-reasoning-slider__ticks" aria-hidden="true">{efforts.map((effort, position) => <i key={effort} data-filled={position <= index || undefined} />)}</div>
      {energized && <>
        <span className="achbit-reasoning-slider__particles" aria-hidden="true">
          {Array.from({ length: 8 }, (_, index) => <i key={index} />)}
        </span>
        <span className="achbit-reasoning-slider__edge-particles" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => <i key={index} />)}
        </span>
      </>}
      <input {...identity.part('range')} type="range" min={0} max={efforts.length - 1} step={1}
      value={Math.max(0, index)} disabled={disabled && !saving} aria-disabled={locked} aria-busy={saving} aria-label={t(language, 'settings.llm.reasoningEffort')}
      aria-valuetext={label}
      onChange={event => { if (!locked) setDraft(event.currentTarget.valueAsNumber); }}
      onPointerDown={event => { if (locked) event.preventDefault(); }}
      onPointerUp={event => { if (event.button === 0) void commit(event.currentTarget.valueAsNumber); }}
      onPointerCancel={() => setDraft(null)}
      onKeyDown={event => {
        if (event.key === 'Escape') { setDraft(null); return; }
        if (locked && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
          event.preventDefault(); return;
        }
        if (index < 0 && ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); setDraft(event.key === 'End' ? efforts.length - 1 : 0);
        }
      }}
      onKeyUp={event => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) void commit(event.currentTarget.valueAsNumber);
      }} onBlur={() => setDraft(null)} />
    </div>
  </div>;
}
