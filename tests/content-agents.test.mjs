import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalize, collect, names } from '../agents/content/sources.mjs';
import { compose } from '../agents/content/compose.mjs';
import { fixtures } from '../agents/content/fixtures.mjs';
import { ProducerState, runAgent, platformOrigin } from '../agents/content/runtime.mjs';
import { jsonRequest, AgentError } from '../agents/content/http.mjs';
import { protocol, validatePublication } from '../server/publishing/protocol.mjs';
import { PublishingStore } from '../server/publishing/store.mjs';
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('五个生产器生成合法发布包，未读全文和虚构经历明确标注', async () => {
  for (const kind of Object.keys(names)) {
    const items = normalize(kind, fixtures[kind]); assert.equal(items.length, 1, kind);
    const doc = await compose(kind, items[0], { env: {} }); validatePublication(doc);
    assert.equal(doc.origin.kind, kind === 'travel' ? 'original' : 'web');
    if (kind !== 'travel') assert.equal(doc.evidence[0].url, items[0].url);
    if (kind === 'papers') assert.equal(doc.evidence[1].id, 'code');
    if (kind === 'travel') assert.match(doc.title, /Fiction/);
    assert.ok(doc.blocks.some(b => b.text?.includes('Metadata/material summary')));
  }
});

test('来源适配器使用指定服务端点、鉴权与热榜范围，新闻支持嵌套条目', async () => {
  const urls = [];
  for (const kind of ['papers', 'twitter', 'news', 'youtube']) {
    const items = await collect(kind, { env: { X_BEARER_TOKEN: 'secret-x', SERPAPI_API_KEY: 'secret-news', YOUTUBE_API_KEY: 'secret-youtube', YOUTUBE_REGION: 'CA' }, fetcher: async (url, options) => {
      const u = new URL(url); urls.push(u); assert.equal(options.redirect, 'error');
      if (kind === 'twitter') { assert.equal(options.headers.authorization, 'Bearer secret-x'); assert.equal(u.searchParams.get('max_results'), '100'); }
      if (kind === 'youtube') assert.equal(u.searchParams.get('chart'), 'mostPopular');
      return response(fixtures[kind]);
    } });
    assert.equal(items.length, 1);
  }
  assert.deepEqual(urls.map(u => u.hostname), ['huggingface.co', 'api.x.com', 'serpapi.com', 'www.googleapis.com']);
  assert.equal(normalize('news', { news_results: [{ stories: fixtures.news.news_results }, { highlight: fixtures.news.news_results[0] }] }).length, 1);
  const hf = { ...fixtures.papers[0], githubRepo: 'https://github.com/example/top-level-code' };
  assert.equal(normalize('papers', [hf])[0].code, hf.githubRepo);
  const raw = structuredClone(fixtures.twitter); raw.data.push({ ...raw.data[0], id: '2', public_metrics: { like_count: 500 } });
  assert.equal(normalize('twitter', raw)[0].id, '2');
  await assert.rejects(collect('youtube', { env: {} }), e => e.code === 'CONFIG');
  assert.throws(() => normalize('news', { error: 'provider error' }), e => e.code === 'SCHEMA');
});

test('旅行素材没有公开授权、授权过期或照片非法时拒绝生成', () => {
  for (const mutate of [p => { p.authorization.public = false; }, p => { p.authorization.expiresAt = '2000-01-01'; }, p => { p.photos = [{ url: 'file:///private/photo', alt: 'x' }]; }]) {
    const raw = structuredClone(fixtures.travel); mutate(raw.entries[0]); assert.throws(() => normalize('travel', raw));
  }
});

test('模型只修改文案，引用与身份由程序绑定；坏输出不发布', async () => {
  const item = normalize('papers', fixtures.papers)[0], env = { ANTHROPIC_API_KEY: 'secret', LLM_MODEL: 'configured-model' };
  const doc = await compose('papers', item, { env, fetcher: async (url, options) => {
    const request = JSON.parse(options.body); assert.match(request.system, /untrusted source material/);
    return response({ content: [{ type: 'text', text: JSON.stringify({ title: '论文导读', summary: '基于摘要', text: '作者讨论了记忆机制。', evidence: [{ url: 'https://attacker.example' }] }) }] });
  } });
  assert.equal(doc.evidence[0].url, item.url); assert.equal(doc.blocks[0].mode, 'analysis');
  await assert.rejects(compose('papers', item, { env, fetcher: async () => response({ content: [{ type: 'text', text: 'not-json' }] }) }), e => e.code === 'MODEL_OUTPUT');
});

test('持久化发件箱在服务端已接收但断网后幂等恢复；去重、修订和平台绑定', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'producer-test-')), origin = 'http://localhost:8787'; let now = 1000;
  const store = new PublishingStore(join(dir, 'server.sqlite')); let state = new ProducerState(join(dir, 'client'), origin, () => now);
  t.after(() => { state.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  let dropped = false, composeCalls = 0, item = normalize('papers', fixtures.papers)[0];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/protocol')) return response(protocol);
    if (path.endsWith('/agents')) return response(store.register(JSON.parse(options.body), 'test'), 201);
    const agent = store.authenticate(options.headers.authorization), result = store.submit(agent, JSON.parse(options.body));
    if (!dropped) { dropped = true; throw Error('connection lost after commit'); }
    return response(result, result.replayed ? 200 : 201);
  };
  const options = () => ({ state, origin, env: {}, now: () => now, collector: async () => [item], composer: async (...args) => { composeCalls++; return compose(...args); }, fetcher });
  assert.equal((await runAgent('papers', options())).status, 'error'); assert.equal(store.rows().length, 1); assert.ok(state.read('papers').pending);
  assert.equal((await runAgent('papers', options())).status, 'backoff');
  assert.throws(() => new ProducerState(join(dir, 'client'), origin, () => now), e => e.code === 'LOCKED');
  state.close(); now += 61000; state = new ProducerState(join(dir, 'client'), origin, () => now);
  assert.equal((await runAgent('papers', options())).status, 'ok'); assert.equal(store.rows()[0].revision, 1); assert.equal(composeCalls, 1);
  item = { ...item, title: 'New title' }; await runAgent('papers', options()); assert.equal(store.rows()[0].revision, 2);
  assert.equal((await runAgent('papers', options())).published, 0);
  assert.throws(() => new ProducerState(join(dir, 'client'), 'https://different.example'), e => e.code === 'ORIGIN');
});

test('HTTP 限流遵守 Retry-After，不泄露密钥；不接受远程明文发布地址', async () => {
  await assert.rejects(jsonRequest('https://example.com?key=secret', {}, async () => response({}, 429, { 'retry-after': '3600' })), e => e.retryAfter === 3600 && !e.message.includes('secret'));
  await assert.rejects(jsonRequest('https://example.com?key=secret', {}, async () => { throw Error('secret'); }), e => e instanceof AgentError && !e.message.includes('secret'));
  assert.throws(() => platformOrigin('http://example.com')); assert.throws(() => platformOrigin('https://example.com/api'));
  assert.equal(platformOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
});
