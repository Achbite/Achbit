import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { runFailureKind } from '@achbit/protocol';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('reconnect status spans retry wait and reconnect send, and clears when content resumes or run settles', async t => {
  const { providerRetryAttempt, ProviderRetryStatus } = await loadGuiModule(t, '/src/components/local-agent/RunFailureDetails.tsx');
  const error = { code: 'provider_transport_failed', message: 'connect timeout' };
  const fact = { providerRequestId: 'request:1', providerAttemptId: 'attempt:1', purpose: 'agent', attempt: 1, phase: 'retryWaiting', error };
  const projection = { run: { status: 'running' }, providerAttempts: [fact] };
  assert.equal(providerRetryAttempt(projection), 2);
  assert.match(renderToStaticMarkup(ProviderRetryStatus({ projection, language: 'zh-CN' })), /正在重新连接 2\/5/);
  assert.deepEqual(projection.providerAttempts[0].error, error, 'presentation never removes original diagnostics');
  projection.providerAttempts.push({ ...fact, providerAttemptId: 'attempt:2', attempt: 2, phase: 'started', error: undefined });
  assert.equal(providerRetryAttempt(projection, { phase: 'waitingResponse' }), 2);
  assert.match(renderToStaticMarkup(ProviderRetryStatus({ projection, language: 'en-US' })), /Reconnecting 2\/5/);
  for (const phase of ['reasoning', 'awaitingOutput', 'generatingOutput']) assert.equal(providerRetryAttempt(projection, { phase }), null);
  projection.providerAttempts.at(-1).phase = 'completed';
  assert.equal(providerRetryAttempt(projection), null);
  projection.providerAttempts.at(-1).phase = 'retryWaiting';
  for (const status of ['failed', 'completed', 'cancelled', 'waiting', 'finishing']) {
    projection.run.status = status;
    assert.equal(providerRetryAttempt(projection), null);
  }
  projection.run.status = 'running';
  projection.providerAttempts = [{ ...fact, phase: 'started' }];
  assert.equal(providerRetryAttempt(projection), null, 'first send is not a reconnection');
});

test('terminal status names the provider failure and reserves Loop failure for internal errors', async t => {
  const { RunFailureDetails } = await loadGuiModule(t, '/src/components/local-agent/RunFailureDetails.tsx');
  const provider = (details, extra = {}) => ({ code: 'provider_error', message: 'Original upstream detail', diagnostics: {
    source: 'providerTransport', phase: 'response', category: 'provider', retryable: false, causes: [],
    ...(Object.keys(details).length ? { providerError: details } : {}), ...extra,
  } });
  const cases = [
    [provider({ code: 'server_is_overloaded', type: 'service_unavailable_error', retryDirective: 'NO_MORE_RETRY' }), '模型服务过载'],
    [provider({ type: 'overloaded_error' }), '模型服务过载'],
    [provider({ httpStatus: 529 }), '模型服务过载'],
    [provider({ httpStatus: 503 }), '模型服务过载或暂不可用'],
    [provider({ code: '503', status: 'UNAVAILABLE', httpStatus: 503 }), '模型服务过载或暂不可用'],
    [provider({ code: 'insufficient_quota', httpStatus: 429 }), '模型服务额度或余额不足'],
    [provider({ httpStatus: 402 }), '模型服务额度或余额不足'],
    [provider({ type: 'rate_limit_error' }), '模型请求受到限流'],
    [provider({ status: 'RESOURCE_EXHAUSTED' }), '模型请求受到限流'],
    [provider({ httpStatus: 429 }), '模型请求受到限流'],
    [provider({ type: 'authentication_error' }), '模型服务认证失败'],
    [provider({ httpStatus: 401 }), '模型服务认证失败'],
    [provider({ status: 'PERMISSION_DENIED' }), '模型服务访问被拒绝'],
    [provider({ httpStatus: 403 }), '模型服务访问被拒绝'],
    [provider({ status: 'DEADLINE_EXCEEDED' }), '模型请求超时'],
    [provider({ httpStatus: 504 }), '模型请求超时'],
    [provider({}, { category: 'network', isTimeout: true, retryable: true }), '模型请求超时'],
    [provider({}, { category: 'network', isConnect: true }), '模型连接失败'],
    [provider({ httpStatus: 500 }), '模型服务内部错误'],
    [provider({}, { category: 'protocol' }), '模型响应格式异常'],
    [provider({ code: 'unknown_vendor_code' }), '模型服务拒绝了请求'],
    [{ code: 'agent_loop_failed', message: 'Invariant violation', diagnostics: {
      source: 'session', phase: 'loop', category: 'internal', retryable: false, causes: [],
    } }, 'Loop 运行失败'],
    [{ code: 'context_input_budget_exceeded', message: 'Input retained' }, '上下文预算不足'],
    [{ code: 'unclassified_legacy_error', message: 'Overloaded wording alone is not proof' }, '任务未完成'],
  ];
  for (const [error, label] of cases) {
    const before = structuredClone(error);
    const projection = { sessionId: 'session:provider-failure', run: { status: 'failed' }, terminalError: error,
      contextHandoff: { status: 'reading' } };
    const html = renderToStaticMarkup(createElement(RunFailureDetails, { projection, language: 'zh-CN', onError() {} }));
    assert.ok(html.includes(`<span>${label}</span>`), `${label}: ${html}`);
    if (label !== 'Loop 运行失败') assert.doesNotMatch(html, />Loop 运行失败</);
    assert.ok(html.includes(error.message));
    assert.deepEqual(error, before, 'classification preserves the original failure and retry directive');
  }
  const historical = cases[0][0];
  const html = renderToStaticMarkup(createElement(RunFailureDetails, { language: 'en-US', onError() {}, projection: {
    sessionId: 'session:historical', run: { status: 'failed' }, failureSnapshot: { error: historical,
      revision: 1, phase: 'provider', providerAttemptIds: [], toolRecordIds: [], pendingCallIds: [] },
  } }));
  assert.match(html, /Model service overloaded/);
  assert.match(html, /NO_MORE_RETRY/);
});

test('incomplete Responses output keeps its cause and is not presented as a rejected request', async t => {
  const { RunFailureDetails } = await loadGuiModule(t, '/src/components/local-agent/RunFailureDetails.tsx');
  const error = {
    code: 'provider_response_failed', message: 'Responses 请求未完成：max_output_tokens',
    diagnostics: { source: 'providerTransport', phase: 'response', category: 'provider',
      retryable: false, causes: [], providerError: { type: 'response.incomplete' } },
  };
  const before = structuredClone(error);
  assert.equal(runFailureKind(error), 'providerIncomplete');
  for (const [language, label] of [['zh-CN', '模型响应未完成'], ['en-US', 'Model response incomplete']]) {
    for (const source of ['terminalError', 'failureSnapshot']) {
      const projection = { sessionId: 'session:incomplete-response', run: { status: 'failed' },
        ...(source === 'terminalError' ? { terminalError: error } : { failureSnapshot: {
          error, revision: 1, phase: 'provider', providerAttemptIds: [], toolRecordIds: [], pendingCallIds: [],
        } }),
      };
      const html = renderToStaticMarkup(createElement(RunFailureDetails, { projection, language, onError() {} }));
      assert.ok(html.includes(`<span>${label}</span>`), `${language} ${source}: ${html}`);
      assert.doesNotMatch(html, /模型服务拒绝了请求|Model service rejected the request/);
      assert.ok(html.includes(error.message));
      assert.match(html, /response\.incomplete/);
      assert.deepEqual(error, before, 'presentation preserves the original failure, diagnostics and retry policy');
    }
  }
});
