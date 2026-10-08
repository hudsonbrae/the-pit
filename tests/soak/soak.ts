// Soak test: runs the real server in-process with simulated players for N minutes
// (default 10) and checks that memory does not grow and the tick stream stays smooth.
//
//   npm run soak                 # 10 minutes
//   SOAK_MINUTES=2 npm run soak  # quicker
//
// Pass criteria (after a 2-minute warm-up so caches and arrays fill to their caps):
//   - heap growth from the warm-up baseline to the end < 20 MB, and the
//     least-squares slope of the heap over that window < 1.5 MB/minute;
//   - every client receives ~4 deltas a second with no gap over 1 second;
//   - event-loop delay p99 under 50 ms.

import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createApp } from '../../server/app';
import { FakeLLM } from '../../server/ai/fake';
import { FakeMarket } from '../../server/market/fake';

const MIN = Number(process.env.SOAK_MINUTES || 10);
const WARM = Math.min(2, MIN / 3);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) { console.error('Run with --expose-gc (npm run soak does this).'); process.exit(2); }

const market = new FakeMarket({ autoNewsEverySec: 60 });
market.forceOpen = true;
const app = createApp({
  llm: new FakeLLM({ firstTokenMs: 400, chunkMs: 10 }),
  market,
  cfg: { publicDir: 'dist', quotePollSec: 5, newsPollSec: 20, aiRoundsPerMinPerRoom: 6, roundPaceMs: 700, chatterPaceMs: 900 },
});
const port = await app.listen(0);
const base = `http://localhost:${port}`;

async function mkRoom(mode: 'sim' | 'real', ticker?: string) {
  const r = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify({ mode, ticker, token: `host-${mode}-0000` }) });
  return (await r.json()).code as string;
}

interface Client { name: string; ws: WebSocket; deltas: number; bytes: number; lastAt: number; maxGap: number; gaps: number[]; trades: number }
function connect(code: string, name: string, token: string): Promise<Client> {
  return new Promise((ok, bad) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const c: Client = { name, ws, deltas: 0, bytes: 0, lastAt: 0, maxGap: 0, gaps: [], trades: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ k: 'join', room: code, token, name })));
    ws.on('message', raw => {
      const s = String(raw); const m = JSON.parse(s);
      if (m.k === 'hello') ok(c);
      if (m.k === 'err') bad(new Error(m.text));
      if (m.k === 'd') {
        const now = performance.now();
        if (c.lastAt && measuring) { const g = now - c.lastAt; c.maxGap = Math.max(c.maxGap, g); if (c.gaps.length < 20000) c.gaps.push(g); }
        c.lastAt = now; c.bytes += s.length; c.deltas++; c.trades += m.trades.length;
      }
    });
    ws.on('error', bad);
  });
}

let measuring = false;
const sim = await mkRoom('sim');
const real = await mkRoom('real', 'NVDA');
const clients = [
  await connect(sim, 'Brae', 'host-sim-0000'), await connect(sim, 'Sam', 'tok-sam-00001'), await connect(sim, 'Alex', 'tok-alex-0001'),
  await connect(real, 'Brae', 'host-real-0000'), await connect(real, 'Kim', 'tok-kim-00001'),
];
console.log(`soak: ${MIN} min, rooms ${sim} (sim) and ${real} (real NVDA), ${clients.length} clients, port ${port}`);

const heads = ['Halcyon wins $4B Pentagon contract', 'CFO resigns effective immediately', 'Short seller alleges fraud', 'Record quarterly profit', 'Regulator opens probe'];
let hi = 0;
const timers = [
  setInterval(() => { for (const c of clients) c.ws.send(JSON.stringify({ k: 'order', side: Math.random() < 0.5 ? 'buy' : 'sell', qty: [100, 500, 2000][Math.floor(Math.random() * 3)] })); }, 1500),
  setInterval(() => { clients[hi % 3].ws.send(JSON.stringify({ k: 'news', text: heads[hi % heads.length] + ' #' + hi })); hi++; }, 30_000),
  setInterval(() => clients[4].ws.send(JSON.stringify({ k: 'check' })), 47_000),
  setInterval(() => clients[1].ws.send(JSON.stringify({ k: 'ask', id: 'pip', q: 'Why?' })), 61_000),
];

const loop = monitorEventLoopDelay({ resolution: 10 });
const samples: { min: number; heapMB: number; rssMB: number }[] = [];
const t0 = Date.now();
const sample = () => { gc!(); const m = process.memoryUsage(); samples.push({ min: (Date.now() - t0) / 60000, heapMB: m.heapUsed / 1e6, rssMB: m.rss / 1e6 }); };
await new Promise(r => setTimeout(r, WARM * 60_000));
sample(); measuring = true; loop.enable();
const baseline = samples[0];
console.log(`baseline after ${WARM} min warm-up: heap ${baseline.heapMB.toFixed(1)} MB`);
const sampler = setInterval(() => { sample(); const s = samples.at(-1)!; console.log(`  t=${s.min.toFixed(1)}m heap ${s.heapMB.toFixed(1)} MB rss ${s.rssMB.toFixed(0)} MB`); }, 30_000);
await new Promise(r => setTimeout(r, (MIN - WARM) * 60_000));
clearInterval(sampler); sample(); loop.disable();
timers.forEach(clearInterval);

const n = samples.length, xs = samples.map(s => s.min), ys = samples.map(s => s.heapMB);
const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
const growth = samples.at(-1)!.heapMB - baseline.heapMB;
const secs = (MIN - WARM) * 60;
const perClient = clients.map(c => {
  const g = c.gaps.slice().sort((a, b) => a - b);
  return { name: c.name, deltasPerSec: +(c.gaps.length / secs).toFixed(2), avgBytes: Math.round(c.bytes / c.deltas), p99GapMs: Math.round(g[Math.floor(g.length * 0.99)] ?? 0), maxGapMs: Math.round(c.maxGap) };
});
const st = app.rooms.rooms;
const report = {
  minutes: MIN, warmupMinutes: WARM, heapBaselineMB: +baseline.heapMB.toFixed(1), heapEndMB: +samples.at(-1)!.heapMB.toFixed(1), heapGrowthMB: +growth.toFixed(1), heapSlopeMBPerMin: +slope.toFixed(2),
  eventLoopP99ms: +(loop.percentile(99) / 1e6).toFixed(1), eventLoopMaxMs: +(loop.max / 1e6).toFixed(1),
  rounds: [...st.values()].map(r => ({ code: r.code, mode: r.mode, ...r.stats })), clients: perClient, usage: app.deps.guard.stats(),
};
console.log(JSON.stringify(report, null, 2));
writeFileSync('tests/soak/last-run.json', JSON.stringify({ ranAt: new Date().toISOString(), ...report }, null, 2) + '\n');

const fails: string[] = [];
if (growth > 20) fails.push(`heap grew ${growth.toFixed(1)} MB`);
if (slope > 1.5) fails.push(`heap slope ${slope.toFixed(2)} MB/min`);
for (const c of perClient) {
  if (c.deltasPerSec < 3.6) fails.push(`${c.name}: only ${c.deltasPerSec} deltas/s`);
  if (c.maxGapMs > 1000) fails.push(`${c.name}: ${c.maxGapMs} ms gap`);
}
if (report.eventLoopP99ms > 50) fails.push(`event loop p99 ${report.eventLoopP99ms} ms`);
if (![...st.values()].every(r => r.stats.rounds > 0)) fails.push('a room ran no AI rounds');
clients.forEach(c => c.ws.close());
await app.close();
if (fails.length) { console.error('SOAK FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
console.log('SOAK PASSED');
process.exit(0);
