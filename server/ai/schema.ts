// The model proposes; the engine decides. Every line Claude returns is checked here
// before it can touch the market. Anything malformed is dropped (the offline rules
// fill the gap); anything out of range is clamped to what is legal right now.

import { AGENT_IDS } from '../agents.js';

export type Action = 'buy' | 'sell' | 'hold';
export type Call = 'up' | 'down' | 'flat';
export const SIGNAL_KEYS = ['news', 'trend', 'value', 'flow', 'risk'] as const;
export type SignalKey = typeof SIGNAL_KEYS[number];
export type Signals = Record<SignalKey, number>;
export const DESK_KINDS = ['confirmed', 'rumour', 'opinion', 'noise'] as const;
export const DESK_CATEGORIES = ['earnings', 'guidance', 'legal', 'management', 'product', 'competition', 'deal', 'macro', 'supply', 'other'] as const;

export interface Desk { impact: number; speed: 'fast' | 'slow'; read: string; kind: typeof DESK_KINDS[number]; category: typeof DESK_CATEGORIES[number] }
export interface Decision {
  id: string; action: Action; qty: number; order: 'market' | 'limit'; limit: number | null;
  conviction: number; call: Call; signals: Signals; thought: string; lesson: string; changed: boolean;
}
export interface Chatter { id: string; to: string; line: string }

/** Plain, single-line text: no control characters, no markup, bounded length. */
/** Only real strings and numbers become text; objects (e.g. {"toString":0}) never get coerced. */
const asText = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

export function cleanText(v: unknown, max: number): string {
  return asText(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Untrusted text placed inside a prompt: angle brackets can't open or close our tags. */
export function quoteUntrusted(v: unknown, max: number): string {
  return asText(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim().slice(0, max);
}

const num = (v: unknown) => { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : NaN; };
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function validateDesk(o: Record<string, unknown>): Desk | null {
  const impact = num(o.impact);
  if (Number.isNaN(impact)) return null;
  const kind = asText(o.kind).toLowerCase();
  const cat = asText(o.category).toLowerCase();
  return {
    impact: +clamp(impact, -45, 60).toFixed(1),
    speed: o.speed === 'fast' ? 'fast' : 'slow',
    read: cleanText(o.read, 300),
    kind: (DESK_KINDS as readonly string[]).includes(kind) ? kind as Desk['kind'] : 'confirmed',
    category: (DESK_CATEGORIES as readonly string[]).includes(cat) ? cat as Desk['category'] : 'other',
  };
}

export interface TradeLimits {
  /** Current position, shares. */
  pos: number;
  /** Max shares this trader may trade this round (risk budget, ≤ 6000). */
  maxQty: number;
  /** Position limit, shares (±). */
  maxPos: number;
  /** Last price, for limit-order sanity. */
  last: number;
}

/** Validates one trader decision. Returns null when it can't be trusted at all. */
export function validateDecision(o: Record<string, unknown>, lim: (id: string) => TradeLimits | null): Decision | null {
  const id = asText(o.id);
  if (!AGENT_IDS.includes(id)) return null;
  const L = lim(id); if (!L) return null;
  const rawAction = asText(o.action).toLowerCase();
  if (!['buy', 'sell', 'hold'].includes(rawAction)) return null;
  let action = rawAction as Action;
  const q = num(o.qty);
  let qty = Number.isNaN(q) ? 0 : Math.floor(clamp(q, 0, L.maxQty));
  if (action === 'buy') qty = Math.min(qty, Math.max(0, L.maxPos - L.pos));
  if (action === 'sell') qty = Math.min(qty, Math.max(0, L.pos + L.maxPos));
  if (action !== 'hold' && qty <= 0) action = 'hold';
  if (action === 'hold') qty = 0;
  let order: 'market' | 'limit' = o.order === 'limit' ? 'limit' : 'market';
  let limit: number | null = null;
  if (order === 'limit') {
    const l = num(o.limit);
    if (!Number.isNaN(l) && l > 0 && Math.abs(l / L.last - 1) <= 0.3) limit = Math.round(l * 100) / 100;
    else order = 'market';
  }
  const conv = num(o.conviction);
  const call = asText(o.call).toLowerCase();
  const sig = (o.signals && typeof o.signals === 'object' ? o.signals : {}) as Record<string, unknown>;
  const signals = Object.fromEntries(SIGNAL_KEYS.map(k => { const v = num(sig[k]); return [k, Number.isNaN(v) ? 0 : Math.round(clamp(v, -2, 2))]; })) as Signals;
  return {
    id, action, qty, order, limit,
    conviction: Number.isNaN(conv) ? 50 : Math.round(clamp(conv, 0, 100)),
    call: call === 'up' || call === 'down' || call === 'flat' ? call : action === 'buy' ? 'up' : action === 'sell' ? 'down' : 'flat',
    signals,
    thought: cleanText(o.thought, 260) || '…',
    lesson: cleanText(o.lesson, 140),
    changed: o.changed === true,
  };
}

export function validateChatter(o: Record<string, unknown>): Chatter | null {
  const id = asText(o.id), to = asText(o.to);
  const line = cleanText(o.line, 200);
  if (!AGENT_IDS.includes(id) || !line) return null;
  return { id, to: AGENT_IDS.includes(to) && to !== id ? to : '', line };
}
