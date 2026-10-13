/* manifest {"name":"summary","version":"1.0.0","author":"platform","streams":[],"props":{"text":{"type":"string","required":true},"sources":{"type":"array"}},"capabilities":[]} */
function render(root, p) {
  const t = document.createElement('p'); t.style.margin = '0 0 6px'; t.textContent = p.text; root.appendChild(t);
  const s = document.createElement('div'); s.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;font-size:12px';
  (p.sources || []).forEach(x => { const a = document.createElement('span'); a.style.cssText = 'border:1px solid var(--line);border-radius:6px;padding:1px 7px;color:var(--accent-ink)'; a.textContent = x; s.appendChild(a); });
  root.appendChild(s);
  const note = document.createElement('small'); note.style.color = 'var(--muted)'; note.textContent = '通过来源文本匹配；不代表完整事实核验。'; root.appendChild(note);
}
