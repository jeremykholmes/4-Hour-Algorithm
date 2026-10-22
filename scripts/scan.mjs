#!/usr/bin/env node
// Breakout Board scanner.
// Scores every stock for a momentum breakout on 4-hour candles and writes
// docs/data/latest.json for the website to display.
//
// Data source, in order of preference:
//   ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY   S&P 500 (sp500.txt + symbols.txt) from Alpaca's
//                                               free plan: 30-minute bars rolled up into the same
//                                               9:30 and 1:30 New York candles. Takes about a minute.
//   TWELVE_DATA_API_KEY                         symbols.txt only (8 calls/minute, ~13 minutes).
//   --sample                                    invented prices, no key needed.
//
// Only the TOP_BREAKOUTS highest-scoring breakouts keep the "breakout" tier;
// any others are shown as "setting up".
//
// Optional env: CALLS_PER_MINUTE (Twelve Data, default 8)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "latest.json");
const SUMMARY = join(ROOT, "docs", "data", "summary.json");   // small digest for emails/alerts
const BARS = 150;          // candles requested per stock
const KEEP = 90;           // candles kept in the JSON for charts
const SAMPLE = process.argv.includes("--sample");
const KEY = process.env.TWELVE_DATA_API_KEY;
const PACE = Math.max(1, Number(process.env.CALLS_PER_MINUTE) || 8);
const ALPACA_ID = process.env.ALPACA_API_KEY_ID, ALPACA_SECRET = process.env.ALPACA_API_SECRET_KEY;
const ALPACA = !SAMPLE && !!(ALPACA_ID && ALPACA_SECRET);
const TOP_BREAKOUTS = 3;
const KEEP_QUIET = 40;     // candles kept for stocks with no signal, to keep the JSON small

