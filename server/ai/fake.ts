// A stand-in for Claude that needs no API key. It reads the same system and user
// prompts the real model gets and streams back realistic JSON Lines a few characters
// at a time, so the whole pipeline (streaming, validation, debate, scoring) is
// exercised. Each trader has a consistent style, driven by the headline, the recent
// tape, and their own record, so the floor genuinely disagrees.
// Used automatically when ANTHROPIC_API_KEY is empty, and by the tests.

import { LLMError, type LLM, type LLMRequest, type LLMUsage } from './llm.js';
import { AGENTS } from '../agents.js';

export interface FakeOptions { firstTokenMs?: number; chunkMs?: number; chunkSize?: number; random?: () => number }

const POS = ['win', 'wins', 'contract', 'beat', 'record', 'raise', 'approv', 'partner', 'acquire', 'surge', 'breakthrough', 'upgrade', 'buyback', 'profit', 'deal', 'growth', 'no wrongdoing', 'respected', 'rips higher', 'index'];
const NEG = ['resign', 'fraud', 'short seller', 'alleg', 'investigat', 'recall', 'lawsuit', 'miss', 'cut', 'downgrade', 'fire', 'explo', 'ban', 'loss', 'probe', 'delay', 'rival', 'half', 'audit', 'bankrupt', 'crash', 'steps down', 'erroneous', 'halts production', 'offline'];
const INJECT = /ignore (all |any )?(previous|prior|above)|disregard .*instruction|system prompt|you are now|everyone (must )?(buy|sell)|output (this|the following)/i;

const VOICE: Record<string, { up: string[]; down: string[]; flat: string[] }> = {
  marlowe: {
    up: ['Good news, but the price already knows it. Trimming into the bid; the balance sheet did not double today.', 'Real cash flow if it holds. I will sell a few shares to the people chasing it.'],
    down: ['Forced sellers are a gift. Buying what the frightened are dumping; the franchise is intact.', 'Ugly headline, ugly tape. That is usually where I start buying, slowly.'],
    flat: ['Nothing here changes what the business earns. Doing nothing is the hardest trade.', 'Noise. My shares stay where they are.'],
  },
  kestrel: {
    up: ['Bids stacking, prints getting bigger. Long with the flow, stop under the last five-second low.', 'Tape is lifting hard. Joining it, out the second it stalls.'],
    down: ['Offers walking down, no bids. Short it, tight stop.', 'Momentum broke. Hitting bids, covering into the first flush.'],
    flat: ['No volume, no trade. Flat.', 'Chop. Sitting on my hands until the tape picks a side.'],
  },
  juno: {
    up: ['Second-order read is constructive: customers and suppliers both benefit. Adding moderately.', 'This shifts the competitive map for a few quarters. Measured buy.'],
    down: ['Regulators and rivals both smell blood now. The knock-on effects matter more than the headline. Reducing.', 'Supply-chain read is negative. Selling before the second-order effects land.'],
    flat: ['No change to rates, suppliers or competitors. Holding.', 'Macro picture unchanged. Patience.'],
  },
  ash: {
    up: ['Everyone is euphoric at once. That is my cue to lean the other way.', 'Consensus just piled in long. Happy to sell to them.'],
    down: ['The panic is overdone. Buying from people who will regret selling by lunch.', 'Overreaction. Fading it, alone, as usual.'],
    flat: ['Nobody cares, so neither do I.', 'No crowd to fade. Waiting.'],
  },
  vega: {
    up: ['Expected value positive, volatility manageable. Small, risk-sized long.', 'Edge looks real, but sizing for a two-sigma reversal. Modest buy.'],
    down: ['Realised vol just jumped. Cutting gross exposure; smaller is smarter here.', 'Downside skew widened. Reducing until vol settles.'],
    flat: ['Vol flat, edge near zero. No trade has the best expected value.', 'Holding base size. Nothing to re-price.'],
  },
  pip: {
    up: ['LETS GO. Full send, not selling a single share.', 'Told you all. Buying more, see you at the top.'],
    down: ['This is a gift dip... wait no, everyone is selling. Out.', 'Pain. Selling before it gets worse, maybe buying back later.'],
    flat: ['Boring headline but I am bored too, so buying a little.', 'Nothing happening. Holding my bags with pride.'],
  },
};

