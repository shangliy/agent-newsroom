import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 2 * 1024 * 1024;
const LEASE_MS = 60000;
const fields = ['title', 'tag', 'publishedAt', 'prerelease', 'bodyHash'];

export function normalizeReleases(rows, repo) {
  if (!Array.isArray(rows) || rows.length > 20) throw new Error('Invalid release list');
  const ids = new Set();
  return rows.map(row => {
    if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)) throw new Error('Invalid release ID');
    ids.add(row.id);
    if (row.draft !== false || typeof row.prerelease !== 'boolean') throw new Error('Invalid publication state');
    for (const name of ['tag_name', 'html_url', 'published_at']) if (typeof row[name] !== 'string' || !row[name]) throw new Error('Missing release field');
    if (row.tag_name.length > 256 || (row.name != null && (typeof row.name !== 'string' || row.name.length > 1000))) throw new Error('Invalid title');
    if (row.body != null && typeof row.body !== 'string') throw new Error('Invalid release notes');
    const url = new URL(row.html_url);
    if (url.origin !== 'https://github.com' || url.username || url.password || !url.pathname.startsWith(`/${repo}/releases/tag/`)) throw new Error('Invalid source URL');
    if (!Number.isFinite(Date.parse(row.published_at))) throw new Error('Invalid source date');
    return { id: String(row.id), title: row.name || row.tag_name, tag: row.tag_name,
      url: url.href, publishedAt: new Date(row.published_at).toISOString(), prerelease: row.prerelease,
      bodyHash: hash(row.body || '') };
  });
}

