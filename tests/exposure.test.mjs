import test from 'node:test';
import assert from 'node:assert/strict';
import { ExposureTracker } from '../web/exposure.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  let callback, id = 0;
  const timers = new Map(), events = [], errors = [];
  const card = { el: {} };
  const tracker = new ExposureTracker({
    onImpression: () => events.push('impression'), onDwell: () => events.push('dwell'), onError: e => errors.push(e),
    createObserver: cb => { callback = cb; return { observe() {}, unobserve() {}, disconnect() {} }; },
    setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key),
  });
  tracker.watch(card);
  return { tracker, card, timers, events, errors,
    visible(height) { callback([{ target: card.el, isIntersecting: height > 0, intersectionRect: { height }, boundingClientRect: { height: 1000 } }]); },
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); },
  };
}

test('未入视口不记曝光；长卡片达到可见高度即记一次曝光', async () => {
  const f = fixture(); f.visible(0); await flush(); assert.deepEqual(f.events, []);
  f.visible(100); await flush(); assert.deepEqual(f.events, []);
  f.visible(200); await flush(); assert.deepEqual(f.events, ['impression']);
  f.visible(300); await flush(); assert.deepEqual(f.events, ['impression']); assert.equal(f.timers.size, 1);
  f.tick(); await flush(); assert.deepEqual(f.events, ['impression', 'dwell']);
});

test('后台标签页不记曝光；失焦中断停留计时，回到前台重新计时', async () => {
  const f = fixture(); f.tracker.setActive(false); f.visible(300); await flush();
  assert.deepEqual(f.events, []); assert.equal(f.timers.size, 0);
  f.tracker.setActive(true); await flush(); assert.deepEqual(f.events, ['impression']);
  f.tracker.setActive(false); assert.equal(f.timers.size, 0);
  f.tick(); await flush(); assert.deepEqual(f.events, ['impression']);
  f.tracker.setActive(true); await flush(); assert.equal(f.timers.size, 1);
  f.tick(); await flush(); assert.deepEqual(f.events, ['impression', 'dwell']);
});

test('滚出视口和卸载清理计时；曝光请求未返回时卸载也不会创建新计时器', async () => {
  const f = fixture(); f.visible(300); await flush();
  f.visible(0); assert.equal(f.timers.size, 0);
  f.visible(300); await flush(); f.tracker.dispose(f.card); assert.equal(f.timers.size, 0);
  f.tick(); await flush(); assert.deepEqual(f.events, ['impression']);
  const g = fixture(); let complete;
  g.tracker.onImpression = () => new Promise(resolve => { complete = resolve; });
  g.visible(300); await flush(); g.tracker.dispose(g.card); complete(); await flush();
  assert.equal(g.timers.size, 0);
});

test('曝光上报短暂失败会重试，成功后才开始停留计时', async () => {
  const f = fixture(); let attempts = 0;
  f.tracker.onImpression = () => { if (++attempts === 1) throw new Error('offline'); f.events.push('impression'); };
  f.visible(300); await flush(); assert.equal(attempts, 1); assert.deepEqual(f.events, []);
  f.tick(); await flush(); assert.equal(attempts, 2); assert.deepEqual(f.events, ['impression']);
  f.tick(); await flush(); assert.deepEqual(f.events, ['impression', 'dwell']);
});

test('停留请求失败不永久标记完成，重试等待新的完整可见时间', async () => {
  const f = fixture(); let attempts = 0;
  f.tracker.onDwell = () => { if (++attempts === 1) throw new Error('offline'); f.events.push('dwell'); };
  f.visible(300); await flush(); f.tick(); await flush(); assert.equal(attempts, 1);
  f.tick(); await flush(); assert.equal(attempts, 1); // retry delay, then a fresh dwell interval
  f.tick(); await flush(); assert.equal(attempts, 2); assert.deepEqual(f.events, ['impression', 'dwell']);
});

test('持续断网的可见性上报有重试上限，卸载取消待重试任务', async () => {
  const f = fixture(); let attempts = 0;
  f.tracker.onImpression = () => { attempts++; throw new Error('offline'); };
  f.visible(300); await flush();
  for (let i = 0; i < 5; i++) { f.tick(); await flush(); }
  assert.equal(attempts, 3); assert.equal(f.timers.size, 0);
  const g = fixture(); g.tracker.onImpression = () => { throw new Error('offline'); };
  g.visible(300); await flush(); g.tracker.dispose(g.card); assert.equal(g.timers.size, 0);
});