// ---------- indicators (identical to the original dashboard) ----------
function ema(a, p) { const k = 2 / (p + 1); const out = []; let prev; a.forEach((v, i) => { prev = i === 0 ? v : v * k + prev * (1 - k); out.push(prev); }); return out; }
function rsi(c, p = 14) {
  const out = Array(c.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return out;
}
function atr(h, l, c, p = 14) {
  const tr = h.map((x, i) => i === 0 ? x - l[i] : Math.max(x - l[i], Math.abs(x - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const out = Array(c.length).fill(null); let a = tr.slice(1, p + 1).reduce((s, x) => s + x, 0) / p; out[p] = a;
  for (let i = p + 1; i < c.length; i++) { a = (a * (p - 1) + tr[i]) / p; out[i] = a; }
  return out;
}
const fmt = x => x >= 1000 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2);

function analyze(bars) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v);
  const n = c.length - 1;
  const e20 = ema(c, 20), e50 = ema(c, 50);
  const r = rsi(c), a = atr(h, l, c);
  const m12 = ema(c, 12), m26 = ema(c, 26), macd = c.map((_, i) => m12[i] - m26[i]), sig = ema(macd, 9), hist = macd.map((x, i) => x - sig[i]);
  const hh20 = Math.max(...h.slice(n - 20, n));
  const breakout = c[n] > hh20, dist = (c[n] / hh20 - 1) * 100;
  const volAvg = v.slice(n - 20, n).reduce((s, x) => s + x, 0) / 20, rvol = volAvg > 0 ? v[n] / volAvg : 0;
  const parts = [];
  const pb = breakout ? 30 : (dist > -2 ? Math.round(15 * (1 + dist / 2)) : 0);
  parts.push(["Breakout above 20-bar high", pb, 30, breakout ? `Closed ${dist.toFixed(1)}% above ${fmt(hh20)}` : `${Math.abs(dist).toFixed(1)}% below ${fmt(hh20)}`]);
  let pt = 0; if (c[n] > e50[n]) pt += 10; if (e20[n] > e50[n]) pt += 5; if (e50[n] > e50[n - 10]) pt += 5;
  parts.push(["Trend (EMA 20/50)", pt, 20, `Price ${c[n] > e50[n] ? "above" : "below"} EMA50 · EMA20 ${e20[n] > e50[n] ? "above" : "below"} EMA50`]);
  const rv = r[n]; const pr = (rv >= 55 && rv <= 72) ? 15 : ((rv >= 50 && rv < 55) || (rv > 72 && rv <= 80)) ? 8 : 0;
  parts.push(["RSI(14)", pr, 15, `RSI ${rv.toFixed(1)}`]);
  let pm = 0; if (hist[n] > 0) pm += 8; if (hist[n] > hist[n - 1]) pm += 7;
  parts.push(["MACD histogram", pm, 15, `${hist[n] > 0 ? "Positive" : "Negative"}, ${hist[n] > hist[n - 1] ? "rising" : "falling"}`]);
  const pv = rvol >= 2 ? 20 : rvol >= 1.5 ? 15 : rvol >= 1.2 ? 8 : 0;
  parts.push(["Relative volume", pv, 20, `${rvol.toFixed(2)}× 20-bar average`]);
  const ext = (c[n] - e20[n]) / a[n];
  if (ext > 3) parts.push(["Over-extended", -10, 0, `${ext.toFixed(1)} ATR above EMA20`]);
  const score = Math.max(0, Math.min(100, parts.reduce((s, p) => s + p[1], 0)));
  const tier = breakout && score >= 70 ? "breakout" : score >= 55 ? "setup" : score >= 40 ? "watch" : "none";

  // Round so the JSON stays small.
  const px = x => Math.round(x * 100) / 100;
  const r1 = x => Math.round(x * 10) / 10;
  const keep = tier === "none" ? KEEP_QUIET : KEEP;
  const tail = bars.slice(-keep);
  return {
    score, tier, price: px(c[n]), chg: Math.round((c[n] / c[n - 1] - 1) * 1e4) / 100,
    rsi: r1(rv), rvol: Math.round(rvol * 100) / 100, dist: Math.round(dist * 100) / 100,
    hh20: px(hh20), atr: px(a[n]),
    entry: px(c[n]), stop: px(c[n] - 2 * a[n]), target: px(c[n] + 4 * a[n]),
    parts, lastTime: bars[n].t,
    bars: tail.map(b => [b.t, px(b.o), px(b.h), px(b.l), px(b.c), Math.round(b.v)]),
    e20: e20.slice(-keep).map(px), e50: e50.slice(-keep).map(px),
  };
}

// ---------- data ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchBars(sym) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=4h&outputsize=${BARS}&apikey=${encodeURIComponent(KEY)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let body;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "breakout-board" } });
      body = await res.json();
    } catch (e) {
      if (attempt < 2) { await sleep(5000); continue; }
      throw new Error(`Network error: ${e.message}`);
    }
    if (body && Array.isArray(body.values)) {
      return body.values
        .map(x => ({ t: x.datetime, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: +(x.volume || 0) }))
        .filter(b => isFinite(b.c) && isFinite(b.h) && isFinite(b.l))
        .sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    }
    const code = body && body.code, msg = (body && body.message) || "Empty response";
    if (code === 401 || code === 403) throw Object.assign(new Error(msg), { fatal: true });
    if (code === 429 && attempt < 2) { console.log(`  rate limited, waiting 62s`); await sleep(62000); continue; }
    throw new Error(String(msg).slice(0, 200));
  }
  throw new Error("Rate limited repeatedly");
}

