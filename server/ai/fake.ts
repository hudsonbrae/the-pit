// A stand-in for Claude that needs no API key. It reads the same prompts the real
// model gets and streams back realistic JSON Lines (desk, six trades, two chatter
// lines) a few characters at a time, so the whole streaming pipeline is exercised.
// Used automatically when ANTHROPIC_API_KEY is empty, and by the tests.

import { LLMError, type LLM, type LLMRequest, type LLMUsage } from './llm.js';
import { AGENTS } from '../agents.js';

export interface FakeOptions {
  /** Delay before the first token, ms (models think before they speak). */
  firstTokenMs?: number;
  /** Delay between streamed chunks, ms. */
  chunkMs?: number;
  chunkSize?: number;
  random?: () => number;
}

const POS = ['win', 'wins', 'contract', 'beat', 'record', 'raise', 'approv', 'partner', 'acquire', 'surge', 'breakthrough', 'upgrade', 'buyback', 'profit', 'deal', 'growth'];
const NEG = ['resign', 'fraud', 'short seller', 'alleg', 'investigat', 'recall', 'lawsuit', 'miss', 'cut', 'downgrade', 'fire', 'explo', 'ban', 'loss', 'probe', 'delay', 'rival', 'half', 'audit', 'bankrupt', 'crash', 'steps down'];

const THOUGHTS: Record<string, { up: string[]; down: string[]; flat: string[] }> = {
  marlowe: {
    up: ['Good news, but the price already knows it. Trimming a little into the bid, the balance sheet did not double today.', 'Real cash flow if it holds. I will let the youngsters chase it and sell them a few shares.'],
    down: ['Forced sellers are a gift. Buying what the frightened are dumping, the franchise is intact.', 'Ugly headline, ugly tape. That is usually where I start buying, slowly.'],
    flat: ['Nothing here changes what the business earns. I am doing nothing, which is the hardest trade.', 'Noise. My 4,000 shares stay where they are.'],
  },
  kestrel: {
    up: ['Bids stacking, prints getting bigger. Long with the flow, stop under the last five-second low.', 'Tape is lifting hard. Joining it, out the second it stalls.'],
    down: ['Offers walking down, no bids. Short it, tight stop.', 'Momentum broke. Hitting bids, will cover into the first flush.'],
    flat: ['No volume, no trade. Flat.', 'Chop. Sitting on hands until the tape picks a side.'],
  },
  juno: {
    up: ['Second-order read is constructive: suppliers and customers both benefit. Adding moderately.', 'This shifts the competitive map in our favour for a few quarters. Measured buy.'],
    down: ['Regulators and rivals both smell blood now. The knock-on effects matter more than the headline. Reducing.', 'Supply chain read is negative. Selling some before the second-order effects land.'],
    flat: ['No change to rates, suppliers or competitors. Holding.', 'Macro picture unchanged. Patience.'],
  },
  ash: {
    up: ['Everyone is euphoric at once. That is my cue to lean the other way.', 'Consensus just piled in long. I am happy to sell to them.'],
    down: ['The panic is overdone. Buying from people who will regret selling by lunch.', 'Overreaction. Fading it, alone, as usual.'],
    flat: ['Nobody cares, so neither do I. Holding.', 'No crowd to fade. Waiting.'],
  },
  vega: {
    up: ['Expected value positive, volatility manageable. Adding a small, risk-sized position.', 'Edge looks real, but sizing for a 2-sigma reversal. Modest buy.'],
    down: ['Realised vol just jumped. Cutting gross exposure, probabilities say smaller is smarter.', 'Downside skew widened. Reducing until vol settles.'],
    flat: ['Vol flat, edge near zero. No trade has the best expected value.', 'Holding base size. Nothing to re-price.'],
  },
  pip: {
    up: ['LETS GO. Full send, this is the one, not selling a single share.', 'Told you all. Buying more, diamond hands, see you at the top.'],
    down: ['This is a gift dip... wait no, everyone is selling. Out, out, out.', 'Pain. Selling before it gets worse, ok maybe buying back later.'],
    flat: ['Boring headline but I am bored too, so buying a little.', 'Nothing happening. Holding my bags with pride.'],
  },
};

