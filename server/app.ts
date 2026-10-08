// HTTP + WebSocket server. Serves the built frontend, a tiny JSON API for creating
// and looking up rooms, and the /ws endpoint that streams each room's state.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config.js';
import { CostGuard } from './costguard.js';
import { AnthropicLLM } from './ai/anthropic.js';
import { FakeLLM } from './ai/fake.js';
import type { LLM } from './ai/llm.js';
import { MemoryStore, type Store } from './store/store.js';
import { SupabaseStore } from './store/supabase.js';
import { FinnhubProvider } from './market/finnhub.js';
import { FakeMarket } from './market/fake.js';
import { MarketHub } from './market/hub.js';
import type { MarketProvider } from './market/provider.js';
import { Rooms, RoomError } from './rooms.js';
import type { Room, RoomDeps, Player } from './room.js';
import type { ClientMsg } from '../shared/protocol.js';

export interface AppOverrides { cfg?: Partial<Config>; llm?: LLM | null; store?: Store; market?: MarketProvider | null; random?: () => number; marketAutoPoll?: boolean }

export function buildDeps(o: AppOverrides = {}): RoomDeps {
  const cfg = loadConfig(o.cfg);
  let llm: LLM | null;
  if (o.llm !== undefined) llm = o.llm;
  else if (cfg.aiProvider === 'off') llm = null;
  else if (cfg.aiProvider === 'mock' || (cfg.aiProvider === 'auto' && !cfg.anthropicKey)) llm = new FakeLLM();
  else llm = new AnthropicLLM(cfg.anthropicKey);
  const store = o.store ?? (cfg.supabaseUrl && cfg.supabaseServiceKey ? new SupabaseStore(cfg.supabaseUrl, cfg.supabaseServiceKey) : new MemoryStore());
  let market: MarketProvider | null;
  if (o.market !== undefined) market = o.market;
  else if (cfg.marketProvider === 'mock' || (cfg.marketProvider === 'auto' && !cfg.finnhubKey)) market = new FakeMarket({ autoNewsEverySec: cfg.mockNewsEverySec });
  else market = new FinnhubProvider(cfg.finnhubKey);
  const hub = market ? new MarketHub(market, { quoteEverySec: cfg.quotePollSec, newsEverySec: cfg.newsPollSec, autoPoll: o.marketAutoPoll }) : null;
  const guard = new CostGuard({ roundsPerMin: cfg.aiRoundsPerMinPerRoom, dailyRounds: cfg.aiDailyRoundCap, dailySmall: cfg.aiDailySmallCap });
  return { cfg, llm, guard, store, hub, random: o.random, aiState: { dead: false } };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

export interface App { server: Server; rooms: Rooms; deps: RoomDeps; wss: WebSocketServer; close(): Promise<void>; listen(port?: number): Promise<number> }

export function createApp(o: AppOverrides = {}): App {
  const deps = buildDeps(o);
  const rooms = new Rooms(deps);
  const root = resolve(deps.cfg.publicDir);

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 10_000) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(s)); req.on('error', bad);
  });

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    let file = normalize(join(root, decodeURIComponent(path)));
    if (!file.startsWith(root)) return json(res, 403, { error: 'forbidden' });
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
    catch { file = join(root, 'index.html'); }            // SPA fallback: /r/ABCDE etc.
    try {
      const data = await readFile(file);
      const immutable = file.includes(`${root}/assets/`);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not built yet. Run: npm run build');
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    try {
      if (url.pathname === '/api/health') {
        let players = 0; for (const r of rooms.rooms.values()) players += r.online;
        return json(res, 200, {
          ok: true, rooms: rooms.rooms.size, playersOnline: players, ai: deps.llm ? (deps.aiState.dead ? 'key rejected' : deps.llm.label) : 'off',
          store: deps.store.kind, market: deps.hub?.provider.name ?? 'off', usage: deps.guard.stats(), memMB: Math.round(process.memoryUsage().heapUsed / 1e6),
        });
      }
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        let b: { mode?: string; ticker?: string; token?: string };
        try { b = JSON.parse(await body(req) || '{}'); } catch { return json(res, 400, { error: 'Bad request.' }); }
        const room = await rooms.create({ mode: b.mode === 'real' ? 'real' : 'sim', ticker: b.ticker, hostToken: String(b.token || '') });
        return json(res, 200, { code: room.code, mode: room.mode, ticker: room.ticker });
      }
      const m = /^\/api\/rooms\/([A-Za-z]{5})$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const room = await rooms.get(m[1]);
        if (!room) return json(res, 404, { error: 'No room with that code.' });
        return json(res, 200, { code: room.code, mode: room.mode, ticker: room.ticker, company: room.co.name, players: room.playersV().length });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof RoomError) return json(res, e.status, { error: e.message });
      console.error(e);
      return json(res, 500, { error: 'Server error.' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
  wss.on('connection', (ws: WebSocket & { alive?: boolean }) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let joined: { room: Room; player: Player } | null = null;
    const kill = setTimeout(() => { if (!joined) ws.close(4000, 'join timeout'); }, 10_000);
    ws.on('message', async raw => {
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (!joined) {
        if (m.k !== 'join') return;
        const token = String(m.token || '');
        if (token.length < 8 || token.length > 100) { ws.send(JSON.stringify({ k: 'err', text: 'Missing player token.' })); return ws.close(4001); }
        const room = await rooms.get(String(m.room || ''));
        if (!room) { ws.send(JSON.stringify({ k: 'err', text: 'No room with that code. It may have expired.' })); return ws.close(4004); }
        const p = room.attach(ws, token, String(m.name || ''));
        if (typeof p === 'string') { ws.send(JSON.stringify({ k: 'err', text: p })); return ws.close(4003); }
        joined = { room, player: p };
        clearTimeout(kill);
        ws.on('close', () => room.detach(ws, p));
        return;
      }
      try { await joined.room.handle(ws, joined.player, m); }
      catch (e) { console.error(e); }
    });
    ws.on('close', () => clearTimeout(kill));
  });
  const beat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 25_000);

  return {
    server, rooms, deps, wss,
    listen(port = deps.cfg.port) {
      rooms.startSweeper();
      return new Promise(ok => server.listen(port, () => { const a = server.address(); ok(typeof a === 'object' && a ? a.port : port); }));
    },
    async close() {
      clearInterval(beat);
      await rooms.closeAll();
      deps.hub?.stopAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(ok => wss.close(() => ok()));
      await new Promise<void>(ok => server.close(() => ok()));
    },
  };
}
