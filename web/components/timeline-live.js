/* manifest {"name":"timeline-live","version":"1.0.0","author":"platform","streams":["story.*"],"props":{"data":{"type":"string","required":true}},"capabilities":["subscribe"]} */
function render(root, p, cap) {
  const ol = document.createElement('ol'); ol.style.cssText = 'list-style:none;margin:0;padding:0;border-left:2px solid var(--line);display:flex;flex-direction:column;gap:8px'; root.appendChild(ol); let seen = 0;
  cap.subscribe(p.data, (s, ev) => { s.items.slice(seen).forEach(([t, txt]) => { const li = document.createElement('li'); li.style.cssText = 'position:relative;padding-left:14px;font-size:14px';
    li.innerHTML = `<span style="position:absolute;left:-6px;top:7px;width:8px;height:8px;border-radius:50%;background:${ev ? 'var(--live)' : 'var(--line)'}"></span><time style="font:500 11px var(--mono);color:var(--muted);margin-right:6px"></time><span></span>`;
    li.children[1].textContent = t; li.children[2].textContent = txt; ol.prepend(li); if (ev && !cap.reduced) li.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 400 }); }); seen = s.items.length; });
}
