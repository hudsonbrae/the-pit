// A stand-in market-data provider for running without a Finnhub key, and for tests.
// Prices take a slow random walk; a new plausible headline appears every few minutes.

import type { Headline, MarketProvider, MarketStatus, Profile, Quote } from './provider.js';
import { usMarketOpenNow } from './provider.js';

const BASE: Record<string, [number, string, string]> = {
  AAPL: [228, 'Apple Inc', 'Technology'], NVDA: [182, 'NVIDIA Corp', 'Semiconductors'], TSLA: [245, 'Tesla Inc', 'Automobiles'],
  MSFT: [430, 'Microsoft Corp', 'Technology'], AMZN: [190, 'Amazon.com Inc', 'Retail'], GOOGL: [165, 'Alphabet Inc', 'Media'],
  META: [560, 'Meta Platforms Inc', 'Media'], AMD: [155, 'Advanced Micro Devices Inc', 'Semiconductors'],
};

const TEMPLATES = [
  '{n} shares climb as analysts lift price targets after product event',
  '{n} faces new antitrust questions in Europe, report says',
  '{n} supplier flags stronger orders for the coming quarter',
  '{n} executive sells shares under pre-arranged trading plan',
  '{n} announces expanded buyback programme',
  'Short interest in {n} rises to a six-month high',
  '{n} wins large multi-year government contract',
  '{n} recalls a batch of devices over overheating concerns',
];

export class FakeMarket implements MarketProvider {
  readonly name = 'Mock market data';
  readonly real = false;
  private px = new Map<string, number>();
  private feed = new Map<string, Headline[]>();
  private seq = 0;
  private lastGen = new Map<string, number>();
  /** Fail every call (tests the "provider down" path). */
  down = false;
  /** Treat the market as open/closed; null = use the real US clock. */
  forceOpen: boolean | null = null;

  constructor(private o: { autoNewsEverySec?: number; random?: () => number; now?: () => number } = {}) {}

  private R() { return (this.o.random ?? Math.random)(); }
  private now() { return (this.o.now ?? Date.now)(); }

  /** Tests: add a headline to the feed for a symbol. Same id twice = duplicate. */
  push(symbol: string, h: Partial<Headline> & { headline: string }): Headline {
    const item: Headline = { id: h.id ?? `mock-${++this.seq}`, headline: h.headline, source: h.source ?? 'MockWire', url: h.url ?? 'https://example.com/news', time: h.time ?? this.now() };
    const arr = this.feed.get(symbol) ?? [];
    arr.unshift(item); if (arr.length > 50) arr.length = 50;
    this.feed.set(symbol, arr);
    return item;
  }

  setPrice(symbol: string, price: number) { this.px.set(symbol, price); }

  async quote(symbol: string): Promise<Quote | null> {
    if (this.down) return null;
    if (!/^[A-Z][A-Z.]{0,5}$/.test(symbol) || symbol === 'ZZZZ') return null;
    let p = this.px.get(symbol) ?? BASE[symbol]?.[0] ?? 50 + (symbol.charCodeAt(0) % 20) * 7;
    if (this.forceOpen ?? usMarketOpenNow(new Date(this.now()))) p = Math.round(p * (1 + (this.R() - 0.5) * 0.004) * 100) / 100;
    this.px.set(symbol, p);
    return { price: p, prevClose: BASE[symbol]?.[0] ?? null, time: this.now() };
  }

  async news(symbol: string): Promise<Headline[]> {
    if (this.down) return [];
    const every = this.o.autoNewsEverySec ?? 0;
    if (every > 0) {
      const last = this.lastGen.get(symbol);
      if (last == null) { this.lastGen.set(symbol, this.now()); this.push(symbol, { headline: this.make(symbol), time: this.now() - 20 * 60_000 }); }
      else if (this.now() - last >= every * 1000) { this.lastGen.set(symbol, this.now()); this.push(symbol, { headline: this.make(symbol) }); }
    }
    return [...(this.feed.get(symbol) ?? [])];
  }

  private make(symbol: string) {
    const n = (BASE[symbol]?.[1] ?? symbol).replace(/ (Inc|Corp|Platforms Inc|\.com Inc)$/, '').replace(/ Inc$/, '');
    return TEMPLATES[Math.floor(this.R() * TEMPLATES.length)].replace('{n}', n);
  }

  async profile(symbol: string): Promise<Profile | null> {
    if (this.down) return null;
    const b = BASE[symbol];
    return b ? { name: b[1], industry: b[2], exchange: 'NASDAQ NMS - GLOBAL MARKET', currency: 'USD' } : { name: symbol, currency: 'USD' };
  }

  async marketStatus(): Promise<MarketStatus | null> {
    if (this.down) return null;
    const open = this.forceOpen ?? usMarketOpenNow(new Date(this.now()));
    return { isOpen: open, session: open ? 'regular' : 'closed', holiday: null };
  }
}
