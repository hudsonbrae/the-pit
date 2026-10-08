// One trading room: an authoritative engine ticking every 250 ms, the six AI
// traders, the newsroom, and the humans (players and spectators) connected to it.
// Everything that changes game state happens here; browsers only render.
//
// Around the engine sit the room's "intelligence" systems, all derived from real
// state: the scorebook (every AI call scored 60 s later → track records, calibration,
// reputation, risk budgets), market intel (regime, psychology, order-book signals,
// humans vs AI), the storyteller (notable moments, achievements) and the scenario
// runner. AI rounds can be a single streamed call or a two-call floor debate.

import { createHash } from 'node:crypto';
import { Engine, clock, r2, seeded, type Trade } from './engine.js';
import { AGENTS, AGENT_IDS, HLCN, SIM_PRE, SIM_PRESETS, realPre, realPresets, type CompanyCtx } from './agents.js';
import {
  SYSTEM_ROUND, SYSTEM_DEBATE_OPEN, SYSTEM_DEBATE_FINAL, roundUser, debateUser, surprisePrompt, wrapPrompt, askPrompt,
  type AgentState, type PromptCtx, type OpeningView,
} from './prompts.js';
import { offline } from './offline.js';
import { lineSplitter, parseLine, LLMError, type LLM, type LLMUsage } from './ai/llm.js';
import { validateDesk, validateDecision, validateChatter, cleanText, type Decision, type Desk, type TradeLimits } from './ai/schema.js';
import type { CostGuard } from './costguard.js';
import type { Config } from './config.js';
import type { Store, PlayerRow } from './store/store.js';
import type { MarketHub, FeedListener } from './market/hub.js';
import type { Headline, MarketStatus, Quote } from './market/provider.js';
import { normHeadline } from './market/hub.js';
import { Scorebook, categorise, stars, type TraderStats } from './intel/stats.js';
import { MarketIntel } from './intel/market.js';
import { Storyteller, ACHIEVEMENTS } from './intel/stories.js';
import { SCENARIOS, scenarioList, fill as fillScenario, type Scenario } from './scenarios.js';
import type {
  AccV, AgentV, ChatterV, ClientMsg, Delta, FillV, IntelV, LabV, LevelV, MarkerV, Mode, NewsV, Origin, PlayerV, RecapV, RoomInfo, RoundState,
  ServerMsg, Snapshot, TradeV, TraderStatsV, AchievementId, Side,
} from '../shared/protocol.js';
import { DEFAULT_LAB } from '../shared/protocol.js';
import { f2, fi, money } from '../shared/format.js';

/** Anything that can receive a serialized message (a WebSocket, or a test double). */
export interface Conn { send(data: string): void; readonly bufferedAmount?: number; close?(code?: number, reason?: string): void; terminate?(): void }

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
  call: Decision['call'] | null; signals: Decision['signals'] | null;
  opening: AgentV['opening']; changed: AgentV['changed']; budget: number;
}

export interface Player {
  id: string; token: string; name: string; color: string; host: boolean;
  conns: Set<Conn>; dirty: boolean; orderTimes: number[];
  start: number; cash: number; sh: number; cost: number; // persisted copy (engine account is the live one)
  lastNews: number; lastAsk: number; offlineSince: number;
}

export interface RoundOpts {
  text: string; byName: string | null; origin: Origin; deep?: boolean; debate?: boolean; debateAct?: string;
  source?: string; at?: string; url?: string;
}

/** One colour per player. The first is the original "You" white. */
export const PLAYER_COLORS = ['#f4f7fa', '#ff8a3d', '#3ddbd9', '#ff6ec7', '#b8e04a', '#6aa8ff', '#ffb3a7', '#c0a36e', '#9be7c4', '#d6a2ff', '#ffd27f', '#8fd3ff'];
const START_CASH = 1_000_000;
const AGENT_CASH = 600_000, AGENT_SH = 4000;
const PLAYER_MAX_POS = 50_000;
const MAX_CONNS_PER_PLAYER = 3;

export const hashToken = (t: string) => createHash('sha256').update('the-pit:' + t).digest('hex');
const sleep = (ms: number) => new Promise<void>(r => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));

interface ScenarioRun { def: Scenario; i: number; nextAt: number; block: 'round' | 'resume' | null; reverts: { at: number; knobs: Partial<Engine['knobs']> }[] }

export class Room {
  readonly code: string;
  readonly mode: Mode;
  readonly ticker: string;
  readonly hostHash: string;
  readonly seed: number;
  co: CompanyCtx;
  presets: string[];
  eng!: Engine;
  agents: AgentRT[] = [];
  news: NewsV[] = [];
  markers: MarkerV[] = [];
  fills: FillV[] = [];
  chatter: ChatterV[] = [];
  players = new Map<string, Player>();      // by hashed token
  private byId = new Map<string, Player>();
  watchers = new Set<Conn>();
  private pseq = 0;
  speed = 1;
  round: RoundState = { busy: false };
  rounds = 0;
  session: 'open' | 'closed' = 'open';
  lab: LabV = { ...DEFAULT_LAB };
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
  // intelligence
  sb: Scorebook;
  intel = new MarketIntel();
  intelV: IntelV;
  tell: Storyteller;
  private regimesSeen: string[] = [];
  private newsMoves: { id: number; t: number; px: number }[] = [];
  private biggestTrade: RecapV['biggestTrade'] = null;
  private statsDirty = false;
  private lastStatsSave = 0;
  private scen: ScenarioRun | null = null;
  private scenKnobs = { vol: 1, liq: 1, spread: 1, crowd: 1 };
  private lastAuto = 0;
  private lastReset = 0;
  private lastWrap = 0;
  private frameNo = 0;
  // broadcast bookkeeping
  private pendTrades: Trade[] = [];
  private candleSent = 0;
  private haltSig = '';
  private newFills: FillV[] = [];
  private newMarkers: MarkerV[] = [];
  private pendEv: NonNullable<Delta['ev']> = [];
  private R: () => number;
  /** Rounds started, by origin (tests and the admin view). */
  stats = { rounds: 0, aiRounds: 0, offlineRounds: 0, live: 0, debates: 0, aiMs: 0 };
  /** Frame timing (admin view). */
  perf = { frames: 0, frameMsAvg: 0, frameMsMax: 0, msgs: 0, bytes: 0 };

  constructor(private deps: RoomDeps, init: { code: string; mode: Mode; ticker: string; hostToken?: string; hostHash?: string; co?: CompanyCtx; startPrice?: number; seed?: number }) {
    this.code = init.code; this.mode = init.mode; this.ticker = init.ticker;
    this.hostHash = init.hostHash ?? hashToken(init.hostToken ?? '');
    this.seed = init.seed ?? Math.floor(Math.random() * 1e9);
    this.R = deps.random ?? seeded(this.seed);
    this.co = init.co ?? HLCN;
    this.presets = this.mode === 'sim' ? SIM_PRESETS : realPresets(this.co.short);
    if (this.mode === 'real') this.real = { price: init.startPrice ?? null, asOf: null, marketOpen: deps.hub?.marketOpen() ?? null, session: deps.hub?.status?.session ?? null, provider: deps.hub?.provider.name ?? '' };
    this.agents = AGENTS.map(a => ({ ...a, log: [], lessons: [], callPx: 0, callPnl: 0, conv: 50, thought: '', thinking: null, lastAct: null, call: null, signals: null, opening: null, changed: null, budget: 6000 }));
    this.sb = new Scorebook();
    this.tell = new Storyteller(s => this.broadcast({ k: 'story', s }), (pid, a) => this.onAchievement(pid, a));
    this.build(init.startPrice);
    this.intelV = this.intel.compute(this.eng, this.sb, this.teams());
  }

