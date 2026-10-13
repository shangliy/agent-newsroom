import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { PublishingStore } from '../server/publishing/store.mjs';
const dataDir = resolve(process.env.DATA_DIR || 'data');
if (!existsSync(join(dataDir, 'publishing.sqlite'))) throw Error('No publications database');
const store = new PublishingStore(join(dataDir, 'publishing.sqlite'));
let rows, histories;
try { rows = store.rows(); histories = Object.fromEntries(rows.map(p => [p.publicationId, store.rows(p.publicationId)])); } finally { store.close(); }
const safe = x => JSON.stringify(x).replace(/</g, '\\u003c');
let html = readFileSync('web/platform.html', 'utf8');
const css = ['web/tokens.css', 'web/platform.css'].map(p => readFileSync(p, 'utf8')).join('\n');
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '').replace('</head>', `<style>${css}</style></head>`);
const script = readFileSync('web/discovery.js', 'utf8').replace(/export /g, '') + '\n' + readFileSync('web/platform.js', 'utf8').replace(/^import .*\n/, '');
const shim = `const snapshotRows = ${safe(rows)}, snapshotHistories = ${safe(histories)};
async function fetch(path) { const u = new URL(path, 'http://snapshot.local'); let data;
 if(u.pathname === '/api/v1/publications') data = {publications:snapshotRows};
 else if(u.pathname === '/api/v1/history') data = {revisions:snapshotHistories[u.searchParams.get('id')] || []};
 else if(u.pathname === '/api/v1/post') data = {publication:snapshotRows.find(p=>p.publicationId === u.searchParams.get('id'))};
 else return {ok:false,status:404};
 return {ok:true,json:async()=>data}; }
`;
html = html.replace('<script type="module" src="/platform.js"></script>', `<script type="module">${(shim + script).replace(/<\/script/gi, '<\\/script')}</script>`);
html = html.replace('Latest 100 posts', 'Offline snapshot · ' + new Date().toISOString() + ' · Not a live site · Latest 100 posts');
html = html.replace('href="/api/v1/protocol"', 'href="https://modelcontextprotocol.io/"').replace('Connect your agent ↗', 'MCP standard ↗');
// Snapshot detail links use the same modal, not a nonexistent file-system /p path.
html = html.replace("permalink.href = '/p/' + p.publicationId;", "permalink.href = '#'; permalink.textContent = 'Offline snapshot: permalinks are available on the live site'; permalink.onclick = e => e.preventDefault();");
html = html.replace('function assetURL(url) { return url; }', "function assetURL(url) { return url.startsWith('/media/') ? './media/' + url.slice(7) : url; }");
const out = resolve(process.argv[2] || 'outputs/newsroom-preview.html'); mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, html); console.log(out);
mkdirSync(join(dirname(out), 'media'), {recursive:true});
for (const file of readdirSync('web/media').filter(f => f.endsWith('.webp'))) copyFileSync(join('web/media', file), join(dirname(out), 'media', file));

// Export each visual direction with the same real publication snapshot.
if (!process.argv[2]) {
  for (const style of ['discover', 'journal', 'minimal']) {
    const target = resolve(`outputs/newsroom-${style}.html`);
    writeFileSync(target, html.replace('data-style="discover"', `data-style="${style}"`));
    console.log(target);
  }
}
