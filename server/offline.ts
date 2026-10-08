// Offline fallback, unchanged from the original: rule-based traders that run when
// Claude is unavailable, errors out, or the cost cap has been hit.

import { AGENTS } from './agents.js';

export interface DeskLine { type?: 'desk'; impact: number; speed: string; read: string; kind?: string; category?: string }
export interface TradeLine { type?: 'trade'; id: string; action: string; qty: number; order: string; limit?: number | null; conviction: number; call?: string; signals?: Record<string, number>; thought: string; lesson?: string }

export function offline(headline: string | null, last: number, open: number, random: () => number = Math.random): { desk: DeskLine; trades: TradeLine[] } {
  const t = (headline || '').toLowerCase();
  const pos = ['win', 'wins', 'contract', 'beat', 'record', 'raise', 'approv', 'partner', 'acquire', 'surge', 'breakthrough', 'upgrade', 'buyback', 'profit', 'deal', 'growth'];
  const neg = ['resign', 'fraud', 'short seller', 'alleg', 'investigat', 'recall', 'lawsuit', 'miss', 'cut', 'downgrade', 'fire', 'explo', 'ban', 'loss', 'probe', 'delay', 'rival', 'half', 'audit', 'bankrupt', 'crash'];
  let s = 0; pos.forEach(w => { if (t.includes(w)) s += 1; }); neg.forEach(w => { if (t.includes(w)) s -= 1.3; });
  const impact = headline ? Math.max(-30, Math.min(30, s * 6 + (random() - .5) * 2)) : 0;
  const dir = Math.sign(impact) || (last >= open ? 1 : -1);
  const mag = Math.min(1, Math.abs(impact) / 20);
  const B = dir > 0 ? 'buy' : 'sell', X = dir > 0 ? 'sell' : 'buy';
  const plan: Record<string, [string, number, string]> = {
    marlowe: impact < -6 ? ['buy', 3000, 'Panic is a price. I buy what others are forced to sell.'] : impact > 8 ? ['sell', 1500, 'Euphoria. Trimming into strength, the business did not change that much.'] : ['hold', 0, 'Nothing here changes intrinsic value. Patience.'],
    kestrel: [B, Math.round(1000 + 3000 * mag), dir > 0 ? 'Tape is lifting. Going with it, stop under the last low.' : 'Bids are thin and falling. Short side, tight stop.'],
    juno: [Math.abs(impact) > 3 ? B : 'hold', Math.round(2000 * mag), 'Second-order read agrees with the first, sizing moderately.'],
    ash: [Math.abs(impact) > 4 ? X : 'hold', Math.round(1500 + 1500 * mag), 'Consensus piles in one direction. I take the other side.'],
    vega: [Math.abs(impact) > 10 ? 'sell' : B, Math.abs(impact) > 10 ? 1000 : 600, Math.abs(impact) > 10 ? 'Vol just spiked. Cutting gross exposure.' : 'Small edge, small size.'],
    pip: [B, Math.round(2000 + 4000 * mag), dir > 0 ? 'LETS GO. Sending it, max size.' : 'This is a gift dip... wait no, everyone is selling. Out.'],
  };
  return {
    desk: { impact: +impact.toFixed(1), kind: 'confirmed', category: 'other', speed: Math.abs(impact) > 10 ? 'fast' : 'slow', read: headline ? 'Offline keyword read (Claude not connected).' : 'Floor check on offline rules.' },
    trades: AGENTS.map(a => {
      const act = plan[a.id][0], n = Math.max(-2, Math.min(2, Math.round(impact / 6)));
      return { id: a.id, action: act, qty: plan[a.id][1], order: 'market', conviction: 40 + Math.round(mag * 50), call: act === 'buy' ? 'up' : act === 'sell' ? 'down' : 'flat', signals: { news: n, trend: 0, value: a.id === 'marlowe' ? -n : 0, flow: 0, risk: Math.abs(impact) > 10 ? -1 : 0 }, thought: plan[a.id][2] };
    }),
  };
}
