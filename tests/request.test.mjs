import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, createActionGate } from '../web/request.js';
const ok = value => ({ ok: true, status: 200, json: async () => value });
const errorResponse = status => ({ ok: false, status, json: async () => ({ error: 'failed' }) });

test('幂等写请求网络重试保持相同 ID 和请求体', async () => {
  const sent = [];
  const api = createApi({ sleep: async () => {}, fetchImpl: async (_path, options) => {
    sent.push(options.body); if (sent.length === 1) throw new TypeError('network lost'); return ok({ ok: true });
  } });
  assert.deepEqual(await api('/api/swap', { decisionId: 'a', storyId: 'b', requestId: 'once' }), { ok: true });
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
});

test('模拟、重置和无请求 ID 的信息流不能自动重试；业务拒绝也不重试', async () => {
  for (const [path, body] of [['/api/reset', {}], ['/api/sim', {}], ['/api/feed', undefined]]) {
    let count = 0;
    const api = createApi({ sleep: async () => {}, fetchImpl: async () => { count++; throw new Error('offline'); } });
    await assert.rejects(api(path, body)); assert.equal(count, 1);
  }
  let count = 0;
  const api = createApi({ fetchImpl: async () => { count++; return errorResponse(409); } });
  await assert.rejects(api('/api/event', { eventId: 'x' }), e => e.status === 409); assert.equal(count, 1);
});

test('只重试临时故障，读请求有超时和次数上限', async () => {
  let count = 0;
  const api = createApi({ sleep: async () => {}, fetchImpl: async () => { count++; return count < 3 ? errorResponse(503) : ok({ value: 1 }); } });
  assert.deepEqual(await api('/api/feed?requestId=once'), { value: 1 }); assert.equal(count, 3);
  let aborted = 0;
  const slow = createApi({ timeoutMs: 5, retryDelays: [], fetchImpl: async (_path, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); })) });
  await assert.rejects(slow('/api/catalog'), /请求超时/); assert.equal(aborted, 1);
});

test('页面操作互斥，失败后恢复操作能力且保留错误原因', async () => {
  let release;
  const busy = [], errors = [], calls = [];
  const run = createActionGate({ onBusy: value => busy.push(value), onError: error => errors.push(error.message) });
  const first = run(async () => { calls.push('first'); await new Promise(r => { release = r; }); });
  assert.equal(await run(async () => calls.push('stale-click')), false);
  release(); assert.equal(await first, true);
  assert.equal(await run(async () => { throw new Error('offline'); }), false);
  assert.equal(await run(async () => calls.push('retry')), true);
  assert.deepEqual(calls, ['first', 'retry']); assert.deepEqual(errors, ['offline']);
  assert.deepEqual(busy, [true, false, true, false, true, false]);
});
