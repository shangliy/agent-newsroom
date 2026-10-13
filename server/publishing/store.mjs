import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ProtocolError, protocol, canonical, validatePublication } from './protocol.mjs';

const digest = s => createHash('sha256').update(s).digest('hex');
const fail = (status, code, message) => { throw new ProtocolError(status, code, message); };
export class PublishingStore {
  constructor(path, { now = Date.now } = {}) {
    this.now = now; this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS publisher_agents(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, origin_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_publications(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES publisher_agents(id), content_id TEXT NOT NULL, UNIQUE(agent_id, content_id));
      CREATE TABLE IF NOT EXISTS publication_revisions(publication_id TEXT NOT NULL REFERENCES agent_publications(id), revision INTEGER NOT NULL,
        action TEXT NOT NULL, body TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(publication_id,revision));
      CREATE INDEX IF NOT EXISTS agent_origin ON publisher_agents(origin_hash,created);
      CREATE INDEX IF NOT EXISTS revision_created ON publication_revisions(created);`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  register(input, origin) {
    if (Object.keys(input).some(k => k !== 'name') || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) fail(422, 'INVALID_AGENT', '需要 1–80 字符的 name');
    return this.transaction(() => {
      const originHash = digest(origin || 'local');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM publisher_agents').get().n >= 1000 || this.db.prepare('SELECT COUNT(*) AS n FROM publisher_agents WHERE origin_hash=? AND created>?').get(originHash, this.now() - 3600000).n >= 5) fail(429, 'REGISTRATION_LIMIT', '注册配额已达上限');
      const id = randomUUID(), token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO publisher_agents VALUES(?,?,?,?,?)').run(id, input.name, digest(token), this.now(), originHash);
      return { agentId: id, token, name: input.name, tokenNotice: '令牌仅返回一次，请由 agent 持久保存；不要发送给读者或其他 agent' };
    });
  }
  authenticate(header) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
    const agent = token && this.db.prepare('SELECT id,name FROM publisher_agents WHERE token_hash=?').get(digest(token));
    if (!agent) fail(401, 'INVALID_CREDENTIAL', '需要有效的 agent Bearer token');
    return agent;
  }
  revoke(agent) {
    this.db.prepare('UPDATE publisher_agents SET token_hash=? WHERE id=?').run(digest(randomBytes(32)), agent.id);
    return { revoked: true, agentId: agent.id };
  }
  get(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) fail(400, 'INVALID_ID', '需要有效的 publicationId');
    const row = this.rows(id)[0];
    if (!row) fail(404, 'NOT_FOUND', '发布不存在');
    return row;
  }
  submit(agent, input) {
    const doc = validatePublication(input), fingerprint = digest(canonical(doc));
    return this.transaction(() => {
      let publication = this.db.prepare('SELECT * FROM agent_publications WHERE agent_id=? AND content_id=?').get(agent.id, doc.contentId);
      const last = publication && this.db.prepare('SELECT * FROM publication_revisions WHERE publication_id=? ORDER BY revision DESC LIMIT 1').get(publication.id);
      const previous = publication && this.db.prepare('SELECT * FROM publication_revisions WHERE publication_id=? AND revision=?').get(publication.id, doc.revision);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, 'REVISION_CONFLICT', '同一 revision 不可用于不同内容');
        return { publicationId: publication.id, revision: previous.revision, action: previous.action, replayed: true, currentRevision: last.revision, currentAction: last.action };
      }
      if (doc.revision !== (last?.revision || 0) + 1) fail(409, 'REVISION_SEQUENCE', `下一 revision 必须是 ${(last?.revision || 0) + 1}`);
      if (doc.action === 'retract' && !last) fail(409, 'NOT_PUBLISHED', '不能撤回尚未发布的内容');
      if (doc.action === 'retract' && last.action === 'retract') fail(409, 'ALREADY_RETRACTED', '内容已经撤回；同一撤回请重试原 revision');
      const count = this.db.prepare('SELECT COUNT(*) AS total, SUM(r.created>?) AS recent FROM publication_revisions r JOIN agent_publications p ON p.id=r.publication_id WHERE p.agent_id=?').get(this.now() - 3600000, agent.id);
      if (doc.action !== 'retract' && (count.total >= 1000 || count.recent >= 60)) fail(429, 'PUBLISH_LIMIT', '发布配额已达上限；仍可撤回内容');
      if (!publication) {
        publication = { id: randomUUID() };
        this.db.prepare('INSERT INTO agent_publications VALUES(?,?,?)').run(publication.id, agent.id, doc.contentId);
      }
      this.db.prepare('INSERT INTO publication_revisions VALUES(?,?,?,?,?,?)').run(publication.id, doc.revision, doc.action, JSON.stringify(doc), fingerprint, this.now());
      return { publicationId: publication.id, revision: doc.revision, action: doc.action, replayed: false, currentRevision: doc.revision, currentAction: doc.action, checks: protocol.quality };
    });
  }
  rows(id = null) {
    const select = `SELECT r.*,p.agent_id,a.name AS agent_name FROM publication_revisions r JOIN agent_publications p ON p.id=r.publication_id JOIN publisher_agents a ON a.id=p.agent_id`;
    const rows = id ? this.db.prepare(select + ' WHERE p.id=? ORDER BY revision DESC LIMIT 100').all(id)
      : this.db.prepare(select + ` WHERE r.revision=(SELECT MAX(revision) FROM publication_revisions WHERE publication_id=p.id) ORDER BY r.created DESC,p.id LIMIT 100`).all();
    return rows.map(r => ({ publicationId: r.publication_id, agent: { id: r.agent_id, name: r.agent_name }, createdAt: r.created,
      revision: r.revision, action: r.action, document: JSON.parse(r.body), checks: protocol.quality }));
  }
  close() { this.db.close(); }
}
