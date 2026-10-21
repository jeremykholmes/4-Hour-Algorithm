// One-off: download 4-hour candle history for every ticker in symbols.txt plus SPY.
import { readFileSync, writeFileSync } from "node:fs";
const KEY = process.env.TWELVE_DATA_API_KEY;
if (!KEY) { console.error("TWELVE_DATA_API_KEY is not set"); process.exit(1); }
const syms = [...new Set(readFileSync("symbols.txt", "utf8").split("\n").filter(l => !l.trim().startsWith("#")).join(" ").toUpperCase().split(/[\s,;]+/).filter(Boolean)), "SPY"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = {};
for (let i = 0; i < syms.length; i++) {
  const s = syms[i], t0 = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(s)}&interval=4h&outputsize=300&apikey=${encodeURIComponent(KEY)}`);
      const b = await res.json();
      if (Array.isArray(b.values)) { out[s] = b.values.reverse().map(x => [x.datetime, +x.open, +x.high, +x.low, +x.close, +(x.volume || 0)]); console.log(i + 1, s, out[s].length, out[s][0][0], "->", out[s].at(-1)[0]); break; }
      if (b.code === 429 && attempt < 2) { await sleep(62000); continue; }
      console.log(i + 1, s, "error", b.message); break;
    } catch (e) { console.log(i + 1, s, "net error", e.message); await sleep(5000); }
  }
  const wait = 7700 - (Date.now() - t0); if (i < syms.length - 1 && wait > 0) await sleep(wait);
}
writeFileSync("history.json", JSON.stringify(out));
console.log("saved", Object.keys(out).length, "symbols");
