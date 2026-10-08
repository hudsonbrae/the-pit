// One trading room: an authoritative engine ticking every 250 ms, the six AI
// traders, the newsroom, and the human players connected to it. Everything the
// original ui.js did to game state now happens here; browsers only render.

import { Engine, clock, r2, type Trade } from './engine.js';
import { AGENTS, AGENT_IDS, HLCN, SIM_PRE, SIM_PRESETS, realCompany, realPre, realPresets, type CompanyCtx } from './agents.js';
import { tradePrompt, surprisePrompt, wrapPrompt, askPrompt, type AgentState, type PromptCtx } from './prompts.js';
import { offline } from './offline.js';
import { lineSplitter, parseLine, LLMError, type LLM, type LLMUsage } from './ai/llm.js';
import type { CostGuard } from './costguard.js';
import type { Config } from './config.js';
import type { Store, PlayerRow } from './store/store.js';
import type { MarketHub, FeedListener } from './market/hub.js';
import type { Headline, MarketStatus, Quote } from './market/provider.js';
import { normHeadline } from './market/hub.js';
import type {
  AccV, AgentV, ChatterV, ClientMsg, Delta, FillV, LevelV, MarkerV, Mode, NewsV, PlayerV, RoomInfo, RoundState, ServerMsg, Snapshot, TradeV,
} from '../shared/protocol.js';
import { f2, fi, money } from '../shared/format.js';

/** Anything that can receive a serialized message (a WebSocket, or a test double). */
export interface Conn { send(data: string): void; readonly bufferedAmount?: number; close?(code?: number, reason?: string): void }

export interface RoomDeps {
  cfg: Config;
  llm: LLM | null;
  guard: CostGuard;
  store: Store;
  hub: MarketHub | null;
  random?: () => number;
  /** Set when the API key is rejected; every room falls back to offline rules. */
  aiState: { dead: boolean };
}

interface AgentRT extends AgentState {
  conv: number; thought: string; thinking: string | null;
  lastAct: { side: string; label: string; fill: string; queued?: boolean } | null;
}

export interface Player {
  id: string; token: string; name: string; color: string; host: boolean;
  conns: Set<Conn>; dirty: boolean; orderTimes: number[];
  start: number; cash: number; sh: number; cost: number; // persisted copy (engine account is the live one)
}

interface RoundOpts { text: string; byName: string | null; origin: 'LIVE' | 'PLAYER'; deep?: boolean; source?: string; at?: string; url?: string }

/** One colour per player. The first is the original "You" white. */
export const PLAYER_COLORS = ['#f4f7fa', '#ff8a3d', '#3ddbd9', '#ff6ec7', '#b8e04a', '#6aa8ff', '#ffb3a7', '#c0a36e', '#9be7c4', '#d6a2ff', '#ffd27f', '#8fd3ff'];
const START_CASH = 1_000_000;
const AGENT_CASH = 600_000, AGENT_SH = 4000;

