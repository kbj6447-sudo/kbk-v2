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

function sum(values) {
  return values.map(num).filter((value) => value !== null && value > 0).reduce((total, value) => total + value, 0);
}

function positive(value) {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function volumeAccelerationScoreFromRatio(ratio) {
  const value = num(ratio);
  if (value === null) return 50;
  if (value >= 5) return 96;
  if (value >= 3) return 84;
  if (value >= 2) return 72;
  if (value >= 1.3) return 60;
  if (value >= 0.8) return 50;
  return 38;
}

function calculateVolumeAcceleration(bars) {
  const volumes = bars.map((bar) => positive(bar.volume));
  const current1mVolume = volumes.at(-1) ?? null;
  const previous5 = volumes.slice(-6, -1).filter((value) => value !== null);
  const last5 = volumes.slice(-5).filter((value) => value !== null);
  const previous30 = volumes.slice(-35, -5).filter((value) => value !== null);
  const averageVolumeLast5m = previous5.length >= 5 ? average(previous5) : null;
  const averageVolumeLast30m = previous30.length >= 20 ? sum(previous30) / 6 : null;
  const volumeLast5m = last5.length >= 5 ? sum(last5) : null;
  const volumeAcceleration1m = current1mVolume !== null && averageVolumeLast5m ? current1mVolume / averageVolumeLast5m : null;
  const volumeAcceleration5m = volumeLast5m !== null && averageVolumeLast30m ? volumeLast5m / averageVolumeLast30m : null;
  const availableScores = [volumeAcceleration1m, volumeAcceleration5m]
    .filter((value) => num(value) !== null)
    .map(volumeAccelerationScoreFromRatio);

  return {
    averageVolumeLast5m,
    averageVolumeLast30m,
    volumeAcceleration1m,
    volumeAcceleration5m,
    volumeAccelerationScore: availableScores.length ? Math.round(average(availableScores)) : 50,
    volumeAccelerationStatus: availableScores.length ? "ok" : "데이터 부족",
  };
}

function calculateHigherLowScore(bars) {
  const sample = bars.slice(-10)
    .map((bar) => ({
      low: positive(bar.low),
      close: positive(bar.close),
    }))
    .filter((bar) => bar.low !== null && bar.close !== null);
  if (sample.length < 5) return 50;

  let defendedPairs = 0;
  for (let index = 1; index < sample.length; index += 1) {
    if (sample[index].low >= sample[index - 1].low * 0.998) defendedPairs += 1;
  }

  let consecutiveHigherLows = 0;
  for (let index = sample.length - 1; index > 0; index -= 1) {
    if (sample[index].low >= sample[index - 1].low * 1.001) consecutiveHigherLows += 1;
    else break;
  }

  const recent = sample.slice(-4);
  const recentFloor = Math.min(...recent.slice(0, -1).map((bar) => bar.low));
  const last = sample.at(-1);
  const closeMaintainsStructure = last.close >= last.low * 1.002 && last.close >= recentFloor * 0.998;
  const trendDamaged = last.low < recentFloor * 0.992 || last.close < recentFloor * 0.995;
  const defendedRatio = defendedPairs / (sample.length - 1);

  let score = 35 + defendedRatio * 38 + Math.min(consecutiveHigherLows, 4) * 7;
  if (consecutiveHigherLows >= 3 && closeMaintainsStructure && !trendDamaged) score = Math.max(score, 90);
  else if (consecutiveHigherLows >= 2 && closeMaintainsStructure && !trendDamaged) score = Math.max(score, 74);
  else if (trendDamaged) score = Math.min(score - 22, 38);
  if (closeMaintainsStructure) score += 6;

  return Math.round(clamp(score));
}

function calculateVwapHold(bars) {
  const sample = bars.slice(-24);
  if (sample.length < 3) return { vwapHoldMinutes: null, vwapHoldScore: 50 };

  let pv = 0;
  let totalVolume = 0;
  const evaluated = [];
  for (const bar of bars) {
    const high = positive(bar.high);
    const low = positive(bar.low);
    const close = positive(bar.close);
    const volume = positive(bar.volume);
    if (high === null || low === null || close === null || volume === null) continue;
    pv += ((high + low + close) / 3) * volume;
    totalVolume += volume;
    if (!sample.includes(bar) || totalVolume <= 0) continue;
    const vwap = pv / totalVolume;
    evaluated.push({ close, vwap });
  }

  if (evaluated.length < 3) return { vwapHoldMinutes: null, vwapHoldScore: 50 };

  let vwapHoldMinutes = 0;
  for (let index = evaluated.length - 1; index >= 0; index -= 1) {
    if (evaluated[index].close >= evaluated[index].vwap) vwapHoldMinutes += 1;
    else break;
  }

  const holdRatio = evaluated.filter((bar) => bar.close >= bar.vwap).length / evaluated.length;
  const score = vwapHoldMinutes >= 10 ? 96
    : vwapHoldMinutes >= 5 ? 82
      : vwapHoldMinutes >= 3 ? 66
        : vwapHoldMinutes >= 1 ? 44
          : Math.max(22, holdRatio * 48);

  return {
    vwapHoldMinutes,
    vwapHoldScore: Math.round(clamp(score)),
  };
}

function calculateCompressionScore(bars) {
  const sample = bars.slice(-20);
  if (sample.length < 8) return 50;
  const highs = sample.map((bar) => positive(bar.high)).filter((value) => value !== null);
  const lows = sample.map((bar) => positive(bar.low)).filter((value) => value !== null);
  const lastClose = positive(sample.at(-1)?.close);
  if (!highs.length || !lows.length || lastClose === null) return 50;

  const rangePct = ((Math.max(...highs) - Math.min(...lows)) / lastClose) * 100;
  const base = rangePct <= 3 ? 90
    : rangePct <= 5 ? 78
      : rangePct <= 8 ? 64
        : rangePct <= 12 ? 52
          : 38;
  return Math.round(clamp(base + (calculateHigherLowScore(sample) - 50) * 0.12));
}

function calculateCommonSignals(bars) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return {
      volumeAcceleration1m: null,
      volumeAcceleration5m: null,
      volumeAccelerationScore: 50,
      higherLowScore: 50,
      vwapHoldMinutes: null,
      vwapHoldScore: 50,
      compressionScore: 50,
      commonSignalStatus: "데이터 부족",
    };
  }

  const volumeAcceleration = calculateVolumeAcceleration(bars);
  return {
    ...volumeAcceleration,
    higherLowScore: calculateHigherLowScore(bars),
    ...calculateVwapHold(bars),
    compressionScore: calculateCompressionScore(bars),
    commonSignalStatus: "ok",
  };
}

