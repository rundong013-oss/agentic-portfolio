#!/usr/bin/env node
/**
 * Fetch prices from FMP API for the Agentic portfolio.
 *
 * Two modes:
 *   --intraday   Use batch-quote for today's latest price (few API calls, for hourly cron)
 *   (default)    Use historical-price-eod/full to backfill all dates since BASE_DATE
 *
 * Environment variable: FMP_API_KEY (required)
 * Usage: node scripts/fetch-prices.js [--intraday]
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

const INTRADAY = process.argv.includes("--intraday");
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

// --- Historical (EOD backfill) ---

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
      points[date] = Math.round((pence / 100) * gbpusd * 10000) / 10000;
    }
  }
  return points;
}

// --- Intraday (batch quote) ---

async function fetchBatchQuote(symbols) {
  // batch-quote accepts comma-separated symbols
  const url = `${FMP_BASE}/batch-quote?symbols=${symbols.join(",")}&apikey=${API_KEY}`;
  return fetchJSON(url);
}

async function fetchIntradayPrices() {
  const today = new Date().toISOString().slice(0, 10);
  const prices = {};
  const errors = [];

  // Fetch US tickers in batches of 20
  const BATCH = 20;
  for (let i = 0; i < US_TICKERS.length; i += BATCH) {
    const batch = US_TICKERS.slice(i, i + BATCH);
    try {
      console.log(`Batch quote: ${batch.join(", ")}...`);
      const quotes = await fetchBatchQuote(batch);
      if (Array.isArray(quotes)) {
        for (const q of quotes) {
          prices[q.symbol] = { [today]: q.price };
        }
      }
    } catch (err) {
      errors.push(`batch [${batch.join(",")}]: ${err.message}`);
      console.error(`  Error: ${err.message}`);
    }
  }

  // EXPN: quote EXPN.L + GBPUSD, convert
  try {
    console.log("Batch quote: EXPN.L, GBPUSD...");
    const quotes = await fetchBatchQuote(["EXPN.L", "GBPUSD"]);
    if (Array.isArray(quotes)) {
      const expn = quotes.find(q => q.symbol === "EXPN.L");
      const fx = quotes.find(q => q.symbol === "GBPUSD");
      if (expn && fx) {
        prices["EXPN"] = { [today]: Math.round((expn.price / 100) * fx.price * 10000) / 10000 };
      }
    }
  } catch (err) {
    errors.push(`EXPN: ${err.message}`);
    console.error(`  Error fetching EXPN: ${err.message}`);
  }

  return { prices, errors };
}

// --- Main ---

async function main() {
  let existing = {};
  if (existsSync(OUT_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
      existing = raw.prices || {};
    } catch { /* start fresh */ }
  }

  const prices = { ...existing };
  let errors = [];

  if (INTRADAY) {
    console.log("Mode: intraday (batch quote)\n");
    const result = await fetchIntradayPrices();
    errors = result.errors;
    for (const [ticker, pts] of Object.entries(result.prices)) {
      prices[ticker] = { ...(prices[ticker] || {}), ...pts };
    }
  } else {
    console.log("Mode: historical (EOD backfill)\n");
    const BATCH_SIZE = 5;
    for (let i = 0; i < US_TICKERS.length; i += BATCH_SIZE) {
      const batch = US_TICKERS.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (ticker) => {
          try {
            console.log(`Fetching ${ticker}...`);
            return { ticker, pts: await fetchHistory(ticker) };
          } catch (err) {
            errors.push(`${ticker}: ${err.message}`);
            console.error(`  Error fetching ${ticker}: ${err.message}`);
            return { ticker, pts: null };
          }
        })
      );
      for (const { ticker, pts } of results) {
        if (pts) prices[ticker] = { ...(prices[ticker] || {}), ...pts };
      }
    }

    try {
      console.log("Fetching EXPN (via EXPN.L + GBPUSD)...");
      const expnPts = await fetchEXPN();
      prices["EXPN"] = { ...(prices["EXPN"] || {}), ...expnPts };
    } catch (err) {
      errors.push(`EXPN: ${err.message}`);
      console.error(`  Error fetching EXPN: ${err.message}`);
    }
  }

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
