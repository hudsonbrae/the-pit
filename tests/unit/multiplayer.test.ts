import { describe, it, expect } from 'vitest';
import { deps, simRoom, RecConn } from './helpers';
import { Rooms, newCode, validCode } from '../../server/rooms';
import type { Player } from '../../server/room';

const join = (room: ReturnType<typeof simRoom>, c: RecConn, token: string, name: string) => {
  const p = room.attach(c, token, name); if (typeof p === 'string') throw new Error(p); return p as Player;
};

describe('multiplayer rooms', () => {
  it('join codes are 5 unambiguous letters', () => {
    for (let i = 0; i < 200; i++) { const c = newCode(); expect(validCode(c)).toBe(true); expect(c).not.toMatch(/[IO]/); }
  });

  it('every player gets $1M on the shared book, a colour, and shows in everyone\'s standings', () => {
    const room = simRoom(deps());
    const a = new RecConn(), b = new RecConn();
    const pa = join(room, a, 'host-token-1', 'Brae'), pb = join(room, b, 'token-sam-1', 'Sam');
    expect(pa.host).toBe(true); expect(pb.host).toBe(false);
    expect(pa.color).not.toBe(pb.color);
    expect(room.eng.S.accounts[pa.id]).toMatchObject({ cash: 1_000_000, sh: 0 });
    room.playerOrder(pa, 'buy', 2000);
    // Sam's socket got a delta containing Brae's prints and Brae's account
    const d = b.of('d').at(-1)!;
    expect(d.trades.some(t => t.buyer === pa.id)).toBe(true);
    expect(d.acc[pa.id][1]).toBe(2000);
    expect(d.fills!.some(f => f.owner === pa.id)).toBe(true);
    expect(b.of('players').at(-1)!.players.map(p => p.name)).toEqual(['Brae', 'Sam']);
  });

  it('players trade against each other on the same book', () => {
    const room = simRoom(deps());
    const pa = join(room, new RecConn(), 'host-token-1', 'Brae'), pb = join(room, new RecConn(), 'token-sam-1', 'Sam');
    room.eng.S.asks = []; room.eng.S.bids = [];
    room.eng.submit(pb.id, 'sell', 300, 99.5);          // Sam rests an offer
    room.playerOrder(pa, 'buy', 100);                     // Brae lifts it
    expect(room.eng.S.trades[0]).toMatchObject({ buyer: pa.id, seller: pb.id, q: 100, price: 99.5 });
    expect(room.eng.S.accounts[pb.id].sh).toBe(-100);
  });

  it('tracks each player\'s cost basis through adds, reductions and flips', () => {
    const room = simRoom(deps());
    const pa = join(room, new RecConn(), 'host-token-1', 'Brae');
    const S = room.eng.S; S.asks = []; S.bids = [];
    room.eng.submit('mm9', 'sell', 1000, 100); room.playerOrder(pa, 'buy', 100);
    room.eng.submit('mm9', 'sell', 1000, 110); S.asks = S.asks.filter(o => o.price === 110); room.playerOrder(pa, 'buy', 100);
    expect(S.accounts[pa.id].cost! / S.accounts[pa.id].sh).toBeCloseTo(105);
    S.asks = []; room.eng.submit('mm9', 'buy', 1000, 120); room.playerOrder(pa, 'sell', 100);
    expect(S.accounts[pa.id].cost! / S.accounts[pa.id].sh).toBeCloseTo(105);   // reducing keeps the average
    room.playerOrder(pa, 'sell', 300);                                            // flip short at 120
    expect(S.accounts[pa.id].sh).toBe(-200);
    expect(S.accounts[pa.id].cost! / S.accounts[pa.id].sh).toBeCloseTo(120);
  });

  it('disconnect keeps the position; reconnecting with the same token restores the seat', () => {
    const room = simRoom(deps());
    const c1 = new RecConn();
    const p = join(room, c1, 'token-sam-1', 'Sam');
    room.playerOrder(p, 'buy', 500);
    const sh = room.eng.S.accounts[p.id].sh;
    room.detach(c1, p);
    expect(room.playersV().find(x => x.id === p.id)!.online).toBe(false);
    const c2 = new RecConn();
    const again = join(room, c2, 'token-sam-1', 'Sam');
    expect(again.id).toBe(p.id);
    const hello = c2.of('hello')[0];
    expect(hello.you.id).toBe(p.id);
    expect(hello.snap.acc[p.id][1]).toBe(sh);
  });

  it('only the host can pause, change speed or reset', async () => {
    const room = simRoom(deps());
    const a = new RecConn(), b = new RecConn();
    const host = join(room, a, 'host-token-1', 'Brae'), guest = join(room, b, 'token-sam-1', 'Sam');
    await room.handle(b, guest, { k: 'host', action: 'speed', value: 0 });
    expect(room.speed).toBe(1);
    expect(b.of('toast').at(-1)!.text).toMatch(/Only the host/);
    await room.handle(a, host, { k: 'host', action: 'speed', value: 0 });
    expect(room.speed).toBe(0);
    expect(b.of('room').at(-1)!.room.speed).toBe(0);
    room.frame();                                   // paused: the clock does not move
    const t = room.eng.S.t; room.frame(); expect(room.eng.S.t).toBe(t);
    await room.handle(a, host, { k: 'host', action: 'speed', value: 3 });
    room.frame(); expect(room.eng.S.t).toBe(t + 3);
    room.playerOrder(guest, 'buy', 500);
    await room.handle(a, host, { k: 'host', action: 'reset' });
    expect(room.eng.S.accounts[guest.id]).toMatchObject({ cash: 1_000_000, sh: 0 });
    expect(b.of('reset')).toHaveLength(1);
  });

  it('names are cleaned and kept unique', () => {
    const room = simRoom(deps());
    join(room, new RecConn(), 'tok-aaaaaaa1', 'Sam');
    const p2 = join(room, new RecConn(), 'tok-aaaaaaa2', 'sam');
    const p3 = join(room, new RecConn(), 'tok-aaaaaaa3', '<b>Pip</b>');
    expect(p2.name).toBe('sam 2');
    expect(p3.name).toBe('bPip/b');
  });

  it('rate-limits order spam', () => {
    const room = simRoom(deps());
    const c = new RecConn();
    const p = join(room, c, 'tok-spam-0001', 'Spam');
    for (let i = 0; i < 20; i++) room.playerOrder(p, 'buy', 100);
    expect(c.of('toast').some(t => /Slow down/.test(t.text))).toBe(true);
  });

  it('a room closed for being idle comes back from the database with positions intact', async () => {
    const d = deps();
    const rooms = new Rooms(d);
    const room = await rooms.create({ mode: 'sim', hostToken: 'host-token-1' });
    const c = new RecConn();
    const p = room.attach(c, 'token-sam-1', 'Sam') as Player;
    room.playerOrder(p, 'buy', 500);
    const sh = room.eng.S.accounts[p.id].sh;
    room.detach(c, p);
    await rooms.close(room.code);
    const back = await rooms.get(room.code);
    expect(back).not.toBe(room);
    const p2 = back!.attach(new RecConn(), 'token-sam-1', 'Sam') as Player;
    expect(p2.id).toBe(p.id);
    expect(back!.eng.S.accounts[p.id].sh).toBe(sh);
    await rooms.closeAll();
  });
});
