import { describe, it, expect } from 'vitest';
import { deps, RecConn, until } from './helpers';
import { FakeMarket } from '../../server/market/fake';
import { MarketHub } from '../../server/market/hub';
import { FinnhubProvider } from '../../server/market/finnhub';
import { usMarketOpenNow } from '../../server/market/provider';
import { FakeLLM } from '../../server/ai/fake';
import { Rooms } from '../../server/rooms';
import type { Room } from '../../server/room';

function setup() {
  const market = new FakeMarket();               // no automatic headlines: the test pushes them
  market.forceOpen = true;
  let newsCalls = 0;
  const news = market.news.bind(market);
  market.news = async (s: string) => { newsCalls++; return news(s); };
  const hub = new MarketHub(market, { quoteEverySec: 15, newsEverySec: 180, autoPoll: false });
  const llm = new FakeLLM({ firstTokenMs: 0, chunkMs: 0 });
  const d = deps({ llm, hub });
  const rooms = new Rooms(d);
  return { market, hub, llm, d, rooms, newsCalls: () => newsCalls };
}
const idle = (r: Room) => !r.round.busy;

describe('Real Market mode', () => {
  it('a new headline triggers exactly one AI round; duplicates are ignored', async () => {
    const { market, hub, llm, rooms } = setup();
    const room = await rooms.create({ mode: 'real', ticker: 'NVDA', hostToken: 'host-token-1' });
    room.attach(new RecConn(), 'host-token-1', 'Brae');
    const feed = hub.feeds.get('NVDA')!;
    expect(room.stats.rounds).toBe(0);

    market.push('NVDA', { id: 'n1', headline: 'Nvidia unveils next-generation AI chip', source: 'Reuters' });
    await feed.pollNews();
    await until(() => room.stats.rounds === 1 && idle(room));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].prompt).toContain('BREAKING HEADLINE: "Nvidia unveils next-generation AI chip"');

    // the same story again: same id, then same text under a new id, then a re-punctuated copy
    market.push('NVDA', { id: 'n1', headline: 'Nvidia unveils next-generation AI chip' });
    market.push('NVDA', { id: 'n2', headline: 'Nvidia unveils next-generation AI chip', source: 'Yahoo' });
    market.push('NVDA', { id: 'n3', headline: 'NVIDIA unveils next generation AI chip!' });
    await feed.pollNews();
    await feed.pollNews();
    await new Promise(r => setTimeout(r, 50));
    expect(room.stats.rounds).toBe(1);
    expect(llm.calls).toHaveLength(1);

    // a genuinely new story does run
    market.push('NVDA', { id: 'n4', headline: 'Nvidia faces new export restrictions to China' });
    await feed.pollNews();
    await until(() => room.stats.rounds === 2 && idle(room));
    expect(llm.calls).toHaveLength(2);
    await rooms.closeAll();
  });

  it('LIVE headlines are labelled with source and time; player headlines are PLAYER', async () => {
    const { market, hub, rooms } = setup();
    const room = await rooms.create({ mode: 'real', ticker: 'AAPL', hostToken: 'host-token-1' });
    const c = new RecConn();
    const p = room.attach(c, 'host-token-1', 'Brae');
    if (typeof p === 'string') throw new Error(p);
    const at = Date.parse('2026-10-08T14:32:00Z');
    market.push('AAPL', { id: 'x1', headline: 'Apple raises dividend', source: 'Reuters', url: 'https://example.com/a', time: at });
    await hub.feeds.get('AAPL')!.pollNews();
    await until(() => room.stats.rounds === 1 && idle(room));
    await room.handle(c, p, { k: 'news', text: 'Apple CEO adopts a dog' });
    await until(() => room.stats.rounds === 2 && idle(room));
    const [mine, live] = room.news.filter(n => n.kind === 'news');
    expect(live).toMatchObject({ origin: 'LIVE', source: 'Reuters', url: 'https://example.com/a', at: new Date(at).toISOString(), text: 'Apple raises dividend' });
    expect(mine).toMatchObject({ origin: 'PLAYER', by: 'Brae', text: 'Apple CEO adopts a dog' });
    await rooms.closeAll();
  });

  it('one poll serves every room on the same ticker', async () => {
    const { market, hub, llm, rooms, newsCalls } = setup();
    const a = await rooms.create({ mode: 'real', ticker: 'TSLA', hostToken: 'host-token-1' });
    const b = await rooms.create({ mode: 'real', ticker: 'TSLA', hostToken: 'host-token-2' });
    a.attach(new RecConn(), 'host-token-1', 'A'); b.attach(new RecConn(), 'host-token-2', 'B');
    expect(hub.feeds.size).toBe(1);
    const before = newsCalls();
    market.push('TSLA', { id: 't1', headline: 'Tesla deliveries beat estimates' });
    await hub.feeds.get('TSLA')!.pollNews();
    expect(newsCalls() - before).toBe(1);
    await until(() => a.stats.rounds === 1 && b.stats.rounds === 1 && idle(a) && idle(b));
    expect(llm.calls).toHaveLength(2);       // one round per room, not per poll per room
    await rooms.closeAll();
  });

  it('real quotes anchor fair value and show beside the simulated price', async () => {
    const { market, hub, rooms } = setup();
    market.setPrice('AMD', 150);
    const room = await rooms.create({ mode: 'real', ticker: 'AMD', hostToken: 'host-token-1' });
    expect(room.eng.S.open).toBeCloseTo(150, 0);
    const c = new RecConn();
    room.attach(c, 'host-token-1', 'Brae');
    market.setPrice('AMD', 165); market.forceOpen = false;          // closed market: quote stays put
    await hub.feeds.get('AMD')!.pollQuote();
    expect(room.eng.S.anchor).toBe(165);
    expect(c.of('room').at(-1)!.room.real!.price).toBe(165);
    for (let i = 0; i < 3000; i++) room.eng.tick();
    expect(room.eng.S.fvTarget).toBeGreaterThan(158);                // pulled toward the real price
    await rooms.closeAll();
  });

  it('says so when the US market is closed, and keeps running on the last real price', async () => {
    const { market, hub, rooms } = setup();
    const room = await rooms.create({ mode: 'real', ticker: 'MSFT', hostToken: 'host-token-1' });
    const c = new RecConn();
    room.attach(c, 'host-token-1', 'Brae');
    market.forceOpen = false;
    await hub.refreshStatus();
    expect(room.real!.marketOpen).toBe(false);
    expect(room.news[0].text).toBe('US market closed: running on the last real price');
    expect(c.of('room').at(-1)!.room.real!.marketOpen).toBe(false);
    const t = room.eng.S.t; room.frame(); expect(room.eng.S.t).toBe(t + 1); // still ticking
    await rooms.closeAll();
  });

  it('headlines that arrive while nobody is watching wait until someone joins', async () => {
    const { market, hub, rooms } = setup();
    const room = await rooms.create({ mode: 'real', ticker: 'META', hostToken: 'host-token-1' });
    market.push('META', { id: 'm1', headline: 'Meta announces buyback' });
    await hub.feeds.get('META')!.pollNews();
    await new Promise(r => setTimeout(r, 30));
    expect(room.stats.rounds).toBe(0);
    room.attach(new RecConn(), 'host-token-1', 'Brae');
    await until(() => room.stats.rounds === 1);
    await rooms.closeAll();
  });

  it('rejects unknown tickers and tickers with no quote', async () => {
    const { market, rooms } = setup();
    await expect(rooms.create({ mode: 'real', ticker: 'not a ticker', hostToken: 'host-token-1' })).rejects.toThrow(/US ticker/);
    await expect(rooms.create({ mode: 'real', ticker: 'ZZZZ', hostToken: 'host-token-1' })).rejects.toThrow(/No live quote/);
    market.down = true;
    await expect(rooms.create({ mode: 'real', ticker: 'GOOGL', hostToken: 'host-token-1' })).rejects.toThrow(/No live quote/);
  });

  it('knows US market hours', () => {
    expect(usMarketOpenNow(new Date('2026-10-08T15:00:00Z'))).toBe(true);    // Thu 11:00 New York
    expect(usMarketOpenNow(new Date('2026-10-08T21:00:00Z'))).toBe(false);   // Thu 17:00
    expect(usMarketOpenNow(new Date('2026-10-10T15:00:00Z'))).toBe(false);   // Saturday
  });
});

