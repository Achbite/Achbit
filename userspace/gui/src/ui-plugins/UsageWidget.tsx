import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationReaderLayout } from '../components/local-agent/LocalAgentPanel';
import { useLocalAgentStore } from '../state/localAgentStore';
import { useSettingsStore } from '../state/settingsStore';
import { UiPluginSlotView, useDisplayTheme } from './UiPlugins';
import { UsageWidgetSettings } from './UsageWidgetSettings';
import { normalizeUiLanguage } from '../i18n';
import { usageWidgetLabels } from './usageWidgetLabels';
import { useUsageCostDisplay } from './usageCost';
import type { UiPluginInput } from './types';

/** Every provider response advances these counters, so the widget reconciles usage after each one. */
export function usageRevision(history: ReadonlyArray<{ providerCallCount: number; inputTokens: number; outputTokens: number }> | undefined) {
  return (history ?? []).reduce((total, run) => total + run.providerCallCount + run.inputTokens + run.outputTokens, 0);
}

export function UsageWidget({ readerLayout, hidden }: {
  readerLayout: ConversationReaderLayout;
  hidden: boolean;
}) {
  const enabled = useSettingsStore(state => state.effectiveSettings['gui.usageWidget.enabled']) !== false;
  const visibility = useSettingsStore(state => state.effectiveSettings['gui.usageWidget.visibility']);
  const locale = normalizeUiLanguage(useSettingsStore(state => state.effectiveSettings['workbench.language']));
  const profile = useLocalAgentStore(state => state.profiles.find(profile => profile.id === state.selectedProfileId));
  const connection = useLocalAgentStore(state => state.connections.find(connection => connection.id === profile?.connectionId)) ?? null;
  const revision = useLocalAgentStore(state => usageRevision(state.projection?.tokenUsageHistory));
  const patch = useSettingsStore(state => state.patchUserSetting);
  const [expanded, setExpanded] = useState(false);
  const [readerVisibility, setReaderVisibility] = useState<'summary' | 'collapsed'>('collapsed');
  const boundary = useRef<HTMLDivElement>(null);
  const theme = useDisplayTheme();
  const costDisplay = useUsageCostDisplay();
  const [settingsOpen, setSettingsOpen] = useState(false);
  useLayoutEffect(() => {
    setReaderVisibility('collapsed');
    setExpanded(false);
  }, [readerLayout.visible]);
  useLayoutEffect(() => {
    const element = boundary.current;
    const page = element?.parentElement;
    if (!element || !page) return;
    const target = readerLayout.visible ? readerLayout.conversationBounds : page;
    if (!target) return;
    const align = () => {
      const pageRect = page.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      Object.assign(element.style, {
        left: `${rect.left - pageRect.left}px`, top: `${rect.top - pageRect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
      });
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(page);
    if (target !== page) observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, readerLayout.visible, readerLayout.conversationBounds]);
  const concealed = hidden || (readerLayout.visible && readerLayout.expanded);
  const displayVisibility = concealed || visibility === 'hidden' ? 'hidden'
    : readerLayout.visible ? readerVisibility : visibility === 'collapsed' ? 'collapsed' : 'summary';
  // Conversation text streams independently of usage. Do not redraw the plugin for every token.
  const input = useMemo<UiPluginInput>(() => ({ kind: 'usage.widget', connection, modelId: profile?.model ?? null,
    visibility: displayVisibility, expanded, revision, locale, theme,
    costDisplay: { currency: costDisplay.currency, usdRate: costDisplay.usdRate }, labels: usageWidgetLabels(locale) }),
  [connection, profile?.model, displayVisibility, expanded, revision, locale, theme, costDisplay.currency, costDisplay.usdRate]);
  if (!enabled) return null;
  return <div ref={boundary} className="achbit-gui-usage-boundary" hidden={concealed}>
    <UiPluginSlotView slot="usage.widget" input={input}
      actions={{ setExpanded, setUsageVisibility: value => {
        if (value !== 'summary') setExpanded(false);
        // Opening Reader is a temporary disclosure change, not a saved preference.
        if (readerLayout.visible && value !== 'hidden') setReaderVisibility(value);
        else void patch('gui.usageWidget.visibility', value);
      }, openUsageSettings: () => setSettingsOpen(true) }}>{null}</UiPluginSlotView>
    {settingsOpen && <UsageWidgetSettings onClose={() => setSettingsOpen(false)} />}
  </div>;
}
