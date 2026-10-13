// Scene cache. Key = (reader cluster, story, agent, agent version, registry
// version). A story with live streams is still cacheable: the scene is the
// *structure*; the numbers arrive through the bus. Only follow-ups are
// generated per reader, never cached.
export class SceneCache {
  constructor(ttlMs = 5 * 60 * 1000) { this.ttl = ttlMs; this.clear(); }
  clear() { this.map = new Map(); this.hits = 0; this.misses = 0; }
  key({ readerCluster, storyId, agentId, agentVersion, registryVersion }) { return [readerCluster, storyId, agentId, agentVersion, registryVersion].join('|'); }
  get(k) { const e = this.map.get(k); if (!e) { this.misses++; return null; } if (Date.now() - e.t > this.ttl) { this.map.delete(k); this.misses++; return null; } this.hits++; return structuredClone(e.v); }
  set(k, v) { this.map.set(k, { v: structuredClone(v), t: Date.now() }); }
  stats() { return { size: this.map.size, hits: this.hits, misses: this.misses, hitRate: this.hits / Math.max(1, this.hits + this.misses) }; }
}