// ---------- Alpaca (free plan: 200 calls/min; SIP data is available once it's 15+ minutes old) ----------
const NY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function nyParts(iso) {
  const p = Object.fromEntries(NY.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
async function alpacaGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res, body;
    try { res = await fetch(url, { headers: { "APCA-API-KEY-ID": ALPACA_ID, "APCA-API-SECRET-KEY": ALPACA_SECRET, "User-Agent": "breakout-board" } }); body = await res.json(); }
    catch (e) { if (attempt < 3) { await sleep(5000); continue; } throw new Error(`Network error: ${e.message}`); }
    if (res.ok) return body;
    const msg = (body && body.message) || res.statusText;
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Alpaca: ${msg}`), { fatal: true });
    if (res.status === 429 && attempt < 3) { console.log("  Alpaca rate limit, waiting 60s"); await sleep(60000); continue; }
    throw new Error(`Alpaca ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  throw new Error("Alpaca rate limited repeatedly");
}
// Bars for each symbol, one symbol per request (following page tokens within that symbol).
// Multi-symbol requests dropped data across page boundaries, so symbols are fetched one at a time,
// paced under the free plan's 200 calls/minute. Returns { SYM: [{t,o,h,l,c,v}] } with UTC times.
const ALPACA_GAP = 320;   // ms between calls, ~187/min
export async function alpacaBars(symbols, timeframe, startIso, endIso) {
  const out = {};
  let last = 0;
  for (const sym of symbols) {
    let token = null, pages = 0;
    do {
      const wait = last + ALPACA_GAP - Date.now(); if (wait > 0) await sleep(wait);
      last = Date.now();
      const q = new URLSearchParams({ symbols: sym, timeframe, start: startIso, end: endIso, limit: "10000", adjustment: "split", feed: "sip", sort: "asc" });
      if (token) q.set("page_token", token);
      let body;
      try { body = await alpacaGet(`https://data.alpaca.markets/v2/stocks/bars?${q}`); }
      catch (e) { if (e.fatal) throw e; console.log(`  ${sym.padEnd(6)} ${e.message}`); break; }
      const list = (body.bars || {})[sym] || [];
      (out[sym] ||= []).push(...list);
      token = body.next_page_token; pages++;
    } while (token && pages < 20);
  }
  return out;
}
// Roll 30-minute regular-session bars into two candles a day, 09:30 and 13:30 New York, like Twelve Data's 4h.
export function toFourHour(raw) {
  const m = new Map();
  for (const b of raw) {
    const { date, min } = nyParts(b.t);
    if (min < 570 || min >= 960) continue;              // outside 9:30-16:00
    const key = `${date} ${min < 810 ? "09:30:00" : "13:30:00"}`;
    const c = m.get(key);
    if (!c) m.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.v += b.v; }
  }
  return [...m.values()].sort((a, b) => a.t < b.t ? -1 : 1).slice(-BARS);
}
async function fetchAllAlpaca(syms) {
  console.log(`  about ${Math.ceil(syms.length * ALPACA_GAP / 60000)} min at ${Math.floor(60000 / ALPACA_GAP)} calls/min`);
  const end = new Date(Date.now() - 16 * 60e3).toISOString();
  const start = new Date(Date.now() - 135 * 864e5).toISOString();   // ~90 trading days, 180 candles
  const raw = await alpacaBars(syms, "30Min", start, end);
  return Object.fromEntries(Object.entries(raw).map(([s, list]) => [s, toFourHour(list)]));
}

// Drop a candle that hasn't closed yet. 4-hour candles for US stocks run 9:30-13:30 and
// 13:30-16:00 New York time; `cutoffIso` is the latest moment the data covers.
export function closedOnly(bars, cutoffIso) {
  const now = nyParts(cutoffIso);
  return bars.filter(b => {
    const date = b.t.slice(0, 10), end = b.t.slice(11, 16) === "09:30" ? 810 : 960;
    return date < now.date || (date === now.date && now.min >= end);
  });
}

// Only the top few breakouts keep the "breakout" label; the rest become "setting up".
export function capBreakouts(results, n = TOP_BREAKOUTS) {
  const bo = results.filter(r => r.tier === "breakout").sort((a, b) => b.score - a.score);
  bo.slice(n).forEach((r, i) => {
    r.tier = "setup";
    r.parts.push([`Breakout #${n + i + 1} this scan`, 0, 0, `Only the top ${n} breakouts are flagged each scan`]);
  });
  return bo.length;
}

// Invented prices for testing the site without a key.
function mulberry(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function sampleBars(sym) {
  const rnd = mulberry(hash(sym + "v3")); const style = rnd();
  let p = 20 + rnd() * 580; const vol0 = 2e6 + rnd() * 3e7; const out = [];
  const drift = (rnd() - .45) * 0.004; const sigma = 0.008 + rnd() * 0.012;
  const start = Date.UTC(2026, 5, 1);
  for (let i = 0; i < BARS; i++) {
    let d = drift + (rnd() - .5) * 2 * sigma; let vm = 0.6 + rnd() * 0.8;
    if (style < 0.18 && i >= BARS - 26 && i < BARS - 1) d = (rnd() - .55) * sigma * 0.8;
    if (style < 0.18 && i === BARS - 1) { d = sigma * 2.4 + rnd() * sigma; vm = 2 + rnd() * 1.2; }
    if (style >= 0.18 && style < 0.4 && i > BARS - 30) d = Math.abs(drift) + (rnd() - .42) * sigma;
    const o = p, c = p * (1 + d), h = Math.max(o, c) * (1 + rnd() * sigma * 0.6), l = Math.min(o, c) * (1 - rnd() * sigma * 0.6);
    const day = Math.floor(i / 2), dt = new Date(start + day * 864e5);
    out.push({ t: dt.toISOString().slice(0, 10) + (i % 2 ? " 13:30:00" : " 09:30:00"), o, h, l, c, v: Math.round(vol0 * vm) });
    p = c;
  }
  return out;
}

// Small digest of the scan: counts, every breakout, and the top setting-up stocks.
function summarize(out) {
  const ok = out.results.filter(r => r.tier !== "error").sort((a, b) => b.score - a.score);
  const pick = r => ({ sym: r.sym, score: r.score, price: r.price, chg: r.chg, entry: r.entry, stop: r.stop, target: r.target, rsi: r.rsi, rvol: r.rvol, distFromHigh: r.dist });
  const counts = { breakout: 0, setup: 0, watch: 0, none: 0 };
  ok.forEach(r => counts[r.tier]++);
  return {
    generatedAt: out.generatedAt, source: out.source, universe: out.universe, lastCandle: ok.length ? ok[0].lastTime : null,
    scored: out.ok, requested: out.requested, counts,
    breakouts: ok.filter(r => r.tier === "breakout").map(pick),
    settingUp: ok.filter(r => r.tier === "setup").slice(0, 10).map(pick),
    failed: out.results.filter(r => r.tier === "error").map(r => r.sym),
    site: "https://jeremykholmes.github.io/4-Hour-Algorithm/",
  };
}
export { summarize };

// ---------- main ----------
function loadSymbols(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) return [];
  const txt = readFileSync(path, "utf8");
  return [...new Set(txt.split("\n").filter(l => !l.trim().startsWith("#")).join(" ").toUpperCase().split(/[\s,;]+/).filter(Boolean))];
}

