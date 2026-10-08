// The admin / observability page: rooms, engine health, sockets, AI latency, tokens,
// estimated cost, market-data freshness, store errors, and the memory experiment.
// Served at /admin. Open /admin#token=ADMIN_TOKEN (the fragment never reaches the server or its logs);
// the page sends it as a header to /api/admin. Without ADMIN_TOKEN, only loopback and never behind a proxy.

export const adminHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Pit · Control room</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root{--ground:#0c1219;--panel:#121a24;--panel2:#17212d;--line:#233142;--fg:#dce4ec;--muted:#7d8ca0;--faint:#4f5f73;--amber:#f0a83a;--up:#36c2a0;--down:#f0605a;color-scheme:dark}
html,body{margin:0;background:var(--ground);color:var(--fg);font:13px/1.45 "IBM Plex Mono",ui-monospace,monospace}
.wrap{max-width:1300px;margin:0 auto;padding:16px;display:grid;gap:12px}
h1{margin:0;font:900 40px/0.9 "Big Shoulders Display",Impact,sans-serif;color:var(--amber);text-transform:uppercase;letter-spacing:.02em}
h2{margin:0 0 8px;font:800 18px/1 "Big Shoulders Display",Impact,sans-serif;text-transform:uppercase;letter-spacing:.06em}
.sub{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow:auto}
.kpi{display:flex;flex-wrap:wrap;gap:6px 22px}.kpi div{display:flex;flex-direction:column}.kpi span{font-size:10px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase}.kpi b{font-size:18px;font-weight:600}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:500;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}
.ok{color:var(--up)}.bad{color:var(--down)}.amb{color:var(--amber)}
.err{color:var(--down);white-space:pre-wrap}
</style></head><body><div class="wrap">
<div><h1>Control room</h1><div class="sub" id="meta">connecting…</div></div>
<div class="grid">
 <div class="panel"><h2>Server</h2><div class="kpi" id="srv"></div></div>
 <div class="panel"><h2>AI cost · today</h2><div class="kpi" id="cost"></div></div>
 <div class="panel"><h2>Market data</h2><div id="mkt"></div></div>
</div>
<div class="panel"><h2>Rooms</h2><table id="rooms"></table></div>
<div class="grid">
 <div class="panel"><h2>Recent AI calls</h2><table id="calls"></table></div>
 <div class="panel"><h2>Experiment · AI config vs accuracy</h2><p class="sub">Calls are scored 60 s after they're made. Small samples are noisy.</p><table id="exp"></table></div>
</div>
<div class="panel"><h2>Errors</h2><div class="err" id="errs">none</div></div>
</div>
<script>
const q = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const $ = s => document.querySelector(s);
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = x => x == null ? '-' : '$' + (+x).toFixed(x < 0.1 ? 4 : 2);
const kpi = o => Object.entries(o).map(([k, v]) => '<div><span>' + e(k) + '</span><b>' + e(v) + '</b></div>').join('');
const tbl = (cols, rows) => '<tr>' + cols.map(c => '<th>' + e(c[0]) + '</th>').join('') + '</tr>' + rows.map(r => '<tr>' + cols.map(c => '<td>' + c[1](r) + '</td>').join('') + '</tr>').join('');
async function tick() {
  try {
    const r = await fetch('/api/admin', { cache: 'no-store', headers: q ? { 'x-admin-token': q } : {} });
    if (!r.ok) { $('#meta').textContent = 'admin only (' + r.status + '): open /admin#token=YOUR_ADMIN_TOKEN'; return; }
    const d = await r.json();
    $('#meta').textContent = 'uptime ' + d.uptimeMin + ' min · updated ' + new Date().toLocaleTimeString();
    $('#srv').innerHTML = kpi({ Rooms: d.rooms.length, Sockets: d.sockets, 'Heap MB': d.memMB.heap, 'RSS MB': d.memMB.rss, Store: d.store.kind + (d.store.errors ? ' · ' + d.store.errors + ' errors' : '') });
    const a = d.ai;
    $('#cost').innerHTML = kpi({ Provider: a.provider, Today: usd(a.costUSD), 'Last call': usd(a.lastCallUSD), Rounds: a.rounds + ' / ' + a.roundCap, Small: a.small + ' / ' + a.smallCap, 'Tokens in/out': a.tokensIn + ' / ' + a.tokensOut, Avoided: a.avoided });
    $('#mkt').innerHTML = d.market ? '<div class="sub">' + e(d.market.provider) + ' · US market ' + (d.market.status ? (d.market.status.isOpen ? '<span class=ok>open</span>' : 'closed') : '?') + '</div>' + tbl([['Ticker', t => e(t.symbol)], ['Rooms', t => t.listeners], ['Price', t => t.price ?? '-'], ['Quote age', t => t.quoteAgeSec == null ? '-' : '<span class="' + (t.quoteAgeSec > 120 ? 'amb' : 'ok') + '">' + t.quoteAgeSec + 's</span>']], d.market.tickers) : 'off';
    $('#rooms').innerHTML = tbl([
      ['Room', r => '<b>' + e(r.code) + '</b>'], ['Mode', r => e(r.mode + ' ' + r.ticker)], ['Seed', r => r.seed], ['Players', r => r.online + '/' + r.players + (r.watchers ? ' +' + r.watchers + ' watching' : '')],
      ['Speed', r => r.speed + '×'], ['Regime', r => e(r.regime)], ['Round', r => r.round ? '<span class=amb>' + e(r.round) + '</span>' : '-'], ['Queue', r => r.liveQueue],
      ['AI rounds', r => r.rounds.aiRounds + ' (+' + r.rounds.debates + ' debates, ' + r.rounds.offlineRounds + ' offline)'], ['AI avg', r => r.aiAvgMs == null ? '-' : r.aiAvgMs + ' ms'],
      ['Cost', r => usd(r.costToday)], ['Frame', r => r.frameMsAvg + ' / ' + r.frameMsMax + ' ms'], ['Sent', r => r.mbSent + ' MB'], ['Pending calls', r => r.pendingCalls],
      ['Lab', r => e('mem ' + (r.lab.memory ? 'on' : 'off') + ' · debate ' + r.lab.debate + ' · vol ' + r.lab.vol + ' · liq ' + r.lab.liq)],
    ], d.rooms);
    $('#calls').innerHTML = tbl([['Room', c => e(c.room)], ['Kind', c => e(c.kind)], ['Model', c => e(c.model)], ['In/out', c => c.inputTokens + '/' + c.outputTokens], ['ms', c => c.ms], ['Cost', c => usd(c.cost)], ['OK', c => c.ok ? '<span class=ok>✓</span>' : '<span class=bad>✗</span>']], a.recent);
    $('#exp').innerHTML = tbl([['Config', x => e(x.lab)], ['Rooms', x => x.rooms], ['Calls', x => x.calls], ['Accuracy', x => x.accuracy == null ? '-' : Math.round(x.accuracy * 100) + '%'], ['70+ conv', x => x.highConvAccuracy == null ? '-' : Math.round(x.highConvAccuracy * 100) + '%']], d.experiments);
    $('#errs').textContent = d.errors.length ? d.errors.join('\\n') : 'none';
  } catch (err) { $('#meta').textContent = 'offline: ' + err.message; }
}
tick(); setInterval(tick, 2000);
</script></body></html>`;
