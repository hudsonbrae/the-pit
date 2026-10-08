// The Pit — browser client. Renders server state; never runs its own engine.
// Render code (chart, book, tape, floor, wire, drawer, sound) is ported from the
// original ui.js; everything new (intel strip, storyline, signals, calls, records,
// debate, host lab, scenarios, recap, dock, stage, spectators) renders state the
// server computed. Every action is an intent sent to the server.

import './style.css';
import { f2, fi, money, sgn, esc } from '../../shared/format';
import type {
  AccV, AgentV, CandleV, ChatterV, ClientMsg, FillV, HaltV, IntelV, LevelV, MarkerV, NewsV, PlayerV, RecapV, RoomInfo, RoundState, ServerMsg, Snapshot,
  StoryV, TradeV, TraderStatsV, ScienceV,
} from '../../shared/protocol';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const DT = 0.25;
const clock = (t: number) => { const s = 9 * 3600 + 30 * 60 + Math.floor(t * DT); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
const store = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const coarse = matchMedia('(pointer:coarse)').matches;
const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* unsupported */ } };

// ---------- identity ----------
let token = store.get('pit.token');
if (!token) { token = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('pit.token', token); }
const TOKEN = token;

// ---------- client state (a mirror of the server's room) ----------
const G = {
  room: null as RoomInfo | null, me: null as PlayerV | null, watching: false,
  t: 0, clock: '09:30:00', last: 100, open: 100, hi: 100, lo: 100, vwap: null as number | null, vol: 0, halted: 0,
  candles: [] as CandleV[], trades: [] as TradeV[], book: { bids: [] as LevelV[], asks: [] as LevelV[] }, acc: {} as Record<string, AccV>,
  halts: [] as HaltV[], fills: [] as FillV[], markers: [] as MarkerV[],
  agents: [] as AgentV[], players: [] as PlayerV[], wire: [] as NewsV[], round: { busy: false } as RoundState,
  stories: [] as StoryV[], stats: {} as Record<string, TraderStatsV>, oracle: null as string | null, intel: null as IntelV | null,
  science: null as ScienceV | null,
};
type Who = { id: string; name: string; c: string; ai: boolean };
let NAMES: Record<string, Who> = {};
function rebuildNames() {
  NAMES = {};
  G.agents.forEach(a => { NAMES[a.id] = { id: a.id, name: a.name, c: `var(--a-${a.id})`, ai: true }; });
  G.players.forEach(p => { NAMES[p.id] = { id: p.id, name: p.id === G.me?.id ? 'You' : p.name, c: p.color, ai: false }; });
}
const pnl = (id: string) => { const a = G.acc[id]; return a ? a[0] + a[1] * G.last - a[2] : 0; };
const isHost = () => !!G.me && G.me.id === G.room?.hostId;

// ---------- routing: lobby, join card, or game ----------
const path = location.pathname.match(/^\/r\/([A-Za-z]{5})\/?$/);
const params = new URLSearchParams(location.search);
const CODE = (path?.[1] ?? params.get('room') ?? '').toUpperCase();
const WATCH = params.get('watch') === '1';
if (params.get('stage') === '1') document.body.classList.add('stage');

function show(id: 'lobby' | 'joinCard' | 'game') { ['lobby', 'joinCard', 'game'].forEach(x => { $(`#${x}`).hidden = x !== id; }); $('#dock').hidden = id !== 'game'; }

async function createRoom(body: Record<string, unknown>, st: HTMLElement, btn: HTMLButtonElement, name: string) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token: TOKEN }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Could not open a room.');
    history.replaceState(null, '', `/r/${j.code}`);
    startGame(j.code, name, false);
  } catch (err) {
    st.className = 'status err'; st.textContent = (err as Error).message || 'Could not reach the server.';
    btn.disabled = false;
  }
}

function lobby() {
  show('lobby');
  const nameIn = $<HTMLInputElement>('#nameIn'); nameIn.value = store.get('pit.name') ?? '';
  let mode: 'sim' | 'real' = 'sim';
  $('#modeSeg').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    mode = b.dataset.m as 'sim' | 'real';
    $('#modeSeg').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    $('#tickerFld').hidden = mode !== 'real';
    $('#modeHint').textContent = mode === 'real' ? 'A real US stock. Real quotes anchor the price; real headlines arrive on their own and the floor debates them.' : 'Fictional Halcyon Dynamics. Write any headline, or run a scenario, and watch the floor react.';
  });
  const st = $('#lobbyStatus');
  $('#createForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    store.set('pit.name', name);
    const ticker = $<HTMLInputElement>('#tickerIn').value.trim().toUpperCase();
    if (mode === 'real' && !ticker) { $<HTMLInputElement>('#tickerIn').focus(); return; }
    st.className = 'status busy'; st.textContent = mode === 'real' ? `Looking up ${ticker} and warming up the floor…` : 'Warming up the floor…';
    void createRoom({ mode, ticker }, st, $<HTMLButtonElement>('#createBtn'), name);
  });
  $('#demoBtn').addEventListener('click', () => {
    const name = nameIn.value.trim() || store.get('pit.name') || 'Host';
    store.set('pit.name', name);
    st.className = 'status busy'; st.textContent = 'Setting the stage…';
    void createRoom({ mode: 'sim', scenario: 'demo' }, st, $<HTMLButtonElement>('#demoBtn'), name);
  });
  const code = () => { const c = $<HTMLInputElement>('#codeIn').value.trim().toUpperCase(); if (!/^[A-Z]{5}$/.test(c)) { st.className = 'status err'; st.textContent = 'Room codes are 5 letters.'; return null; } return c; };
  $('#joinForm').addEventListener('submit', e => { e.preventDefault(); const c = code(); if (c) location.href = `/r/${c}`; });
  $('#watchBtn').addEventListener('click', () => { const c = code(); if (c) location.href = `/r/${c}?watch=1`; });
}

async function enter(code: string) {
  if (WATCH) return startGame(code, '', true);
  const name = store.get('pit.name');
  if (name) return startGame(code, name, false);
  show('joinCard');
  try {
    const r = await fetch(`/api/rooms/${code}`); const j = await r.json();
    $('#joinWhat').textContent = r.ok ? `Room ${j.code} · ${j.ticker} · ${j.mode === 'real' ? 'Real market' : 'Sim'}` : (j.error || 'Room not found');
  } catch { /* offline: the socket will report */ }
  $('#nameForm').addEventListener('submit', e => {
    e.preventDefault();
    const n = $<HTMLInputElement>('#nameIn2').value.trim(); if (!n) return;
    store.set('pit.name', n); startGame(code, n, false);
  });
}

// ---------- socket ----------
let ws: WebSocket | null = null;
let retry = 0, fatal = false, joinedOnce = false;
function send(m: ClientMsg) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

function startGame(code: string, name: string, watch: boolean) {
  show('game');
  G.watching = watch;
  document.body.classList.toggle('watching', watch);
  $('#watchPill').hidden = !watch;
  if (watch) $('#dock').hidden = true;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 0; send({ k: 'join', room: code, token: TOKEN, name, watch }); };
    ws.onmessage = ev => { try { onMsg(JSON.parse(ev.data)); } catch (e) { console.error(e); } };
    ws.onclose = () => {
      if (fatal) return;
      const m = $('#mkt'); m.className = 'pill halt'; m.lastChild!.textContent = 'Reconnecting…';
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  };
  connect();
}

