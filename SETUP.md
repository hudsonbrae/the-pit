# Setting up The Pit (step by step)

By the end you'll have a link like `https://the-pit-xxxx.onrender.com`. Open
it on your phone, create a room on a real ticker, and send the link to a
friend.

It takes about 30–45 minutes. You'll create four free accounts. Only one of
them, Anthropic, ever costs money: you pay for what Claude uses, from credit
you load yourself, and you'll set a hard monthly limit on it in step 1.

| Service | What it does here | Cost |
|---|---|---|
| Anthropic | The six AI traders (Claude) | Pay-as-you-go from prepaid credit. You set the monthly limit. Roughly 2–4 cents per AI round, 4–7 cents per floor debate (see "What it costs") |
| Finnhub | Real stock prices and headlines | Free plan |
| Supabase | Database: rooms, players' positions, traders' lessons | Free plan |
| Render | Runs the app on the internet | Free plan. Render may ask for a card to verify you; it doesn't charge the free plan |

> **You don't need any of the keys to try it.** Without them the app runs on
> built-in stand-ins (Mock Claude, mock prices and headlines, memory). Each
> key you add switches one part to the real thing.

---

## Step 1: Anthropic (Claude) key and a monthly spend limit

1. Go to **<https://platform.claude.com>** (the Anthropic Console; the old
   address console.anthropic.com takes you there too) and sign up, or log in.
2. **Add credit.** Open **Settings → Billing**, click **Buy credits**, and
   start small, e.g. **$10**. Leave **auto-reload off**. With auto-reload off,
   spending stops when the credit runs out, whatever happens.
3. **Set a monthly spend limit. Do this before the first deploy.**
   Open **Settings → Limits** (or, on some accounts, **Organization settings
   → Billing → Spend limits**), click **Change limit** (or **Set limit**),
   enter a monthly amount such as **$20**, and save. If the monthly total
   reaches it, Claude calls stop until next month and the game carries on
   with its offline traders.
4. **Create the key.** Open **Settings → API keys**, click **Create key**,
   name it `the-pit`, and click **Create**. **Copy the key now**: it starts
   with `sk-ant-` and is shown only once. Paste it somewhere private for
   step 5.

## Step 2: Finnhub key (real prices and headlines)

1. Go to **<https://finnhub.io/register>** and sign up with your email (or Google).
2. Click the link in the verification email Finnhub sends you.
3. Log in and open **<https://finnhub.io/dashboard>**. Your **API key** is
   shown at the top of the page. Copy it.
4. The free plan is for personal, non-commercial use, which is what this
   is. Read and accept the terms when you sign up. See
   [docs/DATA.md](docs/DATA.md) for why Finnhub and what its limits are.

## Step 3: Supabase (the database)

1. Go to **<https://supabase.com>**, click **Start your project**, and sign
   up (signing in with GitHub is easiest).
2. Click **New project**:
   - **Name:** `the-pit`
   - **Database password:** click **Generate a password** (you won't need it
     for this app, but keep it somewhere safe)
   - **Region:** **Southeast Asia (Singapore)**, so the database sits next
     to the server
   - Plan: **Free**. Click **Create new project** and wait about a minute.
3. **Create the tables.** In the left sidebar click **SQL Editor**, then
   **New query**. Open the file [`supabase/schema.sql`](supabase/schema.sql)
   from this repo, copy **all** of it, paste it into the editor, and click
   **Run**. You should see "Success. No rows returned". (The file is safe to
   run again whenever it changes: it only adds what's missing.)
4. **Copy the two values the app needs:**
   - **Project URL:** click **Connect** at the top of the project page (or
     **Project Settings → Data API**). It looks like
     `https://abcdefghijkl.supabase.co`.
   - **Secret key:** **Project Settings → API Keys**. Under **Secret keys**,
     click **Reveal**, then copy the key (it starts with `sb_secret_`). On older
     projects you'll instead find the **`service_role`** key under **Legacy API
     Keys**; that works too.

   ⚠️ The secret key can read and write everything in your database. Only
   ever put it in `.env` or in Render's settings, never in a message, a
   screenshot or a file in GitHub.

Free Supabase projects pause after a week with no activity. If that happens,
open the Supabase dashboard and click **Restore project**.

## Step 4: Run it on your computer (optional, but a good check)

1. Install **Node.js 22 LTS** from <https://nodejs.org> (click the big
   "LTS" button and run the installer).
