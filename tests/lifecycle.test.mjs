import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewsroom } from '../server/index.mjs';
import { AGENTS } from '../server/agents/index.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'newsroom-lifecycle-'));
  let app = createNewsroom({ dataDir: dir, llm: false, ...options });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const client = () => {
    let cookie = '';
    return async (path, value, { oneByte = false } = {}) => {
      const bytes = value == null ? null : Buffer.from(JSON.stringify(value));
      const req = Readable.from(!bytes ? [] : oneByte ? [...bytes].map(byte => Buffer.from([byte])) : [bytes]);
      Object.assign(req, { url: path, method: value == null ? 'GET' : 'POST', headers: { host: 'localhost', cookie } });
      const headers = {}; let output = '';
      const res = { statusCode: 200, headersSent: false,
        setHeader(k, v) { headers[k] = v; },
        writeHead(status, h) { this.statusCode = status; Object.assign(headers, h); },
        end(v = '') { output += v; },
      };
      await app.server.listeners('request')[0](req, res);
      cookie = headers['set-cookie']?.split(';')[0] || cookie;
      return { status: res.statusCode, data: JSON.parse(output) };
    };
  };
  return { get app() { return app; }, dir, client,
    async restart({ asV2 = false } = {}) {
      await app.close();
      if (asV2) { const path = join(dir, 'state.json'); const state = JSON.parse(readFileSync(path, 'utf8')); state.version = 2; delete state.contextPost; writeFileSync(path, JSON.stringify(state)); }
      app = createNewsroom({ dataDir: dir, llm: false, ...options });
    },
  };
}
const view = (request, card) => request('/api/event', { decisionId: card.decisionId, type: 'impression' });
const settledCount = app => [...app.allocator.decisions.values()].filter(d => d.reward != null).length;

test('未看卡片关闭或替换：不计零分、不更新后验、不进入 OPE', async t => {
  const f = fixture(t), request = f.client();
  const first = (await request('/api/feed')).data;
  const before = structuredClone(f.app.allocator.post);
  const second = (await request('/api/feed?replace=' + first.feedId)).data;
  for (const card of first.cards) {
    const imp = f.app.impressions.get(card.decisionId);
    assert.equal(imp.closed, true); assert.equal(imp.decision.reward, null);
    assert.equal(imp.decision.discarded, 'not-exposed');
  }
  assert.deepEqual(f.app.allocator.post, before);
  assert.equal((await request('/api/ope')).data.logged, 0);
  await request('/api/close', { feedId: second.feedId });
  assert.equal(settledCount(f.app), 0);
  await f.restart();
  assert.equal(settledCount(f.app), 0);
});

test('只结算已看到的卡片；曝光和关闭重复请求幂等', async t => {
  const f = fixture(t), request = f.client();
  const feed = (await request('/api/feed')).data, card = feed.cards[0];
  assert.equal((await request('/api/event', { decisionId: card.decisionId, type: 'like' })).status, 409);
  await view(request, card); await view(request, card);
  assert.equal(f.app.impressions.get(card.decisionId).events.length, 1);
  assert.equal((await request('/api/event', { decisionId: card.decisionId, type: 'dwell', payload: { sec: 8 } })).status, 400);
  await request('/api/close', { feedId: feed.feedId }); await request('/api/close', { feedId: feed.feedId });
  assert.equal(settledCount(f.app), 1);
  assert.equal(f.app.impressions.get(card.decisionId).decision.reward, 0);
  const before = structuredClone(f.app.allocator.post);
  await f.restart(); assert.deepEqual(f.app.allocator.post, before);
});

