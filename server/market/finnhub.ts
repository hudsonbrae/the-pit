// Finnhub (https://finnhub.io). Free tier: 60 calls/minute; /quote, /company-news,
// /stock/profile2 and /stock/market-status are free for US stocks. See docs/DATA.md.

import type { Headline, MarketProvider, MarketStatus, Profile, Quote } from './provider.js';

export class FinnhubProvider implements MarketProvider {
  readonly name = 'Finnhub';
  readonly real = true;
  private base = 'https://finnhub.io/api/v1';
  /** Timestamps of recent calls, for a client-side limit below Finnhub's 60/min. */
  private calls: number[] = [];

  constructor(private key: string, private perMinute = 50, private fetchFn: typeof fetch = fetch) {}

  private async get<T>(path: string, q: Record<string, string>): Promise<T | null> {
    const now = Date.now();
    this.calls = this.calls.filter(t => now - t < 60_000);
    if (this.calls.length >= this.perMinute) { console.warn(JSON.stringify({ ev: 'finnhub_throttled', path })); return null; }
    this.calls.push(now);
    const url = `${this.base}${path}?${new URLSearchParams(q)}`;
    try {
      const r = await this.fetchFn(url, { headers: { 'X-Finnhub-Token': this.key }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { console.warn(JSON.stringify({ ev: 'finnhub_http', path, status: r.status })); return null; }
      return (await r.json()) as T;
    } catch (e) {
      console.warn(JSON.stringify({ ev: 'finnhub_error', path, error: String((e as Error).message) }));
      return null;
    }
  }

  async quote(symbol: string): Promise<Quote | null> {
    const q = await this.get<{ c: number; pc: number; t: number }>('/quote', { symbol });
    if (!q || !(q.c > 0)) return null;           // Finnhub returns c=0 for unknown symbols
    return { price: q.c, prevClose: q.pc > 0 ? q.pc : null, time: (q.t || Date.now() / 1000) * 1000 };
  }

  async news(symbol: string, from: string, to: string): Promise<Headline[]> {
    const rows = await this.get<{ id: number; headline: string; source: string; url: string; datetime: number; summary?: string }[]>('/company-news', { symbol, from, to });
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r && typeof r.headline === 'string' && r.headline.trim() && Number.isFinite(r.datetime)).map(r => ({ id: String(r.id), headline: r.headline.trim(), source: typeof r.source === 'string' ? r.source : 'Finnhub', url: typeof r.url === 'string' ? r.url : '', time: r.datetime * 1000, summary: r.summary }))
      .sort((a, b) => b.time - a.time);
  }

  async profile(symbol: string): Promise<Profile | null> {
    const p = await this.get<{ name?: string; finnhubIndustry?: string; exchange?: string; marketCapitalization?: number; shareOutstanding?: number; currency?: string }>('/stock/profile2', { symbol });
    if (!p || !p.name) return null;
    return { name: p.name, industry: p.finnhubIndustry, exchange: p.exchange, marketCapM: p.marketCapitalization, sharesM: p.shareOutstanding, currency: p.currency };
  }

  async marketStatus(): Promise<MarketStatus | null> {
    const s = await this.get<{ isOpen: boolean; session: string | null; holiday: string | null }>('/stock/market-status', { exchange: 'US' });
    if (!s || typeof s.isOpen !== 'boolean') return null;
    return { isOpen: s.isOpen, session: s.session ?? null, holiday: s.holiday ?? null };
  }
}
