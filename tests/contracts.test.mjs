import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allocator, evaluatePolicy } from '../server/allocator.mjs';
import { Registry } from '../server/registry.mjs';
import { defaultBus } from '../server/bus.mjs';
import { attribute } from '../server/attribution.mjs';
import { SceneCache } from '../server/cache.mjs';
import { createNewsroom } from '../server/index.mjs';
import { Readable } from 'node:stream';
import { AGENTS } from '../server/agents/index.mjs';

test('排除 agent 后，实际抽样和日志使用同一个归一化分布', () => {
  const a = new Allocator({ topics: ['x'], agents: ['a', 'b', 'c'] });
  a.propensities = (_topic, pool) => { assert.deepEqual(pool, ['b', 'c']); return { a: 0, b: 0, c: 1 }; };
  const d = a.choose({ topic: 'x', readerCluster: 'data', exclude: 'a' });
  assert.equal(d.agent, 'c'); assert.equal(d.propensity, 1);
  const b = new Allocator({ topics: ['x'], agents: ['a', 'b', 'c'] });
  for (let i = 0; i < 30; i++) {
    const d = b.choose({ topic: 'x', exclude: 'a' });
    assert.notEqual(d.agent, 'a'); assert.equal(d.propensities.a, 0);
    assert.ok(Math.abs(Object.values(d.propensities).reduce((x, y) => x + y) - 1) < 1e-12);
  }
});
test('OPE 返回已知 IPS、SNIPS、有效样本量并传递可用动作', () => {
  const ds = [{ topic: 'x', agent: 'a', eligible: ['a', 'b'], reward: 1, propensity: .5 }, { topic: 'x', agent: 'b', eligible: ['a', 'b'], reward: 0, propensity: .5 }];
  const r = evaluatePolicy(ds, (_t, _c, pool) => { assert.deepEqual(pool, ['a', 'b']); return { a: 1 }; });
  assert.deepEqual(r, { n: 2, ips: 1, snips: 1, effectiveSampleSize: 1 });
});
test('注册表拒绝不存在的精确版本、props 数据流覆盖与越权订阅', () => {
  const registry = new Registry(), bus = defaultBus();
  assert.equal(registry.resolve('live-chart@2').version, '2.1.0');
  assert.equal(registry.resolve('live-chart@2.9.9'), null);
  assert.ok(registry.validate({ scene: [{ component: 'video@1', data: 'video.clip', props: { clip: 'nba' } }] }, 'datadesk', bus).length);
  assert.ok(registry.validate({ scene: [{ component: 'scoreboard@1', data: 'scores.nba.lal-bos', props: { data: 'video.clip' } }] }, 'hype', bus).length);
});
test('只给实际场景中发生交互的组件分账，缓存不共享可变对象', () => {
  const decision = { agent: 'a', components: ['real'] };
  assert.deepEqual(attribute(decision, [{ type: 'interact', component: 'fake' }, { type: 'like' }]).split, { agent: { a: 1 }, components: {} });
  const r = attribute(decision, [{ type: 'interact', component: 'real' }, { type: 'like' }]);
  assert.deepEqual(r.split, { agent: { a: .6 }, components: { real: .4 } });
  const cache = new SceneCache(); const value = { x: [1] }; cache.set('x', value); value.x.push(2); cache.get('x').x.push(3); assert.deepEqual(cache.get('x'), { x: [1] });
});

