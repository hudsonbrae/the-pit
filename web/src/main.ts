// The Pit — browser client. Renders server state; never runs its own engine.
// Render code (chart, book, tape, floor, wire, drawer, sound) is ported from the
// original ui.js with the game logic removed: every action is sent to the server.

import './style.css';
import { f2, fi, money, sgn, esc } from '../../shared/format';
import type { AccV, AgentV, CandleV, ChatterV, ClientMsg, FillV, HaltV, LevelV, MarkerV, NewsV, PlayerV, RoomInfo, RoundState, ServerMsg, Snapshot, TradeV } from '../../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DT = 0.25;
const clock = (t: number) => { const s = 9 * 3600 + 30 * 60 + Math.floor(t * DT); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// ---------- identity ----------
let token = store.get('pit.token');
if (!token) { token = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('pit.token', token); }
const TOKEN = token;

// ---------- client state (a mirror of the server's room) ----------
const G = {
  room: null as RoomInfo | null, me: null as PlayerV | null,
  t: 0, clock: '09:30:00', last: 100, open: 100, hi: 100, lo: 100, vwap: null as number | null, vol: 0, halted: 0,
  candles: [] as CandleV[], trades: [] as TradeV[], book: { bids: [] as LevelV[], asks: [] as LevelV[] }, acc: {} as Record<string, AccV>,
  halts: [] as HaltV[], fills: [] as FillV[], markers: [] as MarkerV[],
  agents: [] as AgentV[], players: [] as PlayerV[], wire: [] as NewsV[], round: { busy: false } as RoundState,
};
type Who = { id: string; name: string; c: string; ai: boolean };
let NAMES: Record<string, Who> = {};
function rebuildNames() {
  NAMES = {};
  G.agents.forEach(a => { NAMES[a.id] = { id: a.id, name: a.name, c: `var(--a-${a.id})`, ai: true }; });
  G.players.forEach(p => { NAMES[p.id] = { id: p.id, name: p.id === G.me?.id ? 'You' : p.name, c: p.color, ai: false }; });
}
const pnl = (id: string) => { const a = G.acc[id]; return a ? a[0] + a[1] * G.last - a[2] : 0; };

// ---------- routing: lobby, join card, or game ----------
const path = location.pathname.match(/^\/r\/([A-Za-z]{5})\/?$/);
const qs = new URLSearchParams(location.search).get('room');
const CODE = (path?.[1] ?? qs ?? '').toUpperCase();

function show(id: 'lobby' | 'joinCard' | 'game') { ['lobby', 'joinCard', 'game'].forEach(x => { $(`#${x}`).hidden = x !== id; }); }

if (!CODE) lobby(); else enter(CODE);

function lobby() {
  show('lobby');
  const nameIn = $<HTMLInputElement>('#nameIn'); nameIn.value = store.get('pit.name') ?? '';
  let mode: 'sim' | 'real' = 'sim';
  $('#modeSeg').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    mode = b.dataset.m as 'sim' | 'real';
    $('#modeSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('#tickerFld').hidden = mode !== 'real';
    $('#modeHint').textContent = mode === 'real' ? 'A real US stock. Real quotes anchor the price; real headlines arrive on their own.' : 'Fictional Halcyon Dynamics. Write any headline and watch the floor react.';
  });
  const st = $('#lobbyStatus');
  $('#createForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    store.set('pit.name', name);
    const ticker = $<HTMLInputElement>('#tickerIn').value.trim().toUpperCase();
    if (mode === 'real' && !ticker) { $<HTMLInputElement>('#tickerIn').focus(); return; }
    st.className = 'status busy'; st.textContent = mode === 'real' ? `Looking up ${ticker} and warming up the floor…` : 'Warming up the floor…';
    $<HTMLButtonElement>('#createBtn').disabled = true;
    try {
      const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, ticker, token: TOKEN }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not open a room.');
      history.replaceState(null, '', `/r/${j.code}`);
      startGame(j.code, name);
    } catch (err) {
      st.className = 'status err'; st.textContent = (err as Error).message || 'Could not reach the server.';
      $<HTMLButtonElement>('#createBtn').disabled = false;
    }
  });
  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const c = $<HTMLInputElement>('#codeIn').value.trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(c)) { st.className = 'status err'; st.textContent = 'Room codes are 5 letters.'; return; }
    location.href = `/r/${c}`;
  });
}

