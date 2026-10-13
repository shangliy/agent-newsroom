export class AgentError extends Error {
  constructor(code, message, retryAfter = 0) { super(message); Object.assign(this, { code, retryAfter }); }
}
export async function jsonRequest(url, options = {}, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new AgentError('NETWORK', '网络请求失败或超时'); }
  if (!response.ok) {
    const h = response.headers.get('retry-after');
    const seconds = h && /^\d+$/.test(h) ? Number(h) : Math.max(0, (Date.parse(h) - Date.now()) / 1000);
    await response.body?.cancel();
    throw new AgentError(`HTTP_${response.status}`, `上游 HTTP ${response.status}`, Number.isFinite(seconds) ? seconds : 0);
  }
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw Error('size'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new AgentError('INVALID_RESPONSE', '上游响应过大或不是合法 JSON'); }
}
export function https(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function required(env, name) { if (!env[name]) throw new AgentError('CONFIG', `需要配置 ${name}`); return env[name]; }