test('HTTP：会话隔离、核验、结算、模拟、恢复和重置', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'newsroom-test-'));
  let app = createNewsroom({ dataDir: dir, llm: false });
  // Exercise the actual HTTP handler without opening a port (sandbox-friendly).
  async function dispatch(path, { method = 'GET', headers = {}, body } = {}) {
    const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
    Object.assign(req, { url: path, method, headers: { host: 'localhost', ...headers } });
    const responseHeaders = {}; let text = '';
    const res = { statusCode: 200, headersSent: false,
      setHeader(k, v) { responseHeaders[k] = v; },
      writeHead(status, h) { this.statusCode = status; Object.assign(responseHeaders, h); this.headersSent = true; },
      end(value = '') { text += value; this.headersSent = true; },
    };
    await app.server.listeners('request')[0](req, res);
    return { status: res.statusCode, ok: res.statusCode < 400, headers: { get: k => responseHeaders[k] }, json: async () => JSON.parse(text) };
  }
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  function client() {
    let cookie = '';
    return async (path, input, opts = {}) => {
      const r = await dispatch(path, { method: input === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json', ...opts.headers }, body: input === undefined ? undefined : JSON.stringify(input), ...opts });
      cookie = r.headers.get('set-cookie')?.split(';')[0] || cookie;
      return { status: r.status, data: await r.json(), cookie };
    };
  }
  const a = client(), b = client();
  assert.equal((await a('/api/sim', { readers: -1 })).status, 400);
  assert.equal((await a('/api/reset')).status, 405);
  assert.equal((await a('/api/unknown')).status, 404);
  assert.equal((await dispatch('/api/reset', { method: 'POST', headers: { origin: 'https://other.example' }, body: '{}' })).status, 403);
  assert.equal((await dispatch('/api/event', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(33000) }) })).status, 413);
  const bad = await dispatch('/api/event', { method: 'POST', body: '{' }); assert.equal(bad.status, 400);
  const feed = (await a('/api/feed')).data; assert.equal(feed.cards.length, 6);
  const card = feed.cards[0];
  for (const c of feed.cards) await a('/api/event', { decisionId: c.decisionId, type: 'impression' });
  assert.equal((await b('/api/event', { decisionId: card.decisionId, type: 'like' })).status, 404);
  assert.equal((await a('/api/event', { decisionId: card.decisionId, type: 'invented' })).status, 400);
  assert.equal((await a('/api/event', { decisionId: card.decisionId, type: 'interact', component: 'invented@1' })).status, 403);
  const streamBlock = feed.cards.flatMap(c => c.scene.scene.map(block => ({ c, block }))).find(x => x.block.data);
  const query = new URLSearchParams({ decisionId: streamBlock.c.decisionId, component: streamBlock.block.resolved, id: streamBlock.block.data });
  assert.equal((await a('/api/snapshot?' + query)).status, 200);
  query.set('id', 'video.clip'); query.set('component', 'scoreboard@1.0.0');
  assert.equal((await a('/api/snapshot?' + query)).status, 403);
  const original = AGENTS[card.agent.id].answer;
  AGENTS[card.agent.id].answer = () => ({ component: 'quote@1', props: { text: '不存在的伪造引文', source: '民调汇总' } });
  try {
    const result = await a('/api/followup', { decisionId: card.decisionId, question: '解释一下' });
    assert.equal(result.data.block, null); assert.ok(result.data.errors.length);
    assert.equal(app.impressions.get(card.decisionId).decision.reward, null);
  } finally { AGENTS[card.agent.id].answer = original; }
  await a('/api/event', { decisionId: card.decisionId, type: 'like', eventId: 'once' });
  const ledger = structuredClone(app.ledger);
  await a('/api/event', { decisionId: card.decisionId, type: 'skip', eventId: 'twice' });
  assert.deepEqual(structuredClone(app.ledger), ledger);
  const swapped = (await a('/api/swap', { decisionId: card.decisionId, storyId: card.story.id })).data;
  assert.notEqual(swapped.agent.id, card.agent.id);
  assert.equal(app.impressions.get(swapped.decisionId).decision.propensities[card.agent.id], 0);
  assert.equal((await a('/api/swap', { decisionId: card.decisionId, storyId: card.story.id })).status, 409);
  const fashion = feed.cards.find(c => c.story.id === 'outfit');
  await a('/api/event', { decisionId: fashion.decisionId, type: 'interact', component: 'outfit-picker@1.0.0', eventId: 'touch' });
  await a('/api/event', { decisionId: fashion.decisionId, type: 'like' });
  assert.equal(app.ledger.authors['stylist-labs'], .4);
  await a('/api/event', { decisionId: swapped.decisionId, type: 'impression' });
  const answer = await a('/api/followup', { decisionId: swapped.decisionId, question: '解释一下' });
  assert.ok(answer.data.block); assert.equal(app.impressions.get(swapped.decisionId).decision.reward, .9);
  const sim = (await a('/api/sim', { readers: 100 })).data; assert.equal(sim.impressions, 600);
  await a('/api/close', { feedId: feed.feedId });
  const before = (await a('/api/leaderboard')).data;
  await app.close(); app = createNewsroom({ dataDir: dir, llm: false });
  const after = (await a('/api/leaderboard')).data;
  assert.deepEqual(after.table, before.table); assert.deepEqual(after.ledger, before.ledger);
  await a('/api/reset', {});
  const reset = (await a('/api/leaderboard')).data;
  assert.deepEqual(reset.ledger, { agents: {}, components: {}, authors: {} }); assert.equal(reset.cache.size, 0);
  assert.ok(reset.table.every(r => r.cells.every(c => c.n === 0)));
});

test('SSE 服务端仅向授权连接扇出流', () => {
  const bus = defaultBus(), writes = [];
  bus.clients.add({ res: { writableLength: 0, write: s => writes.push(s) }, allowed: id => id === 'scores.nba.lal-bos' });
  bus.broadcast('video.clip', 'update'); assert.equal(writes.length, 0);
  bus.broadcast('scores.nba.lal-bos', 'score'); assert.equal(writes.length, 1);
});

test('所有 agent × 故事 × 读者簇均可校验，过滤不修改其他生成结果', async () => {
  const { STORIES } = await import('../server/stories.mjs');
  const { Verifier } = await import('../server/verify.mjs');
  const registry = new Registry(), bus = defaultBus();
  const verifier = new Verifier(new URL('../data/sources.json', import.meta.url));
  for (const [id, agent] of Object.entries(AGENTS)) for (const story of STORIES) for (const cluster of ['data', 'story', 'hype', 'skim']) {
    const scene = structuredClone(agent.build({ story, reader: { cluster }, bus }));
    assert.deepEqual(registry.validate(scene, id, bus), []);
    const report = verifier.check(scene);
    assert.ok(scene.scene.length > 0);
    assert.equal(report.filter(r => !r.ok).length, id === 'hype' && story.id === 'film' ? 1 : 0);
  }
});

test('runtime 忽略非父窗口消息，只初始化一次', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  let handler, renders = 0;
  const parent = { postMessage() {} }, root = {};
  const window = { name: 'frame', render: () => renders++, addEventListener: (_type, fn) => { handler = fn; } };
  runInNewContext(readFileSync(new URL('../web/runtime.js', import.meta.url), 'utf8'), {
    parent, window, document: { getElementById: () => root, documentElement: { dataset: {} }, body: {} },
    matchMedia: () => ({ matches: false }), ResizeObserver: class { observe() {} },
  });
  handler({ source: {}, data: { type: 'init' } }); assert.equal(renders, 0);
  handler({ source: parent, data: { type: 'init' } });
  handler({ source: parent, data: { type: 'init' } }); assert.equal(renders, 1);
});
