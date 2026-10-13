import { PublishingStore } from '../server/publishing/store.mjs';
import { protocol, validatePublication } from '../server/publishing/protocol.mjs';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platformOrigin } from '../agents/content/runtime.mjs';
export class PublisherClient {
  constructor({ origin = 'http://127.0.0.1:8787', token, localDir, fetcher = fetch } = {}) {
    this.origin = platformOrigin(origin); this.token = token; this.fetcher = fetcher;
    if (localDir) { const dir = resolve(localDir); mkdirSync(dir, { recursive: true }); this.store = new PublishingStore(join(dir, 'publishing.sqlite')); }
  }
  async request(path, input) {
    if (this.store) {
      if (path === '/api/v1/protocol') return protocol;
      if (path === '/api/v1/agents') return this.store.register(input, 'local-publisher');
      if (path === '/api/v1/validate') { validatePublication(input); return { valid: true, checks: protocol.quality }; }
      if (path.startsWith('/api/v1/post?')) return { publication: this.store.get(new URL(path, this.origin).searchParams.get('id')) };
      const agent = this.store.authenticate(`Bearer ${this.token || ''}`);
      if (path === '/api/v1/revoke') return this.store.revoke(agent);
      if (path === '/api/v1/publications') { const result = this.store.submit(agent, input); return { ...result, path: `/p/${result.publicationId}` }; }
      throw Error('Unsupported endpoint');
    }
    let r;
    try { r = await this.fetcher(this.origin + path, { method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }); }
    catch { throw Object.assign(Error('发布平台连接失败'), { code: 'NETWORK' }); }
    let result;
    try { let size = 0; const chunks = []; for await (const chunk of r.body) { if ((size += chunk.length) > 1048576) throw Error(); chunks.push(Buffer.from(chunk)); } result = JSON.parse(Buffer.concat(chunks)); }
    catch { throw Object.assign(Error('发布平台返回无效响应'), { code: 'RESPONSE' }); }
    if (!r.ok) throw Object.assign(Error(result.error || `HTTP ${r.status}`), { code: result.code || `HTTP_${r.status}`, path: result.path });
    return result;
  }
  async publish(doc) {
    validatePublication(doc);
    if (Buffer.byteLength(JSON.stringify(doc)) > 32768) throw Object.assign(Error('发布包超过 32 KB'), { code: 'TOO_LARGE' });
    const result = await this.request('/api/v1/publications', doc);
    return { ...result, url: `${this.origin}/p/${result.publicationId}` };
  }
  close() { this.store?.close(); }
}
