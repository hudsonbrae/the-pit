// ===== THE PIT — exchange engine (limit order book + rule-based crowd) =====
// TypeScript port of the original engine.js. The logic is kept line-for-line where
// possible; the changes are: one instance per room (a class instead of a singleton),
// an injectable random source (so tests are deterministic), a configurable start
// price, an optional real-price anchor for Real Market mode, and bounded event /
// trade buffers so a long-running room does not grow in memory.

export type Side = 'buy' | 'sell';
export interface Order { id: number; owner: string; side: Side; price: number; qty: number }
export interface Trade { id: number; price: number; q: number; aggr: Side; buyer: string; seller: string; t: number }
export interface Candle { idx: number; t: number; o: number; h: number; l: number; c: number; v: number }
export interface Halt { start: number; end: number | null; dir: 'up' | 'down'; t: number }
export interface Account { cash: number; sh: number; vol: number; start: number; cost?: number }
export type EngineEvent =
  | { type: 'halt'; dir: 'up' | 'down'; t: number }
  | { type: 'resume'; price: number; t: number };
export interface SubmitResult { filled: number; avg: number; rest: number; queued?: boolean }
export interface Level { price: number; qty: number }

export const DT = 0.25, CANDLE = 20; // 250ms ticks, 5s candles
export const r2 = (x: number) => Math.round(x * 100) / 100;

/** Small seedable PRNG (mulberry32). Tests pass a seed; rooms use Math.random. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface EngineState {
  t: number; last: number; open: number; hi: number; lo: number; fv: number; fvTarget: number; fvK: number;
  bids: Order[]; asks: Order[]; seq: number; trades: Trade[]; candles: Candle[]; cur: Candle | null;
  halted: number; haltCool: number; halts: Halt[]; hist: number[]; accounts: Record<string, Account>; mmInv: Record<string, number>;
  vwapN: number; vwapD: number; pending: [string, Side, number, number | null][]; events: EngineEvent[]; volume: number;
  tradeSeq: number;
  /** Real Market mode: the latest real last price. null in Sim mode. */
  anchor: number | null;
}

export class Engine {
  S: EngineState;
  private R: () => number;
  /** Called for every print, so the room can stream fills without diffing arrays. */
  onTrade: ((t: Trade) => void) | null = null;
  /** Per-tick pull of fvTarget toward the real price (Real mode). ~0.2%/tick ≈ 2 min half-life. */
  anchorK = 0.002;

  constructor(opts: { start?: number; random?: () => number } = {}) {
    const p = opts.start ?? 100;
    this.R = opts.random ?? Math.random;
    this.S = {
      t: 0, last: p, open: p, hi: p, lo: p, fv: p, fvTarget: p, fvK: 0.03,
      bids: [], asks: [], seq: 0, trades: [], candles: [], cur: null,
      halted: 0, haltCool: 0, halts: [], hist: [], accounts: {}, mmInv: {},
      vwapN: 0, vwapD: 0, pending: [], events: [], volume: 0, tradeSeq: 0, anchor: null,
    };
  }

