const $ = id => document.getElementById(id);
const date = n => n == null ? '尚未成功获取' : new Date(n).toLocaleString('zh-CN');
const labels = { title: '标题', tag: '版本号', publishedAt: '源发布时间', prerelease: '预发布状态', bodyHash: '发布说明指纹', url: '来源链接' };
const element = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; };
async function get(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
  if (!response.ok) throw new Error(`读取失败 (${response.status})`);
  return response.json();
}
function sourceLink(evidence) {
  const link = element('a', '查看官方发布');
  const url = new URL(evidence.url);
  if (url.origin === 'https://github.com') { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  return link;
}
function card(p) {
  const article = document.createElement('article');
  article.append(element('span', p.revision > 1 ? `来源已修订 · 第 ${p.revision} 版` : '首次收录', p.revision > 1 ? 'badge corrected' : 'badge'));
  article.append(element('h2', p.evidence.title));
  article.append(element('p', `官方记录的版本：${p.evidence.tag}${p.evidence.prerelease ? '（预发布）' : ''}`));
  article.append(element('p', `源发布时间：${date(p.evidence.publishedAt)} · 收录/修订：${date(p.observedAt)}`, 'meta'));
  if (p.changes.length) article.append(element('p', '本次变化：' + p.changes.map(c => labels[c.field]).join('、')));
  article.append(sourceLink(p.evidence));
  const details = document.createElement('details'); details.append(element('summary', '证据与版本历史'));
  const content = element('div', '', 'history'); details.append(content);
  let loading = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loading || content.dataset.loaded) return;
    loading = true; content.textContent = '读取历史…';
    try {
      const data = await get('/api/publication-history?id=' + encodeURIComponent(p.id));
      content.replaceChildren();
      for (const r of data.revisions) {
        const block = element('div', '', 'revision');
        block.append(element('strong', `第 ${r.revision} 版 · ${date(r.observedAt)}`));
        block.append(element('p', `来源记录：${r.evidence.title} / ${r.evidence.tag}`));
        for (const c of r.changes) block.append(element('p', `${labels[c.field]}：${String(c.before)} → ${String(c.after)}`));
        block.append(element('code', `Release ID: ${r.id} · SHA-256: ${r.evidence.bodyHash}`));
        block.append(element('p', '证据范围：官方 API 元数据与发布说明指纹；正文未转载，内容真实性未独立验证。', 'meta'));
        content.append(block);
      }
      content.dataset.loaded = 'true';
    } catch (error) { content.textContent = error.message + '；收起后可重新展开重试。'; }
    finally { loading = false; }
  });
  article.append(details); return article;
}
let busy = false, signature = '';
async function refresh() {
  if (busy) return; busy = true; $('refresh').disabled = true;
  try {
    const [status, feed] = await Promise.all([get('/api/system/status'), get('/api/changes')]);
    $('health').textContent = !status.enabled ? '真实来源尚未启用。请用 npm run start:live 启动（Node 22.13+）。'
      : `${status.repo} · ${status.error ? '获取失败，等待自动重试' : status.stale ? '数据尚未就绪或已过期' : '监测中'} · 上次成功：${date(status.lastSuccess)}`;
    $('coverage').textContent = status.enabled ? `${status.coverage}。下次计划获取：${date(status.nextAttempt)}。${status.error || ''}` : '';
    const next = JSON.stringify(feed.publications.map(p => [p.id, p.revision]));
    if (signature !== next) {
      $('changes').replaceChildren(...feed.publications.map(card));
      if (!feed.publications.length) $('changes').append(element('p', '暂无已收录的发布。系统会自动获取来源；此页面不会生成样例代替真实内容。'));
      signature = next;
    }
    $('error').hidden = true;
  } catch (error) { $('error').textContent = error.message + '。当前显示可能已过期，正在等待恢复。'; $('error').hidden = false; }
  finally { busy = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
void refresh();
