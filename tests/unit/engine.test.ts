import { describe, it, expect } from 'vitest';
import { Engine, seeded, CANDLE } from '../../server/engine';

const quiet = () => new Engine({ start: 100, random: seeded(1) });

describe('engine: matching', () => {
  it('fills at the resting price with price-time priority', () => {
    const e = quiet();
    e.submit('a', 'sell', 100, 101);
    e.submit('b', 'sell', 100, 100.5);
    e.submit('c', 'sell', 100, 100.5);   // same price, later: queued behind b
    const r = e.submit('x', 'buy', 150, null);
    expect(r.filled).toBe(150);
    expect(e.S.trades.map(t => [t.seller, t.price, t.q]).reverse()).toEqual([['b', 100.5, 100], ['c', 100.5, 50]]);
    expect(r.avg).toBeCloseTo(100.5);
    expect(e.depth().asks).toEqual([{ price: 100.5, qty: 50 }, { price: 101, qty: 100 }]);
    expect(e.S.last).toBe(100.5);
  });

  it('a limit order only crosses up to its price and rests the remainder', () => {
    const e = quiet();
    e.submit('s1', 'sell', 200, 100.1);
    e.submit('s2', 'sell', 200, 100.3);
    const r = e.submit('buyer', 'buy', 500, 100.2);
    expect(r).toMatchObject({ filled: 200, rest: 300 });
    expect(e.depth().bids).toEqual([{ price: 100.2, qty: 300 }]);
    expect(e.depth().asks).toEqual([{ price: 100.3, qty: 200 }]);
  });

  it('partial fills: a market order larger than the book fills what exists and drops the rest', () => {
    const e = quiet();
    e.submit('s', 'sell', 120, 100);
    e.submit('s', 'sell', 80, 100.2);
    const r = e.submit('b', 'buy', 1000, null);
    expect(r.filled).toBe(200);
    expect(r.rest).toBe(0);                      // market orders never rest
    expect(r.avg).toBeCloseTo((120 * 100 + 80 * 100.2) / 200);
    expect(e.depth().asks).toEqual([]);
  });

  it('partially fills a resting order and leaves the rest on the book', () => {
    const e = quiet();
    e.submit('s', 'sell', 500, 100);
    e.submit('b', 'buy', 120, null);
    expect(e.depth().asks).toEqual([{ price: 100, qty: 380 }]);
  });

  it('keeps accounts in step with fills', () => {
    const e = quiet();
    e.S.accounts.b = { cash: 1000, sh: 0, vol: 0, start: 1000 };
    e.S.accounts.s = { cash: 0, sh: 10, vol: 0, start: 1000 };
    e.submit('s', 'sell', 10, 50);
    e.submit('b', 'buy', 10, null);
    expect(e.S.accounts.b).toMatchObject({ cash: 500, sh: 10 });
    expect(e.S.accounts.s).toMatchObject({ cash: 500, sh: 0 });
  });

  it('cancel removes only that owner', () => {
    const e = quiet();
    e.submit('a', 'buy', 10, 99); e.submit('b', 'buy', 10, 98);
    e.cancel('a');
    expect(e.S.bids.map(o => o.owner)).toEqual(['b']);
  });
});

describe('engine: circuit breaker', () => {
  it('halts on a 10% move inside 30s, queues orders, then reopens after 6s', () => {
    const e = new Engine({ start: 100, random: seeded(7) });
    for (let i = 0; i < 400; i++) e.tick();
    e.drainEvents();
    expect(e.S.halted).toBe(0);
    // A huge shock to fair value: the crowd chases it until the breaker trips.
    e.shock(40, 'fast');
    let t = 0;
    while (!e.S.halted && t++ < 200) e.tick();
    expect(e.S.halted).toBeGreaterThan(0);
    const ev = e.drainEvents();
    expect(ev[0]).toMatchObject({ type: 'halt', dir: 'up' });
    expect(e.S.bids).toEqual([]); expect(e.S.asks).toEqual([]);
    expect(e.S.halts.at(-1)!.end).toBeNull();

    // Orders during the halt are queued, not matched.
    const q = e.submit('p1', 'buy', 50, null);
    expect(q.queued).toBe(true);
    expect(e.S.pending).toHaveLength(1);

    // 24 ticks * 250 ms = 6 s.
    let n = 0;
    while (e.S.halted) { e.tick(); n++; }
    expect(n).toBe(24);
    const re = e.drainEvents();
    expect(re[0].type).toBe('resume');
    expect(e.S.halts.at(-1)!.end).not.toBeNull();
    expect(e.S.pending).toHaveLength(0);
    expect(e.S.bids.length).toBeGreaterThan(0);  // market makers quoted the reopen
    expect(e.S.asks.length).toBeGreaterThan(0);
    // and a cool-down stops it halting again straight away
    expect(e.S.haltCool).toBeGreaterThan(0);
  });

  it('opens a new 5-second candle every 20 ticks', () => {
    const e = new Engine({ start: 100, random: seeded(3) });
    for (let i = 0; i < CANDLE * 5; i++) e.tick();
    expect(e.S.candles).toHaveLength(5);
    expect(e.S.candles.map(c => c.idx)).toEqual([0, 1, 2, 3, 4]);
  });

  it('pulls fair value toward the real price anchor', () => {
    const e = new Engine({ start: 100, random: seeded(5) });
    e.S.anchor = 120;
    for (let i = 0; i < 3000; i++) e.tick();
    expect(e.S.fvTarget).toBeGreaterThan(112);
    expect(e.S.last).toBeGreaterThan(108);
  });

  it('bounded memory: events are drained and arrays stay capped', () => {
    const e = new Engine({ random: seeded(9) });
    for (let i = 0; i < 30_000; i++) { e.tick(); if (i % 50 === 0) e.drainEvents(); }
    expect(e.S.candles.length).toBeLessThanOrEqual(900);
    expect(e.S.trades.length).toBeLessThanOrEqual(80);
    expect(e.S.hist.length).toBeLessThanOrEqual(400);
    expect(e.S.events.length).toBeLessThan(50);
  });
});
