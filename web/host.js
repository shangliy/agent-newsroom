// Host page: renders scenes, owns the ONE SSE connection, mounts every component
// in its own sandboxed iframe, enforces stream ACLs, and reports events.
(async () => {
  const [{ ExposureTracker }, { createApi, createActionGate }] = await Promise.all([import('/exposure.js'), import('/request.js')]);
  let feedId = null;
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const api = createApi();
  function showError(error) { const box = $('#status'); box.textContent = error.message || '请求失败，请重试'; box.hidden = false; }
  window.addEventListener('unhandledrejection', e => { e.preventDefault(); showError(e.reason || {}); });
  const runAction = createActionGate({
    onBusy: busy => { $('#reader').disabled = busy; $('#reset').disabled = busy; $('#feed').inert = busy; $('#feed').setAttribute('aria-busy', String(busy)); },
    onError: showError,
  });
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const tokensCss = await (await fetch('/api/tokens.css')).text();
  const runtimeJs = await (await fetch('/runtime.js')).text();
  const catalog = await api('/api/catalog');
  const manifests = new Map(catalog.components.map(c => [c.key, c]));
  const matches = (pattern, id) => pattern === '*' || pattern === id || (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1)));
  const codeCache = new Map();
  const getCode = async ref => {
    if (!codeCache.has(ref)) { const r = await fetch('/api/component?ref=' + encodeURIComponent(ref), { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('组件加载失败，请重试'); codeCache.set(ref, await r.text()); }
    return codeCache.get(ref);
  };

  /* ---------- data bus client: one SSE, fan-out to iframes ---------- */
  const streamState = {};                       // id -> {state, version}
  const iframeSubs = {};                        // streamId -> Set(iframeId)
  const frames = {};                            // iframeId -> {iframe, card, componentKey, agentId}
  const es = new EventSource('/api/stream');
  es.addEventListener('stream', (e) => {
    const m = JSON.parse(e.data); streamState[m.id] = { state: m.state, version: m.version };
    for (const fid of iframeSubs[m.id] || []) { const f = frames[fid]; if (f) f.iframe.contentWindow.postMessage({ type: 'data', id: m.id, state: m.state, ev: m.ev }, '*'); }
  });

  const snapshot = f => api(`/api/snapshot?id=${encodeURIComponent(f.data)}&decisionId=${encodeURIComponent(f.card.decisionId)}&component=${encodeURIComponent(f.componentKey)}`);
  es.addEventListener('open', async () => {
    for (const f of Object.values(frames)) if (f.subscribed) {
      try { const s = await snapshot(f); if (frames[f.iframe.name] !== f) continue; f.iframe.contentWindow.postMessage({ type: 'data', id: f.data, state: s.state, ev: null }, '*'); }
      catch (e) { logLine(e.message); }
    }
  });
  const theme = matchMedia('(prefers-color-scheme: dark)');
  theme.addEventListener('change', () => { for (const f of Object.values(frames)) f.iframe.contentWindow.postMessage({ type: 'theme', dark: theme.matches }, '*'); });

  /* ---------- sandbox mount ---------- */
  const BASE_CSS = `html,body{margin:0;background:transparent;color:var(--fg);font-family:var(--font);font-size:14px;line-height:1.5}*{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:5px 9px}button:hover{border-color:var(--accent)}button.on{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast)}a{color:var(--accent-ink)}`;
  async function mount(container, block, card) {
    const id = 'f' + Math.random().toString(36).slice(2, 9);
    const code = await getCode(block.resolved || block.component);
    const iframe = document.createElement('iframe');
    iframe.name = id; iframe.setAttribute('sandbox', 'allow-scripts'); iframe.title = block.resolved;
    iframe.srcdoc = `<!doctype html><html${matchMedia('(prefers-color-scheme: dark)').matches ? ' data-theme="dark"' : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<style>${tokensCss}${BASE_CSS}</style></head><body><div id="root"></div>
<script>${code}<\/script><script>${runtimeJs}<\/script></body></html>`;
    frames[id] = { iframe, card, componentKey: block.resolved, agentId: card.agent.id, data: block.data, manifest: manifests.get(block.resolved) };
    const wrap = h('div', 'comp'); wrap.appendChild(h('div', 'lbl', esc(block.resolved) + (block.data ? ' · ' + esc(block.data) : ''))); wrap.appendChild(iframe); container.appendChild(wrap);
    iframe.addEventListener('load', () => iframe.contentWindow.postMessage({ type: 'init', props: Object.assign({}, block.props || {}, { data: block.data }) }, '*'));
    return id;
  }
  window.addEventListener('message', async (e) => {
    const m = e.data || {}; const f = frames[m.iframeId]; if (!f || e.source !== f.iframe.contentWindow) return;
    if (m.type === 'resize' && Number.isFinite(m.height)) f.iframe.style.height = Math.min(2000, Math.max(24, m.height)) + 'px';
    if (m.type === 'subscribe') {
      if (!f.manifest?.capabilities.includes('subscribe') || m.id !== f.data || !f.manifest.streams.some(p => matches(p, m.id)) || f.subscribed) return;
      f.subscribed = true;
      try {
        (iframeSubs[m.id] ||= new Set()).add(m.iframeId);
        const s = await snapshot(f);
        if (frames[m.iframeId] !== f) return;
        const latest = streamState[m.id];
        const current = latest && latest.version > s.version ? latest : s;
        streamState[m.id] = current;
        f.iframe.contentWindow.postMessage({ type: 'data', id: m.id, state: current.state, ev: null }, '*');
      } catch (err) { f.subscribed = false; iframeSubs[m.id]?.delete(m.iframeId); logLine(err.message); }
    }
    if (m.type === 'emit' && m.event === 'interact' && f.manifest?.capabilities.includes('emit') && tracker.isVisible(f.card)) report(f.card, m.event, m.payload, f.componentKey);
  });

  /* ---------- events ---------- */
  const logEl = $('#log');
  function logLine(text) { const li = h('li', null, `<span>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>${esc(text)}`); logEl.prepend(li); while (logEl.children.length > 40) logEl.lastChild.remove(); }
  async function report(card, type, payload, component) {
    if (type !== 'impression') await tracker.ensure(card);
    card.eventIds ||= {};
    const eventId = type === 'interact' ? crypto.randomUUID() : (card.eventIds[type] ||= crypto.randomUUID());
    const r = await api('/api/event', { decisionId: card.decisionId, eventId, type, payload, component });
    logLine(`${type} · ${card.story.id} · ${card.agent.name}${component ? ' · ' + component : ''}${r.settled ? ' · settled' : ''}`);
    scheduleRail();
  }

  /* ---------- feed ---------- */
  const feed = $('#feed'); const readerSel = $('#reader'); let cards = []; let loading = false;
  const tracker = new ExposureTracker({
    active: document.visibilityState === 'visible',
    onImpression: card => report(card, 'impression'),
    onDwell: card => report(card, 'dwell', { sec: 8 }),
    onError: error => logLine(error.message),
  });
  document.addEventListener('visibilitychange', () => tracker.setActive(document.visibilityState === 'visible'));
  function dispose(card) {
    tracker.dispose(card);
    for (const [id, f] of Object.entries(frames)) if (f.card === card) { for (const subs of Object.values(iframeSubs)) subs.delete(id); delete frames[id]; }
  }
  window.addEventListener('pagehide', () => { tracker.setActive(false); if (feedId) navigator.sendBeacon('/api/close', new Blob([JSON.stringify({ feedId })], { type: 'application/json' })); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); }); 
  async function renderScene(container, card) {
    container.innerHTML = ''; container.className = 'scene' + (card.scene.motion === 'editorial-reveal' ? ' motion-reveal' : '');
    for (const block of card.scene.scene) await mount(container, block, card);
  }
  async function buildCard(card) {
    const el = h('article', 'card'); card.el = el;
    const stripped = (card.verification?.citations || []).filter(c => !c.ok).length + (card.verification?.errors || []).length;
    el.innerHTML = `<div class="card-h"><div class="meta"><span class="chip">${esc(card.story.topicName)}</span>${card.story.live ? '<span class="live">● LIVE</span>' : ''}
      <span class="chip">倾向 ${(card.propensity * 100).toFixed(0)}%</span>${card.cached ? '<span class="chip">cache</span>' : '<span class="chip">generated</span>'}${stripped ? `<span class="chip warn">核验剔除 ${stripped} 块</span>` : ''}</div>
      <h3 class="title">${esc(card.story.title)}</h3><div class="byline">由 <b>${esc(card.agent.name)}</b> v${card.agent.version} 生成 · ${esc(card.agent.style)}</div></div>`;
    const scene = h('div', 'scene'); el.appendChild(scene); await renderScene(scene, card);
    if (readerSel.value === 'skim' && card.scene.scene.length > 2) scene.classList.add('collapsed');
    const actions = h('div', 'actions');
    const b = (t) => h('button', null, t);
    const bExpand = b('展开'), bLike = b('👍 有用'), bSkip = b('跳过'), bSwap = b('换一个 agent'), bSpec = b('{ } 规格 + 核验');
    bExpand.onclick = () => runAction(async () => { await report(card, 'expand'); scene.classList.remove('collapsed'); bExpand.disabled = true; });
    bLike.onclick = () => runAction(async () => { await report(card, 'like'); bLike.disabled = true; });
    bSkip.onclick = () => runAction(async () => { await report(card, 'skip'); await swap(card); });
    bSwap.onclick = () => runAction(() => swap(card));
    const pre = h('pre', 'spec'); pre.textContent = JSON.stringify({ decisionId: card.decisionId, propensity: card.propensity, scene: card.scene, verification: card.verification }, null, 1); pre.hidden = true;
    bSpec.onclick = () => { pre.hidden = !pre.hidden; };
    actions.append(bExpand, bLike, bSkip, bSwap, bSpec); el.appendChild(actions);
    const fu = h('div', 'followup'); const inp = h('input'); inp.type = 'text'; inp.id = 'q-' + card.decisionId; inp.placeholder = `追问（路由给 ${card.agent.name}，实时生成，不走缓存）`; const go = h('button', 'primary', '追问');
    let pendingQuestion = null;
    const ask = () => runAction(async () => { const q = inp.value.trim(); if (!q) return; if (go.disabled) return; go.disabled = true;
      if (pendingQuestion?.question !== q) pendingQuestion = { question: q, eventId: crypto.randomUUID() };
      try { await tracker.ensure(card); const r = await api('/api/followup', { decisionId: card.decisionId, ...pendingQuestion });
      const ans = h('div', 'answer'); ans.appendChild(h('div', 'q', '你：' + esc(q))); if (r.block) await mount(ans, r.block, card); else ans.appendChild(h('div', null, '回答未通过校验：' + esc(r.errors.join('; ')))); el.insertBefore(ans, fu); inp.value = ''; pendingQuestion = null; scheduleRail(); } finally { go.disabled = false; } });
    go.onclick = ask; inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    fu.append(inp, go); el.append(fu, pre);
    return el;
  }
  async function swap(card) {
    if (card.swapping || loading) return; card.swapping = true;
    try { await tracker.ensure(card); card.swapRequestId ||= crypto.randomUUID(); const r = await api('/api/swap', { decisionId: card.decisionId, storyId: card.story.id, requestId: card.swapRequestId });
    const nc = Object.assign({}, card, r); delete nc.el; delete nc.timer; delete nc.dwelled; delete nc.swapping; delete nc.eventIds; delete nc.swapRequestId; const el = await buildCard(nc); dispose(card); card.el.replaceWith(el); cards[cards.indexOf(card)] = nc; watch(nc); scheduleRail(); } finally { card.swapping = false; }
  }
  function watch(card) { tracker.watch(card); }
  let pendingFeed = null;
  async function buildFeed() {
    if (loading) return; loading = true;
    try {
      const reader = readerSel.value;
      if (pendingFeed?.reader !== reader || pendingFeed?.sourceFeedId !== feedId) pendingFeed = { reader, sourceFeedId: feedId, replace: feedId, requestId: crypto.randomUUID() };
      let data;
      const fetchFeed = () => api('/api/feed?' + new URLSearchParams({ reader, requestId: pendingFeed.requestId, ...(pendingFeed.replace ? { replace: pendingFeed.replace } : {}) }));
      try { data = await fetchFeed(); }
      catch (error) {
        // Old session/reset invalidates the previous feed. A fresh request can
        // recover without asking users to clear cookies or reload the browser.
        if (![404, 409].includes(error.status)) throw error;
        pendingFeed = { reader, sourceFeedId: feedId, replace: null, requestId: crypto.randomUUID() };
        data = await fetchFeed();
      }
      await Promise.all([...new Set(data.cards.flatMap(card => card.scene.scene.map(block => block.resolved)))].map(getCode));
      const next = [];
      try { for (const card of data.cards) { await buildCard(card); next.push(card); } }
      catch (error) { for (const card of data.cards) if (card.el) dispose(card); throw error; }
      for (const card of cards) dispose(card);
      tracker.disconnect(); cards = next; feedId = data.feedId; pendingFeed = null;
      feed.replaceChildren(...cards.map(card => card.el));
      for (const card of cards) watch(card);
      $('#status').hidden = true; scheduleRail();
    } finally { loading = false; }
  }

  /* ---------- rail ---------- */
  let railTimer, railVersion = 0;
  function scheduleRail() { clearTimeout(railTimer); railTimer = setTimeout(() => refreshRail().catch(showError), 100); }
  async function refreshRail() {
    const version = ++railVersion;
    const reader = readerSel.value;
    const [lb, ope] = await Promise.all([api('/api/leaderboard?reader=' + reader), api('/api/ope?reader=' + reader)]);
    if (version !== railVersion || reader !== readerSel.value) return;
    const topics = lb.table.map(r => r.topic), agents = Object.keys(lb.agents);
    let html = '<table class="lb"><thead><tr><th>agent</th>' + topics.map(t => `<th>${lb.topicName[t]}</th>`).join('') + '</tr></thead><tbody>';
    const top = Object.fromEntries(lb.table.map(r => [r.topic, r.cells.reduce((b, c) => c.mean > b.mean ? c : b).agent]));
    for (const a of agents) html += `<tr><td>${lb.agents[a]}</td>` + lb.table.map(r => { const c = r.cells.find(x => x.agent === a); return `<td><span class="cell${top[r.topic] === a && c.n > 0 ? ' top' : ''}">${(c.mean * 100).toFixed(0)}<small>n=${c.n}</small></span></td>`; }).join('') + '</tr>';
    $('#lb').innerHTML = `<p class="note">当前读者：${esc(readerSel.selectedOptions[0].textContent)} · 各读者簇独立学习</p>` + html + '</tbody></table>';
    const led = lb.ledger; const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<b>${esc(k)}</b><span>${v.toFixed(1)}</span>`).join('') || '<b>—</b><span>还没有已结算的曝光</span>';
    $('#ledger').innerHTML = `<p class="note">累计分账：全部读者</p><div class="kv">${fmt(Object.fromEntries(Object.entries(led.agents).map(([k, v]) => [lb.agents[k] || k, v])))}</div><p class="note">组件作者</p><div class="kv">${fmt(led.authors || {})}</div><p class="note">缓存命中率 ${(lb.cache.hitRate * 100).toFixed(0)}%（${lb.cache.hits}/${lb.cache.hits + lb.cache.misses}）</p>`;
    const holdout = ope.holdout;
    const result = holdout.status === 'ready'
      ? `<div class="kv"><b>训练 / 留出记录</b><span>${holdout.train} / ${holdout.test}</span><b>留出贪心 IPS / SNIPS</b><span>${holdout.greedy.ips.toFixed(3)} / ${holdout.greedy.snips.toFixed(3)}</span><b>留出均匀 IPS / SNIPS</b><span>${holdout.uniform.ips.toFixed(3)} / ${holdout.uniform.snips.toFixed(3)}</span><b>贪心有效样本量</b><span>${holdout.greedy.effectiveSampleSize.toFixed(1)}</span></div>`
      : `<p class="note">当前读者簇已结算 ${holdout.available} 条记录；至少需要 ${holdout.required} 条才能划分训练和留出数据。</p>`;
    $('#ope').innerHTML = result + `<p class="note">策略只在训练部分拟合。留出结果仍受可见性选择和样本相关性影响。</p><details><summary>全量拟合诊断（不独立）</summary><div class="kv"><b>已结算曝光</b><span>${ope.logged}</span><b>贪心 SNIPS</b><span>${ope.greedy.snips.toFixed(3)}</span><b>均匀 SNIPS</b><span>${ope.uniform.snips.toFixed(3)}</span></div></details>`;

  }
  $('#catalog').innerHTML = `<p class="note">data bus（ACL 标在流后）</p><div class="reg">${catalog.streams.map(s => `<code>${esc(s.id)}${s.acl.includes('*') ? '' : ' 🔒' + s.acl.join('/')}</code>`).join('')}</div>
    <p class="note">component registry（name@version · 作者）</p><div class="reg">${catalog.components.map(c => `<code>${esc(c.key)} · ${esc(c.author)}</code>`).join('')}</div>
    <p class="note">agents</p><div class="reg">${catalog.agents.map(a => `<code>${esc(a.name)} v${a.version}</code>`).join('')}</div>
    <p class="note">event → reward</p><div class="reg">${Object.entries(catalog.reward).map(([k, v]) => `<code>${k} ${v}</code>`).join('')}</div>`;

  $('#sim').onclick = async () => { const b = $('#sim'); b.disabled = true; b.textContent = '模拟中…'; try { const r = await api('/api/sim', { readers: 100 }); logLine(`独立模拟 · ${r.readers} 位读者 · ${r.impressions} 次曝光`);
      $('#sim-result').hidden = false;
      const held = r.ope.holdout;
      $('#sim-result').textContent = `模拟实验 ${r.runId.slice(0, 8)}：${r.readers} 位模拟读者，${r.impressions} 次曝光。贪心 SNIPS ${r.ope.greedy.snips.toFixed(3)}，均匀 SNIPS ${r.ope.uniform.snips.toFixed(3)}。${held.status === 'ready' ? `留出贪心 SNIPS ${held.greedy.snips.toFixed(3)}（训练 ${held.train} / 评估 ${held.test}）。` : '留出样本不足。'}结果未写入真人排行榜；奖励来自预设偏好表。`; } finally { b.disabled = false; b.textContent = '模拟 100 位读者'; } };
  $('#reset').onclick = () => runAction(async () => { await api('/api/reset', {}); feedId = null; pendingFeed = null; logEl.innerHTML = ''; await buildFeed(); });
  readerSel.onchange = () => runAction(buildFeed);
  $('#retry').onclick = () => runAction(buildFeed);
  runAction(buildFeed);
})();