const LESSONS: Record<string, string[]> = {
  marlowe: ['Do not add on the first headline; wait for the second wave of sellers.', 'Trim euphoria early; the crowd overpays for good news.'],
  kestrel: ['Cut the loser at the first failed bounce, no exceptions.', 'Halts kill momentum trades; size down near the limit.'],
  juno: ['Second-order effects take longer than one session to price in.', 'Rival headlines matter less than demand headlines.'],
  ash: ['Fading a confirmed fact is costlier than fading a rumour.', 'Being early and alone needs smaller size.'],
  vega: ['Vol spikes after headlines; halve size for the next round.', 'My sizing was right; my entry was late.'],
  pip: ['Maybe do not buy the exact top every single time.', 'Selling the bottom is not a strategy, apparently.'],
};

const CHATTER = [
  ['pip', 'marlowe', 'Marlowe still holding like it is 1987. Grandpa, the money is over here.'],
  ['marlowe', 'pip', 'Pip, I have owned this since before you could spell it. Mind your bags.'],
  ['ash', 'kestrel', 'Kestrel chasing again. Tell me how that stop feels when it triggers.'],
  ['kestrel', 'ash', 'Ash, fading the tape is a slow way to go broke.'],
  ['vega', 'pip', 'Pip, your position sizing has a negative expected value. Mathematically.'],
  ['juno', 'vega', 'Vega, your model has never met a regulator. Mine has.'],
];

const HEADLINES = [
  '{co} wins multi-year supply deal with a top-five utility',
  'Report: {co} weighs secondary offering to fund expansion',
  'Activist fund discloses 6% stake in {co}, pushes for buyback',
  '{co} delays flagship product launch by two quarters',
  'Regulator opens probe into {co} safety disclosures',
  '{co} shares added to a major index, effective next week',
  'Unconfirmed: rival courting {co} for takeover at a premium',
  '{co} CEO says demand is "the strongest we have ever seen"',
];

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (ms <= 0) { if (signal?.aborted) rej(new LLMError('cancelled', 'cancelled')); else res(); return; }
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new LLMError('cancelled', 'cancelled')); }, { once: true });
});

export class FakeLLM implements LLM {
  readonly label = 'Mock Claude (no API key)';
  readonly real = false;
  /** Every request this fake received, newest last. Tests read the prompts from here. */
  readonly calls: LLMRequest[] = [];
  /** Optional: make the next call fail with this error code (tests). */
  failNext: LLMError['code'] | null = null;
  private o: Required<FakeOptions>;
  private n = 0;

  constructor(opts: FakeOptions = {}) {
    this.o = { firstTokenMs: 600, chunkMs: 18, chunkSize: 14, random: Math.random, ...opts };
  }

  private pick<T>(a: T[]): T { return a[Math.floor(this.o.random() * a.length) % a.length]; }

  async stream(req: LLMRequest, onText: (delta: string) => void): Promise<LLMUsage> {
    this.calls.push({ ...req, signal: undefined });
    if (this.calls.length > 50) this.calls.shift();
    this.n++;
    if (this.failNext) { const c = this.failNext; this.failNext = null; throw new LLMError(c, 'fake failure: ' + c); }
    const text = this.respond(req.prompt);
    await sleep(this.o.firstTokenMs, req.signal);
    for (let i = 0; i < text.length; i += this.o.chunkSize) {
      if (req.signal?.aborted) throw new LLMError('cancelled', 'cancelled');
      onText(text.slice(i, i + this.o.chunkSize));
      if (this.o.chunkMs > 0) await sleep(this.o.chunkMs, req.signal);
    }
    return { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(text.length / 4), stopReason: 'end_turn', model: req.model + ' (mock)' };
  }

