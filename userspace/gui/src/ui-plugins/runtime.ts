import { isSettingsContributionSlot } from './slots';
import type {
  UiPluginContext,
  UiPluginFile,
  UiPluginManifest,
  UiPluginModule,
  UiPluginRenderer,
  UiPluginScope,
  UiPluginSlot,
  UiPluginSource,
} from './types';

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
type Disposer = () => void | Promise<void>;

export function createPluginScope(
  addStyle: (css: string) => () => void,
  reportError: (error: unknown) => void,
): UiPluginScope & { abort(): void; dispose(): Promise<void> } {
  const controller = new AbortController();
  const disposers: Disposer[] = [];
  let completion: Promise<void> | undefined;
  let finished = false;
  const onDispose = (dispose: Disposer) => {
    if (typeof dispose !== 'function') throw new Error('UI plugin disposer must be a function.');
    if (finished) void Promise.resolve().then(dispose).catch(reportError);
    else disposers.push(dispose);
  };
  return {
    signal: controller.signal,
    onDispose,
    abort: () => controller.abort(),
    reportError: (error) => {
      if (!controller.signal.aborted) reportError(error);
    },
    addStyle(css) {
      if (controller.signal.aborted) return;
      if (typeof css !== 'string') throw new Error('UI plugin stylesheet must be a string.');
      onDispose(addStyle(css));
    },
    dispose() {
      controller.abort();
      return (completion ??= (async () => {
        const errors: string[] = [];
        while (disposers.length) {
          try {
            await disposers.pop()!();
          } catch (error) {
            errors.push(errorText(error));
          }
        }
        finished = true;
        if (errors.length) throw new Error(errors.join('\n'));
      })());
    },
  };
}

export interface UiPluginEntry {
  path: string;
  manifest: UiPluginManifest | null;
  generation: number;
  status: 'disabled' | 'loading' | 'active' | 'error';
  error: string | null;
  renderers: ReadonlyMap<UiPluginSlot, UiPluginRenderer>;
}
interface LivePlugin {
  file: UiPluginFile;
  entry: UiPluginEntry;
  scope?: ReturnType<typeof createPluginScope>;
  views: Set<Disposer>;
}

