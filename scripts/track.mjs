#!/usr/bin/env node
// Breakout track record.
// Records every stock the scan flags as a breakout and measures how it did
// from the breakout price 1 week, 1 month, 2 months, 6 months and 1 year later.
// Writes docs/data/breakouts.json for docs/performance.html.
//
//   node scripts/track.mjs                     add breakouts from docs/data/summary.json (no API calls)
//   node scripts/track.mjs --prices            ...and refresh daily closes from Twelve Data
//   node scripts/track.mjs a.json b.json       add breakouts from other summary files (backfill)
//
// Rules
// - Breakout date = trading day of the scan's latest candle. Breakout price = the
//   scan's entry price the first time the stock was flagged.
// - At most 3 breakouts a day: the day's highest-scoring ones across all scans.
//   A later scan can replace an earlier, lower-scoring pick from the same day.
// - A stock flagged again within 7 calendar days of its last entry is not added twice.
// - Each horizon uses the daily close on the first trading day on or after
//   the breakout date + 7 days / 1 / 2 / 6 / 12 months.
// - Benchmark: each return is compared with SPY (S&P 500 ETF) over the same days,
//   from SPY's close on the breakout date to its close on the same horizon date.
//   "vs" = stock return minus SPY return, in percentage points.
// - Splits: the first fetch stores the daily close on the breakout date; if a later
//   fetch shows a different (split-adjusted) close for that day, the breakout price
//   is scaled by the same factor.
//
// Env: ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY (preferred; one call for every stock),
//      or TWELVE_DATA_API_KEY + CALLS_PER_MINUTE (one call per stock, default 8/min)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alpacaBars } from "./scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "breakouts.json");
const SUMMARY = join(ROOT, "docs", "data", "summary.json");
const KEY = process.env.TWELVE_DATA_API_KEY;
const PACE = Math.max(1, Number(process.env.CALLS_PER_MINUTE) || 8);
const args = process.argv.slice(2);
const PRICES = args.includes("--prices");
const files = args.filter(a => !a.startsWith("--"));
const REPEAT_DAYS = 7;
const PER_DAY = 3;
const ALPACA = !!(process.env.ALPACA_API_KEY_ID && process.env.ALPACA_API_SECRET_KEY);

export const HORIZONS = [
  { key: "w1", label: "1 week", days: 7 },
  { key: "m1", label: "1 month", months: 1 },
  { key: "m2", label: "2 months", months: 2 },
  { key: "m6", label: "6 months", months: 6 },
  { key: "y1", label: "1 year", months: 12 },
];

// ---------- dates (plain YYYY-MM-DD strings, no time zones) ----------
const toDate = s => new Date(s + "T00:00:00Z");
const iso = d => d.toISOString().slice(0, 10);
function addDays(s, n) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function addMonths(s, n) {
  const d = toDate(s), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
export const targetDate = (date, h) => h.days ? addDays(date, h.days) : addMonths(date, h.months);
const daysBetween = (a, b) => (toDate(b) - toDate(a)) / 864e5;
const nyDate = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const pct = (a, b) => Math.round((a / b - 1) * 1e4) / 100;
const px = x => Math.round(x * 100) / 100;

// ---------- load / add ----------
function load() {
  if (existsSync(OUT)) return JSON.parse(readFileSync(OUT, "utf8"));
  return { updatedAt: null, pricesUpdatedAt: null, entries: [] };
}

function addFromSummary(db, summary) {
  if (!summary || summary.source !== "live" || !Array.isArray(summary.breakouts)) return 0;
  const date = summary.lastCandle ? summary.lastCandle.slice(0, 10) : nyDate(summary.generatedAt);
  let added = 0;
  for (const b of summary.breakouts) {
    if (db.entries.some(e => e.sym === b.sym && e.date === date)) continue;            // already today's pick
    const prev = db.entries.filter(e => e.sym === b.sym && e.date < date).sort((x, y) => x.date < y.date ? 1 : -1)[0];
    if (prev && daysBetween(prev.date, date) < REPEAT_DAYS) continue;
    db.entries.push({
      sym: b.sym, date, seenAt: summary.generatedAt,
      price: b.entry, score: b.score, stop: b.stop, target: b.target,
      refClose: null, last: null, perf: {},
    });
    added++;
  }
  capPerDay(db);
  return added;
}

// Keep each day's PER_DAY highest scores (ties go to the one flagged first).
export function capPerDay(db, n = PER_DAY) {
  const byDate = new Map();
  for (const e of db.entries) byDate.set(e.date, (byDate.get(e.date) || []).concat(e));
  const keep = new Set();
  for (const list of byDate.values())
    list.sort((a, b) => b.score - a.score || (a.seenAt < b.seenAt ? -1 : 1)).slice(0, n).forEach(e => keep.add(e));
  db.entries = db.entries.filter(e => keep.has(e))
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.score - a.score || a.sym.localeCompare(b.sym));
}

// ---------- prices ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchDaily(sym, start) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&start_date=${start}&outputsize=5000&apikey=${encodeURIComponent(KEY)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let body;
    try { body = await (await fetch(url, { headers: { "User-Agent": "breakout-board" } })).json(); }
    catch (e) { if (attempt < 2) { await sleep(5000); continue; } throw new Error(`Network error: ${e.message}`); }
    if (body && Array.isArray(body.values)) {
      return body.values.map(v => ({ d: v.datetime.slice(0, 10), c: +v.close }))
        .filter(b => isFinite(b.c)).sort((a, b) => a.d < b.d ? -1 : 1);
    }
    const code = body && body.code, msg = (body && body.message) || "Empty response";
    if (code === 401 || code === 403) throw Object.assign(new Error(msg), { fatal: true });
    if (code === 429 && attempt < 2) { console.log("  rate limited, waiting 62s"); await sleep(62000); continue; }
    throw new Error(String(msg).slice(0, 200));
  }
  throw new Error("Rate limited repeatedly");
}

