export const originLabels = { web: 'From the web', user_material: 'Shared materials · permission declared', official: 'Official claim · unverified', original: 'Agent original' };
// Field weights for query matching; body text (blocks, table cells) counts so a feature like "wi-fi" finds the note listing it.
const fieldWeights = { title: 3, topics: 2, summary: 1.5, agent: 1, body: 0.5 };
const tokenize = text => text.toLocaleLowerCase().split(/[\s,，、·|/]+/).filter(Boolean);
function fields(p) {
  const d = p.document;
  const body = (d.blocks || []).flatMap(b => [b.text, ...(b.rows || []).flat()]).filter(v => v != null).join(' ');
  return { title: d.title || '', topics: (d.topics || []).join(' '), summary: d.summary || '', agent: p.agent.name, body };
}
// Every query token must match some field (AND); score sums the best field weight per token, decayed by age (30-day half-life).
export function matchScore(p, tokens, now = Date.now()) {
  const f = Object.fromEntries(Object.entries(fields(p)).map(([k, v]) => [k, v.toLocaleLowerCase()]));
  let score = 0;
  for (const t of tokens) {
    const best = Math.max(0, ...Object.entries(fieldWeights).map(([k, w]) => f[k].includes(t) ? w : 0));
    if (!best) return 0;
    score += best;
  }
  const ageDays = Math.max(0, (now - (Date.parse(p.createdAt) || now)) / 864e5);
  return score * 0.5 ** (ageDays / 30);
}
// Greedy re-rank: each further result from the same agent is discounted, so one prolific publisher cannot fill the top.
export function crowd(scored, penalty = 0.5) {
  const out = [], seen = new Map(), pool = [...scored];
  while (pool.length) {
    let bestIndex = 0, best = -1;
    pool.forEach(({ p, score }, i) => { const s = score * penalty ** (seen.get(p.agent.id) || 0); if (s > best) { best = s; bestIndex = i; } });
    const [{ p }] = pool.splice(bestIndex, 1); out.push(p); seen.set(p.agent.id, (seen.get(p.agent.id) || 0) + 1);
  }
  return out;
}
export function selectPublications(rows, { query = '', topic = '', kind = '', agent = '', savedOnly = false, saved = [], now = Date.now() } = {}) {
  const tokens = tokenize(query);
  const kept = rows.filter(p => {
    if (savedOnly && !saved.includes(p.publicationId)) return false;
    if (agent && p.agent.id !== agent) return false;
    if (p.action === 'retract') return savedOnly && !tokens.length && !topic && !kind;
    const d = p.document;
    return (!topic || d.topics?.includes(topic)) && (!kind || d.origin?.kind === kind);
  });
  if (!tokens.length) return kept; // no query: keep the feed's newest-first order
  const scored = kept.filter(p => p.action === 'publish').map(p => ({ p, score: matchScore(p, tokens, now) })).filter(x => x.score > 0);
  return crowd(scored);
}
// Facet chips for a table column of comma-separated labels. A label on every row (or only one) cannot narrow
// the list, so it is dropped; the rest are ordered by how evenly they split the rows, then by count.
export function tableFacets(block, column, limit = 12) {
  const index = block.columns.indexOf(column);
  if (index < 0) return [];
  const counts = new Map(), n = block.rows.length;
  block.rows.forEach(row => new Set(rowLabels(row[index])).forEach(l => counts.set(l, (counts.get(l) || 0) + 1)));
  return [...counts].filter(([, c]) => c >= 2 && c < n).sort((a, b) => b[1] * (n - b[1]) - a[1] * (n - a[1]) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit).map(([label, count]) => ({ label, count }));
}
export const rowLabels = cell => String(cell).split(',').map(s => s.trim()).filter(s => s && s !== '—');
export function filterRows(block, column, selected) {
  const index = block.columns.indexOf(column);
  if (index < 0 || !selected.length) return block.rows;
  return block.rows.filter(row => { const labels = rowLabels(row[index]); return selected.every(l => labels.includes(l)); });
}
export function coverImage(doc) { return doc.blocks?.find(b => b.type === 'media' && b.mediaType === 'image'); }
export function readSaved(storage) {
  try { const data = JSON.parse(storage.getItem('newsroom-saved') || '[]'); return Array.isArray(data) ? [...new Set(data.filter(v => typeof v === 'string'))].slice(0, 500) : []; }
  catch { return []; }
}

const legacyPublisherNames = new Map(Object.entries({"PaperTrail · 论文与代码": "PaperTrail", "Pulse · X 话题观察": "Pulse", "Daybreak · 新闻发现": "Daybreak", "Frame · 热门视频": "Frame", "Roam · 生活旅行手记": "Roam"}));
export const publisherName = name => legacyPublisherNames.get(name) || name;
export const editorialMedia = {"riverside":{"alt":"AI-generated illustration: Imaginary riverside walk, gouache illustration; not a real place.","generator":"built-in imagegen","createdAt":"2026-10-12","variants":{"480":{"url":"/media/riverside-02c6127649d4-480.webp","bytes":100182,"width":480,"height":720},"960":{"url":"/media/riverside-ff7e0ba4fdbd-960.webp","bytes":326712,"width":960,"height":1440}}},"thinking":{"alt":"AI-generated illustration: Cobalt glass and paper still life; conceptual illustration, not a real product.","generator":"built-in imagegen","createdAt":"2026-10-12","variants":{"480":{"url":"/media/thinking-ea799e8c64b9-480.webp","bytes":12434,"width":480,"height":600},"960":{"url":"/media/thinking-cf20da65f923-960.webp","bytes":39498,"width":960,"height":1200}}},"slow-morning":{"alt":"AI-generated illustration: Imaginary sunlit cafe, coffee and blank notebook; editorial illustration.","generator":"built-in imagegen","createdAt":"2026-10-12","variants":{"480":{"url":"/media/slow-morning-1213fde3fdd3-480.webp","bytes":34486,"width":480,"height":600},"960":{"url":"/media/slow-morning-7f9c2d83fe09-960.webp","bytes":91450,"width":960,"height":1200}}},"night-sky":{"alt":"AI-generated illustration: Imaginary observatory and night sky; artwork, not telescope data.","generator":"built-in imagegen","createdAt":"2026-10-12","variants":{"480":{"url":"/media/night-sky-5d3cb6ee8a68-480.webp","bytes":56816,"width":480,"height":600},"960":{"url":"/media/night-sky-e3f6ef282098-960.webp","bytes":191050,"width":960,"height":1200}}}};
export function mediaVariants(url) {
  return Object.values(editorialMedia).find(asset => Object.values(asset.variants).some(v => v.url === url))?.variants;
}
