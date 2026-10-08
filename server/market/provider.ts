// Market data: real quotes and company headlines for Real Market rooms.

export interface Quote { price: number; prevClose: number | null; time: number /* ms */ }
export interface Headline { id: string; headline: string; source: string; url: string; time: number /* ms */; summary?: string }
export interface Profile { name?: string; industry?: string; exchange?: string; marketCapM?: number; sharesM?: number; currency?: string }
export interface MarketStatus { isOpen: boolean; session: string | null; holiday: string | null }

export interface MarketProvider {
  readonly name: string;
  readonly real: boolean;
  quote(symbol: string): Promise<Quote | null>;
  /** Company news between two dates (YYYY-MM-DD, inclusive), newest first. */
  news(symbol: string, from: string, to: string): Promise<Headline[]>;
  profile(symbol: string): Promise<Profile | null>;
  marketStatus(): Promise<MarketStatus | null>;
}

/** US regular session, Mon–Fri 09:30–16:00 New York time. Used when the provider can't tell us. */
export function usMarketOpenNow(now = new Date()): boolean {
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => ny.find(p => p.type === t)?.value ?? '';
  const wd = get('weekday'), mins = Number(get('hour')) * 60 + Number(get('minute'));
  return !['Sat', 'Sun'].includes(wd) && mins >= 570 && mins < 960;
}
