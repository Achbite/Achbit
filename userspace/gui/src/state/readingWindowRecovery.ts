import type { OpeningReadingWindow } from './recentSessionViews';

/** The selected view owns exactly one transition to full history. Showing the window never waits
 * for this gate. A real interaction releases it synchronously; a later selection cancels it. */
export class ReadingWindowRecovery {
  readonly ready: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private released = false;
  private timer: ReturnType<typeof setTimeout>;
  private idle?: number;

  constructor(readonly window: OpeningReadingWindow, private signal: AbortSignal) {
    signal.throwIfAborted();
    this.ready = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A hidden/unmounted view (or a rendering failure) must not leave the original activateSession
    // promise waiting forever for a paint. Only this still-selected generation owns this timer.
    this.timer = setTimeout(() => this.afterPresentation(), 1000);
    signal.addEventListener('abort', this.abort, { once: true });
  }

  afterPresentation() {
    if (this.released || this.idle !== undefined) return;
    // The viewport owns the formatted-frame acknowledgement. Don't wait for a second pair
    // of animation frames here; the active reader may need its next page immediately.
    clearTimeout(this.timer);
    if (typeof requestIdleCallback === 'function') this.idle = requestIdleCallback(() => this.demand(), { timeout: 250 });
    else this.timer = setTimeout(() => this.demand(), 0);
  }

  demand() { if (this.finish()) this.resolve(); }
  private abort = () => { if (this.finish()) this.reject(this.signal.reason); };
  private finish() {
    if (this.released) return false;
    this.released = true;
    clearTimeout(this.timer);
    if (this.idle !== undefined) cancelIdleCallback(this.idle);
    this.signal.removeEventListener('abort', this.abort);
    return true;
  }
}
