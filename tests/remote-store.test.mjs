import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePublishingStore } from '../server/publishing/remote-store.mjs';
import { PublishingStore } from '../server/publishing/store.mjs';
import { VERSION } from '../server/publishing/protocol.mjs';
import { createNewsroom } from '../server/index.mjs';

const publication = (overrides = {}) => ({ protocol: VERSION, contentId: 'first', revision: 1, action: 'publish', title: 'A story', summary: 'Creative example', language: 'zh-CN',
  blocks: [{ id: 'intro', type: 'text', mode: 'fiction', text: 'A city of agents.' }], evidence: [], ...overrides });
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('libSQL 存储与 SQLite 存储行为一致：注册、配额、发布、重放、冲突、撤回、吊销', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-store-'));
  const remote = new RemotePublishingStore({ url: 'file:' + join(dir, 'remote.sqlite') }), local = new PublishingStore(join(dir, 'local.sqlite'));
  t.after(() => { remote.close(); local.close(); rmSync(dir, { recursive: true, force: true }); });
  await rejects(remote.register({ name: '' }, 'origin'), 'INVALID_AGENT');
  const credential = await remote.register({ name: 'writer' }, 'origin');
  assert.match(credential.token, /^[A-Za-z0-9_-]{43}$/);
  for (let i = 0; i < 4; i++) await remote.register({ name: 'other' }, 'origin');
  await rejects(remote.register({ name: 'sixth' }, 'origin'), 'REGISTRATION_LIMIT');
  await rejects(remote.authenticate('Bearer ' + 'x'.repeat(43)), 'INVALID_CREDENTIAL');
  const agent = await remote.authenticate('Bearer ' + credential.token);
  assert.equal(agent.name, 'writer');

  const first = await remote.submit(agent, publication());
  assert.equal(first.replayed, false); assert.equal(first.revision, 1);
  const replay = await remote.submit(agent, publication());
  assert.deepEqual([replay.replayed, replay.currentRevision], [true, 1]);
  await rejects(remote.submit(agent, publication({ title: 'Changed' })), 'REVISION_CONFLICT');
  await rejects(remote.submit(agent, publication({ revision: 3 })), 'REVISION_SEQUENCE');
  await rejects(remote.submit(agent, { protocol: VERSION, contentId: 'unknown', revision: 1, action: 'retract', reason: 'x' }), 'NOT_PUBLISHED');
  const second = await remote.submit(agent, publication({ revision: 2, title: 'Revised' }));
  assert.equal(second.currentRevision, 2);
  const list = await remote.rows();
  assert.equal(list.length, 1); assert.equal(list[0].document.title, 'Revised'); assert.equal(list[0].revision, 2);
  assert.equal(typeof list[0].createdAt, 'number');
  const history = await remote.rows(first.publicationId);
  assert.deepEqual(history.map(r => r.revision), [2, 1]);
  await rejects(remote.get('nope'), 'INVALID_ID');
  await rejects(remote.get('00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
  assert.equal((await remote.get(first.publicationId)).revision, 2);

  // Same inputs through the SQLite store produce the same shapes.
  const localAgent = local.authenticate('Bearer ' + local.register({ name: 'writer' }, 'origin').token);
  local.submit(localAgent, publication()); local.submit(localAgent, publication({ revision: 2, title: 'Revised' }));
  const [a, b] = [list[0], local.rows()[0]];
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.deepEqual([a.revision, a.action, a.document.title, a.agent.name], [b.revision, b.action, b.document.title, b.agent.name]);

  await remote.revoke(agent);
  await rejects(remote.authenticate('Bearer ' + credential.token), 'INVALID_CREDENTIAL');
});

test('服务器可注入异步存储，并按可信代理头统计注册来源', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-server-'));
  const publishing = new RemotePublishingStore({ url: 'file:' + join(dir, 'remote.sqlite') });
  const previous = process.env.TRUST_PROXY_HEADER; process.env.TRUST_PROXY_HEADER = 'x-real-ip';
  const app = createNewsroom({ dataDir: dir, platformOnly: true, publishing });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { process.env.TRUST_PROXY_HEADER = previous; await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const register = ip => fetch(base + '/api/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify({ name: 'a' }) });
  for (let i = 0; i < 5; i++) assert.equal((await register('203.0.113.1')).status, 201);
  assert.equal((await register('203.0.113.1')).status, 429);
  const other = await register('203.0.113.2');
  assert.equal(other.status, 201);
  const { token } = await other.json();
  const posted = await fetch(base + '/api/v1/publications', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(publication()) });
  assert.equal(posted.status, 201);
  const { publicationId } = await posted.json();
  assert.equal((await (await fetch(base + '/api/v1/publications')).json()).publications.length, 1);
  assert.equal((await fetch(base + '/p/' + publicationId)).status, 200);
  assert.equal((await fetch(base + '/api/v1/history?id=' + publicationId)).status, 200);
  assert.equal((await fetch(base + '/api/v1/post?id=' + publicationId)).status, 200);
});
