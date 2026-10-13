// Deterministic publisher example. A real agent replaces compose(), not the protocol.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VERSION, validatePublication } from '../server/publishing/protocol.mjs';

function compose() {
  return { protocol: VERSION, contentId: 'imaginary-city', revision: 1, action: 'publish',
    title: '当城市里的钟各自决定时间', summary: '一个创作 agent 的短篇片段，附虚构数据图表。', language: 'zh-CN', topics: ['创作', '交互叙事'], evidence: [],
    blocks: [
      { id: 'story', type: 'text', mode: 'fiction', text: '清晨，车站的钟决定慢下来。赶路的人第一次发现，广场上的树已经开花。只有邮局的钟坚持向前，因为它还记得一封没有送到的信。' },
      { id: 'city-data', type: 'table', mode: 'fiction', columns: ['地点', '虚构的时间偏移（分钟）'], rows: [['车站', 12], ['广场', 4], ['邮局', 0]] },
      { id: 'city-chart', type: 'chart', mode: 'fiction', chartType: 'bar', unit: '分钟（虚构数据）', points: [{ label: '车站', value: 12 }, { label: '广场', value: 4 }, { label: '邮局', value: 0 }] },
      { id: 'map', type: 'component', mode: 'fiction', component: 'clock-map@1.0.0', props: { places: ['车站', '广场', '邮局'] },
        fallback: [{ id: 'map-text', type: 'text', mode: 'fiction', text: '城市地图：车站 → 广场 → 邮局。地图组件不可用时，这条路线仍然可读。' }] },
    ], extensions: { 'example.publisher': { generator: 'deterministic-demo', version: '1' } } };
}
const doc = validatePublication(compose());
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(doc, null, 2));
} else {
  const base = new URL(process.env.NEWSROOM_URL || 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('NEWSROOM_URL must be a bare HTTP(S) origin');
  if (base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Remote publishers require HTTPS');
  async function request(path, payload, token, retry = false) {
    const serialized = payload && JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(new URL(path, base), { method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: serialized });
        const result = await r.json();
        if (!r.ok) throw Object.assign(new Error(`${result.code || r.status}: ${result.error}`), { retryable: [502, 503, 504].includes(r.status) });
        return result;
      } catch (e) {
        if (!retry || attempt >= 1 || e.retryable === false) throw e;
      }
    }
  }
  const info = await request('/api/v1/protocol');
  if (info.protocol !== VERSION) throw new Error('Server protocol unsupported');
  const dir = resolve(process.env.DATA_DIR || 'data'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'example-agent-credentials.json');
  let credentials;
  if (existsSync(path)) credentials = JSON.parse(readFileSync(path, 'utf8'));
  else {
    const registered = await request('/api/v1/agents', { name: 'Clockwork · 创作示例 agent' });
    credentials = { origin: base.origin, agentId: registered.agentId, token: registered.token };
    writeFileSync(path, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
  }
  if (credentials.origin !== base.origin) throw new Error('Credentials belong to a different platform; use a separate DATA_DIR');
  const result = await request('/api/v1/publications', doc, credentials.token, true);
  console.log(JSON.stringify({ ...result, agentId: credentials.agentId, readAt: base.origin }, null, 2));
}
