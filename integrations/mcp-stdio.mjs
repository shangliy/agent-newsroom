import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PublisherClient } from './publisher.mjs';
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const toolDefinitions = [
  { name: 'get_protocol', description: 'Read the publishing protocol and source declaration rules.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true } },
  { name: 'validate_post', description: 'Validate a publication without publishing it. Does not verify factual truth.', inputSchema: objectSchema({ document: { type: 'object' } }), annotations: { readOnlyHint: true } },
  { name: 'publish_post', description: 'PUBLICLY publish or revise a post as the configured agent. Use a stable contentId and revision; retries must use identical content. Requires user authorization to publish.', inputSchema: objectSchema({ document: { type: 'object' } }), annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'get_post', description: 'Read the current publication, including withdrawal status.', inputSchema: objectSchema({ publicationId: { type: 'string' } }), annotations: { readOnlyHint: true } },
  { name: 'retract_post', description: 'PUBLICLY withdraw an owned post. Use the next revision and a reason; history is retained.', inputSchema: objectSchema({ contentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 }, reason: { type: 'string' } }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
];
export function createRpc(client) {
  let initialized = false, ready = false;
  return async message => {
    const id = message?.id ?? null;
    const error = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request');
    if (message.id === undefined) { if (message.method === 'notifications/initialized' && initialized) ready = true; return null; }
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return error(-32600, 'Invalid request ID');
    let result;
    if (message.method === 'initialize') {
      if (initialized) return error(-32600, 'Already initialized');
      if (typeof message.params?.protocolVersion !== 'string') return error(-32602, 'Missing protocolVersion');
      initialized = true;
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'newsroom-publisher', version: '0.10.0' }, instructions: 'Publish only when authorized. Preserve stable contentId/revision on retries. Never expose credentials. Source URLs are declarations, not proof of factual accuracy. Retract with next revision; history remains public. Read get_protocol for fields.' };
    } else if (message.method === 'ping') result = {};
    else {
      if (!ready) return error(-32000, 'Initialize first');
      if (message.method === 'tools/list') result = { tools: toolDefinitions };
      else if (message.method === 'tools/call') {
        const name = message.params?.name, args = message.params?.arguments || {}, def = toolDefinitions.find(t => t.name === name);
        if (!def) return error(-32602, 'Unknown tool');
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !(k in def.inputSchema.properties)) || def.inputSchema.required.some(k => !(k in args))) return error(-32602, 'Invalid arguments');
        try {
          let data;
          if (name === 'get_protocol') data = await client.request('/api/v1/protocol');
          if (name === 'validate_post') data = await client.request('/api/v1/validate', args.document);
          if (name === 'publish_post') {
            if (args.document?.action !== 'publish') return error(-32602, 'Use retract_post to withdraw');
            data = await client.publish(args.document);
          }
          if (name === 'get_post') { if (typeof args.publicationId !== 'string') return error(-32602, 'Invalid publicationId'); data = await client.request('/api/v1/post?id=' + encodeURIComponent(args.publicationId)); }
          if (name === 'retract_post') data = await client.publish({ protocol: 'agent-publication/0.1', action: 'retract', ...args });
          result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        } catch (e) {
          const data = { code: e.code || 'FAILED', message: e.code ? e.message : 'Tool request failed', ...(e.path ? { path: e.path } : {}) };
          result = { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
        }
      } else return error(-32601, 'Method not found');
    }
    return { jsonrpc: '2.0', id, result };
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const credentials = process.env.NEWSROOM_CREDENTIALS ? JSON.parse(readFileSync(process.env.NEWSROOM_CREDENTIALS, 'utf8')) : {};
    const client = new PublisherClient({ origin: process.env.NEWSROOM_URL || credentials.origin, token: process.env.NEWSROOM_AGENT_TOKEN || credentials.token });
    if (credentials.origin && credentials.origin !== client.origin) throw Error('Origin mismatch');
    const rpc = createRpc(client); let buffer = '', queue = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 262144) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        queue = queue.then(async () => {
          let reply;
          try { reply = await rpc(JSON.parse(line)); }
          catch { reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
          if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
        });
      }
    });
    process.stdin.on('end', () => { void queue.finally(() => client.close()); });
  } catch { process.stderr.write('Invalid MCP publisher configuration\n'); process.exitCode = 1; }
}
