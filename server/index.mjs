import { createServer } from 'node:http';
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defaultBus } from './bus.mjs';
import { Registry } from './registry.mjs';
import { greedyPolicy, uniformPolicy, evaluateHoldout } from './evaluation.mjs';
import { Allocator, evaluatePolicy, READER_CLUSTERS } from './allocator.mjs';
import { attribute, Ledger, REWARD } from './attribution.mjs';
import { Verifier } from './verify.mjs';
import { SceneCache } from './cache.mjs';
import { STORIES, TOPICS, TOPIC_NAME } from './stories.mjs';
import { AGENTS, runBuild } from './agents/index.mjs';
import { withDeadline } from './deadline.mjs';
import { runSimulation } from './simulation.mjs';
import { PublishingStore } from './publishing/store.mjs';
import { protocol, validatePublication } from './publishing/protocol.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 32768) throw fail(413, '请求体超过 32 KB'); chunks.push(bytes); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { const value = JSON.parse(text || '{}'); if (!value || Array.isArray(value) || typeof value !== 'object') throw 0; return value; }
  catch { throw fail(400, '需要合法 JSON 对象'); }
}
const clusterOf = r => READER_CLUSTERS.includes(r) ? r : 'data';

// Behind a trusted reverse proxy (Fly, Vercel) the socket address is the proxy; name the header carrying the real client IP.
const clientAddress = req => {
  const header = process.env.TRUST_PROXY_HEADER?.toLowerCase(), value = header && req.headers[header];
  return (typeof value === 'string' && value.split(',')[0].trim()) || req.socket?.remoteAddress;
};