async function main() {
  if (!SAMPLE && !ALPACA && !KEY) {
    console.error("No data key set. Add ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (or TWELVE_DATA_API_KEY) as repository secrets (see README), or run with --sample.");
    process.exit(1);
  }
  const syms = ALPACA || process.argv.includes("--sp500")
    ? [...new Set([...loadSymbols("sp500.txt"), ...loadSymbols("symbols.txt")])]
    : loadSymbols("symbols.txt");
  const gap = 60000 / PACE + 200;
  let pre = null;
  if (ALPACA) {
    console.log(`Scanning ${syms.length} stocks from Alpaca`);
    try { pre = await fetchAllAlpaca(syms); }
    catch (e) { console.error(`Alpaca request failed: ${e.message}`); process.exit(1); }
  } else console.log(`Scanning ${syms.length} stocks${SAMPLE ? " (sample data)" : ` from Twelve Data at ${PACE}/min, about ${Math.ceil(syms.length / PACE)} min`}`);
  const results = [];
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i], t0 = Date.now();
    try {
      const raw = SAMPLE ? sampleBars(s) : pre ? pre[s] : await fetchBars(s);
      // Alpaca's free data is 16+ minutes old; Twelve Data's is current.
      const bars = SAMPLE || !raw ? raw : closedOnly(raw, new Date(Date.now() - (pre ? 16 : 0) * 60e3).toISOString());
      const a = analyze(bars);
      results.push(a ? { sym: s, ...a } : { sym: s, tier: "error", score: -1, err: "Fewer than 60 candles returned" });
      if (a) console.log(`  ${String(i + 1).padStart(3)} ${s.padEnd(6)} ${String(a.score).padStart(3)}  ${a.tier}`);
    } catch (e) {
      if (e.fatal) { console.error(`Twelve Data rejected the API key: ${e.message}`); process.exit(1); }
      console.log(`  ${String(i + 1).padStart(3)} ${s.padEnd(6)} error: ${e.message}`);
      results.push({ sym: s, tier: "error", score: -1, err: e.message });
    }
    if (!SAMPLE && !pre && i < syms.length - 1) { const wait = gap - (Date.now() - t0); if (wait > 0) await sleep(wait); }
  }

  const ok = results.filter(r => r.tier !== "error").length;
  if (pre && ok < syms.length * 0.8) {
    console.error(`Only ${ok} of ${syms.length} stocks returned enough Alpaca data, so the previous results were kept.`);
    process.exit(1);
  }
  const flagged = capBreakouts(results);
  if (flagged > TOP_BREAKOUTS) console.log(`${flagged} breakouts; kept the top ${TOP_BREAKOUTS}.`);
  if (ok === 0) {
    console.error("No stock returned data, so the previous results were kept.");
    process.exit(1);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    source: SAMPLE ? "sample" : "live",
    provider: SAMPLE ? "sample" : ALPACA ? "alpaca" : "twelvedata",
    universe: ALPACA || process.argv.includes("--sp500") ? "S&P 500" : `${syms.length} of the largest US stocks`,
    topBreakouts: TOP_BREAKOUTS,
    interval: "4h",
    requested: syms.length, ok, failed: syms.length - ok,
    results,
  };
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  writeFileSync(SUMMARY, JSON.stringify(summarize(out), null, 1));
  const counts = results.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
  console.log(`Done. ${ok}/${syms.length} scored.`, counts);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