const sleep = (ms: number) => new Promise<void>(r => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

export class Room {
  readonly code: string;
  readonly mode: Mode;
  readonly ticker: string;
  readonly hostToken: string;
  co: CompanyCtx;
  presets: string[];
  eng!: Engine;
  agents: AgentRT[] = [];
  news: NewsV[] = [];
  markers: MarkerV[] = [];
  fills: FillV[] = [];
  chatter: ChatterV[] = [];
  players = new Map<string, Player>();      // by token
  private byId = new Map<string, Player>();
  private pseq = 0;
  speed = 1;
  round: RoundState = { busy: false };
  rounds = 0;                               // career rounds, all sources
  private newsNo = 0;
  private newsId = 0;
  private liveQueue: Headline[] = [];
  private seenLive = new Set<string>();
  real: NonNullable<RoomInfo['real']> | null = null;
  private unsub: (() => void) | null = null;
  private loop: NodeJS.Timeout | null = null;
  private saver: NodeJS.Timeout | null = null;
  private liveRetry: NodeJS.Timeout | null = null;
  disposed = false;
  lastActive = Date.now();
  // broadcast bookkeeping
  private pendTrades: Trade[] = [];
  private candleSent = 0;
  private haltSig = '';
  private newFills: FillV[] = [];
  private newMarkers: MarkerV[] = [];
  private pendEv: NonNullable<Delta['ev']> = [];
  private R: () => number;
  /** Rounds started, by origin (tests and /api/health). */
  stats = { rounds: 0, aiRounds: 0, offlineRounds: 0, live: 0 };

  constructor(private deps: RoomDeps, init: { code: string; mode: Mode; ticker: string; hostToken: string; co?: CompanyCtx; startPrice?: number }) {
    this.code = init.code; this.mode = init.mode; this.ticker = init.ticker; this.hostToken = init.hostToken;
    this.R = deps.random ?? Math.random;
    this.co = init.co ?? HLCN;
    this.presets = this.mode === 'sim' ? SIM_PRESETS : realPresets(this.co.short);
    if (this.mode === 'real') this.real = { price: init.startPrice ?? null, asOf: null, marketOpen: deps.hub?.marketOpen() ?? null, session: deps.hub?.status?.session ?? null, provider: deps.hub?.provider.name ?? '' };
    this.agents = AGENTS.map(a => ({ ...a, log: [], lessons: [], callPx: 0, callPnl: 0, conv: 50, thought: '', thinking: null, lastAct: null }));
    this.build(init.startPrice);
  }

  // ---------- setup ----------
  /** A fresh engine and a morning of trading before players arrive (as in the original). */
  private build(startPrice?: number) {
    const sim = this.mode === 'sim';
    const eng = new Engine({ start: sim ? 100 : r2(startPrice ?? this.real?.price ?? 100), random: this.R });
    if (!sim) eng.S.anchor = eng.S.last;
    this.eng = eng;
    this.news = []; this.markers = []; this.fills = []; this.chatter = []; this.newsNo = 0;
    const S = eng.S;
    const addNews = (text: string, impact: number, read: string) => {
      this.newsNo++;
      this.news.unshift({ id: ++this.newsId, no: this.newsNo, kind: 'news', text, impact, read, time: eng.clock() });
      this.markers.push({ idx: S.cur!.idx, no: this.newsNo });
    };
    for (let i = 0; i < 3300; i++) {
      if (sim && i === 1100) { eng.shock(6, 'slow'); addNews('Halcyon raises full-year battery delivery guidance by 12%', 6, 'Guidance raise points to stronger utility demand; margins unchanged.'); }
      if (sim && i === 2350) { eng.shock(-4, 'fast'); addNews('Rival Ferrovolt opens sodium-cell pilot plant in Nevada', -4, 'New domestic competitor; years from scale, but pricing pressure later.'); }
      eng.tick();
    }
    eng.drainEvents();
    this.news.push({ id: ++this.newsId, kind: 'sys', text: 'Opening bell', time: '09:30:00' });
    if (!sim) this.news.unshift({ id: ++this.newsId, kind: 'sys', text: `Anchored to real ${this.ticker} price $${f2(S.last)}`, time: eng.clock() });
    AGENTS.forEach(a => { S.accounts[a.id] = { cash: AGENT_CASH, sh: AGENT_SH, vol: 0, start: AGENT_CASH + AGENT_SH * S.last }; });
    const pre = sim ? SIM_PRE : realPre(this.ticker);
    this.agents.forEach(a => {
      a.log = [{ time: '09:31', head: 'Pre-market note', act: 'HOLD', thought: pre[a.id] }];
      a.thought = pre[a.id]; a.conv = 50; a.lastAct = null; a.thinking = null; a.callPx = S.last; a.callPnl = 0;
    });
    for (const p of this.players.values()) this.openAccount(p);
    eng.onTrade = tr => this.onTrade(tr);
    this.pendTrades = []; this.candleSent = S.cur!.idx; this.haltSig = ''; this.newFills = []; this.newMarkers = []; this.pendEv = [];
  }

  private openAccount(p: Player) {
    this.eng.S.accounts[p.id] = { cash: p.cash, sh: p.sh, vol: 0, start: p.start, cost: p.cost };
  }

  async loadPersisted() {
    const lessons = await this.deps.store.loadLessons(this.code);
    this.agents.forEach(a => { a.lessons = (lessons[a.id] || []).slice(0, 6); });
    for (const r of await this.deps.store.loadPlayers(this.code)) {
      const p = this.newPlayer(r.token, r.name, r.pid, r.color);
      p.cash = r.cash; p.sh = r.shares; p.cost = r.cost; p.start = r.start_value;
      this.openAccount(p);
    }
  }

  start() {
    if (this.loop || this.disposed) return;
    this.loop = setInterval(() => this.frame(), 250);
    this.saver = setInterval(() => void this.savePlayers(), 5000);
    if (this.mode === 'real' && this.deps.hub) {
      const feed = this.deps.hub.feeds.get(this.ticker);
      const l: FeedListener = { onQuote: q => this.onQuote(q), onHeadline: h => this.onHeadline(h), onStatus: s => this.onStatus(s) };
      this.unsub = this.deps.hub.subscribe(this.ticker, l);
      // A new room opens on the latest real headline if it is recent, so there is action straight away.
      const n = feed?.newest;
      if (n && this.deps.hub.now() - n.time < 24 * 3600_000) this.onHeadline(n);
    }
  }

  async dispose() {
    this.disposed = true;
    if (this.loop) clearInterval(this.loop);
    if (this.saver) clearInterval(this.saver);
    if (this.liveRetry) clearTimeout(this.liveRetry);
    this.loop = this.saver = this.liveRetry = null;
    this.unsub?.(); this.unsub = null;
    this.deps.guard.forgetRoom(this.code);
    await this.savePlayers(true);
  }

  // ---------- helpers ----------
  pnl = (id: string) => { const a = this.eng.S.accounts[id]; return a ? a.cash + a.sh * this.eng.S.last - a.start : 0; };
  get online() { let n = 0; for (const p of this.players.values()) if (p.conns.size) n++; return n; }
  private named(owner: string) { return AGENT_IDS.includes(owner) || this.byId.has(owner); }
  private ctx(): PromptCtx { return { co: this.co, eng: this.eng, news: this.news, agents: this.agents, pnl: this.pnl, real: this.real ? { price: this.real.price, marketOpen: this.real.marketOpen } : null }; }
  private aiOn() { return !!this.deps.llm && !this.deps.aiState.dead; }

  info(): RoomInfo {
    const st = this.deps.guard.stats();
    const capped = st.rounds >= st.roundCap;
    const ai = !this.deps.llm ? { label: 'Offline sim (no Claude)', on: false }
      : this.deps.aiState.dead ? { label: 'Offline sim (API key rejected)', on: false }
      : capped ? { label: 'Offline sim (daily AI cap reached)', on: false }
      : { label: this.deps.llm.label, on: true };
    const host = [...this.players.values()].find(p => p.host);
    return { code: this.code, mode: this.mode, ticker: this.ticker, company: this.co.name, speed: this.speed, hostId: host?.id ?? null, presets: this.presets, ai, real: this.real ?? undefined };
  }

  private agentV(a: AgentRT): AgentV {
    return { id: a.id, name: a.name, tag: a.tag, voice: a.voice, thought: a.thought, conv: a.conv, lastAct: a.lastAct, lessons: a.lessons, log: a.log.slice(0, 12), thinking: a.thinking };
  }
  private playerV(p: Player): PlayerV { return { id: p.id, name: p.name, color: p.color, host: p.host, online: p.conns.size > 0 }; }
  playersV() { return [...this.players.values()].map(p => this.playerV(p)); }

  private accs(): Record<string, AccV> {
    const out: Record<string, AccV> = {}, A = this.eng.S.accounts;
    for (const id of AGENT_IDS) { const a = A[id]; out[id] = [Math.round(a.cash), a.sh, Math.round(a.start), 0]; }
    for (const p of this.players.values()) { const a = A[p.id]; if (a) out[p.id] = [Math.round(a.cash), a.sh, Math.round(a.start), r2(a.cost ?? 0)]; }
    return out;
  }

  private bookV() {
    const S = this.eng.S;
    const agg = (arr: typeof S.bids): LevelV[] => {
      const out: LevelV[] = [];
      for (const o of arr) {
        const l = out[out.length - 1];
        if (l && l[0] === o.price) { l[1] += o.qty; if (this.named(o.owner) && !l[2].includes(o.owner)) l[2].push(o.owner); }
        else { if (out.length === 8) break; out.push([o.price, o.qty, this.named(o.owner) ? [o.owner] : []]); }
      }
      return out;
    };
    return { bids: agg(S.bids), asks: agg(S.asks) };
  }

  private tradeV(t: Trade): TradeV { return { id: t.id, price: t.price, q: t.q, aggr: t.aggr, buyer: t.buyer, seller: t.seller, t: t.t }; }

  private base(): Delta {
    const S = this.eng.S;
    return {
      t: S.t, clock: this.eng.clock(), last: S.last, open: S.open, hi: S.hi, lo: S.lo, vwap: S.vwapD ? r2(S.vwapN / S.vwapD) : null, vol: S.volume,
      halted: S.halted ? Math.ceil(S.halted * 0.25) : 0, trades: [], candles: [], book: S.halted ? { bids: [], asks: [] } : this.bookV(), acc: this.accs(),
    };
  }

  snapshot(): Snapshot {
    const S = this.eng.S;
    return {
      ...this.base(),
      trades: S.trades.slice(0, 18).map(t => this.tradeV(t)),
      candles: S.candles.slice(-300).map(c => ({ ...c })),
      halts: S.halts.map(h => ({ ...h })), fills: this.fills.slice(), markers: this.markers.slice(),
      agents: this.agents.map(a => this.agentV(a)), players: this.playersV(), wire: this.news.slice(0, 40), chatter: this.chatter.slice(), round: this.round,
    };
  }

  // ---------- transport ----------
  private sendTo(c: Conn, m: ServerMsg) { try { c.send(JSON.stringify(m)); } catch { /* socket closing */ } }
  broadcast(m: ServerMsg, skipSlow = false) {
    const s = JSON.stringify(m);
    for (const p of this.players.values()) for (const c of p.conns) {
      if (skipSlow && (c.bufferedAmount ?? 0) > 2_000_000) continue;
      try { c.send(s); } catch { /* closing */ }
    }
  }
  private sendWire() { this.broadcast({ k: 'wire', wire: this.news.slice(0, 40) }); }
  private sendRound(shake?: 'up' | 'down') { this.broadcast({ k: 'round', r: this.round, shake }); }
  private toast(p: Player | Conn, text: string, area: 'seat' | 'news' = 'seat') {
    const m: ServerMsg = { k: 'toast', text, area };
    if ('conns' in p) p.conns.forEach(c => this.sendTo(c, m)); else this.sendTo(p, m);
  }

  // ---------- the loop ----------
  private onTrade(tr: Trade) {
    this.pendTrades.push(tr);
    if (this.pendTrades.length > 60) this.pendTrades.splice(0, this.pendTrades.length - 60);
    for (const id of [tr.buyer, tr.seller]) {
      const p = this.byId.get(id); if (!p) continue;
      // cost basis of the open position (signed), after the fill has already changed sh
      const a = this.eng.S.accounts[id], d = id === tr.buyer ? tr.q : -tr.q, after = a.sh, before = after - d;
      if (before === 0 || Math.sign(before) === Math.sign(d)) a.cost = (a.cost ?? 0) + d * tr.price;
      else if (Math.sign(after) === Math.sign(before)) a.cost = (a.cost ?? 0) * after / before;
      else a.cost = after * tr.price;
      if (a.sh === 0) a.cost = 0;
      p.dirty = true;
    }
  }

  /** One 250 ms frame: advance the engine `speed` ticks and push a delta to everyone. */
  frame() {
    if (this.disposed) return;
    if (!this.online) return;                 // nobody watching: the room is frozen
    this.lastActive = Date.now();
    for (let k = 0; k < this.speed; k++) this.eng.tick();
    this.handleEvents();
    this.flush();
  }

  private handleEvents() {
    const evs = this.eng.drainEvents();
    if (!evs.length) return;
    for (const e of evs) {
      if (e.type === 'halt') this.news.unshift({ id: ++this.newsId, kind: 'sys', time: clock(e.t), text: `Circuit breaker: limit ${e.dir}, trading halted` });
      else {
        this.news.unshift({ id: ++this.newsId, kind: 'sys', time: clock(e.t), text: `Trading resumes at ${f2(e.price)}` });
        this.agents.forEach(a => { if (a.lastAct?.queued) { a.lastAct.fill = 'released at reopen'; a.lastAct.queued = false; this.broadcast({ k: 'agent', a: this.agentV(a) }); } });
      }
      this.pendEv.push(e);
    }
    if (this.news.length > 100) this.news.length = 100;
    this.sendWire();
  }

  /** Sends whatever changed since the last delta. Also called right after a player's order so fills show instantly. */
  flush() {
    const S = this.eng.S, d = this.base();
    d.trades = this.pendTrades.map(t => this.tradeV(t)).reverse(); // newest first, like S.trades
    this.pendTrades = [];
    d.candles = S.candles.filter(c => c.idx >= this.candleSent).map(c => ({ ...c }));
    this.candleSent = S.cur!.idx;
    const last = S.halts[S.halts.length - 1];
    const sig = `${S.halts.length}:${last?.start}:${last?.end}`;
    if (sig !== this.haltSig) { this.haltSig = sig; d.halts = S.halts.map(h => ({ ...h })); }
    if (this.newFills.length) { d.fills = this.newFills; this.newFills = []; }
    if (this.newMarkers.length) { d.markers = this.newMarkers; this.newMarkers = []; }
    if (this.pendEv.length) { d.ev = this.pendEv; this.pendEv = []; }
    this.broadcast({ k: 'd', ...d }, true);
  }

  private addFill(owner: string, side: 'buy' | 'sell', px: number) {
    const f: FillV = { idx: this.eng.S.cur!.idx, px: r2(px), side, owner };
    this.fills.push(f); if (this.fills.length > 200) this.fills.shift();
    this.newFills.push(f);
  }
  private addMarker(no: number) {
    const m = { idx: this.eng.S.cur!.idx, no };
    this.markers.push(m); if (this.markers.length > 100) this.markers.shift();
    this.newMarkers.push(m);
  }

  // ---------- players ----------
  private newPlayer(token: string, name: string, pid?: string, color?: string): Player {
    const n = pid ? Number(pid.slice(1)) : ++this.pseq;
    if (pid) this.pseq = Math.max(this.pseq, n);
    const p: Player = {
      id: pid ?? 'p' + n, token, name, color: color ?? PLAYER_COLORS[(n - 1) % PLAYER_COLORS.length], host: token === this.hostToken,
      conns: new Set(), dirty: true, orderTimes: [], start: START_CASH, cash: START_CASH, sh: 0, cost: 0,
    };
    this.players.set(token, p); this.byId.set(p.id, p);
    return p;
  }

  /** A browser joins (or rejoins) the room. Returns an error message or null. */
  attach(c: Conn, token: string, rawName: string): Player | string {
    if (this.disposed) return 'This room has closed. Create a new one.';
    const name = cleanName(rawName) || 'Player';
    let p = this.players.get(token);
    if (!p) {
      if (this.players.size >= this.deps.cfg.maxPlayersPerRoom) return `This room is full (${this.deps.cfg.maxPlayersPerRoom} players).`;
      p = this.newPlayer(token, uniqueName(name, [...this.players.values()].map(x => x.name)));
      this.openAccount(p);
    } else if (name && name !== p.name && !p.conns.size) {
      p.name = uniqueName(name, [...this.players.values()].filter(x => x !== p).map(x => x.name)); p.dirty = true;
    }
    p.conns.add(c);
    this.lastActive = Date.now();
    this.sendTo(c, { k: 'hello', you: this.playerV(p), room: this.info(), snap: this.snapshot() });
    this.broadcast({ k: 'players', players: this.playersV() });
    if (this.online === 1) this.pumpLive();
    return p;
  }

  detach(c: Conn, p: Player) {
    p.conns.delete(c);
    this.lastActive = Date.now();
    if (!p.conns.size) { this.syncPlayer(p); p.dirty = true; void this.savePlayers(); }
    this.broadcast({ k: 'players', players: this.playersV() });
  }

  private syncPlayer(p: Player) {
    const a = this.eng.S.accounts[p.id]; if (!a) return;
    p.cash = a.cash; p.sh = a.sh; p.cost = a.cost ?? 0; p.start = a.start;
  }

  async savePlayers(all = false) {
    const rows: PlayerRow[] = [];
    for (const p of this.players.values()) {
      if (!p.dirty && !all) continue;
      this.syncPlayer(p); p.dirty = false;
      rows.push({ room_code: this.code, token: p.token, pid: p.id, name: p.name, color: p.color, cash: p.cash, shares: p.sh, cost: p.cost, start_value: p.start });
    }
    if (rows.length) await this.deps.store.savePlayers(rows);
  }

  // ---------- intents ----------
  async handle(c: Conn, p: Player, m: ClientMsg) {
    switch (m.k) {
      case 'order': return this.playerOrder(p, m.side, m.qty);
      case 'flatten': {
        const s = this.eng.S.accounts[p.id]?.sh ?? 0;
        if (!s) return this.toast(p, 'You are already flat.');
        return this.playerOrder(p, s > 0 ? 'sell' : 'buy', Math.abs(s), true);
      }
      case 'news': {
        const text = String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
        if (!text) return;
        return this.requestRound(c, p, { text, byName: p.name, origin: 'PLAYER', deep: !!m.deep });
      }
      case 'check': return this.requestRound(c, p, { text: '', byName: p.name, origin: 'PLAYER', deep: !!m.deep });
      case 'surprise': return this.surprise(c, p, !!m.deep);
      case 'wrap': return this.wrap(c);
      case 'ask': return this.ask(c, String(m.id), String(m.q ?? '').slice(0, 300));
      case 'host': {
        if (!p.host) return this.toast(c, 'Only the host can do that.', 'news');
        if (m.action === 'speed') {
          const v = Number(m.value); if (![0, 1, 3].includes(v)) return;
          this.speed = v; this.broadcast({ k: 'room', room: this.info() });
          return;
        }
        if (m.action === 'reset') return this.reset(c);
        return;
      }
      case 'ping': return;
    }
  }

  playerOrder(p: Player, side: 'buy' | 'sell', qty: number, flatten = false) {
    if (side !== 'buy' && side !== 'sell') return;
    qty = Math.floor(Number(qty));
    if (!(qty > 0) || (!flatten && qty > 5000) || qty > 1_000_000) return this.toast(p, 'Order size not allowed.');
    const now = Date.now();
    p.orderTimes = p.orderTimes.filter(t => now - t < 1000);
    if (p.orderTimes.length >= 8) return this.toast(p, 'Slow down: too many orders in one second.');
    p.orderTimes.push(now);
    const before = this.eng.S.last;
    const res = this.eng.submit(p.id, side, qty, null);
    if (res.filled) this.addFill(p.id, side, res.avg);
    p.dirty = true;
    this.toast(p, res.queued ? `Halted: your ${side} of ${fi(qty)} is queued for the reopen.` :
      res.filled ? `${side === 'buy' ? 'Bought' : 'Sold'} ${fi(res.filled)} @ ${f2(res.avg)} avg · moved the price ${f2(this.eng.S.last - before)}${res.filled < qty ? ` · ${fi(qty - res.filled)} unfilled (book too thin)` : ''}` : 'No liquidity on that side right now.');
    this.flush();
  }

  private requestRound(c: Conn, _p: Player, o: RoundOpts) {
    if (this.round.busy) return this.toast(c, `A round is already in flight${this.round.by ? ` (${this.round.by})` : ''}. Try again when it lands.`, 'news');
    void this.runRound(o);
  }

  private async reset(c: Conn) {
    if (this.round.busy) return this.toast(c, 'Wait for the current round to land before resetting.', 'news');
    const rows = [...AGENTS.map(a => ({ room_code: this.code, name: a.name, pnl: Math.round(this.pnl(a.id)), is_ai: true })),
      ...[...this.players.values()].map(p => ({ room_code: this.code, name: p.name, pnl: Math.round(this.pnl(p.id)), is_ai: false }))];
    void this.deps.store.saveLeaderboard(rows);
    for (const p of this.players.values()) { p.cash = START_CASH; p.sh = 0; p.cost = 0; p.start = START_CASH; p.dirty = true; }
    this.liveQueue = [];
    this.build(this.real?.price ?? undefined);
    this.broadcast({ k: 'reset', snap: this.snapshot() });
    this.broadcast({ k: 'room', room: this.info() });
    void this.savePlayers();
  }

  // ---------- Real Market feed ----------
  onQuote(q: Quote) {
    if (!this.real) return;
    this.eng.S.anchor = q.price;
    const changed = this.real.price !== q.price;
    this.real.price = q.price; this.real.asOf = new Date(q.time).toISOString();
    if (changed) this.broadcast({ k: 'room', room: this.info() });
  }

  onStatus(s: MarketStatus) {
    if (!this.real) return;
    const changed = this.real.marketOpen !== s.isOpen;
    this.real.marketOpen = s.isOpen; this.real.session = s.session;
    if (changed) {
      this.news.unshift({ id: ++this.newsId, kind: 'sys', time: this.eng.clock(), text: s.isOpen ? 'US market open: tracking the live price' : 'US market closed: running on the last real price' });
      this.sendWire();
      this.broadcast({ k: 'room', room: this.info() });
    }
  }

  /** A real headline arrived from the data provider. Duplicates are ignored. */
  onHeadline(h: Headline) {
    const kId = 'id:' + h.id, kTx = 'tx:' + normHeadline(h.headline);
    if (this.seenLive.has(kId) || this.seenLive.has(kTx)) return;
    this.seenLive.add(kId); this.seenLive.add(kTx);
    if (this.seenLive.size > 4000) this.seenLive = new Set([...this.seenLive].slice(-2000));
    this.liveQueue.push(h);
    if (this.liveQueue.length > 3) this.liveQueue.splice(0, this.liveQueue.length - 3); // keep the 3 newest
    this.pumpLive();
  }

  private pumpLive() {
    if (this.disposed || this.round.busy || !this.liveQueue.length || !this.online) return;
    const g = this.deps.guard.canRound(this.code);
    if (!g.ok && g.reason === 'room_rate' && this.aiOn()) {
      if (!this.liveRetry) this.liveRetry = setTimeout(() => { this.liveRetry = null; this.pumpLive(); }, Math.max(1000, g.retryMs ?? 5000));
      return;
    }
    const h = this.liveQueue.shift()!;
    this.stats.live++;
    void this.runRound({ text: h.headline, byName: 'LIVE wire', origin: 'LIVE', source: h.source, at: new Date(h.time).toISOString(), url: h.url });
  }

  // ---------- AI round (port of breakNews) ----------
  async runRound(o: RoundOpts): Promise<boolean> {
    if (this.round.busy || this.disposed) return false;
    const text = o.text.trim();
    const isCheck = !text;
    this.rounds++; this.stats.rounds++;
    this.round = { busy: true, by: o.byName ?? undefined, headline: text || undefined, status: isCheck ? 'Floor check: traders are reviewing their books…' : o.origin === 'LIVE' ? 'Live headline. Claude is reading it…' : 'Claude is reading the headline…' };
    const item: NewsV = isCheck
      ? { id: ++this.newsId, kind: 'check', time: this.eng.clock(), text: 'Floor check: traders reassess', read: '', origin: 'PLAYER', by: o.byName ?? undefined }
      : { id: ++this.newsId, kind: 'news', no: ++this.newsNo, time: this.eng.clock(), text, impact: null, read: '', origin: o.origin, by: o.byName ?? undefined, source: o.source, at: o.at, url: o.url };
    this.news.unshift(item); if (this.news.length > 100) this.news.length = 100;
    if (!isCheck) this.addMarker(item.no!);
    this.agents.forEach(a => { a.thinking = isCheck ? 'Reviewing…' : 'Reading the headline…'; });
    this.sendWire(); this.sendRound();
    this.broadcast({ k: 'thinking', text: isCheck ? 'Reviewing…' : 'Reading the headline…' });

    const done = new Set<string>();
    let gotDesk = false;
    const applyDesk = (d: Record<string, unknown>) => {
      gotDesk = true;
      if (isCheck) { item.read = String(d.read || ''); this.sendWire(); return; }
      const imp = Math.max(-45, Math.min(60, +(d.impact as number) || 0));
      item.impact = +imp.toFixed(1); item.read = String(d.read || '').slice(0, 300);
      this.eng.shock(imp, d.speed === 'fast' ? 'fast' : 'slow');
      this.sendWire();
      this.round = { ...this.round, status: 'Desk has read it. Traders are deciding…' };
      this.sendRound(Math.abs(imp) >= 8 ? (imp > 0 ? 'up' : 'down') : undefined);
    };
    // traders act one after another, ~0.7s apart, so the market makers can refill between them
    let chain = Promise.resolve();
    const applyTrade = (d: Record<string, unknown>) => {
      const a = this.agents.find(x => x.id === d.id); if (!a || done.has(a.id)) return; done.add(a.id);
      chain = chain.then(async () => { if (!this.disposed) this.execAgent(a, d, isCheck ? null : text); await sleep(this.deps.cfg.roundPaceMs); });
    };
    const handleLine = (line: string) => {
      const obj = parseLine(line); if (!obj) return;
      if (obj.type === 'desk') { if (!gotDesk) applyDesk(obj); }
      else if (obj.type === 'chatter') chain = chain.then(() => this.addChatter(obj));
      else if (obj.type === 'trade' || obj.id) applyTrade(obj);
    };

    let note = '';
    let usage: LLMUsage | null = null;
    const llm = this.deps.llm;
    const g = this.deps.guard.canRound(this.code);
    if (!llm) note = 'Claude is not connected here, so the traders ran on offline rules.';
    else if (this.deps.aiState.dead) note = 'The Anthropic API key was rejected, so the traders ran on offline rules.';
    else if (!g.ok) note = g.reason === 'daily_cap' ? 'Today’s AI budget is used up, so offline rules took this one.' : `AI round limit for this room reached (${this.deps.cfg.aiRoundsPerMinPerRoom} a minute). Offline rules took this one.`;
    else {
      this.deps.guard.takeRound(this.code);
      const split = lineSplitter(handleLine);
      const t0 = Date.now();
      try {
        usage = await llm.stream({
          model: this.deps.cfg.modelRound, prompt: tradePrompt(this.ctx(), isCheck ? null : text), maxTokens: 4000,
          effort: o.deep ? this.deps.cfg.effortDeep : this.deps.cfg.effortRound,
        }, delta => split.push(delta));
        split.end();
        this.stats.aiRounds++;
      } catch (e) {
        split.end();
        const code = e instanceof LLMError ? e.code : 'error';
        if (code === 'auth') { this.deps.aiState.dead = true; this.broadcast({ k: 'room', room: this.info() }); }
        note = ({
          rate_limited: 'Claude is rate-limited right now. Offline rules took this one; try again in a minute.',
          auth: 'The Anthropic API key was rejected, so the traders are running on simple offline rules.',
          refused: 'Claude declined that headline. Offline rules handled it instead.',
        } as Record<string, string>)[code] || 'Claude could not answer that one, so offline rules handled it.';
        console.warn(JSON.stringify({ ev: 'ai_error', room: this.code, code, error: String((e as Error).message) }));
      }
      this.deps.guard.record({ room: this.code, kind: isCheck ? 'check' : o.origin === 'LIVE' ? 'live_round' : 'round', model: usage?.model ?? this.deps.cfg.modelRound, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ms: Date.now() - t0, ok: !!usage });
    }

    if (!gotDesk || done.size < AGENTS.length) {
      if (!usage) this.stats.offlineRounds++;
      const off = offline(isCheck ? null : text, this.eng.S.last, this.eng.S.open, this.R);
      if (!gotDesk) applyDesk(off.desk as unknown as Record<string, unknown>);
      off.trades.forEach(t => { if (!done.has(t.id)) applyTrade(t as unknown as Record<string, unknown>); });
    }
    await chain;
    void this.deps.store.logNews({
      room_code: this.code, no: item.no ?? null, kind: item.kind, origin: item.origin ?? null, by_name: item.by ?? null, headline: item.text,
      source: item.source ?? null, url: item.url ?? null, published_at: item.at ?? null, impact: item.impact ?? null, read: item.read ?? null,
      model: usage?.model ?? (note ? 'offline' : null), tokens_in: usage?.inputTokens ?? null, tokens_out: usage?.outputTokens ?? null,
    });
    this.round = { busy: false, note };
    if (!this.disposed) this.sendRound();
    setImmediate(() => this.pumpLive());
    return true;
  }

  private async addChatter(o: Record<string, unknown>) {
    const id = String(o.id ?? ''), to = String(o.to ?? ''), line = String(o.line ?? '').slice(0, 200);
    if (!AGENT_IDS.includes(id) || !line) return;
    const c: ChatterV = { id, to: AGENT_IDS.includes(to) ? to : '', line };
    this.chatter.unshift(c); if (this.chatter.length > 4) this.chatter.length = 4;
    this.broadcast({ k: 'chatter', c });
    await sleep(this.deps.cfg.chatterPaceMs);
  }

  execAgent(a: AgentRT, d: Record<string, unknown>, headline: string | null) {
    const S = this.eng.S;
    this.eng.cancel(a.id);
    let side = String(d.action || 'hold').toLowerCase();
    let qty = Math.max(0, Math.min(6000, Math.round(+(d.qty as number) || 0)));
    const pos = S.accounts[a.id].sh;
    if (side === 'sell') qty = Math.min(qty, pos + 12000);
    if (side === 'buy') qty = Math.min(qty, 12000 - pos);
    if (!['buy', 'sell'].includes(side) || qty <= 0) side = 'hold';
    let label = 'HOLD', fill = '';
    let lim = d.order === 'limit' && +(d.limit as number) > 0 ? r2(+(d.limit as number)) : null;
    if (lim && Math.abs(lim / S.last - 1) > 0.3) lim = null;
    let queued = false, avgFill: number | null = null;
    if (side !== 'hold') {
      const sd = side as 'buy' | 'sell';
      let res = this.eng.submit(a.id, sd, qty, lim);
      if (!lim && !res.queued && res.filled < qty) {          // thin book: park the rest just through the last print
        const px = r2(S.last * (sd === 'buy' ? 1.004 : 0.996));
        const r2nd = this.eng.submit(a.id, sd, qty - res.filled, px);
        res = { filled: res.filled + r2nd.filled, avg: (res.filled * res.avg + r2nd.filled * r2nd.avg) / Math.max(1, res.filled + r2nd.filled), rest: r2nd.rest };
      }
      queued = !!res.queued; if (res.filled) avgFill = res.avg;
      label = `${side.toUpperCase()} ${fi(qty)} · ${lim ? 'LMT ' + f2(lim) : 'MKT'}`;
      fill = queued ? 'queued for reopen' : res.filled ? `filled ${fi(res.filled)} @ ${f2(res.avg)}${res.rest ? ` · ${fi(res.rest)} resting` : ''}` : res.rest ? 'resting on the book' : 'no liquidity';
    }
    if (avgFill) this.addFill(a.id, side as 'buy' | 'sell', avgFill);
    const lesson = String(d.lesson || '').trim();
    let newLesson = false;
    if (lesson && lesson.length > 6) {
      a.lessons.unshift(lesson.slice(0, 140)); a.lessons.length = Math.min(a.lessons.length, 6);
      newLesson = true;
      void this.deps.store.saveLessons(this.code, a.id, a.lessons);
    }
    a.callPx = S.last; a.callPnl = this.pnl(a.id);
    a.lastAct = { side, label, fill, queued };
    a.conv = Math.max(0, Math.min(100, +(d.conviction as number) || 50));
    a.thought = String(d.thought || '').slice(0, 260) || '…';
    a.thinking = null;
    a.log.unshift({ time: this.eng.clock().slice(0, 5), head: headline || 'Floor check', act: label, thought: a.thought });
    if (a.log.length > 30) a.log.length = 30;
    this.broadcast({ k: 'agent', a: this.agentV(a), flash: true, newLesson });
    this.flush();
  }

  // ---------- smaller Claude calls (fast model) ----------
  private async small(c: Conn, prompt: string, onText: (full: string) => void, maxTokens = 600): Promise<{ text: string; err?: string }> {
    const llm = this.deps.llm;
    if (!llm || this.deps.aiState.dead) return { text: '', err: 'nollm' };
    if (!this.deps.guard.takeSmall()) return { text: '', err: 'cap' };
    let full = '';
    const t0 = Date.now();
    let usage: LLMUsage | null = null;
    try {
      usage = await llm.stream({ model: this.deps.cfg.modelFast, prompt, maxTokens, effort: 'low' }, delta => { full += delta; onText(full); });
      return { text: full };
    } catch (e) {
      const code = e instanceof LLMError ? e.code : 'error';
      if (code === 'auth') { this.deps.aiState.dead = true; this.broadcast({ k: 'room', room: this.info() }); }
      return { text: full, err: code };
    } finally {
      this.deps.guard.record({ room: this.code, kind: 'small', model: usage?.model ?? this.deps.cfg.modelFast, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ms: Date.now() - t0, ok: !!usage });
    }
  }

  private async surprise(c: Conn, p: Player, deep: boolean) {
    if (this.round.busy) return this.toast(c, `A round is already in flight${this.round.by ? ` (${this.round.by})` : ''}. Try again when it lands.`, 'news');
    if (!this.aiOn()) return this.toast(c, 'Claude is not connected here. Type a headline or pick one above.', 'news');
    this.round = { busy: true, by: p.name, status: 'Claude is writing a headline…' };
    this.sendRound();
    const r = await this.small(c, surprisePrompt(this.ctx()), () => { }, 200);
    let h = '';
    try { h = String(JSON.parse(r.text.trim().replace(/^```\w*|```$/g, '').match(/\{[\s\S]*\}/)?.[0] ?? '{}').headline || '').trim().slice(0, 220); } catch { h = ''; }
    this.round = { busy: false, note: h ? '' : r.err === 'cap' ? 'Today’s AI budget is used up. Type a headline instead.' : 'Claude could not write a headline just now. Type one instead.' };
    this.sendRound();
    if (h) void this.runRound({ text: h, byName: `${p.name} (Claude wrote it)`, origin: 'PLAYER', deep });
  }

  private async wrap(c: Conn) {
    const stream = (text: string, done: boolean, error?: string) => this.sendTo(c, { k: 'stream', kind: 'wrap', text, done, error });
    if (!this.aiOn()) return stream('The market wrap needs Claude, which is not connected in this view.', true);
    stream('Writing…', false);
    const board = [...this.agents.map(a => `${a.name} (${a.tag}): P&L ${money(this.pnl(a.id))}, holds ${fi(this.eng.S.accounts[a.id].sh)} sh, last call ${a.log[0]?.act}`),
      ...[...this.players.values()].map(p => `Human player ${p.name}: P&L ${money(this.pnl(p.id))}, holds ${fi(this.eng.S.accounts[p.id]?.sh ?? 0)} sh`)].join('\n');
    const r = await this.small(c, wrapPrompt(this.ctx(), board), full => stream(full, false), 700);
    if (r.err) stream(r.text, true, r.err === 'cap' ? 'Today’s AI budget is used up.' : 'The wrap could not be finished. Try again in a moment.');
    else stream(r.text, true);
  }

  private async ask(c: Conn, id: string, q: string) {
    const a = this.agents.find(x => x.id === id);
    const stream = (text: string, done: boolean, error?: string) => this.sendTo(c, { k: 'stream', kind: 'ask', text, done, error });
    if (!a || !q.trim()) return;
    if (!this.aiOn()) return stream('', true, 'Needs Claude, which is not connected here');
    stream('Thinking…', false);
    const r = await this.small(c, askPrompt(this.ctx(), a, q.trim()), full => stream(full, false), 400);
    if (r.err) stream(r.text, true, r.err === 'cap' ? 'Today’s AI budget is used up.' : 'The answer was cut off. Ask again in a moment.');
    else stream(r.text, true);
  }
}

export function cleanName(s: string) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}
function uniqueName(name: string, taken: string[]) {
  const reserved = [...AGENTS.map(a => a.name.toLowerCase()), 'you', 'live wire'];
  let n = name, i = 2;
  while (taken.some(t => t.toLowerCase() === n.toLowerCase()) || reserved.includes(n.toLowerCase())) n = `${name} ${i++}`;
  return n;
}

export { realCompany };
