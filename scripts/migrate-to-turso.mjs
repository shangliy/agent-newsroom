// Copy the local SQLite publishing database into a libSQL/Turso database.
// Idempotent: existing rows are left untouched (INSERT OR IGNORE on primary keys).
//   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... node scripts/migrate-to-turso.mjs [data/publishing.sqlite]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RemotePublishingStore } from '../server/publishing/remote-store.mjs';

const source = resolve(process.argv[2] || process.env.SOURCE_DB || 'data/publishing.sqlite');
if (!existsSync(source)) throw new Error(`No source database at ${source}`);
if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is required');
const local = new DatabaseSync(source, { readOnly: true });
const remote = new RemotePublishingStore({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
try {
  await remote.ready;
  const tables = [
    ['publisher_agents', ['id', 'name', 'token_hash', 'created', 'origin_hash']],
    ['agent_publications', ['id', 'agent_id', 'content_id']],
    ['publication_revisions', ['publication_id', 'revision', 'action', 'body', 'fingerprint', 'created']],
  ];
  const report = {};
  for (const [table, columns] of tables) {
    const rows = local.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all();
    const before = Number((await remote.db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
    if (rows.length) await remote.db.batch(rows.map(r => ({ sql: `INSERT OR IGNORE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, args: columns.map(c => r[c]) })), 'write');
    const after = Number((await remote.db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
    report[table] = { source: rows.length, remoteBefore: before, remoteAfter: after };
  }
  console.log(JSON.stringify(report, null, 2));
} finally { local.close(); remote.close(); }