describe('Finnhub provider', () => {
  const fetchOf = (routes: Record<string, unknown>, seen: string[] = []) => (async (u: string | URL, init?: RequestInit) => {
    const url = new URL(String(u)); seen.push(url.pathname + url.search + ' token=' + new Headers(init?.headers).get('X-Finnhub-Token'));
    const body = routes[url.pathname]; return new Response(JSON.stringify(body ?? {}), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;

  it('maps quote, news, profile and market status, sending the key as a header', async () => {
    const seen: string[] = [];
    const f = new FinnhubProvider('k123', 50, fetchOf({
      '/api/v1/quote': { c: 182.5, pc: 180, t: 1760000000 },
      '/api/v1/company-news': [{ id: 7, headline: ' Old ', source: 'A', url: 'u1', datetime: 100 }, { id: 8, headline: 'New', source: 'B', url: 'u2', datetime: 200 }],
      '/api/v1/stock/profile2': { name: 'NVIDIA Corp', finnhubIndustry: 'Semiconductors', exchange: 'NASDAQ', marketCapitalization: 4.4e6, shareOutstanding: 24300 },
      '/api/v1/stock/market-status': { isOpen: false, session: 'post-market', holiday: null },
    }, seen));
    expect(await f.quote('NVDA')).toEqual({ price: 182.5, prevClose: 180, time: 1760000000000 });
    expect((await f.news('NVDA', '2026-10-06', '2026-10-09')).map(h => [h.id, h.headline])).toEqual([['8', 'New'], ['7', 'Old']]);
    expect(await f.profile('NVDA')).toMatchObject({ name: 'NVIDIA Corp', industry: 'Semiconductors', marketCapM: 4.4e6 });
    expect(await f.marketStatus()).toEqual({ isOpen: false, session: 'post-market', holiday: null });
    expect(seen[0]).toBe('/api/v1/quote?symbol=NVDA token=k123');
    expect(seen.join()).not.toContain('token=k123&');                       // never in the URL
  });

  it('treats an unknown symbol (c = 0) as no quote, and stays under its own rate limit', async () => {
    const f = new FinnhubProvider('k', 2, fetchOf({ '/api/v1/quote': { c: 0, pc: 0, t: 0 } }));
    expect(await f.quote('XXXX')).toBeNull();
    await f.quote('A');
    expect(await f.quote('B')).toBeNull();                                   // 3rd call in a minute with a limit of 2
  });
});
