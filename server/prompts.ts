// The Claude prompts, ported unchanged from the original ui.js. The only edits:
// the company (ticker, name, description) is a parameter so Real Market rooms can
// use a real company, and Real rooms add one line with the real price to brief().
// In a Sim room every prompt is byte-for-byte the original text.

import type { CompanyCtx } from './agents.js';
import type { Engine } from './engine.js';
import type { NewsV } from '../shared/protocol.js';
import { f2, fi, money } from '../shared/format.js';

export interface AgentState {
  id: string; name: string; tag: string; voice: string;
  log: { time: string; head: string; act: string; thought: string }[];
  lessons: string[]; callPx: number; callPnl: number;
}

export interface PromptCtx {
  co: CompanyCtx;
  eng: Engine;
  news: NewsV[];
  agents: AgentState[];
  pnl: (id: string) => number;
  /** Real Market mode only. */
  real?: { price: number | null; marketOpen: boolean | null } | null;
}

export function brief(c: PromptCtx) {
  const S = c.eng.S;
  const cs = S.candles.slice(-24).map(x => x.c.toFixed(2)).join(', ');
  const d = c.eng.depth(1);
  const recent = c.news.filter(n => n.kind !== 'sys').slice(0, 5).map(n => `[${n.time.slice(0, 5)}] ${n.kind === 'check' ? 'floor check' : `"${n.text}" (desk impact ${n.impact ?? '?'}%)`}`).join('\n') || 'none';
  const real = c.real ? `Real-world ${c.co.ticker} last trade: ${c.real.price != null ? '$' + f2(c.real.price) : 'unknown'}${c.real.marketOpen === false ? ' (US market closed; that is the last real price)' : ''}. This simulated exchange is anchored to it.\n` : '';
  return `Simulated time ${c.eng.clock()}. Last $${f2(S.last)}, session open $${f2(S.open)} (${((S.last / S.open - 1) * 100).toFixed(2)}%), high ${f2(S.hi)}, low ${f2(S.lo)}, VWAP ${f2(S.vwapN / S.vwapD)}.
${real}Best bid ${d.bids[0] ? f2(d.bids[0].price) : 'none'}, best ask ${d.asks[0] ? f2(d.asks[0].price) : 'none'}. Typical displayed depth is only a few thousand shares, so a 5,000-share market order moves the price noticeably.
${S.halted ? 'TRADING IS CURRENTLY HALTED by a circuit breaker; orders queue for the reopen.\n' : ''}Last 24 five-second closes, oldest first: ${cs}
Recent headlines, newest first:
${recent}`;
}

export function book(c: PromptCtx, a: AgentState) {
  const S = c.eng.S;
  const ac = S.accounts[a.id], last = a.log[0];
  return `- id "${a.id}" | ${a.name}, ${a.tag}: ${a.voice}
  Now holds ${fi(ac.sh)} shares and $${fi(ac.cash)} cash; P&L ${money(c.pnl(a.id))}. Their last call: ${last ? `${last.act} ("${last.thought}")` : 'none'}
  How that call has worked out: price ${f2(a.callPx)} then, ${f2(S.last)} now; their P&L moved ${money(c.pnl(a.id) - a.callPnl)} since.
  Lessons they wrote for themselves (newest first): ${a.lessons.length ? a.lessons.map((l, i) => `${i + 1}) ${l}`).join(' ') : 'none yet'}`;
}