  // ---------- setup ----------
  /** A fresh engine and a morning of trading before players arrive (as in the original). */
  private build(startPrice?: number) {
    const sim = this.mode === 'sim';
    const eng = new Engine({ start: sim ? 100 : r2(startPrice ?? this.real?.price ?? 100), random: this.R });
    if (!sim) eng.S.anchor = eng.S.last;
    this.eng = eng;
    this.applyKnobs();
    this.news = []; this.markers = []; this.fills = []; this.chatter = []; this.newsNo = 0; this.newsMoves = []; this.biggestTrade = null;
    const S = eng.S;
    const addNews = (text: string, impact: number, read: string) => {
      this.newsNo++;
      this.news.unshift({ id: ++this.newsId, no: this.newsNo, kind: 'news', text, impact, read, time: eng.clock(), origin: 'SCENARIO', deskKind: 'confirmed' });
      this.markers.push({ idx: S.cur!.idx, no: this.newsNo });
    };
    for (let i = 0; i < 3300; i++) {
      if (sim && i === 1100) { eng.shock(6, 'slow'); addNews('Halcyon raises full-year battery delivery guidance by 12%', 6, 'Guidance raise points to stronger utility demand; margins unchanged.'); }
      if (sim && i === 2350) { eng.shock(-4, 'fast'); addNews('Rival Ferrovolt opens sodium-cell pilot plant in Nevada', -4, 'New domestic competitor; years from scale, but pricing pressure later.'); }
      eng.tick();
    }
    eng.drainEvents();
    this.news.push({ id: ++this.newsId, kind: 'sys', text: 'Opening bell', time: '09:30:00' });
    if (!sim) this.news.unshift({ id: ++this.newsId, kind: 'sys', text: `Anchored to real ${this.ticker} price $${f2(this.real?.price ?? S.last)}`, time: eng.clock() });
    AGENTS.forEach(a => { S.accounts[a.id] = { cash: AGENT_CASH, sh: AGENT_SH, vol: 0, start: AGENT_CASH + AGENT_SH * S.last, cost: AGENT_SH * S.last }; });
    const pre = sim ? SIM_PRE : realPre(this.ticker);
    this.agents.forEach(a => {
      a.log = [{ time: '09:31', head: 'Pre-market note', act: 'HOLD', thought: pre[a.id] }];
      a.thought = pre[a.id]; a.conv = 50; a.lastAct = null; a.thinking = null; a.callPx = S.last; a.callPnl = 0;
      a.call = null; a.signals = null; a.opening = null; a.changed = null; a.budget = 6000;
    });
    for (const p of this.players.values()) this.openAccount(p);
    eng.onTrade = tr => this.onTrade(tr);
    this.intel = new MarketIntel();
    this.sb.pending = []; this.sb.latest.clear();
    this.regimesSeen = ['CALM'];
    this.pendTrades = []; this.candleSent = S.cur!.idx; this.haltSig = ''; this.newFills = []; this.newMarkers = []; this.pendEv = [];
  }

  private applyKnobs() {
    if (!this.eng) return;
    this.eng.knobs = { vol: this.lab.vol * this.scenKnobs.vol, liq: this.lab.liq * this.scenKnobs.liq, spread: this.scenKnobs.spread, crowd: this.scenKnobs.crowd };
  }

  private openAccount(p: Player) {
    this.eng.S.accounts[p.id] = { cash: p.cash, sh: p.sh, vol: 0, start: p.start, cost: p.cost };
  }

  async loadPersisted() {
    const lessons = await this.deps.store.loadLessons(this.code);
    this.agents.forEach(a => { a.lessons = (lessons[a.id] || []).map(l => cleanText(l, 140)).filter(Boolean).slice(0, 6); });
    const st = await this.deps.store.loadStats(this.code);
    if (Object.keys(st).length) this.sb = new Scorebook(st);
    for (const r of await this.deps.store.loadPlayers(this.code)) {
      const color = /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : PLAYER_COLORS[0];
      const p = this.newPlayer(r.token, cleanText(r.name, 20) || 'Player', r.pid, color);
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
    await this.saveStats(true);
  }

  // ---------- helpers ----------
  pnl = (id: string) => { const a = this.eng.S.accounts[id]; return a ? a.cash + a.sh * this.eng.S.last - a.start : 0; };
  get online() { let n = 0; for (const p of this.players.values()) if (p.conns.size) n++; return n; }
  get audience() { return this.online + this.watchers.size; }
  private named(owner: string) { return AGENT_IDS.includes(owner) || this.byId.has(owner); }
  private nameOf(id: string) { return AGENTS.find(a => a.id === id)?.name ?? this.byId.get(id)?.name ?? id; }
  private aiOn() { return !!this.deps.llm && !this.deps.aiState.dead; }
  private pnlFrac(id: string) { const a = this.eng.S.accounts[id]; return a ? this.pnl(id) / a.start : 0; }
  private lastHeadline() { return this.news.find(n => n.kind === 'news')?.text ?? 'no headline'; }

  ctx(headline?: string | null): PromptCtx {
    const cat = headline ? categorise(headline) : null;
    return {
      co: this.co, eng: this.eng, news: this.news, agents: this.agents, pnl: this.pnl,
      real: this.real ? { price: this.real.price, marketOpen: this.real.marketOpen } : null,
      memory: this.lab.memory ? (id => this.sb.record4prompt(id, this.pnlFrac(id), this.lab.appetite, cat)) : null,
      floor: this.lab.memory ? this.sb.floorLine() : undefined,
      appetite: this.lab.appetite,
      mood: `regime ${this.intelV?.regime.name ?? 'CALM'}, floor mood ${this.intelV?.psych.label ?? 'NEUTRAL'}${this.intelV?.book.signals.length ? `, order book: ${this.intelV.book.signals.join(', ').toLowerCase()}` : ''}.`,
    };
  }

  /** Engine-enforced limits for one trader this round (the risk budget is the trader's own track record talking). */
  private limits = (id: string): TradeLimits | null => {
    const a = this.eng.S.accounts[id]; if (!a) return null;
    const budget = this.lab.memory ? this.sb.budget(id, this.pnlFrac(id), this.lab.appetite).budget : 6000;
    return { pos: a.sh, maxQty: budget, maxPos: 12000, last: this.eng.S.last };
  };

  info(): RoomInfo {
    const st = this.deps.guard.stats();
    const capped = st.rounds >= st.roundCap;
    const ai = !this.deps.llm ? { label: 'Offline sim (no Claude)', on: false }
      : this.deps.aiState.dead ? { label: 'Offline sim (API key rejected)', on: false }
      : capped ? { label: 'Offline sim (daily AI cap reached)', on: false }
      : { label: this.deps.llm.label, on: true };
    const host = [...this.players.values()].find(p => p.host);
    const sc = this.scen ? { id: this.scen.def.id, name: this.scen.def.name, act: this.currentAct } : null;
    return {
      code: this.code, mode: this.mode, ticker: this.ticker, company: this.co.name, speed: this.speed, hostId: host?.id ?? null, presets: this.presets, ai,
      lab: this.lab, seed: this.seed, session: this.session, watchers: this.watchers.size, scenario: sc,
      scenarios: this.mode === 'sim' ? scenarioList() : [], real: this.real ?? undefined,
    };
  }
  private currentAct: string | null = null;
  /** A scenario to start when the host first arrives (the lobby's "Run the demo"). */
  autoStart: string | undefined;

  private agentV(a: AgentRT): AgentV {
    return {
      id: a.id, name: a.name, tag: a.tag, voice: a.voice, thought: a.thought, conv: a.conv, lastAct: a.lastAct, lessons: a.lessons, log: a.log.slice(0, 12),
      thinking: a.thinking, call: a.call, signals: a.signals, opening: a.opening, changed: a.changed, budget: a.budget,
    };
  }
  private playerV(p: Player): PlayerV { return { id: p.id, name: p.name, color: p.color, host: p.host, online: p.conns.size > 0, badges: [...(this.tell.earned.get(p.id) ?? [])] }; }
  playersV() { return [...this.players.values()].map(p => this.playerV(p)); }

  statsV(): Record<string, TraderStatsV> {
    const out: Record<string, TraderStatsV> = {};
    for (const a of AGENTS) {
      const s = this.sb.get(a.id);
      out[a.id] = {
        calls: s.calls, correct: s.correct, streak: s.streak, trades: s.trades, wins: s.wins, pnl: Math.round(s.pnl), best: s.best, worst: s.worst,
        avgConv: s.calls ? Math.round(s.convSum / s.calls) : 0, recent: s.recent, stars: stars(s), badges: this.sb.badges(a.id), calibration: this.sb.calibration(a.id),
      };
    }
    return out;
  }

  private accs(): Record<string, AccV> {
    const out: Record<string, AccV> = {}, A = this.eng.S.accounts;
    for (const id of AGENT_IDS) { const a = A[id]; out[id] = [Math.round(a.cash), a.sh, Math.round(a.start), 0]; }
    for (const p of this.players.values()) { const a = A[p.id]; if (a) out[p.id] = [Math.round(a.cash), a.sh, Math.round(a.start), r2(a.cost ?? 0)]; }
    return out;
  }

  private teams(): IntelV['teams'] {
    let hp = 0, hs = 0, ap = 0, as = 0, n = 0;
    for (const p of this.players.values()) { const a = this.eng.S.accounts[p.id]; if (!a) continue; hp += this.pnl(p.id); hs += a.start; n++; }
    for (const id of AGENT_IDS) { ap += this.pnl(id); as += this.eng.S.accounts[id].start; }
    const rows = this.standings();
    const top = rows[0];
    return { human: { pnl: Math.round(hp), ret: hs ? +(hp / hs * 100).toFixed(2) : 0, n }, ai: { pnl: Math.round(ap), ret: as ? +(ap / as * 100).toFixed(2) : 0 }, leader: top ? { id: top.id, name: top.name, human: top.human } : null };
  }

  standings() {
    return [...AGENTS.map(a => ({ id: a.id, name: a.name, pnl: Math.round(this.pnl(a.id)), human: false })),
      ...[...this.players.values()].map(p => ({ id: p.id, name: p.name, pnl: Math.round(this.pnl(p.id)), human: true }))].sort((a, b) => b.pnl - a.pnl);
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
      stories: this.tell.stories.slice(0, 30), stats: this.statsV(), oracle: this.sb.oracle(), intel: this.intelV,
    };
  }

