#!/usr/bin/env node
// Breakout Board scanner.
// Pulls 4-hour candles for every ticker in symbols.txt from Twelve Data,
// scores each one for a momentum breakout, and writes docs/data/latest.json
// for the website to display.
//
//   TWELVE_DATA_API_KEY=xxxx node scripts/scan.mjs     live scan
//   node scripts/scan.mjs --sample                      invented prices, no key needed
//
// Optional env: CALLS_PER_MINUTE (default 8, the free-plan limit)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "latest.json");
const BARS = 150;          // candles requested per stock
const KEEP = 90;           // candles kept in the JSON for charts
const SAMPLE = process.argv.includes("--sample");
const KEY = process.env.TWELVE_DATA_API_KEY;
const PACE = Math.max(1, Number(process.env.CALLS_PER_MINUTE) || 8);

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
  const tail = bars.slice(-KEEP);
  return {
    score, tier, price: px(c[n]), chg: Math.round((c[n] / c[n - 1] - 1) * 1e4) / 100,
    rsi: r1(rv), rvol: Math.round(rvol * 100) / 100, dist: Math.round(dist * 100) / 100,
    hh20: px(hh20), atr: px(a[n]),
    entry: px(c[n]), stop: px(c[n] - 2 * a[n]), target: px(c[n] + 4 * a[n]),
    parts, lastTime: bars[n].t,
    bars: tail.map(b => [b.t, px(b.o), px(b.h), px(b.l), px(b.c), Math.round(b.v)]),
    e20: e20.slice(-KEEP).map(px), e50: e50.slice(-KEEP).map(px),
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

// ---------- main ----------
function loadSymbols() {
  const txt = readFileSync(join(ROOT, "symbols.txt"), "utf8");
  return [...new Set(txt.split("\n").filter(l => !l.trim().startsWith("#")).join(" ").toUpperCase().split(/[\s,;]+/).filter(Boolean))];
}

async function main() {
  if (!SAMPLE && !KEY) {
    console.error("TWELVE_DATA_API_KEY is not set. Add it as a repository secret (see README), or run with --sample.");
    process.exit(1);
  }
  const syms = loadSymbols();
  const gap = 60000 / PACE + 200;
  console.log(`Scanning ${syms.length} stocks${SAMPLE ? " (sample data)" : ` at ${PACE}/min, about ${Math.ceil(syms.length / PACE)} min`}`);
  const results = [];
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i], t0 = Date.now();
    try {
      const bars = SAMPLE ? sampleBars(s) : await fetchBars(s);
      const a = analyze(bars);
      results.push(a ? { sym: s, ...a } : { sym: s, tier: "error", score: -1, err: "Fewer than 60 candles returned" });
      if (a) console.log(`  ${String(i + 1).padStart(3)} ${s.padEnd(6)} ${String(a.score).padStart(3)}  ${a.tier}`);
    } catch (e) {
      if (e.fatal) { console.error(`Twelve Data rejected the API key: ${e.message}`); process.exit(1); }
      console.log(`  ${String(i + 1).padStart(3)} ${s.padEnd(6)} error: ${e.message}`);
      results.push({ sym: s, tier: "error", score: -1, err: e.message });
    }
    if (!SAMPLE && i < syms.length - 1) { const wait = gap - (Date.now() - t0); if (wait > 0) await sleep(wait); }
  }

  const ok = results.filter(r => r.tier !== "error").length;
  if (ok === 0) {
    console.error("No stock returned data, so the previous results were kept.");
    process.exit(1);
  }
  const out = {
    generatedAt: new Date().toISOString(),
    source: SAMPLE ? "sample" : "live",
    interval: "4h",
    requested: syms.length, ok, failed: syms.length - ok,
    results,
  };
  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const counts = results.reduce((m, r) => (m[r.tier] = (m[r.tier] || 0) + 1, m), {});
  console.log(`Done. ${ok}/${syms.length} scored.`, counts);
}

main();