export function tradePrompt(c: PromptCtx, headline: string | null) {
  return `You are the simulation engine for THE PIT, a live simulated stock exchange. You voice six independent AI traders who each decide what to do on their own. They have different temperaments and should often disagree. This is a fictional market game; no real money.

THE COMPANY
${c.co.desc}

THE MARKET RIGHT NOW
${brief(c)}

${headline ? `BREAKING HEADLINE: "${headline}"` : 'NO NEW HEADLINE. This is a floor check: each trader reviews the tape, recent headlines and their own position and decides whether to act.'}

THE TRADERS
${c.agents.map(a => book(c, a)).join('\n')}

Each trader may buy or sell up to 6000 shares this round. Positions must stay between -12000 and +12000 shares. Market orders fill now against the book; limit orders rest at their price until hit.

OUTPUT: JSON Lines only. No prose, no code fences, exactly 9 lines.
Line 1: {"type":"desk","impact":<number, the % change this news should make to ${c.co.ticker} fair value, from -45 to 60, use 0 for a floor check>,"speed":"fast" or "slow","read":"<one sentence: the newsroom analyst's read of what this means for ${c.co.short}>"}
Then one line per trader, in this order: marlowe, kestrel, juno, ash, vega, pip:
{"type":"trade","id":"<id>","action":"buy" or "sell" or "hold","qty":<integer 0-6000>,"order":"market" or "limit","limit":<price or null>,"conviction":<0-100>,"thought":"<at most 28 words, first person, in that trader's own voice, specific to this headline and their own position>","lesson":"<at most 16 words: a rule this trader takes from how their PREVIOUS call worked out, or an empty string if nothing new was learned>"}
Then 2 lines of floor chatter, traders needling each other by name about their actual positions and P&L:
{"type":"chatter","id":"<speaker id>","to":"<target id>","line":"<at most 18 words, in the speaker's voice>"}

Judge impact like a real analyst, scaled to how material the news is to cash flow, dilution, legal risk or survival. Trivial or absurd news is near 0, though traders can still react in character. Unconfirmed allegations move less than confirmed facts. Traders should remember their own last call and current P&L, and actually follow the lessons they have written, unless this situation is genuinely different. A trader who keeps losing should adapt.`;
}

export function surprisePrompt(c: PromptCtx) {
  const S = c.eng.S;
  const prev = c.news.filter(n => n.kind === 'news').slice(0, 8).map(n => '- ' + n.text).join('\n');
  return `${c.co.desc}\nThe stock is at $${f2(S.last)} (${((S.last / S.open - 1) * 100).toFixed(1)}% today).\nHeadlines already published today:\n${prev}\n\nWrite ONE new breaking financial-wire headline about ${c.co.name} or its world that would make this simulated market interesting. Vary it: it could be very good, very bad, ambiguous, a rumour, a macro shock, a twist on an earlier headline, or something absurd. At most 16 words, wire style. Reply with only JSON: {"headline":"..."}`;
}

export function wrapPrompt(c: PromptCtx, board: string) {
  const S = c.eng.S;
  const halts = S.halts.length ? `${S.halts.length} circuit-breaker halt(s) today.` : 'No halts today.';
  return `You are a sharp financial wire reporter. Write a market wrap for ${c.co.ticker} (${c.co.name}) on this simulated exchange, about 130 words, in plain paragraphs (no headers, no bullet points, no markdown). Cite specific prices and moves, explain which headlines moved the stock and why, name which AI traders won and lost and what that says about their styles, mention the human player if they traded, and end with one line on what to watch next.\n\n${c.co.desc}\n\n${brief(c)}\n${halts}\n\nTrader standings:\n${board}`;
}

export function askPrompt(c: PromptCtx, a: AgentState, q: string) {
  const S = c.eng.S;
  return `You are ${a.name}, an AI trader on THE PIT, a simulated stock exchange trading only ${c.co.ticker}. Personality: ${a.voice}\n\n${c.co.desc}\n\nMarket now:\n${brief(c)}\n\nYour position: ${fi(S.accounts[a.id].sh)} shares, $${fi(S.accounts[a.id].cash)} cash, P&L ${money(c.pnl(a.id))} today.\nRules you have taught yourself: ${a.lessons.join(' | ') || 'none yet'}\nYour calls today, newest first:\n${a.log.slice(0, 8).map(l => `${l.time} on "${l.head}": ${l.act}. Said: ${l.thought}`).join('\n')}\n\nA person on the floor asks you: "${q}"\n\nAnswer in character, first person, 2 to 4 sentences, plain text. Be specific about your trades and reasoning. Stay in this fictional market.`;
}
