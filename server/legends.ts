// Legends: the all-time records of this server, across every room and session.
// Offered when a session closes (and live for AI streaks). Persisted in the store
// (table `legends`) so they survive restarts; held in memory when there is no database.
// Holder names are display names players chose (already cleaned), never tokens.

import type { Store, LegendRow } from './store/store.js';
import type { LegendV } from '../shared/protocol.js';

export type LegendKey = 'human_session' | 'ai_session' | 'human_trade' | 'ai_streak' | 'fastest' | 'wildest' | 'slayer';

export const LEGENDS: Record<LegendKey, { title: string; unit: '$' | '%' | 's' | 'calls' | 'pts'; lower?: boolean; min: number }> = {
  human_session: { title: 'Best human session', unit: '$', min: 1 },
  slayer: { title: 'Biggest win over the AI floor', unit: 'pts', min: 0.25 },
  human_trade: { title: 'Best single human trade', unit: '$', min: 1 },
  fastest: { title: 'Fastest reaction to a headline', unit: 's', lower: true, min: 1 },
  ai_session: { title: 'Best AI trader session', unit: '$', min: 1 },
  ai_streak: { title: 'Longest AI calling streak', unit: 'calls', min: 3 },
  wildest: { title: 'Wildest session (high to low)', unit: '%', min: 3 },
};

export const fmtLegend = (key: LegendKey, v: number) => {
  const u = LEGENDS[key].unit;
  return u === '$' ? '$' + Math.round(v).toLocaleString('en-US') : u === '%' ? v.toFixed(1) + '%' : u === 's' ? v.toFixed(1) + 's' : u === 'pts' ? '+' + v.toFixed(2) + ' pts' : `${v} in a row`;
};

export class Legends {
  rows = new Map<LegendKey, LegendRow>();
  constructor(private store: Store | null) {}

  async hydrate() {
    if (!this.store) return;
    // keep whichever is better if a record was offered before the database answered
    for (const r of await this.store.loadLegends()) {
      if (!Object.hasOwn(LEGENDS, r.key) || !Number.isFinite(r.value)) continue;
      const k = r.key as LegendKey, cur = this.rows.get(k);
      if (!cur || (LEGENDS[k].lower ? r.value < cur.value : r.value > cur.value)) this.rows.set(k, r);
    }
  }

  /** Records `value` if it beats the standing record. Returns true for a new record. */
  offer(key: LegendKey, holder: string, value: number, detail: string, room: string): boolean {
    const def = LEGENDS[key], cur = this.rows.get(key);
    if (!Number.isFinite(value) || value < def.min) return false;
    if (cur && (def.lower ? value >= cur.value : value <= cur.value)) return false;
    const row: LegendRow = { key, holder: holder.slice(0, 20), value, detail: detail.slice(0, 160), room_code: room, at: new Date().toISOString() };
    this.rows.set(key, row);
    void this.store?.saveLegend(row);
    return true;
  }

  list(): LegendV[] {
    return (Object.keys(LEGENDS) as LegendKey[]).filter(k => this.rows.has(k)).map(k => {
      const r = this.rows.get(k)!;
      return { key: k, title: LEGENDS[k].title, holder: r.holder, value: fmtLegend(k, r.value), detail: r.detail, at: r.at.slice(0, 10) };
    });
  }
}
