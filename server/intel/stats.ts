// Trader memory. Every AI decision is a CALL ("price goes up / down / nowhere in the
// next 60 seconds, with this much conviction") plus a trade. Sixty simulated seconds
// later the call is scored against what the price actually did. That gives each
// trader a track record, a confidence calibration, a reputation and a risk budget,
// and all of it is fed back into their next prompt. Human trades are scored the
// same way (their side is their call) for stories and achievements.

import { AGENTS } from '../agents.js';
import type { Call } from '../ai/schema.js';
import { money } from '../../shared/format.js';

export const HORIZON_TICKS = 240;      // 60 simulated seconds
export const FLAT_BAND = 0.004;        // |move| under 0.4% counts as "flat"
export const BUCKETS = [[0, 50], [50, 70], [70, 90], [90, 101]] as const;

export interface CallRec {
  who: string; ai: boolean; t: number; px: number; call: Call; conviction: number;
  action: string; qty: number; fill: number | null; head: string; category: string; clock: string;
  /** Debated rounds: the opening view's call. */ opening?: Call | null; debate?: boolean;
  /** Set at the end of the round: did this trader go with the AI majority or against it? */ floor?: 'with' | 'against' | null;
  /** Regime when the call was made. */ regime?: string;
}
export interface Resolved extends CallRec { endPx: number; ret: number; correct: boolean; pnl: number }

export interface TraderStats {
  calls: number; correct: number; streak: number;
  buckets: { n: number; correct: number }[];
  trades: number; wins: number; pnl: number;
  best: { pnl: number; head: string } | null; worst: { pnl: number; head: string } | null;
  convSum: number; recent: boolean[];
  byCat: Record<string, { n: number; correct: number; last?: { head: string; action: string; call: Call; correct: boolean; clock: string } }>;
  /** Tendencies: accuracy when following the floor, fading it, and in stressed regimes. */
  fol: { n: number; c: number }; fade: { n: number; c: number }; stress: { n: number; c: number };
}

export interface TraderRecord { summary: string; budget: number; budgetWhy: string; similar: string | null }

export const emptyStats = (): TraderStats => ({
  calls: 0, correct: 0, streak: 0, buckets: BUCKETS.map(() => ({ n: 0, correct: 0 })),
  trades: 0, wins: 0, pnl: 0, best: null, worst: null, convSum: 0, recent: [], byCat: {},
  fol: { n: 0, c: 0 }, fade: { n: 0, c: 0 }, stress: { n: 0, c: 0 },
});

export const actualOf = (ret: number): Call => ret > FLAT_BAND ? 'up' : ret < -FLAT_BAND ? 'down' : 'flat';
const STRESSED = new Set(['PANIC', 'EUPHORIA', 'LIQUIDITY CRUNCH', 'VOLATILE', 'HALTED']);

/** Accuracy shrunk toward 50% so two lucky calls don't make an oracle. */
export const shrunk = (s: TraderStats) => (s.correct + 2) / (s.calls + 4);
export const stars = (s: TraderStats) => s.calls < 3 ? 0 : Math.max(1, Math.min(5, Math.round((shrunk(s) - 0.3) / 0.1) + 1));

/** Classifies a headline into the desk categories by keywords (used before the desk has read it). */
export function categorise(head: string): string {
  const t = head.toLowerCase();
  const rules: [string, RegExp][] = [
    ['earnings', /earnings|quarter|q[1-4]\b|revenue|profit|eps|beats|misses|results/],
    ['guidance', /guidance|forecast|outlook/],
    ['legal', /lawsuit|probe|fraud|alleg|investigat|sec\b|regulator|antitrust|court|fine|short seller|audit/],
    ['management', /ceo|cfo|chair|resign|steps down|appoint|executive|board/],
    ['product', /launch|unveil|product|chip|recall|model|device|plant|production/],
    ['competition', /rival|competitor|competition|cheaper|half .*cost/],
    ['deal', /acquire|acquisition|merger|takeover|deal|contract|partner|buyback|stake/],
    ['macro', /rates?\b|fed\b|inflation|tariff|recession|economy|china|export/],
    ['supply', /supply|shortage|disruption|fire|strike|factory/],
  ];
  return rules.find(([, re]) => re.test(t))?.[0] ?? 'other';
}

