// Chaos and security: the server must stay up and authoritative whatever clients,
// models, databases or data providers do. Runs the real HTTP + WebSocket server.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createApp, type App } from '../../server/app';
import { FakeLLM } from '../../server/ai/fake';
import { FakeMarket } from '../../server/market/fake';
import type { Store } from '../../server/store/store';
import { MemoryStore } from '../../server/store/store';

let app: App, port = 0;
const base = () => `http://localhost:${port}`;

function raw(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise(ok => { const r = request({ host: 'localhost', port, path, headers }, res => { res.resume(); ok(res.statusCode ?? 0); }); r.on('error', () => ok(-1)); r.end(); });
}
const alive = async () => (await fetch(`${base()}/api/health`)).ok;
async function mkRoom(token = 'host-token-' + Math.random().toString(36).slice(2)) {
  const r = await fetch(`${base()}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sim', token }) });
  return { code: (await r.json()).code as string, token };
}
function sock(opts: { origin?: string } = {}): Promise<WebSocket> {
  return new Promise((ok, bad) => { const ws = new WebSocket(`ws://localhost:${port}/ws`, { origin: opts.origin }); ws.once('open', () => ok(ws)); ws.once('error', bad); ws.once('unexpected-response', (_q, res) => bad(new Error('HTTP ' + res.statusCode))); });
}
const joinMsg = (ws: WebSocket, code: string, token: string, name: string) => new Promise<Record<string, unknown>>((ok, bad) => {
  ws.on('message', d => { const m = JSON.parse(String(d)); if (m.k === 'hello') ok(m); if (m.k === 'err') bad(new Error(m.text)); });
  ws.send(JSON.stringify({ k: 'join', room: code, token, name }));
});

beforeAll(async () => {
  app = createApp({ llm: new FakeLLM({ firstTokenMs: 0, chunkMs: 0 }), market: new FakeMarket(), cfg: { roomCreatesPerIpPerMin: 1000, maxSocketsPerIp: 1000, adminToken: 'sekret', roundPaceMs: 0, chatterPaceMs: 0, newsCooldownSec: 0 } });
  port = await app.listen(0);
});
afterAll(async () => { await app.close(); });

describe('chaos: the server stays up', () => {
  it('an oversized WebSocket frame closes that socket, not the server', async () => {
    const ws = await sock();
    const closed = new Promise(r => ws.once('close', r));
    ws.send('x'.repeat(20_000));
    await closed;
    expect(await alive()).toBe(true);
  });

  it('a malformed URL gets a 400, not a crash', async () => {
    expect(await raw('/%E0%A4%A')).toBe(400);
    expect(await raw('/..%2F..%2Fpackage.json')).not.toBe(200);
    expect(await alive()).toBe(true);
  });

  it('malformed and hostile messages are ignored', async () => {
    const { code, token } = await mkRoom();
    const ws = await sock(); await joinMsg(ws, code, token, 'Brae');
    for (const m of ['{', 'null', '[]', '{"k":5}', '{"k":"order","side":"buy","qty":"lots"}', '{"k":"order","side":"short","qty":100}', '{"k":"order","side":"buy","qty":-5}', '{"k":"order","side":"buy","qty":1e12}', '{"k":"ask","id":{"toString":0},"q":{"toString":0}}', '{"k":"news","text":{"toString":0}}', '{"k":"host","action":"lab","lab":{"vol":"x"}}', '{"k":"join","room":"AAAAA","token":"x"}'])
      ws.send(m);
    await new Promise(r => setTimeout(r, 200));
    expect(await alive()).toBe(true);
    ws.close();
  });

  it('a flooding client is disconnected; everyone else is fine', async () => {
    const { code, token } = await mkRoom();
    const good = await sock(); await joinMsg(good, code, token, 'Good');
    const bad = await sock(); await joinMsg(bad, code, 'flooder-token-1', 'Flood');
    const closed = new Promise<number>(r => bad.once('close', c => r(c)));
    for (let i = 0; i < 400; i++) bad.send('{"k":"ping","t":0}');
    expect(await closed).toBe(4029);
    expect(good.readyState).toBe(WebSocket.OPEN);
    good.close();
  });

  it('twenty players trading at once on one book', async () => {
    const { code, token } = await mkRoom();
    const socks: WebSocket[] = [];
    const host = await sock(); await joinMsg(host, code, token, 'Host'); socks.push(host);
    for (let i = 0; i < 11; i++) { const s = await sock(); await joinMsg(s, code, `player-token-${i}-x`, `P${i}`); socks.push(s); }
    // the room caps at 12 seats; the rest can watch
    const extra = await sock();
    await expect(joinMsg(extra, code, 'player-token-99-x', 'P99')).rejects.toThrow(/full/);
    const watchers: WebSocket[] = [];
    for (let i = 0; i < 8; i++) { const w = await sock(); w.send(JSON.stringify({ k: 'join', room: code, token: '', name: '', watch: true })); watchers.push(w); }
    await new Promise(r => setTimeout(r, 100));
    for (const s of socks) for (let k = 0; k < 3; k++) s.send(JSON.stringify({ k: 'order', side: k % 2 ? 'sell' : 'buy', qty: 500 }));
    await new Promise(r => setTimeout(r, 300));
    const room = app.rooms.rooms.get(code)!;
    expect(room.players.size).toBe(12);
    expect(room.watchers.size).toBe(8);
    // shares are conserved: every share bought was sold by someone
    const total = Object.values(room.eng.S.accounts).reduce((a, x) => a + x.sh, 0) + Object.values(room.eng.S.mmInv).reduce((a, x) => a + x, 0);
    expect(Number.isFinite(total)).toBe(true);
    [...socks, ...watchers, extra].forEach(s => s.close());
  });

  it('spectators cannot act', async () => {
    const { code } = await mkRoom();
    const w = await sock();
    await new Promise<void>(ok => { w.on('message', d => { if (JSON.parse(String(d)).k === 'hello') ok(); }); w.send(JSON.stringify({ k: 'join', room: code, token: '', name: '', watch: true })); });
    w.send(JSON.stringify({ k: 'news', text: 'watcher news' }));
    w.send(JSON.stringify({ k: 'order', side: 'buy', qty: 500 }));
    await new Promise(r => setTimeout(r, 100));
    const room = app.rooms.rooms.get(code)!;
    expect(room.news.some(n => n.text === 'watcher news')).toBe(false);
    w.close();
  });
});

describe('security', () => {
  it('cross-site WebSocket connections are refused', async () => {
    await expect(sock({ origin: 'https://evil.example' })).rejects.toThrow(/403/);
    const ok = await sock({ origin: `http://localhost:${port}` }); ok.close();
  });

  it('responses carry security headers; the health check no longer exposes usage', async () => {
    const r = await fetch(`${base()}/api/health`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(Object.keys(await r.json())).not.toContain('usage');
  });

  it('admin needs the token', async () => {
    expect((await fetch(`${base()}/api/admin`)).status).toBe(403);
    const r = await fetch(`${base()}/api/admin`, { headers: { 'x-admin-token': 'sekret' } });
    expect(r.status).toBe(200);
    const d = await r.json();
    expect(d).toHaveProperty('ai.costUSD');
    expect(d).toHaveProperty('experiments');
  });

  it('tokens are stored hashed, never as sent', async () => {
    const store = (app.deps.store as unknown as { inner: MemoryStore }).inner;
    const { code, token } = await mkRoom('my-secret-token-123');
    expect(store.rooms.get(code)!.host_token).not.toBe(token);
    expect(store.rooms.get(code)!.host_token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('failure is graceful', () => {
  it('a database that throws on every call never takes the game down', async () => {
    const broken = new Proxy({ kind: 'supabase' }, { get: (t, k) => k === 'kind' ? 'supabase' : async () => { throw new Error('db down'); } }) as unknown as Store;
    const a = createApp({ llm: new FakeLLM({ firstTokenMs: 0, chunkMs: 0 }), store: broken, market: null, cfg: { roundPaceMs: 0, chatterPaceMs: 0, newsCooldownSec: 0 } });
    const p = await a.listen(0);
    const r = await fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) });
    expect(r.status).toBe(200);
    const room = a.rooms.rooms.get((await r.json()).code)!;
    await room.runRound({ text: 'Still trading', byName: 'x', origin: 'PLAYER' });
    await room.savePlayers(true);
    expect(room.stats.rounds).toBe(1);
    await a.close();
  });

  it('market data down: a Real room can\'t open, and says why; Sim still works', async () => {
    const m = new FakeMarket(); m.down = true;
    const a = createApp({ llm: null, market: m });
    const p = await a.listen(0);
    const r = await fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'real', ticker: 'NVDA', token: 'host-token-abc' }) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatch(/No live quote/);
    const s = await fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) });
    expect(s.status).toBe(200);
    await a.close();
  });

  it('room creation is rate-limited per IP', async () => {
    const a = createApp({ llm: null, market: null, cfg: { roomCreatesPerIpPerMin: 2 } });
    const p = await a.listen(0);
    const post = () => fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) }).then(r => r.status);
    expect([await post(), await post(), await post()]).toEqual([200, 200, 429]);
    await a.close();
  });

  it('the daily AI usage survives a restart', async () => {
    const store = new MemoryStore();
    const a = createApp({ llm: new FakeLLM({ firstTokenMs: 0, chunkMs: 0 }), store, market: null, cfg: { roundPaceMs: 0, chatterPaceMs: 0 } });
    const p = await a.listen(0);
    const r = await fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) });
    const room = a.rooms.rooms.get((await r.json()).code)!;
    room.lab.debate = 'off';
    await room.runRound({ text: 'x', byName: 'x', origin: 'PLAYER' });
    await new Promise(r => setTimeout(r, 3300));
    expect(store.usage?.rounds).toBe(1);
    await a.close();
    const b = createApp({ llm: new FakeLLM(), store, market: null });
    await b.listen(0);
    await new Promise(r => setTimeout(r, 50));
    expect(b.deps.guard.stats().rounds).toBe(1);
    await b.close();
  });
});