2. Download the code. On the GitHub page for this repo click **Code →
   Download ZIP** and unzip it, or use `git clone`.
3. In the project folder, make a copy of **`.env.example`** and name the copy
   **`.env`**. Open `.env` in any text editor and fill in exactly these
   lines (leave everything else as it is):

   ```
   ANTHROPIC_API_KEY=sk-ant-...your key from step 1...
   FINNHUB_API_KEY=...your key from step 2...
   SUPABASE_URL=https://abcdefghijkl.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_...your key from step 3...
   ```

   `.env` is in `.gitignore`, so it never gets uploaded to GitHub.
4. Open a terminal in the project folder (on a Mac: right-click the folder →
   **New Terminal at Folder**; on Windows: open the folder, type `cmd` in the
   address bar, press Enter) and run this **one command**:

   ```
   npm run local
   ```

   When it says `The Pit is running on http://localhost:8787`, open that
   address in your browser. The startup lines tell you which parts are real
   and which are mocks, for example `AI: Claude on the floor`.

## Step 5: Put it on the internet (Render)

1. **Get the code onto the main branch on GitHub.** The work is on the
   branch `claude/festive-gauss-lpi4ci`. On
   <https://github.com/hudsonbrae/the-pit> click **Pull requests → New pull
   request**, set **base: main** and **compare: claude/festive-gauss-lpi4ci**,
   then click **Create pull request**, then **Merge pull request**, then
   **Confirm merge**.
   (Or skip this and choose that branch in step 4 below.)
2. Go to **<https://render.com>** and click **Get Started**. Sign up **with
   GitHub** and allow Render to see the `the-pit` repository.
3. In the Render dashboard click **New +** (top right), then **Blueprint**.
4. Pick the **`hudsonbrae/the-pit`** repository (and branch `main`). Render
   reads the `render.yaml` file in the repo and shows one service called
   **`the-pit`** on the **Free** plan. If it shows any paid plan, stop:
   nothing in this repo asks for one.
5. Render asks for four values (marked as secret). Paste in:

   | Key | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
   | `FINNHUB_API_KEY` | your Finnhub key |
   | `SUPABASE_URL` | your `https://….supabase.co` URL |
   | `SUPABASE_SECRET_KEY` | your `sb_secret_...` key |

6. Click **Deploy Blueprint** (on some screens the button is labelled
   **Apply**). The first build takes 3–5 minutes. When the service shows
   **Live**, its address is at the top of the service page, something like
   **`https://the-pit-xxxx.onrender.com`**.
7. **Check it:** open `https://the-pit-xxxx.onrender.com/api/health`. You
   should see `"ai":"Claude on the floor"`, `"market":"Finnhub"` and
   `"store":"supabase"`. If one of them says "Mock" or "memory", that key is
   missing or mistyped. Fix it under the service's **Environment** tab; Render
   redeploys by itself.
8. **Your control room (optional):** Render created a random `ADMIN_TOKEN` for
   you. Copy it from the service's **Environment** tab and open
   `https://the-pit-xxxx.onrender.com/admin#token=PASTE_IT_HERE`. It shows every
   room, AI latency, tokens, the day's estimated cost, data freshness and any
   errors. Don't share that link.

## Step 6: Play

**The fastest way to show someone: run the demo.**

1. On a laptop (or a TV), open your Render link and tap **Run the demo**. A
   scripted, six-minute story plays out: a calm open, a bombshell, a floor
   debate, a crash, a halt, a twist, and then the scores. Tap **Stage** at the
   top for the big-screen layout.