// ---------- messages ----------
function onMsg(m: ServerMsg) {
  switch (m.k) {
    case 'hello': G.me = m.you; joinedOnce = true; applyRoom(m.room); applySnap(m.snap); break;
    case 'reset': applySnap(m.snap); $('#chatter').innerHTML = ''; $('#chatter').hidden = true; $('#wrap').hidden = true; $('#recap').hidden = true; $('#toast').textContent = 'New session. Everyone is back to $1M; the traders keep their memories.'; break;
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
    case 'thinking': G.agents.forEach(a => { a.thinking = m.text; paintAgent(a); }); break;
    case 'chatter': addChatter(m.c, true); break;
    case 'round': setRound(m.r); if (m.shake) shake(m.shake); break;
    case 'players': { G.players = m.players; const me = m.players.find(p => p.id === G.me?.id); if (me) G.me = me; rebuildNames(); renderPlayers(); renderStand(); break; }
    case 'room': applyRoom(m.room); break;
    case 'toast': if (m.text) { if (m.area === 'news') { const st = $('#status'); st.textContent = m.text; st.classList.remove('busy'); } else { $('#toast').textContent = m.text; if (coarse && /^(Bought|Sold)/.test(m.text)) buzz(15); } } break;
    case 'stream': onStream(m); break;
    case 'story': addStory(m.s, true); break;
    case 'stats': {
      const prev = G.stats; G.stats = m.stats; G.oracle = m.oracle; G.science = m.science; renderScience();
      G.agents.forEach(a => { const p = prev[a.id], n = m.stats[a.id]; if (p && n && n.calls > p.calls) flashScored(a.id, n.correct > p.correct); paintRecord(a); });
      if (open) paintDrawer();
      break;
    }
    case 'achievement': showAch(m.title, m.desc); break;
    case 'act': showAct(m.title, m.sub); break;
    case 'recap': showRecap(m.recap); break;
    case 'err':
      fatal = true; ws?.close();
      if (!joinedOnce) { show('joinCard'); $('#joinWhat').textContent = m.text; $('#nameForm').hidden = true; const a = document.createElement('a'); a.href = '/'; a.className = 'btn primary'; a.textContent = 'Back to the lobby'; a.style.textAlign = 'center'; a.style.textDecoration = 'none'; $('#joinStatus').replaceChildren(a); }
      else { $('#status').textContent = m.text; }
      break;
  }
}

let lastAct = '';
function applyRoom(r: RoomInfo) {
  const first = !G.room;
  G.room = r;
  const real = r.mode === 'real';
  $('#brandSub').textContent = real ? `${r.ticker} · ${r.company} · simulated exchange anchored to real price` : `${r.ticker} · ${r.company} · simulated exchange`;
  $('#chartTitle').textContent = r.ticker;
  $('#chart').setAttribute('aria-label', `Candlestick chart of ${r.ticker} price`);
  document.title = `${r.ticker} · The Pit`;
  $('#roomLbl').textContent = `Room ${r.code} · invite`;
  $('#stageUrl').textContent = `${location.host}/r/${r.code}`;
  $('#ai').className = 'pill ' + (r.ai.on ? 'ai' : 'off'); $('#ai').lastChild!.textContent = r.ai.label;
  const host = isHost();
  document.querySelectorAll<HTMLElement>('.hostonly').forEach(el => { el.hidden = !host; });
  $('#hostBtn').hidden = !host;
  $('#speed').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(+(b as HTMLElement).dataset.s! === r.speed)));
  $('#pauseBanner').hidden = r.speed !== 0 || r.session === 'closed';
  $('#pauseBanner').textContent = 'Paused by the host';
  if (r.session === 'closed') { $('#pauseBanner').hidden = false; $('#pauseBanner').textContent = 'Session closed'; }
  $('#realq').hidden = !real;
  const watchers = r.watchers ? ` · ${r.watchers} watching` : '';
  $('#whoLbl').textContent = `${G.players.filter(p => p.online).length} on the floor${watchers}`;
  if (real && r.real) {
    $('#realPx').textContent = r.real.price != null ? f2(r.real.price) : '-';
    const closed = r.real.marketOpen === false;
    $('#realSub').textContent = closed ? 'US market closed · last real price' : 'live quote';
    $('#chartSub').textContent = `5-second candles · simulated exchange anchored to real price${closed ? ' · US market closed' : ''}`;
    $('#deskSub').textContent = `Real ${r.ticker} headlines arrive on their own (LIVE) and the floor debates them. Yours are PLAYER.`;
  }
  if (r.scenario?.act && r.scenario.act !== lastAct) lastAct = r.scenario.act;
  if (first) {
    $('#chips').innerHTML = r.presets.map(p => `<button class="chip" type="button">${esc(p)}</button>`).join('');
    setBusyUI(G.round.busy);
  }
  paintHost();
}

function applySnap(s: Snapshot) {
  Object.assign(G, { t: s.t, clock: s.clock, last: s.last, open: s.open, hi: s.hi, lo: s.lo, vwap: s.vwap, vol: s.vol, halted: s.halted, candles: s.candles, trades: s.trades, book: s.book, acc: s.acc, halts: s.halts, fills: s.fills, markers: s.markers, agents: s.agents, players: s.players, wire: s.wire, round: s.round, stats: s.stats, oracle: s.oracle, intel: s.intel, science: s.science });
  renderScience();
  rebuildNames();
  C = null;
  buildFloor();
  $('#chatter').innerHTML = ''; $('#chatter').hidden = true;
  s.chatter.slice().reverse().forEach(c => addChatter(c, false));
  G.stories = s.stories.slice();
  renderStories();
  setRound(s.round);
  $('#haltBanner').hidden = !s.halted;
  renderWire(); renderTop(); renderBook(); renderTape(); renderStand(); renderPlayers(); renderIntel(); drawChart();
}

let frame = 0, prevPx = 0;
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
    if (e.type === 'halt') { sfx.halt(); buzz([40, 30, 40]); $('#haltTitle').textContent = `Limit ${e.dir}`; $('#haltBanner').hidden = false; $('#actBanner').hidden = true; shake(e.dir); }
    else $('#haltBanner').hidden = true;
  }
  if (G.halted) $('#haltSub').textContent = `Circuit breaker · reopens in ${G.halted}s`;
  else if (!$('#haltBanner').hidden) $('#haltBanner').hidden = true;
  if (d.intel) { G.intel = d.intel; renderIntel(); }
  frame++;
  renderTop(); scheduleChart();
  if (frame % 2 === 0) { renderBook(); renderStand(); }
}

