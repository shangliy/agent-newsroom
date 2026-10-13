import { randomUUID } from 'node:crypto';
// Allocator: Thompson sampling over (reader cluster × topic × agent) with an exploration floor,
// propensity logging for off-policy evaluation, and a decision log so every
// impression can later be scored by any candidate policy.

function normal() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gamma(k) {
  if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4) return d * v; if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
}
const beta = (a, b) => { const x = gamma(a), y = gamma(b); return x / (x + y); };

export const READER_CLUSTERS = ['data', 'story', 'hype', 'skim'];

export class Allocator {
  constructor({ topics, agents, exploreFloor = 0.05, propensitySamples = 200, clusters = READER_CLUSTERS }) {
    this.clusters = [...clusters];
    this.topics = topics; this.agents = agents; this.exploreFloor = exploreFloor; this.propensitySamples = propensitySamples;
    this.reset();
  }
  blank() { return Object.fromEntries(this.topics.map(t => [t, Object.fromEntries(this.agents.map(a => [a, { a: 1, b: 1 }]))])); }
  reset() {
    this.post = this.blank(); // Aggregate reporting only; never drives a cluster's choices.
    this.contextPost = Object.fromEntries(this.clusters.map(c => [c, this.blank()]));
    this.decisions = new Map();
  }
  posterior(t, a, cluster = null) {
    const state = cluster == null ? this.post : this.contextPost[cluster];
    if (!state?.[t]?.[a]) throw new Error('Unknown reader cluster, topic or agent');
    return state[t][a];
  }
  mean(t, a, cluster = null) { const p = this.posterior(t, a, cluster); return p.a / (p.a + p.b); }
  n(t, a, cluster = null) { const p = this.posterior(t, a, cluster); return Math.round(p.a + p.b - 2); }
  // Estimated probability that TS would pick each agent (Monte Carlo) — this is
  // the propensity we log, so IPS/DR estimators can be computed later.
  propensities(t, pool = this.agents, cluster = 'data') {
    const counts = Object.fromEntries(this.agents.map(a => [a, 0]));
    for (let i = 0; i < this.propensitySamples; i++) counts[this.sampleArgmax(t, pool, cluster)]++;
    const k = pool.length, f = this.exploreFloor;
    const p = {};
    for (const a of this.agents) p[a] = pool.includes(a) ? (1 - f) * counts[a] / this.propensitySamples + f / k : 0;   // floor mixes in uniform
    return p;
  }
  sampleArgmax(t, pool = this.agents, cluster = 'data') { let best = null, bs = -1; for (const a of pool) { const p = this.posterior(t, a, cluster); const s = beta(p.a, p.b); if (s > bs) { bs = s; best = a; } } return best; }
  choose({ topic, readerCluster = 'data', exclude = null }) {
    const pool = this.agents.filter(a => a !== exclude);
    if (!pool.length || !this.post[topic] || !this.clusters.includes(readerCluster)) throw new Error('No eligible agents or unknown topic');
    const p = this.propensities(topic, pool, readerCluster);
    // Draw from the very distribution we log: propensity is exact conditional
    // on this Monte Carlo approximation, including excluded actions.
    let u = Math.random(), agent = pool.at(-1);
    for (const a of pool) { u -= p[a]; if (u < 0) { agent = a; break; } }
    const id = randomUUID();
    const decision = { id, ts: Date.now(), policyVersion: 'cluster-ts-v1', topic, readerCluster, agent, eligible: pool,
      propensity: p[agent], propensities: p, reward: null, components: [] };
    this.decisions.set(id, decision);
    return decision;
  }
  update(t, a, r, cluster = 'data') {
    if (!Number.isFinite(r) || r < 0 || r > 1) throw new Error('Reward must be between 0 and 1');
    const context = this.posterior(t, a, cluster), total = this.posterior(t, a);
    for (const p of [context, total]) { p.a += r; p.b += 1 - r; }
  }
  table(cluster = null) { return this.topics.map(t => ({ topic: t, cells: this.agents.map(a => ({ agent: a, mean: this.mean(t, a, cluster), n: this.n(t, a, cluster) })) })); }
}

// Off-policy evaluation: given logged decisions with propensities and rewards,
// estimate the value of a candidate policy π(agent | topic) via IPS and SNIPS.
export function evaluatePolicy(decisions, policy) {
  let ips = 0, w = 0, w2 = 0, n = 0;
  for (const d of decisions) {
    if (d.reward == null) continue; n++;
    const target = policy(d.topic, d.readerCluster, d.eligible)[d.agent] || 0;
    const ratio = target / Math.max(d.propensity, 1e-3);
    ips += ratio * d.reward; w += ratio; w2 += ratio * ratio;
  }
  return n ? { n, ips: ips / n, snips: w ? ips / w : 0, effectiveSampleSize: w2 ? w * w / w2 : 0 } : { n: 0, ips: 0, snips: 0, effectiveSampleSize: 0 };
}
