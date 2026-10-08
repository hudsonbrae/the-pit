// Room registry: create rooms with short join codes, find them again (restoring
// from the database after a server restart), and close rooms nobody is using.

import { randomInt, randomUUID } from 'node:crypto';
import { Room, type RoomDeps } from './room.js';
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

  constructor(private deps: RoomDeps, private idleMs = 2 * 3600_000) {}

  startSweeper() {
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const r of this.rooms.values()) if (!r.online && now - r.lastActive > this.idleMs) void this.close(r.code);
    }, 60_000);
  }

  async create(o: { mode: Mode; ticker?: string; hostToken: string }): Promise<Room> {
    if (this.rooms.size >= this.deps.cfg.maxRooms) throw new RoomError(503, 'The server is full right now. Try again later.');
    if (!o.hostToken || o.hostToken.length < 8 || o.hostToken.length > 100) throw new RoomError(400, 'Missing player token.');
    let code = newCode();
    while (this.rooms.has(code) || (await this.deps.store.getRoom(code))) code = newCode();
    const room = o.mode === 'real' ? await this.buildReal(code, (o.ticker || '').toUpperCase().trim(), o.hostToken) : new Room(this.deps, { code, mode: 'sim', ticker: 'HLCN', hostToken: o.hostToken });
    await this.deps.store.createRoom({ code, mode: room.mode, ticker: room.ticker, host_token: o.hostToken });
    this.rooms.set(code, room);
    room.start();
    console.log(JSON.stringify({ ev: 'room_created', code, mode: room.mode, ticker: room.ticker }));
    return room;
  }

  private async buildReal(code: string, ticker: string, hostToken: string): Promise<Room> {
    if (!validTicker(ticker)) throw new RoomError(400, 'Enter a US ticker symbol, like AAPL or NVDA.');
    const hub = this.deps.hub;
    if (!hub) throw new RoomError(503, 'Real Market mode is not available on this server.');
    const feed = await hub.prepare(ticker);
    if (!feed?.quote) throw new RoomError(404, `No live quote found for ${ticker}. US-listed stocks only.`);
    return new Room(this.deps, { code, mode: 'real', ticker, hostToken, co: realCompany(ticker, feed.profile), startPrice: feed.quote.price });
  }

  /** The room for a join code: in memory, or rebuilt from the database (after a restart or idle close). */
  async get(code: string): Promise<Room | null> {
    code = code.toUpperCase();
    if (!validCode(code)) return null;
    const r = this.rooms.get(code);
    if (r) return r;
    if (!this.loading.has(code)) {
      this.loading.set(code, (async () => {
        try {
          const row = await this.deps.store.getRoom(code);
          if (!row) return null;
          let room: Room;
          if (row.mode === 'real') {
            try { room = await this.buildReal(code, row.ticker, row.host_token); }
            catch { return null; }
          } else room = new Room(this.deps, { code, mode: 'sim', ticker: 'HLCN', hostToken: row.host_token });
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