// ---------- intel strip ----------
let lastRegime = '';
const pc = $<HTMLCanvasElement>('#psych');
function renderIntel() {
  const v = G.intel; if (!v) return;
  const rg = $('.ic.regime');
  if (v.regime.name !== lastRegime) {
    if (lastRegime) { rg.classList.remove('changed'); void rg.offsetWidth; rg.classList.add('changed'); if (['PANIC', 'EUPHORIA', 'LIQUIDITY CRUNCH'].includes(v.regime.name)) sfx.regime(); }
    lastRegime = v.regime.name;
  }
  rg.dataset.r = v.regime.name;
  $('#regime').textContent = v.regime.name;
  const secs = Math.max(0, Math.round((G.t - v.regime.since) * DT));
  $('#regimeSince').textContent = `for ${secs < 90 ? secs + 's' : Math.round(secs / 60) + ' min'} · vol ${v.stats.rv} bps/min`;
  $('#psychLbl').textContent = v.psych.label;
  const sp = v.psych.split;
  $('#split').textContent = sp.buy + sp.sell + sp.hold ? `AI floor: ${sp.buy} buy · ${sp.sell} sell · ${sp.hold} hold` : 'AI floor: no calls yet';
  drawPsych(v);
  const tot = v.book.buyV + v.book.sellV || 1;
  $('#flowB').style.width = (v.book.buyV / tot * 100) + '%'; $('#flowS').style.width = (v.book.sellV / tot * 100) + '%';
  $('#flowTxt').textContent = `buy ${fi(v.book.buyV)} · sell ${fi(v.book.sellV)} · spread ${v.book.spr} bps · depth ${fi(v.book.depth)}`;
  $('#sigs').innerHTML = (v.book.signals.length ? v.book.signals : ['BALANCED']).map(s => `<span class="${/AGGRESSIVE|SWEPT|THINNING|WALL|STACKED/.test(s) ? 'hot' : ''}">${esc(s)}</span>`).join('');
  const hr = v.teams.human, ar = v.teams.ai;
  $('#hRet').textContent = hr.n ? `${hr.ret >= 0 ? '+' : ''}${hr.ret.toFixed(2)}%` : '-'; $('#hRet').className = sgn(hr.ret);
  $('#aRet').textContent = `${ar.ret >= 0 ? '+' : ''}${ar.ret.toFixed(2)}%`; $('#aRet').className = sgn(ar.ret);
  const L = v.teams.leader;
  $('#leader').textContent = !hr.n ? 'no human trades yet' : L ? (L.human ? `${(L.id === G.me?.id ? 'YOU ARE' : L.name.toUpperCase() + ' IS')} #1` : `${L.name} leads · ${hr.ret > ar.ret ? 'humans ahead' : 'AI ahead'}`) : '-';
  if (v.smart) { const n = NAMES[v.smart.id]?.name ?? v.smart.id; $('#smart').textContent = `${n} ${v.smart.sh > 0 ? 'LONG' : v.smart.sh < 0 ? 'SHORT' : 'FLAT'}`; $('#smartSub').textContent = `${fi(Math.abs(v.smart.sh))} sh · the floor's oracle`; }
  else { $('#smart').textContent = '-'; $('#smartSub').textContent = 'needs 5+ scored calls'; }
}
function drawPsych(v: IntelV) {
  const dpr = window.devicePixelRatio || 1, S = 64;
  if (pc.width !== S * dpr) { pc.width = S * dpr; pc.height = S * dpr; }
  const x = pc.getContext('2d')!; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, S, S);
  x.strokeStyle = css('--line2'); x.lineWidth = 1;
  x.strokeRect(0.5, 0.5, S - 1, S - 1);
  x.beginPath(); x.moveTo(S / 2, 2); x.lineTo(S / 2, S - 2); x.moveTo(2, S / 2); x.lineTo(S - 2, S / 2); x.stroke();
  x.font = '600 7px "IBM Plex Mono", monospace'; x.fillStyle = css('--faint'); x.textAlign = 'center';
  x.fillText('GREED', S / 2, 9); x.fillText('FEAR', S / 2, S - 3); x.textAlign = 'left'; x.fillText('BEAR', 3, S / 2 - 3); x.textAlign = 'right'; x.fillText('BULL', S - 3, S / 2 - 3);
  const pt = ([b, g]: [number, number]) => [S / 2 + b * (S / 2 - 6), S / 2 - g * (S / 2 - 6)];
  const tr = v.psych.trail;
  tr.forEach((p, i) => { const [px, py] = pt(p); x.globalAlpha = 0.1 + 0.4 * i / tr.length; x.fillStyle = css('--amber'); x.fillRect(px - 1, py - 1, 2, 2); });
  x.globalAlpha = 1;
  const [px, py] = pt([v.psych.bull, v.psych.greed]);
  x.fillStyle = v.psych.greed < -0.4 ? css('--down') : v.psych.greed > 0.4 ? css('--up') : css('--amber');
  x.beginPath(); x.arc(px, py, 4, 0, Math.PI * 2); x.fill();
}

// ---------- floor ----------
const floor = $('#floor');
const card = (id: string) => floor.querySelector(`[data-id="${id}"]`) as HTMLElement;
const lsnLabel = (a: AgentV) => a.lessons.length ? `${a.lessons.length} lesson${a.lessons.length > 1 ? 's' : ''}` : '';
const SIG = [['news', 'News'], ['trend', 'Trend'], ['value', 'Value'], ['flow', 'Flow'], ['risk', 'Risk']] as const;
function buildFloor() {
  floor.innerHTML = G.agents.map(a => `
    <button class="agent" type="button" data-id="${a.id}" style="--c:var(--a-${a.id})">
      <div class="ah"><span class="dot"></span><b>${esc(a.name)}</b><span class="tag">${esc(a.tag)}</span><span class="pnl num" data-pnl></span></div>
      <div class="act" data-act></div>
      <div class="opening" data-open hidden></div>
      <p class="thought" data-th></p>
      <div class="sig" data-sig hidden></div>
      <div class="callrow" data-rec></div>
      <div class="meta"><span data-pos></span><span>conviction</span><span class="conv"><i data-conv></i></span><span class="lsn" data-lsn></span></div>
    </button>`).join('');
  G.agents.forEach(a => { paintAgent(a, false); paintRecord(a); });
}
function sigHtml(s: NonNullable<AgentV['signals']>) {
  return SIG.map(([k, l]) => {
    const v = s[k];
    const cells = [-2, -1, 1, 2].map(i => `<i class="${v < 0 && i < 0 && i >= v ? 'n' : v > 0 && i > 0 && i <= v ? 'p' : ''}"></i>`).join('');
    return `<div title="${l}: ${v > 0 ? '+' : ''}${v}"><span>${l}</span><span class="m">${cells}</span></div>`;
  }).join('');
}
function paintAgent(a: AgentV, flash?: boolean) {
  const el = card(a.id); if (!el) return;
  const th = el.querySelector('[data-th]') as HTMLElement & { _t?: number };
  if (a.thinking) { el.classList.add('thinking'); clearInterval(th._t); th.textContent = a.opening ? a.opening.thought : a.thinking; }
  else {
    el.classList.remove('thinking');
    if (flash) typeInto(th, a.thought); else { clearInterval(th._t); th.textContent = a.thought; }
  }
  (el.querySelector('[data-conv]') as HTMLElement).style.width = a.conv + '%';
  const act = el.querySelector('[data-act]')!;
  if (!a.lastAct) act.innerHTML = `<span class="side hold">No trades yet</span>`;
  else act.innerHTML = `<span class="side ${esc(a.lastAct.side)}">${esc(a.lastAct.label)}</span><span class="fill">${esc(a.lastAct.fill || '')}</span>`;
  const op = el.querySelector('[data-open]') as HTMLElement;
  if (a.opening) {
    op.hidden = false;
    op.innerHTML = `<span>OPENING VIEW: ${esc(a.opening.action.toUpperCase())} ${fi(a.opening.qty)} · ${a.opening.conviction}%</span>${a.changed ? `<span class="chg">CHANGED MIND: ${esc(a.changed.from)} → ${esc(a.changed.to)}</span>` : ''}`;
  } else op.hidden = true;
  const sg = el.querySelector('[data-sig]') as HTMLElement;
  if (a.signals) { sg.hidden = false; sg.innerHTML = sigHtml(a.signals); } else sg.hidden = true;
  if (!el.querySelector('.lsn.new')) el.querySelector('[data-lsn]')!.textContent = lsnLabel(a);
  paintRecord(a);
  if (flash) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
}
function badgeHtml(b: string) { const c = b === 'ORACLE' ? 'oracle' : b === 'HOT HAND' ? 'hot' : b === 'COLD' ? 'cold' : b === 'OVERCONFIDENT' ? 'over' : ''; return `<span class="badge ${c}">${esc(b)}</span>`; }
function paintRecord(a: AgentV) {
  const el = card(a.id); if (!el) return;
  const s = G.stats[a.id];
  el.classList.toggle('oracle', G.oracle === a.id);
  const call = a.call ? `<span class="call ${a.call}">CALLS ${a.call === 'up' ? '▲ UP' : a.call === 'down' ? '▼ DOWN' : '◆ FLAT'} · ${a.conv}%</span>` : '';
  const rec = s && s.calls ? `<span class="rec">${s.correct}/${s.calls} right <i>${s.recent.slice(0, 5).map(x => x ? '✓' : '✗').join('')}</i></span>` : '<span class="rec">unscored</span>';
  const bud = a.budget != null && a.budget < 6000 ? `<span class="rec budget">risk cut to ${fi(a.budget)}</span>` : '';
  el.querySelector('[data-rec]')!.innerHTML = call + rec + (s?.badges ?? []).map(badgeHtml).join('') + bud;
}
function flashScored(id: string, right: boolean) {
  const el = card(id); if (!el) return;
  if (right) { el.classList.remove('scored-right'); void el.offsetWidth; el.classList.add('scored-right'); }
}
floor.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.agent') as HTMLElement | null; if (b) openDrawer(b.dataset.id!); });

