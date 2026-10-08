// The one interface the game uses to talk to a language model. Two implementations:
// AnthropicLLM (real API, server-side key) and FakeLLM (realistic streamed mock).

export type Effort = 'low' | 'medium' | 'high';

export interface LLMRequest {
  model: string;
  /** Static instructions (rules, personas, format). Sent as the system prompt and prompt-cached. */
  system?: string;
  /** The user turn: data only. */
  prompt: string;
  maxTokens: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface LLMUsage { inputTokens: number; outputTokens: number; stopReason: string | null; model: string; cachedTokens?: number }

/** Error with a short machine code the room uses to pick fallback copy. */
export class LLMError extends Error {
  constructor(public code: 'rate_limited' | 'auth' | 'refused' | 'cancelled' | 'overloaded' | 'error', message: string) { super(message); }
}

export interface LLM {
  /** Shown in the header pill. */
  readonly label: string;
  readonly real: boolean;
  /** Streams text; calls onText with each delta. Resolves with token usage. */
  stream(req: LLMRequest, onText: (delta: string) => void): Promise<LLMUsage>;
}

/** Splits a text stream into lines and hands each complete line to onLine. */
export function lineSplitter(onLine: (line: string) => void) {
  let pending = '';
  return {
    push(delta: string) { const ls = (pending + delta).split('\n'); pending = ls.pop()!; ls.forEach(onLine); },
    end() { if (pending.trim()) onLine(pending); pending = ''; },
  };
}

/** Parses one JSON Lines row the way the original client did: tolerant of fences and trailing commas. */
export function parseLine(line: string): Record<string, unknown> | null {
  line = line.trim().replace(/^```\w*|```$/g, '').replace(/,\s*$/, '');
  if (!line.startsWith('{')) return null;
  try { const o = JSON.parse(line); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