test('同会话两个标签页的刷新、关闭和流权限相互独立', async t => {
  const f = fixture(t), request = f.client(), other = f.client();
  const a = (await request('/api/feed')).data, b = (await request('/api/feed')).data;
  assert.notEqual(a.feedId, b.feedId);
  assert.equal(f.app.impressions.get(a.cards[0].decisionId).closed, false);
  assert.equal((await request('/api/close', {})).status, 400);
  assert.equal((await other('/api/close', { feedId: a.feedId })).status, 404);
  const bCard = b.cards.find(c => c.scene.scene.some(block => block.data));
  const block = bCard.scene.scene.find(block => block.data);
  const query = new URLSearchParams({ id: block.data, component: block.resolved, decisionId: bCard.decisionId });
  await request('/api/snapshot?' + query);
  await request('/api/close', { feedId: a.feedId });
  assert.equal((await request('/api/snapshot?' + query)).status, 200);
  const a2 = (await request('/api/feed?replace=' + a.feedId)).data;
  await request('/api/close', { feedId: a.feedId }); // late beacon from old document
  assert.equal(f.app.impressions.get(a2.cards[0].decisionId).closed, false);
  await view(request, bCard);
  assert.equal((await request('/api/followup', { decisionId: bCard.decisionId, question: '解释一下' })).status, 200);
});

test('客户端不能领取追问奖励；失败回答零奖励，成功请求重试不重复执行', async t => {
  const f = fixture(t), request = f.client();
  const card = (await request('/api/feed')).data.cards[0];
  await view(request, card);
  assert.equal((await request('/api/event', { decisionId: card.decisionId, type: 'followup' })).status, 403);
  const agent = AGENTS[card.agent.id], original = agent.answer;
  let calls = 0;
  try {
    agent.answer = () => ({ component: 'quote@1', props: { text: '虚构引文', source: '民调汇总' } });
    const bad = await request('/api/followup', { decisionId: card.decisionId, question: '解释一下' });
    assert.equal(bad.data.block, null); assert.equal(settledCount(f.app), 0);
    agent.answer = () => { calls++; return { component: 'quote@1', props: { text: '差距缩小主要来自独立选民的回流，而不是基本盘的流失。', source: '民调汇总' } }; };
    const payload = { decisionId: card.decisionId, question: '解释一下', eventId: 'followup-request-1' };
    const first = await request('/api/followup', payload), second = await request('/api/followup', payload);
    assert.deepEqual(first.data, second.data); assert.equal(calls, 1);
    assert.equal(f.app.impressions.get(card.decisionId).decision.reward, .9);
  } finally { agent.answer = original; }
});

test('模拟实验不会修改读者后验、账本、缓存、审计日志与 OPE', async t => {
  const f = fixture(t), request = f.client();
  const feed = (await request('/api/feed')).data; await view(request, feed.cards[0]);
  await request('/api/event', { decisionId: feed.cards[0].decisionId, type: 'like' });
  const before = (await request('/api/leaderboard')).data, ope = (await request('/api/ope')).data;
  const audit = readFileSync(join(f.dir, 'events.jsonl'), 'utf8');
  const report = (await request('/api/sim', { readers: 25 })).data;
  assert.equal(report.dataset, 'synthetic'); assert.equal(report.impressions, 150);
  assert.ok(report.decisions.every(d => d.dataset === 'synthetic'));
  assert.deepEqual((await request('/api/leaderboard')).data, before);
  assert.deepEqual((await request('/api/ope')).data, ope);
  assert.equal(readFileSync(join(f.dir, 'events.jsonl'), 'utf8'), audit);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'simulations', report.runId + '.json'), 'utf8')).impressions, 150);
  await request('/api/close', { feedId: feed.feedId });
  await f.restart(); assert.equal(settledCount(f.app), 1);
});

test('v1 混合实验数据被保留归档，不自动导入新的读者模型', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'newsroom-migration-'));
  const old = { version: 1, post: { old: 'mixed' }, ledger: { agents: { hype: 100 } }, impressions: [] };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(old));
  const app = createNewsroom({ dataDir: dir, llm: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const archive = readdirSync(dir).find(name => name.startsWith('state-v1-archive-'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, archive), 'utf8')), old);
  assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).version, 3);
  assert.deepEqual(app.ledger.agents, {}); assert.equal(app.impressions.size, 0);
});

