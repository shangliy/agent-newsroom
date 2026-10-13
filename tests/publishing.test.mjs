import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PublishingStore } from '../server/publishing/store.mjs';
import { VERSION, validatePublication } from '../server/publishing/protocol.mjs';
import { createNewsroom } from '../server/index.mjs';

function publication(overrides = {}) {
  return { protocol: VERSION, contentId: 'first', revision: 1, action: 'publish', title: 'A story', summary: 'Creative example', language: 'zh-CN',
    blocks: [{ id: 'intro', type: 'text', mode: 'fiction', text: 'A city of agents.' }], evidence: [], ...overrides };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-publishing-')), path = join(dir, 'publishing.sqlite');
  let store = new PublishingStore(path); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const credential = store.register({ name: 'writer' }, 'origin');
  return { get store() { return store; }, credential, get agent() { return store.authenticate('Bearer ' + credential.token); },
    restart() { store.close(); store = new PublishingStore(path); } };
}

test('创作不强制外部证据，事实/分析/引文要求有效引用', () => {
  assert.equal(validatePublication(publication()).blocks[0].mode, 'fiction');
  for (const type of ['fact', 'analysis']) {
    const p = publication(); p.blocks[0].mode = type;
    assert.throws(() => validatePublication(p), e => e.path === '$.blocks[0].evidenceIds');
    p.blocks[0].evidenceIds = ['source']; p.evidence = [{ id: 'source', url: 'https://example.com', label: 'source' }];
    assert.doesNotThrow(() => validatePublication(p));
    p.blocks[0].evidenceIds = ['missing']; assert.throws(() => validatePublication(p));
  }
  const quote = publication(); quote.blocks[0].type = 'quote'; assert.throws(() => validatePublication(quote));
});

test('多样内容与自定义组件有标准降级，拒绝代码、非法 URL 和畸形数据', () => {
  const p = publication({ blocks: [
    { id: 'table', type: 'table', mode: 'fiction', columns: ['name', 'n'], rows: [['a', 2]] },
    { id: 'chart', type: 'chart', mode: 'fiction', chartType: 'bar', unit: 'count', points: [{ label: 'a', value: 2 }] },
    { id: 'media', type: 'media', mode: 'fiction', mediaType: 'image', url: 'https://example.com/image', alt: 'example' },
    { id: 'custom', type: 'component', mode: 'fiction', component: 'story-map@1.0.0', props: { zoom: 2 }, fallback: [{ id: 'fallback', type: 'text', mode: 'fiction', text: 'A map in words' }] },
  ], extensions: { 'example.agent': { style: 'minimal' } } });
  assert.doesNotThrow(() => validatePublication(p));
  const mutate = fn => { const copy = structuredClone(p); fn(copy); assert.throws(() => validatePublication(copy)); };
  mutate(p => { p.blocks[0].rows = [['x']]; });
  mutate(p => { p.blocks[1].points[0].value = NaN; });
  mutate(p => { p.blocks[2].url = 'javascript:alert(1)'; });
  mutate(p => { p.blocks[3].fallback = []; });
  mutate(p => { p.blocks[3].code = 'fetch()'; });
  mutate(p => { p.blocks[3].fallback[0].id = 'chart'; });
});

test('凭据身份隔离，发布幂等、顺序修订、撤回和重启恢复', t => {
  const f = fixture(t), doc = publication();
  assert.throws(() => f.store.authenticate('Bearer fake'), e => e.status === 401);
  const result = f.store.submit(f.agent, doc);
  assert.equal(f.store.submit(f.agent, { ...doc, summary: doc.summary }).replayed, true);
  assert.throws(() => f.store.submit(f.agent, { ...doc, title: 'different' }), e => e.code === 'REVISION_CONFLICT');
  assert.throws(() => f.store.submit(f.agent, { ...doc, revision: 3 }), e => e.code === 'REVISION_SEQUENCE');
  const otherKey = f.store.register({ name: 'other' }, 'other-origin');
  const other = f.store.authenticate('Bearer ' + otherKey.token);
  assert.throws(() => f.store.submit(other, { protocol: VERSION, contentId: doc.contentId, revision: 1, action: 'retract', reason: 'attack' }), e => e.code === 'NOT_PUBLISHED');
  assert.notEqual(f.store.submit(other, doc).publicationId, result.publicationId);
  f.store.submit(f.agent, { ...doc, revision: 2, title: 'corrected' });
  const retract = { protocol: VERSION, contentId: doc.contentId, revision: 3, action: 'retract', reason: 'source issue' };
  f.store.submit(f.agent, retract); f.restart();
  assert.equal(f.store.rows(result.publicationId)[0].action, 'retract');
  assert.equal(f.store.rows(result.publicationId).length, 3);
  const replay = f.store.submit(f.agent, doc); assert.equal(replay.currentRevision, 3); assert.equal(replay.currentAction, 'retract');
  assert.equal(f.store.submit(f.agent, retract).replayed, true);
  const stored = f.store.db.prepare('SELECT token_hash FROM publisher_agents WHERE id=?').get(f.agent.id);
  assert.notEqual(stored.token_hash, f.credential.token);
});

test('发布事务失败不留下空内容；限额不阻止撤回', t => {
  const f = fixture(t);
  f.store.db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON publication_revisions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => f.store.submit(f.agent, publication()), /test failure/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM agent_publications').get().n, 0);
  f.store.db.exec('DROP TRIGGER fail_revision');
  for (let i = 1; i <= 60; i++) f.store.submit(f.agent, publication({ revision: i }));
  assert.throws(() => f.store.submit(f.agent, publication({ revision: 61 })), e => e.status === 429);
  assert.equal(f.store.submit(f.agent, { protocol: VERSION, contentId: 'first', revision: 61, action: 'retract', reason: 'withdraw' }).action, 'retract');
});

test('HTTP 端到端 handler：自动注册到发布、公开读取、机器可读拒绝', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'publishing-http-')); const app = createNewsroom({ dataDir: dir, llm: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(url, data, token) {
    const req = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []), { url, method: data ? 'POST' : 'GET', headers: { host: 'localhost', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
    let text = '', status = 200; const res = { setHeader() {}, writeHead(s) { status = s; }, end(value) { text = value; } };
    await app.server.listeners('request')[0](req, res); return { status, data: JSON.parse(text) };
  }
  const catalog = await request('/api/v1/protocol'); assert.equal(catalog.data.protocol, VERSION);
  const agent = (await request('/api/v1/agents', { name: 'test-agent' })).data;
  assert.equal((await request('/api/v1/publications', publication())).status, 401);
  const first = await request('/api/v1/publications', publication(), agent.token); assert.equal(first.status, 201);
  assert.equal((await request('/api/v1/publications', publication(), agent.token)).status, 200);
  const invalid = publication(); invalid.blocks[0].mode = 'fact';
  const bad = await request('/api/v1/publications', invalid, agent.token);
  assert.equal(bad.status, 422); assert.equal(bad.data.path, '$.blocks[0].evidenceIds');
  assert.equal((await request('/api/v1/publications')).data.publications.length, 1);
  assert.equal((await request('/api/v1/history?id=' + first.data.publicationId)).data.revisions.length, 1);
  for (let i = 0; i < 4; i++) assert.equal((await request('/api/v1/agents', { name: 'test' })).status, 201);
  assert.equal((await request('/api/v1/agents', { name: 'excess' })).status, 429);
});
