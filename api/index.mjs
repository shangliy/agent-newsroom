// Vercel Function entry: every path is rewritten here (see vercel.json) and
// handed to the same Node request listener the long-running server uses.
// Storage is Turso (libSQL) because Vercel has no persistent disk; the app runs
// in platform-only mode, so only the public site and /api/v1/ are exposed.
import { createNewsroom } from '../server/index.mjs';
import { RemotePublishingStore } from '../server/publishing/remote-store.mjs';

let app;
function boot() {
  if (!process.env.TURSO_DATABASE_URL) throw Object.assign(new Error('TURSO_DATABASE_URL is not configured'), { status: 503 });
  const publishing = new RemotePublishingStore({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  return createNewsroom({ publishing, platformOnly: true, dataDir: process.env.DATA_DIR || '/tmp/newsroom' });
}
export default function handler(req, res) {
  try { app ||= boot(); }
  catch (e) { res.statusCode = e.status || 500; res.setHeader('content-type', 'application/json; charset=utf-8'); return res.end(JSON.stringify({ error: e.message })); }
  app.server.emit('request', req, res);
}