async function boundedJSON(response) {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Source response exceeds 2 MB');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// One fixed public API, deterministic metadata publishing, no model or arbitrary URL execution.
export class ReleaseNewsroom {
  constructor({ path, repo = 'langchain-ai/langgraph', fetchImpl = fetch, now = Date.now, intervalMs = 600000 }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some(x => ['.', '..'].includes(x))) throw new Error('Invalid repository');
    if (!Number.isFinite(intervalMs) || intervalMs < 60000) throw new Error('Polling interval must be at least one minute');
    this.repo = repo; this.fetch = fetchImpl; this.now = now; this.intervalMs = intervalMs;
    this.url = `https://api.github.com/repos/${repo}/releases?per_page=20`;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS source (id INTEGER PRIMARY KEY CHECK(id=1), repo TEXT NOT NULL,
        etag TEXT, last_success INTEGER, next_attempt INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        error TEXT, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started INTEGER NOT NULL, finished INTEGER,
        status TEXT NOT NULL, changed INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS publications (release_id TEXT NOT NULL, revision INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, evidence TEXT NOT NULL, changes TEXT NOT NULL, observed INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(release_id,revision));
      CREATE INDEX IF NOT EXISTS publication_time ON publications(observed);`);
    this.db.prepare('INSERT OR IGNORE INTO source(id,repo) VALUES(1,?)').run(repo);
    if (this.source().repo !== repo) { this.db.close(); throw new Error('Database belongs to another source; use a separate DATA_DIR'); }
    this.active = null; this.timer = null; this.closed = false;
  }
  source() { return this.db.prepare('SELECT * FROM source WHERE id=1').get(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status() {
    const s = this.source(); const now = this.now();
    return { enabled: true, repo: this.repo, sourceUrl: this.url, lastSuccess: s.last_success,
      nextAttempt: s.next_attempt, failures: s.failures, error: s.error,
      running: s.lease_until > now, stale: s.last_success == null || now - s.last_success > this.intervalMs * 2,
      coverage: '仅最近 20 条公开 Release；不覆盖普通 tag、历史全量或删除检测',
      runs: this.db.prepare('SELECT * FROM runs ORDER BY started DESC, rowid DESC LIMIT 10').all() };
  }
  changes() {
    return this.db.prepare(`SELECT p.* FROM publications p WHERE revision =
      (SELECT MAX(revision) FROM publications WHERE release_id=p.release_id)
      ORDER BY observed DESC, release_id DESC LIMIT 100`).all().map(row => this.decode(row));
  }
  history(id) { return this.db.prepare('SELECT * FROM publications WHERE release_id=? ORDER BY revision DESC LIMIT 100').all(id).map(row => this.decode(row)); }
  decode(row) {
    return { id: row.release_id, revision: row.revision, evidence: JSON.parse(row.evidence),
      changes: JSON.parse(row.changes), observedAt: row.observed, runId: row.run_id,
      kind: row.revision === 1 ? 'first-observed' : 'corrected', verification: 'official-source-metadata' };
  }
  poll() {
    if (this.closed) return Promise.reject(new Error('Newsroom is closed'));
    if (this.active) return this.active;
    this.active = this.run().finally(() => { this.active = null; });
    return this.active;
  }
  async run() {
    const now = this.now(), id = randomUUID();
    const claimed = this.transaction(() => {
      const s = this.source();
      if (s.lease_until > now || s.next_attempt > now) return null;
      this.db.prepare("UPDATE runs SET status='interrupted', finished=? WHERE status='running'").run(now);
      this.db.prepare('UPDATE source SET lease=?, lease_until=? WHERE id=1').run(id, now + LEASE_MS);
      this.db.prepare("INSERT INTO runs(id,started,status) VALUES(?,?,'running')").run(id, now);
      return s;
    });
    if (!claimed) return { skipped: true };
    let retryAt = 0;
    try {
      const response = await this.fetch(this.url, { redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Agent-Newsroom/0.6', ...(claimed.etag ? { 'if-none-match': claimed.etag } : {}) } });
      if (![200, 304].includes(response.status)) {
        const retry = response.headers.get('retry-after');
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        retryAt = retry ? (/^\d+$/.test(retry) ? this.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
        if ([403, 429].includes(response.status) && Number.isFinite(reset)) retryAt = Math.max(retryAt || 0, reset);
        await response.body?.cancel();
        throw new Error(`Source HTTP ${response.status}`);
      }
      if (response.status === 304 && !claimed.etag) throw new Error('Unexpected 304 without stored ETag');
      const rows = response.status === 304 ? [] : normalizeReleases(await boundedJSON(response), this.repo);
      const finished = this.now();
      const changed = this.transaction(() => {
        const s = this.source();
        if (s.lease !== id || s.lease_until <= finished) throw new Error('Expired worker lease');
        let count = 0;
        for (const evidence of rows) {
          const previous = this.db.prepare('SELECT * FROM publications WHERE release_id=? ORDER BY revision DESC LIMIT 1').get(evidence.id);
          const fingerprint = hash(JSON.stringify(evidence));
          if (previous?.fingerprint === fingerprint) continue;
          const old = previous ? JSON.parse(previous.evidence) : null;
          const changes = old ? [...fields, 'url'].filter(key => old[key] !== evidence[key]).map(field => ({ field, before: old[field], after: evidence[field] })) : [];
          this.db.prepare('INSERT INTO publications VALUES(?,?,?,?,?,?,?)').run(evidence.id, (previous?.revision || 0) + 1,
            fingerprint, JSON.stringify(evidence), JSON.stringify(changes), finished, id);
          count++;
        }
        this.db.prepare('UPDATE source SET etag=?,last_success=?,next_attempt=?,failures=0,error=NULL,lease=NULL,lease_until=0 WHERE id=1')
          .run(response.status === 304 ? claimed.etag : response.headers.get('etag'), finished, finished + this.intervalMs);
        this.db.prepare("UPDATE runs SET status='succeeded',finished=?,changed=? WHERE id=?").run(finished, count, id);
        return count;
      });
      return { changed, notModified: response.status === 304 };
    } catch (error) {
      const finished = this.now();
      this.transaction(() => {
        const s = this.source();
        this.db.prepare("UPDATE runs SET status='failed',finished=?,error=? WHERE id=?").run(finished, String(error.message).slice(0, 300), id);
        if (s.lease === id) {
          const delay = Math.min(3600000, 60000 * 2 ** Math.min(s.failures, 6));
          this.db.prepare('UPDATE source SET failures=failures+1,error=?,next_attempt=?,lease=NULL,lease_until=0 WHERE id=1')
            .run(String(error.message).slice(0, 300), Math.max(finished + delay, Number.isFinite(retryAt) ? retryAt : 0));
        }
      });
      return { error: String(error.message) };
    }
  }
  start() {
    if (this.timer || this.closed) return;
    const tick = () => this.poll().catch(error => console.error('Release worker:', error.message));
    void tick(); this.timer = setInterval(tick, 15000); this.timer.unref();
  }
  async close() {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); await this.active; this.db.close();
  }
}