  private gauss() { let u = 0, v = 0; while (!u) u = this.R(); while (!v) v = this.R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  private acct(o: string, dq: number, dc: number) {
    const S = this.S, a = S.accounts[o];
    if (a) { a.sh += dq; a.cash += dc; a.vol += Math.abs(dq); }
    else if (o.startsWith('mm')) S.mmInv[o] = (S.mmInv[o] || 0) + dq;
  }

  private trade(buyer: string, seller: string, price: number, q: number, aggr: Side) {
    const S = this.S;
    S.last = price;
    this.acct(buyer, q, -q * price);
    this.acct(seller, -q, q * price);
    const tr: Trade = { id: ++S.tradeSeq, price, q, aggr, buyer, seller, t: S.t };
    S.trades.unshift(tr);
    if (S.trades.length > 80) S.trades.length = 80;
    const c = S.cur;
    if (c) { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += q; }
    S.hi = Math.max(S.hi, price); S.lo = Math.min(S.lo, price);
    S.vwapN += price * q; S.vwapD += q; S.volume += q;
    this.onTrade?.(tr);
  }

  private insert(o: Order) {
    const arr = o.side === 'buy' ? this.S.bids : this.S.asks;
    let i = 0;
    if (o.side === 'buy') while (i < arr.length && arr[i].price >= o.price) i++;
    else while (i < arr.length && arr[i].price <= o.price) i++;
    arr.splice(i, 0, o);
  }

  cancel(owner: string) {
    const S = this.S;
    S.bids = S.bids.filter(o => o.owner !== owner);
    S.asks = S.asks.filter(o => o.owner !== owner);
  }

  // price === null -> market order
  submit(owner: string, side: Side, qty: number, price: number | null): SubmitResult {
    const S = this.S;
    qty = Math.floor(qty);
    if (!(qty > 0)) return { filled: 0, avg: 0, rest: 0 };
    if (price != null) price = r2(price);
    if (S.halted > 0) { S.pending.push([owner, side, qty, price]); return { filled: 0, avg: 0, rest: qty, queued: true }; }
    const opp = side === 'buy' ? S.asks : S.bids;
    let left = qty, filled = 0, notional = 0;
    while (left > 0 && opp.length) {
      const b = opp[0];
      if (price != null && (side === 'buy' ? b.price > price : b.price < price)) break;
      const q = Math.min(left, b.qty);
      if (side === 'buy') this.trade(owner, b.owner, b.price, q, 'buy');
      else this.trade(b.owner, owner, b.price, q, 'sell');
      b.qty -= q; left -= q; filled += q; notional += q * b.price;
      if (b.qty <= 0) opp.shift();
    }
    if (left > 0 && price != null) this.insert({ id: ++S.seq, owner, side, price, qty: left });
    return { filled, avg: filled ? notional / filled : 0, rest: price != null ? left : 0 };
  }

  private newCandle() {
    const S = this.S, L = S.last;
    S.cur = { idx: S.candles.length ? S.candles[S.candles.length - 1].idx + 1 : 0, t: S.t, o: L, h: L, l: L, c: L, v: 0 };
    S.candles.push(S.cur);
    if (S.candles.length > 900) S.candles.shift();
  }

  private quoteMM(m: number, L: number) {
    const S = this.S, R = this.R;
    const id = 'mm' + m;
    this.cancel(id);
    const inv = S.mmInv[id] || 0;
    const ref = L * 0.88 + S.fv * 0.12;
    const skew = -inv * 0.000003 * L;
    const half = Math.max(0.02, L * 0.0005 * (1 + m * 0.6));
    for (let k = 0; k < 4; k++) {
      const step = half * (1 + k * 1.3);
      const sz = Math.round(120 + R() * 260);
      this.submit(id, 'buy', sz, ref + skew - step);
      this.submit(id, 'sell', sz, ref + skew + step);
    }
  }

  private crowd() {
    const S = this.S, R = this.R;
    S.fvTarget *= Math.exp(this.gauss() * 0.0006);
    if (S.anchor != null) S.fvTarget += (S.anchor - S.fvTarget) * this.anchorK;
    S.fv += (S.fvTarget - S.fv) * S.fvK;
    // market makers
    for (let m = 0; m < 4; m++) if (R() < 0.45 || !S.bids.length || !S.asks.length) this.quoteMM(m, S.last);
    const L = S.last;
    // fundamental traders
    for (let i = 0; i < 22; i++) if (R() < 0.12) {
      const est = S.fv * (1 + this.gauss() * 0.012);
      const gap = (est - S.last) / S.last;
      if (Math.abs(gap) > 0.003) {
        const q = Math.round(Math.min(400, 20 + Math.abs(gap) * 8000 * R()));
        this.submit('f' + i, gap > 0 ? 'buy' : 'sell', q, null);
      }
    }
    // noise traders
    for (let i = 0; i < 18; i++) if (R() < 0.08) this.submit('n' + i, R() < 0.5 ? 'buy' : 'sell', 10 + Math.round(R() * 90), null);
    // momentum traders
    const ref = S.hist[Math.max(0, S.hist.length - 40)] || L;
    const ret = L / ref - 1;
    for (let i = 0; i < 10; i++) if (R() < 0.08 && Math.abs(ret) > 0.004) this.submit('m' + i, ret > 0 ? 'buy' : 'sell', 30 + Math.round(R() * 120), null);
  }

  private halt(dir: 'up' | 'down') {
    const S = this.S;
    S.halted = 24; S.haltCool = 240;
    S.bids = []; S.asks = [];
    S.halts.push({ start: S.cur!.idx, end: null, dir, t: S.t });
    if (S.halts.length > 50) S.halts.shift();
    S.events.push({ type: 'halt', dir, t: S.t });
  }

  private reopen() {
    const S = this.S;
    const px = r2(S.last * 0.4 + S.fv * 0.6);
    S.last = px;
    const c = S.cur!; c.c = px; c.h = Math.max(c.h, px); c.l = Math.min(c.l, px);
    S.hi = Math.max(S.hi, px); S.lo = Math.min(S.lo, px);
    const h = S.halts[S.halts.length - 1]; if (h) h.end = S.cur!.idx;
    for (let m = 0; m < 4; m++) this.quoteMM(m, px);
    S.events.push({ type: 'resume', price: px, t: S.t });
    const p = S.pending; S.pending = [];
    p.forEach(a => this.submit(...a));
  }

  tick() {
    const S = this.S;
    if (S.t % CANDLE === 0) this.newCandle();
    if (S.halted > 0) {
      S.halted--;
      if (S.halted === 0) this.reopen();
      S.hist.push(S.last); if (S.hist.length > 400) S.hist.shift();
      S.t++;
      return;
    }
    this.crowd();
    S.hist.push(S.last); if (S.hist.length > 400) S.hist.shift();
    if (S.haltCool > 0) S.haltCool--;
    const ref = S.hist[Math.max(0, S.hist.length - 121)];
    if (S.haltCool === 0 && S.t > 200 && Math.abs(S.last / ref - 1) > 0.10) this.halt(S.last > ref ? 'up' : 'down');
    S.t++;
  }

  shock(pct: number, speed: string) {
    const S = this.S;
    pct = Math.max(-45, Math.min(60, pct));
    S.fvTarget *= 1 + pct / 100;
    S.fvK = speed === 'fast' ? 0.08 : 0.015;
  }

  depth(levels = 8): { bids: Level[]; asks: Level[] } {
    const agg = (arr: Order[]) => { const out: Level[] = []; for (const o of arr) { const l = out[out.length - 1]; if (l && l.price === o.price) l.qty += o.qty; else { if (out.length === levels) break; out.push({ price: o.price, qty: o.qty }); } } return out; };
    return { bids: agg(this.S.bids), asks: agg(this.S.asks) };
  }

  /** Hands queued engine events to the caller and empties the queue (the original let it grow forever). */
  drainEvents(): EngineEvent[] { const e = this.S.events; this.S.events = []; return e; }

  clock(t = this.S.t) { return clock(t); }
}

export const clock = (t: number) => { const s = 9 * 3600 + 30 * 60 + Math.floor(t * DT); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
