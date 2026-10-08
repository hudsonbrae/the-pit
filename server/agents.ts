// The six AI traders, the fictional company and the preset headlines.
// Text is copied unchanged from the original ui.js; Real-mode variants are new.

export interface AgentDef { id: string; name: string; tag: string; voice: string }

export const AGENTS: AgentDef[] = [
  { id: 'marlowe', name: 'Marlowe', tag: 'Deep value', voice: 'A 30-year value investor. Dry, patient, sounds like an old fund manager. Buys fear and sells euphoria. Cares about cash flow, balance sheet and dilution, ignores noise.' },
  { id: 'kestrel', name: 'Kestrel', tag: 'Momentum scalper', voice: 'A fast tape-reader. Terse and clipped. Trades the price action and volume, never fights the trend, cuts losers instantly.' },
  { id: 'juno', name: 'Juno', tag: 'Macro strategist', voice: 'Thinks in second-order effects: rates, supply chains, competitors, regulators, who else is affected. Measured and analytical.' },
  { id: 'ash', name: 'Ash', tag: 'Contrarian', voice: 'A professional sceptic who fades consensus and overreactions. Sardonic, enjoys being early and alone.' },
  { id: 'vega', name: 'Vega', tag: 'Risk quant', voice: 'A volatility-targeting quant. Sizes by risk, speaks in probabilities and expected value, cuts exposure when volatility spikes.' },
  { id: 'pip', name: 'Pip', tag: 'Retail degen', voice: 'A 19-year-old forum trader. Overconfident, chaotic, uses internet trading slang (no emojis). Loves big swings and hates selling.' },
];
export const AGENT_IDS = AGENTS.map(a => a.id);

/** What the prompts call the company: full description, ticker, short name. */
export interface CompanyCtx { desc: string; ticker: string; name: string; short: string }

export const HLCN: CompanyCtx = {
  desc: `Halcyon Dynamics (ticker HLCN) is a mid-cap industrial tech company: grid-scale sodium-ion batteries (about 60% of revenue) and autonomous haul trucks for mines (about 40%). Founded in Perth, listed in the US, about 400 million shares outstanding, thin profits, fast growth, a favourite of retail traders.`,
  ticker: 'HLCN', name: 'Halcyon Dynamics', short: 'Halcyon',
};

export const SIM_PRESETS = [
  'Halcyon wins $4B Pentagon contract for battery-backed forward bases',
  'CFO resigns effective immediately; auditors reviewing Q3 revenue recognition',
  'Short seller alleges Halcyon double-counted autonomous truck orders',
  'Chinese rival unveils sodium cell at half Halcyon’s cost',
  'CEO posts a photo of his dog wearing a Halcyon hard hat',
];

export const realPresets = (short: string) => [
  `${short} beats earnings estimates and raises full-year guidance`,
  `${short} CFO resigns effective immediately; auditors reviewing revenue recognition`,
  `Short seller alleges ${short} inflated its order book`,
  `Rival unveils a competing product at half ${short}’s price`,
  `${short} CEO posts a photo of his dog wearing a company hard hat`,
];

/** Each trader starts the day with their own book (same total equity, different exposure). */
export const START_SHARES: Record<string, number> = { marlowe: 6000, kestrel: 0, juno: 3000, ash: -2000, vega: 2000, pip: 9000 };

export const SIM_PRE: Record<string, string> = {
  marlowe: 'Guidance raise is real cash flow. I own 6,000 and I am in no hurry.',
  kestrel: 'Morning trend up, Ferrovolt dip got bought. Flat, no position, until the tape speaks.',
  juno: 'Utilities are still under-ordering storage. Ferrovolt is a 2028 problem, not today’s.',
  ash: 'Everyone loves this name after the guidance bump. I am short 2,000. That usually ends badly.',
  vega: 'Realised vol is low. Holding base size, room to add on a clean signal.',
  pip: 'HLCN to the moon, holding 9k shares and not selling a single one.',
};

export const realPre = (ticker: string): Record<string, string> => ({
  marlowe: 'Cash flow and balance sheet first. I own 6,000 and I am in no hurry.',
  kestrel: 'Tape is quiet. Flat, no position, until volume tells me which way.',
  juno: 'Watching rates, suppliers and competitors for the second-order read.',
  ash: 'Whatever the crowd agrees on today, I will be on the other side. Short 2,000 to start.',
  vega: 'Realised vol is normal. Holding base size, room to add on a clean signal.',
  pip: `${ticker} only goes up, holding 9k shares and not selling a single one.`,
});

/** Builds the company context for a real ticker from a provider profile. */
export function realCompany(ticker: string, p: { name?: string; industry?: string; exchange?: string; marketCapM?: number; sharesM?: number } | null): CompanyCtx {
  const name = (p?.name || ticker).trim();
  const short = name.replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Ltd\.?|Limited|plc|PLC|Holdings?|Group|N\.?V\.?|S\.?A\.?|AG|SE)$/i, '').trim() || ticker;
  const ind = p?.industry?.trim().toLowerCase();
  const what = ind ? `${/^[aeiou]/.test(ind) ? 'an' : 'a'} ${ind} company` : 'a listed company';
  const where = p?.exchange ? `, listed on ${p.exchange}` : '';
  const cap = p?.marketCapM ? `, market capitalisation about $${p.marketCapM >= 1e6 ? (p.marketCapM / 1e6).toFixed(2) + ' trillion' : (p.marketCapM / 1e3).toFixed(1) + ' billion'}` : '';
  const sh = p?.sharesM ? `, about ${Math.round(p.sharesM).toLocaleString('en-US')} million shares outstanding` : '';
  const desc = `${name} (ticker ${ticker}) is ${what}${where}${cap}${sh}. On this exchange it trades in a simulated order book anchored to its real share price.`;
  return { desc, ticker, name, short };
}
