// One poller per ticker, shared by every room trading that ticker, so the number
// of provider calls does not grow with the number of rooms. Caches the last quote,
// profile and market status; de-duplicates headlines before handing them out.

import type { Headline, MarketProvider, MarketStatus, Profile, Quote } from './provider.js';
import { usMarketOpenNow } from './provider.js';

export interface FeedListener {
  onQuote(q: Quote): void;
  onHeadline(h: Headline): void;
  onStatus(s: MarketStatus): void;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Headline text normalised for duplicate detection across sources. */
export const normHeadline = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class TickerFeed {
  readonly listeners = new Set<FeedListener>();
  quote: Quote | null = null;
  profile: Profile | null = null;
  /** Newest headline seen at the first poll (a fresh room can open on it). */
  newest: Headline | null = null;
  baselined = false;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(readonly symbol: string, private hub: MarketHub) {}

  private remember(key: string) {
    if (this.seen.has(key)) return;
    this.seen.add(key); this.seenOrder.push(key);
    if (this.seenOrder.length > 2000) this.seen.delete(this.seenOrder.shift()!);
  }
  private isSeen(h: Headline) { return this.seen.has('id:' + h.id) || this.seen.has('tx:' + normHeadline(h.headline)); }

  async pollQuote() {
    const q = await this.hub.provider.quote(this.symbol);
    if (!q) return null;
    this.quote = q;
    this.listeners.forEach(l => l.onQuote(q));
    return q;
  }

  async pollNews() {
    const now = this.hub.now();
    const items = await this.hub.provider.news(this.symbol, ymd(now - 2 * 86_400_000), ymd(now + 86_400_000));
    if (!this.baselined) {
      // First poll: everything already published is history, not breaking news.
      items.forEach(h => { this.remember('id:' + h.id); this.remember('tx:' + normHeadline(h.headline)); });
      this.newest = items[0] ?? null;
      this.baselined = true;
      return [];
    }
    const fresh = items.filter(h => !this.isSeen(h)).sort((a, b) => a.time - b.time);
    const out: Headline[] = [];
    for (const h of fresh) {
      if (this.isSeen(h)) continue;        // same text twice inside one batch
      this.remember('id:' + h.id); this.remember('tx:' + normHeadline(h.headline));
      out.push(h);
      this.listeners.forEach(l => l.onHeadline(h));
    }
    return out;
  }

  start() {
    if (this.timers.length || !this.hub.autoPoll) return;
    this.timers.push(setInterval(() => void this.pollQuote(), this.hub.quoteEveryMs));
    this.timers.push(setInterval(() => void this.pollNews(), this.hub.newsEveryMs));
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
}

export class MarketHub {
  readonly feeds = new Map<string, TickerFeed>();
  status: MarketStatus | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(readonly provider: MarketProvider, readonly o: { quoteEverySec: number; newsEverySec: number; autoPoll?: boolean; now?: () => number }) {}

  get autoPoll() { return this.o.autoPoll !== false; }
  get quoteEveryMs() { return this.o.quoteEverySec * 1000; }
  get newsEveryMs() { return this.o.newsEverySec * 1000; }
  now() { return (this.o.now ?? Date.now)(); }

  /** Open or closed right now, from the provider if it answered, else from the clock. */
  marketOpen(): boolean { return this.status?.isOpen ?? usMarketOpenNow(new Date(this.now())); }

  async refreshStatus() {
    const s = await this.provider.marketStatus();
    this.status = s ?? { isOpen: usMarketOpenNow(new Date(this.now())), session: null, holiday: null };
    this.feeds.forEach(f => f.listeners.forEach(l => l.onStatus(this.status!)));
    return this.status;
  }

  /** Looks a ticker up before a room is created: needs a real quote to anchor to. */
  async prepare(symbol: string): Promise<TickerFeed | null> {
    let f = this.feeds.get(symbol);
    if (f?.quote) return f;
    f ??= new TickerFeed(symbol, this);
    const q = await f.pollQuote();
    if (!q) return null;
    this.feeds.set(symbol, f);
    if (!f.profile) f.profile = await this.provider.profile(symbol);
    if (!f.baselined) await f.pollNews();
    if (!this.status) await this.refreshStatus();
    return f;
  }

  subscribe(symbol: string, l: FeedListener): () => void {
    const f = this.feeds.get(symbol);
    if (!f) throw new Error('prepare() the ticker first');
    f.listeners.add(l);
    f.start();
    if (this.autoPoll && !this.statusTimer) this.statusTimer = setInterval(() => void this.refreshStatus(), 5 * 60_000);
    return () => {
      f.listeners.delete(l);
      if (!f.listeners.size) { f.stop(); }
      if (![...this.feeds.values()].some(x => x.listeners.size) && this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    };
  }

  stopAll() { this.feeds.forEach(f => f.stop()); if (this.statusTimer) clearInterval(this.statusTimer); this.statusTimer = null; }
}
