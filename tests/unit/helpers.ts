import { Room, type Conn, type RoomDeps } from '../../server/room';
import { loadConfig, type Config } from '../../server/config';
import { CostGuard } from '../../server/costguard';
import { MemoryStore } from '../../server/store/store';
import type { LLM, LLMRequest, LLMUsage } from '../../server/ai/llm';
import type { MarketHub } from '../../server/market/hub';
import { seeded } from '../../server/engine';
import type { ServerMsg } from '../../shared/protocol';

export function deps(o: { llm?: LLM | null; cfg?: Partial<Config>; store?: MemoryStore; hub?: MarketHub | null } = {}): RoomDeps & { store: MemoryStore } {
  const cfg = loadConfig({ roundPaceMs: 0, chatterPaceMs: 0, ...o.cfg });
  return {
    cfg, llm: o.llm === undefined ? null : o.llm, store: o.store ?? new MemoryStore(), hub: o.hub ?? null, random: seeded(42), aiState: { dead: false },
    guard: new CostGuard({ roundsPerMin: cfg.aiRoundsPerMinPerRoom, dailyRounds: cfg.aiDailyRoundCap, dailySmall: cfg.aiDailySmallCap }),
  };
}

export function simRoom(d: RoomDeps, code = 'TESTA') { return new Room(d, { code, mode: 'sim', ticker: 'HLCN', hostToken: 'host-token-1' }); }

/** A fake socket that records what the room sends it. */
export class RecConn implements Conn {
  msgs: (ServerMsg & { at: number })[] = [];
  bufferedAmount = 0;
  send(s: string) { this.msgs.push({ ...JSON.parse(s), at: performance.now() }); }
  of<K extends ServerMsg['k']>(k: K) { return this.msgs.filter(m => m.k === k) as (Extract<ServerMsg, { k: K }> & { at: number })[]; }
}

/** An LLM that streams a fixed script line by line with a delay between lines, and records prompts. */
export class ScriptLLM implements LLM {
  readonly label = 'Script'; readonly real = false;
  prompts: string[] = [];
  lineDoneAt: number[] = [];
  endedAt = 0;
  constructor(private scripts: string[][], private lineMs = 5) {}
  async stream(req: LLMRequest, onText: (d: string) => void): Promise<LLMUsage> {
    this.prompts.push(req.prompt);
    const lines = this.scripts[Math.min(this.prompts.length - 1, this.scripts.length - 1)];
    for (const l of lines) {
      // send each line in two pieces to exercise the line splitter
      const half = Math.floor(l.length / 2);
      onText(l.slice(0, half)); await new Promise(r => setTimeout(r, 1)); onText(l.slice(half) + '\n');
      this.lineDoneAt.push(performance.now());
      await new Promise(r => setTimeout(r, this.lineMs));
    }
    this.endedAt = performance.now();
    return { inputTokens: req.prompt.length / 4, outputTokens: 300, stopReason: 'end_turn', model: req.model };
  }
}

export const IDS = ['marlowe', 'kestrel', 'juno', 'ash', 'vega', 'pip'];
export function script(impact: number, lesson: (id: string) => string, action = 'buy'): string[] {
  return [
    JSON.stringify({ type: 'desk', impact, speed: 'fast', read: 'Desk read.' }),
    ...IDS.map(id => JSON.stringify({ type: 'trade', id, action, qty: 500, order: 'market', limit: null, conviction: 70, thought: `${id} thinks.`, lesson: lesson(id) })),
    JSON.stringify({ type: 'chatter', id: 'pip', to: 'marlowe', line: 'Grandpa is wrong again.' }),
    JSON.stringify({ type: 'chatter', id: 'marlowe', to: 'pip', line: 'Mind your bags.' }),
  ];
}

export const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); } };
