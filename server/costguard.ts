// Cost guard and cost intelligence.
// Limits: AI rounds per room per minute, AI rounds per room per day, AI rounds per day
// across the server, small calls per day. When a limit is hit the game keeps working
// on the offline rules. Every call is logged with tokens and an estimated cost.
// The day's counters are persisted (see Store.saveUsage), so a restart doesn't reset them.

import { costUSD } from './costs.js';

export interface Usage { room: string; kind: string; model: string; inputTokens: number; outputTokens: number; ms: number; ok: boolean; cost?: number }
export interface DayUsage { day: string; rounds: number; small: number; tokensIn: number; tokensOut: number; cost: number }

export class CostGuard {
  private perRoom = new Map<string, number[]>();
  private roomDay = new Map<string, number>();
  private roomCost = new Map<string, number>();
  private byKind = new Map<string, { n: number; cost: number; ms: number }>();
  private day = '';
  rounds = 0;
  small = 0;
  tokensIn = 0;
  tokensOut = 0;
  cost = 0;
  avoided = 0;
  readonly log: Usage[] = [];
  /** Called after every change so the day's totals can be persisted. */
  onChange: ((u: DayUsage) => void) | null = null;

  constructor(private o: { roundsPerMin: number; dailyRounds: number; dailySmall: number; roomDailyRounds?: number }, private now = () => Date.now()) {}

  private rollDay() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.rounds = 0; this.small = 0; this.tokensIn = 0; this.tokensOut = 0; this.cost = 0; this.avoided = 0; this.roomDay.clear(); this.roomCost.clear(); this.byKind.clear(); }
  }

  /** Restores today's totals after a restart. */
  hydrate(u: DayUsage | null) {
    this.rollDay();
    if (!u || u.day !== this.day) return;
    this.rounds = Math.max(this.rounds, u.rounds); this.small = Math.max(this.small, u.small);
    this.tokensIn = Math.max(this.tokensIn, u.tokensIn); this.tokensOut = Math.max(this.tokensOut, u.tokensOut); this.cost = Math.max(this.cost, u.cost);
  }

  private changed() { this.onChange?.({ day: this.day, rounds: this.rounds, small: this.small, tokensIn: this.tokensIn, tokensOut: this.tokensOut, cost: +this.cost.toFixed(4) }); }

  /** Checks without consuming. `units` = how many AI calls the round needs (a debate is 2). */
  canRound(room: string, units = 1): { ok: true } | { ok: false; reason: 'room_rate' | 'daily_cap' | 'room_daily'; retryMs?: number } {
    this.rollDay();
    if (this.rounds + units > this.o.dailyRounds) return { ok: false, reason: 'daily_cap' };
    if ((this.roomDay.get(room) ?? 0) + units > (this.o.roomDailyRounds ?? Infinity)) return { ok: false, reason: 'room_daily' };
    const t = this.now(), arr = (this.perRoom.get(room) || []).filter(x => t - x < 60_000);
    this.perRoom.set(room, arr);
    if (arr.length + units > this.o.roundsPerMin) return { ok: false, reason: 'room_rate', retryMs: 60_000 - (t - (arr[0] ?? t)) };
    return { ok: true };
  }

  takeRound(room: string, units = 1) {
    this.rollDay(); this.rounds += units;
    this.roomDay.set(room, (this.roomDay.get(room) ?? 0) + units);
    const a = this.perRoom.get(room) || []; for (let i = 0; i < units; i++) a.push(this.now()); this.perRoom.set(room, a);
    this.changed();
  }

  takeSmall(): boolean { this.rollDay(); if (this.small >= this.o.dailySmall) return false; this.small++; this.changed(); return true; }

  /** A call the game chose not to make (cap, cooldown, offline). */
  avoid() { this.rollDay(); this.avoided++; }

  forgetRoom(room: string) { this.perRoom.delete(room); }

  record(u: Usage) {
    this.rollDay();
    const cost = u.ok ? costUSD(u.model, u.inputTokens, u.outputTokens) : 0;
    u.cost = +cost.toFixed(5);
    this.tokensIn += u.inputTokens; this.tokensOut += u.outputTokens; this.cost += cost;
    this.roomCost.set(u.room, (this.roomCost.get(u.room) ?? 0) + cost);
    const k = this.byKind.get(u.kind) ?? { n: 0, cost: 0, ms: 0 }; k.n++; k.cost += cost; k.ms += u.ms; this.byKind.set(u.kind, k);
    this.log.push(u); if (this.log.length > 200) this.log.shift();
    // One JSON line per AI call, so token usage per round is greppable in the host's logs.
    console.log(JSON.stringify({ ev: 'ai_usage', ...u }));
    this.changed();
  }

  roomStats(room: string) { this.rollDay(); return { roundsToday: this.roomDay.get(room) ?? 0, costToday: +(this.roomCost.get(room) ?? 0).toFixed(4) }; }

  stats() {
    this.rollDay();
    const last = this.log.at(-1);
    return {
      day: this.day, rounds: this.rounds, roundCap: this.o.dailyRounds, small: this.small, smallCap: this.o.dailySmall,
      tokensIn: this.tokensIn, tokensOut: this.tokensOut, costUSD: +this.cost.toFixed(4), avoided: this.avoided,
      lastCallUSD: last?.cost ?? null,
      byKind: Object.fromEntries([...this.byKind].map(([k, v]) => [k, { calls: v.n, costUSD: +v.cost.toFixed(4), avgMs: Math.round(v.ms / v.n) }])),
    };
  }
}
