import { describe, it, expect } from 'vitest';
import { deps, simRoom, RecConn, until } from './helpers';
import { Legends } from '../../server/legends';
import { MemoryStore, SafeStore } from '../../server/store/store';
import { createApp } from '../../server/app';
import type { Player } from '../../server/room';

const join = (room: ReturnType<typeof simRoom>, c: RecConn, token: string, name: string) => room.attach(c, token, name) as Player;

describe('Legends: all-time records', () => {
  it('keeps the best value, respects lower-is-better and minimums, and persists', async () => {
    const store = new MemoryStore();
    const L = new Legends(store);
    expect(L.offer('human_session', 'Brae', 5000, 'HLCN', 'AAAAA')).toBe(true);
    expect(L.offer('human_session', 'Sam', 4000, 'HLCN', 'BBBBB')).toBe(false);
    expect(L.offer('human_session', 'Sam', 9000, 'HLCN', 'BBBBB')).toBe(true);
    expect(L.offer('fastest', 'Sam', 2.5, '', 'BBBBB')).toBe(true);
    expect(L.offer('fastest', 'Brae', 3.0, '', 'AAAAA')).toBe(false);
    expect(L.offer('fastest', 'Brae', 1.2, '', 'AAAAA')).toBe(true);
    expect(L.offer('ai_streak', 'Pip', 2, '', 'AAAAA')).toBe(false);          // below the minimum
    expect(L.offer('human_session', 'Sam', NaN, '', 'AAAAA')).toBe(false);
    await new Promise(r => setImmediate(r));
    const again = new Legends(store); await again.hydrate();
    expect(again.list().map(l => [l.key, l.holder, l.value])).toEqual([['human_session', 'Sam', '$9,000'], ['fastest', 'Brae', '1.2s']]);
  });

  it('a broken database never breaks the records', async () => {
    const bad = new SafeStore({ ...new MemoryStore(), kind: 'memory', loadLegends: async () => { throw new Error('down'); }, saveLegend: async () => { throw new Error('down'); } } as never);
    const L = new Legends(bad); await L.hydrate();
    expect(L.offer('wildest', 'Room X', 5, '', 'X')).toBe(true);
    await new Promise(r => setImmediate(r));
    expect(bad.errors).toBeGreaterThan(0);
  });

  it('the closing bell offers the session to the Legends, names new records, and the next session opens with "Previously on"', async () => {
    const d = deps(); d.legends = new Legends(d.store);
    const room = simRoom(d);
    const c = new RecConn(); const host = join(room, c, 'host-token-1', 'Brae');
    room.playerOrder(host, 'buy', 2000);
    room.eng.S.last *= 1.05;                                  // Brae is up on the session
    await room.handle(c, host, { k: 'host', action: 'close' });
    const recap = c.of('recap')[0].recap;
    expect(recap.records.some(r => r.key === 'human_session' && r.holder === 'Brae')).toBe(true);
    expect(room.tell.stories.some(s => s.title === 'NEW RECORD' && /Brae/.test(s.text))).toBe(true);
    expect(room.prev?.winner).toBeTruthy();
    await room.handle(c, host, { k: 'host', action: 'reset' });
    const snap = c.of('reset').at(-1)!.snap;
    expect(snap.prev?.records.some(r => /Brae: best human session/.test(r))).toBe(true);
    // a later joiner in the first 90 s also sees it
    const c2 = new RecConn(); join(room, c2, 'player-token-2', 'Sam');
    expect(c2.of('hello')[0].snap.prev?.id).toBe(snap.prev!.id);
  });

  it('GET /api/legends lists the records', async () => {
    const app = createApp({ cfg: { publicDir: 'dist' }, llm: null, market: null });
    const port = await app.listen(0);
    app.deps.legends!.offer('wildest', 'Room ABCDE', 7.5, 'HLCN', 'ABCDE');
    const j = await (await fetch(`http://127.0.0.1:${port}/api/legends`)).json();
    expect(j.legends[0]).toMatchObject({ key: 'wildest', holder: 'Room ABCDE', value: '7.5%' });
    await app.close();
  });
});

describe('chaos controls', () => {
  it('host-only, Sim-only, one at a time; a halt trips the breaker at once', async () => {
    const room = simRoom(deps());
    const c = new RecConn(); const host = join(room, c, 'host-token-1', 'Brae');
    const g = new RecConn(); const guest = join(room, g, 'guest-token-1', 'Sam');
    await room.handle(g, guest, { k: 'host', action: 'chaos', id: 'chaos_halt' });
    expect(g.of('toast').at(-1)!.text).toMatch(/Only the host/);
    expect(c.of('hello')[0].room.chaos.map(x => x.id)).toContain('chaos_crash');
    await room.handle(c, host, { k: 'host', action: 'chaos', id: 'chaos_halt' });
    room.frame();
    expect(room.eng.S.halted).toBeGreaterThan(0);
    expect(room.tell.stories.some(s => s.title === 'CHAOS · MARKET HALT')).toBe(true);
  });

  it('a flash crash drains the book and sells; a second chaos waits for the first', async () => {
    const room = simRoom(deps());
    const c = new RecConn(); const host = join(room, c, 'host-token-1', 'Brae');
    const before = room.eng.S.last;
    await room.handle(c, host, { k: 'host', action: 'chaos', id: 'chaos_crash' });
    room.frame();
    await room.handle(c, host, { k: 'host', action: 'chaos', id: 'chaos_squeeze' });
    expect(c.of('toast').at(-1)!.text).toMatch(/still running/);
    for (let i = 0; i < 40; i++) room.frame();
    expect(room.eng.S.lo).toBeLessThan(before * 0.99);
    expect(c.of('act').some(a => a.title === 'FLASH CRASH')).toBe(true);
  });

  it('a news shock runs a real (offline here) round with a SCENARIO headline', async () => {
    const room = simRoom(deps());
    const c = new RecConn(); const host = join(room, c, 'host-token-1', 'Brae');
    await room.handle(c, host, { k: 'host', action: 'chaos', id: 'chaos_news' });
    for (let i = 0; i < 8; i++) { room.frame(); await new Promise(r => setImmediate(r)); }
    await until(() => room.news.some(n => n.origin === 'SCENARIO' && n.kind === 'news' && n.impact != null && n.by === 'Scenario: News shock'), 5000);
  });
});
