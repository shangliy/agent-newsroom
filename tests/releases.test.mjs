import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ReleaseNewsroom, normalizeReleases } from '../server/ingest/releases.mjs';
import { createNewsroom } from '../server/index.mjs';

const repo = 'langchain-ai/langgraph';
const release = (changes = {}) => ({ id: 101, name: 'LangGraph v1', tag_name: 'v1', body: 'Initial notes',
  html_url: `https://github.com/${repo}/releases/tag/v1`, published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false, ...changes });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-newsroom-'));
  let time = Date.parse('2026-01-02T00:00:00Z'), calls = 0, handler = () => new Response(JSON.stringify([release()]), { headers: { etag: 'one' } });
  const options = { path: join(dir, 'releases.sqlite'), now: () => time, intervalMs: 60000,
    fetchImpl: async (...args) => { calls++; return handler(...args); } };
  let room = new ReleaseNewsroom(options);
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup) await fn(); await room.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, cleanup, get room() { return room; }, get calls() { return calls; }, options,
    advance(ms = 60001) { time += ms; }, respond(fn) { handler = fn; },
    async restart() { await room.close(); room = new ReleaseNewsroom(options); } };
}

test('自动收录、去重、更正、保留证据和重启恢复；不依赖读者', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.room.poll(), { changed: 1, notModified: false });
  assert.equal(f.room.changes()[0].kind, 'first-observed');
  assert.equal(f.room.changes()[0].evidence.publishedAt, '2026-01-01T00:00:00.000Z');
  f.advance(); assert.equal((await f.room.poll()).changed, 0);
  f.respond(() => new Response(JSON.stringify([release({ body: 'Corrected notes', tag_name: 'v1-fixed' })])));
  f.advance(); assert.equal((await f.room.poll()).changed, 1);
  const card = f.room.changes()[0];
  assert.equal(card.revision, 2); assert.equal(card.kind, 'corrected');
  assert.deepEqual(card.changes.map(c => c.field), ['tag', 'bodyHash']);
  await f.restart();
  assert.equal(f.room.changes().length, 1); assert.equal(f.room.history('101').length, 2);
  assert.equal(f.room.history('101')[1].evidence.tag, 'v1');
  assert.deepEqual(await f.room.poll(), { skipped: true });
});

test('304 不生成新版本，ETag 只随成功事务保存', async t => {
  const f = fixture(t); await f.room.poll(); f.advance();
  f.respond((url, options) => {
    assert.equal(options.headers['if-none-match'], 'one'); assert.equal(options.redirect, 'error');
    assert.ok(options.signal); return new Response(null, { status: 304 });
  });
  assert.deepEqual(await f.room.poll(), { changed: 0, notModified: true });
  assert.equal(f.room.history('101').length, 1);
});

test('异常批次原子拒绝，不覆盖旧版；自动退避在重启后继续', async t => {
  const f = fixture(t); await f.room.poll(); f.advance();
  f.respond(() => new Response(JSON.stringify([release({ name: 'new' }), release({ id: 102, published_at: 'bad' })]), { headers: { etag: 'bad' } }));
  assert.match((await f.room.poll()).error, /date/);
  assert.equal(f.room.changes()[0].evidence.title, 'LangGraph v1');
  assert.equal(f.room.source().etag, 'one');
  const next = f.room.status().nextAttempt; await f.restart();
  assert.equal(f.room.status().nextAttempt, next); assert.deepEqual(await f.room.poll(), { skipped: true });
  f.respond(() => new Response(JSON.stringify([release({ name: 'new' })]))); f.advance();
  assert.equal((await f.room.poll()).changed, 1); assert.equal(f.room.status().failures, 0);
});

test('事务写入失败不出现部分版本或错误 ETag', async t => {
  const f = fixture(t); await f.room.poll(); f.advance();
  f.room.db.exec("CREATE TRIGGER fail_publication BEFORE INSERT ON publications WHEN NEW.release_id='102' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END");
  f.respond(() => new Response(JSON.stringify([release({ name: 'new' }), release({ id: 102 })]), { headers: { etag: 'two' } }));
  assert.match((await f.room.poll()).error, /disk simulation/);
  assert.equal(f.room.history('101').length, 1); assert.equal(f.room.history('102').length, 0);
  assert.equal(f.room.source().etag, 'one');
});

test('并发轮询共享一次调用，过期 worker 不能提交', async t => {
  const f = fixture(t); let complete;
  f.respond(() => new Promise(resolve => { complete = resolve; }));
  const a = f.room.poll(), b = f.room.poll(); assert.equal(f.calls, 1);
  f.advance(); complete(new Response(JSON.stringify([release()])));
  assert.match((await a).error, /lease/); await b;
  assert.equal(f.room.changes().length, 0);
});

test('其他实例不能抢占活跃租约；崩溃遗留任务自动恢复', async t => {
  const f = fixture(t), second = new ReleaseNewsroom(f.options);
  f.cleanup.push(() => second.close());
  f.room.db.prepare("INSERT INTO runs(id,started,status) VALUES('crashed',?,'running')").run(f.options.now());
  f.room.db.prepare("UPDATE source SET lease='crashed',lease_until=?").run(f.options.now() + 60000);
  assert.deepEqual(await second.poll(), { skipped: true });
  f.advance(); assert.equal((await second.poll()).changed, 1);
  assert.equal(second.db.prepare("SELECT status FROM runs WHERE id='crashed'").get().status, 'interrupted');
});

test('限制来源、响应体和限流；缺席不当作删除', async t => {
  assert.throws(() => normalizeReleases([release({ html_url: 'https://evil.test/inject' })], repo), /URL/);
  assert.throws(() => normalizeReleases([release({ draft: true })], repo), /state/);
  const f = fixture(t); await f.room.poll(); f.advance();
  f.respond(() => new Response('blocked', { status: 429, headers: { 'retry-after': '3600' } }));
  await f.room.poll(); assert.equal(f.room.status().nextAttempt, f.options.now() + 3600000);
  f.advance(3600001); f.respond(() => new Response('x'.repeat(2 * 1024 * 1024 + 1)));
  assert.match((await f.room.poll()).error, /2 MB/);
  f.advance(120001); f.respond(() => new Response('[]')); await f.room.poll();
  assert.equal(f.room.changes().length, 1);
});

test('真实 HTTP handler 提供来源修订、历史与状态，平台首页与来源示例分开', async t => {
  const f = fixture(t); await f.room.poll();
  const app = createNewsroom({ dataDir: f.dir, llm: false, newsroom: f.room });
  f.cleanup.push(() => app.close());
  async function request(url) {
    const req = Object.assign(Readable.from([]), { url, method: 'GET', headers: { host: 'localhost' } });
    let body = '', status = 200;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(s) { body = s; } };
    await app.server.listeners('request')[0](req, res); return { status, body };
  }
  assert.equal(JSON.parse((await request('/api/changes')).body).publications[0].revision, 1);
  assert.equal(JSON.parse((await request('/api/system/status')).body).enabled, true);
  assert.equal(JSON.parse((await request('/api/publication-history?id=101')).body).revisions.length, 1);
  assert.equal((await request('/api/publication-history?id=bad')).status, 400);
  assert.equal((await request('/api/publication-history?id=999')).status, 404);
  assert.match(String((await request('/')).body), /Find your next rabbit hole/);
  assert.match(String((await request('/changes.html')).body), /技术变化/);
});
