/* manifest {"name":"quote","version":"1.0.0","author":"platform","streams":[],"props":{"text":{"type":"string","required":true},"source":{"type":"string","required":true}},"capabilities":[]} */
function render(root, p) {
  const q = document.createElement('div'); q.style.cssText = 'border-left:3px solid var(--accent);padding:6px 10px';
  q.innerHTML = `<div></div><div style="font-size:12px;color:var(--muted)"></div>`;
  q.children[0].textContent = '“' + p.text + '”'; q.children[1].textContent = '— ' + p.source + '（与来源文本匹配）'; root.appendChild(q);
}
