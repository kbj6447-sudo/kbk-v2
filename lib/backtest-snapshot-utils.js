function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return null;
  return Number((clean.reduce((sum, value) => sum + value, 0) / clean.length).toFixed(4));
}

function rate(items, predicate) {
  if (!items.length) return null;
  const hits = items.filter(predicate).length;
  return Number(((hits / items.length) * 100).toFixed(2));
}

function scoreBucket(score) {
  const value = num(score);
  if (value === null) return null;
  if (value >= 90) return "90+";
  if (value >= 80) return "80-89";
  if (value >= 70) return "70-79";
  if (value >= 60) return "60-69";
  return null;
}

function normalizeSnapshotItem(item = {}, snapshot = {}) {
  const score = num(
    item.score
      ?? item.finalScore
      ?? item.displayFinalScore
      ?? item.topPickFinalScore
      ?? item.finalProbabilityScore
      ?? item.scannerScore
  );
  const priceAtScan = num(
    item.priceAtScan
      ?? item.entryPrice
      ?? item.price
      ?? item.preMarketPrice
      ?? item.regularMarketPrice
  );
  const changePercentAtScan = num(
    item.changePercentAtScan
      ?? item.changePercent
      ?? item.preMarketChangePercent
  );
  const rvol = num(item.rvol ?? item.relativeVolume ?? item.volumeRatio);
  const vwapStatus = item.vwapStatus
    ?? item.vwapState
    ?? item.technical?.vwapState
    ?? (item.aboveVwap === true ? "above-vwap" : item.aboveVwap === false ? "below-vwap" : null);

  return {
    symbol: item.symbol,
    scanTime: item.scanTime ?? snapshot.capturedAt ?? snapshot.sourceUpdatedAt ?? null,
    category: item.category ?? item.stage ?? item.signalType ?? "top-picks",
    score,
    priceAtScan,
    changePercentAtScan,
    volume: num(item.volume ?? item.preMarketVolume ?? item.regularMarketVolume),
    rvol,
    vwapStatus,
    rsi: num(item.rsi ?? item.technical?.rsi),
    actionSignal: item.actionSignal ?? item.decision ?? item.verdict ?? item.topPickVerdict ?? null,
    decision: item.decision ?? item.verdict ?? item.topPickVerdict ?? null,
    panicOversoldSignal: item.panicOversoldSignal === true,
    panicOversoldScore: num(item.panicOversoldScore),
    panicOversoldLabel: item.panicOversoldLabel ?? null,
    panicOversoldReasons: Array.isArray(item.panicOversoldReasons) ? item.panicOversoldReasons : [],
    panicOversoldRiskFlags: Array.isArray(item.panicOversoldRiskFlags) ? item.panicOversoldRiskFlags : [],
    panicOversoldExcluded: item.panicOversoldExcluded === true,
    panicOversoldMode: item.panicOversoldMode ?? null,
    liveTradeState: item.liveTradeState ?? null,
    liveTradeLabel: item.liveTradeLabel ?? null,
    liveTradeConfidence: num(item.liveTradeConfidence),
    liveTradeReasons: Array.isArray(item.liveTradeReasons) ? item.liveTradeReasons : [],
    liveTradeWarnings: Array.isArray(item.liveTradeWarnings) ? item.liveTradeWarnings : [],
    liveTradeMode: item.liveTradeMode ?? null,
    source: item.source ?? snapshot.source ?? "top-picks-snapshot",
    rank: num(item.rank),
  };
}

function attachCurrentResult(item, currentPrice) {
  const priceNow = num(currentPrice ?? item.priceNow ?? item.exitPrice);
  const priceAtScan = num(item.priceAtScan);
  const fallbackReturn = num(item.returnNow ?? item.returnPct);
  const returnNow = priceNow !== null && priceAtScan !== null && priceAtScan > 0
    ? Number((((priceNow - priceAtScan) / priceAtScan) * 100).toFixed(4))
    : fallbackReturn;

  return {
    ...item,
    priceNow,
    returnNow,
    hitPlus5: returnNow !== null ? returnNow >= 5 : false,
    hitPlus10: returnNow !== null ? returnNow >= 10 : false,
    hitPlus20: returnNow !== null ? returnNow >= 20 : false,
    failedMinus5: returnNow !== null ? returnNow <= -5 : false,
    failedMinus10: returnNow !== null ? returnNow <= -10 : false,
    evaluated: returnNow !== null,
  };
}

function summarizeByScoreBand(items) {
  const bands = {
    "90+": [],
    "80-89": [],
    "70-79": [],
    "60-69": [],
  };

  for (const item of items) {
    const bucket = scoreBucket(item.score);
    if (bucket && bands[bucket]) bands[bucket].push(item);
  }

  return Object.entries(bands).map(([scoreRange, rows]) => {
    const evaluated = rows.filter((item) => item.evaluated);
    const enough = evaluated.length >= 5;
    return {
      scoreRange,
      sampleCount: evaluated.length,
      avgReturnNow: enough ? average(evaluated.map((item) => item.returnNow)) : null,
      hitRatePlus5: enough ? rate(evaluated, (item) => item.hitPlus5) : null,
      hitRatePlus10: enough ? rate(evaluated, (item) => item.hitPlus10) : null,
      failRateMinus10: enough ? rate(evaluated, (item) => item.failedMinus10) : null,
      dataStatus: enough ? "ok" : "데이터 부족",
    };
  });
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

module.exports = {
  num,
  average,
  rate,
  scoreBucket,
  normalizeSnapshotItem,
  attachCurrentResult,
  summarizeByScoreBand,
  mapWithLimit,
};
