/** Only the explicit Debug entry installs this registry. Actions retain their UI owner. */
export interface DebugActionState {
  unavailableReason: string | null;
  /** Only an owner that verifies the business result may declare this. */
  completion?: string;
}
export type DebugActionStates = Record<string, DebugActionState>;
export interface ComponentSource {
  ownerId?: string;
  slot: string | null;
  pluginId: string | null;
  read(): unknown;
  actions(): Record<string, (...args: never[]) => unknown>;
  actionStates?(): DebugActionStates;
  target?(): Readonly<Record<string, string>>;
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
export function createDebugUiRegistry(inspectIdentity: (id: string, source: ComponentSource) => object = () => ({})) {
  const components = new Map<string, Set<ComponentSource>>();
  const records: unknown[] = [];
  let dropped = 0;
  const matchesTarget = (source: ComponentSource, target: Record<string, string>) => {
    if (!target || Array.isArray(target) || typeof target !== 'object' || Object.values(target).some(value => typeof value !== 'string')) throw Error('debug_action_target_invalid');
    return Object.entries(target).every(([key, value]) => source.target?.()[key] === value);
  };
  const entries = () => [...components].flatMap(([id, instances]) => [...instances].map(source => ({ id, source })));
  const measure = (componentId: string, event: string, startedAt: number, outcome: 'completed' | 'failed') => {
    if (records.length === 4096) { records.shift(); dropped++; }
    const endedAt = performance.now();
    records.push({ componentId, event, outcome, startedAt, endedAt, durationMs: endedAt - startedAt, clockDomain: 'webview.performance', occurredAt: new Date().toISOString(), occurredAtMs: Date.now() });
  };
  const registry = {
    register(id: string, source: ComponentSource) {
      const instances = components.get(id) ?? new Set<ComponentSource>();
      instances.add(source);
      components.set(id, instances);
      return () => {
        instances.delete(source);
        if (instances.size === 0 && components.get(id) === instances) components.delete(id);
      };
    },
    measure,
    list: () => [...components].flatMap(([id, instances]) => [...instances].map(source => ({
      id, instanceId: id, ownerId: source.ownerId ?? null, slot: source.slot, pluginId: source.pluginId,
      identityStatus: instances.size === 1 ? 'unique' : 'ambiguous', ...inspectIdentity(id, source),
      target: source.target?.() ?? {}, input: source.read(), actions: Object.keys(source.actions()).filter(name => name in signatures).map(name => {
        const state = source.actionStates?.()[name];
        return { name, actionId: source.ownerId ? `${source.ownerId}.${name}` : null, execution: 'component.callback', arguments: signatures[name], availability: state ? (state.unavailableReason ? 'unavailable' : 'available') : 'not-declared',
          reason: state?.unavailableReason ?? null, businessCompletion: state?.completion ?? 'not-asserted' };
      }) }))),
    owner(ownerId: string, target: Record<string, string> = {}) {
      const matches = entries().filter(row => row.source.ownerId === ownerId && matchesTarget(row.source, target));
      if (matches.length > 1) throw Error('debug_action_target_ambiguous');
      return matches.length ? { id: matches[0].id, input: matches[0].source.read() } : undefined;
    },
    async callAction(actionId: string, target: Record<string, string> = {}, args: unknown[] = []) {
      const matches = entries().flatMap(row => Object.keys(row.source.actions())
        .filter(name => name in signatures && `${row.source.ownerId}.${name}` === actionId && matchesTarget(row.source, target))
        .map(name => ({ ...row, name })));
      if (!matches.length) throw Error('debug_action_not_mounted');
      if (matches.length !== 1) throw Error('debug_action_target_ambiguous');
      const { id, source, name } = matches[0];
      if (!source.actionStates?.()[name]) throw Error('debug_action_availability_not_declared');
      return { ...await registry.call(id, name, args), actionId, componentId: id, target: source.target?.() ?? {}, execution: 'component.callback' };
    },
    async call(id: string, name: string, args: unknown[]) {
      const instances = components.get(id);
      if (!instances?.size) throw new Error('debug_component_not_mounted');
      if (instances.size !== 1) throw new Error('debug_component_ambiguous');
      const source = [...instances][0];
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
  return registry;
}
