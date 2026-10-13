// Component runtime — runs INSIDE the sandboxed iframe. It is the only code a
// component can talk to. Network is closed by the iframe's CSP; the host is the
// single door, and this file is the lock on it.
//
// host  -> component : {type:'init', props, data?}  {type:'data', id, state, ev}  {type:'theme', dark}
// component -> host  : {type:'ready'} {type:'subscribe', id} {type:'emit', event, payload} {type:'resize', height}
(() => {
  const subs = {}; let initialized = false;
  const post = (m) => parent.postMessage({ ...m, iframeId: window.name }, '*');
  const cap = Object.freeze({
    subscribe(id, cb) { (subs[id] ||= []).push(cb); post({ type: 'subscribe', id }); },
    emit(event, payload) { post({ type: 'emit', event, payload }); },
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
  });
  const root = document.getElementById('root');
  new ResizeObserver(() => post({ type: 'resize', height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);
  window.addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data || {};
    if (m.type === 'init' && !initialized) { initialized = true; try { window.render(root, m.props || {}, cap); } catch (err) { root.textContent = '组件错误：' + err.message; } post({ type: 'ready' }); }
    if (m.type === 'data') (subs[m.id] || []).forEach(cb => cb(m.state, m.ev));
    if (m.type === 'theme') document.documentElement.dataset.theme = m.dark ? 'dark' : 'light';
  });
  // belt and braces: no fetch/XHR even if CSP were misconfigured
  window.fetch = () => Promise.reject(new Error('network disabled in component sandbox'));
  window.XMLHttpRequest = function () { throw new Error('network disabled in component sandbox'); };
})();
