// Room registry: create rooms with short join codes, find them again (restoring
// from the database after a server restart), and close rooms nobody is using.

import { randomInt, randomUUID } from 'node:crypto';
import { Room, hashToken, type RoomDeps } from './room.js';
import { realCompany } from './agents.js';
import type { Mode } from '../shared/protocol.js';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read out loud
export const newCode = () => Array.from({ length: 5 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
export const validCode = (s: string) => /^[A-Z]{5}$/.test(s);
export const validTicker = (s: string) => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s);

export class RoomError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export class Rooms {
  readonly rooms = new Map<string, Room>();
  private loading = new Map<string, Promise<Room | null>>();
  private sweeper: NodeJS.Timeout | null = null;
  /** Tickers that had no quote recently: don't spend provider calls on them again for 10 minutes. */
  private badTickers = new Map<string, number>();

  constructor(private deps: RoomDeps, private idleMs = 2 * 3600_000) {}

  startSweeper() { this.sweeper = setInterval(() => void this.sweep(), 60_000); }

  /** Closes rooms nobody is in: after the idle time, or after 5 minutes if nobody ever joined. */
  async sweep(now = Date.now()) {
    for (const r of [...this.rooms.values()]) {
      if (r.audience) continue;
      if (now - r.lastActive > this.idleMs || (!r.everJoined && now - r.lastActive > 5 * 60_000)) await this.close(r.code);
    }
  }

  async create(o: { mode: Mode; ticker?: string; hostToken: string; seed?: number; owner?: string }): Promise<Room> {
    if (this.rooms.size >= this.deps.cfg.maxRooms) throw new RoomError(503, 'The server is full right now. Try again later.');
    if (typeof o.hostToken !== 'string' || o.hostToken.length < 8 || o.hostToken.length > 100) throw new RoomError(400, 'Missing player token.');
    let code = newCode();
    while (this.rooms.has(code) || (await this.deps.store.getRoom(code))) code = newCode();
    const hostHash = hashToken(o.hostToken);
    const seed = Number.isInteger(o.seed) && o.seed! > 0 ? o.seed! : Math.floor(Math.random() * 1e9);
    const room = o.mode === 'real' ? await this.buildReal(code, String(o.ticker || '').toUpperCase().trim(), hostHash, seed) : new Room(this.deps, { code, mode: 'sim', ticker: 'HLCN', hostHash, seed });
    room.owner = o.owner;
    await this.deps.store.createRoom({ code, mode: room.mode, ticker: room.ticker, host_token: hostHash, seed });
    this.rooms.set(code, room);
    room.start();
    console.log(JSON.stringify({ ev: 'room_created', code, mode: room.mode, ticker: room.ticker }));
    return room;
  }

  private async buildReal(code: string, ticker: string, hostHash: string, seed?: number): Promise<Room> {
    if (!validTicker(ticker)) throw new RoomError(400, 'Enter a US ticker symbol (1–5 letters), like AAPL or NVDA.');
    const hub = this.deps.hub;
    if (!hub) throw new RoomError(503, 'Real Market mode is not available on this server.');
    const bad = this.badTickers.get(ticker);
    if (bad && Date.now() - bad < 10 * 60_000) throw new RoomError(404, `No live quote found for ${ticker}. US-listed stocks only.`);
    const active = new Set([...this.rooms.values()].filter(r => r.mode === 'real').map(r => r.ticker));
    if (!active.has(ticker) && active.size >= this.deps.cfg.maxTickers) throw new RoomError(503, `Too many different tickers are live right now. Try one already trading: ${[...active].join(', ')}.`);
    const feed = await hub.prepare(ticker);
    if (!feed?.quote) { this.badTickers.set(ticker, Date.now()); if (this.badTickers.size > 500) this.badTickers.clear(); throw new RoomError(404, `No live quote found for ${ticker}. US-listed stocks only.`); }
    return new Room(this.deps, { code, mode: 'real', ticker, hostHash, seed, co: realCompany(ticker, feed.profile), startPrice: feed.quote.price });
  }

  /** The room for a join code: in memory, or rebuilt from the database (after a restart or idle close). */
  /** `mayRestore` lets the caller rate-limit rebuilding rooms from the database (it costs a warm-up). */
  async get(code: string, mayRestore: () => boolean = () => true): Promise<Room | null> {
    code = code.toUpperCase();
    if (!validCode(code)) return null;
    const r = this.rooms.get(code);
    if (r) return r;
    if (!this.loading.has(code) && !mayRestore()) return null;
    if (!this.loading.has(code)) {
      this.loading.set(code, (async () => {
        try {
          if (this.rooms.size >= this.deps.cfg.maxRooms) return null;
          const row = await this.deps.store.getRoom(code);
          if (!row) return null;
          let room: Room;
          const seed = Number(row.seed) || undefined;
          if (row.mode === 'real') {
            try { room = await this.buildReal(code, row.ticker, row.host_token, seed); }
            catch { return null; }
          } else room = new Room(this.deps, { code, mode: 'sim', ticker: 'HLCN', hostHash: row.host_token, seed });
          await room.loadPersisted();
          this.rooms.set(code, room);
          room.start();
          void this.deps.store.touchRoom(code);
          console.log(JSON.stringify({ ev: 'room_restored', code }));
          return room;
        } finally { this.loading.delete(code); }
      })());
    }
    return this.loading.get(code)!;
  }

  async close(code: string) {
    const r = this.rooms.get(code); if (!r) return;
    this.rooms.delete(code);
    await r.dispose();
    console.log(JSON.stringify({ ev: 'room_closed', code }));
  }

  async closeAll() { if (this.sweeper) clearInterval(this.sweeper); await Promise.all([...this.rooms.keys()].map(c => this.close(c))); }
}

export const newToken = () => randomUUID();