test('丢失信息流响应后按同一 requestId 重试不重复分配；参数冲突返回 409', async t => {
  const f = fixture(t), request = f.client();
  const a = await request('/api/feed?requestId=feed-once&reader=data');
  const b = await request('/api/feed?requestId=feed-once&reader=data');
  assert.deepEqual(a.data, b.data); assert.equal(f.app.impressions.size, 6);
  await view(request, a.data.cards[0]);
  await request('/api/followup', { decisionId: a.data.cards[0].decisionId, question: '解释一下', eventId: 'answer-after-feed' });
  assert.deepEqual((await request('/api/feed?requestId=feed-once&reader=data')).data, a.data);
  assert.equal((await request('/api/feed?requestId=feed-once&reader=hype')).status, 409);
  await request('/api/close', { feedId: a.data.feedId });
  assert.equal((await request('/api/feed?requestId=feed-once&reader=data')).status, 409);
});

test('换卡响应丢失后可安全重试，同一个原卡只产生一个新分配', async t => {
  const f = fixture(t), request = f.client();
  const card = (await request('/api/feed')).data.cards[0]; await view(request, card);
  const payload = { decisionId: card.decisionId, storyId: card.story.id, requestId: 'swap-once' };
  const a = await request('/api/swap', payload), b = await request('/api/swap', payload);
  assert.deepEqual(a.data, b.data); assert.equal(f.app.impressions.size, 7);
  assert.equal(settledCount(f.app), 1);
});

test('整页生成中途失败会清理部分分配并保持旧页面可用', async t => {
  const f = fixture(t), request = f.client();
  const first = (await request('/api/feed')).data;
  f.app.cache.clear();
  const originals = Object.fromEntries(Object.entries(AGENTS).map(([id, agent]) => [id, agent.build]));
  for (const [id, agent] of Object.entries(AGENTS)) agent.build = ctx => {
    if (ctx.story.id === 'nba') throw Object.assign(new Error('generation failed'), { status: 502 });
    return originals[id](ctx);
  };
  try {
    assert.equal((await request('/api/feed?requestId=replace-once&replace=' + first.feedId)).status, 502);
    assert.equal(f.app.impressions.size, 6); assert.equal(f.app.allocator.decisions.size, 6);
    assert.ok(first.cards.every(card => !f.app.impressions.get(card.decisionId).closed));
  } finally { for (const [id, agent] of Object.entries(AGENTS)) agent.build = originals[id]; }
  assert.equal((await request('/api/feed?requestId=replace-once&replace=' + first.feedId)).status, 200);
});

