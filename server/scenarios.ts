// Scenarios: scripted market events with structured causes and effects, for Sim rooms.
// Each step runs after the previous one finishes (plus a delay in simulated seconds,
// so pausing pauses the script). News steps go through a normal AI round, so the six
// traders genuinely react; mechanical steps (liquidity withdrawal, sell programs,
// volatility) act on the engine directly. Everything is labelled SCENARIO on screen.

export type Step =
  | { after: number; act: string; sub: string }
  | { after: number; news: string; debate?: boolean; debateAct?: string }
  | { after: number; shock: number; speed: 'fast' | 'slow'; note?: string }
  | { after: number; program: 'buy' | 'sell'; perTick: number; ticks: number; note?: string }
  | { after: number; withdraw: number; note?: string }
  | { after: number; knobs: { vol?: number; liq?: number; spread?: number; crowd?: number }; ticks: number; note?: string }
  | { after: number; haltIfNone: 'up' | 'down' | 'auto'; withinTicks: number }
  | { after: number; waitResume: true }
  | { after: number; prompt: string }
  | { after: number; close: true }
  /** Announce how the AI floor's calls on the scenario's first headline were scored (right / wrong). */
  | { after: number; scoreboard: string; sub?: string };

export interface Scenario { id: string; name: string; desc: string; steps: Step[] }

