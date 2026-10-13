/* manifest {"name":"live-chart","version":"2.1.0","author":"platform","streams":["polls.*"],"props":{"data":{"type":"string","required":true},"compare":{"type":"array","required":true}},"capabilities":["subscribe"]} */
function render(root, p, cap) {
  const svgBox = document.createElement('div'); const nums = document.createElement('div'); nums.style.cssText = 'display:flex;gap:16px;font-variant-numeric:tabular-nums;font-size:13px;margin-top:4px';
  root.append(svgBox, nums);
  const colors = ['var(--accent)', 'var(--warn)'];
  cap.subscribe(p.data, (s) => {
    const keys = Object.keys(s.series).slice(0, 2); const series = keys.map(k => s.series[k]); const n = series[0].length, W = 320, H = 110, pad = 18;
    const all = series.flat(), lo = Math.min(...all) - 1, hi = Math.max(...all) + 1;
    const x = i => pad + i * (W - 2 * pad) / (n - 1), y = v => H - pad - (v - lo) * (H - 2 * pad) / (hi - lo);
    const path = (a, c) => `<path d="${a.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ')}" fill="none" stroke="${c}" stroke-width="2.2"/>`;
    const grid = [lo + 1, (lo + hi) / 2, hi - 1].map(v => `<line x1="${pad}" x2="${W - pad}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pad - 4}" y="${y(v) + 3}" font-size="8" text-anchor="end" fill="var(--muted)">${v.toFixed(0)}</text>`).join('');
    svgBox.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block" role="img" aria-label="走势">${grid}${series.map((a, i) => path(a, colors[i]) + `<circle cx="${x(n - 1)}" cy="${y(a.at(-1))}" r="3.5" fill="${colors[i]}"/>`).join('')}</svg>`;
    nums.innerHTML = series.map((a, i) => `<div><span style="color:${colors[i]}">${p.compare[i]}</span> <b style="font-size:18px">${a.at(-1).toFixed(1)}%</b></div>`).join('') + `<div style="color:var(--muted)">差距 ${(series[0].at(-1) - series[1].at(-1)).toFixed(1)}</div>`;
  });
}
