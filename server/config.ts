// All settings come from environment variables (see .env.example).
// Missing keys never crash the app: each one falls back to a mock or to memory.

import { existsSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile('.env'); } catch { /* malformed .env: ignore and use real env */ }
}

const str = (k: string, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && (process.env[k] ?? '').trim() !== '' ? v : d; };

export interface Config {
  port: number;
  publicDir: string;
  anthropicKey: string;
  /** auto = real Claude if a key is set, mock otherwise. */
  aiProvider: 'auto' | 'anthropic' | 'mock' | 'off';
  modelRound: string;
  modelFast: string;
  effortRound: 'low' | 'medium' | 'high';
  effortDeep: 'low' | 'medium' | 'high';
  aiRoundsPerMinPerRoom: number;
  aiDailyRoundCap: number;
  aiDailySmallCap: number;
  finnhubKey: string;
  marketProvider: 'auto' | 'finnhub' | 'mock';
  quotePollSec: number;
  newsPollSec: number;
  supabaseUrl: string;
  supabaseServiceKey: string;
  roundPaceMs: number;
  chatterPaceMs: number;
  maxRooms: number;
  maxPlayersPerRoom: number;
  mockNewsEverySec: number;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  return {
    port: num('PORT', 8787),
    publicDir: str('PUBLIC_DIR', 'dist'),
    anthropicKey: str('ANTHROPIC_API_KEY'),
    aiProvider: str('AI_PROVIDER', 'auto') as Config['aiProvider'],
    modelRound: str('AI_MODEL_ROUND', 'claude-sonnet-5-5'),
    modelFast: str('AI_MODEL_FAST', 'claude-haiku-5-5'),
    effortRound: str('AI_EFFORT_ROUND', 'low') as Config['effortRound'],
    effortDeep: str('AI_EFFORT_DEEP', 'high') as Config['effortDeep'],
    aiRoundsPerMinPerRoom: num('AI_ROUNDS_PER_MIN_PER_ROOM', 3),
    aiDailyRoundCap: num('AI_DAILY_ROUND_CAP', 200),
    aiDailySmallCap: num('AI_DAILY_SMALL_CAP', 400),
    finnhubKey: str('FINNHUB_API_KEY'),
    marketProvider: str('MARKET_PROVIDER', 'auto') as Config['marketProvider'],
    quotePollSec: num('QUOTE_POLL_SEC', 15),
    newsPollSec: num('NEWS_POLL_SEC', 180),
    supabaseUrl: str('SUPABASE_URL'),
    supabaseServiceKey: str('SUPABASE_SECRET_KEY') || str('SUPABASE_SERVICE_ROLE_KEY'),
    roundPaceMs: num('ROUND_PACE_MS', 700),
    chatterPaceMs: num('CHATTER_PACE_MS', 900),
    maxRooms: num('MAX_ROOMS', 50),
    maxPlayersPerRoom: num('MAX_PLAYERS_PER_ROOM', 12),
    mockNewsEverySec: num('MOCK_NEWS_EVERY_SEC', 240),
    ...over,
  };
}