test('超时回答释放请求队列，迟到结果不修改卡片或奖励', async t => {
  const f = fixture(t, { agentTimeoutMs: 30 }), request = f.client();
  const card = (await request('/api/feed')).data.cards[0]; await view(request, card);
  const agent = AGENTS[card.agent.id], original = agent.answer;
  let finish;
  agent.answer = () => new Promise(resolve => { finish = resolve; });
  const count = f.app.impressions.get(card.decisionId).blocks.length;
  try {
    assert.equal((await request('/api/followup', { decisionId: card.decisionId, question: '解释', eventId: 'timeout' })).status, 504);
    assert.equal((await request('/api/event', { decisionId: card.decisionId, type: 'expand', eventId: 'after-timeout' })).status, 200);
    finish({ component: 'quote@1', props: { text: '京都的秘诀只有一个：比旅行团早一小时。', source: '旅行库' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.app.impressions.get(card.decisionId).blocks.length, count);
    assert.equal(f.app.impressions.get(card.decisionId).decision.reward, null);
  } finally { agent.answer = original; }
});

test('同一个事件或追问 ID 不允许用于不同内容', async t => {
  const f = fixture(t), request = f.client();
  const card = (await request('/api/feed')).data.cards[0]; await view(request, card);
  const event = { decisionId: card.decisionId, type: 'expand', eventId: 'event-once' };
  await request('/api/event', event);
  assert.equal((await request('/api/event', { ...event, type: 'like' })).status, 409);
  const payload = { decisionId: card.decisionId, question: '解释一下', eventId: 'question-once' };
  assert.equal((await request('/api/followup', payload)).status, 200);
  assert.equal((await request('/api/followup', { ...payload, question: '另一个问题' })).status, 409);
});

test('中文和 emoji 跨网络分块也能完整解析', async t => {
  const f = fixture(t), request = f.client();
  const card = (await request('/api/feed')).data.cards[0]; await view(request, card);
  const payload = { note: '中文和 🌏 表情不能被分块破坏' };
  const r = await request('/api/event', { decisionId: card.decisionId, type: 'like', payload }, { oneByte: true });
  assert.equal(r.status, 200);
  assert.deepEqual(f.app.impressions.get(card.decisionId).events.at(-1).payload, payload);
});

test('首屏六张卡并行准备，完成前不关闭旧页', async t => {
  const f = fixture(t), request = f.client();
  const first = (await request('/api/feed')).data;
  f.app.cache.clear();
  const originals = Object.fromEntries(Object.entries(AGENTS).map(([id, agent]) => [id, agent.build]));
  const waiting = [];
  for (const [id, agent] of Object.entries(AGENTS)) agent.build = ctx => new Promise(resolve => { waiting.push(() => resolve(originals[id](ctx))); });
  const pending = request('/api/feed?replace=' + first.feedId);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.length, 6);
    assert.ok(first.cards.every(card => !f.app.impressions.get(card.decisionId).closed));
    waiting.forEach(resolve => resolve());
    assert.equal((await pending).status, 200);
    assert.ok(first.cards.every(card => f.app.impressions.get(card.decisionId).closed));
  } finally {
    waiting.forEach(resolve => resolve()); await pending;
    for (const [id, agent] of Object.entries(AGENTS)) agent.build = originals[id];
  }
});

test('分群统计与 OPE 过滤正确，v2 升级从已有反馈恢复分群后验', async t => {
  const f = fixture(t), request = f.client();
  f.app.allocator.propensities = (_topic, pool) => Object.fromEntries(f.app.allocator.agents.map(a => [a, a === pool[0] ? 1 : 0]));
  const data = (await request('/api/feed?reader=data')).data.cards[0];
  const hype = (await request('/api/feed?reader=hype')).data.cards[0];
  assert.equal(data.agent.id, hype.agent.id);
  await view(request, data); await view(request, hype);
  await request('/api/event', { decisionId: data.decisionId, type: 'like' });
  await request('/api/event', { decisionId: hype.decisionId, type: 'skip' });
  const group = async reader => (await request('/api/leaderboard?reader=' + reader)).data;
  const cell = report => report.table.find(row => row.topic === data.story.topic).cells.find(c => c.agent === data.agent.id);
  const dataReport = await group('data'), hypeReport = await group('hype');
  assert.equal(cell(dataReport).mean, 2 / 3); assert.equal(cell(hypeReport).mean, 1 / 3);
  assert.equal(cell(await group('skim')).n, 0);
  assert.equal(cell(await group('all')).n, 2);
  assert.equal((await request('/api/ope?reader=data')).data.logged, 1);
  assert.equal((await request('/api/ope?reader=hype')).data.logged, 1);
  assert.equal((await request('/api/ope')).data.logged, 2);
  assert.equal((await request('/api/leaderboard?reader=invalid')).status, 400);
  assert.equal((await request('/api/ope?reader=invalid')).status, 400);
  const ledger = structuredClone(f.app.ledger);
  await f.restart({ asV2: true });
  assert.equal(cell(await group('data')).mean, 2 / 3);
  assert.equal(cell(await group('hype')).mean, 1 / 3);
  assert.deepEqual(structuredClone(f.app.ledger), ledger);
  assert.equal(JSON.parse(readFileSync(join(f.dir, 'state.json'), 'utf8')).version, 3);
  const post = structuredClone(f.app.allocator.contextPost);
  await f.restart(); assert.deepEqual(f.app.allocator.contextPost, post);
});
