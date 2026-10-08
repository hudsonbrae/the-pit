// AI science: the room as a running experiment, measured from scored calls only.
//
// Question: does a floor debate make the AI traders smarter? In a debated round every
// trader states an opening view (a call) before the challenges and a final call after
// them. Both are scored against what the price did 60 s later, so the room measures,
// call by call, whether arguing helped. Single (non-debated) rounds are the control.
//
// Alongside it: herding (how much the floor agrees, by regime: do they move as one
// in a panic?), who moves together and who takes the other side, and whether the
// desk's read of a headline pointed the right way.

import { AGENTS } from '../agents.js';
import type { Resolved } from './stats.js';
import type { ScienceV } from '../../shared/protocol.js';

type Tally = { n: number; c: number };
const pct = (t: Tally) => t.n ? Math.round(t.c / t.n * 100) : null;
export const STRESSED = new Set(['PANIC', 'EUPHORIA', 'LIQUIDITY CRUNCH', 'VOLATILE', 'HALTED']);
const MIN_N = 6;

export class Science {
  open: Tally = { n: 0, c: 0 };        // debated rounds, opening views
  final: Tally = { n: 0, c: 0 };       // debated rounds, final calls
  flips: Tally = { n: 0, c: 0 };       // the debate changed the call; c = the new call was right
  single: Tally = { n: 0, c: 0 };      // non-debated rounds (control)
  desk: Tally = { n: 0, c: 0 };        // desk's fair-value direction vs the 60 s move
  herd = { calm: { sum: 0, n: 0 }, stressed: { sum: 0, n: 0 } };
  pairs: Record<string, { same: number; opp: number; n: number }> = {};

  /** After every AI round: how unanimous the floor was, and who sided with whom. */
  onRound(regime: string, decisions: { id: string; action: string }[]) {
    if (decisions.length < 4) return;
    const n: Record<string, number> = { buy: 0, sell: 0, hold: 0 };
    decisions.forEach(d => { n[d.action] = (n[d.action] ?? 0) + 1; });
    const agree = Math.max(n.buy, n.sell, n.hold) / decisions.length;
    const h = STRESSED.has(regime) ? this.herd.stressed : this.herd.calm;
    h.sum += agree; h.n++;
    for (let i = 0; i < decisions.length; i++) for (let j = i + 1; j < decisions.length; j++) {
      const [a, b] = [decisions[i], decisions[j]].sort((x, y) => x.id.localeCompare(y.id));
      if (a.action === 'hold' && b.action === 'hold') continue;
      const p = (this.pairs[`${a.id}|${b.id}`] ??= { same: 0, opp: 0, n: 0 });
      p.n++; if (a.action === b.action) p.same++; else if (a.action !== 'hold' && b.action !== 'hold') p.opp++;
    }
  }

  onResolved(r: Resolved, actual: 'up' | 'down' | 'flat') {
    if (!r.ai) return;
    if (r.debate) {
      this.final.n++; if (r.correct) this.final.c++;
      if (r.opening) {
        this.open.n++; if (r.opening === actual) this.open.c++;
        if (r.opening !== r.call) { this.flips.n++; if (r.correct) this.flips.c++; }
      }
    } else { this.single.n++; if (r.correct) this.single.c++; }
  }

  /** The desk said +x% to fair value; did the price move that way in 60 s? (Moves inside the flat band don't count.) */
  onHeadlineMoved(impact: number, movedPct: number) {
    if (Math.abs(impact) < 0.5 || Math.abs(movedPct) < 0.4) return;
    this.desk.n++; if (Math.sign(impact) === Math.sign(movedPct)) this.desk.c++;
  }

  view(): ScienceV {
    const name = (id: string) => AGENTS.find(a => a.id === id)?.name ?? id;
    const o = pct(this.open), f = pct(this.final);
    let verdict: string;
    if (this.final.n < MIN_N || this.open.n < MIN_N) verdict = `Collecting data: ${this.final.n} of ${MIN_N} debated calls scored.`;
    else if (o != null && f != null && Math.abs(f - o) < 5) verdict = `Debate made no real difference: ${o}% → ${f}% over ${this.final.n} calls.`;
    else verdict = `Debate ${f! > o! ? 'improved' : 'hurt'} the floor: opening views ${o}% right, final calls ${f}% (${this.final.n} calls).`;
    const hc = this.herd.calm.n ? +(this.herd.calm.sum / this.herd.calm.n).toFixed(2) : null;
    const hs = this.herd.stressed.n ? +(this.herd.stressed.sum / this.herd.stressed.n).toFixed(2) : null;
    const rel = Object.entries(this.pairs).filter(([, p]) => p.n >= 4).map(([k, p]) => {
      const [a, b] = k.split('|'); const same = p.same / p.n, opp = p.opp / p.n;
      const kind = same >= 0.75 ? 'twins' as const : opp >= 0.5 ? 'rivals' as const : null;
      return { a: name(a), b: name(b), rate: +(kind === 'rivals' ? opp : same).toFixed(2), n: p.n, kind };
    }).filter(x => x.kind).sort((x, y) => y.rate * y.n - x.rate * x.n).slice(0, 4) as ScienceV['relations'];
    return {
      debate: { open: o, final: f, n: this.final.n, flips: this.flips.n, flipsRight: this.flips.c },
      single: { acc: pct(this.single), n: this.single.n },
      desk: { acc: pct(this.desk), n: this.desk.n },
      herding: { calm: hc, stressed: hs },
      relations: rel, verdict,
    };
  }
}
