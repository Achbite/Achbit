import { useSyncExternalStore } from 'react';
import type { HistoryDetail } from '../../services/desktopHistory';

const empty = {};
const emptySnapshot = () => empty;
const inactive = () => () => {};
export function useHistoryDetail<T>(detail?: HistoryDetail<T>): { value?: T; error?: string } {
  const snapshot = detail?.snapshot ?? emptySnapshot;
  return useSyncExternalStore(detail?.subscribe ?? inactive, snapshot, snapshot);
}