export function createNewsroom({ dataDir = process.env.DATA_DIR || join(ROOT, 'data'), llm = true, agentTimeoutMs = 10000, newsroom = null, platformOnly = process.env.PLATFORM_ONLY === '1', publishing = null } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const stateFile = join(dataDir, 'state.json'), logFile = join(dataDir, 'events.jsonl');
  const bus = defaultBus(), registry = new Registry(), verifier = new Verifier(join(ROOT, 'data/sources.json'));
  const allocator = new Allocator({ topics: TOPICS, agents: Object.keys(AGENTS) });
  const cache = new SceneCache(), ledger = new Ledger(), impressions = new Map();
  const sessions = new Map();
  // The SQLite store is synchronous and the libSQL store is asynchronous; every call site awaits, which is a no-op for plain values.
  publishing ||= new PublishingStore(join(dataDir, 'publishing.sqlite'));
  const registryVersion = registry.list().map(m => m.key).sort().join(',');
  let queue = Promise.resolve(), simulationTask = null, closing = false, closeTask;
  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (state.version === 1) {
      // Old feedback mixes unseen cards and synthetic readers. Preserve it for
      // inspection, but do not train the corrected reader policy on it.
      writeFileSync(join(dataDir, `state-v1-archive-${randomUUID()}.json`), JSON.stringify(state), { mode: 0o600 });
      console.warn('旧实验状态已归档；新版本从独立的可见曝光记录开始学习。');
      persist();
    } else {
      if (![2, 3].includes(state.version)) throw new Error('Unsupported state version');
      Object.assign(ledger, state.ledger);
      if (state.version === 3) { allocator.post = state.post; allocator.contextPost = state.contextPost; }
      else {
        // v2 decisions retain readerCluster and reward, so rebuild the group
        // posteriors without inventing historical context or changing propensities.
        for (const imp of state.impressions) { const d = imp.decision; if (d.reward != null) allocator.update(d.topic, d.agent, d.reward, d.readerCluster); }
      }
      for (const imp of state.impressions) { impressions.set(imp.decision.id, imp); allocator.decisions.set(imp.decision.id, imp.decision); }
    }
  }
  function persist() {
    writeFileSync(stateFile + '.tmp', JSON.stringify({ version: 3, post: allocator.post, contextPost: allocator.contextPost, ledger, impressions: [...impressions.values()] }), { mode: 0o600 });
    renameSync(stateFile + '.tmp', stateFile);
  }
  function session(req, res) {
    let id = /(?:^|;\s*)newsroom=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!id || !sessions.has(id)) {
      id = randomUUID(); sessions.set(id, { streams: new Set(), lastSeen: Date.now(), feedRequests: new Map() });
      res.setHeader('set-cookie', `newsroom=${id}; Path=/; HttpOnly; SameSite=Strict`);
    }
    sessions.get(id).lastSeen = Date.now();
    return id;
  }
  function owned(id, owner) {
    const imp = impressions.get(id);
    if (!imp || imp.owner !== owner) throw fail(404, '曝光不存在或不属于当前会话');
    return imp;
  }
  function validate(scene, agent) {
    if (!scene || !Array.isArray(scene.scene) || scene.scene.length > 20) throw fail(502, 'Agent 场景结构无效');
    const errors = registry.validate(scene, agent, bus);
    scene.scene = scene.scene.filter((_, i) => !errors.some(e => e.startsWith(`#${i} `)));
    const citations = verifier.check(scene);
    scene.motion = scene.motion === 'editorial-reveal' ? scene.motion : 'none';
    scene.__verification = { errors, citations, scope: '仅检查引文与摘要的来源文本匹配；不保证语义事实正确，其他组件未做事实核验。' };
    return scene;
  }
  async function buildScene({ story, readerCluster, agentId }) {
    const key = cache.key({ readerCluster, storyId: story.id, agentId, agentVersion: AGENTS[agentId].version, registryVersion });
    let scene = cache.get(key); const cached = !!scene;
    if (!scene) {
      const ctx = { story, reader: { cluster: readerCluster }, bus };
      const generated = await withDeadline(() => llm ? runBuild(agentId, ctx) : AGENTS[agentId].build(ctx), agentTimeoutMs);
      scene = validate(structuredClone(generated), agentId);
      cache.set(key, scene);
    }
    return { scene, cached, verification: scene.__verification };
  }
  async function cardFor(story, readerCluster, owner, feedId, exclude = null) {
    const decision = allocator.choose({ topic: story.topic, readerCluster, exclude });
    try {
      const result = await buildScene({ story, readerCluster, agentId: decision.agent });
      decision.storyId = story.id; decision.dataset = 'reader'; decision.exposedAt = null; decision.components = result.scene.scene.map(c => c.resolved);
      impressions.set(decision.id, { decision, owner, feedId, events: [], blocks: result.scene.scene, seenEvents: [], closed: false });
      const a = AGENTS[decision.agent];
      return { feedId, decisionId: decision.id, story: { ...story, topicName: TOPIC_NAME[story.topic] },
        agent: { id: decision.agent, name: a.name, style: a.style, version: a.version }, propensity: decision.propensity, ...result };
    } catch (e) { allocator.decisions.delete(decision.id); throw e; }
  }
  function settle(imp) {
    if (imp.decision.reward != null || imp.decision.exposedAt == null) return;
    const { reward, split } = attribute(imp.decision, imp.events);
    Object.assign(imp.decision, { reward, settledAt: Date.now() });
    allocator.update(imp.decision.topic, imp.decision.agent, reward, imp.decision.readerCluster); ledger.credit(split, registry);
  }
  function checkRequestId(id) {
    if (id != null && (typeof id !== 'string' || !id || id.length > 100)) throw fail(400, '请求 ID 需为 1–100 字符');
  }
  function record(imp, ev, { verifiedFollowup = false } = {}) {
    if (!Object.hasOwn(REWARD, ev.type)) throw fail(400, '未知事件');
    if (ev.type === 'followup' && !verifiedFollowup) throw fail(403, '追问奖励只能由通过核验的回答产生');
    checkRequestId(ev.eventId);
    const prior = ev.eventId && imp.events.find(e => e.eventId === ev.eventId);
    if (prior && JSON.stringify([prior.type, prior.component, prior.payload]) !== JSON.stringify([ev.type, ev.component, ev.type === 'dwell' ? { sec: Math.min(30, ev.payload?.sec) } : ev.payload])) throw fail(409, '同一事件 ID 不能用于不同内容');
    if (ev.component && (!imp.decision.components.includes(ev.component) || !registry.resolve(ev.component)?.capabilities.includes('emit') || ev.type !== 'interact')) throw fail(403, '组件事件未获授权');
    if (imp.closed || imp.decision.reward != null || (ev.eventId && imp.seenEvents.includes(ev.eventId))) return;
    if (ev.type !== 'impression' && imp.decision.exposedAt == null) throw fail(409, '卡片尚未记录可见曝光');
    if (ev.type === 'impression' && imp.decision.exposedAt != null) return;
    if (ev.type === 'dwell' && Date.now() - imp.decision.exposedAt < 8000) throw fail(400, '距首次曝光不足 8 秒');
    if (ev.type === 'dwell' && (!Number.isFinite(ev.payload?.sec) || ev.payload.sec < 8)) throw fail(400, '停留时间不足 8 秒');
    if (imp.events.length >= 256 && !['like', 'skip', 'followup'].includes(ev.type)) throw fail(429, '单次曝光事件数量已达上限');
    const rec = { ts: Date.now(), decisionId: imp.decision.id, type: ev.type, component: ev.component,
      payload: ev.type === 'dwell' ? { sec: Math.min(30, ev.payload.sec) } : ev.payload,
      eventId: ev.eventId, topic: imp.decision.topic, agent: imp.decision.agent,
      propensity: imp.decision.propensity, readerCluster: imp.decision.readerCluster };
    rec.dataset = 'reader'; rec.feedId = imp.feedId;
    if (ev.type === 'impression') imp.decision.exposedAt = rec.ts;
    imp.events.push(rec); if (ev.eventId) imp.seenEvents.push(ev.eventId);
    appendFileSync(logFile, JSON.stringify(rec) + '\n');
    if (['like', 'skip', 'followup'].includes(ev.type)) settle(imp);
  }
  function streamAllowed(imp, id, component) {
    const def = registry.resolve(component);
    return !imp.closed && def?.capabilities.includes('subscribe') && imp.blocks.some(b => b.resolved === component && b.data === id) && bus.allowed(id, imp.decision.agent);
  }
  function close(imp) {
    settle(imp); imp.closed = true;
    if (imp.decision.exposedAt == null) imp.decision.discarded = 'not-exposed';
    const streams = sessions.get(imp.owner)?.streams;
    if (streams) for (const key of streams) if (key.startsWith(imp.decision.id + ':')) streams.delete(key);
  }
  function feedOwned(feedId, owner) {
    if (typeof feedId !== 'string' || !feedId) throw fail(400, '需要 feedId');
    const feed = [...impressions.values()].filter(imp => imp.feedId === feedId && imp.owner === owner);
    if (!feed.length) throw fail(404, '信息流不存在或不属于当前会话');
    return feed;
  }
  const routes = {
    '/api/catalog': 'GET', '/api/tokens.css': 'GET', '/api/component': 'GET', '/api/snapshot': 'GET', '/api/stream': 'GET',
    '/api/feed': 'GET', '/api/leaderboard': 'GET', '/api/ope': 'GET', '/api/health': 'GET',
    '/api/changes': 'GET', '/api/publication-history': 'GET', '/api/system/status': 'GET',
    '/api/v1/protocol': 'GET', '/api/v1/agents': 'POST', '/api/v1/publications': ['GET', 'POST'], '/api/v1/history': 'GET',
    '/api/v1/post': 'GET', '/api/v1/validate': 'POST', '/api/v1/revoke': 'POST',
    '/api/event': 'POST', '/api/followup': 'POST', '/api/swap': 'POST', '/api/reset': 'POST', '/api/sim': 'POST', '/api/close': 'POST',
  };
  function reportingCluster(url) {
    const value = url.searchParams.get('reader');
    if (value == null || value === 'all') return null;
    if (!READER_CLUSTERS.includes(value)) throw fail(400, '未知读者簇');
    return value;
  }
  async function handle(req, res, url, owner, input) {
    const p = url.pathname;
    if (p === '/api/v1/protocol') return json(res, 200, protocol);
    if (p === '/api/v1/post') return json(res, 200, { publication: await publishing.get(url.searchParams.get('id')) });
    if (p === '/api/v1/validate') { validatePublication(input); return json(res, 200, { valid: true, checks: protocol.quality }); }
    if (p === '/api/v1/revoke') return json(res, 200, await publishing.revoke(await publishing.authenticate(req.headers.authorization)));
    if (p === '/api/v1/agents') return json(res, 201, await publishing.register(input, clientAddress(req)));
    if (p === '/api/v1/publications') {
      if (req.method === 'GET') return json(res, 200, { publications: await publishing.rows() });
      const agent = await publishing.authenticate(req.headers.authorization);
      const result = await publishing.submit(agent, input);
      return json(res, result.replayed ? 200 : 201, { ...result, path: `/p/${result.publicationId}` });
    }
    if (p === '/api/v1/history') {
      const id = url.searchParams.get('id');
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail(400, '需要有效的 publicationId');
      const revisions = await publishing.rows(id);
      if (!revisions.length) throw fail(404, '发布不存在');
      return json(res, 200, { revisions });
    }
    if (p === '/api/system/status') return json(res, 200, newsroom ? newsroom.status() : { enabled: false });
    if (p === '/api/changes') return json(res, 200, { enabled: !!newsroom, publications: newsroom?.changes() || [] });
    if (p === '/api/publication-history') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d{1,16}$/.test(id)) throw fail(400, '需要有效的发布 ID');
      const revisions = newsroom?.history(id) || [];
      if (!revisions.length) throw fail(404, '发布不存在');
      return json(res, 200, { revisions });
    }
    if (p === '/api/health') return json(res, 200, { ok: true });
    if (p === '/api/catalog') return json(res, 200, { streams: bus.catalog(), components: registry.list(), agents: Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, version: a.version, style: a.style })), reward: REWARD });
    if (p === '/api/tokens.css') { res.setHeader('content-type', 'text/css'); return res.end(readFileSync(join(ROOT, 'web/tokens.css'))); }
    if (p === '/api/component') { const def = registry.resolve(url.searchParams.get('ref')); if (!def) throw fail(404, '未知组件'); res.setHeader('content-type', 'text/javascript'); return res.end(def.code); }
    if (p === '/api/stream') return bus.attach(res, id => [...(sessions.get(owner)?.streams || [])].some(key => { const [decisionId, stream] = key.split(':'); const imp = impressions.get(decisionId); return stream === id && imp && !imp.closed && bus.allowed(id, imp.decision.agent); }));
    if (p === '/api/snapshot') {
      const id = url.searchParams.get('id'), imp = owned(url.searchParams.get('decisionId'), owner);
      if (!streamAllowed(imp, id, url.searchParams.get('component'))) throw fail(403, '数据流未获授权');
      sessions.get(owner).streams.add(imp.decision.id + ':' + id);
      return json(res, 200, bus.snapshot(id));
    }
    if (p === '/api/feed') {
      const readerCluster = clusterOf(url.searchParams.get('reader')), cards = [];
      const replace = url.searchParams.get('replace'), requestId = url.searchParams.get('requestId');
      checkRequestId(requestId);
      const requests = sessions.get(owner).feedRequests;
      const fingerprint = JSON.stringify([readerCluster, replace]);
      const prior = requestId && requests.get(requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail(409, '同一请求 ID 不能用于不同信息流参数');
        if (prior.response.cards.some(card => impressions.get(card.decisionId)?.closed !== false)) throw fail(409, '该信息流已发生变化，请重新加载');
        return json(res, 200, prior.response);
      }
      const previous = replace ? feedOwned(replace, owner) : [];
      const feedId = randomUUID();
      const results = await Promise.allSettled(STORIES.map(story => cardFor(story, readerCluster, owner, feedId)));
      for (const result of results) if (result.status === 'fulfilled') cards.push(result.value);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) {
        // Await every preparation before cleanup; late completions must not
        // recreate allocations after the failed request has been rolled back.
        for (const card of cards) { impressions.delete(card.decisionId); allocator.decisions.delete(card.decisionId); }
        throw failure.reason;
      }
      for (const imp of previous) close(imp);
      const response = { feedId, readerCluster, cards };
      if (requestId) {
        requests.set(requestId, { fingerprint, response: structuredClone(response) });
        if (requests.size > 100) requests.delete(requests.keys().next().value);
      }
      persist(); return json(res, 200, response);
    }
    if (p === '/api/event') { const imp = owned(input.decisionId, owner); record(imp, input); persist(); return json(res, 200, { ok: true, settled: imp.decision.reward != null }); }
    if (p === '/api/close') { for (const imp of feedOwned(input.feedId, owner)) close(imp); persist(); return json(res, 200, { ok: true }); }
    if (p === '/api/swap') {
      const imp = owned(input.decisionId, owner);
      if (input.storyId !== imp.decision.storyId) throw fail(400, '故事与曝光不匹配');
      checkRequestId(input.requestId);
      if (input.requestId && imp.swapResult?.requestId === input.requestId) {
        if (impressions.get(imp.swapResult.card.decisionId)?.closed !== false) throw fail(409, '替换后的卡片已关闭');
        return json(res, 200, imp.swapResult.card);
      }
      if (imp.closed) throw fail(409, '曝光已关闭');
      const card = await cardFor(STORIES.find(s => s.id === imp.decision.storyId), imp.decision.readerCluster, owner, imp.feedId, imp.decision.agent);
      if (input.requestId) imp.swapResult = { requestId: input.requestId, card: structuredClone(card) };
      close(imp); persist(); return json(res, 200, card);
    }
    if (p === '/api/followup') {
      const imp = owned(input.decisionId, owner);
      if (imp.closed) throw fail(409, '曝光已关闭');
      if (imp.decision.exposedAt == null) throw fail(409, '卡片尚未记录可见曝光');
      checkRequestId(input.eventId);
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 1000) throw fail(400, '问题需为 1–1000 字');
      if (input.eventId && imp.answers && Object.hasOwn(imp.answers, input.eventId)) {
        if (imp.answerQuestions?.[input.eventId] !== undefined && imp.answerQuestions[input.eventId] !== input.question.trim()) throw fail(409, '同一追问 ID 不能用于不同问题');
        return json(res, 200, imp.answers[input.eventId]);
      }
      if (input.eventId && imp.seenEvents.includes(input.eventId)) throw fail(409, '请求 ID 已用于其他事件');
      if (imp.blocks.length >= 40) throw fail(429, '单张卡片追问数量已达上限');
      const block = await withDeadline(() => AGENTS[imp.decision.agent].answer({ story: STORIES.find(s => s.id === imp.decision.storyId), reader: { cluster: imp.decision.readerCluster }, question: input.question.trim(), bus }), agentTimeoutMs);
      const scene = validate({ scene: [block] }, imp.decision.agent);
      const result = scene.scene[0] || null;
      if (result) { imp.blocks.push(result); imp.decision.components.push(result.resolved); record(imp, { type: 'followup', eventId: input.eventId }, { verifiedFollowup: true }); }
      const response = { block: result, errors: [...scene.__verification.errors, ...scene.__verification.citations.filter(c => !c.ok).map(c => c.reason)], verification: scene.__verification };
      if (input.eventId && result) {
        imp.answers ||= {}; imp.answerQuestions ||= {};
        Object.defineProperty(imp.answers, input.eventId, { value: response, enumerable: true, configurable: true });
        Object.defineProperty(imp.answerQuestions, input.eventId, { value: input.question.trim(), enumerable: true, configurable: true });
      }
      persist(); return json(res, 200, response);
    }
    if (p === '/api/leaderboard') {
      const readerCluster = reportingCluster(url);
      return json(res, 200, { dataset: 'reader', readerCluster, policyVersion: 'cluster-ts-v1', table: allocator.table(readerCluster), ledger, ledgerScope: 'all-readers', cache: cache.stats(), agents: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.name])), topicName: TOPIC_NAME });
    }
    if (p === '/api/ope') {
      const readerCluster = reportingCluster(url);
      const decisions = [...allocator.decisions.values()].filter(d => readerCluster == null || d.readerCluster === readerCluster);
      return json(res, 200, { dataset: 'reader', readerCluster, logged: decisions.filter(d => d.reward != null).length,
        greedy: evaluatePolicy(decisions, greedyPolicy(allocator)), uniform: evaluatePolicy(decisions, uniformPolicy(allocator.agents)),
        holdout: evaluateHoldout(decisions, allocator),
        note: '全量拟合结果仅供诊断；留出评估只用训练部分拟合策略。可见性选择、延迟反馈与相关样本仍可能引入偏差。' });
    }
    if (p === '/api/reset') { allocator.reset(); ledger.reset(); cache.clear(); impressions.clear(); for (const s of sessions.values()) { s.streams.clear(); s.feedRequests.clear(); } persist(); return json(res, 200, { ok: true }); }
    if (p === '/api/sim') {
      const readers = input.readers ?? 100;
      if (!Number.isInteger(readers) || readers < 1 || readers > 500) throw fail(400, '模拟读者数需为 1–500');
      if (simulationTask) throw fail(429, '已有模拟实验运行中');
      let report;
      try { simulationTask = runSimulation({ readers, registry, validate, bus }); report = await simulationTask; }
      finally { simulationTask = null; }
      const dir = join(dataDir, 'simulations'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, report.runId + '.json'), JSON.stringify(report), { mode: 0o600 });
      return json(res, 200, report);
    }
  }
  // Restored browser sessions are intentionally invalidated; close their pending exposures.
  for (const imp of impressions.values()) if (!imp.closed) close(imp);
  if (impressions.size) persist();
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (closing) throw fail(503, '服务正在重启');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (platformOnly && !url.pathname.startsWith('/api/v1/') && !['/api/health', '/api/tokens.css'].includes(url.pathname)) throw fail(404, '未知接口');
        if (!routes[url.pathname]) throw fail(404, '未知接口');
        if (![routes[url.pathname]].flat().includes(req.method)) throw fail(405, '请求方法不允许');
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) throw fail(403, '跨站请求不允许');
        const owner = platformOnly || url.pathname.startsWith('/api/v1/') || url.pathname === '/api/health' ? null : session(req, res);
        const input = req.method === 'POST' ? await body(req) : null;
        const work = () => handle(req, res, url, owner, input);
        // Serialize state-changing operations, including feed allocation and LLM waits.
        if ((req.method === 'POST' && url.pathname !== '/api/sim') || url.pathname === '/api/feed') { const task = queue.then(work); queue = task.catch(() => {}); await task; }
        else await work();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, '请求方法不允许');
      const postRoute = /^\/p\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (postRoute) await publishing.get(postRoute[1]);
      const webRoot = join(ROOT, 'web'), file = resolve(webRoot, '.' + decodeURIComponent(url.pathname === '/' || postRoute ? '/platform.html' : url.pathname));
      const bundledMedia = /^\/media\/[a-z0-9-]+-[a-f0-9]{12}-(480|960)\.webp$/.test(url.pathname);
      if (platformOnly && !bundledMedia && !['platform.html', 'platform.js', 'discovery.js', 'platform.css', 'changes.css'].some(name => file === join(webRoot, name))) throw fail(404, '文件不存在');
      if (!file.startsWith(webRoot + sep) || !existsSync(file) || !statSync(file).isFile()) throw fail(404, '文件不存在');
      res.setHeader('content-type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp' })[extname(file)] || 'application/octet-stream');
      if (bundledMedia) {
        const etag = '"' + file.slice(file.lastIndexOf('/') + 1) + '"';
        res.setHeader('cache-control', 'public, max-age=31536000, immutable'); res.setHeader('etag', etag);
        if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
        res.setHeader('content-length', statSync(file).size);
      }
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    } catch (e) { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : '服务器内部错误', ...(e.status && e.code ? { code: e.code, path: e.path } : {}) }); else res.end(); if (!e.status) console.error(e); }
  });
  if (!platformOnly) bus.start();
  newsroom?.start();
  const sweep = setInterval(() => {
    const task = queue.then(() => {
      let changed = false;
      for (const [id, s] of sessions) if (Date.now() - s.lastSeen > 30 * 60 * 1000) {
        for (const imp of impressions.values()) if (imp.owner === id && !imp.closed) { close(imp); changed = true; }
        sessions.delete(id);
      }
      if (changed) persist();
    });
    queue = task.catch(console.error);
  }, 60000); sweep.unref();
  return { server, bus, registry, allocator, ledger, impressions, cache, publishing, close: () => closeTask ||= (async () => {
    closing = true; clearInterval(sweep);
    const drained = new Promise(r => server.close(r));
    bus.stop(); await newsroom?.close(); await drained;
    await simulationTask?.catch(() => {}); await queue;
    for (const imp of impressions.values()) if (!imp.closed) close(imp);
    persist(); publishing.close();
  })() };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let newsroom = null;
  if (process.argv.includes('--live')) {
    const { ReleaseNewsroom } = await import('./ingest/releases.mjs');
    const dataDir = process.env.DATA_DIR || join(ROOT, 'data'); mkdirSync(dataDir, { recursive: true });
    newsroom = new ReleaseNewsroom({ path: join(dataDir, 'releases.sqlite'), repo: process.env.NEWSROOM_REPO || 'langchain-ai/langgraph' });
  }
  const app = createNewsroom({ newsroom });
  app.server.listen(+(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log(`Agent Newsroom http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 8787}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
}
