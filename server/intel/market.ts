// Market intelligence, computed once a second from the simulated state only (never from
// the hidden fair value). Thresholds come from measuring the engine: calm-market 1-min
// realised vol ≈ 125 bps (p99 148), spread p90 ≈ 17 bps, top-8 depth ≈ 4,200 shares,
// |aggressor flow| p90 0.44 / p99 0.60, top-8 imbalance p99 ±0.20.

import type { Engine, Trade } from '../engine.js';
import type { Scorebook } from './stats.js';
import type { IntelV, Regime } from '../../shared/protocol.js';

interface Flow { t: number; q: number }

export class MarketIntel {
  private flow: Flow[] = [];            // signed aggressor quantity per print
  private d8ema = 0;
  private sprHist: number[] = [];
  private v1mEma = 0;
  private crunchTicks = 0;
  regime: Regime = 'CALM';
  regimeSince = 0;
  lastHalt: { t: number; dir: 'up' | 'down' } | null = null;
  lastRoundT = -1e9;
  /** Psychology history for the dot's trail (last 20 seconds). */
  private trail: [number, number][] = [];

  onTrade(tr: Trade) { this.flow.push({ t: tr.t, q: tr.aggr === 'buy' ? tr.q : -tr.q }); if (this.flow.length > 4000) this.flow.splice(0, 1000); }
  onHalt(t: number, dir: 'up' | 'down') { this.lastHalt = { t, dir }; }
  onRound(t: number) { this.lastRoundT = t; }