/** A page owns its display generations. Every replacement drains the old effects first. */
export class UiPluginRuntime {
  private readonly plugins = new Map<string, LivePlugin>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly UiPluginEntry[] = [];
  private nextGeneration = 0;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private readonly importModule: (source: string) => Promise<UiPluginModule>,
    private readonly insertStyle: (css: string) => () => void,
  ) {}
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;
  private publish() {
    this.snapshot = [...this.plugins.values()].map((plugin) => plugin.entry);
    this.listeners.forEach((listener) => listener());
  }
  private enqueue(action: () => Promise<void>) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {}); // The caller receives the failure; later explicit updates may still run.
    return next;
  }
  private async release(plugin: LivePlugin): Promise<string | null> {
    plugin.scope?.abort();
    const errors: string[] = [];
    for (const dispose of plugin.views) {
      try {
        await dispose();
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    plugin.views.clear();
    try {
      await plugin.scope?.dispose();
    } catch (error) {
      errors.push(errorText(error));
    }
    plugin.scope = undefined;
    return errors.length ? errors.join('\n') : null;
  }
  attachView(entry: UiPluginEntry, dispose: Disposer): () => void {
    const plugin = this.plugins.get(entry.path);
    if (!plugin || plugin.entry.generation !== entry.generation || plugin.entry.status !== 'active')
      throw new Error('UI plugin generation is no longer active.');
    plugin.views.add(dispose);
    return () => {
      plugin.views.delete(dispose);
    };
  }
  select(sources: UiPluginSource[]) {
    const retained = new Set(
      sources.filter((source) => source.enabled).map((source) => source.path),
    );
    for (const plugin of this.plugins.values())
      if (!retained.has(plugin.file.path)) plugin.scope?.abort();
    return this.enqueue(async () => {
      for (const [path, plugin] of this.plugins) {
        if (retained.has(path)) continue;
        plugin.entry = { ...plugin.entry, status: 'loading', renderers: new Map() };
        this.publish();
        const error = await this.release(plugin);
        if (error) {
          plugin.entry = { ...plugin.entry, status: 'error', error };
        } else this.plugins.delete(path);
      }
      this.publish();
    });
  }
  replace(files: UiPluginFile[], force: boolean | string = false): Promise<void> {
    for (const plugin of this.plugins.values()) {
      const next = files.find((file) => file.path === plugin.file.path);
      if (
        !next ||
        JSON.stringify(next) !== JSON.stringify(plugin.file) ||
        force === true ||
        force === plugin.file.path
      )
        plugin.scope?.abort();
    }
    return this.enqueue(async () => {
      const checked = files.map((file) => {
        if (!file.enabled || !file.manifest || file.error) return file;
        const duplicate = files.find(
          (other) =>
            other.path !== file.path && other.enabled && other.manifest?.id === file.manifest?.id,
        );
        const overlap = files.find(
          (other) =>
            other.path !== file.path &&
            other.enabled &&
            other.manifest?.slots.some((slot) => file.manifest?.slots.includes(slot)
              && !isSettingsContributionSlot(slot)
              && (slot !== 'tool.result' || other.manifest?.toolId === file.manifest?.toolId)),
        );
        const error = duplicate
          ? `Duplicate UI plugin id: ${file.manifest.id}`
          : overlap
            ? `UI plugin slot already selected by ${overlap.manifest?.name}`
            : null;
        return error ? { ...file, error } : file;
      });
      for (const [path, previous] of this.plugins) {
        if (checked.some((file) => file.path === path)) continue;
        const error = await this.release(previous);
        if (error) throw new Error(`${path}: ${error}`);
        this.plugins.delete(path);
      }
      for (const file of checked) {
        const previous = this.plugins.get(file.path);
        if (
          force !== true &&
          force !== file.path &&
          previous &&
          JSON.stringify(previous.file) === JSON.stringify(file)
        )
          continue;
        if (previous) {
          previous.entry = { ...previous.entry, status: 'loading', renderers: new Map() };
          this.publish();
        }
        const releaseError = previous ? await this.release(previous) : null;
        const error = [file.error, releaseError].filter(Boolean).join('\n') || null;
        const entry: UiPluginEntry = {
          path: file.path,
          manifest: file.manifest ?? previous?.entry.manifest ?? null,
          generation: ++this.nextGeneration,
          status: error ? 'error' : file.enabled ? 'loading' : 'disabled',
          error,
          renderers: new Map(),
        };
        const plugin: LivePlugin = { file, entry, views: new Set() };
        this.plugins.set(file.path, plugin);
        this.publish();
        if (entry.status === 'loading') await this.load(plugin);
      }
      this.publish();
    });
  }
  private async load(plugin: LivePlugin) {
    const scope = createPluginScope(this.insertStyle, (error) => this.report(plugin.entry, error));
    plugin.scope = scope;
    try {
      if (!plugin.file.manifest || plugin.file.source === null)
        throw new Error('UI plugin source is missing.');
      const module = await this.importModule(plugin.file.source);
      if (scope.signal.aborted) {
        await this.release(plugin);
        return;
      }
      if (!module || typeof module.apply !== 'function')
        throw new Error('UI module must export default { apply(context) }.');
      const renderers = new Map<UiPluginSlot, UiPluginRenderer>();
      let registering = true;
      const context: UiPluginContext = {
        ...scope,
        slots: plugin.file.manifest.slots,
        register: (slot, renderer) => {
          if (
            !registering ||
            !plugin.file.manifest?.slots.includes(slot) ||
            slot === ('theme' as UiPluginSlot)
          )
            throw new Error(`Undeclared or late UI plugin slot: ${slot}`);
          if (renderers.has(slot) || typeof renderer !== 'function')
            throw new Error(`Invalid UI renderer: ${slot}`);
          renderers.set(slot, renderer);
        },
      };
      const dispose = await module.apply(context);
      registering = false;
      if (dispose !== undefined) scope.onDispose(dispose);
      for (const slot of plugin.file.manifest.slots)
        if (slot !== 'theme' && !renderers.has(slot))
          throw new Error(`UI module did not register ${slot}.`);
      if (!scope.signal.aborted) plugin.entry = { ...plugin.entry, status: 'active', renderers };
    } catch (error) {
      const cleanupError = await this.release(plugin);
      plugin.entry = {
        ...plugin.entry,
        status: 'error',
        error: [errorText(error), cleanupError].filter(Boolean).join('\n'),
        renderers: new Map(),
      };
    }
    this.publish();
  }
  report(entry: UiPluginEntry, error: unknown) {
    return this.enqueue(async () => {
      const plugin = this.plugins.get(entry.path);
      if (!plugin || plugin.entry.generation !== entry.generation) return;
      plugin.entry = {
        ...plugin.entry,
        status: 'error',
        error: errorText(error),
        renderers: new Map(),
      };
      this.publish();
      const cleanupError = await this.release(plugin);
      if (cleanupError)
        plugin.entry = { ...plugin.entry, error: `${errorText(error)}\n${cleanupError}` };
      this.publish();
    });
  }
  dispose(): Promise<void> {
    for (const plugin of this.plugins.values()) plugin.scope?.abort();
    return this.enqueue(async () => {
      const errors: string[] = [];
      for (const plugin of this.plugins.values()) {
        const error = await this.release(plugin);
        if (error) errors.push(`${plugin.file.path}: ${error}`);
      }
      this.plugins.clear();
      this.publish();
      if (errors.length) throw new Error(errors.join('\n'));
    });
  }
}
