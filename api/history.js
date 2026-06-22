function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const HISTORY_SUCCESS_TTL_MS = 45 * 1000;
const HISTORY_FAILURE_TTL_MS = 12 * 1000;

function cacheKey(symbol, interval, fromMs) {
  const bucket = Math.floor(fromMs / 60_000);
  return `${String(symbol || "").toUpperCase()}|${interval}|${bucket}`;
}

function getHistoryRuntime() {
  if (!globalThis.__KBK_HISTORY_RUNTIME__) {
    globalThis.__KBK_HISTORY_RUNTIME__ = {
      success: new Map(),
      failure: new Map(),
      inFlight: new Map(),
    };
  }
  return globalThis.__KBK_HISTORY_RUNTIME__;
}

const { KIS_BASE_URL, getKisAccessToken } = require("../lib/kisToken");

function makeRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function headerValue(headers, name) {
  if (!headers) return "";
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function getRequestContext(req, fallbackCaller) {
  return {
    caller: headerValue(req.headers, "x-kis-caller") || fallbackCaller,
    requestId: headerValue(req.headers, "x-request-id") || makeRequestId(fallbackCaller),
  };
}

function orNum(a, b) {
  const va = num(a);
  return va !== null ? va : num(b);
}

function positiveVolume(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

function clampInt(value, min, max) {
  const parsed = parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function getKstParts(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function getSessionType(date) {
  const parts = getKstParts(date);
  const totalMinutes = parts.hour * 60 + parts.minute;
  if (totalMinutes >= 9 * 60 && totalMinutes < 17 * 60) return "DAY";
  if (totalMinutes >= 17 * 60 && totalMinutes < 22 * 60 + 30) return "PRE";
  if (totalMinutes >= 22 * 60 + 30 || totalMinutes < 5 * 60) return "REGULAR";
  return "AFTER";
}

function getPreferredKisMarketCodes(exchangeName) {
  const normalized = String(exchangeName || "").toUpperCase();
  if (normalized.includes("NYSE") || normalized.includes("NYQ")) {
    return ["BAY", "BAQ", "BAA"];
  }
  if (normalized.includes("AMEX") || normalized.includes("ASE")) {
    return ["BAA", "BAQ", "BAY"];
  }
  return ["BAQ", "BAY", "BAA"];
}

function resolveInterval(requestedInterval) {
  const raw = String(requestedInterval || "1m").trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*m$/);
  const minutes = clampInt(match ? match[1] : "1", 1, 120);
  return {
    requested: raw,
    normalized: `${minutes}m`,
    nmin: String(minutes),
    yahooInterval: `${minutes}m`,
  };
}

function resolveRange(fromMs) {
  const rangeMs = Math.max(0, Date.now() - fromMs);
  if (rangeMs <= 60 * 60 * 1000) return "1h";
  if (rangeMs <= 2 * 60 * 60 * 1000) return "2h";
  if (rangeMs <= 24 * 60 * 60 * 1000) return "1d";
  if (rangeMs <= 5 * 24 * 60 * 60 * 1000) return "5d";
  return "1mo";
}

function findAlternateVolumeSeries(indicators) {
  if (!indicators || typeof indicators !== "object") return null;
  for (const key of Object.keys(indicators)) {
    if (key === "quote") continue;
    const entry = Array.isArray(indicators[key]) ? indicators[key][0] : indicators[key];
    if (!entry || !Array.isArray(entry.volume)) continue;
    if (entry.volume.some((value) => positiveVolume(value) !== null)) {
      return entry.volume;
    }
  }
  return null;
}

function resolveMetaTotalVolume(meta) {
  return orNum(meta.regularMarketVolume, orNum(meta.preMarketVolume, meta.postMarketVolume));
}

function barActivityWeight(bar) {
  const { open, high, low, close } = bar;
  if (high !== null && low !== null && high >= low) {
    const range = high - low;
    if (range > 0) return range;
  }
  if (open !== null && close !== null) return Math.abs(close - open);
  if (close !== null) return 1;
  return 0;
}

function roundVolumeAllocations(allocations, targetSum) {
  const target = Math.max(0, Math.round(targetSum));
  if (!allocations.length) return [];
  const floors = allocations.map((value) => Math.floor(value));
  let remainder = target - floors.reduce((sum, value) => sum + value, 0);
  const ranked = allocations
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let i = 0; i < ranked.length && remainder > 0; i += 1) {
    result[ranked[i].index] += 1;
    remainder -= 1;
  }
  return result;
}

function distributeMetaVolume(bars, totalVolume) {
  const total = num(totalVolume);
  if (!bars.length || total === null || total <= 0) {
    return { bars, volumeSource: null, volumeStatus: "missing" };
  }

  const weights = bars.map(barActivityWeight);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  let allocations;
  if (weightSum > 0) {
    allocations = weights.map((weight) => (weight / weightSum) * total);
  } else {
    const eligible = bars.filter((bar) => bar.close !== null);
    if (!eligible.length) {
      return { bars, volumeSource: null, volumeStatus: "missing" };
    }
    const perBar = total / eligible.length;
    allocations = bars.map((bar) => (bar.close !== null ? perBar : 0));
  }

  const rounded = roundVolumeAllocations(allocations, total);
  const enriched = bars.map((bar, index) => {
    const volume = rounded[index] > 0 ? rounded[index] : null;
    return {
      ...bar,
      volume,
      volumeSource: volume !== null ? "meta-regularMarketVolume-distributed" : null,
    };
  });

  return {
    bars: enriched,
    volumeSource: "meta-regularMarketVolume-distributed",
    volumeStatus: "fallback",
  };
}

function applyVolumeSeries(bars, volumeSeries, volumeSource) {
  if (!Array.isArray(volumeSeries) || !volumeSeries.length) {
    return { bars, volumeSource: null, volumeStatus: "missing" };
  }

  const enriched = bars.map((bar, index) => {
    const volume = positiveVolume(volumeSeries[index]);
    return {
      ...bar,
      volume,
      volumeSource: volume !== null ? volumeSource : null,
    };
  });

  const hasPositive = enriched.some((bar) => bar.volume !== null && bar.volume > 0);
  return {
    bars: enriched,
    volumeSource: hasPositive ? volumeSource : null,
    volumeStatus: hasPositive ? "ok" : "missing",
  };
}

function resolveBarVolumes(rawBars, quote, indicators, meta) {
  const quoteVolumes = Array.isArray(quote.volume) ? quote.volume : [];
  const withQuote = applyVolumeSeries(rawBars, quoteVolumes, "yahoo-quote-volume");
  if (withQuote.volumeStatus === "ok") {
    return withQuote;
  }

  const alternateVolumes = findAlternateVolumeSeries(indicators);
  if (alternateVolumes) {
    const withAlternate = applyVolumeSeries(rawBars, alternateVolumes, "yahoo-indicator-volume");
    if (withAlternate.volumeStatus === "ok") {
      return withAlternate;
    }
  }

  const metaTotal = resolveMetaTotalVolume(meta);
  if (metaTotal !== null && metaTotal > 0) {
    return distributeMetaVolume(rawBars, metaTotal);
  }

  return { bars: rawBars, volumeSource: null, volumeStatus: "missing" };
}

function parseKisDateTime(datePart, timePart) {
  const dateDigits = String(datePart || "").replace(/\D/g, "");
  const timeDigits = String(timePart || "").replace(/\D/g, "");
  if (dateDigits.length !== 8) return null;
  const hhmmss = timeDigits.padEnd(6, "0").slice(0, 6);
  const year = Number(dateDigits.slice(0, 4));
  const month = Number(dateDigits.slice(4, 6));
  const day = Number(dateDigits.slice(6, 8));
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));
  if (
    !Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) ||
    !Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)
  ) {
    return null;
  }
  const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  if (!Number.isFinite(utcMs)) return null;
  const iso = new Date(utcMs).toISOString();
  return { iso, ms: utcMs };
}

