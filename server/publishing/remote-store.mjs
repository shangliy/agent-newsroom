// Async publishing store on libSQL (Turso or a local `file:` URL) for hosts
// without a persistent disk, such as Vercel. Mirrors store.mjs exactly: same
// schema, same rules, same error codes. The SQLite store stays the default for
// local, Docker and Fly; the server awaits either one.
import { createClient } from '@libsql/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ProtocolError, protocol, canonical, validatePublication } from './protocol.mjs';

const digest = s => createHash('sha256').update(s).digest('hex');
const fail = (status, code, message) => { throw new ProtocolError(status, code, message); };
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS publisher_agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, origin_hash TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS agent_publications(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES publisher_agents(id), content_id TEXT NOT NULL, UNIQUE(agent_id, content_id))',
  `CREATE TABLE IF NOT EXISTS publication_revisions(publication_id TEXT NOT NULL REFERENCES agent_publications(id), revision INTEGER NOT NULL,
    action TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(publication_id,revision))`,
  'CREATE INDEX IF NOT EXISTS agent_origin ON publisher_agents(origin_hash,created)',
  'CREATE INDEX IF NOT EXISTS revision_created ON publication_revisions(created)',
];
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];

export class RemotePublishingStore {
  constructor({ url, authToken, now = Date.now } = {}) {
    if (typeof url !== 'string' || !/^(libsql|https?|wss?|file):/.test(url)) throw new Error('RemotePublishingStore needs a libsql://, https:// or file: URL');
    this.now = now; this.db = createClient({ url, authToken });
    this.ready = this.db.batch(SCHEMA, 'write').then(() => this);
  }
  async transaction(fn) {
    await this.ready;
    const tx = await this.db.transaction('write');
    try { const r = await fn(tx); await tx.commit(); return r; }
    catch (e) { await tx.rollback().catch(() => {}); throw e; }
  }
  async register(input, origin) {
    if (Object.keys(input).some(k => k !== 'name') || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) fail(422, 'INVALID_AGENT', '需要 1–80 字符的 name');
    return this.transaction(async tx => {
      const originHash = digest(origin || 'local');
      const total = await one(tx, 'SELECT COUNT(*) AS n FROM publisher_agents');
      const recent = await one(tx, 'SELECT COUNT(*) AS n FROM publisher_agents WHERE origin_hash=? AND created>?', [originHash, this.now() - 3600000]);
      if (Number(total.n) >= 1000 || Number(recent.n) >= 5) fail(429, 'REGISTRATION_LIMIT', '注册配额已达上限');
      const id = randomUUID(), token = randomBytes(32).toString('base64url');
      await tx.execute({ sql: 'INSERT INTO publisher_agents VALUES(?,?,?,?,?)', args: [id, input.name, digest(token), this.now(), originHash] });
      return { agentId: id, token, name: input.name, tokenNotice: '令牌仅返回一次，请由 agent 持久保存；不要发送给读者或其他 agent' };
    });
  }
  async authenticate(header) {
    await this.ready;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
    const agent = token && await one(this.db, 'SELECT id,name FROM publisher_agents WHERE token_hash=?', [digest(token)]);
    if (!agent) fail(401, 'INVALID_CREDENTIAL', '需要有效的 agent Bearer token');
    return { id: agent.id, name: agent.name };
  }
  async revoke(agent) {
    await this.ready;
    await this.db.execute({ sql: 'UPDATE publisher_agents SET token_hash=? WHERE id=?', args: [digest(randomBytes(32)), agent.id] });
    return { revoked: true, agentId: agent.id };
  }
  async get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail(400, 'INVALID_ID', '需要有效的 publicationId');
    const row = (await this.rows(id))[0];
    if (!row) fail(404, 'NOT_FOUND', '发布不存在');
    return row;
  }
  async submit(agent, input) {
    const doc = validatePublication(input), fingerprint = digest(canonical(doc));
    return this.transaction(async tx => {
      let publication = await one(tx, 'SELECT * FROM agent_publications WHERE agent_id=? AND content_id=?', [agent.id, doc.contentId]);
      const last = publication && await one(tx, 'SELECT * FROM publication_revisions WHERE publication_id=? ORDER BY revision DESC LIMIT 1', [publication.id]);
      const previous = publication && await one(tx, 'SELECT * FROM publication_revisions WHERE publication_id=? AND revision=?', [publication.id, doc.revision]);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, 'REVISION_CONFLICT', '同一 revision 不可用于不同内容');
        return { publicationId: publication.id, revision: Number(previous.revision), action: previous.action, replayed: true, currentRevision: Number(last.revision), currentAction: last.action };
      }
      const lastRevision = Number(last?.revision || 0);
      if (doc.revision !== lastRevision + 1) fail(409, 'REVISION_SEQUENCE', `下一 revision 必须是 ${lastRevision + 1}`);
      if (doc.action === 'retract' && !last) fail(409, 'NOT_PUBLISHED', '不能撤回尚未发布的内容');
      if (doc.action === 'retract' && last.action === 'retract') fail(409, 'ALREADY_RETRACTED', '内容已经撤回；同一撤回请重试原 revision');
      const count = await one(tx, 'SELECT COUNT(*) AS total, SUM(r.created>?) AS recent FROM publication_revisions r JOIN agent_publications p ON p.id=r.publication_id WHERE p.agent_id=?', [this.now() - 3600000, agent.id]);
      if (doc.action !== 'retract' && (Number(count.total) >= 1000 || Number(count.recent || 0) >= 60)) fail(429, 'PUBLISH_LIMIT', '发布配额已达上限；仍可撤回内容');
      if (!publication) {
        publication = { id: randomUUID() };
        await tx.execute({ sql: 'INSERT INTO agent_publications VALUES(?,?,?)', args: [publication.id, agent.id, doc.contentId] });
      }
      await tx.execute({ sql: 'INSERT INTO publication_revisions VALUES(?,?,?,?,?,?)', args: [publication.id, doc.revision, doc.action, JSON.stringify(doc), fingerprint, this.now()] });
      return { publicationId: publication.id, revision: doc.revision, action: doc.action, replayed: false, currentRevision: doc.revision, currentAction: doc.action, checks: protocol.quality };
    });
  }
  async rows(id = null) {
    await this.ready;
    const select = 'SELECT r.*,p.agent_id,a.name AS agent_name FROM publication_revisions r JOIN agent_publications p ON p.id=r.publication_id JOIN publisher_agents a ON a.id=p.agent_id';
    const result = id ? await this.db.execute({ sql: select + ' WHERE p.id=? ORDER BY revision DESC LIMIT 100', args: [id] })
      : await this.db.execute(select + ' WHERE r.revision=(SELECT MAX(revision) FROM publication_revisions WHERE publication_id=p.id) ORDER BY r.created DESC,p.id LIMIT 100');
    return result.rows.map(r => ({ publicationId: r.publication_id, agent: { id: r.agent_id, name: r.agent_name }, createdAt: Number(r.created),
      revision: Number(r.revision), action: r.action, document: JSON.parse(r.body), checks: protocol.quality }));
  }
  close() { this.db.close(); }
}
