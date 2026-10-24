import type { KernelPort, ManagedProcessSnapshot } from '@achbit/protocol';

/** One run-owned fact feed. It never schedules a model request. */
export class ManagedProcesses {
  readonly #controller = new AbortController();
  readonly #jobs = new Map<string, ManagedProcessSnapshot>();
  #writes: Promise<void> = Promise.resolve();
  #failure?: unknown;
  readonly #watch: Promise<void>;

  constructor(readonly sessionId: string, readonly runId: string, private kernel: KernelPort,
    private commit: (jobs: ManagedProcessSnapshot[]) => Promise<void>, onError: (error: unknown) => void) {
    this.#watch = this.watch().catch(error => {
      if (this.#controller.signal.aborted) return;
      this.#failure = error;
      onError(error);
    });
  }

  private revisions(): Record<string, number> {
    return Object.fromEntries([...this.#jobs].map(([id, job]) => [id, job.revision]));
  }

  private accept(jobs: ManagedProcessSnapshot[]): Promise<void> {
    const task = this.#writes.then(async () => {
      const changed = jobs.filter(job => (this.#jobs.get(job.jobId)?.revision ?? 0) < job.revision);
      if (!changed.length) return;
      await this.commit(changed);
      for (const job of changed) this.#jobs.set(job.jobId, job);
    });
    this.#writes = task;
    return task;
  }

  private async watch(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const jobs = await this.kernel.readProcesses({ sessionId: this.sessionId, runId: this.runId,
        revisions: this.revisions(), waitMs: 30_000 }, this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      await this.accept(jobs);
    }
  }

  async sync(): Promise<void> {
    if (this.#failure) throw this.#failure;
    const jobs = await this.kernel.readProcesses({sessionId: this.sessionId, runId: this.runId, revisions: this.revisions()});
    await this.accept(jobs);
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await this.#watch;
    // The cancellation reply is issued only after the owned processes have exited.
    await this.accept(await this.kernel.readProcesses({sessionId: this.sessionId, runId: this.runId,
      revisions: this.revisions(), cancel: true}));
  }
}
