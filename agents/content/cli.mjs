import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { names, collect, normalize } from './sources.mjs';
import { compose } from './compose.mjs';
import { fixtures } from './fixtures.mjs';
import { ProducerState, platformOrigin, runAgent } from './runtime.mjs';

async function main() {
  const args = process.argv.slice(2), flags = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i];
    if (['--publish', '--fixture', '--help'].includes(k)) flags[k] = true;
    else if (['--agent', '--limit', '--out', '--watch'].includes(k) && args[i + 1] && !args[i + 1].startsWith('--')) flags[k] = args[++i];
    else throw Error('参数无效；使用 --help');
  }
  if (flags['--help']) { console.log('npm run agents -- --agent all|papers|twitter|news|youtube|travel [--fixture] [--limit 1..5] [--out outputs/content-agents] [--publish] [--watch 秒数>=300]\n默认只生成预览；--fixture 禁止 --publish；--watch 仅用于真实发布。'); return; }
  const target = flags['--agent'] || 'all', kinds = target === 'all' ? Object.keys(names) : [target];
  if (kinds.some(k => !names[k])) throw Error('未知 agent');
  const limit = Number(flags['--limit'] || 3), interval = flags['--watch'] === undefined ? 0 : Number(flags['--watch']);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5 || !Number.isInteger(interval) || interval < 0 || flags['--watch'] !== undefined && interval < 300) throw Error('limit 需要 1..5；watch 至少 300 秒');
  if (flags['--fixture'] && flags['--publish'] || interval && !flags['--publish']) throw Error('虚构样例不能自动发布；watch 必须搭配 --publish');
  if (!flags['--publish']) {
    const out = resolve(flags['--out'] || 'outputs/content-agents'); mkdirSync(out, { recursive: true, mode: 0o700 });
    for (const kind of kinds) {
      try {
        const env = flags['--fixture'] ? {} : process.env;
        const items = flags['--fixture'] ? normalize(kind, fixtures[kind], env).map(p => ({ ...p, fictional: true })) : await collect(kind, { env });
        const docs = []; for (const item of items.slice(0, limit)) docs.push(await compose(kind, item, { env }));
        const path = join(out, `${kind}.json`); writeFileSync(path, JSON.stringify(docs, null, 2), { mode: 0o600 });
        console.log(JSON.stringify({ agent: kind, status: 'preview', count: docs.length, path, fixture: !!flags['--fixture'] }));
      } catch (e) { console.error(JSON.stringify({ agent: kind, status: 'error', code: e.code || 'FAILED' })); process.exitCode = 1; }
    }
    return;
  }
  const origin = platformOrigin(process.env.NEWSROOM_URL || 'http://127.0.0.1:8787');
  const state = new ProducerState(resolve(process.env.AGENT_STATE_DIR || 'data/content-agents'), origin);
  let stopping = false; const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      state.renew();
      for (const kind of kinds) {
        if (stopping) break;
        const result = await runAgent(kind, { state, origin, limit }); console.log(JSON.stringify(result));
        if (!interval && result.status === 'error') process.exitCode = 1;
      }
      if (interval && !stopping) {
        // Renew lease during long intervals; shutdown interrupts sleep.
        for (let left = interval; left > 0 && !stopping; left -= 60) { await setTimeout(Math.min(60, left) * 1000, undefined, { signal: abort.signal }).catch(() => {}); if (!stopping) state.renew(); }
      }
    } while (interval && !stopping);
  } finally { state.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
main().catch(e => { console.error(e.code ? `${e.code}: ${e.message}` : '运行失败，请检查参数、配置与文件权限（--help 查看用法）'); process.exitCode = 1; });