  respond(prompt: string): string {
    if (prompt.includes('OUTPUT: JSON Lines')) return this.round(prompt);
    if (prompt.includes('Reply with only JSON: {"headline"')) {
      const co = /about (.+?) or its world/.exec(prompt)?.[1] ?? 'The company';
      return JSON.stringify({ headline: this.pick(HEADLINES).replace('{co}', co.split(' ')[0]) });
    }
    if (prompt.includes('Write a market wrap')) {
      const tk = /market wrap for (\S+)/.exec(prompt)?.[1] ?? 'the stock';
      const last = /Last \$([\d,.]+)/.exec(prompt)?.[1] ?? '?';
      return `${tk} finished the session at $${last} on this simulated exchange after a headline-driven day. (This wrap was written by the mock model because no Anthropic API key is set; add one in .env for the real wrap.)\n\nThe floor split along familiar lines: momentum chased the tape, the contrarian faded it and the value desk waited for forced sellers. Watch whether the next headline confirms or reverses today's move.`;
    }
    if (prompt.includes('A person on the floor asks you')) {
      const name = /You are (\w+),/.exec(prompt)?.[1] ?? 'I';
      const pos = /Your position: ([\d,.-]+) shares/.exec(prompt)?.[1] ?? 'some';
      return `I'm ${name}, and I'm holding ${pos} shares right now. I trade the way my rules tell me to and I stick to them until the tape proves me wrong. (Mock answer: add an Anthropic API key in .env and I will answer properly.)`;
    }
    return 'OK';
  }

  private round(prompt: string): string {
    const h = /BREAKING HEADLINE: "([\s\S]*?)"\n/.exec(prompt)?.[1] ?? null;
    const t = (h || '').toLowerCase();
    let s = 0; POS.forEach(w => { if (t.includes(w)) s += 1; }); NEG.forEach(w => { if (t.includes(w)) s -= 1.3; });
    const R = this.o.random;
    const impact = h ? Math.max(-30, Math.min(30, s * 5 + (R() - 0.5) * 3)) : 0;
    const mood: 'up' | 'down' | 'flat' = impact > 1.5 ? 'up' : impact < -1.5 ? 'down' : 'flat';
    const lines: string[] = [];
    const tk = /fair value of (\S+)|change this news should make to (\S+) fair value/.exec(prompt);
    const ticker = tk?.[1] || tk?.[2] || 'the stock';
    lines.push(JSON.stringify({
      type: 'desk', impact: +impact.toFixed(1), speed: Math.abs(impact) > 10 ? 'fast' : 'slow',
      read: !h ? 'Floor check: no new information, traders reassess positions.' : mood === 'up' ? `Material positive for ${ticker}: supports earnings and sentiment, though some is already priced.` : mood === 'down' ? `Negative for ${ticker}: raises risk to cash flow and credibility until clarified.` : `Not material to ${ticker} cash flows; expect noise, not a re-rating.`,
    }));
    for (const a of AGENTS) {
      const last = new RegExp(`- id "${a.id}"[\\s\\S]*?Their last call: ([^\\n]*)`).exec(prompt)?.[1] ?? 'none';
      const contrarian = a.id === 'ash' || (a.id === 'marlowe' && mood !== 'flat');
      const dir = mood === 'flat' ? (R() < 0.6 ? 'hold' : R() < 0.5 ? 'buy' : 'sell') : (mood === 'up') !== contrarian ? 'buy' : 'sell';
      const qty = dir === 'hold' ? 0 : Math.round((300 + R() * (a.id === 'pip' || a.id === 'kestrel' ? 4500 : 2200)) / 100) * 100;
      const learned = last !== 'none' && !last.startsWith('HOLD') && R() < 0.75;
      lines.push(JSON.stringify({
        type: 'trade', id: a.id, action: dir, qty, order: R() < 0.2 && dir !== 'hold' ? 'limit' : 'market', limit: null,
        conviction: Math.round(35 + R() * 60),
        thought: this.pick(THOUGHTS[a.id][mood]),
        lesson: learned ? this.pick(LESSONS[a.id]) : '',
      }));
    }
    const c1 = this.pick(CHATTER);
    let c2 = this.pick(CHATTER); if (c2 === c1) c2 = CHATTER[(CHATTER.indexOf(c1) + 1) % CHATTER.length];
    for (const c of [c1, c2]) lines.push(JSON.stringify({ type: 'chatter', id: c[0], to: c[1], line: c[2] }));
    return lines.join('\n') + '\n';
  }
}