function extractKisSeries(payload) {
  const candidates = [payload?.output2, payload?.output1];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.some((row) => row && (row.last !== undefined || row.open !== undefined))) {
      return candidate;
    }
    if (candidate && !Array.isArray(candidate) && (candidate.last !== undefined || candidate.open !== undefined)) {
      return [candidate];
    }
  }
  return [];
}

function normalizeKisBars(rawSeries, fromSec) {
  return rawSeries
    .map((entry) => {
      const datePart = entry?.kymd || entry?.xymd || entry?.tymd;
      const timePart = entry?.khms || entry?.xhms || entry?.stim;
      const parsed = parseKisDateTime(datePart, timePart);
      return {
        timestamp: parsed ? parsed.ms : null,
        time: parsed ? parsed.iso : null,
        open: num(entry?.open),
        high: num(entry?.high),
        low: num(entry?.low),
        close: num(entry?.last),
        volume: positiveVolume(entry?.evol),
        amount: num(entry?.eamt),
        tradeAmount: num(entry?.eamt),
        volumeSource: positiveVolume(entry?.evol) !== null ? "kis-evol" : null,
      };
    })
    .filter((bar) => bar.close !== null && bar.time && bar.timestamp !== null)
    .filter((bar) => bar.timestamp / 1000 >= fromSec)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function dedupeBarsByTimestamp(bars) {
  const byTimestamp = new Map();
  for (const bar of bars) {
    if (bar && bar.timestamp !== null && bar.timestamp !== undefined) {
      byTimestamp.set(bar.timestamp, bar);
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function buildNextKey(rawSeries, intervalMinutes) {
  if (!Array.isArray(rawSeries) || !rawSeries.length) return "";
  const dated = rawSeries
    .map((entry) => {
      const parsed = parseKisDateTime(entry?.kymd || entry?.xymd || entry?.tymd, entry?.khms || entry?.xhms || entry?.stim);
      return parsed ? { entry, parsed } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.parsed.ms - b.parsed.ms);

  if (!dated.length) return "";
  const oldest = dated[0].parsed.ms - intervalMinutes * 60 * 1000;
  const shifted = new Date(oldest + 9 * 60 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const min = String(shifted.getUTCMinutes()).padStart(2, "0");
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${min}${ss}`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function fetchKisBarsPage(symbol, marketCode, token, intervalInfo, keyb) {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!token || !appKey || !appSecret) {
    return { ok: false, reason: "missing-kis-credentials" };
  }

  const params = new URLSearchParams({
    AUTH: "",
    EXCD: marketCode,
    SYMB: symbol,
    NMIN: intervalInfo.nmin,
    PINC: "1",
    NEXT: keyb ? "1" : "",
    NREC: "120",
    FILL: "",
    KEYB: keyb || "",
  });

  const result = await fetchJson(
    `${KIS_BASE_URL}/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice?${params.toString()}`,
    {
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: "HHDFS76950200",
        custtype: "P",
      },
    }
  );

  if (!result.response.ok || !result.payload) {
    return {
      ok: false,
      reason: `kis-http-${result.response.status}`,
      payload: result.payload,
    };
  }

  if (result.payload.rt_cd !== "0") {
    return {
      ok: false,
      reason: result.payload.msg1 || result.payload.msg_cd || "kis-nonzero-rt-cd",
      payload: result.payload,
    };
  }

  const series = extractKisSeries(result.payload);
  return {
    ok: true,
    series,
    payload: result.payload,
  };
}

async function fetchKisHistory(symbol, exchangeName, sessionType, intervalInfo, fromMs, requestContext) {
  if (sessionType !== "DAY") {
    return { ok: false, reason: "non-day-session" };
  }

  const token = await getKisAccessToken(requestContext.caller, {
    requestId: requestContext.requestId,
    symbol,
  });
  if (!token) {
    return { ok: false, reason: "missing-token" };
  }

  const marketCodes = getPreferredKisMarketCodes(exchangeName);
  const fromSec = fromMs / 1000;

  for (const marketCode of marketCodes) {
    let keyb = "";
    let attempts = 0;
    let allRawBars = [];
    let lastFailure = null;

    while (attempts < 5) {
      attempts += 1;
      const page = await fetchKisBarsPage(symbol, marketCode, token, intervalInfo, keyb);
      if (!page.ok) {
        lastFailure = page.reason || "kis-page-failed";
        break;
      }

      const pageSeries = Array.isArray(page.series) ? page.series : [];
      if (!pageSeries.length) {
        lastFailure = "empty-kis-series";
        break;
      }

      allRawBars = allRawBars.concat(pageSeries);
      keyb = buildNextKey(pageSeries, clampInt(intervalInfo.nmin, 1, 120));
      if (!keyb) break;

      const normalizedSoFar = normalizeKisBars(allRawBars, fromSec);
      const oldest = normalizedSoFar[0];
      if (!oldest || oldest.timestamp / 1000 <= fromSec) break;
      if (pageSeries.length < 120) break;
    }

    const bars = dedupeBarsByTimestamp(normalizeKisBars(allRawBars, fromSec));
    if (bars.length) {
      return {
        ok: true,
        bars,
        marketCode,
        historySource: "kis-daymarket-bars",
        volumeSource: "kis-evol",
        interval: intervalInfo.normalized,
        barCount: bars.length,
      };
    }

    if (lastFailure) {
      continue;
    }
  }

  return { ok: false, reason: "no-usable-market-code" };
}

async function fetchYahooQuoteExchange(symbol) {
  const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const result = await fetchJson(quoteUrl, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
  });
  const quote = result?.payload?.quoteResponse?.result?.[0] || {};
  return quote.exchangeName || quote.fullExchangeName || "";
}

async function fetchYahooHistory(symbol, intervalInfo, fromMs) {
  const range = resolveRange(fromMs);
  const yahooUrl =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=${encodeURIComponent(intervalInfo.yahooInterval)}&includePrePost=true`;

  const yahooRes = await fetch(yahooUrl, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
  });
  const payload = await yahooRes.json();

  if (!yahooRes.ok || payload?.chart?.error) {
    const errMsg = payload?.chart?.error?.description || `Yahoo HTTP ${yahooRes.status}`;
    throw new Error(errMsg);
  }

  const result = payload?.chart?.result?.[0];
  const meta = result?.meta || {};
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const indicators = result?.indicators || {};
  const fromSec = fromMs / 1000;

  const rawBars = timestamps
    .map((ts, i) => ({
      timestamp: ts * 1000,
      time: new Date(ts * 1000).toISOString(),
      open: num(quote.open?.[i]),
      high: num(quote.high?.[i]),
      low: num(quote.low?.[i]),
      close: num(quote.close?.[i]),
      volume: null,
      amount: null,
      tradeAmount: null,
    }))
    .filter((bar) => bar.close !== null && bar.timestamp / 1000 >= fromSec);

  const volumeResolution = resolveBarVolumes(rawBars, quote, indicators, meta);
  const bars = volumeResolution.bars;

  return {
    symbol: meta.symbol || symbol,
    currency: meta.currency || "USD",
    regularMarketPrice: num(meta.regularMarketPrice),
    previousClose: num(meta.previousClose) || num(meta.chartPreviousClose),
    regularMarketVolume: resolveMetaTotalVolume(meta),
    volumeSource: volumeResolution.volumeSource,
    volumeStatus: volumeResolution.volumeStatus,
    barsWithVolume: bars.filter((bar) => bar.volume !== null && bar.volume > 0).length,
    bars,
    exchangeName: meta.exchangeName || meta.fullExchangeName || "",
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const url = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    const symbol = url.searchParams.get("symbol") || "";
    const from = url.searchParams.get("from") || "";
    const intervalInfo = resolveInterval(url.searchParams.get("interval") || "1m");
    const requestContext = getRequestContext(req, "history");
    console.log(`[HISTORY] request requestId=${requestContext.requestId} caller=${requestContext.caller} symbol=${symbol} interval=${intervalInfo.normalized}`);

    if (!symbol || /^\d+$/.test(symbol)) {
      return res.status(400).json({ ok: false, code: "BAD_SYMBOL", message: `Invalid symbol: ${symbol}` });
    }

    const fromMs = from ? new Date(from).getTime() : Date.now() - 6 * 60 * 60 * 1000;
    const safeFromMs = Number.isFinite(fromMs) ? fromMs : Date.now() - 6 * 60 * 60 * 1000;
    const key = cacheKey(symbol, intervalInfo.normalized, safeFromMs);
    const runtime = getHistoryRuntime();
    const now = Date.now();
    const successCached = runtime.success.get(key);
    if (successCached && now < successCached.expiresAt) {
      res.setHeader("cache-control", "public, s-maxage=20, stale-while-revalidate=40");
      return res.status(200).json(successCached.payload);
    }
    const failureCached = runtime.failure.get(key);
    if (failureCached && now < failureCached.expiresAt) {
      res.setHeader("cache-control", "public, s-maxage=4");
      return res.status(502).json(failureCached.payload);
    }
    if (runtime.inFlight.has(key)) {
      const shared = await runtime.inFlight.get(key);
      res.setHeader("cache-control", shared.ok ? "public, s-maxage=20, stale-while-revalidate=40" : "public, s-maxage=4");
      return res.status(shared.ok ? 200 : 502).json(shared.payload);
    }

    const work = (async () => {
    const sessionType = getSessionType(new Date());

    let exchangeName = "";
    let kisHistory = { ok: false, reason: "not-attempted" };
    let fallbackReason = null;

    if (sessionType === "DAY") {
      exchangeName = await fetchYahooQuoteExchange(symbol).catch(() => "");
      kisHistory = await fetchKisHistory(symbol, exchangeName, sessionType, intervalInfo, safeFromMs, requestContext);
      if (!kisHistory.ok) {
        fallbackReason = kisHistory.reason || "kis-history-failed";
      }
    }

    if (kisHistory.ok) {
      return {
        ok: true,
        payload: {
        ok: true,
        data: {
          symbol,
          currency: "USD",
          regularMarketPrice: kisHistory.bars.at(-1)?.close ?? null,
          previousClose: null,
          regularMarketVolume: null,
          sessionType,
          historySource: kisHistory.historySource,
          volumeSource: kisHistory.volumeSource,
          volumeStatus: "ok",
          kisMarketCode: kisHistory.marketCode,
          kisInterval: kisHistory.interval,
          kisBarCount: kisHistory.barCount,
          barsWithVolume: kisHistory.bars.filter((bar) => bar.volume !== null && bar.volume > 0).length,
          bars: kisHistory.bars,
        },
      },
      };
    }

    const yahooHistory = await fetchYahooHistory(symbol, intervalInfo, safeFromMs);

    return {
      ok: true,
      payload: {
      ok: true,
      data: {
        symbol: yahooHistory.symbol,
        currency: yahooHistory.currency,
        regularMarketPrice: yahooHistory.regularMarketPrice,
        previousClose: yahooHistory.previousClose,
        regularMarketVolume: yahooHistory.regularMarketVolume,
        sessionType,
        historySource: sessionType === "DAY" ? "yahoo-fallback" : "yahoo",
        volumeSource: yahooHistory.volumeSource,
        volumeStatus: yahooHistory.volumeStatus,
        kisMarketCode: null,
        kisInterval: null,
        kisBarCount: 0,
        fallbackReason,
        kisError: fallbackReason,
        barsWithVolume: yahooHistory.barsWithVolume,
        bars: yahooHistory.bars,
      },
    },
    };
    })();

    runtime.inFlight.set(key, work);
    let settled;
    try {
      settled = await work;
    } finally {
      runtime.inFlight.delete(key);
    }
    if (settled.ok) {
      runtime.success.set(key, {
        expiresAt: Date.now() + HISTORY_SUCCESS_TTL_MS,
        payload: settled.payload,
      });
      runtime.failure.delete(key);
      res.setHeader("cache-control", "public, s-maxage=20, stale-while-revalidate=40");
      return res.status(200).json(settled.payload);
    }
    runtime.failure.set(key, {
      expiresAt: Date.now() + HISTORY_FAILURE_TTL_MS,
      payload: settled.payload,
    });
    res.setHeader("cache-control", "public, s-maxage=4");
    return res.status(502).json(settled.payload);
  } catch (error) {
    const payload = {
      ok: false,
      code: "HANDLER_ERROR",
      message: error instanceof Error ? error.message : "history handler failed",
    };
    res.setHeader("cache-control", "public, s-maxage=4");
    return res.status(502).json(payload);
  }
};
