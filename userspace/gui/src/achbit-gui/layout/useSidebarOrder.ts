import { useMemo, useRef, useState } from 'react';
import type { ConversationProject, ConversationSessionSummary } from '@achbit/protocol';
import { useSettingsStore } from '../../state/settingsStore';
import {
  SIDEBAR_ORDER_SETTING, moveSidebarItem, orderSidebarItems, readSidebarOrder,
  type SidebarDragItem, type SidebarDropEdge, type SidebarOrder,
} from './sidebarOrder';

export function useSidebarOrder(projects: ConversationProject[], sessions: ConversationSessionSummary[]) {
  const value = useSettingsStore((state) => state.effectiveSettings[SIDEBAR_ORDER_SETTING]);
  const settingsLoading = useSettingsStore((state) => state.loading);
  const saved = useMemo(() => {
    try {
      return { order: readSidebarOrder(value), error: null };
    } catch (error) {
      return { order: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [value]);
  const [pending, setPending] = useState<SidebarOrder | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);
  const order = pending ?? saved.order;

  const move = async (source: SidebarDragItem, target: SidebarDragItem, edge: SidebarDropEdge) => {
    if (saving.current || settingsLoading || !saved.order) return;
    const next = moveSidebarItem(saved.order, projects, sessions, source, target, edge);
    if (!next) return;
    saving.current = true;
    setPending(next);
    setSaveError(null);
    try {
      await useSettingsStore.getState().patchUserSetting(SIDEBAR_ORDER_SETTING, JSON.stringify(next));
      setSaveError(useSettingsStore.getState().errorMessage);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      saving.current = false;
      setPending(null);
    }
  };

  return {
    projects: useMemo(() => order ? orderSidebarItems(projects, order.projects) : projects, [projects, order]),
    sessions: useMemo(() => order ? orderSidebarItems(sessions, order.sessions) : sessions, [sessions, order]),
    disabled: settingsLoading || pending !== null || saved.order === null,
    error: saveError ?? saved.error,
    move,
  };
}
