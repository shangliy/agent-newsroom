/* manifest {"name":"scoreboard","version":"1.0.0","author":"sportsbox-dev","streams":["scores.*"],"props":{"data":{"type":"string","required":true}},"capabilities":["subscribe"]} */
function render(root, p, cap) {
  const w = document.createElement('div'); w.style.cssText = 'display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;text-align:center'; root.appendChild(w);
  cap.subscribe(p.data, (s) => {
    w.innerHTML = `<div><div style="font-weight:600"></div><div style="font:600 34px/1 var(--mono)"></div></div><div style="font:500 12px var(--mono);color:var(--muted)"></div><div><div style="font-weight:600"></div><div style="font:600 34px/1 var(--mono)"></div></div><div style="grid-column:1/-1;font-size:13px;color:var(--muted);text-align:left"></div>`;
    const c = w.children; c[0].children[0].textContent = s.home[0]; c[0].children[1].textContent = s.home[1]; c[1].innerHTML = `Q${s.q}<br>${s.clock}`; c[2].children[0].textContent = s.away[0]; c[2].children[1].textContent = s.away[1]; c[3].textContent = s.play;
    if (!cap.reduced) { w.animate([{ background: 'var(--accent-soft)' }, { background: 'transparent' }], { duration: 700, easing: 'ease-out' }); }
  });
}
