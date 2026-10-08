// The market tells stories. This watches what actually happens (moves, splits, calls
// scored, halts, regime changes, leaderboard changes, human timing) and turns notable
// moments into one-line stories for the live feed and the closing Daily Wrap. It also
// awards a few tasteful achievements to human players.

import type { Resolved } from './stats.js';
import type { Regime, StoryV, AchievementId } from '../../shared/protocol.js';
import { fi, money } from '../../shared/format.js';

export const ACHIEVEMENTS: Record<AchievementId, { title: string; desc: string }> = {
  first_blood: { title: 'First Blood', desc: 'First fill on the floor' },
  perfect_timing: { title: 'Perfect Timing', desc: 'Traded right before a 1.5%+ move your way' },
  against_floor: { title: 'Against the Floor', desc: 'Took the other side of the AI majority, and was right' },
  diamond_hands: { title: 'Diamond Hands', desc: 'Held 1,000+ shares through a circuit-breaker halt' },
  ai_slayer: { title: 'AI Slayer', desc: 'Ahead of all six AI traders, in profit' },
};

export class Storyteller {
  stories: StoryV[] = [];
  private seq = 0;
  private cool = new Map<string, number>();      // kind → tick it may fire again
  private lastLeader: string | null = null;
  private humansAhead: boolean | null = null;
  private lastRegime: Regime = 'CALM';
  /** Recent AI majority after each round: used for "against the floor". */
  floorMajority: { side: 'buy' | 'sell'; t: number } | null = null;
  earned = new Map<string, Set<AchievementId>>();
  private holdThroughHalt = new Map<string, number>();

  constructor(private emit: (s: StoryV) => void, private award: (pid: string, a: AchievementId) => void) {}

  add(kind: string, text: string, weight: 1 | 2 | 3, clock: string, t: number, opts: { cool?: number; who?: string } = {}) {
    const until = this.cool.get(kind) ?? -1;
    if (t < until) return;
    if (opts.cool) this.cool.set(kind, t + opts.cool);
    const s: StoryV = { id: ++this.seq, kind, text, weight, clock: clock.slice(0, 5), who: opts.who };
    this.stories.unshift(s);
    if (this.stories.length > 60) this.stories.length = 60;
    this.emit(s);
  }

  give(pid: string, a: AchievementId, name: string, clock: string, t: number) {
    const set = this.earned.get(pid) ?? new Set();
    if (set.has(a)) return;
    set.add(a); this.earned.set(pid, set);
    this.award(pid, a);
    this.add('ach:' + pid + a, `${name} earned ${ACHIEVEMENTS[a].title.toUpperCase()}: ${ACHIEVEMENTS[a].desc.toLowerCase()}.`, 2, clock, t, { who: pid });
  }

  // ---- hooks ----
  onIntel(ticker: string, regime: Regime, r30: number, depthRatio: number, clock: string, t: number) {
    if (regime !== this.lastRegime) {
      const big = ['PANIC', 'EUPHORIA', 'LIQUIDITY CRUNCH', 'HALTED'].includes(regime);
      if (regime !== 'HALTED') this.add('regime', `Regime: ${this.lastRegime} → ${regime}.`, big ? 2 : 1, clock, t, { cool: 40 });
      this.lastRegime = regime;
    }
    if (Math.abs(r30) >= 2) this.add('move', `${ticker} ${r30 > 0 ? 'jumped' : 'fell'} ${Math.abs(r30).toFixed(1)}% in 30 seconds.`, Math.abs(r30) >= 4 ? 3 : 2, clock, t, { cool: 160 });
    if (depthRatio < 0.45) this.add('liq', `Liquidity drained: the top of the book is ${Math.round((1 - depthRatio) * 100)}% thinner than normal.`, 2, clock, t, { cool: 400 });
  }

  onHalt(dir: 'up' | 'down', clock: string, t: number, holders: { pid: string; name: string; sh: number }[]) {
    this.add('halt', `Circuit breaker: limit ${dir}. Trading halted.`, 3, clock, t);
    this.holdThroughHalt.clear();
    for (const h of holders) if (Math.abs(h.sh) >= 1000) this.holdThroughHalt.set(h.pid, Math.sign(h.sh));
  }

  onResume(clock: string, t: number, holders: { pid: string; name: string; sh: number }[]) {
    for (const h of holders) {
      const s = this.holdThroughHalt.get(h.pid);
      if (s && Math.sign(h.sh) === s && Math.abs(h.sh) >= 1000) this.give(h.pid, 'diamond_hands', h.name, clock, t);
    }
    this.holdThroughHalt.clear();
  }

