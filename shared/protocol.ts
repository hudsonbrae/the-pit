// Wire protocol between the game server and the browser. Shared by both sides.

export type Side = 'buy' | 'sell';
export type Mode = 'sim' | 'real';

/** A print on the tape. buyer/seller are account ids (agents, players, or bot ids). */
export interface TradeV { id: number; price: number; q: number; aggr: Side; buyer: string; seller: string; t: number }
export interface CandleV { idx: number; t: number; o: number; h: number; l: number; c: number; v: number }
export interface HaltV { start: number; end: number | null; dir: 'up' | 'down'; t: number }
/** Book level: [price, qty, owners shown as coloured squares (agents and players only)]. */
export type LevelV = [number, number, string[]];
export interface FillV { idx: number; px: number; side: Side; owner: string }
export interface MarkerV { idx: number; no: number }

/**
 * Where a headline came from. Provenance is shown on every item:
 * LIVE = real news wire · PLAYER = typed by a player · AI = written by Claude · SCENARIO = scripted sim event.
 */
export type Origin = 'LIVE' | 'PLAYER' | 'AI' | 'SCENARIO';

export interface NewsV {
  id: number;
  kind: 'news' | 'sys' | 'check';
  no?: number;
  text: string;
  time: string;
  impact?: number | null;
  read?: string;
  origin?: Origin;
  by?: string;
  source?: string;
  /** Real-world publish time for LIVE headlines (ISO). */
  at?: string;
  url?: string;
  /** The desk's classification. */
  deskKind?: 'confirmed' | 'rumour' | 'opinion' | 'noise';
  category?: string;
  /** What the price actually did in the 60 s after the headline, % (filled in later). */
  moved?: number | null;
  debate?: boolean;
}

export type Signals = { news: number; trend: number; value: number; flow: number; risk: number };

export interface AgentV {
  id: string; name: string; tag: string; voice: string; playbook: string; edge: string; flaw: string;
  thought: string; conv: number;
  lastAct: { side: string; label: string; fill: string; queued?: boolean } | null;
  lessons: string[];
  log: { time: string; head: string; act: string; thought: string }[];
  thinking?: string | null;
  /** The trader's prediction for the next 60 s and the factors behind the decision (no chain of thought). */
  call?: 'up' | 'down' | 'flat' | null;
  signals?: Signals | null;
  /** Floor debate: their opening view, and whether the debate changed their mind. */
  opening?: { action: string; qty: number; conviction: number; call: string; thought: string } | null;
  changed?: { from: string; to: string } | null;
  budget?: number;
}

/** A trader's measured record (from scored calls). */
export interface TraderStatsV {
  calls: number; correct: number; streak: number; trades: number; wins: number; pnl: number;
  best: { pnl: number; head: string } | null; worst: { pnl: number; head: string } | null;
  avgConv: number; recent: boolean[]; stars: number; badges: string[];
  calibration: { lo: number; hi: number; n: number; acc: number | null }[];
  /** This session: return on starting equity and the worst peak-to-trough drop, both in %. */
  roi: number; maxDD: number;
  /** Measured: the news category they call best and worst (2+ calls each), and the average holding before they reverse, in sim seconds. */
  avgHold: number | null;
  bestCat: { cat: string; c: number; n: number } | null; worstCat: { cat: string; c: number; n: number } | null;
  /** Accuracy (%) with the AI majority, against it, and in stressed regimes; null until 3+ calls. */
  tend: { fol: [number, number]; fade: [number, number]; stress: [number, number] };
}

/** The room's running experiment (see server/intel/science.ts). Percentages, null until there is data. */
export interface ScienceV {
  debate: { open: number | null; final: number | null; n: number; flips: number; flipsRight: number };
  single: { acc: number | null; n: number };
  desk: { acc: number | null; n: number };
  herding: { calm: number | null; stressed: number | null };
  /** twins: same action in `rate` of `n` rounds; rivals: opposite sides (buy vs sell) in `rate` of `n`. */
  relations: { a: string; b: string; rate: number; n: number; kind: 'twins' | 'rivals' }[];
  verdict: string;
}

