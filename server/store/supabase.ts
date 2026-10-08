import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LeaderRow, LegendRow, NewsRow, PlayerRow, RoomRow, Store } from './store.js';
import type { TraderStats } from '../intel/stats.js';
import type { DayUsage } from '../costguard.js';

/**
 * Supabase Postgres via the service-role key (server only; never sent to browsers).
 * Tables are created by supabase/schema.sql. Writes are best-effort: a database
 * hiccup is logged and the game keeps running from memory.
 */
export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceKey: string, fetchFn?: typeof fetch) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, ...(fetchFn ? { global: { fetch: fetchFn } } : {}) });
  }

  private warn(what: string, error: unknown) { if (error) throw new Error(`${what}: ${String((error as { message?: string }).message ?? error)}`); }

  async createRoom(r: RoomRow) { const { error } = await this.db.from('rooms').insert(r); this.warn('createRoom', error); }
  async getRoom(code: string) {
    const { data, error } = await this.db.from('rooms').select('code,mode,ticker,host_token,seed,created_at').eq('code', code).maybeSingle();
    this.warn('getRoom', error); return (data as RoomRow) ?? null;
  }
  async touchRoom(code: string) { const { error } = await this.db.from('rooms').update({ last_active_at: new Date().toISOString() }).eq('code', code); this.warn('touchRoom', error); }
  async loadPlayers(code: string) {
    const { data, error } = await this.db.from('players').select('room_code,token,pid,name,color,cash,shares,cost,start_value').eq('room_code', code);
    this.warn('loadPlayers', error); return (data as PlayerRow[]) ?? [];
  }
  async savePlayers(rows: PlayerRow[]) {
    if (!rows.length) return;
    const { error } = await this.db.from('players').upsert(rows.map(r => ({ ...r, updated_at: new Date().toISOString() })), { onConflict: 'room_code,token' });
    this.warn('savePlayers', error);
  }
  async loadLessons(code: string) {
    const { data, error } = await this.db.from('trader_lessons').select('agent_id,lessons').eq('room_code', code);
    this.warn('loadLessons', error);
    const out: Record<string, string[]> = {};
    for (const r of (data as { agent_id: string; lessons: string[] }[]) ?? []) out[r.agent_id] = r.lessons ?? [];
    return out;
  }
  async saveLessons(code: string, agentId: string, lessons: string[]) {
    const { error } = await this.db.from('trader_lessons').upsert({ room_code: code, agent_id: agentId, lessons, updated_at: new Date().toISOString() }, { onConflict: 'room_code,agent_id' });
    this.warn('saveLessons', error);
  }
  async logNews(r: NewsRow) { const { error } = await this.db.from('news_log').insert(r); this.warn('logNews', error); }
  async saveLeaderboard(rows: LeaderRow[]) { if (!rows.length) return; const { error } = await this.db.from('leaderboards').insert(rows); this.warn('saveLeaderboard', error); }
  async loadStats(code: string) {
    const { data, error } = await this.db.from('trader_stats').select('agent_id,stats').eq('room_code', code);
    this.warn('loadStats', error);
    return Object.fromEntries(((data as { agent_id: string; stats: TraderStats }[]) ?? []).map(r => [r.agent_id, r.stats]));
  }
  async saveStats(code: string, agentId: string, stats: TraderStats, lab: string) {
    const { error } = await this.db.from('trader_stats').upsert({ room_code: code, agent_id: agentId, stats, lab, updated_at: new Date().toISOString() }, { onConflict: 'room_code,agent_id' });
    this.warn('saveStats', error);
  }
  async loadUsage(day: string) {
    const { data, error } = await this.db.from('ai_usage_daily').select('day,rounds,small,tokens_in,tokens_out,cost_usd').eq('day', day).maybeSingle();
    this.warn('loadUsage', error);
    const r = data as { day: string; rounds: number; small: number; tokens_in: number; tokens_out: number; cost_usd: number } | null;
    return r ? { day: r.day, rounds: r.rounds, small: r.small, tokensIn: r.tokens_in, tokensOut: r.tokens_out, cost: r.cost_usd } : null;
  }
  async saveUsage(u: DayUsage) {
    const { error } = await this.db.from('ai_usage_daily').upsert({ day: u.day, rounds: u.rounds, small: u.small, tokens_in: u.tokensIn, tokens_out: u.tokensOut, cost_usd: u.cost, updated_at: new Date().toISOString() }, { onConflict: 'day' });
    this.warn('saveUsage', error);
  }
  async loadLegends() {
    const { data, error } = await this.db.from('legends').select('key,holder,value,detail,room_code,at');
    this.warn('loadLegends', error); return (data as LegendRow[]) ?? [];
  }
  async saveLegend(r: LegendRow) { const { error } = await this.db.from('legends').upsert(r, { onConflict: 'key' }); this.warn('saveLegend', error); }
}
