import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPublications, readSaved, coverImage } from '../web/discovery.js';
import { VERSION, validatePublication } from '../server/publishing/protocol.mjs';
const doc = () => ({ protocol: VERSION, contentId: 'note', revision: 1, action: 'publish', title: '周末旅行', summary: '给散步留一点时间', language: 'zh-CN', topics: ['旅行'], blocks: [{ id: 'body', type: 'text', mode: 'opinion', text: '我更喜欢步行。' }], evidence: [] });

test('三类素材来源可声明，官方不能自授认证，旧发布包保持兼容', () => {
  assert.doesNotThrow(() => validatePublication(doc()));
  for (const kind of ['web', 'user_material', 'official', 'original']) {
    const d = doc(); d.origin = { kind, statement: '素材来源及使用范围说明' };
    if (kind === 'official') d.origin.representedEntity = '示例机构';
    if (kind === 'web') d.evidence = [{ id: 's', url: 'https://example.com', label: '公开来源' }];
    assert.equal(validatePublication(d).origin.kind, kind);
    d.origin.verified = true; assert.throws(() => validatePublication(d), e => e.path === '$.origin.verified');
  }
  for (const origin of [null, { kind: 'official', statement: '官方' }, { kind: 'user_material', statement: '' }, { kind: 'unknown', statement: 'x' }]) assert.throws(() => validatePublication({ ...doc(), origin }));
  assert.throws(() => validatePublication({ ...doc(), origin: { kind: 'web', statement: '转载' } }), e => e.path === '$.evidence');
  assert.throws(() => validatePublication({ protocol: VERSION, contentId: 'note', revision: 2, action: 'retract', reason: '撤回', origin: { kind: 'original', statement: 'x' } }));
});

test('发现筛选组合匹配，撤回内容不重新进入发现，收藏仍能看到撤回状态', () => {
  const rows = [
    { publicationId: 'a', action: 'publish', agent: { id: 'one', name: 'TravelBot' }, document: { ...doc(), origin: { kind: 'web' } } },
    { publicationId: 'b', action: 'publish', agent: { id: 'two', name: 'DesignBot' }, document: { ...doc(), title: '设计', summary: '色彩', topics: ['设计'] } },
    { publicationId: 'c', action: 'retract', agent: { id: 'one', name: 'TravelBot' }, document: { reason: '过期' } },
  ];
  assert.deepEqual(selectPublications(rows).map(p => p.publicationId), ['a', 'b']);
  assert.deepEqual(selectPublications(rows, { query: ' travelbot ', topic: '旅行', kind: 'web', agent: 'one' }).map(p => p.publicationId), ['a']);
  assert.equal(selectPublications(rows, { topic: '设计', kind: 'web' }).length, 0);
  assert.deepEqual(selectPublications(rows, { savedOnly: true, saved: ['a', 'c'] }).map(p => p.publicationId), ['a', 'c']);
  assert.deepEqual(selectPublications(rows, { savedOnly: true, saved: ['a', 'c'], query: '旅行' }).map(p => p.publicationId), ['a']);
});

test('损坏或禁用的收藏存储降级，只有图片成为封面', () => {
  assert.deepEqual(readSaved({ getItem() { throw Error('blocked'); } }), []);
  for (const data of ['null', '{}', 'bad']) assert.deepEqual(readSaved({ getItem: () => data }), []);
  assert.deepEqual(readSaved({ getItem: () => '["a", 1, "a", "b"]' }), ['a', 'b']);
  assert.equal(coverImage({ blocks: [{ type: 'media', mediaType: 'video' }] }), undefined);
  const image = { type: 'media', mediaType: 'image', url: 'https://example.com/a.jpg' };
  assert.equal(coverImage({ blocks: [{ type: 'text' }, image] }), image);
});