export interface PlayerV { id: string; name: string; color: string; host: boolean; online: boolean; badges?: AchievementId[] }

/** Account summary: [cash, shares, starting value, cost basis of open position]. */
export type AccV = [number, number, number, number];

export type Regime = 'CALM' | 'TRENDING UP' | 'TRENDING DOWN' | 'VOLATILE' | 'PANIC' | 'EUPHORIA' | 'LIQUIDITY CRUNCH' | 'NEWS-DRIVEN' | 'HALTED';

export interface IntelV {
  regime: { name: Regime; since: number };
  psych: { bull: number; greed: number; label: string; split: { buy: number; sell: number; hold: number }; trail: [number, number][] };
  book: { imb: number; ofi: number; buyV: number; sellV: number; spr: number; depth: number; depthRatio: number; signals: string[] };
  stats: { rv: number; r30: number; v1m: number };
  teams: { human: { pnl: number; ret: number; n: number }; ai: { pnl: number; ret: number }; leader: { id: string; name: string; human: boolean } | null };
  smart: { id: string; sh: number } | null;
  /** AI floor bullishness 0-100 (from their calls), humans' last-2-min fills (net shares, % buying), decayed headline pressure. */
  crowd: { aiBull: number; human: { net: number; bull: number } | null; news: { pressure: number; label: string } };
}

/** A storyline entry. weight 1 = timeline detail, 2 = moment, 3 = big moment. `title` names the moment ("THE FLOOR SPLITS"). */
export interface StoryV { id: number; kind: string; text: string; weight: 1 | 2 | 3; clock: string; who?: string; title?: string }
export type AchievementId = 'first_blood' | 'perfect_timing' | 'against_floor' | 'diamond_hands' | 'ai_slayer';

export interface LabV {
  vol: number;            // fair-value noise multiplier
  liq: number;            // market-maker size multiplier
  appetite: 'cautious' | 'normal' | 'aggressive';
  memory: boolean;        // track records fed back into prompts
  debate: 'off' | 'major' | 'always';
  autoNews: number;       // seconds between AI-written headlines, 0 = off (Sim only)
}

export interface RoomInfo {
  code: string;
  mode: Mode;
  ticker: string;
  company: string;
  speed: number;
  hostId: string | null;
  presets: string[];
  ai: { label: string; on: boolean };
  lab: LabV;
  seed: number;
  session: 'open' | 'closed';
  watchers: number;
  scenario: { id: string; name: string; act: string | null } | null;
  scenarios: { id: string; name: string; desc: string }[];
  /** Host chaos controls (Sim only). */
  chaos: { id: string; name: string; desc: string }[];
  /** Real mode only. */
  real?: { price: number | null; asOf: string | null; marketOpen: boolean | null; session: string | null; provider: string };
}

export interface RoundState { busy: boolean; by?: string; headline?: string; status?: string; note?: string; phase?: 'reading' | 'debate' | 'deciding' }

export interface Delta {
  t: number; clock: string; last: number; open: number; hi: number; lo: number; vwap: number | null; vol: number;
  halted: number; trades: TradeV[]; candles: CandleV[]; book: { bids: LevelV[]; asks: LevelV[] };
  acc: Record<string, AccV>;
  halts?: HaltV[]; fills?: FillV[]; markers?: MarkerV[];
  ev?: ({ type: 'halt'; dir: 'up' | 'down'; t: number } | { type: 'resume'; price: number; t: number })[];
  intel?: IntelV;
}

export interface Snapshot extends Delta {
  halts: HaltV[]; fills: FillV[]; markers: MarkerV[];
  agents: AgentV[]; players: PlayerV[]; wire: NewsV[]; chatter: ChatterV[]; round: RoundState;
  stories: StoryV[]; stats: Record<string, TraderStatsV>; oracle: string | null; intel: IntelV; science: ScienceV;
  /** Set for the first minute of a new session: what happened last time. */
  prev?: PrevV | null;
}

