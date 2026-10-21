# Breakout Board

A free, always-on website that scans 100 of the largest US stocks on 4-hour candles every 4 hours and ranks them by momentum-breakout setup.

- **The scan** runs on GitHub Actions on a schedule. It pulls candles from Twelve Data, scores each stock, and saves `docs/data/latest.json`.
- **The website** is GitHub Pages serving `docs/`. It reads the latest results, so anyone with the link sees them without logging in.
- **Your Twelve Data API key** stays in GitHub's encrypted secrets. It never appears on the website.

Cost: $0. Public repositories get unlimited Actions minutes, and 6 scans a day use 600 of the free Twelve Data plan's 800 daily calls.

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

## Schedule

Every 4 hours on weekdays at :17 past 00, 04, 08, 12, 16 and 20 UTC, plus Saturday 00:17 UTC for Friday's close. In Arizona time that's 1:17, 5:17 and 9:17, both AM and PM, Monday through Friday. The 1:17 PM run lands just after the 4 PM Eastern close.

GitHub sometimes starts scheduled runs 5–30 minutes late when it's busy. The site always shows when the last scan finished, and flags it if a scan looks overdue.

To change the times, edit the `cron` lines in `.github/workflows/scan.yml` and the matching `SCHEDULE` line in `docs/index.html`.

## Changing the stock list

Edit `symbols.txt` on GitHub (pencil icon) and commit. The next scan uses the new list. On the free plan, keep it under about 130 tickers, or the daily call limit runs out before the last scan of the day.

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
