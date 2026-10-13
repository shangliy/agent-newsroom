/* manifest {"name":"itinerary","version":"1.0.0","author":"stylist-labs","streams":["travel.*"],"props":{"data":{"type":"string","required":true}},"capabilities":["subscribe","emit"]} */
function render(root, p, cap) {
  const tabs = document.createElement('div'); tabs.style.cssText = 'display:flex;gap:6px;margin-bottom:8px'; const ul = document.createElement('ul'); ul.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px'; root.append(tabs, ul);
  let day = 0, plan = null, alt = [];
  const draw = () => { [...tabs.children].forEach((b, i) => b.classList.toggle('on', i === day)); ul.innerHTML = '';
    plan[day].forEach((x, i) => { const li = document.createElement('li'); li.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:14px'; const s = document.createElement('span'); s.textContent = x; const b = document.createElement('button'); b.style.cssText = 'font-size:12px;padding:3px 8px'; b.textContent = '换一个';
      b.onclick = () => { plan[day][i] = alt[Math.floor(Math.random() * alt.length)]; draw(); cap.emit('interact', { day: day + 1, swap: i }); }; li.append(s, b); ul.appendChild(li); }); };
  cap.subscribe(p.data, (s) => { plan = s.days.map(d => [...d]); alt = s.alt; tabs.innerHTML = ''; plan.forEach((_, i) => { const b = document.createElement('button'); b.textContent = '第 ' + (i + 1) + ' 天'; b.onclick = () => { day = i; draw(); cap.emit('interact', { tab: i + 1 }); }; tabs.appendChild(b); }); draw(); });
}
