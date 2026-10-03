import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, endpointFor, permissionFor } from '../extension/core/settings.js';
import { extractWithLLM, verifyModelContent } from '../extension/core/llm.js';

const settings = { baseUrl: 'https://example.test/v1/', model: 'example-model', apiKey: 'test-key' };
const reply = (raw) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ results: [raw] }) } }] }));

test('normalizes compatible endpoints without duplicating chat/completions', () => {
  assert.equal(endpointFor(settings), 'https://example.test/v1/chat/completions');
  assert.equal(endpointFor({ ...settings, baseUrl: 'http://localhost:8080/v1/chat/completions/' }), 'http://localhost:8080/v1/chat/completions');
  assert.equal(permissionFor({ ...settings, baseUrl: 'http://localhost:8080/v1' }), 'http://localhost/*');
  for (const baseUrl of ['file:///tmp/x', 'https://user:password@example.test', 'https://example.test?key=x']) {
    assert.throws(() => normalizeSettings({ ...settings, baseUrl }));
  }
});

test('verifies literal fidelity, returns source occurrences, rejects invented data', () => {
  const raw = '{"id":9007199254740993,"x":1,"x":2}';
  const result = verifyModelContent(JSON.stringify({ results: [raw] }), `request ${raw} response [1,2]`);
  assert.deepEqual(result.map(item => item.raw), [raw, '[1,2]']);
  assert.throws(() => verifyModelContent('{"results":["{\\"id\\":9007199254740992}"]}', raw), /原文不一致/);
  assert.throws(() => verifyModelContent('{"results":["{}"]}', 'incomplete {"a":'), /原文不一致/);
});

test('sends only chosen text and compatible chat contract', async () => {
  const raw = '{"safe":true}';
  let calls = 0;
  const result = await extractWithLLM(raw, settings, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(init.body).messages[1].content, raw);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    return reply(raw);
  } });
  assert.equal(calls, 1);
  assert.equal(result[0].raw, raw);
});

test('rejects oversized UTF-8 input before any request', async () => {
  let called = false;
  await assert.rejects(extractWithLLM('中'.repeat(40_000), settings, { fetchImpl: async () => { called = true; } }), /100 KB/);
  assert.equal(called, false);
});

test('reports status without echoing provider error bodies or credentials', async () => {
  for (const [status, expected] of [[401, /鉴权/], [429, /限流/], [500, /HTTP 500/]]) {
    await assert.rejects(extractWithLLM('{}', settings, { fetchImpl: async () => new Response('secret-provider-diagnostic', { status }) }), expected);
  }
});

test('rejects partial model completion and malformed response', async () => {
  await assert.rejects(extractWithLLM('{}', settings, { fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length' }] })) }), /截断/);
  await assert.rejects(extractWithLLM('{}', settings, { fetchImpl: async () => new Response('<html>failure</html>') }), /不是有效 JSON/);
});

test('supports cancellation and timeout', async () => {
  const waitingFetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const stop = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
  const controller = new AbortController();
  const request = extractWithLLM('{}', settings, { signal: controller.signal, fetchImpl: waitingFetch });
  controller.abort();
  await assert.rejects(request, /已取消/);
  await assert.rejects(extractWithLLM('{}', settings, { timeoutMs: 5, fetchImpl: waitingFetch }), /超过 3 分钟/);
});

test('cancellation during asynchronous source verification cannot commit results', async () => {
  let releaseVerification;
  let verificationStarted;
  const started = new Promise(resolve => { verificationStarted = resolve; });
  const controller = new AbortController();
  const request = extractWithLLM('{}', settings, {
    signal: controller.signal,
    fetchImpl: async () => reply('{}'),
    verifyContent: () => { verificationStarted(); return new Promise(resolve => { releaseVerification = resolve; }); },
  });
  await started;
  controller.abort();
  releaseVerification([{ raw: '{}' }]);
  await assert.rejects(request, /已取消/);
});