export class Scorebook {
  stats = new Map<string, TraderStats>();
  pending: CallRec[] = [];
  /** Most recent decision per AI trader (for floor psychology). */
  latest = new Map<string, CallRec>();

  constructor(init?: Record<string, TraderStats>) {
    for (const a of AGENTS) this.stats.set(a.id, init?.[a.id] ? { ...emptyStats(), ...init[a.id] } : emptyStats());
  }

  get(id: string) { let s = this.stats.get(id); if (!s) { s = emptyStats(); this.stats.set(id, s); } return s; }

  record(c: CallRec) {
    this.pending.push(c);
    if (this.pending.length > 600) {                         // drop the oldest HUMAN call first: AI calls must be scored
      const i = this.pending.findIndex(x => !x.ai);
      this.pending.splice(i >= 0 ? i : 0, 1);
    }
    if (c.ai) this.latest.set(c.who, c);
  }

  /** Scores every call whose horizon has passed. Returns what was resolved. */
  resolve(t: number, last: number): Resolved[] {
    const out: Resolved[] = [];
    const keep: CallRec[] = [];
    for (const c of this.pending) {
      if (t - c.t < HORIZON_TICKS) { keep.push(c); continue; }
      const ret = last / c.px - 1;
      const actual = actualOf(ret);
      const correct = actual === c.call;
      const dir = c.action === 'buy' ? 1 : c.action === 'sell' ? -1 : 0;
      const pnl = dir && c.fill != null ? dir * c.qty * (last - c.fill) : 0;
      const r: Resolved = { ...c, endPx: last, ret, correct, pnl };
      out.push(r);
      this.apply(r);
    }
    this.pending = keep;
    return out;
  }

  private apply(r: Resolved) {
    const s = this.get(r.who);
    if (r.ai) {
      s.calls++; if (r.correct) s.correct++;
      s.streak = r.correct ? Math.max(1, s.streak + 1) : Math.min(-1, s.streak - 1);
      const b = BUCKETS.findIndex(([lo, hi]) => r.conviction >= lo && r.conviction < hi);
      if (b >= 0) { s.buckets[b].n++; if (r.correct) s.buckets[b].correct++; }
      s.convSum += r.conviction;
      s.recent.unshift(r.correct); if (s.recent.length > 10) s.recent.length = 10;
      const cat = (s.byCat[r.category] ??= { n: 0, correct: 0 });
      cat.n++; if (r.correct) cat.correct++;
      cat.last = { head: r.head.slice(0, 120), action: r.action, call: r.call, correct: r.correct, clock: r.clock };
      const tally = (t: { n: number; c: number }) => { t.n++; if (r.correct) t.c++; };
      if (r.floor === 'with') tally(s.fol); else if (r.floor === 'against') tally(s.fade);
      if (r.regime && STRESSED.has(r.regime)) tally(s.stress);
    }
    if (r.action !== 'hold' && r.fill != null) {
      s.trades++; if (r.pnl > 0) s.wins++; s.pnl += r.pnl;
      if (!s.best || r.pnl > s.best.pnl) s.best = { pnl: Math.round(r.pnl), head: r.head.slice(0, 120) };
      if (!s.worst || r.pnl < s.worst.pnl) s.worst = { pnl: Math.round(r.pnl), head: r.head.slice(0, 120) };
    }
  }

  /** The AI trader with the best shrunk accuracy, once they have 3+ scored calls and beat a coin flip. */
  oracle(): string | null {
    let best: string | null = null, bv = 0.5;
    for (const a of AGENTS) { const s = this.get(a.id); if (s.calls >= 3 && shrunk(s) > bv) { bv = shrunk(s); best = a.id; } }
    return best;
  }

  badges(id: string): string[] {
    const s = this.get(id), b: string[] = [];
    if (this.oracle() === id) b.push('ORACLE');
    if (s.streak >= 3) b.push('HOT HAND');
    if (s.streak <= -3) b.push('COLD');
    const hi = s.buckets[2].n + s.buckets[3].n, hiC = s.buckets[2].correct + s.buckets[3].correct;
    if (hi >= 4 && hiC / hi < 0.45) b.push('OVERCONFIDENT');
    return b;
  }