  // ---------- transport ----------
  private sendTo(c: Conn, m: ServerMsg) { try { c.send(JSON.stringify(m)); } catch { /* socket closing */ } }
  private *allConns() { for (const p of this.players.values()) yield* p.conns; yield* this.watchers; }
  broadcast(m: ServerMsg, skipSlow = false) {
    const s = JSON.stringify(m);
    for (const c of this.allConns()) {
      const buf = c.bufferedAmount ?? 0;
      if (buf > 4_000_000) { try { c.terminate ? c.terminate() : c.close?.(4008, 'too slow'); } catch { /* gone */ } continue; } // never let one stuck client eat memory
      if (skipSlow && buf > 1_000_000) continue;
      try { c.send(s); this.perf.msgs++; this.perf.bytes += s.length; } catch { /* closing */ }
    }
  }
  private sendWire() { this.broadcast({ k: 'wire', wire: this.news.slice(0, 40) }); }
  private sendRound(shake?: 'up' | 'down') { this.broadcast({ k: 'round', r: this.round, shake }); }
  private toast(p: Player | Conn, text: string, area: 'seat' | 'news' = 'seat') {
    const m: ServerMsg = { k: 'toast', text, area };
    if ('conns' in p) p.conns.forEach(c => this.sendTo(c, m)); else this.sendTo(p, m);
  }
  private sendStats() { this.broadcast({ k: 'stats', stats: this.statsV(), oracle: this.sb.oracle() }); }

  // ---------- the loop ----------
  private onTrade(tr: Trade) {
    this.pendTrades.push(tr);
    if (this.pendTrades.length > 60) this.pendTrades.splice(0, this.pendTrades.length - 60);
    this.intel.onTrade(tr);
    for (const id of [tr.buyer, tr.seller]) {
      const p = this.byId.get(id);
      if (!p && !AGENT_IDS.includes(id)) continue;
      // cost basis of the open position (signed), after the fill has already changed sh
      const a = this.eng.S.accounts[id], d = id === tr.buyer ? tr.q : -tr.q, after = a.sh, before = after - d;
      if (before === 0 || Math.sign(before) === Math.sign(d)) a.cost = (a.cost ?? 0) + d * tr.price;
      else if (Math.sign(after) === Math.sign(before)) a.cost = (a.cost ?? 0) * after / before;
      else a.cost = after * tr.price;
      if (a.sh === 0) a.cost = 0;
      if (p) p.dirty = true;
    }
  }

  /** One 250 ms frame: advance the engine `speed` ticks and push a delta to everyone. */
  frame() {
    if (this.disposed) return;
    if (!this.audience) return;              // nobody watching: the room is frozen
    const t0 = performance.now();
    this.lastActive = Date.now();
    this.frameNo++;
    for (let k = 0; k < this.speed; k++) this.eng.tick();
    this.handleEvents();
    if (this.speed) { this.runScenario(); this.scoreCalls(); this.autoNews(); }
    let intel: IntelV | undefined;
    if (this.frameNo % 4 === 0) intel = this.updateIntel();
    this.flush(intel);
    const ms = performance.now() - t0;
    this.perf.frames++; this.perf.frameMsAvg += (ms - this.perf.frameMsAvg) * 0.02; this.perf.frameMsMax = Math.max(this.perf.frameMsMax * 0.999, ms);
  }

  private updateIntel(): IntelV {
    const v = this.intel.compute(this.eng, this.sb, this.teams());
    this.intelV = v;
    const clk = this.eng.clock(), t = this.eng.S.t;
    if (this.regimesSeen.at(-1) !== v.regime.name) { this.regimesSeen.push(v.regime.name); if (this.regimesSeen.length > 30) this.regimesSeen.shift(); }
    this.tell.onIntel(this.ticker, v.regime.name, v.stats.r30, v.book.depthRatio, clk, t);
    const rows = this.standings();
    this.tell.onStandings(rows, v.teams.ai.pnl, v.teams.human.pnl, v.teams.human.n, clk, t);
    return v;
  }

  private holders() { return [...this.players.values()].map(p => ({ pid: p.id, name: p.name, sh: this.eng.S.accounts[p.id]?.sh ?? 0 })); }

  private handleEvents() {
    const evs = this.eng.drainEvents();
    if (!evs.length) return;
    for (const e of evs) {
      if (e.type === 'halt') {
        this.news.unshift({ id: ++this.newsId, kind: 'sys', time: clock(e.t), text: `Circuit breaker: limit ${e.dir}, trading halted` });
        this.intel.onHalt(e.t, e.dir);
        this.tell.onHalt(e.dir, clock(e.t), e.t, this.holders());
      } else {
        this.news.unshift({ id: ++this.newsId, kind: 'sys', time: clock(e.t), text: `Trading resumes at ${f2(e.price)}` });
        this.agents.forEach(a => { if (a.lastAct?.queued) { a.lastAct.fill = 'released at reopen'; a.lastAct.queued = false; this.broadcast({ k: 'agent', a: this.agentV(a) }); } });
        this.tell.onResume(clock(e.t), e.t, this.holders());
        if (this.scen?.block === 'resume') { this.scen.block = null; this.scen.nextAt = this.eng.S.t; }
      }
      this.pendEv.push(e);
    }
    if (this.news.length > 100) this.news.length = 100;
    this.sendWire();
  }

  /** Scores every call whose 60 s horizon has passed; fills in what each headline did to the price. */
  private scoreCalls() {
    const S = this.eng.S;
    const done = this.sb.resolve(S.t, S.last);
    for (const r of done) {
      const s = this.sb.get(r.who);
      this.tell.onResolved(r, this.nameOf(r.who), s.streak, this.ticker, this.eng.clock(), S.t);
      if (r.ai) this.statsDirty = true;
    }
    if (done.some(r => r.ai)) this.sendStats();
    let wire = false;
    while (this.newsMoves.length && S.t - this.newsMoves[0].t >= 240) {
      const m = this.newsMoves.shift()!;
      const n = this.news.find(x => x.id === m.id);
      if (n) { n.moved = +((S.last / m.px - 1) * 100).toFixed(2); wire = true; }
    }
    if (wire) this.sendWire();
    if (this.statsDirty && Date.now() - this.lastStatsSave > 10_000) void this.saveStats();
  }

  private async saveStats(force = false) {
    if (!this.statsDirty && !force) return;
    this.statsDirty = false; this.lastStatsSave = Date.now();
    const lab = `memory=${this.lab.memory ? 'on' : 'off'};debate=${this.lab.debate};appetite=${this.lab.appetite}`;
    for (const a of AGENTS) await this.deps.store.saveStats(this.code, a.id, this.sb.get(a.id), lab);
  }

  /** Sends whatever changed since the last delta. Also called right after a fill so it shows instantly. */
  flush(intel?: IntelV) {
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
    if (intel) d.intel = intel;
    this.broadcast({ k: 'd', ...d }, true);
  }

