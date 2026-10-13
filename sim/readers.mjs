// Simulated readers: the cold-start instrument for the allocator and the
// ground truth for off-policy evaluation. Hidden preference table = P(reward)
// by reader cluster × topic × agent. Also runnable standalone against a live
// server:  node sim/readers.mjs 200
const BASE = {
  politics: { datadesk: .72, narrator: .55, hype: .45, stylist: .5 }, sports: { datadesk: .6, narrator: .4, hype: .7, stylist: .35 },
  breaking: { datadesk: .5, narrator: .75, hype: .5, stylist: .45 }, entertainment: { datadesk: .35, narrator: .5, hype: .78, stylist: .4 },
  fashion: { datadesk: .4, narrator: .45, hype: .5, stylist: .8 }, travel: { datadesk: .45, narrator: .55, hype: .4, stylist: .78 },
};
const MOD = { data: { datadesk: .15, hype: -.1 }, story: { narrator: .15, datadesk: -.05, hype: -.05 }, hype: { hype: .18, datadesk: -.1, narrator: -.05 }, skim: { narrator: -.1, hype: .05, stylist: -.05 } };
export const truth = (cluster, topic, agent) => Math.max(.02, Math.min(.98, BASE[topic][agent] + (MOD[cluster]?.[agent] || 0)));
// CLI uses the isolated experiment endpoint; it never emits synthetic events
// through the live reader API.
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = +(process.argv[2] || 100), base = process.env.BASE || 'http://localhost:8787';
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('读者数需为 1–500');
  const response = await fetch(`${base}/api/sim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ readers: n }) });
  const report = await response.json(); if (!response.ok) throw new Error(report.error);
  console.log(`独立模拟 ${report.runId} · ${report.impressions} 次曝光`);
  for (const row of report.table) console.log(row.topic.padEnd(14), row.cells.map(c => `${report.agents[c.agent]} ${(c.mean * 100).toFixed(0)} (n=${c.n})`).join('  '));
  for (const [cluster, table] of Object.entries(report.tablesByCluster)) {
    console.log('读者簇:', cluster);
    for (const row of table) console.log(row.topic, row.cells.map(c => `${report.agents[c.agent]} ${(c.mean * 100).toFixed(0)}% n=${c.n}`).join(' | '));
  }
  console.log('OPE', report.ope); console.log(report.note);
}
