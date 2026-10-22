# 4 Hour Algorithm Breakouts

A free, always-on website that scans the S&P 500 on 4-hour candles four times each trading day, ranks every stock by momentum-breakout setup, and flags the top 3 breakouts.

- **The scan** runs on GitHub Actions on a schedule. It pulls candles from Twelve Data, scores each stock, and saves `docs/data/latest.json`.
- **The website** is GitHub Pages serving `docs/`. It reads the latest results, so anyone with the link sees them without logging in.
- **Your Twelve Data API key** stays in GitHub's encrypted secrets. It never appears on the website.

Cost: $0. Public repositories get unlimited Actions minutes, and 4 scans a day use 400 of the free Twelve Data plan's 800 daily calls.

## Setup (about 10 minutes)

### 1. Get a Twelve Data API key
Sign in at twelvedata.com, open **API Keys** in your dashboard, and copy the key.

### 2. Create the repository
1. On GitHub, click **New repository**. Name it something like `breakout-board`, choose **Public**, and click **Create repository**.
2. On the empty repository page, click **uploading an existing file**.
3. Unzip `breakout-board.zip` and drag **everything inside** the `breakout-board` folder into the upload area: `docs`, `scripts`, `.github`, `symbols.txt`, `README.md`.
   - On a Mac, the `.github` folder is hidden in Finder. Press **Cmd + Shift + .** to show it before dragging.
4. Click **Commit changes**.

Check that the repository now shows a `.github/workflows/scan.yml` file. If it doesn't, the hidden folder didn't upload. Click **Add file → Create new file**, type `.github/workflows/scan.yml` as the name, paste in that file's contents, and commit.

### 3. Add your API key as a secret
**Settings → Secrets and variables → Actions → New repository secret**
- Name: `TWELVE_DATA_API_KEY`
- Secret: your key

### 4. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source: GitHub Actions**

### 5. Run the first scan
**Actions** tab → **Scan and publish** → **Run workflow** → **Run workflow**.

It takes about 15 minutes (the free plan allows 8 calls per minute). When it finishes with a green check, your site is live at:

`https://<your-github-username>.github.io/<repository-name>/`

The link also appears on the finished run's **deploy** step and under **Settings → Pages**.

After that it runs on its own.

## Data: Alpaca (S&P 500) or Twelve Data (100 stocks)

With Alpaca keys set, each scan covers the full S&P 500 (`sp500.txt`, plus anything in `symbols.txt`) and takes about a minute. Alpaca's free plan allows 200 calls a minute and serves full-market data once it is 15 minutes old, which is why the after-close scan runs at 4:20 PM. Without Alpaca keys, the scan falls back to Twelve Data and the 100 stocks in `symbols.txt`.

To set up Alpaca (free, no deposit):
1. Sign up at alpaca.markets. A paper-trading account is enough.
2. In the dashboard, generate an API key. Copy the key ID and the secret (the secret is shown only once).
3. In this repository: **Settings → Secrets and variables → Actions → New repository secret**. Add `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`.
4. **Actions → Scan and publish → Run workflow** to test it. The page header changes to "the S&P 500" when it works.

Only the 3 highest-scoring breakouts keep the Breakout label each scan; any others show as Setting up.

## Schedule

Scans run on weekdays during US market hours, at these New York times:

| New York | Arizona (until Nov 1) | Arizona (Nov 1 – Mar 7) | Why |
|---|---|---|---|
| 11:35 AM | 8:35 AM | 9:35 AM | Mid-morning |
| 1:35 PM | 10:35 AM | 11:35 AM | First 4-hour candle has just closed |
| 3:35 PM | 12:35 PM | 1:35 PM | Last half hour of trading |
| 4:20 PM | 1:20 PM | 2:20 PM | After the close, once the day's final candle is available |

NYSE holidays and weekends are skipped, and New York daylight saving time is handled automatically. Each scan takes about 13 minutes, so results appear roughly 15 minutes after the start time. Four scans a day use 400 of the free plan's 800 daily Twelve Data calls, leaving room for manual runs.

You can still scan any time from **Actions → Scan and publish → Run workflow**.

GitHub sometimes starts scheduled runs 5–30 minutes late when it's busy. The site always shows when the last scan finished, and flags it if a scan looks overdue.

To change the times, edit the `cron` lines and the `gate` job in `.github/workflows/scan.yml`, and the matching `SLOTS` line in `docs/index.html`. The holiday list in both files covers through 2027.

## Changing the stock list

Edit `symbols.txt` on GitHub (pencil icon) and commit. The next scan uses the new list. On the free plan, keep it under about 190 tickers, or the daily call limit runs out before the last scan of the day.

If you upgrade your Twelve Data plan, add a repository **variable** (not secret) named `CALLS_PER_MINUTE` with your new limit to make scans faster.

## If something goes wrong

- **Red X on a run in the Actions tab:** click it, then the **scan** step, to see the error. "API key" errors mean the secret is missing or mistyped. If a scan fails, the site keeps showing the previous results.
- **Scans stop after a couple of months:** GitHub pauses schedules in repositories with no activity for 60 days. The scan's own commits normally count as activity, but if it happens, the Actions tab shows an **Enable workflow** button.
- **One ticker shows "No data":** check the symbol in `symbols.txt` matches what Twelve Data uses.

## Running it on your own computer

```
node scripts/scan.mjs --sample                            # invented data, no key
TWELVE_DATA_API_KEY=yourkey node scripts/scan.mjs         # real scan
cd docs && python3 -m http.server 8000                    # then open http://localhost:8000
```

Requires Node 18 or newer. No packages to install.

---

For research and education only. Not investment advice. Signals are mechanical and ignore news, earnings dates and fundamentals.

## Breakout track record

`docs/performance.html` (linked from the main page) lists every stock the scan has flagged as a breakout, with the date it was added, the breakout price, the recommended stop and sell limit, and its return 1 week, 1 month, 2 months, 6 months and 1 year later.

- After every scan, `scripts/track.mjs` adds that scan's breakouts to `docs/data/breakouts.json`, keeping at most the 3 highest-scoring per day. A stock flagged again within 7 days isn't added twice.
- With Alpaca it refreshes daily closes after every scan in a single call. With Twelve Data it does so after the 4:20 PM scan (and on manual runs), one call per stock that still has an open holding period, and fills in each return once its date has passed. It also fetches SPY (one call) so every return is compared with the S&P 500 over the same days. At most about 100 extra calls a day, so the total stays under the free plan's 800.
