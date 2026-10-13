// Where a model slots in. With ANTHROPIC_API_KEY set, rewrite summary text from
// the cited sources only; without it, this is a no-op. The output still goes
// through lexical source checks, which do not guarantee factual correctness.
import { readFileSync } from 'node:fs';
const corpus = JSON.parse(readFileSync(new URL('../../data/sources.json', import.meta.url), 'utf8'));

export async function maybeLLM(scene, { story }) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key || !process.env.LLM_MODEL) return;
  const block = scene.scene.find(c => c.component.startsWith('summary@')); if (!block) return;
  const srcText = story.sources.map(s => `【${s}】${corpus[s] || ''}`).join('\n');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      signal: AbortSignal.timeout(8000), method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.LLM_MODEL, max_tokens: 200,
        messages: [{ role: 'user', content: `只用下面的来源，写一段 60 字以内的中文摘要，不要加入来源里没有的事实：\n${srcText}` }] }),
    });
    if (!r.ok) return;
    const j = await r.json(); const text = j.content?.[0]?.text?.trim(); if (text) block.props.text = text;
  } catch { /* keep template text */ }
}
