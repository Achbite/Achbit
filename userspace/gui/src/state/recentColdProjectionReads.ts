interface Flight<T> {
  id: string;
  revision: number;
  anchorKey?: string;
  controller: AbortController;
  consumer?: { resolve(value: T): void; reject(error: unknown): void };
  expiry?: ReturnType<typeof setTimeout>;
}

/** Per store (and thus per trusted Host). Only the first transport of a known cold open
 * can change hands. There is no completed-value cache here. */
export class RecentColdReads<T> {
  private flights = new Map<string, Flight<T>>();
  constructor(private readonly load: (id: string, revision: number, signal: AbortSignal, anchorKey?: string) => Promise<T>) {}
  pending(id: string, revision: number) { return this.flights.get(id)?.revision === revision; }

  /** A fresh read or command takes priority. Don't cancel an original active caller. */
  forget(id: string, removal?: Error) {
    const flight = this.flights.get(id);
    if (!flight) return;
    this.flights.delete(id);
    clearTimeout(flight.expiry);
    if (removal) { flight.consumer?.reject(removal); delete flight.consumer; }
    if (!flight.consumer) flight.controller.abort(removal);
  }

  clear() { for (const id of this.flights.keys()) this.forget(id); }

  read(id: string, revision: number, signal: AbortSignal, anchorKey?: string): Promise<{ value: T; joined: boolean }> {
    signal.throwIfAborted();
    const previous = this.flights.get(id);
    const joined = previous !== undefined && !previous.consumer && previous.revision === revision && previous.anchorKey === anchorKey;
    const flight = joined ? previous : this.start(id, revision, anchorKey);
    clearTimeout(flight.expiry);
    // Touch on adoption: when A comes back from B and then selects C, evict B, not A.
    this.flights.delete(id);
    this.flights.set(id, flight);
    return new Promise((resolve, reject) => {
      const leave = () => {
        delete flight.consumer;
        reject(signal.reason);
        if (this.flights.get(id) !== flight) flight.controller.abort();
        else flight.expiry = setTimeout(() => this.forget(id), 250);
      };
      flight.consumer = {
        resolve(p) { signal.removeEventListener('abort', leave); resolve({ value: p, joined }); },
        reject(error) { signal.removeEventListener('abort', leave); reject(error); },
      };
      signal.addEventListener('abort', leave, { once: true });
    });
  }

  private start(id: string, revision: number, anchorKey?: string): Flight<T> {
    this.forget(id);
    // At most the current selection and one immediately preceding cold transport.
    if (this.flights.size >= 2) this.forget(this.flights.keys().next().value!);
    const flight: Flight<T> = { id, revision, anchorKey, controller: new AbortController() };
    void this.load(id, revision, flight.controller.signal, anchorKey).then(
      projection => this.finish(flight)?.resolve(projection),
      error => this.finish(flight)?.reject(error),
    );
    return flight;
  }

  private finish(flight: Flight<T>) {
    clearTimeout(flight.expiry);
    if (this.flights.get(flight.id) === flight) this.flights.delete(flight.id);
    const consumer = flight.consumer;
    delete flight.consumer;
    return consumer;
  }
}