  /** Risk budget for the next round: the engine enforces it, whatever the model says. */
  budget(id: string, pnlFrac: number, appetite: 'cautious' | 'normal' | 'aggressive'): { budget: number; why: string } {
    const s = this.get(id);
    let f = appetite === 'cautious' ? 0.5 : 1;
    const why: string[] = [];
    if (s.streak <= -3) { f *= 0.5; why.push(`cut after ${-s.streak} wrong calls in a row`); }
    if (pnlFrac < -0.04) { f *= 0.6; why.push('cut for drawdown'); }
    if (appetite === 'cautious') why.push('cautious desk');
    return { budget: Math.max(500, Math.round(6000 * f / 100) * 100), why: why.join(', ') };
  }

  record4prompt(id: string, pnlFrac: number, appetite: 'cautious' | 'normal' | 'aggressive', headCategory: string | null): TraderRecord {
    const s = this.get(id);
    const { budget, why } = this.budget(id, pnlFrac, appetite);
    const parts: string[] = [];
    if (!s.calls) parts.push('no scored calls yet');
    else {
      parts.push(`${s.correct} of ${s.calls} calls right (${Math.round(s.correct / s.calls * 100)}%)`);
      if (Math.abs(s.streak) >= 2) parts.push(s.streak > 0 ? `${s.streak} right in a row` : `${-s.streak} wrong in a row`);
      const hi = s.buckets[2].n + s.buckets[3].n, hiC = s.buckets[2].correct + s.buckets[3].correct;
      if (hi) parts.push(`at conviction 70+: ${hiC} of ${hi} right`);
      if (s.recent.length) parts.push(`last ${Math.min(5, s.recent.length)}: ${s.recent.slice(0, 5).map(x => x ? '✓' : '✗').join('')}`);
    }
    const t = this.tendency(id);
    if (t) parts.push(t);
    if (s.trades) parts.push(`trades ${s.wins}/${s.trades} profitable, ${money(s.pnl)}${s.best ? `, best ${money(s.best.pnl)}` : ''}${s.worst ? `, worst ${money(s.worst.pnl)}` : ''}`);
    const badges = this.badges(id);
    if (badges.length) parts.push(`reputation: ${badges.join(', ')}`);
    let similar: string | null = null;
    const last = headCategory ? s.byCat[headCategory]?.last : undefined;
    if (last) similar = `on a previous ${headCategory} headline ("${last.head}", ${last.clock}) you ${last.action.toUpperCase()} and called ${last.call.toUpperCase()}: you were ${last.correct ? 'RIGHT' : 'WRONG'}. Overall on ${headCategory} news: ${s.byCat[headCategory!].correct} of ${s.byCat[headCategory!].n} right.`;
    return { summary: parts.join('; '), budget, budgetWhy: why, similar };
  }

  /** What the record says about how this trader does with or against the crowd. Only once there is enough data. */
  tendency(id: string): string | null {
    const s = this.get(id), out: string[] = [];
    if (s.fade.n >= 3) out.push(`against the AI majority: ${s.fade.c} of ${s.fade.n} right`);
    if (s.fol.n >= 3) out.push(`with the majority: ${s.fol.c} of ${s.fol.n} right`);
    if (s.stress.n >= 3) out.push(`in stressed markets: ${s.stress.c} of ${s.stress.n} right`);
    return out.length ? out.join(', ') : null;
  }

  floorLine(): string {
    const o = this.oracle();
    return AGENTS.map(a => { const s = this.get(a.id); const b = this.badges(a.id).filter(x => x !== 'ORACLE'); return `${a.name} ${s.calls ? `${s.correct}/${s.calls}` : 'unscored'}${a.id === o ? ' (ORACLE)' : ''}${b.length ? ` (${b.join(', ').toLowerCase()})` : ''}`; }).join('; ');
  }

  /** Calibration rows: stated conviction vs actual hit rate. */
  calibration(id: string) {
    return this.get(id).buckets.map((b, i) => ({ lo: BUCKETS[i][0], hi: Math.min(100, BUCKETS[i][1]), n: b.n, acc: b.n ? b.correct / b.n : null }));
  }

  toJSON(): Record<string, TraderStats> { return Object.fromEntries([...this.stats].filter(([k]) => AGENTS.some(a => a.id === k))); }
}