export interface ChatterV { id: string; to: string; line: string; kind?: 'chatter' | 'challenge' }

export interface RecapV {
  ticker: string; open: number; close: number; hi: number; lo: number; volume: number; halts: number;
  standings: { id: string; name: string; pnl: number; human: boolean }[];
  humans: { pnl: number; ret: number; traded: number }; ai: { pnl: number; ret: number };
  mostAccurate: { name: string; correct: number; calls: number } | null;
  biggestHeadline: { text: string; impact: number; moved: number | null } | null;
  mostSplit: string | null;
  biggestTrade: { name: string; qty: number; side: Side; price: number } | null;
  regimes: string[];
  moments: StoryV[];
  achievements: { name: string; title: string }[];
  science: ScienceV;
  /** The most confident right call and the most confident wrong one. */
  bestCall: { name: string; call: string; conviction: number; ret: number; head: string } | null;
  worstCall: { name: string; call: string; conviction: number; ret: number; head: string } | null;
  /** Fastest human trade after a headline, in seconds. */
  fastest: { name: string; secs: number } | null;
  /** All-time records set this session. */
  records: LegendV[];
}

/** An all-time record. */
export interface LegendV { key: string; title: string; holder: string; value: string; detail: string; at: string }

/** "Previously on The Pit": the last session, in a few lines. */
export interface PrevV { id: string; ticker: string; chg: number; winner: { name: string; pnl: number; human: boolean } | null; verdict: string; moments: { title: string; text: string }[]; records: string[] }

export type ServerMsg =
  | { k: 'hello'; you: PlayerV | null; room: RoomInfo; snap: Snapshot }
  | ({ k: 'd' } & Delta)
  | { k: 'wire'; wire: NewsV[] }
  | { k: 'agent'; a: AgentV; flash?: boolean; newLesson?: boolean }
  | { k: 'thinking'; text: string }
  | { k: 'chatter'; c: ChatterV }
  | { k: 'round'; r: RoundState; shake?: 'up' | 'down' }
  | { k: 'players'; players: PlayerV[] }
  | { k: 'room'; room: RoomInfo }
  | { k: 'reset'; snap: Snapshot }
  | { k: 'toast'; text: string; area?: 'seat' | 'news' }
  | { k: 'stream'; kind: 'wrap' | 'ask' | 'recap'; text: string; done: boolean; error?: string }
  | { k: 'story'; s: StoryV }
  | { k: 'stats'; stats: Record<string, TraderStatsV>; oracle: string | null; science: ScienceV }
  | { k: 'achievement'; id: AchievementId; title: string; desc: string }
  | { k: 'act'; title: string; sub: string }
  | { k: 'recap'; recap: RecapV }
  | { k: 'err'; text: string };

export type ClientMsg =
  | { k: 'join'; room: string; token: string; name: string; watch?: boolean }
  | { k: 'order'; side: Side; qty: number }
  | { k: 'flatten' }
  | { k: 'news'; text: string; deep?: boolean; debate?: boolean }
  | { k: 'check'; deep?: boolean }
  | { k: 'surprise'; deep?: boolean; debate?: boolean }
  | { k: 'wrap' }
  | { k: 'ask'; id: string; q: string }
  | { k: 'host'; action: 'speed'; value: number }
  | { k: 'host'; action: 'reset' }
  | { k: 'host'; action: 'close' }
  | { k: 'host'; action: 'lab'; lab: Partial<LabV> }
  | { k: 'host'; action: 'scenario'; id: string }
  | { k: 'host'; action: 'chaos'; id: string }
  | { k: 'ping'; t: number };

export const ORDER_SIZES = [100, 500, 2000, 5000];
export const DEFAULT_LAB: LabV = { vol: 1, liq: 1, appetite: 'normal', memory: true, debate: 'major', autoNews: 0 };
