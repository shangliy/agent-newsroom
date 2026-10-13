import test from 'node:test';
import assert from 'node:assert/strict';
import { Verifier } from '../server/verify.mjs';
const verifier = new Verifier(new URL('../data/sources.json', import.meta.url));

test('保留文本重合也不能夹带来源中不存在的数字', () => {
  const report = verifier.summaryReport('《海鸥》首日预售 9.9 亿，刷新档期纪录，评分 1.4。影评普遍认为它是年度最安静的大片。', ['票房通', '影评人周刊']);
  assert.equal(report.ok, false);
  assert.deepEqual(report.unsupportedNumbers, ['9.9', '1.4']);
  assert.equal(verifier.summaryOk('《海鸥》首日预售 1.8 亿，刷新档期纪录，评分 8.4。', ['票房通']), true);
});

test('数字支持必须来自声明的来源，未知来源和原型属性名不通过', () => {
  assert.equal(verifier.summaryOk('京都三日预算 700 以内，关键是时间差。', ['旅行库']), false);
  assert.equal(verifier.summaryOk('京都三日的关键是时间差。', ['旅行库', '不存在']), false);
  assert.equal(verifier.summaryOk('京都三日的关键是时间差。', ['toString']), false);
  assert.equal(verifier.quoteOk('anything', 'constructor'), false);
  assert.equal(verifier.quoteOk('', '旅行库'), false);
});

test('支持全角数字与千分位格式；报告明确标注匹配方法', () => {
  assert.equal(verifier.summaryOk('本轮汇总样本量 18400，误差 ±１.１。', ['民调汇总']), true);
  const scene = { scene: [{ component: 'summary@1', props: { text: '《海鸥》首日预售 9.9 亿，刷新档期纪录。', sources: ['票房通'] } }] };
  const report = verifier.check(scene);
  assert.equal(scene.scene.length, 0);
  assert.equal(report[0].method, 'text-overlap-and-numeric-tokens');
});
