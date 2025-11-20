// server.js
// Infinity Crypto Signals – Full SMC + MTF Engine Backend
// CommonJS version for Render

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 4000;

/* ---------------------------------------------
   Helper: interval + symbol mappings
--------------------------------------------- */

// OKX uses 1m, 5m, 15m, 30m, 1H, 4H, 1D, 1W, 1M
const OKX_BAR_MAP = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
  "1w": "1W",
  "1M": "1M",
};

// Bybit v5 kline: 1,3,5,15,30,60,120,240,360,720,D,W,M
const BYBIT_INTERVAL_MAP = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
  "1M": "M",
};

// CoinGecko OHLC `days` parameter by TF
const COINGECKO_DAYS_MAP = {
  "1m": 1,
  "5m": 1,
  "15m": 1,
  "30m": 1,
  "1h": 1,
  "4h": 1,
  "1d": 30,
  "1w": 365,
  "1M": 365,
};

// Minimal symbol → CoinGecko id map (extend as needed)
const COINGECKO_SYMBOL_MAP = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  XRPUSDT: "ripple",
  BNBUSDT: "binancecoin",
  SOLUSDT: "solana",
  ADAUSDT: "cardano",
  DOGEUSDT: "dogecoin",
  AVAXUSDT: "avalanche-2",
  LINKUSDT: "chainlink",
};

/* ---------------------------------------------
   1. Fetch candles from multiple sources
--------------------------------------------- */