2. Tap **Room XXXXX · invite** and send the link to your friend's phone. They
   type a name and trade from the bar at the bottom of their screen while it
   happens.
3. When it ends, everyone sees the **Daily wrap**. As host, tap **Start a new
   session** to play again. The traders remember how they did.

The "Host · lab" button (host only) has the other scenarios (flash crash,
short squeeze, earnings, black swan, liquidity crisis), the market dials, and
the **closing bell**.

**A real stock:**

1. Open your Render link on your phone.
2. Type your name, tap **Real · ticker**, enter e.g. `NVDA`, and tap
   **Open the room**.
3. Tap **Room XXXXX · invite** at the top. On a phone this opens the share
   sheet, so send it to a friend by text or WhatsApp. On a computer it copies the link.
4. Your friend opens the link, types a name and is on the same floor. Real
   headlines arrive on their own, marked **LIVE**, and the six traders debate
   each one before trading. Anything you type is marked **PLAYER**. Tap a
   trader to see their record and question them.
5. Someone who only wants to watch (on a TV, say) can use the **watch link**
   from Host · lab. They see everything but don't take a seat.

Tip: add the link to your home screen (Share → **Add to Home Screen**) so it
opens like an app.

---

## Good to know

**The first visit after a quiet spell takes about a minute.** Render's free
plan puts the app to sleep after 15 minutes with no visitors and wakes it on
the next visit. Rooms, positions and the traders' lessons are kept in
Supabase, and your room link keeps working after a wake-up. The simulated
price restarts from the current real price.

**What it costs (Anthropic only).** These are measured prompt sizes, not a
bill:

- **One AI round** (a headline read by all six traders) is about 2,700 input
  and 1,000 output tokens on the Sonnet model: about **1.6 cents**, or 2–4
  cents with the model's thinking.
- **A floor debate** is two calls: about **3.3 cents**, or 4–7 cents with thinking.
- **Asking a trader, "Claude writes the news" and the narrator** use the much
  cheaper Haiku model: a fraction of a cent each.
- **The demo** costs about 10 cents.
- **A busy 20-minute session** with a friend is typically **$0.50–$1.00**.

Check the Anthropic Console's usage page (or `/admin`) after your first
session. Built-in brakes (change them in Render → **Environment**):

- `AI_ROUNDS_PER_MIN_PER_ROOM=3`: at most 3 AI rounds a minute per room (a debate counts as 2)
- `AI_ROOM_DAILY_ROUND_CAP=80`: at most 80 per room per day
- `AI_DAILY_ROUND_CAP=200`: at most 200 a day across all rooms, about $4–8 at most. This survives restarts.
- Each player can break news once every 8 seconds. "Deep think" (slower, pricier) is host-only.
- On top of all these, the monthly spend limit you set in step 1.

When a cap is hit the game keeps working: the traders switch to their
offline rules and the header says so.

**Token usage is logged.** Every Claude call writes a line like
`{"ev":"ai_usage","kind":"round","inputTokens":…,"outputTokens":…}` to the
logs (Render → your service → **Logs**). Each headline in the Supabase
`news_log` table also records its token counts.

**Changing a key later:** Render → your service → **Environment** → edit →
**Save changes**. It redeploys automatically. No code changes are ever needed.

**If something's wrong:**
- *"No live quote found for XYZ"*: Real mode supports US-listed tickers only (NVDA, AAPL, TSLA, …).
- *Header says "Offline sim (API key rejected)"*: the Anthropic key is wrong
  or has been deleted. Create a new one (step 1.4) and update it in Render.
- *Header says "Offline sim (daily AI cap reached)"*: the daily cap was hit; it resets at 00:00 UTC.
- *A friend sees "No room with that code"*: check the five letters. Rooms
  are kept for as long as the Supabase project exists.

**Nothing here can trade real money.** There is no brokerage connection,
no payment handling and no real orders anywhere in the code.