async function enter(code: string) {
  const name = store.get('pit.name');
  if (name) return startGame(code, name);
  show('joinCard');
  try {
    const r = await fetch(`/api/rooms/${code}`); const j = await r.json();
    $('#joinWhat').textContent = r.ok ? `Room ${j.code} · ${j.ticker} · ${j.mode === 'real' ? 'Real market' : 'Sim'}` : (j.error || 'Room not found');
  } catch { /* offline: the socket will report */ }
  $('#nameForm').addEventListener('submit', e => {
    e.preventDefault();
    const n = $<HTMLInputElement>('#nameIn2').value.trim(); if (!n) return;
    store.set('pit.name', n); startGame(code, n);
  });
}

// ---------- socket ----------
let ws: WebSocket | null = null;
let retry = 0, fatal = false, joinedOnce = false;
function send(m: ClientMsg) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

function startGame(code: string, name: string) {
  show('game');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 0; send({ k: 'join', room: code, token: TOKEN, name }); };
    ws.onmessage = ev => { try { onMsg(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
    ws.onclose = () => {
      if (fatal) return;
      setConn(false);
      const wait = Math.min(8000, 500 * 2 ** retry++);
      setTimeout(connect, wait);
    };
  };
  connect();
}
function setConn(ok: boolean) {
  if (!ok) { const m = $('#mkt'); m.className = 'pill halt'; m.lastChild!.textContent = 'Reconnecting…'; }
}

// ---------- messages ----------
function onMsg(m: ServerMsg) {
  switch (m.k) {
    case 'hello': G.me = m.you; joinedOnce = true; applyRoom(m.room); applySnap(m.snap); break;
    case 'reset': applySnap(m.snap); $('#chatter').innerHTML = ''; $('#chatter').hidden = true; $('#wrap').hidden = true; $('#toast').textContent = 'The host reset the room. Everyone is back to $1M.'; break;
    case 'd': applyDelta(m); break;
    case 'wire': G.wire = m.wire; renderWire(); break;
    case 'agent': {
      const i = G.agents.findIndex(a => a.id === m.a.id); if (i < 0) break;
      G.agents[i] = m.a; paintAgent(m.a, m.flash);
      if (m.newLesson) { const ls = card(m.a.id).querySelector('[data-lsn]')!; ls.textContent = 'New lesson'; ls.classList.add('new'); setTimeout(() => { ls.textContent = lsnLabel(m.a); ls.classList.remove('new'); }, 4000); }
      if (m.flash && m.a.lastAct && m.a.lastAct.side !== 'hold' && /filled/.test(m.a.lastAct.fill)) sfx.fill(m.a.lastAct.side);
      if (open?.id === m.a.id) paintDrawer();
      break;
    }
    case 'thinking': G.agents.forEach(a => { a.thinking = m.text; const el = card(a.id); el.classList.add('thinking'); el.querySelector('[data-th]')!.textContent = m.text; }); break;
    case 'chatter': addChatter(m.c, true); break;
    case 'round': setRound(m.r); if (m.shake) shake(m.shake); break;
    case 'players': G.players = m.players; const me = m.players.find(p => p.id === G.me?.id); if (me) G.me = me; rebuildNames(); renderPlayers(); renderStand(); break;
    case 'room': applyRoom(m.room); break;
    case 'toast': if (m.text) { if (m.area === 'news') { const st = $('#status'); st.textContent = m.text; st.classList.remove('busy'); } else $('#toast').textContent = m.text; } break;
    case 'stream': onStream(m); break;
    case 'err':
      fatal = true; ws?.close();
      if (!joinedOnce) { show('joinCard'); $('#joinWhat').textContent = m.text; $('#nameForm').hidden = true; const a = document.createElement('a'); a.href = '/'; a.className = 'btn primary'; a.textContent = 'Back to the lobby'; a.style.textAlign = 'center'; a.style.textDecoration = 'none'; $('#joinStatus').replaceChildren(a); }
      else { $('#status').textContent = m.text; }
      break;
  }
}

function applyRoom(r: RoomInfo) {
  const first = !G.room;
  G.room = r;
  const real = r.mode === 'real';
  $('#brandSub').textContent = real ? `${r.ticker} · ${r.company} · simulated exchange anchored to real price` : `${r.ticker} · ${r.company} · simulated exchange`;
  $('#chartTitle').textContent = r.ticker;
  $('#chart').setAttribute('aria-label', `Candlestick chart of ${r.ticker} price`);
  document.title = `${r.ticker} · The Pit`;
  $('#roomLbl').textContent = `Room ${r.code} · invite`;
  $('#ai').className = 'pill ' + (r.ai.on ? 'ai' : 'off'); $('#ai').lastChild!.textContent = r.ai.label;
  const host = G.me?.id === r.hostId;
  $('#speed').querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(+(b as HTMLElement).dataset.s! === r.speed)); (b as HTMLButtonElement).disabled = !host; b.title = host ? '' : 'Only the host can change speed'; });
  $('#resetBtn').hidden = !host;
  $('#pauseBanner').hidden = r.speed !== 0;
  $('#realq').hidden = !real;
  if (real && r.real) {
    $('#realPx').textContent = r.real.price != null ? f2(r.real.price) : '-';
    const closed = r.real.marketOpen === false;
    $('#realSub').textContent = closed ? 'US market closed · running on last real price' : 'live';
    $('#chartSub').textContent = `5-second candles · simulated exchange anchored to real price${closed ? ' · US market closed' : ''}`;
    $('#deskSub').textContent = `Real ${r.ticker} headlines arrive on their own (LIVE). Yours are marked PLAYER.`;
    $('#foot').textContent = `Simulated exchange anchored to real price. Quotes and headlines: ${r.real.provider}. Fake money only; nothing here places real orders.`;
  }
  if (first) {
    $('#chips').innerHTML = r.presets.map(p => `<button class="chip" type="button">${esc(p)}</button>`).join('');
    setBusyUI(G.round.busy);
  }
}

