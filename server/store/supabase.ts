import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { LeaderRow, NewsRow, PlayerRow, RoomRow, Store } from './store.js';

/**
 * Supabase Postgres via the service-role key (server only; never sent to browsers).
 * Tables are created by supabase/schema.sql. Writes are best-effort: a database
 * hiccup is logged and the game keeps running from memory.
 */
export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  private db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private warn(what: string, error: unknown) { if (error) console.warn(JSON.stringify({ ev: 'db_error', what, error: String((error as { message?: string }).message ?? error) })); }

  async createRoom(r: RoomRow) { const { error } = await this.db.from('rooms').insert(r); this.warn('createRoom', error); }
  async getRoom(code: string) {
    const { data, error } = await this.db.from('rooms').select('code,mode,ticker,host_token,created_at').eq('code', code).maybeSingle();
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
}
