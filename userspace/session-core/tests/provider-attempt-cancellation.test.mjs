import test from 'node:test';
import assert from 'node:assert/strict';
import { withProviderAttempts } from '../dist/local-agent/providerAttempts.js';

for (const purpose of ['agent', 'contextCompaction', 'approvalReview']) {
  test(`cancellation while registering ${purpose} never starts a Provider stream`, async () => {
    const controller = new AbortController();
    const events = [];
    let sends = 0;
    const request = { requestId: 'request:cancel-admission', sessionId: 'session:cancel-admission',
      runId: 'run:cancel-admission', purpose };
    const deps = {
      nextId: () => 'attempt:cancel-admission',
      updateAssistantDraft() {},
      async commit(event) {
        events.push(event);
        if (event.payload.phase === 'started') controller.abort('user_cancelled');
      },
    };
    await assert.rejects(withProviderAttempts(request, deps, controller.signal, async () => {
      sends++;
      controller.signal.throwIfAborted();
    }), error => error === 'user_cancelled');
    assert.equal(sends, 0, 'cancellation admitted before dispatch must not call the Provider');
    assert.deepEqual(events.map(event => event.payload.phase), ['started', 'failed']);
    assert.equal(events[1].payload.error.code, 'provider_cancelled');
    assert.equal(events[1].payload.error.diagnostics.retryable, false);
  });
}
