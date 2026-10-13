// Component registry: manifests + versioned code. A scene references `name@major`;
// the registry resolves it to the newest compatible build (same major), so the
// platform can ship patches and minors without agents changing a line.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../web/components/', import.meta.url).pathname;

export class Registry {
  constructor() { this.components = new Map(); this.load(); }
  load() {
    for (const f of readdirSync(DIR)) {
      if (!f.endsWith('.js')) continue;
      const src = readFileSync(join(DIR, f), 'utf8');
      const m = src.match(/\/\*\s*manifest\s*([\s\S]*?)\*\//);
      if (!m) continue;
      const manifest = JSON.parse(m[1]);           // {name, version, streams, props, capabilities, author}
      const key = `${manifest.name}@${manifest.version}`;
      this.components.set(key, { ...manifest, key, code: src });
    }
  }
  list() { return [...this.components.values()].map(({ code, ...m }) => m); }
  // "live-chart@2" -> newest 2.x.y ; "live-chart@2.1.0" -> exact
  resolve(ref) {
    if (typeof ref !== 'string') return null;
    const [name, want = ''] = ref.split('@');
    const cands = [...this.components.values()].filter(c => c.name === name);
    if (!cands.length) return null;
    const exact = cands.find(c => c.version === want); if (exact) return exact;
    if (want.includes('.')) return null;
    const major = want.split('.')[0];
    const ok = cands.filter(c => c.version.split('.')[0] === major || want === '');
    ok.sort((a, b) => cmp(b.version, a.version));
    return ok[0] || null;
  }
  // validate a scene against manifests + the bus ACL for the authoring agent
  validate(scene, agentId, bus) {
    const errors = [];
    for (const [i, c] of scene.scene.entries()) {
      if (!c || typeof c !== 'object' || typeof c.component !== 'string') { errors.push(`#${i} invalid block`); continue; }
      const def = this.resolve(c.component);
      if (!def) { errors.push(`#${i} ${c.component}: unknown component`); continue; }
      if (c.props != null && (typeof c.props !== 'object' || Array.isArray(c.props))) { errors.push(`#${i} props must be an object`); continue; }
      if (c.props?.data != null) errors.push(`#${i} data must be declared at block level`);
      if (c.data && !def.capabilities.includes('subscribe')) errors.push(`#${i} subscribe capability required`);
      if (c.data) {
        if (!def.streams.some(p => match(p, c.data))) errors.push(`#${i} ${def.key}: stream ${c.data} not declared in manifest`);
        if (!bus.allowed(c.data, agentId)) errors.push(`#${i} ${def.key}: agent ${agentId} has no ACL for ${c.data}`);
      }
      for (const [k, spec] of Object.entries(def.props || {})) {
        const v = k === 'data' ? c.data : (c.props || {})[k];
        if (spec.required && v == null) errors.push(`#${i} ${def.key}: prop ${k} required`);
        if (v != null && spec.type && typeof v !== spec.type && !(spec.type === 'array' && Array.isArray(v))) errors.push(`#${i} ${def.key}: prop ${k} should be ${spec.type}`);
      }
      if (c.props?.sources && (!Array.isArray(c.props.sources) || !c.props.sources.every(x => typeof x === 'string'))) errors.push(`#${i} sources must be strings`);
      if (def.name === 'compare' && (!Array.isArray(c.props?.cols) || !c.props.cols.every(col => col && typeof col.title === 'string' && Array.isArray(col.rows) && col.rows.every(row => Array.isArray(row) && row.length === 2 && row.every(cell => ['string', 'number'].includes(typeof cell)))))) errors.push(`#${i} invalid comparison columns`);
      c.resolved = def.key;
    }
    return errors;
  }
}
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] || 0) - (y[i] || 0); return 0; };
const match = (pattern, id) => typeof id === 'string' && (pattern === '*' || pattern === id || (pattern.endsWith('*') && id.startsWith(pattern.slice(0, -1))));
