// Synthetic experiments have their own allocator, ledger and cache. They never
// update reader state, and deliberately use templates rather than paid LLM calls.
import { randomUUID } from 'node:crypto';
import { greedyPolicy, uniformPolicy, evaluateHoldout } from './evaluation.mjs';
import { Allocator, evaluatePolicy } from './allocator.mjs';
import { Ledger, attribute } from './attribution.mjs';
import { SceneCache } from './cache.mjs';
import { AGENTS } from './agents/index.mjs';
import { STORIES, TOPICS, TOPIC_NAME } from './stories.mjs';
import { truth } from '../sim/readers.mjs';

export async function runSimulation({ readers, registry, validate, bus }) {
  const allocator = new Allocator({ topics: TOPICS, agents: Object.keys(AGENTS) });
  const cache = new SceneCache(), ledger = new Ledger();
  for (let i = 0; i < readers; i++) {
    const cluster = ['data', 'story', 'hype', 'skim'][Math.floor(Math.random() * 4)];
    for (const story of STORIES) {
      const decision = allocator.choose({ topic: story.topic, readerCluster: cluster });
      const key = `${cluster}|${story.id}|${decision.agent}`;
      let scene = cache.get(key);
      if (!scene) {
        scene = validate(structuredClone(AGENTS[decision.agent].build({ story, reader: { cluster }, bus })), decision.agent);
        cache.set(key, scene);
      }
      decision.storyId = story.id; decision.dataset = 'synthetic';
      decision.components = scene.scene.map(c => c.resolved);
      const events = [{ type: Math.random() < truth(cluster, story.topic, decision.agent) ? 'like' : 'skip' }];
      const { reward, split } = attribute(decision, events);
      decision.reward = reward; allocator.update(story.topic, decision.agent, reward, cluster); ledger.credit(split, registry);
    }
    // Allow live readers' requests to proceed between batches.
    if (i % 10 === 9) await new Promise(resolve => setImmediate(resolve));
  }
  const decisions = [...allocator.decisions.values()];
  const greedy = greedyPolicy(allocator), uniform = uniformPolicy(allocator.agents);
  return { runId: randomUUID(), dataset: 'synthetic', readers, impressions: decisions.length,
    cacheHits: cache.hits, cache: cache.stats(), ledger, table: allocator.table(), tablesByCluster: Object.fromEntries(allocator.clusters.map(c => [c, allocator.table(c)])),
    agents: Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.name])), topicName: TOPIC_NAME,
    ope: { greedy: evaluatePolicy(decisions, greedy), uniform: evaluatePolicy(decisions, uniform), holdout: evaluateHoldout(decisions, allocator) },
    decisions, note: '独立模拟实验；奖励由预设偏好表产生，不代表实际内容质量或真人偏好。每次运行从零开始。' };
}
