/* manifest {"name":"video","version":"1.0.0","author":"platform","streams":["video.*"],"props":{"data":{"type":"string","required":true},"clip":{"type":"string","required":true},"title":{"type":"string"}},"capabilities":["subscribe","emit"]} */
function render(root, p, cap) {
  const w = document.createElement('div'); w.style.cssText = 'position:relative;aspect-ratio:16/9;border-radius:8px;overflow:hidden;background:linear-gradient(135deg,var(--accent-soft),var(--surface-2));display:grid;place-items:center';
  w.innerHTML = `<span style="position:absolute;left:10px;top:8px;font:500 11px var(--mono);color:var(--muted)"></span><button></button><div style="position:absolute;left:0;bottom:0;height:3px;background:var(--accent);width:0%"></div>`;
  const [lbl, btn, prog] = w.children; root.appendChild(w); let t = null, v = 0;
  cap.subscribe(p.data, (s) => { lbl.textContent = 'video · ' + (s.clips[p.clip] || p.clip); btn.textContent = '▶ 播放 ' + (p.title || ''); });
  btn.onclick = () => { if (t) { clearInterval(t); t = null; btn.textContent = '▶ 继续'; return; } cap.emit('interact', { what: 'play', clip: p.clip }); btn.textContent = '❚❚ 播放中';
    t = setInterval(() => { v = Math.min(100, v + 2); prog.style.width = v + '%'; if (v >= 100) { clearInterval(t); t = null; btn.textContent = '↻ 重播'; v = 0; } }, 200); };
}
