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
  | { after: number; haltIfNone: 'up' | 'down'; withinTicks: number }
  | { after: number; waitResume: true }
  | { after: number; prompt: string }
  | { after: number; close: true };

export interface Scenario { id: string; name: string; desc: string; steps: Step[] }

export const SCENARIOS: Scenario[] = [
  {
    id: 'demo', name: 'The Demo (9 acts)', desc: 'A calm open, a bombshell, a floor debate, a crash, a halt, a reversal and a closing wrap. About 6 minutes.',
    steps: [
      { after: 2, act: 'ACT I · THE OPEN', sub: 'A calm market. Six AI traders, real order book, your money.' },
      { after: 14, act: 'ACT II · BREAKING NEWS', sub: 'A bombshell hits the wire.' },
      { after: 2, news: '{co} CFO resigns effective immediately; auditors reviewing revenue recognition', debate: true, debateAct: 'ACT III · THE DEBATE' },
      { after: 1, act: 'ACT IV · YOUR MOVE', sub: 'The floor has spoken. Buy the panic or join it?' },
      { after: 1, prompt: 'Your move: the AI floor just traded the CFO news. Buy, sell or hold?' },
      { after: 12, act: 'ACT V · VOLATILITY', sub: 'Margin calls. Dealers step back. Liquidity drains.' },
      { after: 0, withdraw: 16, note: 'Market makers pull their quotes.' },
      { after: 0, knobs: { vol: 3, liq: 0.4, spread: 2 }, ticks: 240, note: 'Volatility spikes, liquidity thins.' },
      { after: 0, program: 'sell', perTick: 450, ticks: 14, note: 'A fund dumps its position: forced selling.' },
      { after: 6, haltIfNone: 'down', withinTicks: 160 },
      { after: 0, act: 'ACT VI · HALT', sub: 'Circuit breaker. Six seconds of silence.' },
      { after: 0, waitResume: true },
      { after: 0, act: 'ACT VII · THE REOPEN', sub: 'Who flinched?' },
      { after: 10, act: 'ACT VIII · THE TWIST', sub: 'New information. Does the floor reverse?' },
      { after: 1, news: '{co} names respected interim CFO; preliminary audit finds no wrongdoing', debate: false },
      { after: 62, act: 'ACT IX · THE VERDICT', sub: 'Calls are scored. Who actually read it right?' },
      { after: 4, close: true },
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

export const scenarioList = () => SCENARIOS.map(s => ({ id: s.id, name: s.name, desc: s.desc }));
export const fill = (s: string, co: { ticker: string; name: string; short: string }) => s.replaceAll('{T}', co.ticker).replaceAll('{co}', co.name).replaceAll('{short}', co.short);
