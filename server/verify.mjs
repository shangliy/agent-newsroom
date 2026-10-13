// Citation verification. Every `quote@1` and every `summary@1` source claim is
// checked against the source corpus the agent said it used: a quote must appear
// (normalised) inside the cited source; a summary must share enough n-grams with
// at least one cited source. Failing blocks are stripped and the agent is
// reported; retained content still earns its normal reader reward.
import { readFileSync } from 'node:fs';

const norm = (s) => s.normalize('NFKC').replace(/[\s，。、“”"'：:；;！!？?（）()《》—-]/g, '').toLowerCase();
const grams = (s, n = 4) => { const t = norm(s); const g = new Set(); for (let i = 0; i + n <= t.length; i++) g.add(t.slice(i, i + n)); return g; };

// Conservative lexical guard. This checks numeric tokens, not units, entities,
// negation, arithmetic or semantic entailment. Never label it fact verification.
const numbers = text => new Set((text.normalize('NFKC')
  .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '')
  .match(/[+-]?\d+(?:\.\d+)?(?:%|‰)?/g) || []).map(token => token.replace(/^\+/, '')));

export class Verifier {
  constructor(corpusPath) { this.corpus = JSON.parse(readFileSync(corpusPath, 'utf8')); } // {sourceName: text}
  quoteOk(text, source) { const src = Object.hasOwn(this.corpus, source) ? this.corpus[source] : null; return typeof text === 'string' && !!norm(text) && !!src && norm(src).includes(norm(text)); }
  summaryReport(text, sources, threshold = 0.25) {
    if (typeof text !== 'string' || !Array.isArray(sources)) return { ok: false, reason: 'invalid summary or sources' };
    const cited = sources.map(s => typeof s === 'string' && Object.hasOwn(this.corpus, s) ? this.corpus[s] : null);
    if (!cited.length || cited.some(s => typeof s !== 'string')) return { ok: false, reason: 'unknown or missing cited source' };
    const supported = new Set(cited.flatMap(s => [...numbers(s)]));
    const unsupportedNumbers = [...numbers(text)].filter(n => !supported.has(n));
    if (unsupportedNumbers.length) return { ok: false, reason: 'numbers absent from cited sources', unsupportedNumbers };
    const g = grams(text);
    const overlap = g.size ? Math.max(...cited.map(src => {
      const sg = grams(src); return [...g].filter(x => sg.has(x)).length / g.size;
    })) : 0;
    return { ok: g.size > 0 && overlap >= threshold, overlap,
      reason: g.size > 0 && overlap >= threshold ? '' : 'summary not grounded in cited sources' };
  }
  summaryOk(text, sources, threshold = 0.25) { return this.summaryReport(text, sources, threshold).ok; }
  // mutates scene: drops failing blocks, returns report
  check(scene) {
    const report = [];
    scene.scene = scene.scene.filter((c, i) => {
      const name = c.component.split('@')[0];
      if (name === 'quote') { const ok = this.quoteOk(c.props.text, c.props.source); report.push({ i, component: c.component, method: 'normalized-source-substring', ok, reason: ok ? '' : 'quote not found in source' }); return ok; }
      if (name === 'summary') { const result = this.summaryReport(c.props.text, c.props.sources || []); report.push({ i, component: c.component, method: 'text-overlap-and-numeric-tokens', ...result }); return result.ok; }
      return true;
    });
    return report;
  }
}
