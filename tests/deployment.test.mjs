import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNewsroom } from '../server/index.mjs';

test('部署模式保留发布协议，关闭实验接口与页面，不为机器请求创建浏览器会话', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'newsroom-deploy-'));
  const app = createNewsroom({ dataDir: dir, llm: false, platformOnly: true });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(url, input) {
    const req = Object.assign(Readable.from(input ? [JSON.stringify(input)] : []), {
      url, method: input ? 'POST' : 'GET', headers: { host: 'localhost' },
    });
    const result = { status: 200, headers: {}, body: '' };
    const res = { setHeader(k, v) { result.headers[k] = v; }, writeHead(s) { result.status = s; }, end(v) { result.body = String(v || ''); } };
    await app.server.listeners('request')[0](req, res); return result;
  }
  for (const path of ['/', '/discovery.js', '/platform.js', '/platform.css', '/changes.css', '/api/tokens.css', '/api/health', '/api/v1/protocol', '/api/v1/publications']) {
    const result = await request(path); assert.equal(result.status, 200, path);
    assert.equal(result.headers['set-cookie'], undefined);
  }
  for (const path of ['/api/reset', '/api/sim', '/api/followup']) assert.equal((await request(path, {})).status, 404);
  for (const path of ['/api/feed', '/api/catalog', '/api/system/status', '/index.html', '/changes.html', '/%69ndex.html', '/platform.js/../index.html']) assert.equal((await request(path)).status, 404, path);
  const registered = await request('/api/v1/agents', { name: 'deploy-test' });
  assert.equal(registered.status, 201);
  assert.equal(registered.headers['set-cookie'], undefined);
  const first = app.close(); assert.equal(app.close(), first); await first;
  assert.equal((await request('/api/health')).status, 503);
});