function applySnap(s: Snapshot) {
  Object.assign(G, { t: s.t, clock: s.clock, last: s.last, open: s.open, hi: s.hi, lo: s.lo, vwap: s.vwap, vol: s.vol, halted: s.halted, candles: s.candles, trades: s.trades, book: s.book, acc: s.acc, halts: s.halts, fills: s.fills, markers: s.markers, agents: s.agents, players: s.players, wire: s.wire, round: s.round });
  rebuildNames();
  C = null;
  buildFloor();
  $('#chatter').innerHTML = ''; $('#chatter').hidden = true;
  s.chatter.slice().reverse().forEach(c => addChatter(c, false));
  setRound(s.round);
  $('#haltBanner').hidden = !s.halted;
  renderWire(); renderTop(); renderBook(); renderTape(); renderStand(); renderPlayers(); drawChart();
}

let frame = 0;
function applyDelta(d: ServerMsg & { k: 'd' }) {
  Object.assign(G, { t: d.t, clock: d.clock, last: d.last, open: d.open, hi: d.hi, lo: d.lo, vwap: d.vwap, vol: d.vol, halted: d.halted, book: d.book, acc: d.acc });
  for (const c of d.candles) {
    const last = G.candles[G.candles.length - 1];
    if (last && last.idx === c.idx) G.candles[G.candles.length - 1] = c;
    else if (!last || c.idx > last.idx) G.candles.push(c);
  }
  if (G.candles.length > 900) G.candles.splice(0, G.candles.length - 900);
  if (d.trades.length) { G.trades = [...d.trades, ...G.trades].slice(0, 18); renderTape(); }
  if (d.halts) G.halts = d.halts;
  if (d.fills) { G.fills.push(...d.fills); if (G.fills.length > 200) G.fills.splice(0, G.fills.length - 200); }
  if (d.markers) { G.markers.push(...d.markers); if (G.markers.length > 100) G.markers.splice(0, G.markers.length - 100); }
  for (const e of d.ev ?? []) {
    if (e.type === 'halt') { sfx.halt(); $('#haltTitle').textContent = `Limit ${e.dir}`; $('#haltBanner').hidden = false; shake(e.dir); }
    else $('#haltBanner').hidden = true;
  }
  if (G.halted) $('#haltSub').textContent = `Circuit breaker · reopens in ${G.halted}s`;
  else if (!$('#haltBanner').hidden) $('#haltBanner').hidden = true;
  frame++;
  renderTop(); scheduleChart();
  if (frame % 2 === 0) { renderBook(); renderStand(); }
}

