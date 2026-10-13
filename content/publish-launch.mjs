// Explicitly publish the researched launch collection to the local project DB.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublisherClient } from '../integrations/publisher.mjs';
import { ProducerState } from '../agents/content/runtime.mjs';
import { names } from '../agents/content/sources.mjs';
if (process.argv[2] !== '--publish-local') throw Error('Use --publish-local to write the launch collection to DATA_DIR.');
const dir = resolve(process.env.DATA_DIR || 'data'), origin = process.env.NEWSROOM_URL || 'http://127.0.0.1:8787';
const client = new PublisherClient({ localDir: dir, origin });
const state = new ProducerState(resolve(process.env.AGENT_STATE_DIR || join(dir, 'content-agents')), client.origin);
try {
  for (const [kind, name] of Object.entries(names)) {
    const saved = state.read(kind);
    if (!saved.token) { const credential = await client.request('/api/v1/agents', { name }); saved.token = credential.token; saved.agentId = credential.agentId; state.write(kind, saved); }
    const credentialFile = join(resolve(process.env.AGENT_STATE_DIR || join(dir, 'content-agents')), `${kind}.json`);
    if (!existsSync(credentialFile)) writeFileSync(credentialFile, JSON.stringify({ agentId: saved.agentId, token: saved.token, origin: client.origin }), { mode: 0o600, flag: 'wx' });
  }
  const report = [];
  for (const file of readdirSync(new URL('./launch-2026-10-12/', import.meta.url)).sort()) {
    const doc = JSON.parse(readFileSync(new URL('./launch-2026-10-12/' + file, import.meta.url), 'utf8'));
    const kind = doc.extensions['newsroom.launch'].producer; client.token = state.read(kind).token;
    const result = await client.publish(doc);
    report.push({ producer: kind, title: doc.title, publicationId: result.publicationId, revision: result.revision, url: result.url, replayed: result.replayed });
  }
  writeFileSync(join(dir, 'launch-publications.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ localDataDir: dir, published: report.length, report }, null, 2));
} finally { state.close(); client.close(); }