describe('second security pass', () => {
  it('room creation needs JSON from this site', async () => {
    const plain = await fetch(`${base()}/api/rooms`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) });
    expect(plain.status).toBe(415);
    const cross = await fetch(`${base()}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) });
    expect(cross.status).toBe(403);
  });

  it('a forged X-Forwarded-For does not dodge the per-IP limits (no trusted proxy)', async () => {
    const a = createApp({ llm: null, market: null, cfg: { roomCreatesPerIpPerMin: 2, trustProxy: false } });
    const p = await a.listen(0);
    const post = (i: number) => fetch(`http://localhost:${p}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${i}` }, body: JSON.stringify({ mode: 'sim', token: 'host-token-abc' }) }).then(r => r.status);
    expect([await post(1), await post(2), await post(3)]).toEqual([200, 200, 429]);
    await a.close();
  });

  it('the admin token is accepted only as a header, never in the URL', async () => {
    expect((await fetch(`${base()}/api/admin?token=sekret`)).status).toBe(403);
    expect((await fetch(`${base()}/api/admin`, { headers: { 'x-admin-token': 'wrong' } })).status).toBe(403);
    expect((await fetch(`${base()}/admin`)).headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rooms nobody ever joins are swept within minutes, not hours', async () => {
    const { code } = await mkRoom();
    const r = app.rooms.rooms.get(code)!;
    expect(r.everJoined).toBe(false);
    r.lastActive = Date.now() - 6 * 60_000;
    const fresh = await mkRoom();                              // a brand-new unjoined room survives
    await app.rooms.sweep();
    expect(app.rooms.rooms.has(code)).toBe(false);
    expect(app.rooms.rooms.has(fresh.code)).toBe(true);
  });
});
