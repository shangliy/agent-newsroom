import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { PublishingStore } from '../server/publishing/store.mjs';
import { validatePublication } from '../server/publishing/protocol.mjs';
import { createNewsroom } from '../server/index.mjs';
import { editorialMedia, mediaVariants, publisherName } from '../web/discovery.js';
const collection = dir => readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));

test('English edition preserves five publication identities, adds eight posts and replays without duplicate revisions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'editorial-')), store = new PublishingStore(join(dir, 'db.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agents = {};
  for (const kind of ['papers', 'twitter', 'news', 'youtube', 'travel']) {
    const credential = store.register({ name: kind }, 'edition-test');
    agents[kind] = store.authenticate('Bearer ' + credential.token);
  }
  const original = new Map();
  for (const doc of collection('content/launch-2026-10-12')) original.set(doc.contentId, store.submit(agents[doc.extensions['newsroom.launch'].producer], doc).publicationId);
  const docs = collection('content/editorial-2026-10-12');
  for (const doc of docs) {
    assert.equal(doc.language, 'en'); assert.doesNotMatch(doc.title + doc.summary + JSON.stringify(doc.blocks), /[\u4e00-\u9fff]/);
    const agent = agents[doc.extensions['newsroom.edition'].producer];
    const result = store.submit(agent, doc);
    if (doc.revision === 2) { assert.equal(result.publicationId, original.get(doc.contentId)); assert.equal(store.rows(result.publicationId).length, 2); }
    assert.equal(store.submit(agent, doc).replayed, true);
    for (const b of doc.blocks.filter(b => b.mediaType === 'image' && b.url.startsWith('/media/'))) {
      assert.equal(b.mode, 'fiction'); assert.match(b.alt, /AI-generated illustration/); assert.ok(mediaVariants(b.url));
    }
  }
  assert.equal(store.rows().length, 13);
});

test('Installed media is content-addressed WebP with bounded list and detail variants', () => {
  let thumbnails = 0;
  for (const asset of Object.values(editorialMedia)) {
    for (const [width, variant] of Object.entries(asset.variants)) {
      const bytes = readFileSync('web' + variant.url);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.ok(variant.url.includes(createHash('sha256').update(bytes).digest('hex').slice(0, 12)));
      assert.equal(variant.width, Number(width)); assert.equal(variant.bytes, bytes.length);
      assert.ok(bytes.length < (width === '480' ? 110000 : 350000));
      if (width === '480') thumbnails += bytes.length;
    }
  }
  assert.ok(thumbnails < 250000);
});

test('Only constrained same-origin WebP image paths are added to the publication protocol', () => {
  const doc = collection('content/editorial-2026-10-12').find(d => d.blocks.some(b => b.type === 'media' && b.mediaType === 'image'));
  const image = doc.blocks.find(b => b.mediaType === 'image');
  assert.doesNotThrow(() => validatePublication(doc));
  for (const url of ['/media/../../data/publishing.sqlite', '//attacker.example/a.webp', '/media/x.svg', '/media/%2e%2e/file.webp', 'javascript:alert(1)', 'http://example.com/x.webp']) {
    image.url = url; assert.throws(() => validatePublication(doc));
  }
  image.url = Object.values(editorialMedia)[0].variants['480'].url; image.mediaType = 'video';
  assert.throws(() => validatePublication(doc));
});

test('Platform mode serves cached image bytes, supports HEAD/304, and refuses private or unknown asset paths', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'media-http-')), app = createNewsroom({ dataDir: dir, platformOnly: true, llm: false });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', headers = {}) => {
    const req = Object.assign(Readable.from([]), { url, method, headers: { host: 'localhost', ...headers } });
    const result = { status: 200, headers: {}, body: undefined };
    await app.server.listeners('request')[0](req, { setHeader(k,v) { result.headers[k] = v; }, writeHead(s) { result.status = s; }, end(v) { result.body = v; } });
    return result;
  };
  const asset = editorialMedia.thinking.variants['480'];
  const first = await request(asset.url); assert.equal(first.status, 200); assert.equal(first.headers['content-type'], 'image/webp');
  assert.match(first.headers['cache-control'], /immutable/); assert.equal(first.body.length, asset.bytes);
  assert.equal((await request(asset.url, 'HEAD')).body, undefined);
  const cached = await request(asset.url, 'GET', { 'if-none-match': first.headers.etag }); assert.equal(cached.status, 304); assert.equal(cached.body, undefined);
  for (const path of ['/media/catalog.json', '/media/../../data/publishing.sqlite', '/media/unknown-000000000000-480.webp']) assert.equal((await request(path)).status, 404);
});

test('English publisher aliases do not interpret inherited object keys as names', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'Independent agent']) assert.equal(publisherName(name), name);
  assert.equal(publisherName('Roam · 生活旅行手记'), 'Roam');
});
