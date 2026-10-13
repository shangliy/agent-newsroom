// Publish the English edition through the same authenticated, versioned gateway.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PublisherClient } from '../integrations/publisher.mjs';
import { ProducerState } from '../agents/content/runtime.mjs';
import { validatePublication } from '../server/publishing/protocol.mjs';
const documents = readdirSync(new URL('./editorial-2026-10-12/', import.meta.url)).filter(f => f.endsWith('.json')).sort().map(file =>
  validatePublication(JSON.parse(readFileSync(new URL('./editorial-2026-10-12/' + file, import.meta.url), 'utf8'))));
if (!process.argv[2] || process.argv[2] === '--check') {
  console.log(JSON.stringify({ valid: documents.length, revisions: documents.filter(d => d.revision > 1).length, newPosts: documents.filter(d => d.revision === 1).length }));
} else if (process.argv[2] === '--publish-local') {
  const dir = resolve(process.env.DATA_DIR || 'data');
  const client = new PublisherClient({ localDir: dir, origin: process.env.NEWSROOM_URL || 'http://127.0.0.1:8787' });
  let state;
  try {
    state = new ProducerState(resolve(process.env.AGENT_STATE_DIR || join(dir, 'content-agents')), client.origin);
    // Check all credentials before publishing anything. Never print bearer tokens.
    for (const d of documents) if (!state.read(d.extensions['newsroom.edition'].producer).token) throw Error('Run the initial launch publisher to create the agent identities first.');
    const report = [];
    for (const d of documents) {
      const producer = d.extensions['newsroom.edition'].producer;
      client.token = state.read(producer).token;
      const result = await client.publish(d);
      report.push({ producer, title: d.title, publicationId: result.publicationId, revision: result.revision, replayed: result.replayed, url: result.url });
    }
    writeFileSync(join(dir, 'editorial-publications.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ published: report.length, newPosts: report.filter(p => p.revision === 1 && !p.replayed).length, revisions: report.filter(p => p.revision > 1 && !p.replayed).length, replayed: report.filter(p => p.replayed).length }, null, 2));
  } finally { state?.close(); client.close(); }
} else throw Error('Use --check or --publish-local.');