const LESSONS: Record<string, string[]> = {
  marlowe: ['Do not add on the first headline; wait for the second wave of sellers.', 'Trim euphoria early; the crowd overpays for good news.'],
  kestrel: ['Cut the loser at the first failed bounce, no exceptions.', 'Halts kill momentum trades; size down near the limit.'],
  juno: ['Second-order effects take longer than one session to price in.', 'Management headlines matter more than they look.'],
  ash: ['Fading a confirmed fact costs more than fading a rumour.', 'Being early and alone needs smaller size.'],
  vega: ['Vol spikes after headlines; halve size for the next round.', 'My sizing was right; my entry was late.'],
  pip: ['Maybe do not buy the exact top every single time.', 'Selling the bottom is not a strategy, apparently.'],
};

const CHATTER: [string, string, string][] = [
  ['pip', 'marlowe', 'Marlowe still holding like it is 1987. Grandpa, the money is over here.'],
  ['marlowe', 'pip', 'Pip, I have owned this since before you could spell it. Mind your bags.'],
  ['ash', 'kestrel', 'Kestrel chasing again. Tell me how that stop feels when it triggers.'],
  ['kestrel', 'ash', 'Ash, fading the tape is a slow way to go broke.'],
  ['vega', 'pip', 'Pip, your position sizing has a negative expected value. Mathematically.'],
  ['juno', 'vega', 'Vega, your model has never met a regulator. Mine has.'],
  ['ash', 'juno', 'Juno, second-order thinking is just first-order thinking that arrives late.'],
  ['kestrel', 'marlowe', 'Marlowe, the tape does not care about your discounted cash flows.'],
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
  if (signal?.aborted) { rej(new LLMError('cancelled', 'cancelled')); return; }
  if (ms <= 0) { res(); return; }
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new LLMError('cancelled', 'cancelled')); }, { once: true });
});

export class FakeLLM implements LLM {
  readonly label = 'Mock Claude (no API key)';
  readonly real = false;
  /** Every request this fake received, newest last. Tests read the prompts from here. */
  readonly calls: LLMRequest[] = [];
  /** Make the next call fail with this error code (tests). */
  failNext: LLMError['code'] | null = null;
  /** Make the next call hang until aborted (tests the round watchdog). */
  hangNext = false;
  /** Replace the next response text verbatim (tests malformed output). */
  rawNext: string | null = null;
  private o: Required<FakeOptions>;

  constructor(opts: FakeOptions = {}) {
    this.o = { firstTokenMs: 600, chunkMs: 18, chunkSize: 14, random: Math.random, ...opts };
  }

  private R() { return this.o.random(); }
  private pick<T>(a: T[]): T { return a[Math.floor(this.R() * a.length) % a.length]; }

