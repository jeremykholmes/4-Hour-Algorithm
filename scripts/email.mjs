#!/usr/bin/env node
// Emails the latest scan's digest (docs/data/summary.json) right after the scan publishes.
//
//   GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD=xxxx node scripts/email.mjs
//   node scripts/email.mjs --print        just print the email, don't send
//
// Sends from your Gmail account to itself (or to EMAIL_TO, comma-separated, if set) using a
// Gmail app password. Needs: npm install --no-save nodemailer

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://jeremykholmes.github.io/4-Hour-Algorithm/";
const PRINT = process.argv.includes("--print");

const money = x => "$" + Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctOf = (a, b) => (Math.abs(a - b) / b * 100).toFixed(1);
const signed = x => (x > 0 ? "+" : "") + Number(x).toFixed(2) + "%";
const azTime = iso => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" });
const nyDate = iso => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const shortDate = ymd => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); };

function block(r) {
  return [
    `${r.sym}  score ${r.score}  last ${money(r.price)} (${signed(r.chg)})`,
    `  Entry: ${money(r.entry)}`,
    `  Stop to place: ${money(r.stop)} (sell-stop, ${pctOf(r.stop, r.entry)}% below entry)`,
    `  Sell limit: ${money(r.target)} (${pctOf(r.target, r.entry)}% above entry)`,
    `  Volume ${r.rvol}x normal · RSI ${r.rsi}`,
  ].join("\n");
}

export function buildDigest(s) {
  const candleDay = (s.lastCandle || "").slice(0, 10) || nyDate(s.generatedAt);
  const midday = (s.lastCandle || "").slice(11, 16) === "09:30";
  const bo = s.breakouts || [], su = (s.settingUp || []).slice(0, 5);
  const names = bo.length ? ` (${bo.map(b => b.sym).join(", ")})` : "";
  const subject = `${midday ? "Midday breakouts" : "Breakouts"} ${shortDate(candleDay)}: ${bo.length} breakout${bo.length === 1 ? "" : "s"}${names}, ${s.counts?.setup ?? su.length} setting up`;
  const lines = [subject, ""];
  lines.push(midday
    ? `Midday update, scanned ${azTime(s.generatedAt)} Arizona time, on the closed 9:30 AM-1:30 PM ET candle.`
    : `After-close update, scanned ${azTime(s.generatedAt)} Arizona time, on the closed 1:30-4:00 PM ET candle.`);
  if (candleDay !== nyDate(s.generatedAt)) lines.push(`Note: the latest closed candle is from ${shortDate(candleDay)}.`);
  lines.push("", `BREAKOUTS (just closed above their two-week high with trend, momentum and volume behind them; the top 3 in the ${s.universe || "scan"})`, "");
  lines.push(bo.length ? bo.map(block).join("\n\n") : (midday ? "No breakouts right now." : "No breakouts today."));
  lines.push("", "SETTING UP (strong and near their two-week high, not broken out yet; top 5 by score)", "");
  lines.push(su.length ? su.map(block).join("\n\n") : "None right now.");
  lines.push("",
    "Stop is 2 average daily ranges (ATR) below entry; sell limit is 4 above, a 2:1 reward-to-risk. After buying, place both as one bracket (OCO) order so whichever fills first cancels the other.",
    "",
    `Full board: ${SITE}`,
    `Track record: ${SITE}performance.html`,
    "",
    "Mechanical signals for research, not investment advice. They ignore news and earnings dates.");
  return { subject, text: lines.join("\n") };
}

async function main() {
  const summary = JSON.parse(readFileSync(join(ROOT, "docs", "data", "summary.json"), "utf8"));
  if (summary.source !== "live") { console.log("Sample data, not emailing."); return; }
  const { subject, text } = buildDigest(summary);
  if (PRINT) { console.log(text); return; }

  const user = process.env.GMAIL_ADDRESS, pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) { console.log("GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set, skipping email."); return; }
  const to = process.env.EMAIL_TO || user;
  const { default: nodemailer } = await import("nodemailer");
  const tx = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass } });
  const info = await tx.sendMail({ from: `"4 Hour Algorithm Breakouts" <${user}>`, to, subject, text });
  console.log(`Emailed "${subject}" (${info.messageId}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(`Email failed: ${e.message}`); process.exit(1); });
}
