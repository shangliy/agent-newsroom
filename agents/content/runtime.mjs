import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jsonRequest, AgentError } from './http.mjs';
import { names, collect } from './sources.mjs';
import { compose, hash, contentId } from './compose.mjs';
import { VERSION } from '../../server/publishing/protocol.mjs';

export class ProducerState {
  constructor(dir, origin, now = Date.now) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); this.now = now; this.owner = randomUUID();
    const path = join(dir, 'producers.sqlite'); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS states(kind TEXT PRIMARY KEY,body TEXT);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY,owner TEXT,expires INTEGER);`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT value FROM settings WHERE key=?').get('origin');
      if (old && old.value !== origin) throw new AgentError('ORIGIN', '此状态目录绑定了另一发布平台，请使用独立 AGENT_STATE_DIR');
      const lease = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (lease && lease.expires > now()) throw new AgentError('LOCKED', '已有生产器持有运行租约');
      this.db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('origin', origin);
      this.db.prepare('INSERT OR REPLACE INTO lease VALUES(1,?,?)').run(this.owner, now() + 1800000);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); this.db.close(); throw e; }
  }
  renew() {
    if (!this.db.prepare('UPDATE lease SET expires=? WHERE id=1 AND owner=? AND expires>?').run(this.now() + 1800000, this.owner, this.now()).changes) throw new AgentError('LEASE', '运行租约已失效');
  }
  read(kind) { return JSON.parse(this.db.prepare('SELECT body FROM states WHERE kind=?').get(kind)?.body || '{"items":{},"failures":0,"nextAttempt":0}'); }
  write(kind, state) { this.renew(); this.db.prepare('INSERT OR REPLACE INTO states VALUES(?,?)').run(kind, JSON.stringify(state)); }
  close() { this.db.prepare('DELETE FROM lease WHERE id=1 AND owner=?').run(this.owner); this.db.close(); }
}
export function platformOrigin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || !(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new AgentError('CONFIG', '平台地址必须是 HTTPS origin；仅本地允许 HTTP');
  return u.origin;
}
export async function runAgent(kind, { state, origin, limit = 3, env = process.env, fetcher = fetch, collector = collect, composer = compose, now = Date.now } = {}) {
  const saved = state.read(kind);
  if (saved.nextAttempt > now()) return { agent: kind, status: 'backoff', nextAttempt: saved.nextAttempt };
  const api = (path, payload) => jsonRequest(origin + path, { method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(saved.token ? { authorization: `Bearer ${saved.token}` } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, fetcher);
  let published = 0, skipped = 0;
  try {
    const items = await collector(kind, { env, fetcher });
    if (!items.length && !saved.pending) return { agent: kind, status: 'empty' };
    const discovery = await api('/api/v1/protocol');
    if (discovery.protocol !== VERSION || !discovery.origin) throw new AgentError('PROTOCOL', '发布平台缺少兼容的来源协议');
    if (!saved.token) {
      const key = await api('/api/v1/agents', { name: names[kind] });
      if (typeof key.token !== 'string' || !key.agentId) throw new AgentError('PROTOCOL', '注册响应缺少凭据');
      saved.token = key.token; saved.agentId = key.agentId; state.write(kind, saved);
    }
    async function flush() {
      if (!saved.pending) return;
      const p = saved.pending;
      // Never retry publishing personal material after it has disappeared or changed authorization.
      if (kind === 'travel' && !items.some(item => hash({ item, model: env.LLM_MODEL || '', enabled: !!env.ANTHROPIC_API_KEY }) === p.sourceHash)) throw new AgentError('AUTHORIZATION', '待发送旅行内容的素材或授权已变化；保留待处理状态，不继续公开发布');
      state.renew();
      const result = await api('/api/v1/publications', p.document);
      if (result.revision !== p.document.revision || !result.publicationId) throw new AgentError('PROTOCOL', '发布响应不匹配');
      if (result.currentRevision && result.currentRevision !== p.document.revision) throw new AgentError('REMOTE_CHANGED', '服务端已有更高修订，需要同步状态');
      saved.items[p.document.contentId] = { revision: p.document.revision, sourceHash: p.sourceHash, publicationId: result.publicationId };
      delete saved.pending; state.write(kind, saved); published++;
    }
    await flush();
    for (const item of items.slice(0, limit)) {
      const id = contentId(kind, item), sourceHash = hash({ item, model: env.LLM_MODEL || '', enabled: !!env.ANTHROPIC_API_KEY }), previous = saved.items[id];
      if (previous?.sourceHash === sourceHash) { skipped++; continue; }
      const document = await composer(kind, item, { env, fetcher }); document.revision = (previous?.revision || 0) + 1;
      saved.pending = { document, sourceHash }; state.write(kind, saved); await flush();
    }
    saved.failures = 0; saved.nextAttempt = 0; state.write(kind, saved);
    return { agent: kind, status: 'ok', published, skipped };
  } catch (error) {
    saved.failures = (saved.failures || 0) + 1;
    saved.nextAttempt = now() + Math.max(Math.min(3600, 60 * 2 ** Math.min(saved.failures - 1, 6)), error.retryAfter || 0) * 1000;
    state.write(kind, saved);
    return { agent: kind, status: 'error', code: error.code || 'FAILED', nextAttempt: saved.nextAttempt, published };
  }
}
