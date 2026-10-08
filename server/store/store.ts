// Persistence. Two implementations: MemoryStore (default, no setup) and
// SupabaseStore (when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set).

import type { Mode } from '../../shared/protocol.js';
import type { TraderStats } from '../intel/stats.js';
import type { DayUsage } from '../costguard.js';

/** host_token and token hold a SHA-256 hash of the browser's secret, never the secret itself. */
export interface RoomRow { code: string; mode: Mode; ticker: string; host_token: string; seed?: number; created_at?: string }
export interface PlayerRow { room_code: string; token: string; pid: string; name: string; color: string; cash: number; shares: number; cost: number; start_value: number }
export interface NewsRow { room_code: string; no: number | null; kind: string; origin: string | null; by_name: string | null; headline: string; source: string | null; url: string | null; published_at: string | null; impact: number | null; read: string | null; model: string | null; tokens_in: number | null; tokens_out: number | null }
export interface LeaderRow { room_code: string; name: string; pnl: number; is_ai: boolean }
/** One all-time record (see server/legends.ts). */
export interface LegendRow { key: string; holder: string; value: number; detail: string; room_code: string; at: string }

export interface Store {
  readonly kind: 'memory' | 'supabase';
  createRoom(r: RoomRow): Promise<void>;
  getRoom(code: string): Promise<RoomRow | null>;
  touchRoom(code: string): Promise<void>;
  loadPlayers(code: string): Promise<PlayerRow[]>;
  savePlayers(rows: PlayerRow[]): Promise<void>;
  loadLessons(code: string): Promise<Record<string, string[]>>;
  saveLessons(code: string, agentId: string, lessons: string[]): Promise<void>;
  logNews(r: NewsRow): Promise<void>;
  saveLeaderboard(rows: LeaderRow[]): Promise<void>;
  loadStats(code: string): Promise<Record<string, TraderStats>>;
  saveStats(code: string, agentId: string, stats: TraderStats, lab: string): Promise<void>;
  loadUsage(day: string): Promise<DayUsage | null>;
  saveUsage(u: DayUsage): Promise<void>;
  loadLegends(): Promise<LegendRow[]>;
  saveLegend(r: LegendRow): Promise<void>;
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  rooms = new Map<string, RoomRow>();
  players = new Map<string, PlayerRow>();
  lessons = new Map<string, Record<string, string[]>>();
  news: NewsRow[] = [];
  leaders: LeaderRow[] = [];
  async createRoom(r: RoomRow) { this.rooms.set(r.code, { ...r, created_at: new Date().toISOString() }); }
  async getRoom(code: string) { return this.rooms.get(code) ?? null; }
  async touchRoom() { }
  async loadPlayers(code: string) { return [...this.players.values()].filter(p => p.room_code === code).map(p => ({ ...p })); }
  async savePlayers(rows: PlayerRow[]) { rows.forEach(r => this.players.set(r.room_code + '/' + r.token, { ...r })); }
  async loadLessons(code: string) { return structuredClone(this.lessons.get(code) ?? {}); }
  async saveLessons(code: string, agentId: string, lessons: string[]) { const m = this.lessons.get(code) ?? {}; m[agentId] = [...lessons]; this.lessons.set(code, m); }
  async logNews(r: NewsRow) { this.news.push(r); if (this.news.length > 2000) this.news.shift(); }
  async saveLeaderboard(rows: LeaderRow[]) { this.leaders.push(...rows); if (this.leaders.length > 2000) this.leaders.splice(0, this.leaders.length - 2000); }
  stats = new Map<string, Record<string, { stats: TraderStats; lab: string }>>();
  usage: DayUsage | null = null;
  async loadStats(code: string) { return Object.fromEntries(Object.entries(this.stats.get(code) ?? {}).map(([k, v]) => [k, structuredClone(v.stats)])); }
  async saveStats(code: string, agentId: string, stats: TraderStats, lab: string) { const m = this.stats.get(code) ?? {}; m[agentId] = { stats: structuredClone(stats), lab }; this.stats.set(code, m); }
  async loadUsage(day: string) { return this.usage?.day === day ? { ...this.usage } : null; }
  async saveUsage(u: DayUsage) { this.usage = { ...u }; }
  legends = new Map<string, LegendRow>();
  async loadLegends() { return [...this.legends.values()].map(r => ({ ...r })); }
  async saveLegend(r: LegendRow) { this.legends.set(r.key, { ...r }); }
}

/**
 * Wraps any store so that a database outage can never throw into the game loop:
 * every call is caught, logged, and answered with an empty result.
 */
export class SafeStore implements Store {
  errors = 0;
  lastError: string | null = null;
  constructor(readonly inner: Store) {}
  get kind() { return this.inner.kind; }
  private async run<T>(what: string, f: () => Promise<T>, fallback: T): Promise<T> {
    try { return await f(); }
    catch (e) {
      this.errors++; this.lastError = `${what}: ${String((e as Error)?.message ?? e)}`;
      console.warn(JSON.stringify({ ev: 'db_error', what, error: this.lastError }));
      return fallback;
    }
  }
  createRoom(r: RoomRow) { return this.run('createRoom', () => this.inner.createRoom(r), undefined); }
  getRoom(code: string) { return this.run('getRoom', () => this.inner.getRoom(code), null); }
  touchRoom(code: string) { return this.run('touchRoom', () => this.inner.touchRoom(code), undefined); }
  loadPlayers(code: string) { return this.run('loadPlayers', () => this.inner.loadPlayers(code), [] as PlayerRow[]); }
  savePlayers(rows: PlayerRow[]) { return this.run('savePlayers', () => this.inner.savePlayers(rows), undefined); }
  loadLessons(code: string) { return this.run('loadLessons', () => this.inner.loadLessons(code), {} as Record<string, string[]>); }
  saveLessons(code: string, a: string, l: string[]) { return this.run('saveLessons', () => this.inner.saveLessons(code, a, l), undefined); }
  logNews(r: NewsRow) { return this.run('logNews', () => this.inner.logNews(r), undefined); }
  saveLeaderboard(rows: LeaderRow[]) { return this.run('saveLeaderboard', () => this.inner.saveLeaderboard(rows), undefined); }
  loadStats(code: string) { return this.run('loadStats', () => this.inner.loadStats(code), {} as Record<string, TraderStats>); }
  saveStats(code: string, a: string, s: TraderStats, lab: string) { return this.run('saveStats', () => this.inner.saveStats(code, a, s, lab), undefined); }
  loadUsage(day: string) { return this.run('loadUsage', () => this.inner.loadUsage(day), null); }
  saveUsage(u: DayUsage) { return this.run('saveUsage', () => this.inner.saveUsage(u), undefined); }
  loadLegends() { return this.run('loadLegends', () => this.inner.loadLegends(), [] as LegendRow[]); }
  saveLegend(r: LegendRow) { return this.run('saveLegend', () => this.inner.saveLegend(r), undefined); }
}