// ---------- floor ----------
const floor = $('#floor');
const card = (id: string) => floor.querySelector(`[data-id="${id}"]`) as HTMLElement;
const lsnLabel = (a: AgentV) => a.lessons.length ? `${a.lessons.length} lesson${a.lessons.length > 1 ? 's' : ''} learned` : '';
function buildFloor() {
  floor.innerHTML = G.agents.map(a => `
    <button class="agent" type="button" data-id="${a.id}" style="--c:var(--a-${a.id})">
      <div class="ah"><span class="dot"></span><b>${esc(a.name)}</b><span class="tag">${esc(a.tag)}</span><span class="pnl num" data-pnl></span></div>
      <div class="act" data-act></div>
      <p class="thought" data-th></p>
      <div class="meta"><span data-pos></span><span>conviction</span><span class="conv"><i data-conv></i></span><span class="lsn" data-lsn></span></div>
    </button>`).join('');
  G.agents.forEach(a => { card(a.id).querySelector('[data-lsn]')!.textContent = lsnLabel(a); paintAgent(a, false); });
}
function paintAgent(a: AgentV, flash?: boolean) {
  const el = card(a.id); if (!el) return;
  const th = el.querySelector('[data-th]') as HTMLElement;
  if (a.thinking) { el.classList.add('thinking'); clearInterval((th as unknown as { _t: number })._t); th.textContent = a.thinking; }
  else {
    el.classList.remove('thinking');
    if (flash) typeInto(th, a.thought); else { clearInterval((th as unknown as { _t: number })._t); th.textContent = a.thought; }
  }
  (el.querySelector('[data-conv]') as HTMLElement).style.width = a.conv + '%';
  const act = el.querySelector('[data-act]')!;
  if (!a.lastAct) act.innerHTML = `<span class="side hold">Pre-market</span>`;
  else act.innerHTML = `<span class="side ${esc(a.lastAct.side)}">${esc(a.lastAct.label)}</span><span class="fill">${esc(a.lastAct.fill || '')}</span>`;
  if (!el.querySelector('.lsn.new')) el.querySelector('[data-lsn]')!.textContent = lsnLabel(a);
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}
floor.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.agent') as HTMLElement | null; if (b) openDrawer(b.dataset.id!); });

function typeInto(el: HTMLElement & { _t?: number }, text: string) {
  clearInterval(el._t); el.textContent = ''; let i = 0;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = text; return; }
  el._t = window.setInterval(() => { i += 2; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(el._t); }, 16);
}

