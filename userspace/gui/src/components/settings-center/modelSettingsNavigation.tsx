import { createContext, useContext } from 'react';

/** Internal GUI routing; neither changes the selected model nor submits a Session command. */
export type ModelSettingsTarget = { kind: 'overview' }
  | { kind: 'model'; profileId: string; connectionId: string };
export const ModelSettingsNavigation = createContext<((target: ModelSettingsTarget) => void) | null>(null);
export const useOpenModelSettings = () => useContext(ModelSettingsNavigation);
