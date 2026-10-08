// Persistence. Two implementations: MemoryStore (default, no setup) and
// SupabaseStore (when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set).

import type { Mode } from '../../shared/protocol.js';

export interface RoomRow { code: string; mode: Mode; ticker: string; host_token: string; created_at?: string }
export interface PlayerRow { room_code: string; token: string; pid: string; name: string; color: string; cash: number; shares: number; cost: number; start_value: number }
export interface NewsRow { room_code: string; no: number | null; kind: string; origin: string | null; by_name: string | null; headline: string; source: string | null; url: string | null; published_at: string | null; impact: number | null; read: string | null; model: string | null; tokens_in: number | null; tokens_out: number | null }
export interface LeaderRow { room_code: string; name: string; pnl: number; is_ai: boolean }

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
}