function commonSignalBoost(signals = {}) {
  const score =
    (num(signals.volumeAccelerationScore) ?? 50) * 0.30
    + (num(signals.higherLowScore) ?? 50) * 0.25
    + (num(signals.vwapHoldScore) ?? 50) * 0.25
    + (num(signals.compressionScore) ?? 50) * 0.20;
  return Math.round(clamp(Math.max(0, (score - 50) * 0.16), 0, 8));
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
    const opens = Array.isArray(quote.open) ? quote.open.map(num) : [];
    const highs = Array.isArray(quote.high) ? quote.high.map(num) : [];
    const lows = Array.isArray(quote.low) ? quote.low.map(num) : [];
    const rawVolumes = Array.isArray(quote.volume) ? quote.volume.map(num) : [];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const bars = timestamps.map((timestamp, index) => ({
      time: timestamp ? new Date(timestamp * 1000).toISOString() : null,
      open: positive(opens[index]) ?? positive(closes[index]),
      high: positive(highs[index]) ?? positive(closes[index]),
      low: positive(lows[index]) ?? positive(closes[index]),
      close: positive(closes[index]),
      volume: positive(rawVolumes[index]),
    })).filter((bar) => bar.close !== null).slice(-90);

    let latestClose = null;
    let latestTimestamp = null;
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      if (closes[i] !== null) {
        latestClose = closes[i];
        latestTimestamp = timestamps[i] ?? null;
        break;
      }
    }

    const volumes = rawVolumes.filter((value) => value !== null && value > 0);
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
      commonSignals: calculateCommonSignals(bars),
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
        const chartSnapshot = chartMap.get(symbolKey) || {};
        const liveQuote = normalizeLiveQuote(
          normalizedItem,
          batchQuoteMap.get(symbolKey),
          chartSnapshot,
        );
        const commonSignals = chartSnapshot.commonSignals || calculateCommonSignals([]);
        const rankAuxiliaryScore = commonSignalBoost(commonSignals);
        const baseScannerScore = num(normalizedItem.scannerScore) ?? 0;
        const baseFinalScore = num(normalizedItem.finalProbabilityScore) ?? 0;
        const boostedScannerScore = Math.round(clamp(baseScannerScore + rankAuxiliaryScore));
        const boostedFinalScore = Math.round(clamp(baseFinalScore + rankAuxiliaryScore));

        return {
          ...normalizedItem,
          ...Object.fromEntries(Object.entries(liveQuote).filter(([, value]) => value !== null && value !== undefined)),
          ...commonSignals,
          rankAuxiliaryScore,
          scannerScore: Math.max(baseScannerScore, boostedScannerScore),
          finalProbabilityScore: Math.max(baseFinalScore, boostedFinalScore),
          sourceTags: [...new Set([
            ...(Array.isArray(normalizedItem.sourceTags) ? normalizedItem.sourceTags : []),
            batchQuoteMap.has(symbolKey) ? "yahoo-v7-batch" : null,
            chartMap.has(symbolKey) ? "yahoo-1m-live" : null,
            rankAuxiliaryScore > 0 ? "common-signal-rank-boost" : null,
          ].filter(Boolean))],
          selectionReasons: [
            ...(Array.isArray(normalizedItem.selectionReasons) ? normalizedItem.selectionReasons : []),
            rankAuxiliaryScore > 0 ? `Common signal boost +${rankAuxiliaryScore}` : null,
          ].filter(Boolean),
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
