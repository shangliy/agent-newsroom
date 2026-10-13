import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PublisherClient } from '../integrations/publisher.mjs';
import { createRpc } from '../integrations/mcp-stdio.mjs';
import { createNewsroom } from '../server/index.mjs';
import { validatePublication } from '../server/publishing/protocol.mjs';
const document = { protocol: 'agent-publication/0.1', contentId: 'bridge-test', revision: 1, action: 'publish', title: '测试', summary: '虚构测试', language: 'zh-CN', evidence: [], blocks: [{ id: 'text', type: 'text', mode: 'fiction', text: '故事' }] };

test('MCP 初始化、发布幂等、修订、跨身份拒绝、撤回和吊销凭据', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-bridge-'));
  const client = new PublisherClient({ localDir: dir }); t.after(() => { client.close(); rmSync(dir, { recursive: true, force: true }); });
  client.token = (await client.request('/api/v1/agents', { name: 'bridge' })).token;
  const rpc = createRpc(client), call = (name, args = {}) => rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  assert.ok((await call('get_protocol')).error);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).result.protocolVersion, '2025-11-25');
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await call('validate_post', { document })).result.structuredContent.valid, true);
  assert.equal(client.store.rows().length, 0);
  const first = (await call('publish_post', { document })).result.structuredContent;
  assert.match(first.url, /\/p\//);
  assert.equal((await call('publish_post', { document })).result.structuredContent.replayed, true);
  assert.equal((await call('publish_post', { document: { ...document, title: 'conflict' } })).result.isError, true);
  await call('publish_post', { document: { ...document, revision: 2 } });
  const token = client.token; client.token = (await client.request('/api/v1/agents', { name: 'other' })).token;
  assert.equal((await call('retract_post', { contentId: document.contentId, revision: 3, reason: 'attack' })).result.isError, true);
  client.token = token;
  await call('retract_post', { contentId: document.contentId, revision: 3, reason: 'withdraw' });
  assert.equal((await call('get_post', { publicationId: first.publicationId })).result.structuredContent.publication.action, 'retract');
  await client.request('/api/v1/revoke', {});
  assert.equal((await call('publish_post', { document: { ...document, revision: 4 } })).result.structuredContent.code, 'INVALID_CREDENTIAL');
});

test('独立文章页面、按 ID 查询、校验和令牌吊销通过真实 handler', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'publisher-page-')), app = createNewsroom({ dataDir: dir, platformOnly: true, llm: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = app.publishing.register({ name: 'page-agent' }, 'test');
  const row = app.publishing.submit(app.publishing.authenticate(`Bearer ${agent.token}`), document);
  async function request(url, data, token) {
    const req = Object.assign(Readable.from(data ? [JSON.stringify(data)] : []), { url, method: data ? 'POST' : 'GET', headers: { host: 'localhost', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const result = { status: 200 }; const res = { setHeader() {}, writeHead(s) { result.status = s; }, end(v) { result.body = String(v || ''); } };
    await app.server.listeners('request')[0](req, res); return result;
  }
  assert.match((await request('/p/' + row.publicationId)).body, /platform.js/);
  assert.equal(JSON.parse((await request('/api/v1/post?id=' + row.publicationId)).body).publication.document.title, '测试');
  assert.equal((await request('/api/v1/validate', document)).status, 200);
  assert.equal((await request('/p/00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await request('/api/v1/revoke', {}, agent.token)).status, 200);
  assert.equal((await request('/api/v1/publications', { ...document, revision: 2 }, agent.token)).status, 401);
});

test('首发内容全部通过协议校验，保留真实来源或虚构标签', () => {
  for (const file of readdirSync('content/launch-2026-10-12')) {
    const doc = JSON.parse(readFileSync(join('content/launch-2026-10-12', file), 'utf8')); validatePublication(doc);
    if (doc.origin.kind === 'web') assert.ok(doc.evidence.length);
    else assert.match(doc.title, /虚构/);
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 32768);
  }
});
