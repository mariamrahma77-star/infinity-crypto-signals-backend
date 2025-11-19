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

// PATCHED ✔
function detectBOS(c) {
  const n = c.length;
  if (n < 3) return null;

  const a = c[n - 3], b = c[n - 2], d = c[n - 1];

  if (d.high > a.high && b.high <= a.high)
    return { type: "BOS_BULLISH", time: d.time, level: a.high };

  if (d.low < a.low && b.low >= a.low)
    return { type: "BOS_BEARISH", time: d.time, level: a.low };

  return null;
}

// PATCHED ✔
function detectCHOCH(c) {
  const n = c.length;
  if (n < 4) return null;

  const prev = c[n - 4], swing = c[n - 2], last = c[n - 1];

  if (last.high > swing.high && swing.low < prev.low)
    return { type: "CHOCH_BULLISH", time: last.time };

  if (last.low < swing.low && swing.high > prev.high)
    return { type: "CHOCH_BEARISH", time: last.time };

  return null;
}

// PATCHED ✔
function detectLiquiditySweep(c) {
  const n = c.length;
  if (n < 4) return null;

  const a = c[n - 3], b = c[n - 2], d = c[n - 1];

  if (d.high > a.high && d.close < b.close)
    return { type: "SWEEP_HIGH", level: a.high, time: d.time };

  if (d.low < a.low && d.close > b.close)
    return { type: "SWEEP_LOW", level: a.low, time: d.time };

  return null;
}

/* Collect fair value gaps */
function collectFVG(c, depth = 60) {
  const zones = [];
  const start = Math.max(2, c.length - depth);

  for (let i = start; i < c.length; i++) {
    const a = c[i - 2], b = c[i - 1], d = c[i];

    if (a.high < d.low)
      zones.push({
        type: "FVG_BULLISH",
        lower: a.high,
        upper: d.low,
        time: d.time
      });

    if (d.high < a.low)
      zones.push({
        type: "FVG_BEARISH",
        lower: d.high,
        upper: a.low,
        time: d.time
      });
  }

  return zones;
}

/* Collect order blocks */
function collectOrderBlocks(c, depth = 60) {
  const zones = [];
  const start = Math.max(2, c.length - depth);

  for (let i = start; i < c.length; i++) {
    const prev = c[i - 1], last = c[i];

    if (prev.close < prev.open && last.close > last.open && last.close > prev.high)
      zones.push({
        type: "OB_BULLISH",
        time: prev.time,
        high: prev.high,
        low: prev.low
      });

    if (prev.close > prev.open && last.close < last.open && last.close < prev.low)
      zones.push({
        type: "OB_BEARISH",
        time: prev.time,
        high: prev.high,
        low: prev.low
      });
  }

  return zones;
}

/* ---------------------------------------------
   3. Convert raw klines → candle objects + SMC Signals
--------------------------------------------- */
function buildSMCSignals(klines) {
  const candles = klines.map(k => ({
    time: k[0] / 1000,
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4]
  }));

  const bos = detectBOS(candles);
  const choch = detectCHOCH(candles);
  const sweep = detectLiquiditySweep(candles);
  const fvgZones = collectFVG(candles);
  const orderBlocks = collectOrderBlocks(candles);

  const markers = [];
  const last = candles[candles.length - 1];

  if (choch?.type === "CHOCH_BULLISH" && sweep?.type === "SWEEP_LOW") {
    markers.push({
      time: last.time,
      position: "belowBar",
      color: "#00ff85",
      shape: "arrowUp",
      text: "BUY (CHOCH + Sweep)"
    });
  }

  if (choch?.type === "CHOCH_BEARISH" && sweep?.type === "SWEEP_HIGH") {
    markers.push({
      time: last.time,
      position: "aboveBar",
      color: "#ff5555",
      shape: "arrowDown",
      text: "SELL (CHOCH + Sweep)"
    });
  }

  return {
    candles,
    markers,
    smcSignals: { bos, choch, sweep },
    fvgZones,
    orderBlocks
  };
}

/* ---------------------------------------------
   4. Multi-Timeframe Confluence
--------------------------------------------- */
function inside(price, low, high) {
  return price >= low && price <= high;
}

function getLatest(arr, type) {
  const f = arr.filter(z => z.type === type);
  return f.length ? f[f.length - 1] : null;
}

function buildMtf(htf, ltf) {
  const htfBias =
    htf.smcSignals.choch?.type === "CHOCH_BULLISH" ||
    htf.smcSignals.bos?.type === "BOS_BULLISH"
      ? "BULLISH"
      : htf.smcSignals.choch?.type === "CHOCH_BEARISH" ||
        htf.smcSignals.bos?.type === "BOS_BEARISH"
      ? "BEARISH"
      : "NEUTRAL";

  const bullFvg = getLatest(htf.fvgZones, "FVG_BULLISH");
  const bearFvg = getLatest(htf.fvgZones, "FVG_BEARISH");

  const bullOb = getLatest(htf.orderBlocks, "OB_BULLISH");
  const bearOb = getLatest(htf.orderBlocks, "OB_BEARISH");

  const finalSignals = [];
  const price = ltf.candles.at(-1).close;

  for (const m of ltf.markers) {
    if (m.text.startsWith("BUY") && htfBias === "BULLISH") {
      if (bullFvg && inside(price, bullFvg.lower, bullFvg.upper))
        finalSignals.push({ ...m, reason: "BUY in HTF FVG", price });
      if (bullOb && inside(price, bullOb.low, bullOb.high))
        finalSignals.push({ ...m, reason: "BUY in HTF Order Block", price });
    }

    if (m.text.startsWith("SELL") && htfBias === "BEARISH") {
      if (bearFvg && inside(price, bearFvg.lower, bearFvg.upper))
        finalSignals.push({ ...m, reason: "SELL in HTF FVG", price });
      if (bearOb && inside(price, bearOb.low, bearOb.high))
        finalSignals.push({ ...m, reason: "SELL in HTF Order Block", price });
    }
  }

  return {
    htfBias,
    executionSignals: finalSignals
  };
}

/* ---------------------------------------------
   5. API Endpoint: Multi-Timeframe SMC Signals
--------------------------------------------- */
app.get("/api/mtf-signals", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTCUSDT";
    const htf = req.query.htf || "1h";
    const ltf = req.query.ltf || "15m";

    const [htfData, ltfData] = await Promise.all([
      fetchKlines(symbol, htf, 200),
      fetchKlines(symbol, ltf, 300)
    ]);

    const htfSMC = buildSMCSignals(htfData);
    const ltfSMC = buildSMCSignals(ltfData);
    const mtf = buildMtf(htfSMC, ltfSMC);

    res.json({
      symbol,
      htfInterval: htf,
      ltfInterval: ltf,
      htf: htfSMC,
      ltf: ltfSMC,
      mtfSignals: mtf,
      generatedAt: Date.now()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------------------------------------
   6. Placeholder backtest endpoint
--------------------------------------------- */
app.get("/api/mtf-backtest", (req, res) => {
  res.json({
    notice: "Backtest endpoint placeholder. Logic can be expanded later.",
    trades: [],
    winRate: 0,
    totalPnl: 0
  });
});

/* ---------------------------------------------
   7. Start server
--------------------------------------------- */
app.listen(PORT, () => {
  console.log(`Infinity Crypto Signals backend running on port ${PORT}`);
});
