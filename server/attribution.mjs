// Reward and attribution.
// Event -> reward is the ONLY place the product defines what "good" means.
// Attribution splits each impression's reward between the content agent and the
// component authors whose components the reader actually touched, with a
// Shapley-style equal split among touched components (a cheap, order-free
// approximation of marginal contribution; replace with per-component holdouts
// when there is enough traffic).

export const REWARD = { impression: 0, dwell: 0.6, expand: 0.65, interact: 0.8, followup: 0.9, like: 1.0, skip: 0.0 };

export function rewardOf(events) {
  // one impression may carry many events; take the max and let skip override.
  if (events.some(e => e.type === 'skip')) return 0;
  return Math.max(0, ...events.map(e => REWARD[e.type] ?? 0));
}

export function attribute(decision, events, { agentShare = 0.6 } = {}) {
  const r = rewardOf(events);
  const touched = new Set(events.filter(e => e.type === 'interact' && decision.components.includes(e.component)).map(e => e.component));
  const out = { agent: { [decision.agent]: r * (touched.size ? agentShare : 1) }, components: {} };
  if (touched.size) { const each = r * (1 - agentShare) / touched.size; for (const c of touched) out.components[c] = each; }
  return { reward: r, split: out };
}

export class Ledger {
  constructor() { this.reset(); }
  reset() { this.agents = {}; this.components = {}; this.authors = {}; }
  credit(split, registry) {
    for (const [a, v] of Object.entries(split.agent)) this.agents[a] = (this.agents[a] || 0) + v;
    for (const [c, v] of Object.entries(split.components)) {
      this.components[c] = (this.components[c] || 0) + v;
      const author = registry?.resolve(c)?.author || 'unknown';
      this.authors[author] = (this.authors[author] || 0) + v;
    }
  }
}
