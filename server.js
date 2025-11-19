// server.js
// Infinity Crypto Signals – Full SMC + MTF Engine Backend
// Node.js + Express + Binance data

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

/* ---------------------------------------------
   1. Fetch candles from Binance
--------------------------------------------- */
async function fetchKlines(symbol, interval, limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Binance API Error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/* ---------------------------------------------
   2. SMC Detection Functions
--------------------------------------------- */
function detectBOS(c) {
  const n = c.length;
  if (n < 3) return null;

  const a = c[n - 3], b = c[n - 2], d = c[n - 1];