  compute(eng: Engine, sb: Scorebook, teams: IntelV['teams']): IntelV {
    const S = eng.S, h = S.hist, L = S.last, t = S.t;
    const at = (n: number) => h[Math.max(0, h.length - 1 - n)] ?? L;
    const r30 = L / at(120) - 1, r10 = L / at(40) - 1, r2m = L / at(399) - 1;
    let ss = 0; for (let i = Math.max(1, h.length - 240); i < h.length; i++) { const r = Math.log(h[i] / h[i - 1]); ss += r * r; }
    const rv = Math.sqrt(ss) * 1e4;                                      // bps per minute
    const d = eng.depth(8);
    const bidD = d.bids.reduce((a, l) => a + l.qty, 0), askD = d.asks.reduce((a, l) => a + l.qty, 0), d8 = bidD + askD;
    const bb = d.bids[0]?.price, ba = d.asks[0]?.price;
    const spr = bb && ba ? (ba - bb) / ((ba + bb) / 2) * 1e4 : 0;
    this.d8ema = this.d8ema ? this.d8ema + (d8 - this.d8ema) * (1 / 120) : d8;
    const d8ratio = this.d8ema ? d8 / this.d8ema : 1;
    this.sprHist.push(spr); if (this.sprHist.length > 120) this.sprHist.shift();
    const sprMed = [...this.sprHist].sort((a, b) => a - b)[this.sprHist.length >> 1] || spr;
    while (this.flow.length && this.flow[0].t < t - 240) this.flow.shift();
    let buyV = 0, sellV = 0, v1m = 0, of20 = 0, tot20 = 0;
    for (const f of this.flow) {
      v1m += Math.abs(f.q);
      if (f.t >= t - 120) { if (f.q > 0) buyV += f.q; else sellV -= f.q; }
      if (f.t >= t - 20) { of20 += f.q; tot20 += Math.abs(f.q); }
    }
    this.v1mEma = this.v1mEma ? this.v1mEma + (v1m - this.v1mEma) * (1 / 600) : v1m;
    const ofi = tot20 ? of20 / tot20 : 0;
    const imb = d8 ? (bidD - askD) / d8 : 0;

    // ---- regime, evaluated top-down ----
    const haltRecent = this.lastHalt && t - this.lastHalt.t < 240 ? this.lastHalt.dir : null;
    this.crunchTicks = !S.halted && (spr > 40 || d8ratio < 0.6 || !bidD || !askD) ? this.crunchTicks + 1 : 0;
    let reg: Regime;
    if (S.halted) reg = 'HALTED';
    else if ((r30 < -0.04 && rv > 250) || haltRecent === 'down') reg = 'PANIC';
    else if ((r30 > 0.04 && rv > 250) || haltRecent === 'up') reg = 'EUPHORIA';
    else if (this.crunchTicks >= 3) reg = 'LIQUIDITY CRUNCH';
    else if (rv > 180) reg = 'VOLATILE';
    else if (Math.abs(r30) > 0.015 && Math.sign(r30) === Math.sign(r10)) reg = r30 > 0 ? 'TRENDING UP' : 'TRENDING DOWN';
    else if (t - this.lastRoundT < 120) reg = 'NEWS-DRIVEN';
    else reg = 'CALM';
    if (reg !== this.regime) { this.regime = reg; this.regimeSince = t; }

    // ---- psychology: bull/bear from the AI floor's live calls + aggressor flow; fear/greed from price, vol and halts ----
    let wsum = 0, net = 0;
    const split = { buy: 0, sell: 0, hold: 0 };
    for (const c of sb.latest.values()) {
      const w = Math.pow(0.5, (t - c.t) / 480);
      const dir = c.call === 'up' ? 1 : c.call === 'down' ? -1 : 0;
      net += w * dir * c.conviction / 100; wsum += w;
      if (t - c.t < 480) split[c.action as 'buy' | 'sell' | 'hold']++;
    }
    const aiNet = wsum ? net / wsum : 0;
    const flowAll = buyV + sellV ? (buyV - sellV) / (buyV + sellV) : 0;
    const bull = clamp(0.6 * aiNet + 0.4 * flowAll, -1, 1);
    const stress = clamp((rv - 150) / 300, 0, 1);
    let greed = clamp(r2m / 0.03, -1, 1) - stress * (r2m < 0 ? 1 : 0.4);
    if (haltRecent) greed += haltRecent === 'down' ? -0.6 : 0.3;
    greed = clamp(greed, -1, 1);
    let label: string;
    if (reg === 'PANIC') label = 'PANIC';
    else if (reg === 'EUPHORIA') label = 'EUPHORIA';
    else {
      const g = greed > 0.5 ? 'GREED' : greed > 0.15 ? 'CONFIDENT' : greed < -0.5 ? 'FEAR' : greed < -0.15 ? 'NERVOUS' : 'NEUTRAL';
      const b = bull > 0.25 ? 'BULLISH' : bull < -0.25 ? 'BEARISH' : 'UNDECIDED';
      label = `${b} · ${g}`;
    }
    this.trail.push([+bull.toFixed(3), +greed.toFixed(3)]); if (this.trail.length > 20) this.trail.shift();

    // ---- order-book signals (only what the book and tape show) ----
    const sig: string[] = [];
    if (!S.halted) {
      if (!bidD || !askD) sig.push(!askD ? 'ASK SIDE SWEPT' : 'BID SIDE SWEPT');
      else if (d8ratio < 0.75 && spr > 2 * sprMed) sig.push('LIQUIDITY THINNING');
      if (Math.abs(ofi) > 0.6) sig.push(ofi > 0 ? 'AGGRESSIVE BUYING' : 'AGGRESSIVE SELLING');
      else if (Math.abs(ofi) > 0.45) sig.push(ofi > 0 ? 'BUY PRESSURE' : 'SELL PRESSURE');
      if (Math.abs(imb) > 0.2) sig.push(imb > 0 ? (imb > 0.35 ? 'BIDS STACKED' : 'BID-HEAVY BOOK') : (imb < -0.35 ? 'OFFERS STACKED' : 'ASK-HEAVY BOOK'));
      const lv = [...d.bids, ...d.asks].map(l => l.qty).sort((a, b) => a - b);
      const med = lv[lv.length >> 1] || 1;
      const mid = bb && ba ? (bb + ba) / 2 : L;
      const wallA = d.asks.find(l => l.qty > 3 * med && l.qty >= 600 && Math.abs(l.price / mid - 1) < 0.005);
      const wallB = d.bids.find(l => l.qty > 3 * med && l.qty >= 600 && Math.abs(l.price / mid - 1) < 0.005);
      if (wallA) sig.push(`SELL WALL ${wallA.price.toFixed(2)}`);
      if (wallB) sig.push(`BID WALL ${wallB.price.toFixed(2)}`);
      if (this.v1mEma && v1m > 1.3 * this.v1mEma && v1m > 20000) sig.push('VOLUME SPIKE');
    }

    // ---- smart money: what the most accurate trader currently holds ----
    const oracle = sb.oracle();
    const smart = oracle ? { id: oracle, sh: S.accounts[oracle]?.sh ?? 0 } : null;

    return {
      regime: { name: reg, since: this.regimeSince },
      psych: { bull: +bull.toFixed(3), greed: +greed.toFixed(3), label, split, trail: this.trail.slice() },
      book: { imb: +imb.toFixed(3), ofi: +ofi.toFixed(3), buyV, sellV, spr: +spr.toFixed(1), depth: d8, depthRatio: +d8ratio.toFixed(2), signals: sig.slice(0, 4) },
      stats: { rv: Math.round(rv), r30: +(r30 * 100).toFixed(2), v1m },
      teams, smart,
    };
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