function typeInto(el: HTMLElement & { _t?: number }, text: string) {
  clearInterval(el._t); el.textContent = ''; let i = 0;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = text; return; }
  el._t = window.setInterval(() => { i += 2; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(el._t); }, 16);
}

// ---------- storyline: moments (weight 2+) or the full timeline ----------
let storyView: 'moments' | 'timeline' = store.get('pit.story') === 'timeline' ? 'timeline' : 'moments';
const storyShown = (s: StoryV) => storyView === 'timeline' || s.weight >= 2;
function storyLi(s: StoryV, live: boolean) {
  const li = document.createElement('li');
  li.className = `w${s.weight}${live ? ' new' : ''}`;
  li.innerHTML = `<span class="tm">${esc(s.clock)}</span><span class="tx">${s.title ? `<b class="st">${esc(s.title)}</b>` : ''}${esc(s.text)}</span>`;
  return li;
}
function renderStories() {
  const box = $('#story');
  const rows = G.stories.filter(storyShown).slice(0, 60);
  box.replaceChildren(...rows.map(s => storyLi(s, false)));
  if (!rows.length) box.innerHTML = `<li class="empty"><span class="tm"></span><span class="tx">${storyView === 'timeline' ? 'Every headline, desk read, decision, big trade, scored call and regime change lands here.' : 'Moments land here as they happen: big moves, splits, calls scored, mind changes, halts.'}</span></li>`;
  $('#storySub').textContent = storyView === 'timeline' ? 'everything, as it happens' : 'the moments that matter';
  $('#storyTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === storyView)));
}
function addStory(s: StoryV, live: boolean) {
  G.stories.unshift(s); if (G.stories.length > 160) G.stories.length = 160;
  if (!live || !storyShown(s)) return;
  const box = $('#story');
  box.querySelector('.empty')?.remove();
  box.prepend(storyLi(s, true)); while (box.children.length > 60) box.lastChild!.remove();
  if (s.weight >= 3) sfx.chat();
}
$('#storyTabs').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (!b?.dataset.v) return; storyView = b.dataset.v as typeof storyView; store.set('pit.story', storyView); renderStories(); });