async function fetchKlines(symbol, interval, limit = 200) {
  const okxInstId = symbol
    .replace("USDT", "-USDT")
    .replace("USDC", "-USDC"); // simple spot mapping

  const okxBar = OKX_BAR_MAP[interval] || interval;
  const bybitInterval = BYBIT_INTERVAL_MAP[interval] || "60";
  const cgId = COINGECKO_SYMBOL_MAP[symbol];
  const cgDays = COINGECKO_DAYS_MAP[interval] || 1;

  const sources = [
    {
      name: "OKX",
      url: `https://www.okx.com/api/v5/market/candles?instId=${okxInstId}&bar=${okxBar}&limit=${limit}`,
      map: (json) =>
        (json.data || []).map((k) => ({
          time: Number(k[0]) / 1000,
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
        })),
    },
    {
      name: "BYBIT",
      url: `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`,
      map: (json) =>
        (json.result?.list || []).map((k) => {
          // list is usually [start, open, high, low, close, volume, turnover]
          const arr = Array.isArray(k) ? k : [];
          return {
            time: Number(arr[0]) / 1000,
            open: Number(arr[1]),
            high: Number(arr[2]),
            low: Number(arr[3]),
            close: Number(arr[4]),
          };
        }),
    },
    {
      name: "MEXC",
      url: `https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      map: (json) =>
        (Array.isArray(json) ? json : []).map((k) => ({
          time: k[0] / 1000,
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
        })),
    },
    {
      name: "BINANCE",
      url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      map: (json) =>
        (Array.isArray(json) ? json : []).map((k) => ({
          time: k[0] / 1000,
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
        })),
    },
    cgId && {
      name: "COINGECKO",
      url: `https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=${cgDays}`,
      map: (json) =>
        (Array.isArray(json) ? json : []).map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
        })),
    },
  ].filter(Boolean);

  let lastError = null;

  for (const src of sources) {
    try {
      console.log(
        `[fetchKlines] Trying ${src.name} for ${symbol} ${interval}: ${src.url}`
      );

      const response = await fetch(src.url);
      if (!response.ok) {
        lastError = new Error(
          `${src.name} responded ${response.status} ${response.statusText}`
        );
        console.warn(
          `[fetchKlines] ${src.name} failed for ${symbol} ${interval}:`,
          lastError.message
        );
        continue;
      }

      const data = await response.json();
      const mapped = src.map(data) || [];

      if (mapped.length > 0) {
        // Ensure oldest → newest
        mapped.sort((a, b) => a.time - b.time);
        console.log(
          `[fetchKlines] Using ${src.name} for ${symbol} ${interval}, candles: ${mapped.length}`
        );
        return { candles: mapped, source: src.name };
      }

      lastError = new Error(`${src.name} returned empty data`);
      console.warn(
        `[fetchKlines] ${src.name} empty for ${symbol} ${interval}`
      );
    } catch (err) {
      lastError = err;
      console.warn(
        `[fetchKlines] Error calling ${src.name} for ${symbol} ${interval}:`,
        err.message
      );
      continue;
    }
  }

  console.error(
    `[fetchKlines] All sources failed for ${symbol} ${interval}:`,
    lastError && lastError.message
  );
  throw lastError || new Error("All price sources failed");
}

/* ---------------------------------------------
   2. SMC Detection Functions
--------------------------------------------- */

function detectBOS(candles) {
  const n = candles.length;
  if (n < 3) return null;

  const a = candles[n - 3];
  const b = candles[n - 2];
  const d = candles[n - 1];

  if (d.high > a.high && b.high <= a.high) {
    return { type: "BOS_BULLISH", time: d.time, level: a.high };
  }

  if (d.low < a.low && b.low >= a.low) {
    return { type: "BOS_BEARISH", time: d.time, level: a.low };
  }

  return null;
}

function detectCHOCH(candles) {
  const n = candles.length;
  if (n < 4) return null;

  const prev = candles[n - 4];
  const swing = candles[n - 2];
  const last = candles[n - 1];

  if (last.high > swing.high && swing.low < prev.low) {
    return { type: "CHOCH_BULLISH", time: last.time };
  }

  if (last.low < swing.low && swing.high > prev.high) {
    return { type: "CHOCH_BEARISH", time: last.time };
  }

  return null;
}

function detectLiquiditySweep(candles) {
  const n = candles.length;
  if (n < 4) return null;

  const a = candles[n - 3];
  const b = candles[n - 2];
  const d = candles[n - 1];

  if (d.high > a.high && d.close < b.close) {
    return { type: "SWEEP_HIGH", level: a.high, time: d.time };
  }

  if (d.low < a.low && d.close > b.close) {
    return { type: "SWEEP_LOW", level: a.low, time: d.time };
  }

  return null;
}

function collectFVG(candles, depth = 60) {
  const zones = [];
  const start = Math.max(2, candles.length - depth);

  for (let i = start; i < candles.length; i++) {
    const a = candles[i - 2];
    const d = candles[i];

    if (a.high < d.low) {
      zones.push({
        type: "FVG_BULLISH",
        lower: a.high,
        upper: d.low,
        time: d.time,
      });
    }

    if (d.high < a.low) {
      zones.push({
        type: "FVG_BEARISH",
        lower: d.high,
        upper: a.low,
        time: d.time,
      });
    }
  }

  return zones;
}

function collectOrderBlocks(candles, depth = 60) {
  const zones = [];
  const start = Math.max(2, candles.length - depth);

  for (let i = start; i < candles.length; i++) {
    const prev = candles[i - 1];
    const last = candles[i];

    // Bullish OB
    if (
      prev.close < prev.open &&
      last.close > last.open &&
      last.close > prev.high
    ) {
      zones.push({
        type: "OB_BULLISH",
        time: prev.time,
        high: prev.high,
        low: prev.low,
      });
    }

    // Bearish OB
    if (
      prev.close > prev.open &&
      last.close < last.open &&
      last.close < prev.low
    ) {
      zones.push({
        type: "OB_BEARISH",
        time: prev.time,
        high: prev.high,
        low: prev.low,
      });
    }
  }

  return zones;
}

/* ---------------------------------------------
   3. Build SMC Signals per timeframe
--------------------------------------------- */

function buildSMCSignals(candlesInput) {
  // ensure we don't mutate original
  const candles = (candlesInput || []).slice().sort((a, b) => a.time - b.time);

  const bos = detectBOS(candles);
  const choch = detectCHOCH(candles);
  const sweep = detectLiquiditySweep(candles);
  const fvgZones = collectFVG(candles);
  const orderBlocks = collectOrderBlocks(candles);

  const markers = [];
  const last = candles[candles.length - 1];

  if (last && choch && sweep) {
    if (choch.type === "CHOCH_BULLISH" && sweep.type === "SWEEP_LOW") {
      markers.push({
        time: last.time,
        position: "belowBar",
        color: "#00ff85",
        shape: "arrowUp",
        text: "BUY (CHOCH + Sweep)",
      });
    }

    if (choch.type === "CHOCH_BEARISH" && sweep.type === "SWEEP_HIGH") {
      markers.push({
        time: last.time,
        position: "aboveBar",
        color: "#ff5555",
        shape: "arrowDown",
        text: "SELL (CHOCH + Sweep)",
      });
    }
  }

  return {
    candles,
    markers,
    smcSignals: { bos, choch, sweep },
    fvgZones,
    orderBlocks,
  };
}

/* ---------------------------------------------
   4. Multi-Timeframe Confluence
--------------------------------------------- */

function inside(price, low, high) {
  return price >= low && price <= high;
}

function getLatest(arr, type) {
  const f = (arr || []).filter((z) => z.type === type);
  return f.length ? f[f.length - 1] : null;
}

function buildMtf(htf, ltf) {
  const bos = htf.smcSignals.bos;
  const choch = htf.smcSignals.choch;

  const htfBias =
    (choch && choch.type === "CHOCH_BULLISH") ||
    (bos && bos.type === "BOS_BULLISH")
      ? "BULLISH"
      : (choch && choch.type === "CHOCH_BEARISH") ||
        (bos && bos.type === "BOS_BEARISH")
      ? "BEARISH"
      : "NEUTRAL";

  const bullFvg = getLatest(htf.fvgZones, "FVG_BULLISH");
  const bearFvg = getLatest(htf.fvgZones, "FVG_BEARISH");
  const bullOb = getLatest(htf.orderBlocks, "OB_BULLISH");
  const bearOb = getLatest(htf.orderBlocks, "OB_BEARISH");

  const finalSignals = [];
  const lastCandle = ltf.candles[ltf.candles.length - 1];
  const price = lastCandle?.close;

  for (const m of ltf.markers || []) {
    if (!price) break;

    if (m.text.startsWith("BUY") && htfBias === "BULLISH") {
      if (bullFvg && inside(price, bullFvg.lower, bullFvg.upper)) {
        finalSignals.push({ ...m, reason: "BUY in HTF FVG", price });
      }
      if (bullOb && inside(price, bullOb.low, bullOb.high)) {
        finalSignals.push({ ...m, reason: "BUY in HTF Order Block", price });
      }
    }

    if (m.text.startsWith("SELL") && htfBias === "BEARISH") {
      if (bearFvg && inside(price, bearFvg.lower, bearFvg.upper)) {
        finalSignals.push({ ...m, reason: "SELL in HTF FVG", price });
      }
      if (bearOb && inside(price, bearOb.low, bearOb.high)) {
        finalSignals.push({ ...m, reason: "SELL in HTF Order Block", price });
      }
    }
  }

  return {
    htfBias,
    executionSignals: finalSignals,
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

    console.log(
      `[mtf-signals] Request for symbol=${symbol}, htf=${htf}, ltf=${ltf}`
    );

    const htfData = await fetchKlines(symbol, htf, 200);
    const ltfData = await fetchKlines(symbol, ltf, 300);

    const htfSMC = buildSMCSignals(htfData.candles);
    const ltfSMC = buildSMCSignals(ltfData.candles);
    const mtf = buildMtf(htfSMC, ltfSMC);

    res.json({
      symbol,
      htfInterval: htf,
      ltfInterval: ltf,
      dataSource: `${htfData.source}/${ltfData.source}`,
      htf: htfSMC,
      ltf: ltfSMC,
      mtfSignals: mtf,
      generatedAt: Date.now(),
    });
  } catch (err) {
    console.error("[mtf-signals] Error:", err.message);
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
    totalPnl: 0,
  });
});

/* ---------------------------------------------
   7. Start server
--------------------------------------------- */

app.listen(PORT, () => {
  console.log(`Infinity Crypto Signals backend running on port ${PORT}`);
});

// Extra safety: log unhandled promise rejections so Render doesn't kill silently
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
