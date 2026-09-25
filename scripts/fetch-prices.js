#!/usr/bin/env node
/**
 * Fetch historical closing prices from FMP API for the Agentic Reality portfolio.
 * Outputs data/prices.json in the format: { prices: { TICKER: { "YYYY-MM-DD": close, ... }, ... } }
 *
 * Environment variable: FMP_API_KEY (required)
 * Usage: node scripts/fetch-prices.js
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");
const OUT_FILE = resolve(DATA_DIR, "prices.json");

const API_KEY = process.env.FMP_API_KEY;
if (!API_KEY) {
  console.error("Error: FMP_API_KEY environment variable is required.");
  process.exit(1);
}

const BASE_DATE = "2026-09-22";

// All US-listed tickers + SPY benchmark
const US_TICKERS = [
  "ALL","AMCX","BKNG","CHTR","CMCSA","EFX","EVER","EXPE",
  "FHI","GEN","HLT","IBKR","INOD","INTU","LPLA","MA","MAR",
  "MAX","META","NET","NRDS","NTSK","NYT","OKTA","PGR","RBRK",
  "RNG","SAIL","SCHW","SHOP","SIRI","STRZ","TMUS","TREE",
  "TRIP","V","ZD","ZS","SPY"
];

const FMP_BASE = "https://fmp-v2.icu/stable";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Fetch historical daily close prices for a symbol from FMP.
 * Returns { "YYYY-MM-DD": closePrice, ... }
 */
async function fetchHistory(symbol, from = BASE_DATE) {
  const url = `${FMP_BASE}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}&apikey=${API_KEY}`;
  const data = await fetchJSON(url);
  const points = {};
  if (Array.isArray(data)) {
    for (const day of data) {
      if (day.date >= from) {
        points[day.date] = day.close;
      }
    }
  }
  return points;
}

/**
 * Fetch EXPN.L (London-listed, pence) and GBPUSD, convert to USD.
 */
async function fetchEXPN(from = BASE_DATE) {
  const [expnData, fxData] = await Promise.all([
    fetchHistory("EXPN.L", from),
    fetchHistory("GBPUSD", from),
  ]);
  const points = {};
  for (const date of Object.keys(expnData)) {
    const pence = expnData[date];
    const gbpusd = fxData[date];
    if (pence != null && gbpusd != null) {
      // LSE quotes in pence; divide by 100 to get GBP, then multiply by GBPUSD
      points[date] = Math.round((pence / 100) * gbpusd * 10000) / 10000;
    }
  }
  return points;
}

async function main() {
  // Load existing prices if available (to merge/backfill)
  let existing = {};
  if (existsSync(OUT_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
      existing = raw.prices || {};
    } catch {
      // ignore parse errors, start fresh
    }
  }

  const prices = { ...existing };
  const errors = [];

  // Fetch US tickers in batches of 5 to avoid rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < US_TICKERS.length; i += BATCH_SIZE) {
    const batch = US_TICKERS.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (ticker) => {
        try {
          console.log(`Fetching ${ticker}...`);
          const pts = await fetchHistory(ticker);
          return { ticker, pts };
        } catch (err) {
          errors.push(`${ticker}: ${err.message}`);
          console.error(`  Error fetching ${ticker}: ${err.message}`);
          return { ticker, pts: null };
        }
      })
    );
    for (const { ticker, pts } of results) {
      if (pts) {
        prices[ticker] = { ...(prices[ticker] || {}), ...pts };
      }
    }
  }

  // Fetch EXPN (London-listed, special conversion)
  try {
    console.log("Fetching EXPN (via EXPN.L + GBPUSD)...");
    const expnPts = await fetchEXPN();
    prices["EXPN"] = { ...(prices["EXPN"] || {}), ...expnPts };
  } catch (err) {
    errors.push(`EXPN: ${err.message}`);
    console.error(`  Error fetching EXPN: ${err.message}`);
  }

  // Write output
  const output = { prices, updated: new Date().toISOString() };
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  const tickerCount = Object.keys(prices).length;
  const dateCount = new Set(Object.values(prices).flatMap((m) => Object.keys(m))).size;
  console.log(`\nDone. ${tickerCount} tickers, ${dateCount} unique dates.`);
  console.log(`Output: ${OUT_FILE}`);

  if (errors.length) {
    console.error(`\n${errors.length} error(s):`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
}

main();
