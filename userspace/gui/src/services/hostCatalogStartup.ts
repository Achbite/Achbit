import type { HostReadiness } from './apiClient';

// One catalog initialization belongs to one Host. Replacing the Host settles the
// previous wait before installing another, including after a failed startup.
export function createHostCatalogStartup(initialize: (ready: Promise<void>) => Promise<void>) {
  let current: { hostId: string; invalidated: boolean; ready: boolean; initialization: Promise<void>; resolve(): void; reject(error: Error): void } | null = null;
  let observing: Promise<unknown> = Promise.resolve();
  return {
    hostId: () => current?.hostId ?? null,
    fail(error: Error) {
      if (current && !current.ready) { current.invalidated = true; current.reject(error); }
    },
    observe(data: HostReadiness): Promise<boolean> {
      const next = observing.then(async () => {
        // Native GUI retries retain the Host group id but launch a new process.
        const hostId = `${data.hostInstanceId}:${data.hostPid}`;
        const changed = current?.hostId !== hostId || current.invalidated;
        if (changed) {
          current?.reject(new Error('host_instance_replaced'));
          await current?.initialization;
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
          current = { hostId, invalidated: false, ready: false, resolve, reject, initialization: initialize(ready) };
        }
        if (data.runtimeError) current!.reject(new Error(`${data.runtimeError.code}: ${data.runtimeError.message}`));
        else if (data.kernel === 'ready' && data.session === 'ready') { current!.ready = true; current!.resolve(); }
        return changed;
      });
      observing = next.catch(() => undefined);
      return next;
    },
  };
}
