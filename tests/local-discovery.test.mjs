import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../agents/local-discovery/', import.meta.url));

// The Python agent has its own unittest suite that cross-validates every document with protocol.mjs.
test('本地发现 agent 的 Python 测试通过（有 python3 时）', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 不可用' }, () => {
  const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests', '-q'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  assert.match(run.stderr, /OK/);
});

test('离线夹具预览生成有效发布包，且不会发布', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 不可用' }, () => {
  const out = join(root, '..', '..', 'outputs', 'local-discovery');
  const run = spawnSync('python3', ['-m', 'local_discovery', '--fixture', '--no-model', '--out', out, '--state-dir', join(out, 'state')], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stderr.slice(-2000));
  const line = JSON.parse(run.stdout.trim().split('\n').pop());
  assert.equal(line.contentId, 'local-cafe-santa-clara');
  assert.equal(line.found, 80);
  const refused = spawnSync('python3', ['-m', 'local_discovery', '--fixture', '--publish'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
});