  private addFill(owner: string, side: Side, px: number) {
    const f: FillV = { idx: this.eng.S.cur!.idx, px: r2(px), side, owner };
    this.fills.push(f); if (this.fills.length > 200) this.fills.shift();
    this.newFills.push(f);
  }
  private addMarker(no: number) {
    const m = { idx: this.eng.S.cur!.idx, no };
    this.markers.push(m); if (this.markers.length > 100) this.markers.shift();
    this.newMarkers.push(m);
  }
  private noteTrade(id: string, side: Side, qty: number, price: number) {
    if (!this.biggestTrade || qty > this.biggestTrade.qty) this.biggestTrade = { name: this.nameOf(id), qty, side, price: r2(price) };
  }

  // ---------- players and spectators ----------
  private newPlayer(hash: string, name: string, pid?: string, color?: string): Player {
    const n = pid ? Number(pid.slice(1)) : ++this.pseq;
    if (pid) this.pseq = Math.max(this.pseq, n);
    const p: Player = {
      id: pid ?? 'p' + n, token: hash, name, color: color ?? PLAYER_COLORS[(n - 1) % PLAYER_COLORS.length], host: hash === this.hostHash,
      conns: new Set(), dirty: true, orderTimes: [], start: START_CASH, cash: START_CASH, sh: 0, cost: 0, lastNews: 0, lastAsk: 0, offlineSince: Date.now(),
    };
    this.players.set(hash, p); this.byId.set(p.id, p);
    return p;
  }

  /** A browser joins (or rejoins) the room. Returns an error message or the player. */
  attach(c: Conn, token: string, rawName: string): Player | string {
    if (this.disposed) return 'This room has closed. Create a new one.';
    const hash = hashToken(token);
    const name = cleanName(rawName) || 'Player';
    let p = this.players.get(hash);
    if (!p) {
      if (this.players.size >= this.deps.cfg.maxPlayersPerRoom && !this.evictAbsent()) return `This room is full (${this.deps.cfg.maxPlayersPerRoom} players). You can still watch.`;
      p = this.newPlayer(hash, uniqueName(name, [...this.players.values()].map(x => x.name)));
      this.openAccount(p);
    } else if (name && name !== p.name && !p.conns.size) {
      p.name = uniqueName(name, [...this.players.values()].filter(x => x !== p).map(x => x.name)); p.dirty = true;
    }
    if (p.conns.size >= MAX_CONNS_PER_PLAYER) { const oldest = p.conns.values().next().value!; p.conns.delete(oldest); try { oldest.close?.(4009, 'opened elsewhere'); } catch { /* gone */ } }
    p.conns.add(c);
    this.lastActive = Date.now();
    this.sendTo(c, { k: 'hello', you: this.playerV(p), room: this.info(), snap: this.snapshot() });
    this.broadcast({ k: 'players', players: this.playersV() });
    if (this.audience === 1) this.pumpLive();
    if (p.host && this.autoStart) { const id = this.autoStart; this.autoStart = undefined; setTimeout(() => { if (!this.disposed) this.startScenario(c, id); }, 2500); }
    return p;
  }

  /** Watch without a seat: not in the standings, can't trade or break news. */
  watch(c: Conn): string | null {
    if (this.disposed) return 'This room has closed.';
    if (this.watchers.size >= 50) return 'Too many spectators in this room.';
    this.watchers.add(c);
    this.sendTo(c, { k: 'hello', you: null, room: this.info(), snap: this.snapshot() });
    this.broadcast({ k: 'room', room: this.info() });
    if (this.audience === 1) this.pumpLive();
    return null;
  }
  unwatch(c: Conn) { if (this.watchers.delete(c)) this.broadcast({ k: 'room', room: this.info() }); }

  /** A full room frees the seat of whoever has been away longest (10+ minutes, flat position). */
  private evictAbsent(): boolean {
    const cutoff = Date.now() - 10 * 60_000;
    const cand = [...this.players.values()].filter(p => !p.conns.size && !p.host && p.offlineSince < cutoff && !(this.eng.S.accounts[p.id]?.sh)).sort((a, b) => a.offlineSince - b.offlineSince)[0];
    if (!cand) return false;
    this.players.delete(cand.token); this.byId.delete(cand.id); delete this.eng.S.accounts[cand.id];
    return true;
  }

