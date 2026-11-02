import { useId, useLayoutEffect, useRef } from 'react';
import type { ComponentSource } from '../debug/registry';

/** Passive identity only. No wrapper, plugin slot, business state or Debug build branch. */
type UiTarget = Readonly<Record<string, string | null | undefined>>;
const targetValues = (value: UiTarget): Record<string, string> => Object.fromEntries(
  Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);

export function useUiOwner(ownerId: string, source?: Omit<ComponentSource, 'ownerId'>, target: UiTarget = {}) {
  const instanceId = `ui${useId()}`;
  const latest = useRef(source);
  latest.current = source;
  const targetRef = useRef(target);
  targetRef.current = target;
  useLayoutEffect(() => {
    return window.__ACHBIT_DEBUG_UI__?.register(instanceId, {
      ownerId,
      slot: source?.slot ?? null,
      pluginId: source?.pluginId ?? null,
      read: () => latest.current?.read() ?? null,
      actions: () => latest.current?.actions() ?? {},
      actionStates: () => latest.current?.actionStates?.() ?? {},
      target: () => latest.current?.target?.() ?? targetValues(targetRef.current),
    });
  }, [instanceId, ownerId, source?.slot, source?.pluginId]);
  const part = (partId: string, itemTarget: UiTarget = {}) => ({
    'data-ui-owner': ownerId,
    'data-ui-instance': instanceId,
    'data-ui-part': partId,
    'data-ui-target': JSON.stringify(targetValues({ ...target, ...itemTarget })),
  });
  return {
    instanceId, part,
    /** Declares the real control; Debug dispatches its existing DOM interaction. */
    action: (partId: string, kind: 'click' | 'type' | 'select' | 'key' | 'scroll', itemTarget: UiTarget = {}) => ({
      ...part(partId, itemTarget), 'data-ui-action': `${ownerId}.${partId}`, 'data-ui-action-kind': kind,
    }),
  };
}