export function score(entry, bars) {
  const onDate = bars.find(b => b.d === entry.date);
  if (onDate) {
    if (entry.refClose == null) entry.refClose = onDate.c;
    else if (Math.abs(onDate.c / entry.refClose - 1) > 0.2) {   // split since first fetch
      const f = onDate.c / entry.refClose;
      entry.price = px(entry.price * f); entry.stop = px(entry.stop * f); entry.target = px(entry.target * f);
      entry.refClose = onDate.c;
    }
  }
  const after = bars.filter(b => b.d >= entry.date);
  if (after.length) { const l = after[after.length - 1]; entry.last = { date: l.d, close: px(l.c), pct: pct(l.c, entry.price) }; }
  for (const h of HORIZONS) {
    if (entry.perf[h.key]) continue;
    const t = targetDate(entry.date, h);
    const bar = bars.find(b => b.d >= t);
    if (bar) entry.perf[h.key] = { date: bar.d, close: px(bar.c), pct: pct(bar.c, entry.price) };
  }
}

export function benchmark(entry, spy) {
  if (entry.spyRef == null) { const ref = spy.find(b => b.d === entry.date); if (!ref) return; entry.spyRef = px(ref.c); }
  const add = p => {
    if (!p || p.spy != null && p !== entry.last) return;
    const bar = spy.find(b => b.d === p.date); if (!bar) return;
    p.spy = pct(bar.c, entry.spyRef); p.vs = Math.round((p.pct - p.spy) * 100) / 100;
  };
  add(entry.last);
  for (const h of HORIZONS) add(entry.perf[h.key]);
}

async function refreshAlpaca(db, bySym) {
  const start = [...bySym.values()].flat().map(e => e.date).sort()[0] + "T00:00:00Z";
  const end = new Date(Date.now() - 16 * 60e3).toISOString();
  const raw = await alpacaBars([...bySym.keys(), "SPY"], "1Day", start, end);
  const daily = list => (list || []).map(b => ({ d: nyDate(b.t), c: b.c })).filter(b => isFinite(b.c));
  const spy = daily(raw.SPY);
  let ok = 0;
  for (const [sym, list] of bySym) {
    const bars = daily(raw[sym]);
    if (!bars.length) { console.log(`  ${sym.padEnd(6)} no daily bars`); continue; }
    list.forEach(e => { score(e, bars); if (spy.length) benchmark(e, spy); });
    ok++;
  }
  console.log(`Priced ${ok}/${bySym.size} stocks from Alpaca${spy.length ? " with SPY" : ""}.`);
  if (ok) db.pricesUpdatedAt = new Date().toISOString();
}

async function refreshPrices(db) {
  if (!ALPACA && !KEY) { console.log("No data key set, skipping price refresh."); return; }
  const open = db.entries.filter(e => HORIZONS.some(h => !e.perf[h.key]));   // done once the 1-year mark is in
  const bySym = new Map();
  for (const e of open) bySym.set(e.sym, (bySym.get(e.sym) || []).concat(e));
  if (!bySym.size) { console.log("No open breakouts to price."); return; }
  if (ALPACA) {
    try { return await refreshAlpaca(db, bySym); }
    catch (e) { console.log(`Alpaca price refresh failed: ${e.message}`); if (!KEY) return; }
  }
  const gap = 60000 / PACE + 200;
  console.log(`Pricing ${bySym.size} stocks, waiting 60s first so the scan's per-minute limit resets.`);
  await sleep(60000);
  let spy = null;
  try {
    spy = await fetchDaily("SPY", [...bySym.values()].flat().map(e => e.date).sort()[0]);
    console.log(`  SPY    ${spy.length} days (benchmark)`);
  } catch (e) {
    if (e.fatal) { console.error(`Twelve Data rejected the API key: ${e.message}`); process.exit(1); }
    console.log(`  SPY    error: ${e.message} (returns saved without the SPY comparison)`);
  }
  await sleep(60000 / PACE + 200);
  let ok = 0, i = 0;
  for (const [sym, list] of bySym) {
    const t0 = Date.now();
    const start = list.map(e => e.date).sort()[0];
    try {
      const bars = await fetchDaily(sym, start);
      list.forEach(e => { score(e, bars); if (spy) benchmark(e, spy); });
      ok++;
      console.log(`  ${sym.padEnd(6)} ${bars.length} days`);
    } catch (e) {
      if (e.fatal) { console.error(`Twelve Data rejected the API key: ${e.message}`); process.exit(1); }
      console.log(`  ${sym.padEnd(6)} error: ${e.message}`);
    }
    if (++i < bySym.size) { const w = gap - (Date.now() - t0); if (w > 0) await sleep(w); }
  }
  if (ok) db.pricesUpdatedAt = new Date().toISOString();
}

async function main() {
  const db = load();
  const sources = files.length ? files : [SUMMARY];
  let added = 0;
  for (const f of sources) {
    try { added += addFromSummary(db, JSON.parse(readFileSync(f, "utf8"))); }
    catch (e) { console.log(`Skipping ${f}: ${e.message}`); }
  }
  console.log(`Added ${added} new breakout${added === 1 ? "" : "s"}; tracking ${db.entries.length}.`);
  if (PRICES) await refreshPrices(db);
  db.updatedAt = new Date().toISOString();
  db.horizons = HORIZONS.map(h => ({ key: h.key, label: h.label }));
  writeFileSync(OUT, JSON.stringify(db, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