  detach(c: Conn, p: Player) {
    p.conns.delete(c);
    this.lastActive = Date.now();
    if (!p.conns.size) { p.offlineSince = Date.now(); this.syncPlayer(p); p.dirty = true; void this.savePlayers(); }
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

  private onAchievement(pid: string, a: AchievementId) {
    const p = this.byId.get(pid); if (!p) return;
    const meta = ACHIEVEMENTS[a];
    p.conns.forEach(c => this.sendTo(c, { k: 'achievement', id: a, title: meta.title, desc: meta.desc }));
    this.broadcast({ k: 'players', players: this.playersV() });
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
        const text = cleanText(m.text, 220);
        if (!text) return;
        if (!this.cooldown(c, p)) return;
        return this.requestRound(c, { text, byName: p.name, origin: 'PLAYER', deep: !!m.deep && p.host, debate: m.debate === true ? true : undefined });
      }
      case 'check': if (!this.cooldown(c, p)) return; return this.requestRound(c, { text: '', byName: p.name, origin: 'PLAYER', deep: !!m.deep && p.host });
      case 'surprise': if (!this.cooldown(c, p)) return; return this.surprise(c, p, !!m.deep && p.host, m.debate === true);
      case 'wrap': return this.wrap(c);
      case 'ask': {
        if (Date.now() - p.lastAsk < 4000) return this.sendTo(c, { k: 'stream', kind: 'ask', text: '', done: true, error: 'One question every few seconds, please.' });
        p.lastAsk = Date.now();
        return this.ask(c, String(m.id), typeof m.q === 'string' ? m.q.slice(0, 300) : '');
      }
      case 'host': {
        if (!p.host) return this.toast(c, 'Only the host can do that.', 'news');
        switch (m.action) {
          case 'speed': {
            const v = Number(m.value); if (![0, 1, 3].includes(v)) return;
            this.speed = v; this.broadcast({ k: 'room', room: this.info() });
            return;
          }
          case 'reset': return this.reset(c);
          case 'close': return this.closeSession(c);
          case 'lab': return this.setLab(m.lab);
          case 'scenario': return this.startScenario(c, String(m.id));
        }
        return;
      }
      case 'ping': return;
    }
  }

  /** One news/check/surprise per player every few seconds, so nobody can monopolise the AI. */
  private cooldown(c: Conn, p: Player) {
    const wait = this.deps.cfg.newsCooldownSec * 1000 - (Date.now() - p.lastNews);
    if (wait > 0) { this.toast(c, `Give the floor a moment: you can break news again in ${Math.ceil(wait / 1000)}s.`, 'news'); return false; }
    p.lastNews = Date.now();
    return true;
  }

  playerOrder(p: Player, side: Side, qty: number, flatten = false) {
    if (side !== 'buy' && side !== 'sell') return;
    qty = Math.floor(Number(qty));
    if (!(qty > 0) || (!flatten && qty > 5000) || qty > PLAYER_MAX_POS * 2) return this.toast(p, 'Order size not allowed.');
    if (this.session === 'closed') return this.toast(p, 'The session is closed. The host can start a new one.');
    const now = Date.now();
    p.orderTimes = p.orderTimes.filter(t => now - t < 1000);
    if (p.orderTimes.length >= 8) return this.toast(p, 'Slow down: too many orders in one second.');
    p.orderTimes.push(now);
    const pos = this.eng.S.accounts[p.id]?.sh ?? 0;
    if (!flatten) {
      const room = side === 'buy' ? PLAYER_MAX_POS - pos : PLAYER_MAX_POS + pos;
      if (room <= 0) return this.toast(p, `Position limit: ${fi(PLAYER_MAX_POS)} shares either way.`);
      qty = Math.min(qty, room);
    }
    const before = this.eng.S.last;
    const res = this.eng.submit(p.id, side, qty, null);
    if (res.filled) {
      this.addFill(p.id, side, res.avg);
      this.noteTrade(p.id, side, res.filled, res.avg);
      this.sb.record({ who: p.id, ai: false, t: this.eng.S.t, px: res.avg, call: side === 'buy' ? 'up' : 'down', conviction: 0, action: side, qty: res.filled, fill: res.avg, head: this.lastHeadline(), category: 'other', clock: this.eng.clock().slice(0, 5) });
      this.tell.onFirstFill(p.id, p.name, this.eng.clock(), this.eng.S.t);
    }
    p.dirty = true;
    this.toast(p, res.queued ? `Halted: your ${side} of ${fi(qty)} is queued for the reopen.` :
      res.filled ? `${side === 'buy' ? 'Bought' : 'Sold'} ${fi(res.filled)} @ ${f2(res.avg)} avg · moved the price ${f2(this.eng.S.last - before)}${res.filled < qty ? ` · ${fi(qty - res.filled)} unfilled (book too thin)` : ''}` : 'No liquidity on that side right now.');
    this.flush();
  }

  private requestRound(c: Conn, o: RoundOpts) {
    if (this.session === 'closed') return this.toast(c, 'The session is closed. The host can start a new one.', 'news');
    if (this.round.busy) return this.toast(c, `A round is already in flight${this.round.by ? ` (${this.round.by})` : ''}. Try again when it lands.`, 'news');
    void this.runRound(o).catch(e => console.error(JSON.stringify({ ev: 'round_crash', room: this.code, error: String(e?.message ?? e) })));
  }

  private async reset(c: Conn) {
    if (this.round.busy) return this.toast(c, 'Wait for the current round to land before resetting.', 'news');
    if (Date.now() - this.lastReset < 15_000) return this.toast(c, 'The room was just reset. Give it a few seconds.', 'news');
    this.lastReset = Date.now();
    const rows = this.standings().map(r => ({ room_code: this.code, name: r.name, pnl: r.pnl, is_ai: !r.human }));
    void this.deps.store.saveLeaderboard(rows);
    for (const p of this.players.values()) { p.cash = START_CASH; p.sh = 0; p.cost = 0; p.start = START_CASH; p.dirty = true; }
    this.liveQueue = []; this.scen = null; this.scenKnobs = { vol: 1, liq: 1, spread: 1, crowd: 1 }; this.currentAct = null;
    this.session = 'open'; if (this.speed === 0) this.speed = 1;
    this.tell.reset();
    this.build(this.real?.price ?? undefined);
    this.intelV = this.intel.compute(this.eng, this.sb, this.teams());
    this.broadcast({ k: 'reset', snap: this.snapshot() });
    this.broadcast({ k: 'room', room: this.info() });
    void this.savePlayers();
  }

  private setLab(l: Partial<LabV>) {
    const n = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
    const cur = this.lab;
    this.lab = {
      vol: n(l.vol, 0.25, 3, cur.vol), liq: n(l.liq, 0.25, 2, cur.liq),
      appetite: l.appetite && ['cautious', 'normal', 'aggressive'].includes(l.appetite) ? l.appetite : cur.appetite,
      memory: typeof l.memory === 'boolean' ? l.memory : cur.memory,
      debate: l.debate && ['off', 'major', 'always'].includes(l.debate) ? l.debate : cur.debate,
      autoNews: this.mode === 'sim' ? n(l.autoNews, 0, 900, cur.autoNews) : 0,
    };
    if (this.lab.autoNews && this.lab.autoNews < 60) this.lab.autoNews = 60;
    this.applyKnobs();
    this.broadcast({ k: 'room', room: this.info() });
  }

  // ---------- scenarios ----------
  private startScenario(c: Conn, id: string) {
    if (this.mode !== 'sim') return this.toast(c, 'Scenarios run in Sim rooms only, so fictional events never mix with real prices.', 'news');
    const def = SCENARIOS.find(s => s.id === id);
    if (!def) return;
    if (this.scen) return this.toast(c, `A scenario is already running (${this.scen.def.name}).`, 'news');
    this.scen = { def, i: 0, nextAt: this.eng.S.t, block: null, reverts: [] };
    this.tell.add('scenario', `Scenario started: ${def.name}.`, 1, this.eng.clock(), this.eng.S.t);
    if (this.speed === 0) this.speed = 1;
    this.broadcast({ k: 'room', room: this.info() });
  }

  private runScenario() {
    const S = this.eng.S;
    if (this.scen?.reverts.length) {
      for (const r of this.scen.reverts.filter(r => S.t >= r.at)) { Object.assign(this.scenKnobs, r.knobs); }
      this.scen.reverts = this.scen.reverts.filter(r => S.t < r.at);
      this.applyKnobs();
    }
    const sc = this.scen; if (!sc || sc.block || S.t < sc.nextAt) return;
    if (sc.block === null && this.round.busy) return;
    const step = sc.def.steps[sc.i];
    if (!step) { if (!sc.reverts.length) { this.scen = null; this.currentAct = null; this.broadcast({ k: 'room', room: this.info() }); } return; }
    sc.i++;
    const next = sc.def.steps[sc.i];
    const after = (s: typeof step | undefined) => (s?.after ?? 0) * 4;
    sc.nextAt = S.t + after(next);
    const clk = this.eng.clock();
    if ('act' in step) {
      this.currentAct = step.act;
      this.broadcast({ k: 'act', title: step.act, sub: step.sub });
      this.tell.add('act', `${step.act}: ${step.sub}`, 2, clk, S.t);
      this.broadcast({ k: 'room', room: this.info() });
    } else if ('news' in step) {
      sc.block = 'round';
      const text = fillScenario(step.news, this.co);
      void this.runRound({ text, byName: `Scenario: ${sc.def.name}`, origin: 'SCENARIO', debate: step.debate, debateAct: step.debateAct })
        .catch(e => console.error(JSON.stringify({ ev: 'round_crash', room: this.code, error: String(e?.message ?? e) })))
        .finally(() => { if (this.scen === sc) { sc.block = null; sc.nextAt = this.eng.S.t + after(next); } });
    } else if ('shock' in step) {
      this.eng.shock(step.shock, step.speed);
      if (step.note) this.tell.add('scen', step.note, 2, clk, S.t);
    } else if ('program' in step) {
      this.eng.programs.push({ owner: step.program === 'sell' ? 'algoS' : 'algoB', side: step.program, perTick: step.perTick, ticks: step.ticks });
      if (step.note) this.tell.add('scen', step.note, 2, clk, S.t);
    } else if ('withdraw' in step) {
      this.eng.withdraw(step.withdraw);
      if (step.note) this.tell.add('scen', step.note, 2, clk, S.t);
    } else if ('knobs' in step) {
      const prev: Partial<Engine['knobs']> = {};
      for (const [k, v] of Object.entries(step.knobs)) { prev[k as keyof Engine['knobs']] = 1; this.scenKnobs[k as keyof Engine['knobs']] = v!; }
      sc.reverts.push({ at: S.t + step.ticks, knobs: prev });
      this.applyKnobs();
      if (step.note) this.tell.add('scen', step.note, 1, clk, S.t);
    } else if ('haltIfNone' in step) {
      const lastHalt = S.halts.at(-1);
      if (!S.halted && !(lastHalt && S.t - lastHalt.t < step.withinTicks)) this.eng.forceHalt(step.haltIfNone);
    } else if ('waitResume' in step) {
      if (S.halted) sc.block = 'resume';
    } else if ('prompt' in step) {
      for (const p of this.players.values()) this.toast(p, step.prompt);
    } else if ('close' in step) {
      void this.closeSession(null);
    }
  }

  /** Lab: an AI-written headline every N simulated seconds when the floor is idle (Sim only). */
  private autoNews() {
    if (!this.lab.autoNews || this.mode !== 'sim' || this.round.busy || this.scen || this.session === 'closed' || !this.aiOn()) return;
    const S = this.eng.S;
    if (S.t - this.lastAuto < this.lab.autoNews * 4) return;
    this.lastAuto = S.t;
    void this.surprise(null, null, false, false).catch(() => { });
  }

  // ---------- closing bell ----------
  private async closeSession(c: Conn | null) {
    if (this.session === 'closed') return;
    if (this.round.busy) { if (c) this.toast(c, 'Wait for the current round to land, then close.', 'news'); return; }
    this.session = 'closed';
    this.speed = 0;
    this.scen = null; this.currentAct = null;
    const recap = this.recap();
    this.news.unshift({ id: ++this.newsId, kind: 'sys', time: this.eng.clock(), text: 'Closing bell' });
    this.sendWire();
    this.broadcast({ k: 'room', room: this.info() });
    this.broadcast({ k: 'recap', recap });
    void this.deps.store.saveLeaderboard(recap.standings.map(r => ({ room_code: this.code, name: r.name, pnl: r.pnl, is_ai: !r.human })));
    void this.saveStats(true);
    // the narrator: Claude writes the match report; offline, the recap stands on its own
    const stream = (text: string, done: boolean, error?: string) => this.broadcast({ k: 'stream', kind: 'recap', text, done, error });
    if (!this.aiOn()) return stream('', true);
    const board = recap.standings.map(r => `${r.name}${r.human ? ' (human)' : ''}: ${money(r.pnl)}`).join('\n');
    const moments = this.tell.stories.slice().reverse().filter(s => s.weight >= 2).slice(-12).map(s => `${s.clock} ${s.text}`).join('\n');
    const pr = wrapPrompt(this.ctx(), board, moments);
    const r = await this.small(pr.system, pr.user, this.deps.cfg.models.narrator, full => stream(full, false), 700, 'narrator');
    stream(r.text, true, r.err ? 'The narrator was cut off.' : undefined);
  }

  recap(): RecapV {
    const S = this.eng.S, st = this.standings(), tm = this.teams();
    const oracle = this.sb.oracle() ?? AGENTS.map(a => a.id).sort((a, b) => this.sb.get(b).correct - this.sb.get(a).correct)[0];
    const os = this.sb.get(oracle);
    const headlines = this.news.filter(n => n.kind === 'news' && n.impact != null);
    const big = headlines.sort((a, b) => Math.abs(b.impact!) - Math.abs(a.impact!))[0];
    const moments = this.tell.stories.filter(s => s.weight >= 2).slice(0, 10).reverse();
    const ach: RecapV['achievements'] = [];
    for (const [pid, set] of this.tell.earned) for (const a of set) ach.push({ name: this.nameOf(pid), title: ACHIEVEMENTS[a].title });
    return {
      ticker: this.ticker, open: S.open, close: S.last, hi: S.hi, lo: S.lo, volume: S.volume, halts: S.halts.length,
      standings: st, humans: { pnl: tm.human.pnl, ret: tm.human.ret }, ai: { pnl: tm.ai.pnl, ret: tm.ai.ret },
      mostAccurate: os.calls ? { name: this.nameOf(oracle), correct: os.correct, calls: os.calls } : null,
      biggestHeadline: big ? { text: big.text, impact: big.impact!, moved: big.moved ?? null } : null,
      mostSplit: this.tell.stories.find(s => s.kind === 'split')?.text ?? null,
      biggestTrade: this.biggestTrade, regimes: this.regimesSeen.slice(), moments, achievements: ach,
    };
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
    if (this.disposed || this.round.busy || !this.liveQueue.length || !this.audience) return;
    const debate = this.lab.debate !== 'off';
    const g = this.deps.guard.canRound(this.code, debate ? 2 : 1);
    if (!g.ok && g.reason === 'room_rate' && this.aiOn()) {
      if (!this.liveRetry) this.liveRetry = setTimeout(() => { this.liveRetry = null; this.pumpLive(); }, Math.max(1000, g.retryMs ?? 5000));
      return;
    }
    const h = this.liveQueue.shift()!;
    this.stats.live++;
    void this.runRound({ text: cleanText(h.headline, 220), byName: 'LIVE wire', origin: 'LIVE', debate, source: cleanText(h.source, 60), at: new Date(h.time).toISOString(), url: /^https?:\/\//i.test(h.url ?? '') ? h.url : undefined })
      .catch(e => console.error(JSON.stringify({ ev: 'round_crash', room: this.code, error: String(e?.message ?? e) })));
  }

  // ---------- AI round ----------
  /** One streamed call (with a watchdog). Returns usage, or null on failure with the error code. */
  private async callAI(system: string, user: string, model: string, effort: 'low' | 'medium' | 'high', maxTokens: number, onLine: (l: string) => void, kind: string): Promise<{ usage: LLMUsage | null; code: string | null }> {
    const llm = this.deps.llm!;
    const ac = new AbortController();
    const dog = setTimeout(() => ac.abort(), this.deps.cfg.aiRoundTimeoutMs);
    const split = lineSplitter(l => { try { onLine(l); } catch (e) { console.warn(JSON.stringify({ ev: 'line_error', error: String((e as Error)?.message) })); } });
    const t0 = Date.now();
    let usage: LLMUsage | null = null, code: string | null = null;
    try {
      usage = await llm.stream({ model, system, prompt: user, maxTokens, effort, signal: ac.signal }, d => split.push(d));
    } catch (e) {
      code = ac.signal.aborted ? 'timeout' : e instanceof LLMError ? e.code : 'error';
      if (code === 'auth') { this.deps.aiState.dead = true; this.broadcast({ k: 'room', room: this.info() }); }
      console.warn(JSON.stringify({ ev: 'ai_error', room: this.code, kind, code, error: String((e as Error)?.message) }));
    } finally {
      clearTimeout(dog);
      split.end();
    }
    const ms = Date.now() - t0;
    this.stats.aiMs += ms;
    this.deps.guard.record({ room: this.code, kind, model: usage?.model ?? model, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ms, ok: !!usage });
    return { usage, code };
  }

  async runRound(o: RoundOpts): Promise<boolean> {
    if (this.round.busy || this.disposed) return false;
    const text = o.text.trim();
    const isCheck = !text;
    const debate = !isCheck && (o.debate ?? (this.lab.debate === 'always' || (this.lab.debate === 'major' && o.origin === 'LIVE')));
    this.rounds++; this.stats.rounds++;
    this.intel.onRound(this.eng.S.t);
    this.round = { busy: true, by: o.byName ?? undefined, headline: text || undefined, phase: 'reading', status: isCheck ? 'Floor check: traders are reviewing their books…' : o.origin === 'LIVE' ? 'Live headline. Claude is reading it…' : 'Claude is reading the headline…' };
    const item: NewsV = isCheck
      ? { id: ++this.newsId, kind: 'check', time: this.eng.clock(), text: 'Floor check: traders reassess', read: '', origin: 'PLAYER', by: o.byName ?? undefined }
      : { id: ++this.newsId, kind: 'news', no: ++this.newsNo, time: this.eng.clock(), text, impact: null, read: '', origin: o.origin, by: o.byName ?? undefined, source: o.source, at: o.at, url: o.url, debate };
    this.news.unshift(item); if (this.news.length > 100) this.news.length = 100;
    if (!isCheck) { this.addMarker(item.no!); this.newsMoves.push({ id: item.id, t: this.eng.S.t, px: this.eng.S.last }); }
    const cat = isCheck ? 'other' : categorise(text);
    this.agents.forEach(a => {
      a.thinking = isCheck ? 'Reviewing…' : 'Reading the headline…'; a.opening = null; a.changed = null;
      a.budget = this.limits(a.id)?.maxQty ?? 6000;
    });
    this.sendWire(); this.sendRound();
    this.broadcast({ k: 'thinking', text: isCheck ? 'Reviewing…' : 'Reading the headline…' });

    const done = new Set<string>();
    let desk: Desk | null = null;
    const getDesk = (): Desk | null => desk;         // read through a function: TS can't see closure assignments
    const applyDesk = (d: Desk) => {
      if (desk) return;
      desk = d;
      if (isCheck) { item.read = d.read; this.sendWire(); return; }
      item.impact = d.impact; item.read = d.read; item.deskKind = d.kind; item.category = d.category;
      this.eng.shock(d.impact, d.speed);
      this.sendWire();
      this.round = { ...this.round, phase: debate ? 'debate' : 'deciding', status: debate ? 'Desk has read it. The floor is debating…' : 'Desk has read it. Traders are deciding…' };
      this.sendRound(Math.abs(d.impact) >= 8 ? (d.impact > 0 ? 'up' : 'down') : undefined);
    };
    // traders act one after another, ~0.7s apart, so the market makers can refill between them
    let chain = Promise.resolve();
    const decided: { id: string; name: string; action: string }[] = [];
    const applyTrade = (d: Decision) => {
      if (done.has(d.id)) return; done.add(d.id);
      chain = chain.then(async () => {
        try { if (!this.disposed) { this.execAgent(d, isCheck ? null : text, getDesk()?.category ?? cat); decided.push({ id: d.id, name: this.nameOf(d.id), action: d.action }); } }
        catch (e) { console.warn(JSON.stringify({ ev: 'exec_error', error: String((e as Error)?.message) })); }
        await sleep(this.deps.cfg.roundPaceMs);
      });
    };
    const addChat = (c: ChatterV) => { chain = chain.then(() => this.addChatter(c)).catch(() => { }); };

    let note = '';
    let usedAI = false;
    const llm = this.deps.llm;
    const units = debate ? 2 : 1;
    const g = this.deps.guard.canRound(this.code, units);
    if (!llm) note = 'Claude is not connected here, so the traders ran on offline rules.';
    else if (this.deps.aiState.dead) note = 'The Anthropic API key was rejected, so the traders ran on offline rules.';
    else if (!g.ok) {
      note = g.reason === 'daily_cap' ? 'Today’s AI budget is used up, so offline rules took this one.' : g.reason === 'room_daily' ? 'This room has used its AI rounds for today, so offline rules took this one.' : `AI round limit for this room reached (${this.deps.cfg.aiRoundsPerMinPerRoom} a minute). Offline rules took this one.`;
      this.deps.guard.avoid();
    } else {
      this.deps.guard.takeRound(this.code, units);
      const effort = o.deep ? this.deps.cfg.effortDeep : this.deps.cfg.effortRound;
      const maxTok = o.deep ? 16000 : 6000;
      const ctx = this.ctx(isCheck ? null : text);
      const user = roundUser(ctx, isCheck ? null : text, o.origin);
      const errCopy = (code: string | null) => ({
        rate_limited: 'Claude is rate-limited right now. Offline rules took this one; try again in a minute.',
        auth: 'The Anthropic API key was rejected, so the traders are running on simple offline rules.',
        refused: 'Claude declined that headline. Offline rules handled it instead.',
        timeout: 'Claude took too long, so offline rules finished the round.',
      } as Record<string, string>)[code ?? ''] || 'Claude could not answer that one, so offline rules handled it.';
      if (!debate) {
        const r = await this.callAI(SYSTEM_ROUND, user, this.deps.cfg.models.round, effort, maxTok, line => {
          const obj = parseLine(line); if (!obj) return;
          if (obj.type === 'desk') { const d = validateDesk(obj); if (d) applyDesk(d); }
          else if (obj.type === 'chatter') { const c = validateChatter(obj); if (c) addChat({ ...c, kind: 'chatter' }); }
          else if (obj.type === 'trade' || obj.id) { const d = validateDecision(obj, this.limits); if (d) applyTrade(d); }
        }, isCheck ? 'check' : o.origin === 'LIVE' ? 'live_round' : 'round');
        usedAI = !!r.usage;
        if (r.code) note = errCopy(r.code);
      } else {
        // ---- floor debate: phase 1, opening views (nothing executes) ----
        this.stats.debates++;
        if (o.debateAct) this.broadcast({ k: 'act', title: o.debateAct, sub: 'Six AI traders argue before anyone trades.' });
        const views = new Map<string, Decision>();
        const r1 = await this.callAI(SYSTEM_DEBATE_OPEN, user, this.deps.cfg.models.debate, effort, maxTok, line => {
          const obj = parseLine(line); if (!obj) return;
          if (obj.type === 'desk') { const d = validateDesk(obj); if (d) applyDesk(d); }
          else if (obj.type === 'view') {
            const v = validateDecision(obj, this.limits); if (!v || views.has(v.id)) return;
            views.set(v.id, v);
            const a = this.agents.find(x => x.id === v.id)!;
            a.opening = { action: v.action, qty: v.qty, conviction: v.conviction, call: v.call, thought: v.thought };
            a.thinking = 'Debating…'; a.signals = v.signals;
            this.broadcast({ k: 'agent', a: this.agentV(a) });
          }
        }, 'debate_open');
        usedAI = !!r1.usage;
        if (r1.code && views.size < 4) note = errCopy(r1.code);
        else if (views.size >= 4 && getDesk()) {
          // ---- phase 2: challenges, then final decisions (executed) ----
          this.round = { ...this.round, phase: 'deciding', status: 'Challenges flying. Final calls incoming…' };
          this.sendRound();
          const open: OpeningView[] = [...views.values()].map(v => ({ id: v.id, action: v.action, qty: v.qty, conviction: v.conviction, call: v.call, thought: v.thought }));
          const lastChallenger = new Map<string, string>();
          const r2 = await this.callAI(SYSTEM_DEBATE_FINAL, debateUser(this.ctx(text), text, o.origin, open, getDesk()!.read), this.deps.cfg.models.debate, effort, maxTok, line => {
            const obj = parseLine(line); if (!obj) return;
            if (obj.type === 'challenge') { const c = validateChatter(obj); if (c) { if (c.to) lastChallenger.set(c.to, c.id); addChat({ ...c, kind: 'challenge' }); } }
            else if (obj.type === 'trade' || obj.id) {
              const d = validateDecision(obj, this.limits); if (!d) return;
              const v = views.get(d.id);
              const a = this.agents.find(x => x.id === d.id)!;
              if (v && (v.action !== d.action)) {
                a.changed = { from: v.action.toUpperCase(), to: d.action.toUpperCase() };
                const by = lastChallenger.get(d.id);
                this.tell.onMindChange(a.name, v.action.toUpperCase(), d.action.toUpperCase(), by ? this.nameOf(by) : null, this.eng.clock(), this.eng.S.t);
              }
              applyTrade(d);
            }
          }, 'debate_final');
          if (r2.code) {
            note = 'The debate was cut short; traders acted on their opening views.';
            for (const v of views.values()) applyTrade(v);
          }
        } else if (views.size) for (const v of views.values()) applyTrade(v);
      }
    }

    if (!getDesk() || done.size < AGENTS.length) {
      if (!usedAI) this.stats.offlineRounds++;
      const off = offline(isCheck ? null : text, this.eng.S.last, this.eng.S.open, this.R);
      if (!getDesk()) applyDesk(validateDesk(off.desk as unknown as Record<string, unknown>)!);
      off.trades.forEach(t => { if (!done.has(t.id)) { const d = validateDecision(t as unknown as Record<string, unknown>, this.limits); if (d) applyTrade(d); } });
    } else if (usedAI) this.stats.aiRounds++;
    await chain;
    this.tell.onRoundEnd(isCheck ? null : text, decided, this.eng.clock(), this.eng.S.t);
    void this.deps.store.logNews({
      room_code: this.code, no: item.no ?? null, kind: item.kind, origin: item.origin ?? null, by_name: item.by ?? null, headline: item.text,
      source: item.source ?? null, url: item.url ?? null, published_at: item.at ?? null, impact: item.impact ?? null, read: item.read ?? null,
      model: usedAI ? this.deps.cfg.models.round : 'offline', tokens_in: null, tokens_out: null,
    });
    this.agents.forEach(a => { a.thinking = null; });
    this.round = { busy: false, note };
    if (!this.disposed) { this.sendRound(); this.sendStats(); }
    setImmediate(() => this.pumpLive());
    return true;
  }

  private async addChatter(c: ChatterV) {
    this.chatter.unshift(c); if (this.chatter.length > 4) this.chatter.length = 4;
    this.broadcast({ k: 'chatter', c });
    await sleep(this.deps.cfg.chatterPaceMs);
  }

  /** Executes one validated decision. The engine decides what actually fills. */
  execAgent(d: Decision, headline: string | null, category: string) {
    const S = this.eng.S;
    const a = this.agents.find(x => x.id === d.id)!;
    this.eng.cancel(a.id);
    let label = 'HOLD', fill = '';
    let queued = false, avgFill: number | null = null, filled = 0;
    if (d.action !== 'hold') {
      const sd = d.action;
      let res = this.eng.submit(a.id, sd, d.qty, d.limit);
      if (d.limit == null && !res.queued && res.filled < d.qty) {          // thin book: park the rest just through the last print
        const px = r2(S.last * (sd === 'buy' ? 1.004 : 0.996));
        const r2nd = this.eng.submit(a.id, sd, d.qty - res.filled, px);
        res = { filled: res.filled + r2nd.filled, avg: (res.filled * res.avg + r2nd.filled * r2nd.avg) / Math.max(1, res.filled + r2nd.filled), rest: r2nd.rest };
      }
      queued = !!res.queued; if (res.filled) { avgFill = res.avg; filled = res.filled; }
      label = `${d.action.toUpperCase()} ${fi(d.qty)} · ${d.limit != null ? 'LMT ' + f2(d.limit) : 'MKT'}`;
      fill = queued ? 'queued for reopen' : res.filled ? `filled ${fi(res.filled)} @ ${f2(res.avg)}${res.rest ? ` · ${fi(res.rest)} resting` : ''}` : res.rest ? 'resting on the book' : 'no liquidity';
    }
    if (avgFill) { this.addFill(a.id, d.action as Side, avgFill); this.noteTrade(a.id, d.action as Side, filled, avgFill); }
    let newLesson = false;
    if (d.lesson.length > 6) {
      a.lessons.unshift(d.lesson); a.lessons.length = Math.min(a.lessons.length, 6);
      newLesson = true;
      void this.deps.store.saveLessons(this.code, a.id, a.lessons);
    }
    this.sb.record({ who: a.id, ai: true, t: S.t, px: S.last, call: d.call, conviction: d.conviction, action: d.action, qty: filled, fill: avgFill, head: headline || 'Floor check', category, clock: this.eng.clock().slice(0, 5) });
    a.callPx = S.last; a.callPnl = this.pnl(a.id);
    a.lastAct = { side: d.action, label, fill, queued };
    a.conv = d.conviction; a.thought = d.thought; a.thinking = null; a.call = d.call; a.signals = d.signals;
    a.log.unshift({ time: this.eng.clock().slice(0, 5), head: headline || 'Floor check', act: `${label} · calls ${d.call.toUpperCase()} (${d.conviction}%)`, thought: a.thought });
    if (a.log.length > 30) a.log.length = 30;
    this.broadcast({ k: 'agent', a: this.agentV(a), flash: true, newLesson });
    this.flush();
  }

  // ---------- smaller Claude calls (fast models) ----------
  private async small(system: string, user: string, model: string, onText: (full: string) => void, maxTokens: number, kind: string): Promise<{ text: string; err?: string }> {
    const llm = this.deps.llm;
    if (!llm || this.deps.aiState.dead) return { text: '', err: 'nollm' };
    if (!this.deps.guard.takeSmall()) { this.deps.guard.avoid(); return { text: '', err: 'cap' }; }
    let full = '';
    const t0 = Date.now();
    let usage: LLMUsage | null = null;
    const ac = new AbortController();
    const dog = setTimeout(() => ac.abort(), this.deps.cfg.aiRoundTimeoutMs);
    try {
      usage = await llm.stream({ model, system, prompt: user, maxTokens, effort: 'low', signal: ac.signal }, delta => { full += delta; onText(full); });
      return { text: full };
    } catch (e) {
      const code = e instanceof LLMError ? e.code : 'error';
      if (code === 'auth') { this.deps.aiState.dead = true; this.broadcast({ k: 'room', room: this.info() }); }
      return { text: full, err: code };
    } finally {
      clearTimeout(dog);
      this.deps.guard.record({ room: this.code, kind, model: usage?.model ?? model, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0, ms: Date.now() - t0, ok: !!usage });
    }
  }

  /** "Claude writes the news" (player) or the lab's auto-news (no player). */
  private async surprise(c: Conn | null, p: Player | null, deep: boolean, debate: boolean) {
    if (this.round.busy) { if (c) this.toast(c, `A round is already in flight${this.round.by ? ` (${this.round.by})` : ''}. Try again when it lands.`, 'news'); return; }
    if (!this.aiOn()) { if (c) this.toast(c, 'Claude is not connected here. Type a headline or pick one above.', 'news'); return; }
    this.round = { busy: true, by: p?.name ?? 'AI desk', status: 'Claude is writing a headline…' };
    this.sendRound();
    const pr = surprisePrompt(this.ctx());
    const r = await this.small(pr.system, pr.user, this.deps.cfg.models.news, () => { }, 200, 'headline');
    let h = '';
    try { const o = JSON.parse(r.text.trim().replace(/^```\w*|```$/g, '').match(/\{[\s\S]*\}/)?.[0] ?? '{}'); h = cleanText(o?.headline, 220); } catch { h = ''; }
    this.round = { busy: false, note: h ? '' : r.err === 'cap' ? 'Today’s AI budget is used up. Type a headline instead.' : 'Claude could not write a headline just now. Type one instead.' };
    this.sendRound();
    if (h) await this.runRound({ text: h, byName: p ? `${p.name} asked Claude` : 'AI desk', origin: 'AI', deep, debate: debate || undefined });
  }

  private async wrap(c: Conn) {
    const stream = (text: string, done: boolean, error?: string) => this.sendTo(c, { k: 'stream', kind: 'wrap', text, done, error });
    if (!this.aiOn()) return stream('The market wrap needs Claude, which is not connected in this view.', true);
    if (Date.now() - this.lastWrap < 20_000) return stream('', true, 'A wrap was just written. Try again in a few seconds.');
    this.lastWrap = Date.now();
    stream('Writing…', false);
    const board = this.standings().map(r => `${r.name}${r.human ? ' (human player)' : ''}: P&L ${money(r.pnl)}, holds ${fi(this.eng.S.accounts[r.id]?.sh ?? 0)} sh`).join('\n');
    const moments = this.tell.stories.slice().reverse().filter(s => s.weight >= 2).slice(-10).map(s => `${s.clock} ${s.text}`).join('\n');
    const pr = wrapPrompt(this.ctx(), board, moments);
    const r = await this.small(pr.system, pr.user, this.deps.cfg.models.narrator, full => stream(full, false), 700, 'wrap');
    if (r.err) stream(r.text, true, r.err === 'cap' ? 'Today’s AI budget is used up.' : 'The wrap could not be finished. Try again in a moment.');
    else stream(r.text, true);
  }

  private async ask(c: Conn, id: string, q: string) {
    const a = this.agents.find(x => x.id === id);
    const stream = (text: string, done: boolean, error?: string) => this.sendTo(c, { k: 'stream', kind: 'ask', text, done, error });
    if (!a || !q.trim()) return;
    if (!this.aiOn()) return stream('', true, 'Needs Claude, which is not connected here');
    stream('Thinking…', false);
    const pr = askPrompt(this.ctx(), a, q.trim());
    const r = await this.small(pr.system, pr.user, this.deps.cfg.models.ask, full => stream(full, false), 400, 'ask');
    if (r.err) stream(r.text, true, r.err === 'cap' ? 'Today’s AI budget is used up.' : 'The answer was cut off. Ask again in a moment.');
    else stream(r.text, true);
  }

  /** Admin view of this room. */
  admin() {
    const g = this.deps.guard.roomStats(this.code);
    const feed = this.deps.hub?.feeds.get(this.ticker);
    return {
      code: this.code, mode: this.mode, ticker: this.ticker, seed: this.seed, players: this.players.size, online: this.online, watchers: this.watchers.size,
      speed: this.speed, session: this.session, regime: this.intelV.regime.name, lab: this.lab, scenario: this.scen?.def.id ?? null,
      round: this.round.busy ? (this.round.by ?? 'busy') : null, liveQueue: this.liveQueue.length,
      rounds: this.stats, aiAvgMs: this.stats.aiRounds + this.stats.debates ? Math.round(this.stats.aiMs / Math.max(1, this.stats.aiRounds + this.stats.debates * 2)) : null,
      ...g, frameMsAvg: +this.perf.frameMsAvg.toFixed(3), frameMsMax: +this.perf.frameMsMax.toFixed(2), msgsSent: this.perf.msgs, mbSent: +(this.perf.bytes / 1e6).toFixed(1),
      quoteAgeSec: feed?.quote ? Math.round((Date.now() - feed.quote.time) / 1000) : null, pendingCalls: this.sb.pending.length,
      memory: Object.fromEntries(AGENTS.map(a => [a.id, { calls: this.sb.get(a.id).calls, correct: this.sb.get(a.id).correct }])),
    };
  }

  /** For experiments: the measured stats under this room's AI configuration. */
  experiment(): { lab: string; stats: Record<string, TraderStats> } {
    return { lab: `memory=${this.lab.memory ? 'on' : 'off'} · debate=${this.lab.debate}`, stats: this.sb.toJSON() };
  }
}

export function cleanName(s: string) {
  return String(typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}
function uniqueName(name: string, taken: string[]) {
  const reserved = [...AGENTS.map(a => a.name.toLowerCase()), 'you', 'live wire', 'ai desk'];
  let n = name, i = 2;
  while (taken.some(t => t.toLowerCase() === n.toLowerCase()) || reserved.includes(n.toLowerCase())) n = `${name} ${i++}`;
  return n;
}