export const SCENARIOS: Scenario[] = [
  {
    id: 'demo', name: 'The Demo (9 acts)', desc: 'A calm open, a bombshell, a floor debate, a crash, a halt, a twist, and then the scores. About 2½ minutes.',
    steps: [
      { after: 2, act: 'ACT I · THE OPEN', sub: 'A calm market. Six AI traders, one real order book, and you.' },
      { after: 12, act: 'ACT II · BREAKING NEWS', sub: 'A bombshell hits the wire.' },
      { after: 2, news: '{co} CFO resigns effective immediately; auditors reviewing revenue recognition', debate: true, debateAct: 'ACT III · THE DEBATE' },
      { after: 1, act: 'ACT IV · YOUR MOVE', sub: 'The floor has traded. Buy the panic, or join it? You have 15 seconds.' },
      { after: 0, prompt: 'Your move: the AI floor just traded the CFO news. Buy, sell or hold? Volatility is coming.' },
      { after: 16, act: 'ACT V · VOLATILITY', sub: 'Margin calls. Dealers step back. Liquidity drains.' },
      { after: 0, withdraw: 16, note: 'Market makers pull their quotes.' },
      { after: 0, knobs: { vol: 3, liq: 0.4, spread: 2 }, ticks: 240, note: 'Volatility spikes, liquidity thins.' },
      { after: 0, program: 'sell', perTick: 450, ticks: 14, note: 'A fund dumps its position: forced selling.' },
      { after: 6, haltIfNone: 'down', withinTicks: 160 },
      { after: 0, act: 'ACT VI · HALT', sub: 'Circuit breaker. Six seconds of silence.' },
      { after: 0, waitResume: true },
      { after: 0, act: 'ACT VII · THE REOPEN', sub: 'Who flinched? Watch the tape.' },
      { after: 14, act: 'ACT VIII · THE TWIST', sub: 'New information. Does the floor reverse?' },
      { after: 1, news: '{co} names respected interim CFO; preliminary audit finds no wrongdoing', debate: false },
      { after: 22, scoreboard: 'ACT IX · THE SCORES', sub: 'Sixty seconds after the CFO news, reality checked every call.' },
      { after: 40, close: true },
    ],
  },
  {
    id: 'flash_crash', name: 'Flash crash', desc: 'A sell algorithm malfunctions, dealers vanish, then the exchange reviews the trades.',
    steps: [
      { after: 0, act: 'FLASH CRASH', sub: 'An algorithm is dumping shares at any price.' },
      { after: 0, withdraw: 24, note: 'Market makers pull their quotes.' },
      { after: 0, knobs: { liq: 0.3, spread: 2.5 }, ticks: 240 },
      { after: 0, program: 'sell', perTick: 700, ticks: 18, note: 'A runaway sell program hits every bid.' },
      { after: 12, news: 'Exchange reviewing erroneous sell orders in {T}; firm blames faulty algorithm' },
    ],
  },
  {
    id: 'short_squeeze', name: 'Short squeeze', desc: 'Record short interest, a spark, and shorts scrambling to cover.',
    steps: [
      { after: 0, act: 'SHORT SQUEEZE', sub: 'Everyone is short. Someone just lit a match.' },
      { after: 0, news: 'Short interest in {T} hits a record 38% of the float', debate: false },
      { after: 4, shock: 6, speed: 'slow' },
      { after: 0, program: 'buy', perTick: 350, ticks: 40, note: 'Shorts are covering: forced buying.' },
      { after: 12, news: '{T} rips higher as short sellers scramble to cover', debate: true },
    ],
  },
  {
    id: 'earnings_beat', name: 'Earnings beat', desc: 'A big beat and a raise. Volatility doubles around the print.',
    steps: [
      { after: 0, act: 'EARNINGS', sub: 'The numbers are out.' },
      { after: 0, knobs: { vol: 2 }, ticks: 240 },
      { after: 0, news: '{co} beats quarterly estimates by 22% and raises full-year guidance', debate: true },
    ],
  },
  {
    id: 'earnings_miss', name: 'Earnings miss', desc: 'A miss and a guidance cut. Volatility doubles around the print.',
    steps: [
      { after: 0, act: 'EARNINGS', sub: 'The numbers are out.' },
      { after: 0, knobs: { vol: 2 }, ticks: 240 },
      { after: 0, news: '{co} misses quarterly revenue estimates by 15% and cuts guidance', debate: true },
    ],
  },
  {
    id: 'black_swan', name: 'Black swan', desc: 'Something nobody priced. Liquidity vanishes and volatility triples.',
    steps: [
      { after: 0, act: 'BLACK SWAN', sub: 'Nobody had this in their model.' },
      { after: 0, withdraw: 12 },
      { after: 0, knobs: { vol: 3, liq: 0.5, spread: 2 }, ticks: 360 },
      { after: 0, news: 'Fire halts production at {short}’s largest plant; output offline for months', debate: true },
    ],
  },
  {
    id: 'liquidity_crisis', name: 'Liquidity crisis', desc: 'No news at all. Dealers just stop showing size. Watch spreads blow out.',
    steps: [
      { after: 0, act: 'LIQUIDITY CRISIS', sub: 'No headline. The dealers simply leave.' },
      { after: 0, knobs: { liq: 0.25, spread: 3, crowd: 1.6 }, ticks: 480, note: 'Market makers shrink to a quarter of their size.' },
      { after: 30, prompt: 'Spreads are wide. Every order you place moves the price.' },
    ],
  },
];

/**
 * Chaos controls: one-tap events for the host. Same machinery as scenarios (and the same
 * honesty: mechanical steps hit the engine; headlines go through a real AI round, labelled
 * SCENARIO, so the traders decide for themselves how to react, and the cost guard applies).
 */