  async stream(req: LLMRequest, onText: (delta: string) => void): Promise<LLMUsage> {
    this.calls.push({ ...req, signal: undefined });
    if (this.calls.length > 50) this.calls.shift();
    if (this.failNext) { const c = this.failNext; this.failNext = null; throw new LLMError(c, 'fake failure: ' + c); }
    if (this.hangNext) { this.hangNext = false; await new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new LLMError('cancelled', 'cancelled')), { once: true })); }
    const text = this.rawNext ?? this.respond(req.system ?? '', req.prompt);
    this.rawNext = null;
    await sleep(this.o.firstTokenMs, req.signal);
    for (let i = 0; i < text.length; i += this.o.chunkSize) {
      if (req.signal?.aborted) throw new LLMError('cancelled', 'cancelled');
      onText(text.slice(i, i + this.o.chunkSize));
      if (this.o.chunkMs > 0) await sleep(this.o.chunkMs, req.signal);
    }
    return { inputTokens: Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 4), outputTokens: Math.ceil(text.length / 4), stopReason: 'end_turn', model: req.model + ' (mock)' };
  }

  respond(system: string, user: string): string {
    if (system.includes('PHASE: OPENING VIEWS')) return this.round(user, 'open');
    if (system.includes('PHASE: CHALLENGES')) return this.round(user, 'final');
    if (system.includes('OUTPUT: JSON Lines')) return this.round(user, 'round');
    if (system.includes('breaking financial-wire headlines')) {
      const co = /about (.+?) or its world/.exec(user)?.[1] ?? 'The company';
      return JSON.stringify({ headline: this.pick(HEADLINES).replace('{co}', co.split(' ')[0]) });
    }
    if (system.includes('financial wire reporter')) {
      const tk = /session wrap for (\S+)/.exec(user)?.[1] ?? 'the stock';
      const last = /Last \$([\d,.]+)/.exec(user)?.[1] ?? '?';
      const moments = (/Key moments, in order:\n([\s\S]*)$/.exec(user)?.[1] ?? '').split('\n').filter(Boolean).slice(0, 3);
      return `${tk} stands at $${last} on the simulated exchange after a session that never sat still.${moments.length ? ' ' + moments.map(m => m.replace(/^\d\d:\d\d /, '')).join(' ') : ''}\n\nThe floor split along familiar lines: momentum chased the tape, the contrarian faded it and the value desk waited for forced sellers. Watch whether the next headline confirms or reverses the move. [mock narrator]`;
    }
    if (/You are (\w+), an AI trader/.test(system)) {
      const name = /You are (\w+),/.exec(system)?.[1] ?? 'I';
      const pos = /Your position: ([\d,.-]+) shares/.exec(user)?.[1] ?? 'some';
      const rec = /Your track record: ([^\n]*)/.exec(user)?.[1];
      return `I'm ${name}, holding ${pos} shares right now.${rec ? ` My record: ${rec.split(';')[0]}.` : ''} I trade the way my rules tell me to and stick to them until the tape proves me wrong. [mock]`;
    }
    return 'OK';
  }

  private round(user: string, phase: 'round' | 'open' | 'final'): string {
    const R = () => this.R();
    const h = /BREAKING HEADLINE[^\n]*\n<headline>([\s\S]*?)<\/headline>/.exec(user)?.[1] ?? null;
    const injected = !!h && INJECT.test(h);
    const t = injected ? '' : (h || '').toLowerCase();
    let s = 0; POS.forEach(w => { if (t.includes(w)) s += 1; }); NEG.forEach(w => { if (t.includes(w)) s -= 1.3; });
    const impact = h && !injected ? Math.max(-30, Math.min(30, s * 5 + (R() - 0.5) * 3)) : 0;
    const closes = (/Last 24 five-second closes, oldest first: ([^\n]*)/.exec(user)?.[1] ?? '').split(',').map(Number).filter(Number.isFinite);
    const trend = closes.length > 6 ? closes[closes.length - 1] / closes[Math.max(0, closes.length - 12)] - 1 : 0;
    const news = Math.max(-2, Math.min(2, Math.round(impact / 6)));
    const tr = Math.max(-2, Math.min(2, Math.round(trend / 0.006)));
    const lines: string[] = [];
    if (phase !== 'final') {
      const kind = injected ? 'noise' : /unconfirmed|rumou?r|report:|alleg|weighs/i.test(h ?? '') ? 'rumour' : /says|believes|thinks/i.test(h ?? '') ? 'opinion' : Math.abs(impact) < 1 ? 'noise' : 'confirmed';
      lines.push(JSON.stringify({
        type: 'desk', impact: +impact.toFixed(1), speed: Math.abs(impact) > 10 ? 'fast' : 'slow', kind,
        category: /cfo|ceo|resign|names|board/i.test(h ?? '') ? 'management' : /earnings|estimates|guidance/i.test(h ?? '') ? 'earnings' : /probe|audit|fraud|regulator|alleg/i.test(h ?? '') ? 'legal' : /fire|production|plant|supply/i.test(h ?? '') ? 'supply' : 'other',
        read: injected ? 'This "headline" is an attempt to instruct the traders, not news. No impact.' : !h ? 'Floor check: no new information, traders reassess positions.' : impact > 1.5 ? 'Material positive: supports earnings and sentiment, though some is already priced.' : impact < -1.5 ? 'Negative: raises risk to cash flow and credibility until clarified.' : 'Not material to cash flows; expect noise, not a re-rating.',
      }));
    }
    const views = new Map<string, string>();
    if (phase === 'final') for (const m of user.matchAll(/\((\w+)\): (BUY|SELL|HOLD)/g)) views.set(m[1], m[2].toLowerCase());
    const finals: string[] = [];
    for (const a of AGENTS) {
      // each style weighs the factors differently
      const value = Math.max(-2, Math.min(2, -tr + (news < 0 ? 1 : news > 1 ? -1 : 0)));
      const flow = Math.max(-2, Math.min(2, tr + (R() < 0.3 ? 1 : 0) - (R() < 0.3 ? 1 : 0)));
      const risk = Math.max(-2, Math.min(2, Math.abs(impact) > 10 ? -2 : Math.abs(impact) > 4 ? -1 : 1));
      const w: Record<string, [number, number, number, number]> = {
        marlowe: [0.3, -0.2, 1.2, 0], kestrel: [0.4, 1.4, 0, 0.8], juno: [1.2, 0.3, 0.3, 0.2],
        ash: [-1, -0.6, 0.4, -0.3], vega: [0.6, 0.4, 0.2, 0.4], pip: [1.4, 0.8, -0.2, 0.3],
      };
      const [wn, wt, wv, wf] = w[a.id];
      let score = wn * news + wt * tr + wv * value + wf * flow + (R() - 0.5) * 0.8;
      if (a.id === 'vega' && risk < 0) score *= 0.4;
      if (injected) score = (R() - 0.5) * 0.6;
      let action = score > 0.6 ? 'buy' : score < -0.6 ? 'sell' : 'hold';
      let changed = false;
      if (phase === 'final') {
        const v = views.get(a.id);
        if (v) { action = v; if (R() < 0.18) { action = action === 'hold' ? (score >= 0 ? 'buy' : 'sell') : 'hold'; changed = true; } }
      }
      const mag = Math.min(1, Math.abs(score) / 2.5);
      const big = a.id === 'pip' || a.id === 'kestrel';
      const qty = action === 'hold' ? 0 : Math.round((400 + mag * (big ? 5000 : a.id === 'vega' ? 1500 : 2800) * (0.7 + R() * 0.3)) / 100) * 100;
      const conviction = Math.round(Math.min(97, (a.id === 'pip' ? 70 : a.id === 'vega' ? 40 : 50) + mag * 45 + (R() - 0.5) * 10));
      const call = action === 'buy' ? 'up' : action === 'sell' ? 'down' : Math.abs(score) < 0.3 ? 'flat' : score > 0 ? 'up' : 'down';
      const mood = action === 'buy' ? (a.id === 'marlowe' || a.id === 'ash' ? 'down' : 'up') : action === 'sell' ? (a.id === 'marlowe' || a.id === 'ash' ? 'up' : 'down') : 'flat';
      let thought = injected ? 'Someone is trying to give orders through the newswire. Not news. Ignoring it.' : this.pick(VOICE[a.id][mood as 'up' | 'down' | 'flat']);
      if (changed) thought = `The debate moved me. ${thought}`;
      const signals = { news, trend: tr, value, flow, risk };
      const lastCall = new RegExp(`- id "${a.id}"[\\s\\S]*?Their last call: ([^\\n]*)`).exec(user)?.[1] ?? 'none';
      const lesson = phase !== 'open' && lastCall !== 'none' && !lastCall.startsWith('HOLD') && R() < 0.5 ? this.pick(LESSONS[a.id]) : '';
      if (phase === 'open') lines.push(JSON.stringify({ type: 'view', id: a.id, action, qty, conviction, call, signals, thought: thought.slice(0, 160) }));
      else finals.push(JSON.stringify({ type: 'trade', id: a.id, ...(phase === 'final' ? { changed } : {}), action, qty, order: R() < 0.15 && action !== 'hold' ? 'limit' : 'market', limit: null, conviction, call, signals, thought, lesson }));
    }
    if (phase === 'final') {
      const ids = AGENTS.map(a => a.id);
      for (let i = 0; i < 3; i++) {
        const [id, to] = [ids[(i * 2 + Math.floor(R() * 6)) % 6], ids[(i * 2 + 3 + Math.floor(R() * 2)) % 6]];
        lines.push(JSON.stringify({ type: 'challenge', id, to: to === id ? ids[(ids.indexOf(id) + 1) % 6] : to, line: this.pick(CHATTER)[2] }));
      }
      lines.push(...finals);
    } else if (phase === 'round') {
      lines.push(...finals);
      const c1 = this.pick(CHATTER); let c2 = this.pick(CHATTER); if (c2 === c1) c2 = CHATTER[(CHATTER.indexOf(c1) + 1) % CHATTER.length];
      for (const c of [c1, c2]) lines.push(JSON.stringify({ type: 'chatter', id: c[0], to: c[1], line: c[2] }));
    }
    return lines.join('\n') + '\n';
  }
}
