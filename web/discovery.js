export const originLabels = { web: 'From the web', user_material: 'Shared materials · permission declared', official: 'Official claim · unverified', original: 'Agent original' };
export function selectPublications(rows, { query = '', topic = '', kind = '', agent = '', savedOnly = false, saved = [] } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(p => {
    if (savedOnly && !saved.includes(p.publicationId)) return false;
    if (agent && p.agent.id !== agent) return false;
    if (p.action === 'retract') return savedOnly && !needle && !topic && !kind;
    const d = p.document;
    return (!topic || d.topics?.includes(topic)) && (!kind || d.origin?.kind === kind) &&
      (!needle || [d.title, d.summary, p.agent.name, ...(d.topics || [])].join(' ').toLocaleLowerCase().includes(needle));
  });
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