// ---------- wire ----------
function impChip(n: NewsV) {
  if (n.impact == null) return `<span class="imp wait">reading…</span>`;
  const c = n.impact > 0.4 ? 'pos' : n.impact < -0.4 ? 'neg' : 'flat';
  return `<span class="imp ${c}">${n.impact > 0 ? '+' : ''}${(+n.impact).toFixed(1)}% fair value</span>`;
}
const realTime = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
function origin(n: NewsV) {
  if (n.origin === 'LIVE') return `<span class="org live">LIVE</span>`;
  if (n.origin === 'PLAYER' && n.kind === 'news') return `<span class="org player">PLAYER</span>`;
  return '';
}
function meta(n: NewsV) {
  if (n.origin === 'LIVE') { const src = esc(n.source || 'wire'), tm = realTime(n.at); return `<span class="src">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${src}</a>` : src}${tm ? ' · ' + tm : ''}</span>`; }
  if (n.by) return `<span class="src">${esc(n.by)}</span>`;
  return '';
}
let lastWireTop = 0;
function renderWire() {
  $('#wire').innerHTML = G.wire.slice(0, 40).map(n => n.kind === 'sys'
    ? `<li class="sys"><span class="tm">${n.time.slice(0, 5)}</span><span class="hl">${esc(n.text)}</span><span></span></li>`
    : `<li><span class="tm">${n.time.slice(0, 5)}</span><span class="hl">${n.no ? `<span class="no">${n.no}</span>` : ''}${origin(n)}${esc(n.text)}</span>${n.kind === 'check' ? '<span class="imp flat">floor check</span>' : impChip(n)}${n.read || meta(n) ? `<span class="rd">${meta(n)}${esc(n.read || '')}</span>` : ''}</li>`).join('');
  const top = G.wire.find(n => n.kind === 'news');
  if (top && top.id !== lastWireTop) { if (lastWireTop && top.impact == null) sfx.bell(); lastWireTop = top.id; }
}
$('#chips').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.chip'); if (b && !G.round.busy) send({ k: 'news', text: b.textContent!, deep: deep() }); });

// ---------- chart ----------
const cv = $<HTMLCanvasElement>('#chart'), cx = cv.getContext('2d')!;
let C: { up: string; down: string; grid: string; muted: string; amber: string; ink: string; fg: string; faint: string; ground: string; agent: Record<string, string> } | null = null;
function colors() { C = { up: css('--up'), down: css('--down'), grid: css('--line'), muted: css('--muted'), amber: css('--amber'), ink: css('--amber-ink'), fg: css('--fg'), faint: css('--faint'), ground: css('--ground'), agent: Object.fromEntries(G.agents.map(a => [a.id, css('--a-' + a.id)])) }; }
let chartQueued = false;
function scheduleChart() { if (chartQueued) return; chartQueued = true; requestAnimationFrame(() => { chartQueued = false; drawChart(); }); }
function drawChart() {
  if (!C) colors();
  const Cc = C!;
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, W = r.width, H = r.height;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, W, H);
  const padR = 58, padT = 14, padB = 6, volH = Math.round(H * 0.15);
  const n = Math.max(30, Math.floor((W - padR) / 8));
  const cs = G.candles.slice(-n);
  if (!cs.length) return;
  const plotH = H - padT - volH - padB - 8;
  let lo = Infinity, hi = -Infinity, vmax = 1;
  cs.forEach(c => { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v); });
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const y = (p: number) => padT + (hi - p) / (hi - lo) * plotH;
  const cw = (W - padR) / n, x0 = (n - cs.length) * cw;
  const idx0 = cs[0].idx, curIdx = G.candles[G.candles.length - 1].idx;
  // halts
  G.halts.forEach(h => {
    const a = h.start - idx0, b = (h.end ?? curIdx) - idx0 + 1;
    if (b < 0 || a > cs.length) return;
    cx.fillStyle = Cc.amber; cx.globalAlpha = .1;
    cx.fillRect(x0 + Math.max(0, a) * cw, padT, (Math.min(cs.length, b) - Math.max(0, a)) * cw, plotH); cx.globalAlpha = 1;
  });
  // grid
  const span = hi - lo, raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw)!;
  cx.font = '500 11px "IBM Plex Mono", monospace'; cx.textBaseline = 'middle';
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(y(p)) + .5;
    cx.strokeStyle = Cc.grid; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(0, yy); cx.lineTo(W - padR, yy); cx.stroke();
    cx.fillStyle = Cc.muted; cx.fillText(f2(p), W - padR + 8, yy);
  }
  // candles + volume
  const bw = Math.max(1, cw * 0.62);
  cs.forEach((c, i) => {
    const xc = x0 + i * cw + cw / 2, col = c.c >= c.o ? Cc.up : Cc.down;
    cx.strokeStyle = col; cx.fillStyle = col;
    cx.beginPath(); cx.moveTo(Math.round(xc) + .5, y(c.h)); cx.lineTo(Math.round(xc) + .5, y(c.l)); cx.stroke();
    const top = y(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    cx.fillRect(xc - bw / 2, top, bw, bh);
    const vh = c.v / vmax * volH; cx.globalAlpha = .35; cx.fillRect(xc - bw / 2, H - padB - vh, bw, vh); cx.globalAlpha = 1;
  });
  // headline markers
  G.markers.forEach(m => {
    const i = m.idx - idx0; if (i < 0 || i >= cs.length) return;
    const xc = Math.round(x0 + i * cw + cw / 2) + .5;
    cx.strokeStyle = Cc.amber; cx.setLineDash([3, 3]); cx.beginPath(); cx.moveTo(xc, padT + 14); cx.lineTo(xc, padT + plotH); cx.stroke(); cx.setLineDash([]);
    cx.fillStyle = Cc.amber; const lab = String(m.no), tw = cx.measureText(lab).width + 8;
    cx.fillRect(xc - tw / 2, padT - 2, tw, 15); cx.fillStyle = Cc.ink; cx.textAlign = 'center'; cx.fillText(lab, xc, padT + 6); cx.textAlign = 'left';
  });
  // fills: triangles in the trader's or player's colour (up = bought, down = sold)
  G.fills.forEach(f => {
    const i = f.idx - idx0; if (i < 0 || i >= cs.length) return;
    const col = Cc.agent[f.owner] || G.players.find(p => p.id === f.owner)?.color; if (!col) return;
    const xc = x0 + i * cw + cw / 2, yy = y(f.px), s = 6, dir = f.side === 'buy' ? 1 : -1;
    cx.fillStyle = col; cx.strokeStyle = Cc.ground; cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(xc, yy - dir * s); cx.lineTo(xc - s, yy + dir * s * .7); cx.lineTo(xc + s, yy + dir * s * .7); cx.closePath(); cx.stroke(); cx.fill();
  });
  cx.lineWidth = 1;
  // last price tag
  const ly = Math.round(y(G.last)) + .5, lc = G.last >= G.open ? Cc.up : Cc.down;
  cx.strokeStyle = lc; cx.setLineDash([2, 3]); cx.beginPath(); cx.moveTo(0, ly); cx.lineTo(W - padR, ly); cx.stroke(); cx.setLineDash([]);
  cx.fillStyle = lc; cx.fillRect(W - padR + 2, ly - 9, padR - 4, 18);
  cx.fillStyle = Cc.ink; cx.font = '600 11px "IBM Plex Mono", monospace'; cx.fillText(f2(G.last), W - padR + 7, ly + 1);
}
addEventListener('resize', drawChart);
document.fonts?.ready.then(drawChart);

// ---------- book & tape ----------
function renderBook() {
  const d = G.book, mx = Math.max(1, ...d.bids.map(l => l[1]), ...d.asks.map(l => l[1]));
  const row = (l: LevelV, side: string) => `<div class="lvl ${side}"><span class="bar" style="width:${(l[1] / mx * 100).toFixed(1)}%"></span><span class="who">${l[2].filter(o => NAMES[o]).map(o => `<i style="background:${NAMES[o].c}" title="${esc(NAMES[o].name)}"></i>`).join('')}</span><span class="p">${f2(l[0])}</span><span>${fi(l[1])}</span></div>`;
  const ba = d.asks[0]?.[0], bb = d.bids[0]?.[0];
  $('#book').innerHTML = `<div class="colh"><span></span><span>Price</span><span>Size</span></div>` +
    (G.halted ? `<div class="spread"><span>Book cleared · halted</span></div>` :
      d.asks.slice().reverse().map(l => row(l, 'ask')).join('') +
      `<div class="spread"><span>Spread ${ba && bb ? f2(ba - bb) : '-'}</span><span>Mid ${ba && bb ? f2((ba + bb) / 2) : '-'}</span></div>` +
      d.bids.map(l => row(l, 'bid')).join(''));
}
function renderTape() {
  $('#tape').innerHTML = G.trades.slice(0, 18).map(t => {
    const b = NAMES[t.buyer], s = NAMES[t.seller];
    const who = b ? `${b.name} bought` : s ? `${s.name} sold` : '';
    const wc = b?.c || s?.c || '';
    return `<li class="${t.q >= 1000 ? 'big' : ''}"><span class="tt">${clock(t.t)}</span><span class="${t.aggr === 'buy' ? 'up' : 'down'}">${f2(t.price)}</span><span class="q">${fi(t.q)}</span><span class="who" style="color:${wc}">${esc(who)}</span></li>`;
  }).join('');
}

// ---------- header, standings, you ----------
function renderTop() {
  const ch = G.last - G.open;
  $('#px').textContent = f2(G.last); $('#px').className = 'px num ' + sgn(ch);
  $('#chg').textContent = `${ch >= 0 ? '+' : '−'}${f2(Math.abs(ch))} (${ch >= 0 ? '+' : '−'}${f2(Math.abs(ch / G.open * 100))}%)`;
  $('#chg').className = 'chg ' + sgn(ch);
  $('#sClock').textContent = G.clock; $('#sOpen').textContent = f2(G.open);
  $('#sHigh').textContent = f2(G.hi); $('#sLow').textContent = f2(G.lo);
  $('#sVwap').textContent = G.vwap ? f2(G.vwap) : '-';
  $('#sVol').textContent = G.vol > 1e6 ? (G.vol / 1e6).toFixed(2) + 'M' : fi(G.vol);
  const m = $('#mkt');
  if (G.halted) { m.className = 'pill halt'; m.lastChild!.textContent = 'Halted'; }
  else if (G.room?.speed === 0) { m.className = 'pill halt'; m.lastChild!.textContent = 'Paused'; }
  else { m.className = 'pill live'; m.lastChild!.textContent = 'Market open'; }
}
function renderStand() {
  if (!G.agents.length) return;
  const rows = [...G.agents.map(a => ({ id: a.id, name: a.name, c: `var(--a-${a.id})`, me: false, away: false })),
    ...G.players.map(p => ({ id: p.id, name: p.id === G.me?.id ? `You (${p.name})` : p.name, c: p.color, me: p.id === G.me?.id, away: !p.online }))]
    .map(r => ({ ...r, p: pnl(r.id) })).sort((a, b) => b.p - a.p);
  $('#stand').innerHTML = rows.map((r, i) => `<li class="${r.me ? 'me' : ''}${r.away ? ' away' : ''}" style="--c:${r.c}"><span class="rk">${i + 1}</span><i></i><span>${esc(r.name)}</span><span class="${sgn(r.p)}">${money(r.p)}</span></li>`).join('');
  G.agents.forEach(a => {
    const el = card(a.id); if (!el) return; const p = pnl(a.id);
    const pe = el.querySelector('[data-pnl]')!; pe.textContent = money(p); pe.className = 'pnl num ' + sgn(p);
    el.querySelector('[data-pos]')!.textContent = `${fi(G.acc[a.id]?.[1] ?? 0)} sh`;
  });
  const me = G.me && G.acc[G.me.id];
  if (me) {
    const yp = pnl(G.me!.id);
    $('#yPos').textContent = fi(me[1]); $('#yAvg').textContent = me[1] ? f2(Math.abs(me[3] / me[1])) : '-';
    $('#yPnl').textContent = money(yp); $('#yPnl').className = sgn(yp);
  }
  if (open) paintDrawerLive();
}
function renderPlayers() {
  const on = G.players.filter(p => p.online).length;
  $('#whoLbl').textContent = `${on} on the floor`;
  $('#who').title = G.players.map(p => `${p.name}${p.host ? ' (host)' : ''}${p.online ? '' : ' (away)'}`).join(', ');
  if (G.room) applyRoom(G.room);
}

// ---------- newsroom state ----------
function setBusyUI(b: boolean) {
  ['#breakBtn', '#surpriseBtn', '#checkBtn', '#wrapBtn'].forEach(s => { ($(s) as HTMLButtonElement).disabled = b; });
  $('#chips').querySelectorAll('button').forEach(x => { (x as HTMLButtonElement).disabled = b; });
}
function setRound(r: RoundState) {
  G.round = r;
  setBusyUI(r.busy);
  const st = $('#status');
  st.classList.toggle('busy', r.busy);
  if (r.busy) st.innerHTML = `${esc(r.status || 'Round in flight…')}${r.by ? ` <span class="by">· triggered by ${esc(r.by)}</span>` : ''}`;
  else st.textContent = r.note || '';
  if (!r.busy) G.agents.forEach(a => { if (a.thinking) { a.thinking = null; paintAgent(a); } });
}
function shake(dir: 'up' | 'down') { document.body.classList.remove('shake-up', 'shake-down'); void document.body.offsetWidth; document.body.classList.add(dir === 'up' ? 'shake-up' : 'shake-down'); }

function addChatter(o: ChatterV, live: boolean) {
  const a = NAMES[o.id], b = NAMES[o.to]; if (!a || !o.line) return;
  const box = $('#chatter'); box.hidden = false;
  const li = document.createElement('li');
  li.innerHTML = `<b style="color:${a.c}">${esc(a.name)}</b>${b ? `<span class="to">to <b style="color:${b.c}">${esc(b.name)}</b></span>` : ''}<span class="ln"></span>`;
  box.prepend(li); while (box.children.length > 4) box.lastChild!.remove();
  const ln = li.querySelector('.ln') as HTMLElement;
  if (live) { typeInto(ln, String(o.line).slice(0, 200)); sfx.chat(); } else ln.textContent = o.line;
}

// ---------- sound (off until the viewer turns it on) ----------
const sfx = (() => {
  let ac: AudioContext | null = null, on = false;
  const tone = (f: number, t: number, dur: number, type: OscillatorType = 'sine', vol = .12, f2v: number | null = null) => {
    if (!on || !ac) return; const o = ac.createOscillator(), g = ac.createGain(), t0 = ac.currentTime + t;
    o.type = type; o.frequency.setValueAtTime(f, t0); if (f2v) o.frequency.exponentialRampToValueAtTime(f2v, t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g).connect(ac.destination); o.start(t0); o.stop(t0 + dur + .05);
  };
  return {
    toggle() { on = !on; if (on && !ac) { try { ac = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); } catch { on = false; } } void ac?.resume?.(); return on; },
    bell() { [0, .18, .36].forEach(t => { tone(1318, t, .9, 'sine', .09); tone(2637, t, .5, 'sine', .03); }); },
    halt() { tone(220, 0, .5, 'square', .05, 110); tone(220, .55, .5, 'square', .05, 110); },
    fill(side: string) { tone(side === 'buy' ? 880 : 440, 0, .12, 'triangle', .07); },
    chat() { tone(1600, 0, .05, 'sine', .03); },
  };
})();
$('#soundBtn').onclick = () => { const on = sfx.toggle(); $('#soundBtn').textContent = on ? 'Sound on' : 'Sound off'; $('#soundBtn').setAttribute('aria-pressed', String(on)); if (on) sfx.chat(); };

// ---------- controls ----------
const deep = () => $<HTMLInputElement>('#deep').checked;
$('#speed').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null; if (!b || b.disabled) return; send({ k: 'host', action: 'speed', value: +b.dataset.s! }); });
$('#resetBtn').onclick = () => { if (confirm('Reset the room? Everyone goes back to $1M and the price restarts. AI lessons are kept.')) send({ k: 'host', action: 'reset' }); };
$('#roomBtn').onclick = async () => {
  if (!G.room) return;
  const link = `${location.origin}/r/${G.room.code}`;
  const text = `Trade against six AI traders with me on The Pit (${G.room.ticker}). Room ${G.room.code}`;
  try {
    if (navigator.share && matchMedia('(pointer:coarse)').matches) { await navigator.share({ title: 'The Pit', text, url: link }); return; }
    await navigator.clipboard.writeText(link);
    $('#roomLbl').textContent = 'Link copied'; setTimeout(() => { if (G.room) $('#roomLbl').textContent = `Room ${G.room.code} · invite`; }, 1800);
  } catch { prompt('Send this link to a friend:', link); }
};
$('#newsForm').addEventListener('submit', e => { e.preventDefault(); const inp = $<HTMLInputElement>('#headline'); const v = inp.value; if (!v.trim()) { inp.focus(); return; } if (G.round.busy) return; inp.value = ''; send({ k: 'news', text: v, deep: deep() }); });
$('#checkBtn').onclick = () => send({ k: 'check', deep: deep() });
$('#surpriseBtn').onclick = () => send({ k: 'surprise', deep: deep() });
$('#wrapBtn').onclick = () => { $('#wrap').hidden = false; $('#wrapText').textContent = 'Writing…'; $<HTMLButtonElement>('#wrapBtn').disabled = true; send({ k: 'wrap' }); };

let size = 500;
$('#sizes').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b) return; size = +b.dataset.q!; $('#sizes').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
$('#buyBtn').onclick = () => send({ k: 'order', side: 'buy', qty: size });
$('#sellBtn').onclick = () => send({ k: 'order', side: 'sell', qty: size });
$('#flatBtn').onclick = () => send({ k: 'flatten' });

function onStream(m: ServerMsg & { k: 'stream' }) {
  if (m.kind === 'wrap') {
    const box = $('#wrap'), out = $('#wrapText'); box.hidden = false;
    out.textContent = m.text;
    if (m.done) { $<HTMLButtonElement>('#wrapBtn').disabled = G.round.busy; if (m.error) { $('#status').textContent = m.error; if (!m.text) box.hidden = true; } }
  } else {
    const out = $('#answer');
    out.textContent = m.done && m.error ? (m.text ? m.text + '\n\n' : '') + m.error : m.text;
    if (m.done) $<HTMLButtonElement>('#askBtn').disabled = !G.room?.ai.on;
  }
}

// ---------- trader drawer ----------
let open: AgentV | null = null;
function paintDrawerLive() {
  if (!open) return; const ac = G.acc[open.id], p = pnl(open.id); if (!ac) return;
  $('#dPos').textContent = fi(ac[1]) + ' sh'; $('#dCash').textContent = '$' + fi(ac[0]);
  $('#dPnl').textContent = money(p); $('#dPnl').className = sgn(p);
}
function paintDrawer() {
  if (!open) return;
  const a = G.agents.find(x => x.id === open!.id)!; open = a;
  $('#drawer').style.setProperty('--c', `var(--a-${a.id})`);
  $('#dName').textContent = a.name; $('#dVoice').textContent = `${a.tag}. ${a.voice}`;
  paintDrawerLive();
  $('#dLessons').innerHTML = a.lessons.length ? a.lessons.map(l => `<li>${esc(l)}</li>`).join('') : '<li class="none">None yet. They write one after seeing how a call worked out.</li>';
  $('#dHist').innerHTML = a.log.slice(0, 12).map(l => `<li><span class="hh">${l.time} · ${esc(l.head)} · ${esc(l.act)}</span><span>${esc(l.thought)}</span></li>`).join('');
  const on = !!G.room?.ai.on;
  $<HTMLInputElement>('#askInput').placeholder = on ? `Ask ${a.name} anything…` : 'Needs Claude, which is not connected here';
  $<HTMLButtonElement>('#askBtn').disabled = !on;
}
function openDrawer(id: string) {
  open = G.agents.find(a => a.id === id) ?? null; if (!open) return;
  $('#answer').textContent = ''; paintDrawer();
  $('#drawer').hidden = false; $('#scrim').hidden = false; $<HTMLInputElement>('#askInput').focus();
}
function closeDrawer() { open = null; $('#drawer').hidden = true; $('#scrim').hidden = true; }
$('#dClose').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
addEventListener('keydown', e => { if (e.key === 'Escape' && open) closeDrawer(); });
$('#askForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $<HTMLInputElement>('#askInput'), q = inp.value.trim(); if (!q || !open || !G.room?.ai.on) return;
  inp.value = ''; $('#answer').textContent = 'Thinking…'; $<HTMLButtonElement>('#askBtn').disabled = true;
  send({ k: 'ask', id: open.id, q });
});
