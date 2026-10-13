import { Allocator, evaluatePolicy } from './allocator.mjs';

export function greedyPolicy(allocator) {
  return (topic, cluster, pool = allocator.agents) => {
    const best = pool.reduce((b, a) => allocator.mean(topic, a, cluster) > allocator.mean(topic, b, cluster) ? a : b);
    return { [best]: 1 };
  };
}
export const uniformPolicy = agents => (_topic, _cluster, pool = agents) => Object.fromEntries(pool.map(a => [a, 1 / pool.length]));

// Fit the candidate on one partition only, then freeze it for evaluation.
// This is an offline split by decision time, not a replay of deployment time:
// delayed feedback and correlated observations still limit interpretation.
export function evaluateHoldout(decisions, { topics, agents, minPerPartition = 20 }) {
  const settled = decisions.filter(d => d.reward != null).sort((a, b) => a.ts - b.ts);
  if (settled.length < minPerPartition * 2) return {
    status: 'insufficient-data', available: settled.length, required: minPerPartition * 2,
    train: 0, test: 0, greedy: null, uniform: null,
  };
  const cut = Math.min(settled.length - minPerPartition, Math.max(minPerPartition, Math.floor(settled.length * .7)));
  const train = settled.slice(0, cut), test = settled.slice(cut);
  const candidate = new Allocator({ topics, agents });
  for (const d of train) candidate.update(d.topic, d.agent, d.reward, d.readerCluster);
  return { status: 'ready', available: settled.length, train: train.length, test: test.length,
    trainLastDecisionAt: train.at(-1).ts, testFirstDecisionAt: test[0].ts,
    greedy: evaluatePolicy(test, greedyPolicy(candidate)), uniform: evaluatePolicy(test, uniformPolicy(agents)),
    selectedAgents: Object.fromEntries(candidate.clusters.map(cluster => [cluster,
      Object.fromEntries(topics.map(topic => [topic, Object.keys(greedyPolicy(candidate)(topic, cluster))[0]]))])),
  };
}
