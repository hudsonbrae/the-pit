// HTTP + WebSocket server. Serves the built frontend, a small JSON API for creating
// and looking up rooms, the /ws endpoint that streams each room's state, and an
// admin/observability view. Hardened per the security review: no unhandled throws,
// per-socket message limits, per-IP connection and room-creation limits, Origin
// check, bounded payloads, security headers.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from './config.js';
import { CostGuard } from './costguard.js';
import { AnthropicLLM } from './ai/anthropic.js';
import { FakeLLM } from './ai/fake.js';
import type { LLM } from './ai/llm.js';
import { MemoryStore, SafeStore, type Store } from './store/store.js';
import { SupabaseStore } from './store/supabase.js';
import { FinnhubProvider } from './market/finnhub.js';
import { FakeMarket } from './market/fake.js';
import { MarketHub } from './market/hub.js';
import type { MarketProvider } from './market/provider.js';
import { Rooms, RoomError } from './rooms.js';
import type { Room, RoomDeps, Player } from './room.js';
import type { ClientMsg } from '../shared/protocol.js';
import { adminHtml } from './admin.js';
import { shrunk } from './intel/stats.js';

export interface AppOverrides { cfg?: Partial<Config>; llm?: LLM | null; store?: Store; market?: MarketProvider | null; random?: () => number; marketAutoPoll?: boolean }