export const CHAOS: Scenario[] = [
  { id: 'chaos_news', name: 'News shock', desc: 'A random market-moving headline hits the wire.', steps: [{ after: 0, act: 'NEWS SHOCK', sub: 'Something just hit the wire.' }, { after: 0, news: '{random}' }] },
  {
    id: 'chaos_crash', name: 'Flash crash', desc: 'Dealers vanish and a runaway sell program hits every bid.', steps: [
      { after: 0, act: 'FLASH CRASH', sub: 'A sell program is hitting every bid.' },
      { after: 0, withdraw: 20, note: 'Market makers pull their quotes.' },
      { after: 0, knobs: { liq: 0.3, spread: 2.5 }, ticks: 200 },
      { after: 0, program: 'sell', perTick: 700, ticks: 16, note: 'A runaway sell program hits every bid.' },
    ],
  },
  {
    id: 'chaos_squeeze', name: 'Short squeeze', desc: 'Forced buying into a thin ask side.', steps: [
      { after: 0, act: 'SHORT SQUEEZE', sub: 'Shorts are covering at any price.' },
      { after: 0, withdraw: 10 },
      { after: 0, shock: 4, speed: 'fast' },
      { after: 0, program: 'buy', perTick: 600, ticks: 20, note: 'Shorts are covering: forced buying.' },
    ],
  },
  {
    id: 'chaos_liquidity', name: 'Liquidity crisis', desc: 'Dealers shrink to a quarter of their size for 90 seconds.', steps: [
      { after: 0, act: 'LIQUIDITY CRISIS', sub: 'The dealers just left.' },
      { after: 0, withdraw: 12 },
      { after: 0, knobs: { liq: 0.25, spread: 3 }, ticks: 360, note: 'Market makers shrink to a quarter of their size.' },
    ],
  },
  { id: 'chaos_beat', name: 'Earnings beat', desc: 'A big beat and a raise.', steps: [{ after: 0, act: 'EARNINGS BEAT', sub: 'The numbers are out.' }, { after: 0, knobs: { vol: 2 }, ticks: 240 }, { after: 0, news: '{co} beats quarterly estimates by 22% and raises full-year guidance' }] },
  { id: 'chaos_miss', name: 'Earnings miss', desc: 'A miss and a guidance cut.', steps: [{ after: 0, act: 'EARNINGS MISS', sub: 'The numbers are out.' }, { after: 0, knobs: { vol: 2 }, ticks: 240 }, { after: 0, news: '{co} misses quarterly revenue estimates by 15% and cuts guidance' }] },
  { id: 'chaos_panic', name: 'AI panic', desc: 'The risk desk orders every trader to cut exposure. The AI decides how.', steps: [{ after: 0, act: 'AI PANIC', sub: 'The risk desk just hit the alarm.' }, { after: 0, news: 'RISK DESK: firm-wide loss limits breached; all trading desks ordered to cut {T} exposure immediately' }] },
  { id: 'chaos_euphoria', name: 'AI euphoria', desc: 'A takeover rumour sweeps the floor. Rumour, not fact: the desk should say so.', steps: [{ after: 0, act: 'AI EUPHORIA', sub: 'A rumour is sweeping the floor.' }, { after: 0, news: 'Floor rumour: a megacap buyer is preparing a takeover bid for {co} at a 45% premium' }] },
  { id: 'chaos_halt', name: 'Market halt', desc: 'Trip the circuit breaker now.', steps: [{ after: 0, haltIfNone: 'auto', withinTicks: 0 }] },
];

/** Headlines for the News shock button (one is picked with the room's seeded RNG). */
export const NEWS_SHOCKS = [
  '{co} wins a $4 billion multi-year grid storage contract with a national utility',
  'Regulators open an investigation into {co} battery fire reports',
  '{co} CEO sells 40% of personal stake in an unscheduled filing',
  'Major customer cancels {short} supply agreement citing quality issues',
  '{co} announces a $2 billion share buyback',
  'Tariffs on imported battery cells doubled, effective next month',
  '{co} breakthrough cell chemistry doubles energy density in independent tests',
  'Short seller publishes report alleging {co} inflated order backlog',
];

export const scenarioList = () => SCENARIOS.map(s => ({ id: s.id, name: s.name, desc: s.desc }));
export const chaosList = () => CHAOS.map(s => ({ id: s.id, name: s.name, desc: s.desc }));
export const fill = (s: string, co: { ticker: string; name: string; short: string }) => s.replaceAll('{T}', co.ticker).replaceAll('{co}', co.name).replaceAll('{short}', co.short);
