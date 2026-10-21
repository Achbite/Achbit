/** Only the explicit Debug entry installs this registry. Actions retain their UI owner. */
export interface DebugActionState {
  unavailableReason: string | null;
  /** Only an owner that verifies the business result may declare this. */
  completion?: string;
}
export type DebugActionStates = Record<string, DebugActionState>;
export interface ComponentSource {
  slot: string;
  pluginId: string | null;
  read(): unknown;
  actions(): Record<string, (...args: never[]) => unknown>;
  actionStates?(): DebugActionStates;
}
const signatures: Record<string, readonly string[]> = {
  selectModel: ['string', 'nullableString'], pickAttachments: [], addAttachments: ['attachments'],
  updateDraft: ['string'], submitDraft: [], stopRun: [], activateSession: ['string'],
  selectReaderTab: ['string'], toggleReader: [], toggleReaderExpanded: [], setExpanded: ['boolean'],
  toggleTree: [], selectSettingsPage: ['string'], setSettingsSearch: ['string'], setTreeFilter: ['string'],
  setTreeRuntimeVisible: ['boolean'], setTreeItemExpanded: ['string', 'boolean'], openTreeItem: ['string'], openTreeItemMenu: ['string'],
  setUsageVisibility: ['visibility'], openUsageSettings: [],
};
function valid(kind: string, value: unknown): boolean {
  if (kind === 'nullableString') return value === null || typeof value === 'string';
  if (kind === 'visibility') return ['summary', 'collapsed', 'hidden'].includes(String(value));
  if (kind === 'attachments') return Array.isArray(value) && value.every(item => item && typeof item.path === 'string' && ['file', 'directory'].includes(item.kind));
  return typeof value === kind;
}
export function createDebugUiRegistry() {
  const components = new Map<string, ComponentSource>();
  const records: unknown[] = [];
  let dropped = 0;
  const measure = (componentId: string, event: string, startedAt: number, outcome: 'completed' | 'failed') => {
    if (records.length === 4096) { records.shift(); dropped++; }
    const endedAt = performance.now();
    records.push({ componentId, event, outcome, startedAt, endedAt, durationMs: endedAt - startedAt, clockDomain: 'webview.performance', occurredAt: new Date().toISOString(), occurredAtMs: Date.now() });
  };
  return {
    register(id: string, source: ComponentSource) {
      components.set(id, source);
      return () => { if (components.get(id) === source) components.delete(id); };
    },
    measure,
    list: () => [...components].map(([id, source]) => ({ id, slot: source.slot, pluginId: source.pluginId,
      input: source.read(), actions: Object.keys(source.actions()).filter(name => name in signatures).map(name => {
        const state = source.actionStates?.()[name];
        return { name, arguments: signatures[name], availability: state ? (state.unavailableReason ? 'unavailable' : 'available') : 'not-declared',
          reason: state?.unavailableReason ?? null, businessCompletion: state?.completion ?? 'not-asserted' };
      }) })),
    async call(id: string, name: string, args: unknown[]) {
      const source = components.get(id);
      if (!source) throw new Error('debug_component_not_mounted');
      const signature = signatures[name];
      if (!signature || args.length !== signature.length || !signature.every((kind, index) => valid(kind, args[index]))) throw new Error('debug_component_invalid_arguments');
      const action = source.actions()[name];
      if (!action) throw new Error('debug_component_action_unavailable');
      const state = source.actionStates?.()[name];
      if (state?.unavailableReason) throw new Error(state.unavailableReason);
      const startedAt = performance.now();
      try {
        const value = action(...args as never[]);
        const asynchronous = value instanceof Promise || (value && typeof (value as { then?: unknown }).then === 'function');
        const result = await value;
        measure(id, name, startedAt, 'completed');
        return { result: result ?? null, completion: asynchronous ? 'handler-resolved' : 'handler-returned', businessCompletion: state?.completion ?? 'not-asserted' };
      } catch (error) { measure(id, name, startedAt, 'failed'); throw error; }
    },
    measurements() {
      const result = { records: records.splice(0), dropped, coverage: dropped ? 'incomplete' : 'complete-since-last-read' };
      dropped = 0;
      return result;
    },
  };
}
