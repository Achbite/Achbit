import type { ActivityProjection, SessionProjection, ShellActivityResultProjection, TranscriptOverview } from '@achbit/protocol';

export const archivedMeasurements = new WeakMap<SessionProjection, TranscriptOverview['measurement']>();
type ShellResult = ShellActivityResultProjection;
type RecordMap = Map<string, ActivityProjection>;
type ReadState<T> = { value?: T; error?: string };
const idle = {};
export class HistoryDetail<T> {
  private state: ReadState<T> = idle;
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  constructor(private readonly fetchDetail: (signal: AbortSignal) => Promise<T>) {}

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.load();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.controller) {
        this.controller.abort();
        this.controller = undefined;
      }
    };
  };
  retry = () => { this.publish(idle); this.load(); };
  private publish(state: ReadState<T>) {
    this.state = state;
    for (const notify of this.listeners) notify();
  }
  private load() {
    if (this.controller || this.state !== idle || !this.listeners.size) return;
    const controller = this.controller = new AbortController();
    void this.fetchDetail(controller.signal).then(value => {
      if (!controller.signal.aborted) this.publish({ value });
    }, error => {
      if (!controller.signal.aborted) this.publish({ error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (this.controller === controller) this.controller = undefined; });
  }
}

export interface DeferredShell {
  summary: Omit<ShellResult, 'stdout' | 'stderr'>;
  output: HistoryDetail<Pick<ShellResult, 'stdout' | 'stderr'>>;
  fullProjection: HistoryDetail<RecordMap>;
}
export const deferredShells = new WeakMap<object, DeferredShell>();
export function deferredShell(activity: ActivityProjection) {
  return activity.tool?.shell && deferredShells.get(activity.tool.shell);
}
