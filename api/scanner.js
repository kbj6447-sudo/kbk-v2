const UPSTREAM = "https://kbk-theta-accumulation-pro.vercel.app/api/scanner";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function volumeStrength(item) {
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio);
  const previousVolumeRatio = num(item.previousDayVolumeRatio);
  const bestVolumeRatio = Math.max(relativeVolume ?? 0, previousVolumeRatio ?? 0);
  const rvolScore = bestVolumeRatio >= 8 ? 96
    : bestVolumeRatio >= 5 ? 86
      : bestVolumeRatio >= 3 ? 74
        : bestVolumeRatio >= 1.5 ? 60
          : bestVolumeRatio > 0 ? 42
            : 0;
  const rawScore = rawVolume >= 20_000_000 ? 96
    : rawVolume >= 10_000_000 ? 86
      : rawVolume >= 5_000_000 ? 78
        : rawVolume >= 1_000_000 ? 65
          : 42;
  return clamp(Math.max(rvolScore, rawScore));
}

function average(values) {
  const clean = values.map(num).filter((value) => value !== null && value > 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function pickDisplayPrice({ marketState, regularPrice, preMarketPrice, postMarketPrice, latestClose }) {
  const normalizedState = String(marketState || "").toUpperCase();
  if (normalizedState === "PRE" && preMarketPrice !== null) return preMarketPrice;
  if ((normalizedState === "POST" || normalizedState === "POSTPOST") && postMarketPrice !== null) return postMarketPrice;
  if (!normalizedState && latestClose !== null) return latestClose;
  return latestClose ?? regularPrice ?? preMarketPrice ?? postMarketPrice ?? null;
}

function normalizeLiveQuote(item, quoteSnapshot = {}, chartSnapshot = {}) {
  const marketState = String(
    quoteSnapshot.marketState
    ?? item.marketState
    ?? chartSnapshot.marketState
    ?? "",
  ).toUpperCase();
  const regularPrice = num(quoteSnapshot.regularMarketPrice)
    ?? num(item.regularMarketPrice)
    ?? num(chartSnapshot.regularMarketPrice)
    ?? num(item.price);
  const preMarketPrice = num(quoteSnapshot.preMarketPrice)
    ?? num(item.preMarketPrice)
    ?? num(chartSnapshot.preMarketPrice)
    ?? regularPrice;
  const postMarketPrice = num(quoteSnapshot.postMarketPrice)
    ?? num(item.postMarketPrice)
    ?? num(chartSnapshot.postMarketPrice);
  const latestClose = num(chartSnapshot.latestClose);
  const displayPrice = pickDisplayPrice({
    marketState,
    regularPrice,
    preMarketPrice,
    postMarketPrice,
    latestClose,
  });
  const previousClose = num(quoteSnapshot.regularMarketPreviousClose)
    ?? num(quoteSnapshot.previousClose)
    ?? num(item.previousClose)
    ?? num(chartSnapshot.previousClose)
    ?? num(chartSnapshot.chartPreviousClose);
  const change = displayPrice !== null && previousClose !== null ? displayPrice - previousClose : null;
  const changePercent = change !== null && previousClose ? (change / previousClose) * 100 : null;
  const currentVolume = Math.max(
    num(item.volume) ?? 0,
    num(item.preMarketVolume) ?? 0,
    num(quoteSnapshot.regularMarketVolume) ?? 0,
    num(chartSnapshot.regularMarketVolume) ?? 0,
    num(chartSnapshot.volume) ?? 0,
  ) || null;

  return {
    price: displayPrice ?? item.price,
    normalizedLivePriceUsd: displayPrice,
    regularMarketPrice: regularPrice,
    preMarketPrice: preMarketPrice,
    postMarketPrice: postMarketPrice,
    previousClose: previousClose ?? item.previousClose ?? null,
    change: change ?? num(item.change) ?? null,
    changePercent: changePercent ?? num(item.changePercent) ?? num(item.preMarketChangePercent) ?? null,
    marketState,
    extendedHours: marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST",
    latestClose,
    latestBarAge: num(chartSnapshot.latestBarAge),
    priceUpdatedAt: chartSnapshot.priceUpdatedAt ?? null,
    volume: currentVolume ?? item.volume,
    averageVolume: num(quoteSnapshot.averageDailyVolume3Month)
      ?? num(quoteSnapshot.averageDailyVolume10Day)
      ?? num(item.averageVolume),
  };
}

async function fetchBatchQuoteMap(symbols) {
  const map = new Map();
  const cleanSymbols = [...new Set(symbols.filter(Boolean))];
  const chunkSize = 50;
  for (let start = 0; start < cleanSymbols.length; start += chunkSize) {
    const chunk = cleanSymbols.slice(start, start + chunkSize);
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      const results = payload?.quoteResponse?.result;
      if (!response.ok || !Array.isArray(results)) continue;
      for (const quote of results) {
        if (quote?.symbol) map.set(String(quote.symbol).toUpperCase(), quote);
      }
    } catch {
      // Keep scanner working even if Yahoo batch quote intermittently fails.
    }
  }
  return map;
}

async function fetchChartSnapshot(symbol) {
  if (!symbol) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.chart?.error) return {};
    const result = payload?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quote.close) ? quote.close.map(num) : [];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];

    let latestClose = null;
    let latestTimestamp = null;
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      if (closes[i] !== null) {
        latestClose = closes[i];
        latestTimestamp = timestamps[i] ?? null;
        break;
      }
    }

    const volumes = Array.isArray(quote.volume) ? quote.volume.map(num).filter((value) => value !== null && value > 0) : [];
    const latestBarAge = latestTimestamp ? Math.max(0, Math.round((Date.now() - latestTimestamp * 1000) / 60000)) : null;
    return {
      latestClose,
      latestBarAge,
      priceUpdatedAt: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : null,
      marketState: meta.marketState,
      regularMarketPrice: num(meta.regularMarketPrice),
      previousClose: num(meta.previousClose),
      chartPreviousClose: num(meta.chartPreviousClose),
      regularMarketVolume: num(meta.regularMarketVolume),
      volume: volumes.reduce((sum, value) => sum + value, 0) || null,
    };
  } catch {
    return {};
  }
}

