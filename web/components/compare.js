/* manifest {"name":"compare","version":"1.0.0","author":"platform","streams":[],"props":{"cols":{"type":"array","required":true}},"capabilities":[]} */
function render(root, p) {
  const w = document.createElement('div'); w.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px';
  for (const c of p.cols) { const col = document.createElement('div'); col.style.cssText = 'background:var(--surface-2);border-radius:8px;padding:8px 10px;font-size:13px';
    const h = document.createElement('div'); h.style.cssText = 'font-weight:600;margin-bottom:4px'; h.textContent = c.title; col.appendChild(h);
    for (const [k, v] of c.rows) { const r = document.createElement('div'); r.style.cssText = 'display:flex;justify-content:space-between;gap:8px'; r.innerHTML = '<span></span><b></b>'; r.children[0].textContent = k; r.children[1].textContent = v; col.appendChild(r); }
    w.appendChild(col); }
  root.appendChild(w);
}
