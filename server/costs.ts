// Estimated API cost. Prices are US$ per million tokens (input, output), from
// Anthropic's published price list. Override or add models with AI_PRICES, e.g.
// AI_PRICES={"claude-sonnet-5-5":[2,10]}. Estimates only: the Anthropic Console
// usage page is the source of truth.

const DEFAULT: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50],
};

let table = DEFAULT;
try { const o = JSON.parse(process.env.AI_PRICES || '{}'); if (o && typeof o === 'object') table = { ...DEFAULT, ...o }; } catch { /* ignore bad JSON */ }

export function costUSD(model: string, inTok: number, outTok: number): number {
  const base = model.replace(/ \(mock\)$/, '');
  const p = table[base] ?? (/haiku/.test(base) ? DEFAULT['claude-haiku-5-5'] : /opus/.test(base) ? DEFAULT['claude-opus-5-5'] : DEFAULT['claude-sonnet-5-5']);
  return (inTok * p[0] + outTok * p[1]) / 1e6;
}
