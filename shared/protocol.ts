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

export interface NewsV {
  id: number;
  kind: 'news' | 'sys' | 'check';
  no?: number;
  text: string;
  time: string;
  impact?: number | null;
  read?: string;
  /** LIVE = real headline from the data provider; PLAYER = typed or requested by a player. */
  origin?: 'LIVE' | 'PLAYER';
  by?: string;
  source?: string;
  /** Real-world publish time for LIVE headlines (ISO). */
  at?: string;
  url?: string;
}

export interface AgentV {
  id: string; name: string; tag: string; voice: string;
  thought: string; conv: number;
  lastAct: { side: string; label: string; fill: string; queued?: boolean } | null;
  lessons: string[];
  log: { time: string; head: string; act: string; thought: string }[];
  thinking?: string | null;
}

export interface PlayerV { id: string; name: string; color: string; host: boolean; online: boolean }

/** Account summary: [cash, shares, starting value, cost basis of open position]. */
export type AccV = [number, number, number, number];

export interface RoomInfo {
  code: string;
  mode: Mode;
  ticker: string;
  company: string;
  speed: number;
  hostId: string | null;
  presets: string[];
  ai: { label: string; on: boolean };
  /** Real mode only. */
  real?: { price: number | null; asOf: string | null; marketOpen: boolean | null; session: string | null; provider: string };
}

export interface RoundState { busy: boolean; by?: string; headline?: string; status?: string; note?: string }

export interface Delta {
  t: number; clock: string; last: number; open: number; hi: number; lo: number; vwap: number | null; vol: number;
  halted: number; trades: TradeV[]; candles: CandleV[]; book: { bids: LevelV[]; asks: LevelV[] };
  acc: Record<string, AccV>;
  halts?: HaltV[]; fills?: FillV[]; markers?: MarkerV[];
  ev?: ({ type: 'halt'; dir: 'up' | 'down'; t: number } | { type: 'resume'; price: number; t: number })[];
}

export interface Snapshot extends Delta {
  halts: HaltV[]; fills: FillV[]; markers: MarkerV[];
  agents: AgentV[]; players: PlayerV[]; wire: NewsV[]; chatter: ChatterV[]; round: RoundState;
}

export interface ChatterV { id: string; to: string; line: string }

export type ServerMsg =
  | { k: 'hello'; you: PlayerV; room: RoomInfo; snap: Snapshot }
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
  | { k: 'stream'; kind: 'wrap' | 'ask'; text: string; done: boolean; error?: string }
  | { k: 'err'; text: string };

export type ClientMsg =
  | { k: 'join'; room: string; token: string; name: string }
  | { k: 'order'; side: Side; qty: number }
  | { k: 'flatten' }
  | { k: 'news'; text: string; deep?: boolean }
  | { k: 'check'; deep?: boolean }
  | { k: 'surprise'; deep?: boolean }
  | { k: 'wrap' }
  | { k: 'ask'; id: string; q: string }
  | { k: 'host'; action: 'speed'; value: number }
  | { k: 'host'; action: 'reset' }
  | { k: 'ping'; t: number };

export const ORDER_SIZES = [100, 500, 2000, 5000];