export function buildDeps(o: AppOverrides = {}): RoomDeps & { store: SafeStore } {
  const cfg = loadConfig(o.cfg);
  let llm: LLM | null;
  if (o.llm !== undefined) llm = o.llm;
  else if (cfg.aiProvider === 'off') llm = null;
  else if (cfg.aiProvider === 'mock' || (cfg.aiProvider === 'auto' && !cfg.anthropicKey)) llm = new FakeLLM();
  else llm = new AnthropicLLM(cfg.anthropicKey);
  const inner = o.store ?? (cfg.supabaseUrl && cfg.supabaseServiceKey ? new SupabaseStore(cfg.supabaseUrl, cfg.supabaseServiceKey) : new MemoryStore());
  const store = inner instanceof SafeStore ? inner : new SafeStore(inner);
  let market: MarketProvider | null;
  if (o.market !== undefined) market = o.market;
  else if (cfg.marketProvider === 'mock' || (cfg.marketProvider === 'auto' && !cfg.finnhubKey)) market = new FakeMarket({ autoNewsEverySec: cfg.mockNewsEverySec });
  else market = new FinnhubProvider(cfg.finnhubKey);
  const hub = market ? new MarketHub(market, { quoteEverySec: cfg.quotePollSec, newsEverySec: cfg.newsPollSec, autoPoll: o.marketAutoPoll }) : null;
  const guard = new CostGuard({ roundsPerMin: cfg.aiRoundsPerMinPerRoom, dailyRounds: cfg.aiDailyRoundCap, dailySmall: cfg.aiDailySmallCap, roomDailyRounds: cfg.aiRoomDailyRoundCap });
  return { cfg, llm, guard, store, hub, random: o.random, aiState: { dead: false } };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

/** A tiny fixed-window counter keyed by anything (IP, socket). */
class Limiter {
  private m = new Map<string, { n: number; at: number }>();
  constructor(private max: number, private windowMs: number) {}
  hit(k: string): boolean {
    const now = Date.now(), e = this.m.get(k);
    if (!e || now - e.at > this.windowMs) { this.m.set(k, { n: 1, at: now }); if (this.m.size > 10_000) this.m.clear(); return true; }
    e.n++; return e.n <= this.max;
  }
}

export interface App { server: Server; rooms: Rooms; deps: RoomDeps; wss: WebSocketServer; close(): Promise<void>; listen(port?: number): Promise<number> }

export function createApp(o: AppOverrides = {}): App {
  const deps = buildDeps(o);
  const rooms = new Rooms(deps);
  const root = resolve(deps.cfg.publicDir);
  const started = Date.now();
  const errors: string[] = [];
  const logError = (s: string) => { errors.unshift(`${new Date().toISOString().slice(11, 19)} ${s}`); if (errors.length > 30) errors.length = 30; };

  // the day's AI usage survives restarts
  void deps.store.loadUsage(new Date().toISOString().slice(0, 10)).then(u => deps.guard.hydrate(u));
  let usageTimer: NodeJS.Timeout | null = null;
  deps.guard.onChange = u => { if (usageTimer) return; usageTimer = setTimeout(() => { usageTimer = null; void deps.store.saveUsage(u); }, 3000); };

  const createLimit = new Limiter(deps.cfg.roomCreatesPerIpPerMin, 60_000);
  const lookupLimit = new Limiter(60, 60_000);
  const socketsPerIp = new Map<string, number>();

  const ipOf = (req: IncomingMessage) => {
    // Behind Render's proxy the client address is the LAST entry the proxy appended.
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
    return xff.at(-1) || req.socket.remoteAddress || 'unknown';
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  };
  const body = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 10_000) { bad(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(s)); req.on('error', bad);
  });
  const isAdmin = (req: IncomingMessage, url: URL) => {
    const tok = deps.cfg.adminToken;
    if (!tok) { const a = req.socket.remoteAddress ?? ''; return !req.headers['x-forwarded-for'] && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'); }
    return (url.searchParams.get('token') ?? req.headers['x-admin-token']) === tok;
  };

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    let rel: string;
    try { rel = decodeURIComponent(path); } catch { return json(res, 400, { error: 'bad path' }); }
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return json(res, 403, { error: 'forbidden' });
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
    catch { file = join(root, 'index.html'); }            // SPA fallback: /r/ABCDE etc.
    try {
      const data = await readFile(file);
      const immutable = file.startsWith(join(root, 'assets') + sep);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not built yet. Run: npm run build');
    }
  }

  function adminData() {
    const mem = process.memoryUsage();
    const list = [...rooms.rooms.values()];
    // experiment: accuracy and calibration grouped by each room's AI configuration
    const groups = new Map<string, { calls: number; correct: number; hiN: number; hiC: number; rooms: number }>();
    for (const r of list) {
      const e = r.experiment(); const g = groups.get(e.lab) ?? { calls: 0, correct: 0, hiN: 0, hiC: 0, rooms: 0 }; g.rooms++;
      for (const s of Object.values(e.stats)) { g.calls += s.calls; g.correct += s.correct; g.hiN += s.buckets[2].n + s.buckets[3].n; g.hiC += s.buckets[2].correct + s.buckets[3].correct; }
      groups.set(e.lab, g);
    }
    return {
      uptimeMin: Math.round((Date.now() - started) / 60000), memMB: { heap: Math.round(mem.heapUsed / 1e6), rss: Math.round(mem.rss / 1e6) },
      sockets: wss.clients.size, rooms: list.map(r => r.admin()),
      ai: { provider: deps.llm ? (deps.aiState.dead ? 'key rejected' : deps.llm.label) : 'off', models: deps.cfg.models, ...deps.guard.stats(), recent: deps.guard.log.slice(-12).reverse() },
      market: deps.hub ? { provider: deps.hub.provider.name, status: deps.hub.status, tickers: [...deps.hub.feeds.values()].map(f => ({ symbol: f.symbol, listeners: f.listeners.size, price: f.quote?.price ?? null, quoteAgeSec: f.quote ? Math.round((Date.now() - f.quote.time) / 1000) : null })) } : null,
      store: { kind: deps.store.kind, errors: (deps.store as SafeStore).errors ?? 0, lastError: (deps.store as SafeStore).lastError ?? null },
      experiments: [...groups].map(([lab, g]) => ({ lab, rooms: g.rooms, calls: g.calls, accuracy: g.calls ? +(g.correct / g.calls).toFixed(3) : null, highConvAccuracy: g.hiN ? +(g.hiC / g.hiN).toFixed(3) : null, shrunk: +shrunk({ calls: g.calls, correct: g.correct } as never).toFixed(3) })),
      errors,
    };
  }

  const server = createServer(async (req, res) => {
    let url: URL;
    try { url = new URL(req.url || '/', 'http://x'); } catch { return json(res, 400, { error: 'bad url' }); }
    try {
      if (url.pathname === '/api/health') {
        let players = 0; for (const r of rooms.rooms.values()) players += r.online;
        return json(res, 200, { ok: true, rooms: rooms.rooms.size, playersOnline: players, ai: deps.llm ? (deps.aiState.dead ? 'key rejected' : deps.llm.label) : 'off', store: deps.store.kind, market: deps.hub?.provider.name ?? 'off' });
      }
      if (url.pathname === '/api/admin') { if (!isAdmin(req, url)) return json(res, 403, { error: 'admin only' }); return json(res, 200, adminData()); }
      if (url.pathname === '/admin') {
        if (!isAdmin(req, url)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Admin only. Set ADMIN_TOKEN and open /admin?token=…'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, 'content-security-policy': SECURITY_HEADERS['content-security-policy'].replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") });
        return res.end(adminHtml);
      }
      if (url.pathname === '/api/rooms' && req.method === 'POST') {
        if (!createLimit.hit(ipOf(req))) return json(res, 429, { error: 'Too many rooms from here. Wait a minute.' });
        let b: { mode?: unknown; ticker?: unknown; token?: unknown; scenario?: unknown };
        try { b = JSON.parse(await body(req) || '{}'); } catch { return json(res, 400, { error: 'Bad request.' }); }
        const demo = b.scenario === 'demo';
        const room = await rooms.create({ mode: b.mode === 'real' && !demo ? 'real' : 'sim', ticker: typeof b.ticker === 'string' ? b.ticker : '', hostToken: typeof b.token === 'string' ? b.token : '', seed: demo ? 1987 : undefined });
        if (demo) room.autoStart = 'demo';
        return json(res, 200, { code: room.code, mode: room.mode, ticker: room.ticker });
      }
      const m = /^\/api\/rooms\/([A-Za-z]{5})$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        if (!lookupLimit.hit(ipOf(req))) return json(res, 429, { error: 'Slow down.' });
        const room = await rooms.get(m[1]);
        if (!room) return json(res, 404, { error: 'No room with that code.' });
        return json(res, 200, { code: room.code, mode: room.mode, ticker: room.ticker, company: room.co.name, players: room.playersV().length });
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof RoomError) return json(res, e.status, { error: e.message });
      logError(String((e as Error)?.message ?? e));
      console.error(e);
      if (!res.headersSent) return json(res, 500, { error: 'Server error.' });
      res.end();
    }
  });

  const originOk = (origin: string | undefined, host: string | undefined) => {
    if (!origin) return true;                                   // non-browser clients (tests, tools)
    try { const o = new URL(origin); return o.host === host || deps.cfg.allowedOrigins.includes(origin); } catch { return false; }
  };

  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 8 * 1024,
    verifyClient: (info, cb) => {
      if (!originOk(info.origin, info.req.headers.host)) return cb(false, 403, 'Origin not allowed');
      const ip = ipOf(info.req);
      if ((socketsPerIp.get(ip) ?? 0) >= deps.cfg.maxSocketsPerIp) return cb(false, 429, 'Too many connections');
      cb(true);
    },
  });
  wss.on('connection', (ws: WebSocket & { alive?: boolean }, req) => {
    const ip = ipOf(req);
    socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1);
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => { try { ws.terminate(); } catch { /* already gone */ } });   // oversize/invalid frames must never crash the process
    let joined: { room: Room; player: Player | null } | null = null;
    let joining = false;
    let budget = 40, last = Date.now(), strikes = 0;              // token bucket: ~20 msgs/s sustained, bursts of 40
    const kill = setTimeout(() => { if (!joined) ws.close(4000, 'join timeout'); }, 10_000);
    ws.on('message', async raw => {
      const now = Date.now();
      budget = Math.min(40, budget + (now - last) / 50); last = now;
      if (budget < 1) { if (++strikes > 100) ws.close(4029, 'flooding'); return; }
      budget--;
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.k !== 'string') return;
      try {
        if (!joined) {
          if (m.k !== 'join' || joining) return;
          joining = true;
          const token = typeof m.token === 'string' ? m.token : '';
          if (!m.watch && (token.length < 8 || token.length > 100)) { ws.send(JSON.stringify({ k: 'err', text: 'Missing player token.' })); return ws.close(4001); }
          const room = await rooms.get(typeof m.room === 'string' ? m.room : '');
          if (!room) { ws.send(JSON.stringify({ k: 'err', text: 'No room with that code. It may have expired.' })); return ws.close(4004); }
          if (ws.readyState !== ws.OPEN) return;
          if (m.watch) {
            const err = room.watch(ws);
            if (err) { ws.send(JSON.stringify({ k: 'err', text: err })); return ws.close(4003); }
            joined = { room, player: null };
            clearTimeout(kill);
            ws.on('close', () => room.unwatch(ws));
            return;
          }
          const p = room.attach(ws, token, typeof m.name === 'string' ? m.name : '');
          if (typeof p === 'string') { ws.send(JSON.stringify({ k: 'err', text: p })); return ws.close(4003); }
          joined = { room, player: p };
          clearTimeout(kill);
          ws.on('close', () => room.detach(ws, p));
          return;
        }
        if (!joined.player) return;                               // spectators can't act
        await joined.room.handle(ws, joined.player, m);
      } catch (e) { logError(String((e as Error)?.message ?? e)); console.error(e); }
    });
    ws.on('close', () => {
      clearTimeout(kill);
      const n = (socketsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) socketsPerIp.delete(ip); else socketsPerIp.set(ip, n);
    });
  });
  const beat = setInterval(() => {
    for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false; try { ws.ping(); } catch { /* closing */ }
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
      if (usageTimer) clearTimeout(usageTimer);
      await rooms.closeAll();
      deps.hub?.stopAll();
      for (const c of wss.clients) c.terminate();
      await new Promise<void>(ok => wss.close(() => ok()));
      await new Promise<void>(ok => server.close(() => ok()));
    },
  };
}
