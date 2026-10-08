// Cost guard: a per-room limit on AI trade rounds per minute and global daily caps.
// When a limit is hit the game keeps working on the offline rules.

export interface Usage { room: string; kind: string; model: string; inputTokens: number; outputTokens: number; ms: number; ok: boolean }

export class CostGuard {
  private perRoom = new Map<string, number[]>();
  private day = '';
  rounds = 0;
  small = 0;
  tokensIn = 0;
  tokensOut = 0;
  readonly log: Usage[] = [];

  constructor(private o: { roundsPerMin: number; dailyRounds: number; dailySmall: number }, private now = () => Date.now()) {}

  private rollDay() {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.rounds = 0; this.small = 0; this.tokensIn = 0; this.tokensOut = 0; }
  }

  /** Checks without consuming. */
  canRound(room: string): { ok: true } | { ok: false; reason: 'room_rate' | 'daily_cap'; retryMs?: number } {
    this.rollDay();
    if (this.rounds >= this.o.dailyRounds) return { ok: false, reason: 'daily_cap' };
    const t = this.now(), arr = (this.perRoom.get(room) || []).filter(x => t - x < 60_000);
    this.perRoom.set(room, arr);
    if (arr.length >= this.o.roundsPerMin) return { ok: false, reason: 'room_rate', retryMs: 60_000 - (t - arr[0]) };
    return { ok: true };
  }

  takeRound(room: string) { this.rollDay(); this.rounds++; const a = this.perRoom.get(room) || []; a.push(this.now()); this.perRoom.set(room, a); }

  takeSmall(): boolean { this.rollDay(); if (this.small >= this.o.dailySmall) return false; this.small++; return true; }

  forgetRoom(room: string) { this.perRoom.delete(room); }

  record(u: Usage) {
    this.rollDay();
    this.tokensIn += u.inputTokens; this.tokensOut += u.outputTokens;
    this.log.push(u); if (this.log.length > 200) this.log.shift();
    // One JSON line per AI call, so token usage per round is greppable in the host's logs.
    console.log(JSON.stringify({ ev: 'ai_usage', ...u }));
  }

  stats() { this.rollDay(); return { day: this.day, rounds: this.rounds, roundCap: this.o.dailyRounds, small: this.small, smallCap: this.o.dailySmall, tokensIn: this.tokensIn, tokensOut: this.tokensOut }; }
}
