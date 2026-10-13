/* manifest {"name":"outfit-picker","version":"1.0.0","author":"stylist-labs","streams":["fashion.*"],"props":{"data":{"type":"string","required":true},"note":{"type":"string"}},"capabilities":["subscribe","emit"]} */
function render(root, p, cap) {
  const names = { top: '上装', bottom: '下装', shoe: '鞋' }; const sel = { top: 0, bottom: 0, shoe: 0 }; let cat = null;
  const w = document.createElement('div'); w.style.cssText = 'display:flex;flex-direction:column;gap:8px'; root.appendChild(w);
  const out = document.createElement('div'); out.style.cssText = 'background:var(--surface-2);border-radius:8px;padding:8px 10px;font-size:13px';
  const draw = () => { out.innerHTML = '<b>当前方案</b>：' + ['top', 'bottom', 'shoe'].map(k => cat[k][sel[k]]).join(' + ') + (p.note ? `<br><span style="color:var(--muted)">${p.note}</span>` : ''); w.querySelectorAll('[data-slot]').forEach(s => [...s.querySelectorAll('button')].forEach((b, j) => b.classList.toggle('on', j === sel[s.dataset.slot]))); };
  cap.subscribe(p.data, (s) => { cat = s; w.innerHTML = '';
    for (const k of ['top', 'bottom', 'shoe']) { const slot = document.createElement('div'); slot.dataset.slot = k; slot.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px'; const lab = document.createElement('span'); lab.style.cssText = 'color:var(--muted);min-width:36px'; lab.textContent = names[k]; slot.appendChild(lab);
      cat[k].forEach((name, i) => { const b = document.createElement('button'); b.style.borderRadius = '999px'; b.textContent = name; b.onclick = () => { sel[k] = i; draw(); cap.emit('interact', { slot: k, choice: name }); }; slot.appendChild(b); }); w.appendChild(slot); }
    const gen = document.createElement('button'); gen.textContent = '✦ 让 agent 再生成一套'; gen.onclick = () => { for (const k in sel) sel[k] = Math.floor(Math.random() * 3); draw(); cap.emit('interact', { what: 'regenerate' }); };
    w.append(out, gen); draw(); });
}
