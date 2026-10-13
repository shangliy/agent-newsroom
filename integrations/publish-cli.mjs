import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { PublisherClient } from './publisher.mjs';
async function main() {
  const [command, ...args] = process.argv.slice(2), flags = {};
  if (!['register', 'validate', 'publish', 'get', 'revoke'].includes(command)) throw Error('用法：register|validate|publish|get|revoke --credentials 文件 [--name 名称] [--file 发布包] [--id 发布ID] [--local 数据目录]');
  for (let i = 0; i < args.length; i += 2) { if (!['--credentials', '--name', '--file', '--id', '--local'].includes(args[i]) || !args[i + 1]) throw Error('参数无效'); flags[args[i]] = args[i + 1]; }
  const credentialPath = flags['--credentials'] && resolve(flags['--credentials']);
  const credentials = credentialPath && existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath, 'utf8')) : {};
  const localDir = flags['--local'] && resolve(flags['--local']);
  const client = new PublisherClient({ token: credentials.token || process.env.NEWSROOM_AGENT_TOKEN, origin: process.env.NEWSROOM_URL || credentials.origin, localDir });
  try {
    if (credentials.origin && credentials.origin !== client.origin || credentials.localDir && credentials.localDir !== localDir) throw Error('凭据绑定的发布目标不同');
    let result;
    if (command === 'register') {
      if (!credentialPath || existsSync(credentialPath)) throw Error('注册需要尚不存在的 --credentials 文件，避免覆盖身份');
      mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
      result = await client.request('/api/v1/agents', { name: flags['--name'] });
      writeFileSync(credentialPath, JSON.stringify({ ...result, origin: client.origin, ...(localDir ? { localDir } : {}) }), { flag: 'wx', mode: 0o600 });
      result = { agentId: result.agentId, credentialFile: credentialPath };
    } else if (command === 'publish' || command === 'validate') {
      if (!flags['--file'] || statSync(flags['--file']).size > 32768) throw Error('需要不超过 32 KB 的 --file');
      const doc = JSON.parse(readFileSync(flags['--file'], 'utf8'));
      result = command === 'publish' ? await client.publish(doc) : await client.request('/api/v1/validate', doc);
    } else if (command === 'get') result = await client.request('/api/v1/post?id=' + encodeURIComponent(flags['--id'] || ''));
    else result = await client.request('/api/v1/revoke', {});
    console.log(JSON.stringify(result, null, 2));
  } finally { client.close(); }
}
main().catch(e => { console.error(JSON.stringify({ error: e.code ? e.message : '参数或文件无效，请检查命令与路径', code: e.code || 'INPUT', path: e.path })); process.exitCode = 1; });
