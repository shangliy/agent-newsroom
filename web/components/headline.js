/* manifest {"name":"headline","version":"1.0.0","author":"platform","streams":[],"props":{"text":{"type":"string","required":true}},"capabilities":[]} */
function render(root, p) { const h = document.createElement('h3'); h.style.cssText = 'margin:0;font-size:18px;line-height:1.3'; h.textContent = p.text; root.appendChild(h); }