async function fetchVolumeProfile(symbol, currentVolume) {
  if (!symbol) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&includePrePost=true`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok || payload?.chart?.error) {
      return { volumeProfileStatus: `chart-error-${response.status}` };
    }
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0] || {};
    const volumes = Array.isArray(quote.volume) ? quote.volume.map(num).filter((value) => value !== null && value > 0) : [];
    if (!volumes.length) return { volumeProfileStatus: "no-daily-volume" };

    const latestChartVolume = volumes.at(-1);
    const liveVolume = Math.max(num(currentVolume) ?? 0, num(result?.meta?.regularMarketVolume) ?? 0, latestChartVolume ?? 0);
    const previousDayVolume = volumes.length > 1 ? volumes.at(-2) : null;
    const averageVolume20d = average(volumes.slice(0, -1).slice(-20));
    return {
      averageVolume: averageVolume20d,
      previousDayVolume,
      relativeVolume: averageVolume20d ? liveVolume / averageVolume20d : null,
      volumeRatio: averageVolume20d ? liveVolume / averageVolume20d : null,
      previousDayVolumeRatio: previousDayVolume ? liveVolume / previousDayVolume : null,
      volume: liveVolume || currentVolume,
      volumeSource: "yahoo-daily-chart",
      volumeProfileStatus: "ok",
    };
  } catch {
    return { volumeProfileStatus: "fetch-failed" };
  }
}

async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function boostedScore(item) {
  const premarketChange = num(item.preMarketChangePercent) ?? num(item.changePercent) ?? 0;
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const currentScore = num(item.finalProbabilityScore) ?? num(item.scannerScore) ?? 0;

  let score = currentScore;
  if (premarketChange >= 150 && rawVolume >= 1_000_000) score = Math.max(score, 82);
  if (premarketChange >= 100 && rawVolume >= 5_000_000) score = Math.max(score, 78);
  if (premarketChange >= 60 && rawVolume >= 5_000_000) score = Math.max(score, 70);

  return Math.round(clamp(score));
}

async function normalizeItem(item, enrichVolume = true) {
  if (!item || typeof item !== "object") return item;

  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const needsVolumeProfile = enrichVolume && ((num(item.relativeVolume) ?? num(item.volumeRatio)) === null || num(item.averageVolume) === null);
  const volumeProfile = needsVolumeProfile ? await fetchVolumeProfile(item.symbol, rawVolume) : {};
  const merged = { ...item, ...Object.fromEntries(Object.entries(volumeProfile).filter(([, value]) => value !== null && value !== undefined)) };
  const boosted = boostedScore(merged);
  const correctedVolumeScore = volumeStrength(merged);

  return {
    ...merged,
    volumeComputationVersion: "pro-rvol-v2",
    volume: Math.max(num(merged.volume) ?? 0, rawVolume) || item.volume,
    volumeStrengthScore: correctedVolumeScore,
    scannerScore: Math.max(num(merged.scannerScore) ?? 0, boosted),
    finalProbabilityScore: Math.max(num(merged.finalProbabilityScore) ?? 0, boosted),
    selectionReasons: [
      ...(Array.isArray(merged.selectionReasons) ? merged.selectionReasons : []),
      volumeProfile.relativeVolume ? `RVOL ${volumeProfile.relativeVolume.toFixed(1)}x from 20D avg volume` : null,
      volumeProfile.previousDayVolumeRatio ? `Volume ${volumeProfile.previousDayVolumeRatio.toFixed(1)}x vs previous day` : null,
      boosted > (num(merged.finalProbabilityScore) ?? 0) ? "Premarket surge volume boost" : null,
    ].filter(Boolean),
  };
}

module.exports = async function handler(req, res) {
  try {
    const upstreamUrl = new URL(UPSTREAM);
    const requestUrl = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    upstreamUrl.search = requestUrl.search;

    const response = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();

    if (payload?.data?.items && Array.isArray(payload.data.items)) {
      const rankedForVolume = [...payload.data.items]
        .sort((a, b) => {
          const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
          const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
          const aScore = num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0;
          const bScore = num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0;
          return bVolume - aVolume || bScore - aScore;
        })
        .slice(0, 120);
      const enrichSymbols = new Set(rankedForVolume.map((item) => item.symbol));
      const symbols = payload.data.items.map((item) => String(item?.symbol || "").toUpperCase()).filter(Boolean);
      const batchQuoteMap = await fetchBatchQuoteMap(symbols);
      const chartSymbols = symbols.filter((symbol) => enrichSymbols.has(symbol));
      const chartSnapshots = await mapWithLimit(chartSymbols, 4, async (symbol) => [symbol, await fetchChartSnapshot(symbol)]);
      const chartMap = new Map(chartSnapshots);

      payload.data.items = (await mapWithLimit(payload.data.items, 2, async (item) => {
        const normalizedItem = await normalizeItem(item, enrichSymbols.has(item.symbol));
        const symbolKey = String(item?.symbol || "").toUpperCase();
        const liveQuote = normalizeLiveQuote(
          normalizedItem,
          batchQuoteMap.get(symbolKey),
          chartMap.get(symbolKey),
        );

        return {
          ...normalizedItem,
          ...Object.fromEntries(Object.entries(liveQuote).filter(([, value]) => value !== null && value !== undefined)),
          sourceTags: [...new Set([
            ...(Array.isArray(normalizedItem.sourceTags) ? normalizedItem.sourceTags : []),
            batchQuoteMap.has(symbolKey) ? "yahoo-v7-batch" : null,
            chartMap.has(symbolKey) ? "yahoo-1m-live" : null,
          ].filter(Boolean))],
        };
      }))
        .sort((a, b) => (num(b.finalProbabilityScore) ?? 0) - (num(a.finalProbabilityScore) ?? 0));
    }

    res.setHeader("cache-control", "no-store");
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "scanner proxy failed",
    });
  }
};
