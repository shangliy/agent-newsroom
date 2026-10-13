import test from 'node:test';
import assert from 'node:assert/strict';
import { Allocator } from '../server/allocator.mjs';
import { evaluateHoldout, greedyPolicy } from '../server/evaluation.mjs';

const config = { topics: ['news'], agents: ['a', 'b'] };
test('相反读者偏好分别学习，其他读者簇保持冷启动', () => {
  const a = new Allocator(config);
  for (let i = 0; i < 30; i++) {
    a.update('news', 'a', 1, 'data'); a.update('news', 'b', 0, 'data');
    a.update('news', 'a', 0, 'hype'); a.update('news', 'b', 1, 'hype');
  }
  assert.deepEqual(greedyPolicy(a)('news', 'data'), { a: 1 });
  assert.deepEqual(greedyPolicy(a)('news', 'hype'), { b: 1 });
  assert.equal(a.mean('news', 'a', 'skim'), .5);
  assert.equal(a.n('news', 'a', 'skim'), 0);
  assert.equal(a.n('news', 'a'), 60);
  assert.equal(a.mean('news', 'a'), .5);
  a.reset(); assert.equal(a.n('news', 'a', 'data'), 0);
});

test('选择概率使用目标读者簇，排除 agent 后策略仍限制在候选池', () => {
  const a = new Allocator(config);
  const seen = [];
  a.sampleArgmax = (_topic, pool, cluster) => { seen.push(cluster); return pool.includes(cluster === 'hype' ? 'b' : 'a') ? (cluster === 'hype' ? 'b' : 'a') : pool[0]; };
  const p = a.propensities('news', a.agents, 'hype');
  assert.ok(seen.every(c => c === 'hype')); assert.ok(p.b > p.a);
  const d = a.choose({ topic: 'news', readerCluster: 'hype', exclude: 'b' });
  assert.equal(d.agent, 'a'); assert.equal(d.propensity, 1); assert.equal(d.propensities.b, 0);
  assert.equal(d.policyVersion, 'cluster-ts-v1');
  assert.deepEqual(greedyPolicy(a)('news', 'hype', ['a']), { a: 1 });
  assert.throws(() => a.choose({ topic: 'news', readerCluster: 'unknown' }));
});

test('留出奖励不参与策略拟合，改变留出标签只能改变评估分数', () => {
  const train = Array.from({ length: 28 }, (_, i) => ({
    ts: i, topic: 'news', readerCluster: 'data', agent: i % 2 ? 'b' : 'a',
    eligible: ['a', 'b'], propensity: .5, reward: i % 2 ? 0 : 1,
  }));
  const validation = Array.from({ length: 12 }, (_, i) => ({
    ts: i + 28, topic: 'news', readerCluster: 'data', agent: i % 2 ? 'b' : 'a',
    eligible: ['a', 'b'], propensity: .5, reward: i % 2 ? 1 : 0,
  }));
  // Use 20/20 at N=40; make every item in the first 20 favor a.
  const decisions = [...train.slice(0, 20), ...validation, ...validation.slice(0, 8).map((d, i) => ({ ...d, ts: 40 + i }))];
  const original = structuredClone(decisions);
  const report = evaluateHoldout(decisions, config);
  assert.equal(report.train, 20); assert.equal(report.test, 20);
  assert.equal(report.selectedAgents.data.news, 'a'); assert.equal(report.greedy.snips, 0);
  const changed = decisions.map((d, i) => i < 20 ? d : { ...d, reward: 1 - d.reward });
  const other = evaluateHoldout(changed, config);
  assert.deepEqual(other.selectedAgents, report.selectedAgents);
  assert.equal(other.greedy.snips, 1);
  assert.deepEqual(decisions, original);
});

test('留出评估显式报告样本不足，不把空样本输出成零收益', () => {
  const report = evaluateHoldout([], config);
  assert.equal(report.status, 'insufficient-data'); assert.equal(report.required, 40);
  assert.equal(report.greedy, null); assert.equal(report.uniform, null);
});
