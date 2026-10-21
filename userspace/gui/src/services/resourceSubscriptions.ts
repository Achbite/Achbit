/** One resource stream per Session, shared by Reader tabs and the file tree.
 * Replacing a subscription overlaps only until ready, so reads cannot miss a change.
 * This is transport ownership, not another filesystem or permission fact store.
 */
export function createResourceSubscriptions<T>(key: (resource: T) => string,
  stream: (sessionId: string, resources: T[], signal: AbortSignal,
    ready: (indices?: number[]) => void, changed: (indices: number[]) => void,
    unavailable: (indices: number[], error: unknown) => void) => Promise<void>) {
  type Subscriber = { resources: T[]; changed(indices: number[]): void; initialized: boolean; fail(error: unknown): void };
  type Connection = { resources: T[]; covered?: Set<string>; signature: string; abort: AbortController; timer?: ReturnType<typeof setTimeout> };
  type Hub = { sessionId: string; subscribers: Set<Subscriber>; active?: Connection; pending?: Connection; scheduled: boolean };
  const hubs = new Map<string, Hub>();
  function stop(connection?: Connection) {
    if (!connection) return;
    clearTimeout(connection.timer);
    connection.abort.abort();
  }
  function initialize(hub: Hub) {
    if (!hub.active) return;
    const covered = hub.active.covered!;
    for (const subscriber of [...hub.subscribers]) {
      if (!subscriber.initialized && subscriber.resources.every(resource => covered.has(key(resource)))) {
        subscriber.initialized = true;
        subscriber.changed(subscriber.resources.map((_, index) => index));
      }
    }
  }
  function fail(hub: Hub, error: unknown) {
    stop(hub.pending); stop(hub.active);
    hub.pending = undefined; hub.active = undefined;
    if (hubs.get(hub.sessionId) === hub) hubs.delete(hub.sessionId);
    for (const subscriber of [...hub.subscribers]) subscriber.fail(error);
  }
  function schedule(hub: Hub) {
    if (hub.scheduled) return;
    hub.scheduled = true;
    queueMicrotask(() => {
      hub.scheduled = false;
      if (hubs.get(hub.sessionId) !== hub) return;
      const resources = [...new Map([...hub.subscribers].flatMap(subscriber => subscriber.resources.map(resource => [key(resource), resource] as const))).entries()]
        .sort(([a], [b]) => a.localeCompare(b)).map(([, resource]) => resource);
      if (!resources.length) {
        stop(hub.pending); stop(hub.active); hubs.delete(hub.sessionId); return;
      }
      const signature = JSON.stringify(resources.map(key));
      if (hub.active?.signature === signature) { stop(hub.pending); hub.pending = undefined; initialize(hub); return; }
      if (hub.pending?.signature === signature) return;
      stop(hub.pending);
      const connection: Connection = { resources, signature, abort: new AbortController() };
      hub.pending = connection;
      connection.timer = setTimeout(() => fail(hub, new Error('resource_watch_ready_timeout')), 15000);
      void stream(hub.sessionId, resources, connection.abort.signal, (indices = resources.map((_, index) => index)) => {
        if (connection.abort.signal.aborted || hub.pending !== connection) return;
        clearTimeout(connection.timer);
        const previous = hub.active;
        connection.covered = new Set(indices.map(index => key(resources[index])));
        hub.active = connection; hub.pending = undefined;
        stop(previous);
        initialize(hub);
      }, indices => {
        if (connection.abort.signal.aborted || hub.active !== connection) return;
        const affected = new Set(indices.map(index => key(resources[index])));
        for (const subscriber of [...hub.subscribers]) {
          if (!subscriber.initialized) continue;
          const matches = subscriber.resources.flatMap((resource, index) => affected.has(key(resource)) ? [index] : []);
          if (matches.length) subscriber.changed(matches);
        }
      }, (indices, error) => {
        if (connection.abort.signal.aborted) return;
        const affected = new Set(indices.map(index => key(resources[index])));
        for (const subscriber of [...hub.subscribers]) {
          if (subscriber.resources.some(resource => affected.has(key(resource)))) subscriber.fail(error);
        }
      }).catch(error => { if (!connection.abort.signal.aborted) fail(hub, error); });
    });
  }
  return function watch(sessionId: string, resources: T[], signal: AbortSignal, changed: (indices: number[]) => void): Promise<void> {
    if (signal.aborted || !resources.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let hub = hubs.get(sessionId);
      if (!hub) { hub = { sessionId, subscribers: new Set(), scheduled: false }; hubs.set(sessionId, hub); }
      const owner = hub;
      const dispose = () => {
        signal.removeEventListener('abort', onAbort);
        owner.subscribers.delete(subscriber);
        schedule(owner);
      };
      const onAbort = () => { dispose(); resolve(); };
      const subscriber: Subscriber = { resources: [...resources], changed, initialized: false,
        fail(error) { dispose(); reject(error); } };
      owner.subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      initialize(owner);
      schedule(owner);
    });
  };
}