  onRoundEnd(head: string | null, decisions: { id: string; name: string; action: string }[], clock: string, t: number) {
    const n = { buy: 0, sell: 0, hold: 0 } as Record<string, number>;
    decisions.forEach(d => { n[d.action]++; });
    const what = head ? `on "${head.length > 60 ? head.slice(0, 57) + '…' : head}"` : 'on the floor check';
    if (n.buy === 6 || n.sell === 6) this.add('split', `Unanimous: all six AI traders ${n.buy === 6 ? 'bought' : 'sold'} ${what}.`, 3, clock, t);
    else if (n.buy && n.sell && Math.max(n.buy, n.sell) <= 3) this.add('split', `The AI floor split ${n.buy} buy, ${n.sell} sell, ${n.hold} hold ${what}.`, 2, clock, t);
    this.floorMajority = n.buy >= 4 ? { side: 'buy', t } : n.sell >= 4 ? { side: 'sell', t } : null;
  }

  onMindChange(name: string, from: string, to: string, by: string | null, clock: string, t: number) {
    this.add('mind:' + name, `${name} changed their mind in the debate: ${from} → ${to}${by ? ` after ${by}'s challenge` : ''}.`, 2, clock, t);
  }

  onResolved(r: Resolved, name: string, streak: number, ticker: string, clock: string, t: number) {
    const pct = `${r.ret > 0 ? '+' : ''}${(r.ret * 100).toFixed(1)}%`;
    if (r.ai) {
      if (streak >= 3) this.add('streak:' + r.who, `${name} has called ${streak} in a row right.`, streak >= 5 ? 3 : 2, clock, t, { cool: 240 });
      else if (!r.correct && r.conviction >= 85) this.add('humble:' + r.who, `${name} was ${r.conviction}% sure ${ticker} would go ${r.call}. It went ${pct}.`, 2, clock, t, { cool: 240 });
      else if (r.correct && r.conviction >= 80 && Math.abs(r.ret) >= 0.015) this.add('called:' + r.who, `${name} called it: ${r.call.toUpperCase()} at ${r.conviction}% conviction, ${ticker} ${pct}.`, 2, clock, t, { cool: 240 });
      return;
    }
    // humans
    if (r.qty >= 1000 && Math.abs(r.ret) >= 0.015) {
      const verb = r.action === 'buy' ? 'bought' : 'sold';
      if (r.correct) {
        this.add('htime:' + r.who, `${name} ${verb} ${fi(r.qty)} right before a ${pct} move: ${money(r.pnl)}.`, 3, clock, t, { cool: 120, who: r.who });
        this.give(r.who, 'perfect_timing', name, clock, t);
      } else this.add('hmiss:' + r.who, `${name} ${verb} ${fi(r.qty)} right before a ${pct} move the other way.`, 2, clock, t, { cool: 120, who: r.who });
    }
    if (r.correct && this.floorMajority && r.t - this.floorMajority.t < 240 && r.t >= this.floorMajority.t && r.action !== this.floorMajority.side && r.action !== 'hold' && r.pnl > 0)
      this.give(r.who, 'against_floor', name, clock, t);
  }

  onStandings(rows: { id: string; name: string; pnl: number; human: boolean }[], aiTotal: number, humanTotal: number, humans: number, clock: string, t: number) {
    if (!rows.length) return;
    const top = rows[0];
    if (top.id !== this.lastLeader) {
      if (this.lastLeader !== null && top.pnl > 0) this.add('leader', `${top.human ? top.name.toUpperCase() + ' IS' : top.name + ' is'} now #1 on the floor (${money(top.pnl)}).`, top.human ? 3 : 2, clock, t, { cool: 60 });
      this.lastLeader = top.id;
    }
    if (humans) {
      const ahead = humanTotal > aiTotal;
      if (this.humansAhead !== null && ahead !== this.humansAhead) this.add('teams', ahead ? 'Humans pull ahead of the AI floor.' : 'The AI floor retakes the lead from the humans.', 2, clock, t, { cool: 120 });
      this.humansAhead = ahead;
    }
    const bestAi = Math.max(...rows.filter(r => !r.human).map(r => r.pnl));
    for (const r of rows) if (r.human && r.pnl > 0 && r.pnl > bestAi) this.give(r.id, 'ai_slayer', r.name, clock, t);
  }

  onFirstFill(pid: string, name: string, clock: string, t: number) { this.give(pid, 'first_blood', name, clock, t); }

  reset() { this.stories = []; this.cool.clear(); this.lastLeader = null; this.humansAhead = null; this.lastRegime = 'CALM'; this.floorMajority = null; this.earned.clear(); this.holdThroughHalt.clear(); }
}
