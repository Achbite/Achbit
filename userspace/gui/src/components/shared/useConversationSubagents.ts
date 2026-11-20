import { useEffect, useMemo } from 'react';
import { subagentDefaults, useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';

/** A saved Session never borrows another conversation's defaults when its projection is loading. */
export function useConversationSubagents() {
  const sessionId = useLocalAgentStore(state => state.sessionId);
  const selected = useLocalAgentStore(state => state.sessionId
    ? state.projection?.subagentSettings : state.draftSubagentSettings);
  const saving = useLocalAgentStore(state => state.subagentSettingsBusy);
  const submitting = useLocalAgentStore(state => state.submitting);
  const save = useLocalAgentStore(state => state.setSubagentSettings);
  const defaults = useSettingsStore(state => state.effectiveSettings);
  const loadingDefaults = useSettingsStore(state => state.loading);
  const defaultsReady = useSettingsStore(state => state.storePath !== null && !state.loading && !state.errorMessage);
  const settings = useMemo(() => selected ?? (sessionId ? null : subagentDefaults(defaults)),
    [sessionId, selected, defaults]);
  // On cold start the Host may publish the first defaults after the initial draft is opened.
  // Capture once; later global refreshes must not replace this draft.
  useEffect(() => {
    if (!sessionId && !selected && settings && defaultsReady) useLocalAgentStore.setState(current =>
      current.sessionId || current.draftSubagentSettings ? current : { draftSubagentSettings: settings });
  }, [sessionId, selected, settings, defaultsReady]);
  return { settings, save, saving, busy: saving || submitting || !settings || (!sessionId && loadingDefaults) };
}
