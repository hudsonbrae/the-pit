# Market data for Real Market mode

## Choice: Finnhub (free plan)

Real Market rooms need two things from a data provider, both on a free plan:
**the latest price** for a US stock, and **company headlines** for it. The
headlines also have to be allowed on screen in an app. Finnhub's free plan
provides both.

| Provider | Free quotes | Free company news | Free limit | Verdict |
|---|---|---|---|---|
| **Finnhub** | Real-time US last price (`/quote`) | Yes, per ticker (`/company-news`), with source and link | 60 calls/min | **Chosen** |
| Alpha Vantage | Yes | Yes (news & sentiment) | 25 calls/**day** | Too few calls: 25 a day can't keep a single room fresh for an hour |
| Polygon.io (now "Massive") | End-of-day / previous close on the free plan | Yes | 5 calls/min | No live intraday price on the free plan, and the call limit is tight |
| Twelve Data | Yes | No company news | 8/min, 800/day | No headlines |
| Financial Modeling Prep | Yes | News is on paid plans | 250/day | No free headlines, low daily cap |

These limits are as published by each provider at the time of writing. They
change, so check them when you sign up. I couldn't open finnhub.io's own pages
from the build environment (its network blocks that site), so the Finnhub
figures were cross-checked against several independent sources and the official
API client docs.

### Endpoints used (all on the free plan)

| What | Endpoint | How often |
|---|---|---|
| Last price | `GET /api/v1/quote?symbol=AAPL` | every 15 s per ticker that has a room open |
| Company headlines | `GET /api/v1/company-news?symbol=AAPL&from=…&to=…` | every 3 min per ticker |
| Company name, industry, size (used to describe the company to Claude) | `GET /api/v1/stock/profile2?symbol=AAPL` | once per ticker |
| Is the US market open? | `GET /api/v1/stock/market-status?exchange=US` | every 5 min (one call for all rooms) |

The key goes in the `X-Finnhub-Token` header and never appears in a URL or
in the browser.

### Rate limits and caching

- **One poll serves every room on the same ticker.** `server/market/hub.ts`
  keeps one poller per ticker. Ten rooms on NVDA cost the same as one.
- Per open ticker: 4 quote calls + 0.33 news calls a minute, about 4.3
  calls/minute. With the 5-minute market-status call shared across tickers,
  **about 11 different tickers can be open at once** within the free
  60/minute.
- The server also enforces its own ceiling of **50 calls/minute**
  (`server/market/finnhub.ts`), below Finnhub's 60, so a burst can't get the
  key throttled. If the ceiling is reached, that poll is skipped and the next
  one catches up.
- Polling stops as soon as the last room on a ticker closes.
- To change the timing, set `QUOTE_POLL_SEC` and `NEWS_POLL_SEC` in `.env`.

### Headlines: what counts as new

- On a ticker's first poll, everything already published counts as history,
  not breaking news. The newest of those headlines, if it is less than 24 hours
  old, opens a new room, so there is something to react to immediately.
- After that, a headline is new only if neither its id nor its text has
  been seen. Text is compared after lower-casing and stripping punctuation.
  Finnhub often carries the same story from several outlets, so this
  matters. Each room also keeps its own seen-list.
- Each new headline goes through the normal AI round, marked **LIVE** with
  its source, publish time and a link to the article. Headlines typed by
  players are marked **PLAYER**.
- If several headlines arrive during one round, the three newest wait in a
  queue. Older ones are dropped, so a busy news day doesn't run up AI cost.
- Headlines that arrive while nobody is in the room wait until someone joins.

### Quotes: how the simulation follows the real price

Every tick (250 ms), the engine nudges its hidden fair value 0.2% of the way
toward the latest real price (`anchorK` in `server/engine.ts`). That is a
half-life of about 2 minutes. The simulated book drifts back to reality
between headlines. A big AI-judged headline can still push the simulated
price away from the real one for a while, and that gap is what players
can trade.

The header shows both prices side by side, labelled **"Simulated exchange
anchored to real price."**

### Market hours

US regular hours are 9:30 to 16:00 New York time, Monday to Friday. Finnhub's
market-status endpoint also knows about holidays. Outside those hours the
room keeps running on the last real price, and the UI says
"US market closed · running on last real price". If the status call fails,
the server works it out from the clock.

### Tickers: US only

Real mode accepts US-listed tickers only (`AAPL`, `NVDA`, `TSLA`, `BRK.B`, …).
On Finnhub's free plan, non-US exchanges such as the ASX don't return
reliable quotes (international stock data is on its paid plans), so ASX
tickers aren't offered.

### Terms

Finnhub's free plan is for **personal, non-commercial use**. The Pit fits
that: Brae and friends playing with fake money, no ads, no charges, no data
resale. The app shows each headline with its source and a link to the
original article, and the footer credits Finnhub. Read Finnhub's terms when
you create the account. If the app ever became commercial (ads, paid
access), it would need a paid Finnhub plan, and per the brief you'd decide
that before anything costs money.

## Without a key

With `FINNHUB_API_KEY` empty, the server uses `server/market/fake.ts`. It
gives plausible prices that drift slowly, and a made-up headline every 4
minutes (`MOCK_NEWS_EVERY_SEC`). Everything works the same way, and the
footer names the source as "Mock market data". Add the key and restart; no
code changes are needed.