// ---------- wire ----------
function impChip(n: NewsV) {
  if (n.impact == null) return `<span class="imp wait">${n.debate ? 'debating…' : 'reading…'}</span>`;
  const c = n.impact > 0.4 ? 'pos' : n.impact < -0.4 ? 'neg' : 'flat';
  return `<span class="imp ${c}">${n.impact > 0 ? '+' : ''}${(+n.impact).toFixed(1)}% fair value</span>`;
}
const realTime = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
function origin(n: NewsV) {
  const tags: string[] = [];
  if (n.origin === 'LIVE') tags.push(`<span class="org live">LIVE</span>`);
  else if (n.origin === 'AI' && n.kind === 'news') tags.push(`<span class="org ai">AI</span>`);
  else if (n.origin === 'SCENARIO' && n.kind === 'news') tags.push(`<span class="org scenario">SCENARIO</span>`);
  else if (n.origin === 'PLAYER' && n.kind === 'news') tags.push(`<span class="org player">PLAYER</span>`);
  if (n.deskKind && n.deskKind !== 'confirmed') tags.push(`<span class="org kind ${n.deskKind}">${n.deskKind.toUpperCase()}</span>`);
  if (n.debate) tags.push(`<span class="org deb">DEBATED</span>`);
  return tags.join('');
}
function meta(n: NewsV) {
  let s = '';
  if (n.moved != null) s += `<span class="mv ${sgn(n.moved)}">${n.moved > 0 ? '+' : ''}${n.moved.toFixed(2)}% in 60s</span>`;
  if (n.origin === 'LIVE') { const src = esc(n.source || 'wire'), tm = realTime(n.at); s += `<span class="src">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${src}</a>` : src}${tm ? ' · ' + tm : ''}</span>`; }
  else if (n.by) s += `<span class="src">${esc(n.by)}</span>`;
  return s;
}
let lastWireTop = 0;
function renderWire() {
  $('#wire').innerHTML = G.wire.slice(0, 40).map(n => n.kind === 'sys'
    ? `<li class="sys"><span class="tm">${esc(n.time.slice(0, 5))}</span><span class="hl">${esc(n.text)}</span><span></span></li>`
    : `<li><span class="tm">${esc(n.time.slice(0, 5))}</span><span class="hl">${n.no ? `<span class="no">${n.no}</span>` : ''}${origin(n)}${esc(n.text)}</span>${n.kind === 'check' ? '<span class="imp flat">floor check</span>' : impChip(n)}${n.read || meta(n) ? `<span class="rd">${meta(n)}${esc(n.read || '')}</span>` : ''}</li>`).join('');
  const top = G.wire.find(n => n.kind === 'news');
  if (top && top.id !== lastWireTop) { if (lastWireTop && top.impact == null) sfx.bell(); lastWireTop = top.id; }
}
$('#chips').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.chip'); if (b && !G.round.busy) send({ k: 'news', text: b.textContent!, deep: deep(), debate: debateOn() }); });

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
  const padR = W < 500 ? 50 : 58, padT = 14, padB = 6, volH = Math.round(H * 0.15);
  const n = Math.max(24, Math.floor((W - padR) / (W < 500 ? 11 : 8)));
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
  // grid (labels skip the last-price tag so they never collide)
  const ly0 = y(G.last);
  const span = hi - lo, raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw)!;
  cx.font = '500 11px "IBM Plex Mono", monospace'; cx.textBaseline = 'middle';
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const yy = Math.round(y(p)) + .5;
    cx.strokeStyle = Cc.grid; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(0, yy); cx.lineTo(W - padR, yy); cx.stroke();
    if (Math.abs(yy - ly0) > 12) { cx.fillStyle = Cc.muted; cx.fillText(f2(p), W - padR + 8, yy); }
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
  // fills: triangles in the trader's or player's colour (up = bought, down = sold); fan out when they stack
  const perCandle = new Map<number, number>();
  G.fills.forEach(f => {
    const i = f.idx - idx0; if (i < 0 || i >= cs.length) return;
    const col = Cc.agent[f.owner] || G.players.find(p => p.id === f.owner)?.color; if (!col) return;
    const k = perCandle.get(i) ?? 0; perCandle.set(i, k + 1);
    const off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 5;
    const xc = x0 + i * cw + cw / 2 + off, yy = y(f.px), s = 6, dir = f.side === 'buy' ? 1 : -1;
    cx.fillStyle = col; cx.strokeStyle = Cc.ground; cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(xc, yy - dir * s); cx.lineTo(xc - s, yy + dir * s * .7); cx.lineTo(xc + s, yy + dir * s * .7); cx.closePath(); cx.stroke(); cx.fill();
  });
  cx.lineWidth = 1;
  // last price tag
  const ly = Math.round(ly0) + .5, lc = G.last >= G.open ? Cc.up : Cc.down;
  cx.strokeStyle = lc; cx.setLineDash([2, 3]); cx.beginPath(); cx.moveTo(0, ly); cx.lineTo(W - padR, ly); cx.stroke(); cx.setLineDash([]);
  cx.fillStyle = lc; cx.fillRect(W - padR + 2, ly - 9, padR - 4, 18);
  cx.fillStyle = Cc.ink; cx.font = '600 11px "IBM Plex Mono", monospace'; cx.fillText(f2(G.last), W - padR + 7, ly + 1);
}
addEventListener('resize', () => drawChart());
document.fonts?.ready.then(() => drawChart());

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
    const who = b ? `${b.name} bought` : s ? `${s.name} sold` : t.buyer.startsWith('algo') || t.seller.startsWith('algo') ? 'program' : '';
    const wc = b?.c || s?.c || '';
    return `<li class="${t.q >= 1000 ? 'big' : ''}"><span class="tt">${clock(t.t)}</span><span class="${t.aggr === 'buy' ? 'up' : 'down'}">${f2(t.price)}</span><span class="q">${fi(t.q)}</span><span class="who" style="color:${wc}">${esc(who)}</span></li>`;
  }).join('');
}

// ---------- header, standings, you ----------
function renderTop() {
  const ch = G.last - G.open;
  const px = $('#px');
  px.textContent = f2(G.last);
  if (prevPx && Math.abs(G.last / prevPx - 1) > 0.004) { px.className = 'px num ' + sgn(ch); void px.offsetWidth; px.classList.add(G.last > prevPx ? 'flash-up' : 'flash-down'); prevPx = G.last; }
  else { px.className = 'px num ' + sgn(ch) + (px.classList.contains('flash-up') ? ' flash-up' : px.classList.contains('flash-down') ? ' flash-down' : ''); if (!prevPx || frame % 8 === 0) prevPx = G.last; }
  $('#chg').textContent = `${ch >= 0 ? '+' : '−'}${f2(Math.abs(ch))} (${ch >= 0 ? '+' : '−'}${f2(Math.abs(ch / G.open * 100))}%)`;
  $('#chg').className = 'chg ' + sgn(ch);
  $('#sClock').textContent = G.clock; $('#sOpen').textContent = f2(G.open);
  $('#sHigh').textContent = f2(G.hi); $('#sLow').textContent = f2(G.lo);
  $('#sVwap').textContent = G.vwap ? f2(G.vwap) : '-';
  $('#sVol').textContent = G.vol > 1e6 ? (G.vol / 1e6).toFixed(2) + 'M' : fi(G.vol);
  const m = $('#mkt');
  if (G.halted) { m.className = 'pill halt'; m.lastChild!.textContent = 'Halted'; }
  else if (G.room?.session === 'closed') { m.className = 'pill off'; m.lastChild!.textContent = 'Session closed'; }
  else if (G.room?.speed === 0) { m.className = 'pill halt'; m.lastChild!.textContent = 'Paused'; }
  else { m.className = 'pill live'; m.lastChild!.textContent = 'Exchange open'; }
  $('#dPx').textContent = f2(G.last);
}
let prevOrder: string[] = [];
function renderStand() {
  if (!G.agents.length) return;
  const rows = [...G.agents.map(a => ({ id: a.id, name: a.name, c: `var(--a-${a.id})`, me: false, away: false, badges: [] as string[] })),
    ...G.players.map(p => ({ id: p.id, name: p.id === G.me?.id ? `You (${p.name})` : p.name, c: p.color, me: p.id === G.me?.id, away: !p.online, badges: p.badges ?? [] }))]
    .map(r => ({ ...r, p: pnl(r.id) })).sort((a, b) => b.p - a.p);
  const order = rows.map(r => r.id);
  $('#stand').innerHTML = rows.map((r, i) => {
    const rose = prevOrder.length && prevOrder.indexOf(r.id) > i;
    const bd = r.id === G.oracle ? '<span class="bd">ORACLE</span>' : r.badges.length ? `<span class="bd">${r.badges.length}★</span>` : '';
    return `<li class="${r.me ? 'me' : ''}${r.away ? ' away' : ''}${rose ? ' rise' : ''}" style="--c:${r.c}"><span class="rk">${i + 1}</span><i></i><span>${esc(r.name)}${bd}</span><span class="${sgn(r.p)}">${money(r.p)}</span></li>`;
  }).join('');
  prevOrder = order;
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
    $('#dPos').textContent = `${fi(me[1])} sh`; $('#dPnl2').textContent = money(yp); $('#dPnl2').className = sgn(yp);
  }
  if (open) paintDrawerLive();
}
const ACH_TITLES: Record<string, string> = { first_blood: 'First Blood', perfect_timing: 'Perfect Timing', against_floor: 'Against the Floor', diamond_hands: 'Diamond Hands', ai_slayer: 'AI Slayer' };
function renderPlayers() {
  const on = G.players.filter(p => p.online).length;
  const w = G.room?.watchers ? ` · ${G.room.watchers} watching` : '';
  $('#whoLbl').textContent = `${on} on the floor${w}`;
  $('#who').title = G.players.map(p => `${p.name}${p.host ? ' (host)' : ''}${p.online ? '' : ' (away)'}`).join(', ');
  const mine = G.players.find(p => p.id === G.me?.id)?.badges ?? [];
  $('#myBadges').innerHTML = mine.map(b => `<span class="badge oracle" title="Achievement">${esc(ACH_TITLES[b] ?? b)}</span>`).join('');
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
  const rb = $('#ribbon');
  rb.hidden = !r.busy;
  if (r.busy) $('#ribbonTxt').textContent = `${r.phase === 'debate' ? 'FLOOR DEBATE' : 'AI ROUND'} · ${r.status ?? ''}${r.by ? ' · ' + r.by : ''}`;
  if (!r.busy) G.agents.forEach(a => { if (a.thinking) { a.thinking = null; paintAgent(a); } });
  clearTimeout(chatterTimer);
  if (!r.busy) chatterTimer = window.setTimeout(() => { $('#chatter').hidden = true; }, 25_000);   // the debate fades once it's history
}
let chatterTimer = 0;
function shake(dir: 'up' | 'down') { document.body.classList.remove('shake-up', 'shake-down'); void document.body.offsetWidth; document.body.classList.add(dir === 'up' ? 'shake-up' : 'shake-down'); }

function addChatter(o: ChatterV, live: boolean) {
  const a = NAMES[o.id], b = NAMES[o.to]; if (!a || !o.line) return;
  const box = $('#chatter'); box.hidden = false;
  const li = document.createElement('li');
  li.innerHTML = `<b style="color:${a.c}">${esc(a.name)}</b>${b ? `<span class="to">${o.kind === 'challenge' ? 'challenges' : 'to'} <b style="color:${b.c}">${esc(b.name)}</b></span>` : ''}<span class="ln"></span>`;
  box.prepend(li); while (box.children.length > 4) box.lastChild!.remove();
  const ln = li.querySelector('.ln') as HTMLElement;
  if (live) { typeInto(ln, String(o.line).slice(0, 200)); sfx.chat(); } else ln.textContent = o.line;
}

// ---------- overlays: acts, achievements, recap ----------
let actTimer = 0;
function showAct(title: string, sub: string) {
  const b = $('#actBanner'); b.hidden = true; void b.offsetWidth;
  if (!$('#haltBanner').hidden && !/HALT/.test(title)) return;      // the halt banner wins
  $('#actTitle').textContent = title; $('#actSub').textContent = sub; b.hidden = false;
  sfx.act();
  clearTimeout(actTimer); actTimer = window.setTimeout(() => { b.hidden = true; }, 4600);
}
let achTimer = 0;
function showAch(title: string, desc: string) {
  const b = $('#ach'); b.hidden = true; void b.offsetWidth;
  $('#achTitle').textContent = title; $('#achDesc').textContent = desc; b.hidden = false;
  sfx.ach(); buzz([20, 40, 20]);
  clearTimeout(achTimer); achTimer = window.setTimeout(() => { b.hidden = true; }, 4600);
}
function showRecap(r: RecapV) {
  const card = (k: string, v: string, p = '') => `<div class="rcard"><span>${esc(k)}</span><b>${v}</b>${p ? `<p>${p}</p>` : ''}</div>`;
  const chg = r.close / r.open - 1;
  const top = r.standings.map((s, i) => `${i + 1}. ${esc(s.name)}${s.human ? ' (human)' : ''} <span class="${sgn(s.pnl)}">${money(s.pnl)}</span>`).join('<br>');
  const humans = r.standings.some(s => s.human);
  const sat = r.humans.traded === 0;
  $('#recapBody').innerHTML = `<div class="rgrid">
    ${card(r.ticker, `${f2(r.close)} <small class="${sgn(chg)}">${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%</small>`, `open ${f2(r.open)} · high ${f2(r.hi)} · low ${f2(r.lo)} · ${fi(r.volume)} shares · ${r.halts} halt${r.halts === 1 ? '' : 's'}`)}
    ${card('Standings', '', top)}
    ${humans ? card('Humans vs AI', sat ? 'HUMANS SAT OUT' : r.humans.ret >= r.ai.ret ? 'HUMANS WIN' : 'AI WINS', sat ? `nobody traded · AI floor ${r.ai.ret >= 0 ? '+' : ''}${r.ai.ret.toFixed(2)}%` : `humans ${r.humans.ret >= 0 ? '+' : ''}${r.humans.ret.toFixed(2)}% · AI floor ${r.ai.ret >= 0 ? '+' : ''}${r.ai.ret.toFixed(2)}%`) : ''}
    ${r.mostAccurate ? card('Most accurate AI', esc(r.mostAccurate.name), `${r.mostAccurate.correct} of ${r.mostAccurate.calls} calls right`) : ''}
    ${r.biggestHeadline ? card('Biggest headline', r.biggestHeadline.moved != null ? `${r.biggestHeadline.moved > 0 ? '+' : ''}${r.biggestHeadline.moved.toFixed(1)}% in 60s` : `${r.biggestHeadline.impact > 0 ? '+' : ''}${r.biggestHeadline.impact.toFixed(1)}%`, esc(r.biggestHeadline.text) + ` · the desk called it ${r.biggestHeadline.impact > 0 ? '+' : ''}${r.biggestHeadline.impact.toFixed(1)}% to fair value`) : ''}
    ${r.biggestTrade ? card('Biggest trade', `${esc(r.biggestTrade.name)}`, `${r.biggestTrade.side === 'buy' ? 'bought' : 'sold'} ${fi(r.biggestTrade.qty)} @ ${f2(r.biggestTrade.price)}`) : ''}
    ${r.mostSplit ? card('Most controversial', 'SPLIT', esc(r.mostSplit)) : ''}
    ${card('Regimes', '', esc(r.regimes.join(' → ')))}
    ${r.bestCall ? card('Best call', esc(r.bestCall.name), `${r.bestCall.conviction}% sure of ${esc(r.bestCall.call.toUpperCase())} on “${esc(r.bestCall.head)}”: ${r.bestCall.ret > 0 ? '+' : ''}${r.bestCall.ret.toFixed(1)}% in 60s`) : ''}
    ${r.worstCall ? card('Worst call', esc(r.worstCall.name), `${r.worstCall.conviction}% sure of ${esc(r.worstCall.call.toUpperCase())} on “${esc(r.worstCall.head)}”: it went ${r.worstCall.ret > 0 ? '+' : ''}${r.worstCall.ret.toFixed(1)}%`) : ''}
    ${r.fastest ? card('Fastest reaction', esc(r.fastest.name), `traded ${r.fastest.secs}s after a headline`) : ''}
    ${r.science ? card('AI science', r.science.debate.open != null && r.science.debate.final != null && r.science.debate.n >= 6 ? `${r.science.debate.open}% → ${r.science.debate.final}%` : 'DEBATE?', esc(r.science.verdict)) : ''}
    ${r.achievements.length ? card('Achievements', '', r.achievements.map(a => `${esc(a.name)}: ${esc(a.title)}`).join('<br>')) : ''}
  </div>
  ${r.moments.length ? `<h3 class="sub">Moments</h3><ol class="story">${r.moments.map(s => `<li class="w${s.weight}"><span class="tm">${esc(s.clock)}</span><span class="tx">${s.title ? `<b class="st">${esc(s.title)}</b>` : ''}${esc(s.text)}</span></li>`).join('')}</ol>` : ''}`;
  $('#recapNarr').textContent = '';
  $('#rNew').hidden = !isHost();
  $('#recap').hidden = false;
  sfx.bell();
}
$('#rClose').onclick = () => { $('#recap').hidden = true; };
$('#rNew').onclick = () => { send({ k: 'host', action: 'reset' }); $('#recap').hidden = true; };

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
    act() { tone(196, 0, 1.2, 'sine', .08); tone(294, .05, 1.0, 'sine', .04); },
    regime() { tone(330, 0, .25, 'triangle', .05, 220); },
    ach() { [0, .1, .2].forEach((t, i) => tone(784 * (1 + i * .26), t, .3, 'triangle', .05)); },
  };
})();
$('#soundBtn').onclick = () => { const on = sfx.toggle(); $('#soundBtn').textContent = on ? 'Sound on' : 'Sound off'; $('#soundBtn').setAttribute('aria-pressed', String(on)); if (on) sfx.chat(); };
$('#stageBtn').onclick = () => { const on = document.body.classList.toggle('stage'); $('#stageBtn').setAttribute('aria-pressed', String(on)); setTimeout(drawChart, 50); };

// ---------- controls ----------
const deep = () => isHost() && $<HTMLInputElement>('#deep').checked;
const debateOn = () => $<HTMLInputElement>('#debateT').checked || undefined;
$('#speed').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null; if (!b || !isHost()) return; send({ k: 'host', action: 'speed', value: +b.dataset.s! }); });
async function share(link: string, label: HTMLElement, restore: string) {
  const text = `Trade against six AI traders with me on The Pit (${G.room?.ticker}). Room ${G.room?.code}`;
  try {
    if (navigator.share && coarse) { await navigator.share({ title: 'The Pit', text, url: link }); return; }
    await navigator.clipboard.writeText(link);
    label.textContent = 'Link copied'; setTimeout(() => { label.textContent = restore; }, 1800);
  } catch { prompt('Send this link to a friend:', link); }
}
$('#roomBtn').onclick = () => { if (G.room) void share(`${location.origin}/r/${G.room.code}`, $('#roomLbl'), `Room ${G.room.code} · invite`); };
$('#newsForm').addEventListener('submit', e => { e.preventDefault(); const inp = $<HTMLInputElement>('#headline'); const v = inp.value; if (!v.trim()) { inp.focus(); return; } if (G.round.busy) return; inp.value = ''; send({ k: 'news', text: v, deep: deep(), debate: debateOn() }); });
$('#checkBtn').onclick = () => send({ k: 'check', deep: deep() });
$('#surpriseBtn').onclick = () => send({ k: 'surprise', deep: deep(), debate: debateOn() });
$('#wrapBtn').onclick = () => { $('#wrap').hidden = false; $('#wrapText').textContent = 'Writing…'; $<HTMLButtonElement>('#wrapBtn').disabled = true; send({ k: 'wrap' }); };

const SIZES = [100, 500, 2000, 5000];
let size = 500;
function setSize(q: number) {
  size = q; $('#dSize').textContent = q >= 1000 ? `${q / 1000}k` : String(q);
  $('#sizes').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(+(x as HTMLElement).dataset.q! === q)));
}
$('#sizes').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (b) setSize(+b.dataset.q!); });
$('#dSize').onclick = () => setSize(SIZES[(SIZES.indexOf(size) + 1) % SIZES.length]);
const order = (side: 'buy' | 'sell') => send({ k: 'order', side, qty: size });
$('#buyBtn').onclick = () => order('buy'); $('#sellBtn').onclick = () => order('sell');
$('#dBuy').onclick = () => order('buy'); $('#dSell').onclick = () => order('sell');
$('#flatBtn').onclick = () => send({ k: 'flatten' });

function onStream(m: ServerMsg & { k: 'stream' }) {
  if (m.kind === 'wrap') {
    const box = $('#wrap'), out = $('#wrapText'); box.hidden = false;
    out.textContent = m.text;
    if (m.done) { $<HTMLButtonElement>('#wrapBtn').disabled = G.round.busy; if (m.error) { $('#status').textContent = m.error; if (!m.text) box.hidden = true; } }
  } else if (m.kind === 'recap') {
    $('#recapNarr').textContent = m.text;
  } else {
    const out = $('#answer');
    out.textContent = m.done && m.error ? (m.text ? m.text + '\n\n' : '') + m.error : m.text;
    if (m.done) $<HTMLButtonElement>('#askBtn').disabled = !G.room?.ai.on;
  }
}

// ---------- trader drawer: profile, record, calibration ----------
let open: AgentV | null = null;
function paintDrawerLive() {
  if (!open) return; const ac = G.acc[open.id], p = pnl(open.id); if (!ac) return;
  $('#dPosD').textContent = fi(ac[1]) + ' sh'; $('#dCash').textContent = '$' + fi(ac[0]);
  $('#dPnl').textContent = money(p); $('#dPnl').className = sgn(p);
}
function paintDrawer() {
  if (!open) return;
  const a = G.agents.find(x => x.id === open!.id)!; open = a;
  const s = G.stats[a.id];
  $('#drawer').style.setProperty('--c', `var(--a-${a.id})`);
  $('#dName').textContent = a.name; $('#dVoice').textContent = `${a.tag}. ${a.voice}`;
  $('#dStars').textContent = s?.stars ? '★'.repeat(s.stars) + '☆'.repeat(5 - s.stars) : '';
  paintDrawerLive();
  if (s && (s.calls || s.trades)) {
    const acc = s.calls ? Math.round(s.correct / s.calls * 100) : 0;
    $('#dRecord').innerHTML = `<div class="recgrid">
      <div class="stat"><span>Predictions right</span><b>${s.correct}/${s.calls}${s.calls ? ' · ' + acc + '%' : ''}</b></div>
      <div class="stat"><span>Trades in profit</span><b>${s.wins} of ${s.trades}</b></div>
      <div class="stat"><span>Avg conviction</span><b>${s.avgConv}%</b></div>
      <div class="stat"><span>Best trade</span><b class="up">${s.best && s.best.pnl > 0 ? money(s.best.pnl) : '-'}</b></div>
      <div class="stat"><span>Worst trade</span><b class="down">${s.worst && s.worst.pnl < 0 ? money(s.worst.pnl) : '-'}</b></div>
      <div class="stat"><span>Streak</span><b>${s.streak > 0 ? s.streak + ' right' : s.streak < 0 ? -s.streak + ' wrong' : '-'}</b></div>
      <div class="stat"><span>Return today</span><b class="${sgn(s.roi)}">${s.roi > 0 ? '+' : ''}${s.roi.toFixed(2)}%</b></div>
      <div class="stat"><span>Max drawdown</span><b class="${s.maxDD > 0 ? 'down' : ''}">${s.maxDD ? '−' + s.maxDD.toFixed(2) + '%' : '-'}</b></div>
      <div class="stat"><span>Return / drawdown</span><b>${s.maxDD >= 0.05 ? (s.roi / s.maxDD).toFixed(1) : '-'}</b></div>
    </div><div class="recent">${s.recent.map(x => x ? '<span class="y">✓</span>' : '<span class="n">✗</span>').join('')}</div>
    <div class="badges">${s.badges.map(badgeHtml).join('')}</div>`;
    $('#dCalib').innerHTML = `<div class="calib">${s.calibration.map(c => {
      const mid = (c.lo + c.hi) / 2;
      const few = c.n < 3;
      return `<div class="cr${few ? ' few' : ''}"><span>${c.lo}–${c.hi}%</span><span class="bars">${!few && c.acc != null ? `<i style="width:${Math.round(c.acc * 100)}%"></i>` : ''}<u style="left:${mid}%"></u></span><span class="note">${!c.n ? 'no calls' : few ? `${c.n} so far` : `${Math.round((c.acc ?? 0) * 100)}% of ${c.n}`}</span></div>`;
    }).join('')}<p class="voice">Stated confidence (left) against the hit rate (blue bar). The amber tick is what that confidence claims. Shown once a band has 3+ calls.</p></div>`;
  } else {
    $('#dRecord').innerHTML = '<p class="voice">No scored calls yet. Every call is checked 60 seconds after it is made.</p>';
    $('#dCalib').innerHTML = '<p class="voice">Calibration appears after a few scored calls.</p>';
  }
  const tend = (t: [number, number] | undefined, what: string) => !t || t[1] < 3 ? `<span class="few">${t?.[1] ?? 0} so far</span>` : `${t[0]} of ${t[1]} · <b>${Math.round(t[0] / t[1] * 100)}%</b><span class="voice"> ${what}</span>`;
  $('#dTend').innerHTML = s ? `<table class="ttable"><tr><td>With the AI majority</td><td>${tend(s.tend?.fol, '')}</td></tr><tr><td>Against the majority</td><td>${tend(s.tend?.fade, '')}</td></tr><tr><td>In stressed markets</td><td>${tend(s.tend?.stress, '')}</td></tr></table><p class="voice">Scored calls only. Fed back into their prompt once there are 3 or more.</p>` : '';
  $('#dLessons').innerHTML = a.lessons.length ? a.lessons.map(l => `<li>${esc(l)}</li>`).join('') : '<li class="none">None yet. They write one after seeing how a call worked out.</li>';
  $('#dHist').innerHTML = a.log.slice(0, 12).map(l => `<li><span class="hh">${esc(l.time)} · ${esc(l.head)} · ${esc(l.act)}</span><span>${esc(l.thought)}</span></li>`).join('');
  const on = !!G.room?.ai.on && !G.watching;
  $<HTMLInputElement>('#askInput').placeholder = G.watching ? 'Spectators can’t ask questions' : on ? `Ask ${a.name} anything…` : 'Needs Claude, which is not connected here';
  $<HTMLButtonElement>('#askBtn').disabled = !on;
}
function openDrawer(id: string) {
  open = G.agents.find(a => a.id === id) ?? null; if (!open) return;
  $('#answer').textContent = ''; paintDrawer();
  $('#drawer').hidden = false; $('#scrim').hidden = false; $('#dock').hidden = true;
  if (!coarse) $<HTMLInputElement>('#askInput').focus();
}
function closeDrawers() { open = null; $('#drawer').hidden = true; $('#hostPanel').hidden = true; $('#sciPanel').hidden = true; $('#scrim').hidden = true; if (!G.watching && !$('#game').hidden) $('#dock').hidden = false; }
$('#dClose').onclick = closeDrawers; $('#hClose').onclick = closeDrawers; $('#scrim').onclick = closeDrawers;
addEventListener('keydown', e => { if (e.key === 'Escape') { closeDrawers(); $('#recap').hidden = true; } });
$('#askForm').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $<HTMLInputElement>('#askInput'), q = inp.value.trim(); if (!q || !open || !G.room?.ai.on) return;
  inp.value = ''; $('#answer').textContent = 'Thinking…'; $<HTMLButtonElement>('#askBtn').disabled = true;
  send({ k: 'ask', id: open.id, q });
});

// ---------- AI science ----------
const pctS = (v: number | null) => v == null ? '-' : v + '%';
function renderScience() {
  const x = G.science; if (!x) return;
  const d = x.debate;
  $('#sciTxt').textContent = d.n >= 6 && d.open != null && d.final != null
    ? `Debate: opening views ${d.open}% right → final calls ${d.final}% (${d.n} calls)${x.single.n ? ` · no debate ${pctS(x.single.acc)}` : ''}`
    : `Does debate make the floor smarter? ${d.n} of 6 debated calls scored${x.single.n ? ` · no-debate calls ${pctS(x.single.acc)} of ${x.single.n}` : ''}`;
  if (!$('#sciPanel').hidden) paintScience();
}
function paintScience() {
  const x = G.science; if (!x) return;
  const bar = (label: string, v: number | null, n: number, cls = '') => `<div class="xbar ${cls}"><span>${label}</span><span class="tr">${v != null ? `<i style="width:${v}%"></i>` : ''}<u></u></span><b>${v != null ? v + '%' : '-'}<small class="voice"> /${n}</small></b></div>`;
  const tr = (a: AgentV) => { const t = G.stats[a.id]?.tend; const c = (v?: [number, number]) => !v || v[1] < 3 ? `<span class="few">${v?.[1] ?? 0}</span>` : `${Math.round(v[0] / v[1] * 100)}%<small class="voice">/${v[1]}</small>`; return `<tr><td style="color:var(--a-${a.id})">${esc(a.name)}</td><td>${c(t?.fol)}</td><td>${c(t?.fade)}</td><td>${c(t?.stress)}</td></tr>`; };
  const herd = (v: number | null) => v == null ? '-' : `${Math.round(v * 100)}%`;
  $('#sciBody').innerHTML = `
    <h3 class="sub">Does debate make the floor smarter?</h3>
    <p class="verdict">${esc(x.verdict)}</p>
    <div class="xbars">
      ${bar('Opening views', x.debate.open, x.debate.n)}
      ${bar('After debate', x.debate.final, x.debate.n, 'fin')}
      ${bar('No debate', x.single.acc, x.single.n)}
    </div>
    <p class="voice">Every trader's call (up, down or flat over the next 60 seconds) is scored against the price. In a debated round the opening view is scored too, so the same trader on the same headline is measured before and after the argument. The line marks a coin flip. ${x.debate.flips ? `The debate changed ${x.debate.flips} call${x.debate.flips > 1 ? 's' : ''}; ${x.debate.flipsRight} of them ended up right.` : ''}</p>
    <h3 class="sub">Herding</h3>
    <p class="voice">Share of the floor taking the same action in a round. Calm markets: <b>${herd(x.herding.calm)}</b> · stressed (panic, euphoria, volatile, liquidity crunch): <b>${herd(x.herding.stressed)}</b>.${x.herding.calm != null && x.herding.stressed != null ? (x.herding.stressed > x.herding.calm + 0.05 ? ' The floor moves more as one under stress.' : x.herding.stressed < x.herding.calm - 0.05 ? ' Stress splits the floor.' : ' Stress barely changes how much they agree.') : ''}</p>
    <h3 class="sub">Relationships (measured)</h3>
    ${x.relations.length ? `<ul class="rel">${x.relations.map(r => `<li><span class="k ${r.kind}">${r.kind === 'twins' ? 'MOVE TOGETHER' : 'RIVALS'}</span><b>${esc(r.a)}</b> and <b>${esc(r.b)}</b> ${r.kind === 'twins' ? 'traded the same way' : 'took opposite sides'} in ${Math.round(r.rate * r.n)} of ${r.n} rounds.</li>`).join('')}</ul>` : '<p class="voice">Appears once pairs of traders have acted together in 4+ rounds.</p>'}
    <h3 class="sub">Who is right with the crowd, and against it</h3>
    <table class="ttable"><tr><th></th><th>WITH MAJORITY</th><th>AGAINST</th><th>STRESSED</th></tr>${G.agents.map(tr).join('')}</table>
    <h3 class="sub">The desk</h3>
    <p class="voice">The newsroom's fair-value call pointed the way the price actually went on <b>${pctS(x.desk.acc)}</b> of ${x.desk.n} headlines (moves under 0.4% don't count).</p>`;
}
$('#sciBtn').onclick = () => { paintScience(); $('#sciPanel').hidden = false; $('#scrim').hidden = false; $('#dock').hidden = true; };
$('#sClose').onclick = () => closeDrawers();

// ---------- host panel: scenarios and the lab ----------
function paintHost() {
  const r = G.room; if (!r) return;
  $('#scenBox').hidden = !r.scenarios.length;
  $('#scenList').innerHTML = r.scenarios.map(s => `<button class="btn" type="button" data-id="${esc(s.id)}" ${r.scenario ? 'disabled' : ''}>${esc(s.name)}<small>${esc(s.desc)}</small></button>`).join('') + (r.scenario ? `<p class="voice">Running: ${esc(r.scenario.name)}${r.scenario.act ? ` · ${esc(r.scenario.act)}` : ''}</p>` : '');
  $('#autoRow').hidden = r.mode !== 'sim';
  const L = r.lab;
  $<HTMLInputElement>('#labVol').value = String(L.vol); $('#volV').textContent = L.vol.toFixed(2).replace(/0$/, '') + '×';
  $<HTMLInputElement>('#labLiq').value = String(L.liq); $('#liqV').textContent = L.liq.toFixed(2).replace(/0$/, '') + '×';
  const press = (sel: string, v: string) => $(sel).querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === v)));
  press('#labApp', L.appetite); press('#labDeb', L.debate); press('#labMem', L.memory ? 'on' : 'off'); press('#labAuto', String(L.autoNews));
  $('#seedV').textContent = String(r.seed);
  $<HTMLButtonElement>('#closeBtn').disabled = r.session === 'closed';
}
$('#hostBtn').onclick = () => { paintHost(); $('#hostPanel').hidden = false; $('#scrim').hidden = false; $('#dock').hidden = true; };
$('#scenList').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (b?.dataset.id) { send({ k: 'host', action: 'scenario', id: b.dataset.id }); closeDrawers(); } });
const lab = (l: Record<string, unknown>) => send({ k: 'host', action: 'lab', lab: l });
$('#labVol').addEventListener('change', e => lab({ vol: +(e.target as HTMLInputElement).value }));
$('#labLiq').addEventListener('change', e => lab({ liq: +(e.target as HTMLInputElement).value }));
const segLab = (sel: string, f: (v: string) => Record<string, unknown>) => $(sel).addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement | null; if (b?.dataset.v != null) lab(f(b.dataset.v)); });
segLab('#labApp', v => ({ appetite: v })); segLab('#labDeb', v => ({ debate: v })); segLab('#labMem', v => ({ memory: v === 'on' })); segLab('#labAuto', v => ({ autoNews: +v }));
$('#copyPlay').onclick = () => { if (G.room) void share(`${location.origin}/r/${G.room.code}`, $('#copyPlay'), 'Copy player link'); };
$('#copyWatch').onclick = () => { if (G.room) void share(`${location.origin}/r/${G.room.code}?watch=1&stage=1`, $('#copyWatch'), 'Copy watch link'); };
$('#closeBtn').onclick = () => { send({ k: 'host', action: 'close' }); closeDrawers(); };
$('#resetBtn').onclick = () => { if (confirm('Start a new session? Everyone goes back to $1M and the price restarts. AI memories are kept.')) { send({ k: 'host', action: 'reset' }); closeDrawers(); } };

// ---------- go ----------
if (!CODE) lobby(); else void enter(CODE);
