import { readFileSync, statSync } from 'node:fs';
import { jsonRequest, https, required, AgentError } from './http.mjs';
export const names = { papers: 'PaperTrail', twitter: 'Pulse', news: 'Daybreak', youtube: 'Frame', travel: 'Roam' };
const txt = (x, n = 6000) => typeof x === 'string' ? x.trim().slice(0, n) : '';
const num = x => Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : 0;
const date = x => Number.isFinite(Date.parse(x)) ? new Date(x).toISOString() : null;
export function normalize(kind, raw, env = {}) {
  let items;
  if (kind === 'papers') {
    if (!Array.isArray(raw)) throw new AgentError('SCHEMA', '论文源缺少列表');
    items = raw.map(entry => { const p = entry.paper || entry; return { id: txt(p.id || entry.id, 100), title: txt(entry.title || p.title, 180), text: txt(p.summary || entry.summary), url: `https://huggingface.co/papers/${encodeURIComponent(p.id)}`, code: https(entry.githubRepo || p.githubRepo), publishedAt: date(p.publishedAt), topics: ['AI', 'Papers'], scope: 'Recent Hugging Face paper listings; abstracts only. Code has not been run and results have not been reproduced.' }; });
  } else if (kind === 'twitter') {
    if (!Array.isArray(raw.data) && raw.meta?.result_count !== 0) throw new AgentError('SCHEMA', 'X 响应缺少帖子列表');
    items = (raw.data || []).filter(p => /^\d+$/.test(p.id)).map(p => ({ id: p.id, title: txt(p.text, 90), text: txt(p.text, 3000), url: `https://x.com/i/status/${p.id}`, publishedAt: date(p.created_at), score: num(p.public_metrics?.like_count) + 2 * num(p.public_metrics?.retweet_count), topics: ['Culture', 'X'], scope: `Recent search sample for ${txt(env.X_QUERY || 'AI', 300)}, sorted by likes + 2×reposts; not a platform-wide trend ranking. Claims are unverified.` })).sort((a, b) => b.score - a.score);
  } else if (kind === 'news') {
    if (!Array.isArray(raw.news_results)) throw new AgentError('SCHEMA', '新闻源缺少 news_results');
    const flat = [];
    function walk(list, depth = 0) { if (depth > 4) return; for (const p of list.slice(0, 100)) { if (p.link) flat.push(p); if (p.highlight) walk([p.highlight], depth + 1); if (Array.isArray(p.stories)) walk(p.stories, depth + 1); } }
    walk(raw.news_results);
    items = flat.map(p => ({ id: p.link, title: txt(p.title, 180), text: txt(p.snippet || '', 1500), url: https(p.link), publishedAt: date(p.iso_date), publisher: txt(p.source?.name || p.source?.title, 150), topics: ['News'], scope: 'Google News results via SerpApi. Titles and returned snippets only; full articles were not read. This is not a Google Discover API.' }));
  } else if (kind === 'youtube') {
    if (!Array.isArray(raw.items)) throw new AgentError('SCHEMA', 'YouTube 响应缺少 items');
    items = raw.items.filter(p => /^[\w-]{11}$/.test(p.id)).map(p => ({ id: p.id, title: txt(p.snippet?.title, 180), text: txt(p.snippet?.description, 3000), url: `https://www.youtube.com/watch?v=${p.id}`, publishedAt: date(p.snippet?.publishedAt), publisher: txt(p.snippet?.channelTitle, 150), thumbnail: https(p.snippet?.thumbnails?.high?.url || p.snippet?.thumbnails?.default?.url), score: num(p.statistics?.viewCount), topics: ['Watch'], scope: `YouTube mostPopular / ${env.YOUTUBE_REGION || 'US'} / 类别 ${env.YOUTUBE_CATEGORY || 'All'}; video metadata only. Video and captions were not viewed.` }));
  } else if (kind === 'travel') {
    if (!Array.isArray(raw.entries)) throw new AgentError('SCHEMA', '旅行素材包需要 entries 数组');
    items = raw.entries.map(p => {
      const authorized = p.authorization?.public === true && typeof p.authorization?.statement === 'string' && p.authorization.statement.trim();
      if (!authorized) throw new AgentError('AUTHORIZATION', '旅行素材必须显式声明公开发布授权；不会自动发布未授权素材');
      if (p.authorization.expiresAt && (!date(p.authorization.expiresAt) || Date.parse(p.authorization.expiresAt) <= Date.now())) throw new AgentError('AUTHORIZATION', '旅行素材授权过期或无效');
      if (!/^[\w-]{1,80}$/.test(p.id || '') || !txt(p.notes)) throw new AgentError('SCHEMA', '旅行条目需要稳定 id 和 notes');
      const photos = (p.photos || []).slice(0, 8).map(photo => { if (!https(photo.url) || !txt(photo.alt, 500)) throw new AgentError('SCHEMA', '照片需要公开 HTTPS URL 和描述'); return { url: https(photo.url), alt: txt(photo.alt, 500) }; });
      return { id: p.id, title: txt(p.title, 180), text: txt(p.notes), photos, topics: ['Life', 'Travel'], fictional: p.fictional === true, authorization: txt(p.authorization.statement, 1000), scope: p.fictional ? 'Fictional lifestyle story, not a real personal experience.' : 'Agent-organized notes supplied with publication permission; not the agent’s personal experience or independently verified.' };
    });
  } else throw new AgentError('CONFIG', '未知 agent');
  const unique = new Map();
  for (const p of items) if (p.id && p.title && (kind === 'travel' || https(p.url))) unique.set(p.id, p);
  return [...unique.values()];
}
export async function collect(kind, { env = process.env, fetcher = fetch } = {}) {
  let raw;
  const read = (url, options) => jsonRequest(url, options, fetcher);
  if (kind === 'papers') raw = await read('https://huggingface.co/api/daily_papers?sort=publishedAt&limit=20');
  if (kind === 'twitter') {
    const u = new URL('https://api.x.com/2/tweets/search/recent');
    u.search = new URLSearchParams({ query: env.X_QUERY || 'AI -is:retweet', max_results: '100', 'post.fields': 'created_at,public_metrics', sort_order: 'relevancy' });
    raw = await read(u, { headers: { authorization: `Bearer ${required(env, 'X_BEARER_TOKEN')}` } });
  }
  if (kind === 'news') {
    const u = new URL('https://serpapi.com/search.json');
    u.search = new URLSearchParams({ engine: 'google_news', q: env.NEWS_QUERY || 'technology', gl: env.NEWS_COUNTRY || 'us', hl: env.NEWS_LANGUAGE || 'en', api_key: required(env, 'SERPAPI_API_KEY') }); raw = await read(u);
  }
  if (kind === 'youtube') {
    const u = new URL('https://www.googleapis.com/youtube/v3/videos');
    u.search = new URLSearchParams({ part: 'snippet,statistics', chart: 'mostPopular', regionCode: env.YOUTUBE_REGION || 'US', maxResults: '20', key: required(env, 'YOUTUBE_API_KEY'), ...(env.YOUTUBE_CATEGORY ? { videoCategoryId: env.YOUTUBE_CATEGORY } : {}) }); raw = await read(u);
  }
  if (kind === 'travel') {
    const file = required(env, 'TRAVEL_INPUT');
    if (statSync(file).size > 2 * 1024 * 1024) throw new AgentError('SCHEMA', '旅行素材文件超过 2 MB');
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new AgentError('SCHEMA', '无法读取旅行素材 JSON'); }
  }
  return normalize(kind, raw, env);
}
