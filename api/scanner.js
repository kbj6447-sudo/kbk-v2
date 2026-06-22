const quoteHandler = require("./quote");
const historyHandler = require("./history");
const {
  ensureStore: ensureSnapshotStore,
  saveSnapshot: saveCandidateSnapshot,
  toSafeSnapshotId,
  cleanupDedupe: cleanupSnapshotDedupe,
  hasRecentDedupe: hasRecentSnapshotDedupe,
  markDedupe: markSnapshotDedupe,
} = require("../lib/top-picks-snapshot-store");
const ENRICH_SYMBOL_LIMIT = 30;
const PRE_MOVE_CANDIDATE_LIMIT = 30;
const SCANNER_SUCCESS_TTL_MS = 120 * 1000;
const SCANNER_FAILURE_TTL_MS = 30 * 1000;
const SCANNER_ITEM_LIMIT = 120;
const SCANNER_SHORT_TERM_LIMIT = 30;
const SCANNER_UNDER_ONE_LIMIT = 30;
const SCANNER_OVER_ONE_LIMIT = 30;
const SCANNER_ACCUMULATION_LIMIT = 30;
const SCANNER_PRE_MOVE_LIMIT = 30;
const SCANNER_TOP_PICKS_LIMIT = 20;
const SCANNER_REBOUND_WATCH_LIMIT = 30;
const SCANNER_TRADE_BLOCK_LIMIT = 20;
const SCANNER_REENTRY_WATCH_LIMIT = 30;
const SCANNER_SNAPSHOT_CATEGORY_LIMIT = 25;
const SCANNER_SNAPSHOT_DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const scannerSuccessCacheByMode = {
  default: null,
  debug: null,
};
const scannerFailureCacheByMode = {
  default: null,
  debug: null,
};
const scannerInFlightPromiseByMode = {
  default: null,
  debug: null,
};

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

function scannerSnapshotScore(item) {
  return num(item?.finalSelectionScore)
    ?? num(item?.topPickDisplayFinalScore)
    ?? num(item?.topPickFinalScore)
    ?? num(item?.finalProbabilityScore)
    ?? num(item?.scannerScore)
    ?? 0;
}

function toScannerCandidateLogItem(item, timestamp, rank) {
  const entryPrice = num(item?.price ?? item?.preMarketPrice ?? item?.regularMarketPrice);
  const stopLossPrice = num(item?.stopLossPrice ?? item?.atrStopPrice) ?? (entryPrice !== null ? Number((entryPrice * 0.97).toFixed(4)) : null);
  const takeProfitPrice = num(item?.takeProfitPrice ?? item?.targetPrice) ?? (entryPrice !== null ? Number((entryPrice * 1.05).toFixed(4)) : null);
  return {
    rank,
    timestamp,
    scanTime: timestamp,
    symbol: item?.symbol,
    ticker: item?.symbol,
    category: item?.selectionGroup ?? item?.stage ?? "top-picks",
    score: scannerSnapshotScore(item),
    finalSelectionScore: num(item?.finalSelectionScore),
    entryPrice,
    stopLossPrice,
    takeProfitPrice,
    price: entryPrice,
    priceAtScan: entryPrice,
    changePercent: num(item?.changePercent ?? item?.preMarketChangePercent),
    changePercentAtScan: num(item?.changePercent ?? item?.preMarketChangePercent),
    volume: num(item?.volume ?? item?.preMarketVolume ?? item?.regularMarketVolume),
    tradeValueKrw: num(item?.tradeValueKrw),
    relativeVolume: num(item?.rvol ?? item?.relativeVolume ?? item?.volumeRatio),
    vwapState: item?.technical?.vwapState ?? item?.vwapState ?? null,
    scannerMode: item?.scannerMode?.mode ?? null,
    signalState: item?.signalLifecycle?.status ?? item?.statusBadge ?? item?.selectionGroup ?? null,
    dataQuality: item?.dataQuality?.reliabilityKo ?? item?.dataQualityStatus ?? "미확인",
    riskFlags: Array.isArray(item?.riskFlags) ? item.riskFlags : [],
    tracking: {
      windows: {
        m5: { minutes: 5, targetTime: addMinutes(timestamp, 5), status: "pending", price: null, returnPct: null, firstBarrierHit: null, reachedStopLoss: false, reachedTakeProfit: false },
        m10: { minutes: 10, targetTime: addMinutes(timestamp, 10), status: "pending", price: null, returnPct: null, firstBarrierHit: null, reachedStopLoss: false, reachedTakeProfit: false },
        m30: { minutes: 30, targetTime: addMinutes(timestamp, 30), status: "pending", price: null, returnPct: null, firstBarrierHit: null, reachedStopLoss: false, reachedTakeProfit: false },
        m60: { minutes: 60, targetTime: addMinutes(timestamp, 60), status: "pending", price: null, returnPct: null, firstBarrierHit: null, reachedStopLoss: false, reachedTakeProfit: false },
      },
      eod: { targetTime: addMinutes(timestamp, 360), status: "pending", price: null, returnPct: null, firstBarrierHit: null, reachedStopLoss: false, reachedTakeProfit: false },
      final: { status: "pending", selectedCheckpoint: null, returnPct: null, result: "데이터 부족", dataQuality: "데이터 부족" },
    },
  };
}

async function captureScannerCandidateSnapshot(payload = {}) {
  try {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) return;
    await ensureSnapshotStore();
    cleanupSnapshotDedupe(Date.now(), SCANNER_SNAPSHOT_DEDUPE_WINDOW_MS);
    const grouped = new Map();
    for (const item of items) {
      if (!item?.symbol) continue;
      const category = String(item?.selectionGroup ?? item?.stage ?? "top-picks");
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(item);
    }
    const selected = [];
    for (const categoryItems of grouped.values()) {
      selected.push(...categoryItems
        .slice()
        .sort((a, b) => scannerSnapshotScore(b) - scannerSnapshotScore(a))
        .slice(0, SCANNER_SNAPSHOT_CATEGORY_LIMIT));
    }
    const deduped = selected.filter((item) => {
      const key = `${String(item.symbol || "").toUpperCase()}:${String(item.selectionGroup ?? item.stage ?? "top-picks")}:${Math.floor(Date.now() / SCANNER_SNAPSHOT_DEDUPE_WINDOW_MS)}`;
      if (hasRecentSnapshotDedupe(key, Date.now(), SCANNER_SNAPSHOT_DEDUPE_WINDOW_MS)) return false;
      markSnapshotDedupe(key, Date.now());
      return true;
    });
    if (!deduped.length) return;
    const capturedAt = new Date().toISOString();
    const snapshotId = toSafeSnapshotId(`auto-${payload.updatedAt || capturedAt}`);
    await saveCandidateSnapshot({
      snapshotId,
      capturedAt,
      sourceUpdatedAt: payload.updatedAt || null,
      source: payload.source || "scanner",
      status: "pending",
      resolveAfter: addMinutes(capturedAt, 5),
      notes: ["auto-captured from /api/scanner"],
      items: deduped.map((item, index) => toScannerCandidateLogItem(item, capturedAt, index + 1)),
    });
  } catch (error) {
    console.log("[SCANNER] auto snapshot skipped", error instanceof Error ? error.message : String(error));
  }
}

function sanitizeScannerReasonList(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((reason) => String(reason ?? "").trim())
    .filter(Boolean)
    .map((reason) => (reason.length > 120 ? reason.slice(0, 120) : reason))
    .slice(0, 3);
}

function firstNumericField(item, fields) {
  for (const { key, source } of fields) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    const value = num(item[key]);
    if (value !== null) return { value, source: source || key };
  }
  return { value: null, source: null };
}

function deriveRangeAuditFields(item) {
  if (!item || typeof item !== "object") {
    return {
      highDropPercent: null,
      highDropSource: null,
      closePositionInRange: null,
      closePositionSource: null,
      vwapEstimate: null,
      vwapSource: null,
    };
  }

  const price = num(item.price);
  const high = firstNumericField(item, [
    { key: "regularMarketDayHigh", source: "regularMarketDayHigh" },
    { key: "dayHigh", source: "intradayHigh" },
    { key: "intradayHigh", source: "intradayHigh" },
    { key: "preMarketHigh", source: "preMarketHigh" },
    { key: "postMarketHigh", source: "postMarketHigh" },
    { key: "price", source: "fallback" },
  ]);
  const low = firstNumericField(item, [
    { key: "regularMarketDayLow", source: "regularMarketDayLow" },
    { key: "dayLow", source: "intradayLow" },
    { key: "intradayLow", source: "intradayLow" },
    { key: "preMarketLow", source: "preMarketLow" },
    { key: "postMarketLow", source: "postMarketLow" },
    { key: "price", source: "fallback" },
  ]);
  const highDropPercent = high.value !== null && high.value > 0 && price !== null
    ? Math.max(0, ((high.value - price) / high.value) * 100)
    : null;
  const closePositionInRange = high.value !== null && low.value !== null && price !== null && high.value > low.value
    ? ((price - low.value) / (high.value - low.value)) * 100
    : null;
  const vwapEstimate = high.value !== null && low.value !== null && price !== null && high.value > 0 && low.value > 0 && price > 0
    ? (high.value + low.value + price) / 3
    : null;

  return {
    highDropPercent,
    highDropSource: highDropPercent !== null ? high.source : null,
    closePositionInRange,
    closePositionSource: closePositionInRange !== null ? `${low.source}-${high.source}` : null,
    vwapEstimate,
    vwapSource: vwapEstimate !== null ? "hlc-estimate" : null,
  };
}

const FIELD_QUICK_AUDIT_CONFIG = [
  {
    key: "sessionMovePercent",
    fields: ["sessionMovePercent", "changePercent", "preMarketChangePercent", "regularMarketChangePercent", "postMarketChangePercent"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_with_fallback",
  },
  {
    key: "closePositionInRange",
    fields: ["closePositionInRange"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_with_fallback",
  },
  {
    key: "volumeAcceleration",
    fields: ["volumeAcceleration", "volumeAcceleration1m", "volumeAcceleration5m", "volumeAccelerationScore"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "higherLowScore",
    fields: ["higherLowScore"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "highDropPercent",
    fields: ["highDropPercent"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_with_fallback",
  },
  {
    key: "vwap",
    fields: ["vwap"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "aboveVwap",
    fields: ["aboveVwap"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "vwapDistancePercent",
    fields: ["vwapDistancePercent"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "tradeValueKrw",
    fields: ["tradeValueKrw"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_now",
  },
  {
    key: "relativeVolume",
    fields: ["relativeVolume", "rvol", "volumeRatio"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_now",
  },
  {
    key: "changePercent",
    fields: ["changePercent", "preMarketChangePercent", "regularMarketChangePercent", "postMarketChangePercent"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_now",
  },
  {
    key: "regularMarketDayHigh",
    fields: ["regularMarketDayHigh"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "regularMarketDayLow",
    fields: ["regularMarketDayLow"],
    canCalculateWithoutExtraCall: false,
    requiresExtraApiCall: true,
    conclusion: "top20_or_detail_only",
  },
  {
    key: "price",
    fields: ["price"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_now",
  },
  {
    key: "marketState",
    fields: ["marketState"],
    canCalculateWithoutExtraCall: true,
    requiresExtraApiCall: false,
    conclusion: "use_now",
  },
];

function fieldValueState(item, fields) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) continue;
    return item[field] === null || item[field] === undefined ? "null" : "exists";
  }
  return "missing";
}

function buildFieldQuickAudit(items = []) {
  const total = Array.isArray(items) ? items.length : 0;
  const audit = {};
  for (const config of FIELD_QUICK_AUDIT_CONFIG) {
    let existsCount = 0;
    let nullCount = 0;
    let missingCount = 0;
    for (const item of items) {
      const state = fieldValueState(item || {}, config.fields);
      if (state === "exists") existsCount += 1;
      else if (state === "null") nullCount += 1;
      else missingCount += 1;
    }
    const usableRatio = total > 0 ? Number((existsCount / total).toFixed(3)) : 0;
    audit[config.key] = {
      existsCount,
      nullCount,
      missingCount,
      usableRatio,
      canCalculateWithoutExtraCall: config.canCalculateWithoutExtraCall,
      requiresExtraApiCall: config.requiresExtraApiCall,
      quickConclusion: config.conclusion,
    };
  }
  return audit;
}

function buildQuickAuditSummary(fieldQuickAudit, totalCandidates) {
  const entries = Object.entries(fieldQuickAudit || {});
  return {
    totalCandidates,
    fieldsUsableNow: entries.filter(([, value]) => value.quickConclusion === "use_now").map(([key]) => key),
    fieldsNeedFallback: entries.filter(([, value]) => value.quickConclusion === "use_with_fallback").map(([key]) => key),
    fieldsNeedExtraApiCall: entries.filter(([, value]) => value.quickConclusion === "top20_or_detail_only").map(([key]) => key),
    fieldsUnavailable: entries.filter(([, value]) => value.quickConclusion === "unavailable").map(([key]) => key),
    recommendedNextStep: "Use only no-extra-call and fallback-safe fields for experimental score v1. VWAP and volumeAcceleration require extra API calls, so use them only for top20/detail in later phases.",
  };
}

function attachQuickAudit(payload) {
  if (!payload?.data || typeof payload.data !== "object") return payload;
  const items = Array.isArray(payload.data.items) ? payload.data.items : [];
  const fieldQuickAudit = buildFieldQuickAudit(items);
  payload.data.fieldQuickAudit = fieldQuickAudit;
  payload.data.quickAuditSummary = buildQuickAuditSummary(fieldQuickAudit, items.length);
  return payload;
}

function experimentalChangeScore(changePercent) {
  const change = num(changePercent);
  if (change === null) return { score: 10, label: "change missing: neutral fallback" };
  if (change >= -3 && change < 3) return { score: 22, label: "quiet session move" };
  if (change >= 3 && change <= 8) return { score: 30, label: "early positive session move" };
  if (change > 8 && change <= 15) return { score: 24, label: "extended but still usable move" };
  if (change > 15 && change <= 25) return { score: 14, label: "chase risk from session move" };
  if (change > 25) return { score: 6, label: "overextended session move" };
  if (change >= -8) return { score: 12, label: "mild pullback" };
  return { score: 4, label: "deep negative session move" };
}

function experimentalRelativeVolumeScore(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null) return { score: 0, label: "relative volume missing: low confidence" };
  if (rvol < 0.5) return { score: 0, label: "very low relative volume" };
  if (rvol < 1) return { score: 3, label: "below-normal relative volume" };
  if (rvol < 2) return { score: 12, label: "baseline relative volume" };
  if (rvol < 3) return { score: 18, label: "moderate volume expansion" };
  if (rvol < 5) return { score: 24, label: "strong volume expansion" };
  return { score: 30, label: "very strong volume expansion" };
}

function experimentalTradeValueScore(tradeValueKrw, relativeVolume) {
  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  if (tradeValue === null) return { score: 0, label: "trade value missing: low confidence" };
  let score = 4;
  let label = "thin trade value";
  if (tradeValue >= 1_000_000_000) {
    score = 25;
    label = "very liquid trade value";
  } else if (tradeValue >= 300_000_000) {
    score = 22;
    label = "liquid trade value";
  } else if (tradeValue >= 100_000_000) {
    score = 16;
    label = "usable trade value";
  } else if (tradeValue >= 30_000_000) {
    score = 10;
    label = "light trade value";
  }
  if (rvol !== null && rvol < 0.5 && score > 8) {
    return { score: 8, label: `${label}; capped by very low RVOL` };
  }
  if (rvol !== null && rvol < 1 && score > 12) {
    return { score: 12, label: `${label}; capped by low RVOL` };
  }
  return { score, label };
}

function experimentalPriceScore(price) {
  const value = num(price);
  if (value === null || value <= 0) return { score: 2, label: "price missing" };
  if (value >= 0.5 && value <= 20) return { score: 10, label: "scanner-friendly price band" };
  if (value > 20 && value <= 80) return { score: 8, label: "mid price band" };
  if (value >= 0.1 && value < 0.5) return { score: 6, label: "sub-dollar price band" };
  if (value > 80 && value <= 300) return { score: 5, label: "high price band" };
  return { score: 3, label: "very high or ultra-low price band" };
}

function experimentalMarketStateScore(marketState) {
  const state = String(marketState || "").toUpperCase();
  if (state === "REGULAR") return { score: 4, label: "regular session state" };
  if (state === "PRE" || state === "PREPRE" || state === "POST" || state === "POSTPOST" || state === "DAY") {
    return { score: 3, label: "extended or day session state" };
  }
  return { score: state ? 2 : 0, label: "unknown or inactive market state" };
}

function experimentalOverextensionPenalty(changePercent) {
  const change = num(changePercent);
  if (change === null) return { penalty: 0, label: null };
  if (change >= 70) return { penalty: 30, label: "Overextended: changePercent >= 70%, already surged risk" };
  if (change >= 50) return { penalty: 20, label: "Overextended: changePercent >= 50%, already surged risk" };
  if (change >= 30) return { penalty: 10, label: "Overextended: changePercent >= 30%, already surged risk" };
  return { penalty: 0, label: null };
}

function experimentalExtremeRvolPenalty(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null) return { penalty: 0, label: null };
  if (rvol >= 1000) return { penalty: 5, label: "Abnormal RVOL: verify liquidity/source" };
  if (rvol >= 100) return { penalty: 5, label: "Extreme RVOL: baseline may be too low" };
  return { penalty: 0, label: null };
}

function experimentalLowLiquidityPenalty(tradeValueKrw, marketState) {
  const tradeValue = num(tradeValueKrw);
  if (tradeValue === null) return { penalty: 0, label: null };
  const state = String(marketState || "").toUpperCase();
  const isRegular = state === "REGULAR" || state === "";
  const multiplier = isRegular ? 1 : 0.5;
  if (tradeValue < 50_000_000) {
    return { penalty: Math.round(15 * multiplier), label: "Low liquidity: tradeValueKrw < 50,000,000" };
  }
  if (tradeValue < 100_000_000) {
    return { penalty: Math.round(8 * multiplier), label: "Low liquidity: tradeValueKrw < 100,000,000" };
  }
  if (tradeValue < 300_000_000) {
    return { penalty: Math.round(4 * multiplier), label: "Low liquidity: tradeValueKrw < 300,000,000" };
  }
  return { penalty: 0, label: null };
}

function experimentalStructurePenalty(symbol, tradeValueKrw, changePercent) {
  const value = String(symbol || "").toUpperCase();
  if (!value) return { penalty: 0, labels: [] };
  if (value.endsWith("U") || value.endsWith("W") || value.endsWith("R") || value.includes("WS")) {
    const tradeValue = num(tradeValueKrw);
    const change = num(changePercent);
    const isLowLiquidity = tradeValue !== null && tradeValue < 100_000_000;
    const isZeroChange = change !== null && change === 0;
    let penalty = 8;
    const labels = ["Structure risk: possible unit/warrant/right ticker"];
    if (isLowLiquidity) {
      penalty += 10;
      labels.push("Structure + low liquidity: not suitable for top scanner rank");
    }
    if (isZeroChange) {
      penalty += 8;
      labels.push("Structure + zero change: likely inactive/unit-style move");
    }
    if (isLowLiquidity && isZeroChange) {
      penalty += 10;
      labels.push("Structure + low liquidity + zero change: high scanner-rank risk");
    }
    return { penalty, labels };
  }
  return { penalty: 0, labels: [] };
}

function experimentalRvolScoreCap(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null || rvol < 0.5) {
    return { maxScore: 45, label: "RVOL cap: low relative volume limits rank confidence" };
  }
  if (rvol < 1) {
    return { maxScore: 49, label: "RVOL cap: low relative volume limits rank confidence" };
  }
  return { maxScore: null, label: null };
}

function buildExperimentalScore(item) {
  const rvol = num(item?.relativeVolume);
  const tradeValueRaw = num(item?.tradeValueKrw);
  const change = experimentalChangeScore(item?.changePercent);
  const relativeVolume = experimentalRelativeVolumeScore(rvol);
  const tradeValue = experimentalTradeValueScore(tradeValueRaw, rvol);
  const price = experimentalPriceScore(item?.price);
  const marketState = experimentalMarketStateScore(item?.marketState);
  const overextensionPenalty = experimentalOverextensionPenalty(item?.changePercent);
  const extremeRvolPenalty = experimentalExtremeRvolPenalty(rvol);
  const lowLiquidityPenalty = experimentalLowLiquidityPenalty(tradeValueRaw, item?.marketState);
  const structurePenalty = experimentalStructurePenalty(item?.symbol, tradeValueRaw, item?.changePercent);
  const rvolScoreCap = experimentalRvolScoreCap(rvol);
  const totalPenalty = overextensionPenalty.penalty
    + extremeRvolPenalty.penalty
    + lowLiquidityPenalty.penalty
    + structurePenalty.penalty;
  const rawExperimentalScore = Math.round(clamp(
    change.score
    + relativeVolume.score
    + tradeValue.score
    + price.score
    + marketState.score
    - totalPenalty,
  ));
  const experimentalFinalSelectionScore = rvolScoreCap.maxScore !== null
    ? Math.min(rawExperimentalScore, rvolScoreCap.maxScore)
    : rawExperimentalScore;
  const experimentalRankScore = experimentalFinalSelectionScore;
  const experimentalScoreBreakdown = {
    changePercent: change.score,
    relativeVolume: relativeVolume.score,
    tradeValueKrw: tradeValue.score,
    price: price.score,
    marketState: marketState.score,
    overextensionPenalty: -overextensionPenalty.penalty,
    extremeRvolPenalty: -extremeRvolPenalty.penalty,
    lowLiquidityPenalty: -lowLiquidityPenalty.penalty,
    structurePenalty: -structurePenalty.penalty,
    totalPenalty: -totalPenalty,
    rawTotal: rawExperimentalScore,
    rvolScoreCap: rvolScoreCap.maxScore,
    total: experimentalFinalSelectionScore,
    excludedFields: [
      "vwap",
      "aboveVwap",
      "vwapDistancePercent",
      "volumeAcceleration",
      "higherLowScore",
      "highDropPercent",
      "closePositionInRange",
    ],
  };
  const experimentalReasons = [
    change.label,
    relativeVolume.label,
    rvol !== null && rvol < 1 ? "Low RVOL: below normal volume, not a true volume surge" : null,
    rvol !== null && rvol >= 3 ? "Strong RVOL: volume expansion candidate" : null,
    overextensionPenalty.label,
    extremeRvolPenalty.label,
    rvolScoreCap.label,
    tradeValue.label,
    lowLiquidityPenalty.label,
    ...structurePenalty.labels,
    price.label,
    marketState.label,
    "diagnostic only: not used for sorting",
  ].filter(Boolean);
  return {
    experimentalFinalSelectionScore,
    experimentalRankScore,
    experimentalScoreBreakdown,
    experimentalReasons,
  };
}

function underOneChangeScore(changePercent) {
  const change = num(changePercent);
  if (change === null || change < 0) return { score: 0, label: null };
  if (change < 3) return { score: 18, label: "Under-one early move candidate" };
  if (change < 8) return { score: 30, label: "Under-one early move candidate" };
  if (change < 12) return { score: 26, label: "Under-one early move candidate" };
  if (change < 20) return { score: 18, label: "Under-one early move candidate" };
  if (change < 30) return { score: 10, label: "Under-one early move candidate" };
  return { score: 0, label: "Overextended: changePercent >= 30" };
}

function underOneRvolScore(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null || rvol < 0.1) return { score: 0, label: "Low RVOL: under-one volume not expanding" };
  if (rvol < 0.5) return { score: 6, label: "Low RVOL: under-one volume not expanding" };
  if (rvol < 1) return { score: 12, label: null };
  if (rvol < 3) return { score: 16, label: null };
  if (rvol < 5) return { score: 18, label: null };
  return { score: 20, label: null };
}

function underOneTradeValueScore(tradeValueKrw) {
  const tradeValue = num(tradeValueKrw);
  if (tradeValue === null || tradeValue < 10_000_000) return { score: 0, label: "Low liquidity: tradeValueKrw below threshold" };
  if (tradeValue < 50_000_000) return { score: 5, label: "Low liquidity: tradeValueKrw below threshold" };
  if (tradeValue < 100_000_000) return { score: 10, label: "Low liquidity: tradeValueKrw below threshold" };
  if (tradeValue < 500_000_000) return { score: 18, label: null };
  if (tradeValue < 1_000_000_000) return { score: 22, label: null };
  return { score: 25, label: null };
}

function underOnePriceBandScore(price) {
  const value = num(price);
  if (value === null || value < 0.01) return { score: 0, label: "Extreme penny risk: price below 0.05" };
  if (value < 0.05) return { score: 3, label: "Extreme penny risk: price below 0.05" };
  if (value < 0.1) return { score: 8, label: null };
  if (value < 1) return { score: 15, label: null };
  return { score: 0, label: null };
}

function isUnderOneStructureRiskSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  if (!value) return false;
  return value.endsWith("OW")
    || value.endsWith("AW")
    || value.endsWith("CW")
    || value.endsWith("PR")
    || value.endsWith("W")
    || value.endsWith("R")
    || value.endsWith("Z")
    || value.includes("WW")
    || value.includes("WS");
}

function isUnderOneHighConfidenceStructureSymbol(symbol) {
  const value = String(symbol || "").toUpperCase();
  if (!value) return false;
  return value.endsWith("OW")
    || value.endsWith("AW")
    || value.endsWith("CW")
    || value.endsWith("PR")
    || value.includes("WW")
    || value.includes("WS");
}

function underOneStructurePenalty(symbol, tradeValueKrw, relativeVolume, changePercent) {
  if (!isUnderOneStructureRiskSymbol(symbol)) return { penalty: 0, labels: [] };

  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  const change = num(changePercent);
  let penalty = 20;
  const labels = ["Structure risk: possible warrant/right/unit ticker"];
  if (tradeValue !== null && tradeValue < 100_000_000) penalty += 10;
  if (rvol === null || rvol < 0.1) penalty += 10;
  if (change !== null && change === 0) penalty += 10;
  return { penalty: Math.min(penalty, 35), labels };
}

function underOneScoreCap({ symbol, tradeValueKrw, relativeVolume, price }) {
  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  const priceValue = num(price);
  const labels = [];
  let cap = 100;

  if (isUnderOneStructureRiskSymbol(symbol)) {
    cap = Math.min(cap, 15);
    labels.push("Score capped: structure risk");
    if (isUnderOneHighConfidenceStructureSymbol(symbol)) {
      cap = Math.min(cap, 7);
      labels.push("Score capped: low liquidity structure ticker");
    }
    if (tradeValue !== null && tradeValue < 50_000_000) {
      cap = Math.min(cap, 7);
      labels.push("Score capped: low liquidity structure ticker");
    }
    if (rvol === null || rvol < 0.1) {
      cap = Math.min(cap, 5);
      labels.push("Score capped: low liquidity structure ticker");
    }
    if (priceValue !== null && priceValue < 0.05) {
      cap = Math.min(cap, 3);
      labels.push("Score capped: extreme penny risk");
    }
  }

  if (priceValue !== null && priceValue < 0.01) {
    cap = Math.min(cap, 2);
    labels.push("Score capped: extreme penny risk");
  }
  if (tradeValue !== null && tradeValue < 1_000_000) {
    cap = Math.min(cap, 5);
    labels.push("Score capped: low liquidity structure ticker");
  }
  if (rvol === null && tradeValue !== null && tradeValue < 50_000_000) {
    cap = Math.min(cap, 5);
    labels.push("Score capped: low liquidity structure ticker");
  }

  return {
    cap,
    labels: [...new Set(labels)],
  };
}

function underOneQualityBucket({ symbol, underOneOperationalRankScore, tradeValueKrw, relativeVolume, price }) {
  const score = num(underOneOperationalRankScore) ?? 0;
  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  const priceValue = num(price);
  const structureRisk = isUnderOneStructureRiskSymbol(symbol);

  if (structureRisk
    || score < 15
    || (tradeValue !== null && tradeValue < 50_000_000)
    || rvol === null
    || rvol < 0.1
    || (priceValue !== null && priceValue < 0.05)) {
    return {
      bucket: 2,
      label: "Under-one quality bucket: structure fallback",
    };
  }

  if (!structureRisk
    && score >= 40
    && tradeValue !== null
    && tradeValue >= 100_000_000
    && rvol >= 0.1
    && (priceValue === null || priceValue >= 0.05)) {
    return {
      bucket: 0,
      label: "Under-one quality bucket: primary",
    };
  }

  return {
    bucket: 1,
    label: "Under-one quality bucket: weak",
  };
}

function shortTermRvolScore(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null || rvol < 1) return { score: 0, label: null };
  if (rvol < 2) return { score: 8, label: null };
  if (rvol < 3) return { score: 14, label: "Short-term volume expansion" };
  if (rvol < 5) return { score: 22, label: "Short-term volume expansion" };
  if (rvol < 10) return { score: 27, label: "Short-term volume expansion" };
  return { score: 30, label: "Short-term volume expansion" };
}

function shortTermChangeScore(changePercent) {
  const change = num(changePercent);
  if (change === null || change < 0) return { score: 0, label: null };
  if (change < 1) return { score: 6, label: null };
  if (change < 3) return { score: 14, label: "Good short-term change range" };
  if (change < 8) return { score: 25, label: "Good short-term change range" };
  if (change < 15) return { score: 20, label: "Good short-term change range" };
  if (change < 25) return { score: 12, label: null };
  if (change < 50) return { score: 5, label: "Overextended for scalp" };
  return { score: 0, label: "Overextended for scalp" };
}

function shortTermTradeValueScore(tradeValueKrw) {
  const tradeValue = num(tradeValueKrw);
  if (tradeValue === null) return { score: 5, label: null };
  if (tradeValue < 10_000_000) return { score: 0, label: "Low trade value for scalp" };
  if (tradeValue < 50_000_000) return { score: 4, label: "Low trade value for scalp" };
  if (tradeValue < 100_000_000) return { score: 8, label: null };
  if (tradeValue < 500_000_000) return { score: 14, label: null };
  if (tradeValue < 1_000_000_000) return { score: 17, label: null };
  return { score: 20, label: null };
}

function shortTermPriceBandScore(price) {
  const value = num(price);
  if (value === null) return { score: 0, label: null };
  if (value < 0.5) return { score: 2, label: null };
  if (value < 1) return { score: 6, label: null };
  if (value < 5) return { score: 10, label: null };
  if (value < 20) return { score: 8, label: null };
  if (value < 100) return { score: 5, label: null };
  return { score: 2, label: null };
}

function shortTermBaseQualityScore(item) {
  const operational = num(item?.operationalRankScore);
  if (operational !== null) {
    if (operational >= 70) return 10;
    if (operational >= 50) return 7;
    if (operational >= 30) return 4;
    return 0;
  }
  const finalScore = num(item?.finalSelectionScore) ?? num(item?.marketPrioritySortScore);
  if (finalScore === null) return 0;
  if (finalScore >= 70) return 10;
  if (finalScore >= 50) return 7;
  if (finalScore >= 30) return 4;
  return 0;
}

function shortTermRiskPenalty({ price, changePercent, relativeVolume, tradeValueKrw }) {
  const priceValue = num(price);
  const change = num(changePercent);
  const rvol = num(relativeVolume);
  const tradeValue = num(tradeValueKrw);
  let penalty = 0;
  const labels = [];

  if (change !== null && change >= 50) {
    penalty += 20;
    labels.push("Overextended for scalp");
  } else if (change !== null && change >= 25) {
    penalty += 8;
    labels.push("Overextended for scalp");
  }
  if (rvol === null) penalty += 8;
  else if (rvol < 1) penalty += 10;
  if (tradeValue === null) penalty += 5;
  else if (tradeValue < 50_000_000) {
    penalty += 8;
    labels.push("Low trade value for scalp");
  }
  if (rvol !== null && rvol >= 3 && (tradeValue === null || tradeValue < 50_000_000)) {
    labels.push("High RVOL but low liquidity");
  }
  if (priceValue !== null && priceValue < 0.5) penalty += 8;
  if (priceValue !== null && priceValue >= 100) penalty += 5;

  return {
    penalty: Math.min(penalty, 35),
    labels,
  };
}

function shortTermStructurePenalty({ symbol, tradeValueKrw, relativeVolume }) {
  if (!isUnderOneStructureRiskSymbol(symbol)) return { penalty: 0, labels: [] };
  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  let penalty = 15;
  const labels = ["Structure risk for scalp"];
  if (tradeValue === null || tradeValue < 100_000_000) penalty += 10;
  if (rvol === null) penalty += 10;
  return {
    penalty: Math.min(penalty, 25),
    labels,
  };
}

function shortTermQualityBucket({ symbol, shortTermOperationalRankScore, relativeVolume, changePercent, tradeValueKrw }) {
  const score = num(shortTermOperationalRankScore) ?? 0;
  const rvol = num(relativeVolume);
  const change = num(changePercent);
  const tradeValue = num(tradeValueKrw);
  const structureRisk = isUnderOneStructureRiskSymbol(symbol);

  if (structureRisk || score < 25 || rvol === null || (tradeValue !== null && tradeValue < 10_000_000)) {
    return { bucket: 3, label: "Short-term quality bucket: fallback" };
  }
  if (!structureRisk && score >= 65 && rvol >= 3 && change !== null && change >= 1 && change <= 15 && tradeValue !== null && tradeValue >= 100_000_000) {
    return { bucket: 0, label: "Short-term quality bucket: primary" };
  }
  if (!structureRisk && score >= 45 && rvol >= 2 && change !== null && change >= 0 && change <= 20) {
    return { bucket: 1, label: "Short-term quality bucket: usable" };
  }
  if (!structureRisk && score >= 25 && rvol >= 1) {
    return { bucket: 2, label: "Short-term quality bucket: weak" };
  }
  return { bucket: 3, label: "Short-term quality bucket: fallback" };
}

function buildShortTermOperationalScore(item) {
  const rvol = shortTermRvolScore(item?.relativeVolume ?? item?.volumeRatio ?? item?.rvol);
  const change = shortTermChangeScore(item?.changePercent ?? item?.preMarketChangePercent);
  const tradeValue = shortTermTradeValueScore(item?.tradeValueKrw);
  const price = shortTermPriceBandScore(item?.price ?? item?.preMarketPrice ?? item?.regularMarketPrice);
  const baseQualityScore = shortTermBaseQualityScore(item);
  const riskPenalty = shortTermRiskPenalty({
    price: item?.price ?? item?.preMarketPrice ?? item?.regularMarketPrice,
    changePercent: item?.changePercent ?? item?.preMarketChangePercent,
    relativeVolume: item?.relativeVolume ?? item?.volumeRatio ?? item?.rvol,
    tradeValueKrw: item?.tradeValueKrw,
  });
  const structurePenalty = shortTermStructurePenalty({
    symbol: item?.symbol,
    tradeValueKrw: item?.tradeValueKrw,
    relativeVolume: item?.relativeVolume ?? item?.volumeRatio ?? item?.rvol,
  });
  const rawTotal = rvol.score
    + change.score
    + tradeValue.score
    + price.score
    + baseQualityScore
    - riskPenalty.penalty
    - structurePenalty.penalty;
  const shortTermOperationalRankScore = Math.round(clamp(rawTotal));
  const qualityBucket = shortTermQualityBucket({
    symbol: item?.symbol,
    shortTermOperationalRankScore,
    relativeVolume: item?.relativeVolume ?? item?.volumeRatio ?? item?.rvol,
    changePercent: item?.changePercent ?? item?.preMarketChangePercent,
    tradeValueKrw: item?.tradeValueKrw,
  });
  const shortTermOperationalScoreBreakdown = {
    rvolScore: rvol.score,
    changeScore: change.score,
    tradeValueScore: tradeValue.score,
    priceBandScore: price.score,
    baseQualityScore,
    riskPenalty: -riskPenalty.penalty,
    structurePenalty: -structurePenalty.penalty,
    rawTotal,
    qualityBucket: qualityBucket.bucket,
    total: shortTermOperationalRankScore,
    diagnosticOnly: true,
    excludedFields: [
      "vwap",
      "aboveVwap",
      "vwapDistancePercent",
      "volumeAcceleration",
      "closePositionInRange",
      "sessionMovePercent",
    ],
  };
  const shortTermOperationalReasons = [
    rvol.label,
    change.label,
    tradeValue.label,
    ...riskPenalty.labels,
    ...structurePenalty.labels,
    qualityBucket.label,
    "diagnostic only: not used for sorting",
  ].filter(Boolean);
  return {
    shortTermOperationalRankScore,
    shortTermOperationalScoreBreakdown,
    shortTermOperationalReasons: [...new Set(shortTermOperationalReasons)],
    shortTermOperationalRankSource: "shortTermOperationalV1",
    shortTermQualityBucket: qualityBucket.bucket,
  };
}

function underOneRiskPenalty({ tradeValueKrw, relativeVolume, changePercent, price }) {
  const tradeValue = num(tradeValueKrw);
  const rvol = num(relativeVolume);
  const change = num(changePercent);
  const priceValue = num(price);
  let penalty = 0;
  const labels = [];
  if (tradeValue !== null && tradeValue < 10_000_000) {
    penalty += 20;
    labels.push("Low liquidity: tradeValueKrw below threshold");
  } else if (tradeValue !== null && tradeValue < 50_000_000) {
    penalty += 12;
    labels.push("Low liquidity: tradeValueKrw below threshold");
  }
  if (rvol === null) {
    penalty += 8;
    labels.push("Low RVOL: under-one volume not expanding");
  } else if (rvol < 0.1) {
    penalty += 10;
    labels.push("Low RVOL: under-one volume not expanding");
  }
  if (change !== null && change >= 30) {
    penalty += 20;
    labels.push("Overextended: changePercent >= 30");
  }
  if (priceValue !== null && priceValue < 0.05) {
    penalty += 15;
    labels.push("Extreme penny risk: price below 0.05");
  }
  return { penalty: Math.min(penalty, 40), labels };
}

function buildUnderOneOperationalScore(item) {
  const change = underOneChangeScore(item?.changePercent);
  const rvol = underOneRvolScore(item?.relativeVolume);
  const tradeValue = underOneTradeValueScore(item?.tradeValueKrw);
  const price = underOnePriceBandScore(item?.price);
  const riskPenalty = underOneRiskPenalty({
    tradeValueKrw: item?.tradeValueKrw,
    relativeVolume: item?.relativeVolume,
    changePercent: item?.changePercent,
    price: item?.price,
  });
  const structurePenalty = underOneStructurePenalty(
    item?.symbol,
    item?.tradeValueKrw,
    item?.relativeVolume,
    item?.changePercent,
  );
  const scoreCap = underOneScoreCap({
    symbol: item?.symbol,
    tradeValueKrw: item?.tradeValueKrw,
    relativeVolume: item?.relativeVolume,
    price: item?.price,
  });
  const rawTotal = change.score
    + rvol.score
    + tradeValue.score
    + price.score
    - riskPenalty.penalty
    - structurePenalty.penalty;
  const uncappedTotal = Math.round(clamp(rawTotal));
  const underOneOperationalRankScore = Math.min(uncappedTotal, scoreCap.cap);
  const qualityBucket = underOneQualityBucket({
    symbol: item?.symbol,
    underOneOperationalRankScore,
    tradeValueKrw: item?.tradeValueKrw,
    relativeVolume: item?.relativeVolume,
    price: item?.price,
  });
  const underOneOperationalScoreBreakdown = {
    changeScore: change.score,
    rvolScore: rvol.score,
    tradeValueScore: tradeValue.score,
    priceBandScore: price.score,
    riskPenalty: -riskPenalty.penalty,
    structurePenalty: -structurePenalty.penalty,
    rawTotal,
    uncappedTotal,
    scoreCap: scoreCap.cap < 100 ? scoreCap.cap : null,
    qualityBucket: qualityBucket.bucket,
    total: underOneOperationalRankScore,
    diagnosticOnly: true,
    excludedFields: [
      "vwap",
      "aboveVwap",
      "vwapDistancePercent",
      "volumeAcceleration",
      "higherLowScore",
      "highDropPercent",
      "closePositionInRange",
    ],
  };
  const underOneOperationalReasons = [
    change.label,
    rvol.label,
    tradeValue.label,
    price.label,
    ...riskPenalty.labels,
    ...structurePenalty.labels,
    ...scoreCap.labels,
    qualityBucket.label,
    "diagnostic only: not used for sorting",
  ].filter(Boolean);
  return {
    underOneOperationalRankScore,
    underOneQualityBucket: qualityBucket.bucket,
    underOneOperationalScoreBreakdown,
    underOneOperationalReasons: [...new Set(underOneOperationalReasons)],
    underOneOperationalRankSource: "underOneOperationalV1",
  };
}

function overOneRvolScore(relativeVolume) {
  const rvol = num(relativeVolume);
  if (rvol === null || rvol < 1) return { score: 0, label: null };
  if (rvol < 2) return { score: 8, label: null };
  if (rvol < 3) return { score: 14, label: null };
  if (rvol < 5) return { score: 22, label: "Over-one volume expansion" };
  if (rvol < 10) return { score: 27, label: "Over-one volume expansion" };
  return { score: 30, label: "Over-one volume expansion" };
}

function overOneChangeScore(changePercent) {
  const change = num(changePercent);
  if (change === null || change < 0) return { score: 0, label: null };
  if (change < 1) return { score: 5, label: null };
  if (change < 3) return { score: 12, label: null };
  if (change < 8) return { score: 25, label: "Good over-one change range" };
  if (change < 15) return { score: 22, label: "Good over-one change range" };
  if (change < 25) return { score: 12, label: null };
  if (change < 50) return { score: 4, label: "Overextended for over-one" };
  return { score: 0, label: "Overextended for over-one" };
}

function overOnePriceBandScore(price) {
  const value = num(price);
  if (value === null || value < 1) return { score: 0, label: null };
  if (value < 3) return { score: 15, label: "Good 1-20 price band" };
  if (value < 5) return { score: 15, label: "Good 1-20 price band" };
  if (value < 20) return { score: 12, label: "Good 1-20 price band" };
  if (value < 50) return { score: 7, label: null };
  if (value < 100) return { score: 4, label: "High price: lower priority" };
  return { score: 0, label: "High price: lower priority" };
}

function overOneBaseQualityScore(item) {
  const operational = num(item?.operationalRankScore);
  if (operational !== null) {
    if (operational >= 70) return 15;
    if (operational >= 50) return 10;
    if (operational >= 30) return 5;
    return 0;
  }
  const finalScore = num(item?.finalSelectionScore) ?? num(item?.marketPrioritySortScore);
  if (finalScore === null) return 0;
  if (finalScore >= 70) return 10;
  if (finalScore >= 50) return 7;
  if (finalScore >= 30) return 4;
  return 0;
}

function overOneTechnicalBoost(value, highThreshold, midThreshold, highPoints, midPoints) {
  const parsed = num(value);
  if (parsed === null) return 0;
  if (parsed >= highThreshold) return highPoints;
  if (parsed >= midThreshold) return midPoints;
  return 0;
}

function overOneTechnicalScore(item) {
  const entry = overOneTechnicalBoost(item?.entrySuitability, 65, 45, 5, 3);
  const volumeQuality = overOneTechnicalBoost(item?.volumeQualityScore, 60, 45, 5, 3);
  const volumeAcceleration = overOneTechnicalBoost(item?.volumeAccelerationScore, 60, 45, 3, 2);
  const higherLow = overOneTechnicalBoost(item?.higherLowScore, 58, 45, 2, 1);
  return Math.min(entry + volumeQuality + volumeAcceleration + higherLow, 15);
}

function overOneStructurePenalty(symbol) {
  if (!isUnderOneStructureRiskSymbol(symbol)) return { penalty: 0, labels: [] };
  return {
    penalty: 20,
    labels: ["Structure risk for over-one"],
  };
}

function overOneRiskPenalty({ price, changePercent, relativeVolume, isChasingRisk, isOverheated }) {
  const priceValue = num(price);
  const change = num(changePercent);
  const rvol = num(relativeVolume);
  let penalty = 0;
  const labels = [];

  if (change !== null && change >= 50) {
    penalty += 25;
    labels.push("Overextended for over-one");
  } else if (change !== null && change >= 25) {
    penalty += 10;
    labels.push("Overextended for over-one");
  }
  if (rvol !== null && rvol < 1) {
    penalty += 10;
  }
  if (priceValue !== null && priceValue >= 100) {
    penalty += 15;
    labels.push("High price: lower priority");
  } else if (priceValue !== null && priceValue >= 50) {
    penalty += 5;
    labels.push("High price: lower priority");
  }
  if (isChasingRisk === true) {
    penalty += 25;
    labels.push("Overextended for over-one");
  }
  if (isOverheated === true) {
    penalty += 25;
    labels.push("Overextended for over-one");
  }

  return {
    penalty: Math.min(penalty, 35),
    labels,
  };
}

function overOneQualityBucket({
  symbol,
  overOneOperationalRankScore,
  relativeVolume,
  changePercent,
  price,
  isChasingRisk,
  isOverheated,
}) {
  const score = num(overOneOperationalRankScore) ?? 0;
  const rvol = num(relativeVolume);
  const change = num(changePercent);
  const priceValue = num(price);
  const structureRisk = isUnderOneStructureRiskSymbol(symbol);

  if (structureRisk
    || score < 25
    || rvol === null
    || rvol < 1
    || isChasingRisk === true
    || isOverheated === true) {
    return { bucket: 3, label: "Over-one quality bucket: fallback" };
  }
  if (!structureRisk
    && score >= 65
    && rvol >= 3
    && change !== null
    && change >= 1
    && change <= 15
    && priceValue !== null
    && priceValue >= 1
    && priceValue <= 20
    && isChasingRisk !== true
    && isOverheated !== true) {
    return { bucket: 0, label: "Over-one quality bucket: primary" };
  }
  if (!structureRisk
    && score >= 45
    && rvol >= 2
    && change !== null
    && change >= 1
    && change <= 20
    && priceValue !== null
    && priceValue >= 1
    && priceValue <= 50) {
    return { bucket: 1, label: "Over-one quality bucket: usable" };
  }
  if (!structureRisk
    && score >= 25
    && rvol >= 1
    && change !== null
    && change >= 0) {
    return { bucket: 2, label: "Over-one quality bucket: weak" };
  }
  return { bucket: 3, label: "Over-one quality bucket: fallback" };
}

function buildOverOneOperationalScore(item) {
  const priceValue = item?.price ?? item?.preMarketPrice ?? item?.regularMarketPrice;
  const changePercent = item?.changePercent ?? item?.preMarketChangePercent;
  const relativeVolume = item?.relativeVolume ?? item?.volumeRatio ?? item?.rvol;
  const rvol = overOneRvolScore(relativeVolume);
  const change = overOneChangeScore(changePercent);
  const price = overOnePriceBandScore(priceValue);
  const baseQualityScore = overOneBaseQualityScore(item);
  const technicalScore = overOneTechnicalScore(item);
  const riskPenalty = overOneRiskPenalty({
    price: priceValue,
    changePercent,
    relativeVolume,
    isChasingRisk: item?.isChasingRisk,
    isOverheated: item?.isOverheated,
  });
  const structurePenalty = overOneStructurePenalty(item?.symbol);
  const rawTotal = rvol.score
    + change.score
    + price.score
    + baseQualityScore
    + technicalScore
    - riskPenalty.penalty
    - structurePenalty.penalty;
  const overOneOperationalRankScore = Math.round(clamp(rawTotal));
  const qualityBucket = overOneQualityBucket({
    symbol: item?.symbol,
    overOneOperationalRankScore,
    relativeVolume,
    changePercent,
    price: priceValue,
    isChasingRisk: item?.isChasingRisk,
    isOverheated: item?.isOverheated,
  });
  const overOneOperationalScoreBreakdown = {
    rvolScore: rvol.score,
    changeScore: change.score,
    priceBandScore: price.score,
    baseQualityScore,
    technicalScore,
    riskPenalty: -riskPenalty.penalty,
    structurePenalty: -structurePenalty.penalty,
    rawTotal,
    qualityBucket: qualityBucket.bucket,
    total: overOneOperationalRankScore,
    diagnosticOnly: true,
    excludedFields: [
      "tradeValueKrw",
      "vwapDistancePercent",
      "closePositionInRange",
      "sessionMovePercent",
    ],
  };
  const overOneOperationalReasons = [
    rvol.label,
    change.label,
    price.label,
    ...riskPenalty.labels,
    ...structurePenalty.labels,
    qualityBucket.label,
    "diagnostic only: not used for sorting",
  ].filter(Boolean);
  return {
    overOneOperationalRankScore,
    overOneQualityBucket: qualityBucket.bucket,
    overOneOperationalScoreBreakdown,
    overOneOperationalReasons: [...new Set(overOneOperationalReasons)],
    overOneOperationalRankSource: "overOneOperationalV1",
  };
}

function getOverOneOperationalRankScore(item) {
  const overOneScore = num(item?.overOneOperationalRankScore);
  if (overOneScore !== null) return overOneScore;
  const operational = num(item?.operationalRankScore);
  if (operational !== null) return operational;
  const experimental = num(item?.experimentalRankScore);
  if (experimental !== null) return experimental;
  const finalScore = num(item?.finalSelectionScore);
  if (finalScore !== null) return finalScore;
  const marketPriority = num(item?.marketPrioritySortScore);
  if (marketPriority !== null) return marketPriority;
  return 0;
}

function sortOverOneCandidatesByOperationalRank(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const bucketDiff = (num(a?.overOneQualityBucket) ?? 3) - (num(b?.overOneQualityBucket) ?? 3);
      if (bucketDiff !== 0) return bucketDiff;
      const scoreDiff = getOverOneOperationalRankScore(b) - getOverOneOperationalRankScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      const rvolDiff = (num(b?.relativeVolume) ?? 0) - (num(a?.relativeVolume) ?? 0);
      if (rvolDiff !== 0) return rvolDiff;
      const changeDiff = (num(b?.changePercent) ?? 0) - (num(a?.changePercent) ?? 0);
      if (changeDiff !== 0) return changeDiff;
      return (num(b?.operationalRankScore) ?? 0) - (num(a?.operationalRankScore) ?? 0);
    });
}

function getUnderOneOperationalRankScore(item) {
  const underOneScore = num(item?.underOneOperationalRankScore);
  if (underOneScore !== null) return underOneScore;
  const operational = num(item?.operationalRankScore);
  if (operational !== null) return operational;
  const experimental = num(item?.experimentalRankScore);
  if (experimental !== null) return experimental;
  const finalScore = num(item?.finalSelectionScore);
  if (finalScore !== null) return finalScore;
  return 0;
}

function sortUnderOneCandidatesByOperationalRank(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const bucketDiff = (num(a?.underOneQualityBucket) ?? 2) - (num(b?.underOneQualityBucket) ?? 2);
      if (bucketDiff !== 0) return bucketDiff;
      const scoreDiff = getUnderOneOperationalRankScore(b) - getUnderOneOperationalRankScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      const tradeValueDiff = (num(b?.tradeValueKrw) ?? 0) - (num(a?.tradeValueKrw) ?? 0);
      if (tradeValueDiff !== 0) return tradeValueDiff;
      const rvolDiff = (num(b?.relativeVolume) ?? 0) - (num(a?.relativeVolume) ?? 0);
      if (rvolDiff !== 0) return rvolDiff;
      return (num(b?.changePercent) ?? 0) - (num(a?.changePercent) ?? 0);
    });
}

function getShortTermOperationalRankScore(item) {
  const shortTermScore = num(item?.shortTermOperationalRankScore);
  if (shortTermScore !== null) return shortTermScore;
  const operational = num(item?.operationalRankScore);
  if (operational !== null) return operational;
  const experimental = num(item?.experimentalRankScore);
  if (experimental !== null) return experimental;
  const finalScore = num(item?.finalSelectionScore);
  if (finalScore !== null) return finalScore;
  const marketPriority = num(item?.marketPrioritySortScore);
  if (marketPriority !== null) return marketPriority;
  return 0;
}

function sortShortTermCandidatesByOperationalRank(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const bucketDiff = (num(a?.shortTermQualityBucket) ?? 3) - (num(b?.shortTermQualityBucket) ?? 3);
      if (bucketDiff !== 0) return bucketDiff;
      const scoreDiff = getShortTermOperationalRankScore(b) - getShortTermOperationalRankScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      const rvolDiff = (num(b?.relativeVolume ?? b?.volumeRatio ?? b?.rvol) ?? 0)
        - (num(a?.relativeVolume ?? a?.volumeRatio ?? a?.rvol) ?? 0);
      if (rvolDiff !== 0) return rvolDiff;
      const changeDiff = (num(b?.changePercent ?? b?.preMarketChangePercent) ?? 0)
        - (num(a?.changePercent ?? a?.preMarketChangePercent) ?? 0);
      if (changeDiff !== 0) return changeDiff;
      return (num(b?.tradeValueKrw) ?? 0) - (num(a?.tradeValueKrw) ?? 0);
    });
}

function sanitizeScannerItem(item, { debug = false } = {}) {
  if (!item || typeof item !== "object") return null;
  const rangeAuditFields = deriveRangeAuditFields(item);
  const sanitized = {
    symbol: item.symbol ?? null,
    name: item.name ?? null,
    price: item.price ?? null,
    preMarketPrice: item.preMarketPrice ?? null,
    regularMarketPrice: item.regularMarketPrice ?? null,
    previousClose: item.previousClose ?? null,
    changePercent: item.changePercent ?? null,
    preMarketChangePercent: item.preMarketChangePercent ?? null,
    volume: item.volume ?? null,
    regularMarketVolume: item.regularMarketVolume ?? null,
    relativeVolume: item.relativeVolume ?? null,
    averageVolume: item.averageVolume ?? null,
    marketCap: item.marketCap ?? null,
    exchange: item.exchange ?? null,
    currency: item.currency ?? null,
    marketState: item.marketState ?? null,
    stage: item.stage ?? null,
    stageLabel: item.stageLabel ?? item.stageLabelKo ?? null,
    stageLabelKo: item.stageLabelKo ?? null,
    riskLabelKo: item.riskLabelKo ?? null,
    scannerScore: item.scannerScore ?? null,
    finalProbabilityScore: item.finalProbabilityScore ?? null,
    finalSelectionScore: item.finalSelectionScore ?? null,
    experimentalFinalSelectionScore: item.experimentalFinalSelectionScore ?? null,
    experimentalRankScore: item.experimentalRankScore ?? null,
    experimentalScoreBreakdown: item.experimentalScoreBreakdown ?? null,
    experimentalReasons: Array.isArray(item.experimentalReasons) ? item.experimentalReasons : [],
    operationalRankScore: item.operationalRankScore ?? null,
    operationalRankSource: item.operationalRankSource ?? null,
    shortTermOperationalRankScore: item.shortTermOperationalRankScore ?? null,
    shortTermQualityBucket: item.shortTermQualityBucket ?? null,
    shortTermOperationalScoreBreakdown: item.shortTermOperationalScoreBreakdown ?? null,
    shortTermOperationalReasons: Array.isArray(item.shortTermOperationalReasons) ? item.shortTermOperationalReasons : [],
    shortTermOperationalRankSource: item.shortTermOperationalRankSource ?? null,
    underOneOperationalRankScore: item.underOneOperationalRankScore ?? null,
    underOneQualityBucket: item.underOneQualityBucket ?? null,
    underOneOperationalScoreBreakdown: item.underOneOperationalScoreBreakdown ?? null,
    underOneOperationalReasons: Array.isArray(item.underOneOperationalReasons) ? item.underOneOperationalReasons : [],
    underOneOperationalRankSource: item.underOneOperationalRankSource ?? null,
    overOneOperationalRankScore: item.overOneOperationalRankScore ?? null,
    overOneQualityBucket: item.overOneQualityBucket ?? null,
    overOneOperationalScoreBreakdown: item.overOneOperationalScoreBreakdown ?? null,
    overOneOperationalReasons: Array.isArray(item.overOneOperationalReasons) ? item.overOneOperationalReasons : [],
    overOneOperationalRankSource: item.overOneOperationalRankSource ?? null,
    marketPrioritySortScore: item.marketPrioritySortScore ?? null,
    volumeQualitySortScore: item.volumeQualitySortScore ?? null,
    surgePrecursorScore: item.surgePrecursorScore ?? null,
    momentumExpansionScore: item.momentumExpansionScore ?? null,
    volumeAccelerationScore: item.volumeAccelerationScore ?? null,
    volumeQualityScore: item.volumeQualityScore ?? null,
    entrySuitability: item.entrySuitability ?? null,
    riskScore: item.riskScore ?? null,
    rvol: item.rvol ?? null,
    vwap: item.vwap ?? null,
    aboveVwap: item.aboveVwap ?? null,
    vwapDistancePercent: item.vwapDistancePercent ?? null,
    highDropPercent: rangeAuditFields.highDropPercent,
    highDropSource: rangeAuditFields.highDropSource,
    closePositionInRange: rangeAuditFields.closePositionInRange,
    closePositionSource: rangeAuditFields.closePositionSource,
    vwapEstimate: rangeAuditFields.vwapEstimate,
    vwapSource: rangeAuditFields.vwapSource,
    compressionScore: item.compressionScore ?? null,
    higherLowScore: item.higherLowScore ?? null,
    volumeStrengthScore: item.volumeStrengthScore ?? null,
    tradeValueKrw: item.tradeValueKrw ?? null,
    dataQualityStatus: item.dataQualityStatus ?? null,
    accumulationRankScore: item.accumulationRankScore ?? null,
    accumulationScore: item.accumulationScore ?? null,
    accumulationReason: item.accumulationReason ?? null,
    accumulationSignals: item.accumulationSignals ?? null,
    accumulationRejectReason: item.accumulationRejectReason ?? null,
    tradeBlockScore: item.tradeBlockScore ?? null,
    tradeBlockReason: item.tradeBlockReason ?? null,
    tradeBlockSignals: item.tradeBlockSignals ?? null,
    tradeBlockReasonKo: item.tradeBlockReasonKo ?? null,
    tradeBlockSummaryKo: item.tradeBlockSummaryKo ?? null,
    riskExplanationKo: item.riskExplanationKo ?? null,
    watchlistReason: item.watchlistReason ?? null,
    reentryWaitReason: item.reentryWaitReason ?? null,
    tradeGrouping: item.tradeGrouping ?? null,
    surgeTimingClassification: item.surgeTimingClassification ?? null,
    distanceFromDayHighPct: item.distanceFromDayHighPct ?? null,
    earlySurgeMode: item.earlySurgeMode ?? null,
    earlySurgeScore: item.earlySurgeScore ?? null,
    earlySurgeReason: Array.isArray(item.earlySurgeReason) ? item.earlySurgeReason : [],
    earlySurgeSignal: item.earlySurgeSignal ?? null,
    statusBadge: item.statusBadge ?? null,
    topPickVerdict: item.topPickVerdict ?? null,
    topPickGrade: item.topPickGrade ?? null,
    changePenalty: item.changePenalty ?? null,
    isPreSurgeCandidate: item.isPreSurgeCandidate === true,
    isChasingRisk: item.isChasingRisk === true,
    isOverheated: item.isOverheated === true,
    preMoveScore: item.preMoveScore ?? null,
    preMoveStage: item.preMoveStage ?? null,
    preMoveLabelKo: item.preMoveLabelKo ?? null,
    preMoveReasons: sanitizeScannerReasonList(item.preMoveReasons),
    selectionReasons: sanitizeScannerReasonList(item.selectionReasons),
  };
  if (debug) {
    sanitized.debugQuoteSource = item.debugQuoteSource ?? null;
    sanitized.debugHistorySource = item.debugHistorySource ?? null;
    sanitized.debugFallbackReason = item.debugFallbackReason ?? null;
    sanitized.chartPatternDetails = item.chartPatternDetails ?? null;
    sanitized.topPickRejectedReasons = Array.isArray(item.topPickRejectedReasons) ? item.topPickRejectedReasons : [];
    sanitized.topPickVerdictReasonCodes = Array.isArray(item.topPickVerdictReasonCodes) ? item.topPickVerdictReasonCodes : [];
  }
  return sanitized;
}

function sanitizeScannerList(list, limit, options) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => sanitizeScannerItem(item, options))
    .filter((item) => item && item.symbol)
    .slice(0, limit);
}

function getOperationalRankScore(item) {
  const experimental = num(item?.experimentalRankScore);
  if (experimental !== null) return experimental;
  const finalScore = num(item?.finalSelectionScore);
  if (finalScore !== null) return finalScore;
  return 0;
}

function operationalRankSource(item) {
  return num(item?.experimentalRankScore) !== null ? "experimentalRankScore" : "finalSelectionScore";
}

function sortTopPicksByOperationalRank(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const scoreDiff = getOperationalRankScore(b) - getOperationalRankScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      const tvDiff = (num(b?.tradeValueKrw) ?? 0) - (num(a?.tradeValueKrw) ?? 0);
      if (tvDiff !== 0) return tvDiff;
      return String(a?.symbol || "").localeCompare(String(b?.symbol || ""));
    });
}

function sortByPriority(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const aPriority = num(a.marketPrioritySortScore) ?? num(a.finalSelectionScore) ?? num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0;
      const bPriority = num(b.marketPrioritySortScore) ?? num(b.finalSelectionScore) ?? num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0;
      return bPriority - aPriority
        || ((num(b.entrySuitability ?? b.topPickFinalScore) ?? 0) - (num(a.entrySuitability ?? a.topPickFinalScore) ?? 0))
        || ((num(b.rvol ?? b.relativeVolume ?? b.volumeRatio) ?? 0) - (num(a.rvol ?? a.relativeVolume ?? a.volumeRatio) ?? 0));
    });
}

function accumulationNumber(item, ...keys) {
  for (const key of keys) {
    const value = num(item?.[key]) ?? num(item?.technical?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function accumulationDataQuality(item = {}) {
  const quoteSource = String(item.debugQuoteSource || "").toLowerCase();
  const historySource = String(item.debugHistorySource || "").toLowerCase();
  const hasQuote = quoteSource && quoteSource !== "none";
  const hasHistory = historySource && historySource !== "none";
  const status = hasQuote && hasHistory ? "quote-history"
    : hasQuote ? "quote-only"
      : hasHistory ? "history-only"
        : "missing";
  const score = status === "quote-history" ? 100
    : status === "quote-only" || status === "history-only" ? 45
      : 0;
  return { status, score, hasQuote, hasHistory };
}

function accumulationVwapScore(item = {}) {
  const distance = num(item.vwapDistancePercent);
  const reclaim = accumulationNumber(item, "vwapReclaimScore") ?? 0;
  if (item.aboveVwap === true) return 100;
  if (distance !== null) {
    const abs = Math.abs(distance);
    if (distance >= 0 && abs <= 1.5) return 95;
    if (abs <= 2) return 82;
    if (abs <= 4) return 65;
    if (distance >= -6) return 42;
    return 18;
  }
  if (reclaim >= 70) return 80;
  if (reclaim >= 55) return 62;
  if (num(item.vwapEstimate) !== null) return 45;
  return 35;
}

function accumulationChangeStabilityScore(change) {
  if (change === null) return 0;
  if (change >= -2 && change <= 2) return 100;
  if (change >= -5 && change <= 5) return 82;
  if (change > 5 && change <= 8) return 45;
  return 0;
}

function accumulationVolumeScore(item = {}) {
  const rvol = num(item.relativeVolume) ?? num(item.volumeRatio) ?? num(item.rvol);
  const volume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0, num(item.regularMarketVolume) ?? 0);
  if ((rvol === null || rvol <= 0) && volume <= 0) return 0;
  if (rvol !== null) {
    if (rvol >= 1.15 && rvol <= 2.5) return 100;
    if (rvol > 2.5 && rvol <= 4) return 76;
    if (rvol > 4 && rvol <= 6) return 48;
    if (rvol > 6) return 22;
    if (rvol >= 0.8) return 48;
    return 22;
  }
  if (volume >= 1_000_000) return 58;
  if (volume >= 300_000) return 42;
  return 24;
}

function accumulationRejectReason(item = {}) {
  const stage = String(item.stage || "");
  const change = num(item.changePercent ?? item.preMarketChangePercent);
  const rvol = num(item.relativeVolume) ?? num(item.volumeRatio) ?? num(item.rvol);
  const volume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0, num(item.regularMarketVolume) ?? 0);
  const compression = accumulationNumber(item, "compressionScore", "boxCompression", "volatilityContraction") ?? 50;
  const higherLow = accumulationNumber(item, "higherLowScore") ?? 50;
  const quality = accumulationDataQuality(item);
  if (!isPrimaryCommonStockCandidate(item)) return "non-common-stock";
  if (item.isOverheated === true || item.isChasingRisk === true) return "overheated-or-chasing";
  if (String(item.statusBadge || "").includes("제외")) return "excluded-status";
  if (item.included === false || item.dataQualityStatus === "insufficient-data") return "insufficient-data";
  if (change === null) return "missing-change";
  if (change > 8 && !(stage === "ACCUMULATION" && compression >= 75 && higherLow >= 65)) return "change-too-hot";
  if (change < -5) return "change-too-weak";
  if (rvol !== null && rvol > 8) return "rvol-too-hot";
  if (!["ACCUMULATION", "PRE_SURGE"].includes(stage) && item.isPreSurgeCandidate !== true) return "not-accumulation-stage";
  if (quality.status === "missing") return "missing-quote-history";
  if (compression === 50 && higherLow === 50 && quality.status !== "quote-history") return "default-technical-scores";
  if ((rvol === null || rvol <= 0) && volume <= 0) return "missing-volume-and-rvol";
  return null;
}

function buildAccumulationOperationalScore(item = {}) {
  const change = num(item.changePercent ?? item.preMarketChangePercent);
  const stage = String(item.stage || "");
  const compression = clamp(accumulationNumber(item, "compressionScore", "boxCompression", "volatilityContraction") ?? 50);
  const higherLow = clamp(accumulationNumber(item, "higherLowScore") ?? 50);
  const vwap = clamp(accumulationVwapScore(item));
  const changeStability = clamp(accumulationChangeStabilityScore(change));
  const volumeWarmup = clamp(accumulationVolumeScore(item));
  const dataQuality = accumulationDataQuality(item);
  const preSurgePenalty = stage === "PRE_SURGE" ? 8 : 0;
  const warmChangePenalty = change !== null && change > 5 ? 10 : 0;
  const score = Math.round(clamp(
    compression * 0.25
      + higherLow * 0.20
      + vwap * 0.20
      + changeStability * 0.15
      + volumeWarmup * 0.15
      + dataQuality.score * 0.05
      - preSurgePenalty
      - warmChangePenalty,
  ));
  const reasons = [
    `compression ${Math.round(compression)}`,
    `higherLow ${Math.round(higherLow)}`,
    `vwap ${Math.round(vwap)}`,
    `change ${change === null ? "missing" : change.toFixed(1) + "%"}`,
    `volumeWarmup ${Math.round(volumeWarmup)}`,
    `data ${dataQuality.status}`,
    stage === "PRE_SURGE" ? "PRE_SURGE supplement" : null,
  ].filter(Boolean);
  return {
    accumulationRankScore: score,
    accumulationScore: score,
    accumulationSignals: {
      compressionScore: Math.round(compression),
      higherLowScore: Math.round(higherLow),
      vwapScore: Math.round(vwap),
      changeStabilityScore: Math.round(changeStability),
      volumeWarmupScore: Math.round(volumeWarmup),
      dataQualityScore: Math.round(dataQuality.score),
      dataQualityStatus: dataQuality.status,
    },
    accumulationReason: reasons.join(" | "),
    accumulationRejectReason: null,
  };
}

function sortAccumulationCandidates(items = []) {
  return items
    .slice()
    .sort((a, b) => {
      const scoreDiff = (num(b.accumulationRankScore) ?? 0) - (num(a.accumulationRankScore) ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const compressionDiff = (num(b.compressionScore) ?? 50) - (num(a.compressionScore) ?? 50);
      if (compressionDiff !== 0) return compressionDiff;
      const higherLowDiff = (num(b.higherLowScore) ?? 50) - (num(a.higherLowScore) ?? 50);
      if (higherLowDiff !== 0) return higherLowDiff;
      const vwapDiff = accumulationVwapScore(b) - accumulationVwapScore(a);
      if (vwapDiff !== 0) return vwapDiff;
      const rvolDiff = (num(b.rvol ?? b.relativeVolume ?? b.volumeRatio) ?? 0) - (num(a.rvol ?? a.relativeVolume ?? a.volumeRatio) ?? 0);
      if (rvolDiff !== 0) return rvolDiff;
      const aChange = Math.abs(num(a.changePercent ?? a.preMarketChangePercent) ?? 99);
      const bChange = Math.abs(num(b.changePercent ?? b.preMarketChangePercent) ?? 99);
      if (aChange !== bChange) return aChange - bChange;
      return (accumulationDataQuality(b).score - accumulationDataQuality(a).score);
    });
}

function buildAccumulationCandidates(items = [], limit = SCANNER_ACCUMULATION_LIMIT) {
  const evaluated = items.map((item) => {
    const reject = accumulationRejectReason(item);
    if (reject) {
      return {
        ...item,
        accumulationRejectReason: reject,
      };
    }
    return {
      ...item,
      ...buildAccumulationOperationalScore(item),
    };
  });
  const accepted = evaluated.filter((item) => !item.accumulationRejectReason);
  const primary = sortAccumulationCandidates(accepted.filter((item) => String(item.stage || "") === "ACCUMULATION"));
  const supplement = sortAccumulationCandidates(accepted.filter((item) => String(item.stage || "") === "PRE_SURGE"));
  const preSurgeLimit = Math.min(10, primary.length, Math.max(0, limit - primary.length));
  return [
    ...primary,
    ...supplement.slice(0, preSurgeLimit),
  ].slice(0, limit);
}

function buildTradeBlockReasonKo(blockSignals, change, rvol) {
  const reasons = [];
  for (const signal of blockSignals) {
    if (signal.startsWith("change-")) {
      const p = parseFloat(signal.replace("change-", "").replace("%", ""));
      reasons.push(`오늘 이미 크게 상승했습니다${Number.isFinite(p) ? `(${p.toFixed(1)}%)` : ""}. 현재 진입하면 고점 추격 위험이 큽니다.`);
    } else if (signal === "overheated") {
      reasons.push("현재 과열 상태입니다. 추가 매수는 고점 진입 위험이 있습니다.");
    } else if (signal.startsWith("chasing-risk")) {
      reasons.push("추격 위험이 높습니다. 현재 진입은 적합하지 않습니다.");
    } else if (signal.startsWith("drop-risk")) {
      reasons.push("고점 이후 하락 위험이 커진 상태입니다.");
    } else if (signal.startsWith("rvol-") && signal.includes("vwap-weak")) {
      reasons.push("거래량이 이미 과도하게 폭발해 초기 진입 구간은 지났습니다.");
    } else if (signal === "excluded-status") {
      reasons.push("스캐너 기준상 제외 후보로 분류되었습니다.");
    } else if (signal === "insufficient-data-hot") {
      reasons.push("데이터가 부족해 안전한 진입 판단이 어렵습니다.");
    } else if (signal === "forbidden-verdict-confirmed") {
      reasons.push("매매 금지 조건이 복수 확인되었습니다.");
    } else if (signal === "hot-change-vwap-weak") {
      reasons.push("현재가가 VWAP 아래에 있어 매수세가 약해진 상태입니다.");
    }
  }
  if (reasons.length === 0) {
    if (change !== null && change >= 15) {
      reasons.push("오늘 이미 크게 상승했습니다. 현재 진입하면 고점 추격 위험이 큽니다.");
    } else if (rvol !== null && rvol > 100) {
      reasons.push("거래량이 이미 과도하게 폭발해 초기 진입 구간은 지났습니다.");
    } else {
      reasons.push("복합 위험 신호로 현재 진입이 적합하지 않습니다.");
    }
  }
  return reasons.slice(0, 2).join(" ");
}

function buildSurgeTimingClassification(item) {
  const change = num(item?.changePercent) ?? num(item?.preMarketChangePercent) ?? 0;
  const rvol = num(item?.relativeVolume) ?? num(item?.volumeRatio) ?? 0;
  const rangeAudit = deriveRangeAuditFields(item);
  const distanceFromDayHighPct = rangeAudit.highDropPercent !== null
    ? Math.round(rangeAudit.highDropPercent * 10) / 10
    : null;

  let surgeTimingClassification;
  let earlySurgeSignal = null;
  let earlySurgeScore = 0;
  const earlySurgeReasonArr = [];

  if (change >= 20 || rvol > 100) {
    surgeTimingClassification = "LATE_CHASE_RISK";
    earlySurgeSignal = "LATE_CHASE_RISK";
    if (rvol > 100) earlySurgeReasonArr.push("RVOL 100배 이상 — 추격 위험");
    else earlySurgeReasonArr.push(`상승률 ${change.toFixed(1)}%로 이미 크게 오른 상태`);
    if (distanceFromDayHighPct !== null && distanceFromDayHighPct >= 8) {
      earlySurgeReasonArr.push(`고점 대비 ${distanceFromDayHighPct.toFixed(1)}% 하락`);
    }
  } else if (change >= 15 || rvol > 20) {
    surgeTimingClassification = "SURGE_IN_PROGRESS";
    earlySurgeSignal = "SURGE_IN_PROGRESS";
    if (rvol > 20) earlySurgeReasonArr.push("RVOL 20배 이상 — 이미 폭발한 후");
    else earlySurgeReasonArr.push(`상승률 ${change.toFixed(1)}%로 급등 진행 중`);
  } else if (change >= -2 && change <= 8 && rvol >= 3 && rvol <= 10) {
    surgeTimingClassification = "EARLY_SURGE_SETUP";
    earlySurgeSignal = "EARLY_SURGE_SETUP";
    earlySurgeScore = 50;
    if (rvol >= 5) {
      earlySurgeScore += 20;
      earlySurgeReasonArr.push("RVOL 5배 이상 강한 예열");
    } else {
      earlySurgeScore += 10;
      earlySurgeReasonArr.push("RVOL 3~10배 초기 예열 구간");
    }
    if (change >= 0 && change <= 4) {
      earlySurgeScore += 15;
      earlySurgeReasonArr.push("상승률 초기 구간 유지");
    }
    if (distanceFromDayHighPct !== null && distanceFromDayHighPct < 5) {
      earlySurgeScore += 10;
      earlySurgeReasonArr.push("고점 근처 유지");
    }
  } else {
    surgeTimingClassification = "NEUTRAL";
  }

  return {
    surgeTimingClassification,
    distanceFromDayHighPct,
    earlySurgeMode: "early_surge_v1",
    earlySurgeScore: Math.min(100, Math.round(earlySurgeScore)),
    earlySurgeReason: earlySurgeReasonArr.slice(0, 3),
    earlySurgeSignal,
  };
}

function tradeGroupNumber(item, ...keys) {
  for (const key of keys) {
    const value = num(item?.[key]) ?? num(item?.technical?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function tradeGroupVwapState(item = {}) {
  const distance = tradeGroupNumber(item, "vwapDistancePercent");
  const state = String(item?.vwapState ?? item?.technical?.vwapState ?? "").toLowerCase();
  const above = item?.aboveVwap === true || state === "above" || (distance !== null && distance >= 0);
  const near = state === "near" || (distance !== null && distance > -1.5 && distance < 0);
  const below = item?.aboveVwap === false || state === "below" || (distance !== null && distance <= -1.5);
  return { above, near, below, distance };
}

function evaluateTradeGrouping(item = {}) {
  const change = tradeGroupNumber(item, "changePercent", "preMarketChangePercent");
  const rvol = tradeGroupNumber(item, "relativeVolume", "volumeRatio", "rvol");
  const chaseRisk = tradeGroupNumber(item, "chasingRiskScore", "chaseRiskScore", "topPickChaseRisk", "riskScore") ?? 0;
  const dropRisk = tradeGroupNumber(item, "dropRiskScore", "dropRisk") ?? 0;
  const volume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0, num(item.regularMarketVolume) ?? 0);
  const vwap = tradeGroupVwapState(item);
  const vwapWeak = vwap.below || (vwap.distance !== null && vwap.distance < 0);
  const statusText = String(item.statusBadge || "");
  const verdictText = String(item.topPickVerdict || item.finalDecisionLabel || "");
  const volumeMissing = (rvol === null || rvol <= 0) && volume <= 0;
  const dataInsufficient = item.dataQualityStatus === "insufficient-data" || (volumeMissing && change !== null && change >= 8);

  let tradeBlockScore = 0;
  const blockSignals = [];
  if (item.isOverheated === true) {
    tradeBlockScore += 35;
    blockSignals.push("overheated");
  }
  if (item.isChasingRisk === true && chaseRisk >= 60) {
    tradeBlockScore += 30;
    blockSignals.push(`chasing-risk-${Math.round(chaseRisk)}`);
  }
  if (dropRisk >= 60) {
    tradeBlockScore += dropRisk >= 80 ? 34 : 26;
    blockSignals.push(`drop-risk-${Math.round(dropRisk)}`);
  }
  if (change !== null && change >= 15) {
    tradeBlockScore += 24;
    blockSignals.push(`change-${change.toFixed(1)}%`);
  } else if (change !== null && change >= 10 && vwapWeak) {
    tradeBlockScore += 22;
    blockSignals.push("hot-change-vwap-weak");
  }
  if (rvol !== null && rvol >= 8 && vwapWeak) {
    tradeBlockScore += rvol >= 20 ? 28 : 20;
    blockSignals.push(`rvol-${rvol.toFixed(1)}-vwap-weak`);
  }
  if (statusText.includes("\uC81C\uC678")) {
    tradeBlockScore += 18;
    blockSignals.push("excluded-status");
  }
  if (dataInsufficient && change !== null && change >= 8) {
    tradeBlockScore += 18;
    blockSignals.push("insufficient-data-hot");
  }
  if (verdictText.includes("\uAE08\uC9C0") && (chaseRisk >= 60 || dropRisk >= 60 || vwapWeak || (change !== null && change >= 10))) {
    tradeBlockScore += 14;
    blockSignals.push("forbidden-verdict-confirmed");
  }

  const tradeBlocked = tradeBlockScore >= 35
    || item.isOverheated === true
    || (dropRisk >= 60)
    || (item.isChasingRisk === true && chaseRisk >= 60)
    || (change !== null && change >= 15)
    || (change !== null && change >= 10 && vwapWeak && rvol !== null && rvol >= 3)
    || (rvol !== null && rvol >= 8 && vwapWeak)
    || (dataInsufficient && change !== null && change >= 8);

  const watchSignals = [];
  if (!tradeBlocked) {
    const resurge = tradeGroupNumber(item, "reSurgeSetupScore") ?? 0;
    const reclaim = tradeGroupNumber(item, "vwapReclaimScore") ?? 0;
    const volumeAcceleration = tradeGroupNumber(item, "volumeAccelerationScore") ?? 0;
    const entrySuitability = tradeGroupNumber(item, "entrySuitability", "topPickFinalScore");
    if (vwap.below || reclaim >= 55) watchSignals.push("VWAP 재안착 대기");
    if (resurge >= 60) watchSignals.push("눌림 후 재상승 대기");
    if (volumeMissing || (rvol !== null && rvol < 1.2 && change !== null && change >= 3)) watchSignals.push("거래량 확인 대기");
    if (entrySuitability !== null && entrySuitability >= 40 && entrySuitability < 65) watchSignals.push("신규 진입 보통");
    if (volumeAcceleration >= 55 && change !== null && change >= 0) watchSignals.push("수급 관찰");
    if (verdictText.includes("\uAD00\uCC30") || statusText.includes("\uAD00\uCC30")) watchSignals.push("관찰 추천");
  }

  const tradeBlockReason = tradeBlocked
    ? blockSignals.length ? blockSignals.join(" | ") : "strict-risk"
    : null;
  const reentryWaitReason = !tradeBlocked && watchSignals.some((signal) => signal.includes("재안착") || signal.includes("재상승"))
    ? watchSignals.join(" | ")
    : null;
  const watchlistReason = !tradeBlocked
    ? (watchSignals.length ? watchSignals.join(" | ") : null)
    : null;

  const tradeBlockReasonKo = tradeBlocked
    ? buildTradeBlockReasonKo(blockSignals, change, rvol)
    : null;
  const tradeBlockSummaryKo = tradeBlocked
    ? (change !== null && change >= 20
      ? "오늘 이미 크게 상승했습니다. 고점 추격 위험이 큽니다."
      : change !== null && change >= 15
        ? "상승 과열 구간입니다. 신규 진입은 위험합니다."
        : rvol !== null && rvol > 100
          ? "거래량이 이미 과도하게 폭발했습니다."
          : "복합 위험 신호가 감지되었습니다.")
    : null;

  return {
    tradeBlockScore: Math.round(clamp(tradeBlockScore)),
    tradeBlockReason,
    tradeBlockSignals: blockSignals,
    tradeBlockReasonKo,
    tradeBlockSummaryKo,
    riskExplanationKo: tradeBlockReasonKo,
    watchlistReason,
    reentryWaitReason,
    tradeGrouping: tradeBlocked ? "TRADE_BLOCK" : watchlistReason ? "REENTRY_WATCH" : "NONE",
  };
}

function sortTradeBlockCandidates(items = []) {
  return items.slice().sort((a, b) => {
    const scoreDiff = (num(b.tradeBlockScore) ?? 0) - (num(a.tradeBlockScore) ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const rvolDiff = (num(b.relativeVolume ?? b.rvol ?? b.volumeRatio) ?? 0) - (num(a.relativeVolume ?? a.rvol ?? a.volumeRatio) ?? 0);
    if (rvolDiff !== 0) return rvolDiff;
    return (num(b.changePercent ?? b.preMarketChangePercent) ?? 0) - (num(a.changePercent ?? a.preMarketChangePercent) ?? 0);
  });
}

function sortReentryWatchCandidates(items = []) {
  return items.slice().sort((a, b) => {
    const aReentry = a.reentryWaitReason ? 1 : 0;
    const bReentry = b.reentryWaitReason ? 1 : 0;
    if (aReentry !== bReentry) return bReentry - aReentry;
    return (num(b.operationalRankScore ?? b.finalSelectionScore ?? b.scannerScore) ?? 0)
      - (num(a.operationalRankScore ?? a.finalSelectionScore ?? a.scannerScore) ?? 0);
  });
}

function deriveScannerArrays(payload) {
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object") return payload;
  payload.data.items = Array.isArray(payload.data.items)
    ? payload.data.items.map((item) => ({
        ...item,
        ...evaluateTradeGrouping(item),
        ...buildSurgeTimingClassification(item),
      }))
    : [];
  const items = payload.data.items;
  const ranked = sortByPriority(items);
  const parseChange = (item) => num(item?.changePercent ?? item?.preMarketChangePercent);
  const parsePrice = (item) => num(item?.price ?? item?.preMarketPrice ?? item?.regularMarketPrice);
  const isRisky = (item) => item?.isOverheated === true || item?.isChasingRisk === true;
  const isVwapBelow = (item) => item?.aboveVwap === false || ((num(item?.vwapDistancePercent) ?? 0) < -1.5);

  if (!Array.isArray(payload.data.shortTermCandidates)) {
    payload.data.shortTermCandidates = ranked
      .filter((item) => {
        const change = parseChange(item);
        return change !== null && change >= 0 && !isRisky(item);
      })
      .slice(0, SCANNER_SHORT_TERM_LIMIT);
  }
  payload.data.shortTermCandidates = payload.data.shortTermCandidates.map((item) => ({
    ...item,
    ...buildShortTermOperationalScore(item),
  }));
  payload.data.shortTermCandidates = sortShortTermCandidatesByOperationalRank(payload.data.shortTermCandidates);
  payload.data.shortTermRankingMode = "short_term_operational_v1";
  payload.data.shortTermRankingAppliedTo = ["shortTermCandidates"];
  payload.data.shortTermRankingFallback = "operationalRankScore > experimentalRankScore > finalSelectionScore > marketPrioritySortScore";
  if (!Array.isArray(payload.data.topPicks)) {
    const operationalRanked = sortTopPicksByOperationalRank(items);
    payload.data.topPicks = operationalRanked.slice(0, SCANNER_TOP_PICKS_LIMIT);
    payload.data.rankingMode = "experimental_operational_v1";
    payload.data.rankingAppliedTo = ["topPicks"];
    payload.data.rankingFallback = "finalSelectionScore";
  }
  const accumulationSourceItems = items.length > 0
    ? items
    : Array.isArray(payload.data.accumulationCandidates) ? payload.data.accumulationCandidates : [];
  payload.data.accumulationCandidates = buildAccumulationCandidates(accumulationSourceItems, SCANNER_ACCUMULATION_LIMIT);
  payload.data.accumulationRankingMode = "accumulation_operational_v1";
  payload.data.accumulationRankingAppliedTo = ["accumulationCandidates"];
  payload.data.earlySurgeMode = "early_surge_v1";
  payload.data.accumulationRankingFallback = "accumulationRankScore > compressionScore > higherLowScore > vwapScore > rvol > stableChange > dataQuality";
  if (!Array.isArray(payload.data.underOneCandidates)) {
    const underOneRanked = ranked
      .filter((item) => {
        const price = parsePrice(item);
        const change = parseChange(item);
        return price !== null
          && price < 1
          && change !== null
          && change >= 0
          && !isRisky(item);
      })
      .slice(0, SCANNER_UNDER_ONE_LIMIT)
      .map((item) => ({
        ...item,
        ...buildUnderOneOperationalScore(item),
      }));
    payload.data.underOneCandidates = sortUnderOneCandidatesByOperationalRank(underOneRanked);
    payload.data.underOneRankingMode = "under_one_operational_v1";
    payload.data.underOneRankingAppliedTo = ["underOneCandidates"];
    payload.data.underOneRankingFallback = "operationalRankScore > experimentalRankScore > finalSelectionScore";
  }
  if (!Array.isArray(payload.data.overOneCandidates)) {
    const preferredStages = new Set(["EARLY_BREAKOUT", "PRE_SURGE", "MOMENTUM_EXPANSION"]);
    const preferred = ranked
      .filter((item) => {
        const price = parsePrice(item);
        const change = parseChange(item);
        const stage = String(item?.stage || "");
        return price !== null
          && price >= 1
          && change !== null
          && change >= 0
          && !isRisky(item)
          && preferredStages.has(stage)
          && !isVwapBelow(item);
      })
      .sort((a, b) => {
        const aChange = parseChange(a) ?? 0;
        const bChange = parseChange(b) ?? 0;
        const aPriority = (aChange >= 2 ? 1000 : 0) + (num(a?.marketPrioritySortScore) ?? num(a?.finalSelectionScore) ?? 0);
        const bPriority = (bChange >= 2 ? 1000 : 0) + (num(b?.marketPrioritySortScore) ?? num(b?.finalSelectionScore) ?? 0);
        return bPriority - aPriority;
      });
    payload.data.overOneCandidates = preferred.slice(0, SCANNER_OVER_ONE_LIMIT);
  }
  if (Array.isArray(payload.data.overOneCandidates)) {
    payload.data.overOneCandidates = payload.data.overOneCandidates.map((item) => ({
      ...item,
      ...buildOverOneOperationalScore(item),
    }));
    payload.data.overOneCandidates = sortOverOneCandidatesByOperationalRank(payload.data.overOneCandidates);
    payload.data.overOneRankingMode = "over_one_operational_v1";
    payload.data.overOneRankingAppliedTo = ["overOneCandidates"];
    payload.data.overOneRankingFallback = "operationalRankScore > experimentalRankScore > finalSelectionScore > marketPrioritySortScore";
  }
  if (!Array.isArray(payload.data.reboundWatchCandidates)) {
    payload.data.reboundWatchCandidates = ranked
      .filter((item) => {
        const price = parsePrice(item);
        const change = parseChange(item);
        return price !== null && price >= 1 && change !== null && change < 0;
      })
      .slice(0, SCANNER_REBOUND_WATCH_LIMIT);
  }
  payload.data.tradeBlockCandidates = sortTradeBlockCandidates(items.filter((item) => item.tradeGrouping === "TRADE_BLOCK"))
    .slice(0, SCANNER_TRADE_BLOCK_LIMIT);
  payload.data.reentryWatchCandidates = sortReentryWatchCandidates(items.filter((item) => item.tradeGrouping === "REENTRY_WATCH"))
    .slice(0, SCANNER_REENTRY_WATCH_LIMIT);
  payload.data.tradeGroupingMode = "trade_block_watchlist_v1";
  payload.data.tradeGroupingAppliedTo = ["tradeBlockCandidates", "reentryWatchCandidates"];
  payload.data.tradeGroupingFallback = "strict risk only for tradeBlock; vwap/reentry/volume wait for watchlist";
  if (!Array.isArray(payload.data.preMoveCandidates)) {
    payload.data.preMoveCandidates = [];
  }
  return payload;
}

function sanitizeScannerPayload(payload, { debug = false } = {}) {
  if (!payload || typeof payload !== "object") return payload;
  if (!payload.data || typeof payload.data !== "object") return payload;
  deriveScannerArrays(payload);
  const options = { debug };
  payload.data.items = sanitizeScannerList(payload.data.items, SCANNER_ITEM_LIMIT, options);
  payload.data.shortTermCandidates = sanitizeScannerList(payload.data.shortTermCandidates, SCANNER_SHORT_TERM_LIMIT, options);
  payload.data.underOneCandidates = sanitizeScannerList(payload.data.underOneCandidates, SCANNER_UNDER_ONE_LIMIT, options);
  payload.data.overOneCandidates = sanitizeScannerList(payload.data.overOneCandidates, SCANNER_OVER_ONE_LIMIT, options);
  payload.data.accumulationCandidates = sanitizeScannerList(payload.data.accumulationCandidates, SCANNER_ACCUMULATION_LIMIT, options);
  payload.data.preMoveCandidates = sanitizeScannerList(payload.data.preMoveCandidates, SCANNER_PRE_MOVE_LIMIT, options);
  payload.data.topPicks = sanitizeScannerList(payload.data.topPicks, SCANNER_TOP_PICKS_LIMIT, options);
  payload.data.reboundWatchCandidates = sanitizeScannerList(payload.data.reboundWatchCandidates, SCANNER_REBOUND_WATCH_LIMIT, options);
  payload.data.tradeBlockCandidates = sanitizeScannerList(payload.data.tradeBlockCandidates, SCANNER_TRADE_BLOCK_LIMIT, options);
  payload.data.reentryWatchCandidates = sanitizeScannerList(payload.data.reentryWatchCandidates, SCANNER_REENTRY_WATCH_LIMIT, options);
  return payload;
}

function isDebugScannerRequest(req) {
  const requestUrl = new URL(req?.url || "/api/scanner", "http://localhost");
  return requestUrl.searchParams.get("debug") === "1";
}
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BASELINE_SCANNER_VERSION = "baseline_before_filter_relax_v1";

function formatScannerDetails(details = {}) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function logScannerElapsed(step, elapsedMs, details = {}) {
  const detailText = formatScannerDetails(details);
  console.log(`[SCANNER] ${step} ${elapsedMs}ms${detailText ? ` ${detailText}` : ""}`);
}

function logScannerStep(step, startedAt, details = {}) {
  logScannerElapsed(step, Date.now() - startedAt, details);
}

function makeRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function headerValue(headers, name) {
  if (!headers) return "";
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function hasActualCatalyst(item = {}) {
  const sourceTags = Array.isArray(item.sourceTags) ? item.sourceTags : [];
  const storyTags = Array.isArray(item.storyTags) ? item.storyTags : [];
  if (sourceTags.some((tag) => /news|sec|8-k|filing|press/i.test(String(tag)))) return true;
  if (storyTags.length > 0) return true;
  return Boolean(item.newsTitle || item.newsUrl || item.catalyst || item.catalystTitle);
}

function hasUsableVolumeData(item = {}) {
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const trustedRawVolume = isTrustedCurrentVolumeSource(item.volumeSource) && rawVolume > 0;
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio) ?? num(item.rvol);
  return trustedRawVolume || (relativeVolume !== null && relativeVolume > 0);
}

function isSparseNoCatalystCandidate(item = {}) {
  const change = num(item.changePercent ?? item.preMarketChangePercent);
  return change !== null
    && Math.abs(change) <= 0.05
    && !hasUsableVolumeData(item)
    && !hasActualCatalyst(item);
}

function isPrimaryCommonStockCandidate(item = {}) {
  const symbol = String(item.symbol || "").toUpperCase();
  const name = String(item.companyName || item.name || item.shortName || item.longName || "");
  if (/\b(warrants?|units?|rights?|preferred|depositary share|depositary shares)\b/i.test(name)) return false;
  if (/\badr\b/i.test(name) && /\b(preferred|depositary|right|unit|warrant)\b/i.test(name)) return false;
  if (/^[A-Z]{1,4}(WS|WT)$/.test(symbol)) return false;
  if (/^[A-Z]{4,5}[WUR]$/.test(symbol)) return false;
  return true;
}

function getChangePenalty(changePercent) {
  const change = num(changePercent);
  if (change === null) return 0;
  if (change >= 80) return 70;
  if (change >= 50) return 55;
  if (change >= 25) return 40;
  if (change >= 15) return 28;
  if (change >= 10) return 20;
  if (change >= 8) return 12;
  if (change >= 5) return 5;
  return 0;
}

function classifyStageByMove({ changePercent, relativeVolume, rsi }) {
  const change = num(changePercent) ?? 0;
  const rvol = num(relativeVolume) ?? 0;
  const safeRsi = num(rsi) ?? 50;

  if (change >= 80 || safeRsi >= 95) return "OVERHEATED";
  if (change >= 25) return "CHASING_RISK";
  if (change >= 15) return "MOMENTUM_EXPANSION";
  if (change >= 8) return "EARLY_BREAKOUT";
  if (change >= -3 && change <= 8 && rvol >= 1.5) return "PRE_SURGE";
  if (change >= -5 && change <= 5 && rvol >= 1.1) return "ACCUMULATION";
  return "NEUTRAL";
}

function stageLabelKo(stage) {
  const labels = {
    ACCUMULATION: "매집 후보",
    PRE_SURGE: "급등 전 후보",
    EARLY_BREAKOUT: "초반 돌파",
    MOMENTUM_EXPANSION: "이미 상승 진행",
    CHASING_RISK: "추격 위험",
    OVERHEATED: "과열",
    NEUTRAL: "중립",
  };
  return labels[stage] || labels.NEUTRAL;
}

function riskLabelKo(stage) {
  const labels = {
    ACCUMULATION: "낮음",
    PRE_SURGE: "초입 후보",
    EARLY_BREAKOUT: "돌파 진행",
    MOMENTUM_EXPANSION: "상승 진행",
    CHASING_RISK: "추격 위험",
    OVERHEATED: "과열",
    NEUTRAL: "중립",
  };
  return labels[stage] || labels.NEUTRAL;
}

function withChangePenalty(score, changePenalty) {
  const base = num(score) ?? 0;
  return Math.round(clamp(base - (num(changePenalty) ?? 0)));
}

function buildStageMetadata(item) {
  const change = num(item?.changePercent) ?? num(item?.preMarketChangePercent) ?? 0;
  const rvol = num(item?.relativeVolume) ?? num(item?.volumeRatio) ?? 0;
  const rsi = num(item?.rsi) ?? num(item?.technical?.rsi) ?? 50;
  const stage = classifyStageByMove({ changePercent: change, relativeVolume: rvol, rsi });
  const changePenalty = getChangePenalty(change);
  const isPreSurgeCandidate = (stage === "ACCUMULATION" || stage === "PRE_SURGE") && change <= 10;
  const isChasingRisk = stage === "CHASING_RISK" || stage === "OVERHEATED";
  const isOverheated = stage === "OVERHEATED";
  return {
    stage,
    stageLabelKo: stageLabelKo(stage),
    riskLabelKo: riskLabelKo(stage),
    changePenalty,
    isPreSurgeCandidate,
    isChasingRisk,
    isOverheated,
  };
}

function cacheControlValue(ok) {
  const successSeconds = Math.round(SCANNER_SUCCESS_TTL_MS / 1000);
  const failureSeconds = Math.round(SCANNER_FAILURE_TTL_MS / 1000);
  return ok
    ? `public, max-age=0, s-maxage=${successSeconds}, stale-while-revalidate=${successSeconds}`
    : `public, max-age=0, s-maxage=${failureSeconds}, stale-while-revalidate=${failureSeconds}`;
}

function changePercentFromPreviousClose(price, previousClose) {
  const current = num(price);
  const prev = num(previousClose);
  if (current === null || prev === null || prev <= 0) return null;
  return ((current - prev) / prev) * 100;
}

function volumeStrength(item) {
  const trustedVolume = isTrustedCurrentVolumeSource(item.volumeSource);
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio);
  const previousVolumeRatio = num(item.previousDayVolumeRatio);
  const bestVolumeRatio = Math.max(relativeVolume ?? 0, previousVolumeRatio ?? 0);
  if (!trustedVolume && bestVolumeRatio <= 0) return 24;
  const rvolScore = bestVolumeRatio >= 8 ? 96
    : bestVolumeRatio >= 5 ? 86
      : bestVolumeRatio >= 3 ? 74
        : bestVolumeRatio >= 1.5 ? 60
          : bestVolumeRatio > 0 ? 42
            : 0;
  if (!trustedVolume) return clamp(Math.min(rvolScore, 45));
  const rawScore = rawVolume >= 20_000_000 ? 96
    : rawVolume >= 10_000_000 ? 86
      : rawVolume >= 5_000_000 ? 78
        : rawVolume >= 1_000_000 ? 65
          : 42;
  return clamp(Math.max(rvolScore, rawScore));
}

function volumeQualityScore(item) {
  const trustedVolume = isTrustedCurrentVolumeSource(item.volumeSource);
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio);
  const hasRawVolume = trustedVolume && rawVolume > 0;
  const hasRelativeVolume = relativeVolume !== null && relativeVolume > 0;
  const priceUsd = num(item.price) ?? num(item.preMarketPrice) ?? num(item.regularMarketPrice);
  const priceKrw = num(item.priceKrw);
  const usdKrw = num(item.usdKrw) ?? num(item.exchangeRate) ?? 1350;
  const tradeValueKrw = num(item.tradeValueKrw)
    ?? num(item.tradingValueKrw)
    ?? num(item.amountKrw)
    ?? num(item.dollarVolumeKrw)
    ?? (priceKrw !== null && rawVolume ? priceKrw * rawVolume : null)
    ?? (priceUsd !== null && rawVolume ? priceUsd * rawVolume * usdKrw : null);

  if (!hasRawVolume && !hasRelativeVolume) {
    return {
      score: 24,
      tradeValueKrw: null,
      volumeDataStatus: "missing",
    };
  }
  let score = hasRawVolume ? 50 : 32;
  if (!hasRawVolume && hasRelativeVolume) score += Math.min(relativeVolume * 4, 12);
  if ((relativeVolume ?? 0) >= 3 && rawVolume < 100_000) score -= 25;
  else if (rawVolume > 0 && rawVolume < 100_000) score -= 12;

  if (tradeValueKrw !== null) {
    if ((relativeVolume ?? 0) >= 3 && tradeValueKrw < 100_000_000) score -= 25;
    else if (tradeValueKrw < 100_000_000) score -= 12;
  }

  if (rawVolume >= 5_000_000) score += 24;
  else if (rawVolume >= 1_000_000) score += 14;
  else if (rawVolume >= 500_000) score += 8;
  else if (rawVolume >= 100_000) score += 4;

  if (tradeValueKrw !== null) {
    if (tradeValueKrw >= 1_000_000_000) score += 24;
    else if (tradeValueKrw >= 500_000_000) score += 15;
    else if (tradeValueKrw >= 100_000_000) score += 8;
  }

  return {
    score: Math.round(clamp(!hasRawVolume ? Math.min(score, 45) : score)),
    tradeValueKrw: tradeValueKrw !== null ? Math.round(tradeValueKrw) : null,
    volumeDataStatus: hasRawVolume && hasRelativeVolume ? "confirmed" : hasRawVolume ? "volume-only" : "rvol-only",
  };
}

function computeEarlyMomentumBonus(item, quality = {}, surgeAcceleration = {}, liveQuote = {}, commonSignals = {}) {
  const changePercent = num(liveQuote.changePercent) ?? num(item.changePercent) ?? num(item.preMarketChangePercent) ?? 0;
  if (changePercent < 10 || changePercent > 40) return 0;

  const rvol = num(liveQuote.relativeVolume) ?? num(liveQuote.volumeRatio) ?? num(item.relativeVolume) ?? num(item.volumeRatio) ?? 0;
  const rawVolume = Math.max(num(liveQuote.volume) ?? 0, num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const tradeValueKrw = num(quality.tradeValueKrw);
  const vwapState = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const vwap = num(item?.technical?.vwap ?? item?.vwap);
  const price = num(liveQuote.price) ?? num(item.price) ?? num(item.preMarketPrice) ?? num(item.regularMarketPrice) ?? 0;
  const vwapAbove = liveQuote.aboveVwap === true || item.aboveVwap === true || vwapState === "above" || ((num(commonSignals.vwapHoldMinutes) ?? 0) > 0) || (price > 0 && vwap > 0 && price >= vwap);
  const vwapNear = !vwapAbove && (vwapState === "near" || ((num(commonSignals.vwapReclaimScore) ?? 0) >= 58) || (price > 0 && vwap > 0 && price >= vwap * 0.985));
  const surgeScore = num(surgeAcceleration.surgeAccelerationScore) ?? 0;

  let bonus = 0;
  if (rvol >= 5) bonus += 2;
  else if (rvol >= 3) bonus += 1;
  if (vwapAbove || vwapNear) bonus += 2;
  if (surgeScore >= 72) bonus += 2;
  else if (surgeScore >= 58) bonus += 1;
  if ((tradeValueKrw !== null && tradeValueKrw >= 1_000_000_000) || rawVolume >= 5_000_000) bonus += 2;
  else if ((tradeValueKrw !== null && tradeValueKrw >= 300_000_000) || rawVolume >= 1_000_000) bonus += 1;
  if (changePercent >= 10 && changePercent <= 25) bonus += 1;

  return Math.max(0, Math.min(8, Math.round(bonus)));
}

function computeLiquidityMomentumBonus(item, quality = {}, surgeAcceleration = {}) {
  const qualityScore = num(quality.score) ?? 0;
  const surgeScore = num(surgeAcceleration.surgeAccelerationScore) ?? 0;
  const rvol = num(item.relativeVolume) ?? num(item.volumeRatio) ?? 0;
  let bonus = 0;
  if (qualityScore >= 80) bonus += 4;
  else if (qualityScore >= 68) bonus += 3;
  else if (qualityScore >= 58) bonus += 2;
  if (surgeScore >= 72) bonus += 2;
  else if (surgeScore >= 58) bonus += 1;
  if (rvol >= 5) bonus += 1;
  return Math.max(0, Math.min(6, Math.round(bonus)));
}

function computeForbiddenPenalty(verdict, chaseRisk = null) {
  const label = String(verdict ?? "");
  const risk = num(chaseRisk) ?? 0;
  if (label.includes("진입 금지") || label.includes("매매 금지") || label.includes("추격 금지") || label.includes("위험 과다")) {
    return risk >= 90 ? 18 : 14;
  }
  if (label.includes("금지")) return 12;
  return 0;
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

function pctFromBasis(price, basis) {
  const current = num(price);
  const base = num(basis);
  if (current === null || base === null || base <= 0) return null;
  return ((current - base) / base) * 100;
}

function isTrustedCurrentVolumeSource(source) {
  const text = String(source || "").toLowerCase();
  return text.includes("premarketvolume")
    || text.includes("postmarketvolume")
    || text.includes("regularmarketvolume")
    || text.includes("kis-tvol")
    || text.includes("kis-evol");
}

function sessionLabel(sessionType) {
  if (sessionType === "PRE") return "premarket";
  if (sessionType === "REGULAR") return "regular";
  if (sessionType === "AFTER") return "afterhours";
  if (sessionType === "DAY") return "daymarket";
  return "unknown";
}

function confidenceLabel(value) {
  if (value === "high") return "높음";
  if (value === "medium") return "보통";
  return "낮음";
}

function kstDate(date = new Date()) {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

function formatKstDateTime(date = new Date()) {
  const shifted = kstDate(date);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function extractItemRvol(item = {}) {
  return num(item?.rvol ?? item?.relativeVolume ?? item?.volumeRatio);
}

function resolveScannerMarketState(rawState, now = new Date()) {
  const raw = String(rawState || "").toUpperCase();
  if (raw === "PRE" || raw === "PREPRE" || raw === "PREMARKET") {
    return { marketState: "premarket", marketStateKo: "프리마켓" };
  }
  if (raw === "POST" || raw === "POSTPOST" || raw === "AFTER" || raw === "AFTERHOURS") {
    return { marketState: "afterhours", marketStateKo: "애프터마켓" };
  }
  if (raw === "REGULAR") {
    const parts = getKstParts(now);
    const totalMinutes = parts.hour * 60 + parts.minute;
    if (totalMinutes >= 22 * 60 + 30 && totalMinutes < 23 * 60) {
      return { marketState: "open_drive", marketStateKo: "장초반" };
    }
    return { marketState: "regular", marketStateKo: "장중" };
  }

  const parts = getKstParts(now);
  const totalMinutes = parts.hour * 60 + parts.minute;
  if (totalMinutes >= 17 * 60 && totalMinutes < 22 * 60 + 30) {
    return { marketState: "premarket", marketStateKo: "프리마켓" };
  }
  if (totalMinutes >= 22 * 60 + 30 && totalMinutes < 23 * 60) {
    return { marketState: "open_drive", marketStateKo: "장초반" };
  }
  if (totalMinutes >= 23 * 60 || totalMinutes < 5 * 60) {
    return { marketState: "regular", marketStateKo: "장중" };
  }
  if (totalMinutes >= 5 * 60 && totalMinutes < 9 * 60) {
    return { marketState: "afterhours", marketStateKo: "애프터마켓" };
  }
  return { marketState: "offhours", marketStateKo: "장외 대기" };
}

function hasIntradayFlowSignal(item = {}, commonSignals = {}) {
  const directKeys = [
    "momentum",
    "intradayFlow",
    "oneMinuteTrend",
    "threeMinuteTrend",
    "fiveMinuteTrend",
    "oneMinuteMomentum",
    "threeMinuteMomentum",
    "fiveMinuteMomentum",
  ];
  if (directKeys.some((key) => item?.[key] !== undefined && item?.[key] !== null && item?.[key] !== "")) {
    return true;
  }
  if (directKeys.some((key) => item?.technical?.[key] !== undefined && item?.technical?.[key] !== null && item?.technical?.[key] !== "")) {
    return true;
  }
  return [
    commonSignals?.vwapHoldMinutes,
    commonSignals?.vwapReclaimScore,
    commonSignals?.higherLowScore,
    commonSignals?.volumeTrendScore,
  ].some((value) => num(value) !== null);
}

function buildDataQuality(item = {}, commonSignals = {}) {
  const price = scannerLivePriceUsd(item);
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0, num(item.regularMarketVolume) ?? 0, num(item.postMarketVolume) ?? 0);
  const rvol = extractItemRvol(item);
  const tradeValueKrw = num(item.tradeValueKrw)
    ?? num(item.tradingValueKrw)
    ?? num(item.amountKrw)
    ?? (price !== null && rawVolume > 0 ? price * rawVolume * (num(item.usdKrw) ?? num(item.exchangeRate) ?? 1350) : null);
  const vwap = num(item.vwap) ?? num(item?.technical?.vwap);
  const hasPrice = price !== null && price > 0;
  const hasVolume = rawVolume > 0;
  const hasRelativeVolume = rvol !== null && rvol > 0;
  const hasTradeValue = tradeValueKrw !== null && tradeValueKrw > 0;
  const hasVwap = vwap !== null || item.aboveVwap === true || item.aboveVwap === false || num(item.vwapDistancePercent) !== null || num(item?.technical?.vwapDistancePercent) !== null;
  const hasIntradayFlow = hasIntradayFlowSignal(item, commonSignals);
  const missingFields = [];
  if (!hasPrice) missingFields.push("price");
  if (!hasVolume) missingFields.push("volume");
  if (!hasRelativeVolume) missingFields.push("relativeVolume");
  if (!hasTradeValue) missingFields.push("tradeValueKrw");
  if (!hasVwap) missingFields.push("vwap");
  if (!hasIntradayFlow) missingFields.push("intradayFlow");

  let reliability = "low";
  if (!hasPrice) reliability = "invalid";
  else if (hasVolume && hasRelativeVolume && hasTradeValue && (hasVwap || hasIntradayFlow)) reliability = "high";
  else if (hasVolume && hasTradeValue) reliability = "medium";

  const warningKo = reliability === "invalid"
    ? "가격 데이터가 없거나 0 이하입니다"
    : !hasIntradayFlow
      ? "1~5분 수급 데이터 부족"
      : missingFields.length
        ? `일부 데이터 누락: ${missingFields.join(", ")}`
        : null;

  return {
    hasPrice,
    hasVolume,
    hasRelativeVolume,
    hasTradeValue,
    hasVwap,
    hasIntradayFlow,
    reliability,
    reliabilityKo: reliability === "high" ? "높음" : reliability === "medium" ? "보통" : reliability === "invalid" ? "무효" : "낮음",
    missingFields,
    warningKo,
  };
}

function buildScannerMode(item = {}, now = new Date()) {
  const rvol = extractItemRvol(item);
  const state = resolveScannerMarketState(item.marketState ?? item.sessionType, now);
  if (rvol === null) {
    return {
      mode: "data_gap_watch",
      modeKo: "데이터 부족 관찰",
      reasonKo: `${state.marketStateKo} 구간이지만 RVOL 데이터가 없습니다`,
      marketState: state.marketState,
      marketStateKo: state.marketStateKo,
      rvol: null,
    };
  }
  if (rvol >= 5) {
    if (state.marketState === "premarket") {
      return {
        mode: "strong_premarket_signal",
        modeKo: "강력 선취매 모드",
        reasonKo: `RVOL ${rvol.toFixed(1)}배 + 프리마켓 거래량 집중`,
        marketState: state.marketState,
        marketStateKo: state.marketStateKo,
        rvol,
      };
    }
    if (state.marketState === "open_drive") {
      return {
        mode: "open_drive_breakout_signal",
        modeKo: "장초반 돌파 모드",
        reasonKo: `RVOL ${rvol.toFixed(1)}배 + 장초반 돌파 흐름`,
        marketState: state.marketState,
        marketStateKo: state.marketStateKo,
        rvol,
      };
    }
    if (state.marketState === "regular") {
      return {
        mode: "intraday_breakout_signal",
        modeKo: "장중 돌파 모드",
        reasonKo: `RVOL ${rvol.toFixed(1)}배 + 장중 거래량 재유입`,
        marketState: state.marketState,
        marketStateKo: state.marketStateKo,
        rvol,
      };
    }
    if (state.marketState === "afterhours") {
      return {
        mode: "afterhours_activation_signal",
        modeKo: "장후 활성 신호 모드",
        reasonKo: `RVOL ${rvol.toFixed(1)}배 + 애프터마켓 반응`,
        marketState: state.marketState,
        marketStateKo: state.marketStateKo,
        rvol,
      };
    }
  }
  if (rvol >= 2) {
    return {
      mode: "watchlist_strengthened",
      modeKo: "관찰 강화 모드",
      reasonKo: `RVOL ${rvol.toFixed(1)}배로 감시는 필요하지만 확정 신호 단계는 아닙니다`,
      marketState: state.marketState,
      marketStateKo: state.marketStateKo,
      rvol,
    };
  }
  return {
    mode: "watchlist_pending",
    modeKo: "관찰 대기",
    reasonKo: `RVOL ${rvol.toFixed(1)}배로 추가 거래량 확인이 필요합니다`,
    marketState: state.marketState,
    marketStateKo: state.marketStateKo,
    rvol,
  };
}

function buildSignalLifecycle(item = {}, scannerMode = {}, now = new Date()) {
  const signalCreatedAt = new Date(now.getTime());
  let validUntil = null;
  let noteKo = "관찰 대기 상태입니다";

  if (scannerMode.mode === "strong_premarket_signal") {
    const shifted = kstDate(signalCreatedAt);
    shifted.setUTCHours(22, 45, 0, 0);
    validUntil = new Date(shifted.getTime() - KST_OFFSET_MS);
    noteKo = "장 시작 후 15분까지 유효";
  } else if (scannerMode.mode === "open_drive_breakout_signal") {
    validUntil = addMinutes(signalCreatedAt, 15);
    noteKo = "발생 후 15분 유효";
  } else if (scannerMode.mode === "intraday_breakout_signal") {
    validUntil = addMinutes(signalCreatedAt, 20);
    noteKo = "발생 후 20분 유효";
  } else if (scannerMode.mode === "afterhours_activation_signal") {
    validUntil = addMinutes(signalCreatedAt, 15);
    noteKo = "발생 후 15분 유효";
  }

  const active = validUntil && validUntil.getTime() >= now.getTime();
  const inactive = !validUntil;
  const status = inactive ? "standby" : active ? "active" : "expired";
  const statusKo = inactive ? "관찰 대기" : active ? "유효" : "유효 시간 초과";
  const symbol = String(item.symbol || "UNKNOWN").toUpperCase();
  const signalId = `${symbol}-${formatKstDateTime(signalCreatedAt).replace(/[-: ]/g, "").slice(0, 12)}`;

  return {
    signalId,
    signalCreatedAtKst: formatKstDateTime(signalCreatedAt),
    signalMode: scannerMode.mode,
    signalModeKo: scannerMode.modeKo,
    validUntilKst: validUntil ? formatKstDateTime(validUntil) : null,
    status,
    statusKo,
    noteKo,
  };
}

function buildScoreReasons(item = {}, dataQuality = {}, scannerMode = {}, signalLifecycle = {}, topPickEvaluation = {}) {
  const reasons = [];
  const tradeValueKrw = num(item.tradeValueKrw);
  const rvol = extractItemRvol(item);
  const vwap = num(item.vwap) ?? num(item?.technical?.vwap);
  const price = scannerLivePriceUsd(item);
  const riskScore = num(item.riskScore) ?? num(topPickEvaluation.topPickChaseRisk);
  const changePercent = num(item.changePercent) ?? num(item.preMarketChangePercent);

  if (tradeValueKrw !== null) {
    reasons.push({
      type: "positive",
      labelKo: "거래대금 증가",
      valueKo: `${Math.round(tradeValueKrw / 100000000) / 10}억`,
    });
  }
  if (rvol !== null) {
    reasons.push({
      type: "positive",
      labelKo: `RVOL ${rvol.toFixed(1)}배`,
      valueKo: scannerMode.mode.includes("watch") ? "관찰" : "강화",
    });
  }
  if (price !== null && vwap !== null) {
    reasons.push({
      type: price >= vwap ? "positive" : "negative",
      labelKo: price >= vwap ? "VWAP 위 유지" : "VWAP 아래 위치",
      valueKo: price >= vwap ? "유지" : "주의",
    });
  }
  if (changePercent !== null && Math.abs(changePercent) >= 8) {
    reasons.push({
      type: changePercent > 0 ? "positive" : "negative",
      labelKo: `등락률 ${changePercent >= 0 ? "+" : ""}${changePercent.toFixed(1)}%`,
      valueKo: Math.abs(changePercent) >= 15 ? "강함" : "반응",
    });
  }
  if (riskScore !== null && riskScore >= 70) {
    reasons.push({
      type: "negative",
      labelKo: "단기 과열 위험",
      valueKo: `${Math.round(riskScore)}점`,
    });
  }
  if (dataQuality.warningKo) {
    reasons.push({
      type: "warning",
      labelKo: dataQuality.warningKo,
      valueKo: signalLifecycle.status === "active" ? "주의" : "관찰",
    });
  }

  return reasons.slice(0, 6);
}

function buildBaselineAudit(now = new Date()) {
  return {
    scannerVersion: BASELINE_SCANNER_VERSION,
    generatedAtKst: formatKstDateTime(now),
    purposeKo: "필터 완화 전 현재 기준 성능 기록용",
    filterChanged: false,
  };
}

function getKstParts(date) {
  const shifted = kstDate(date);
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

function barAmount(bar) {
  return positive(bar?.tradeAmount) ?? positive(bar?.amount);
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== null && value !== undefined),
  );
}

async function invokeLocalHandler(handler, path, headers = {}) {
  let statusCode = 200;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const req = { url: path, method: "GET", headers };
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      if (!settled) {
        settled = true;
        resolveResult({ statusCode, headers: this.headers, body });
      }
      return this;
    },
  };

  Promise.resolve(handler(req, res))
    .then((body) => {
      if (!settled) {
        settled = true;
        resolveResult({ statusCode, headers: res.headers, body });
      }
    })
    .catch((error) => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    });

  return resultPromise;
}

async function fetchLocalQuoteSnapshot(symbol, requestId) {
  if (!symbol) return {};
  try {
    const result = await invokeLocalHandler(
      quoteHandler,
      `/api/quote?symbol=${encodeURIComponent(symbol)}`,
      { "x-kis-caller": "scanner", "x-request-id": requestId },
    );
    if (result?.statusCode !== 200 || result?.body?.ok !== true || !result?.body?.data) return {};
    return result.body.data;
  } catch {
    return {};
  }
}

async function fetchLocalHistorySnapshot(symbol, interval = "1m", requestId) {
  if (!symbol) return {};
  try {
    const result = await invokeLocalHandler(
      historyHandler,
      `/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      { "x-kis-caller": "scanner", "x-request-id": requestId },
    );
    if (result?.statusCode !== 200 || result?.body?.ok !== true || !result?.body?.data) return {};
    return result.body.data;
  } catch {
    return {};
  }
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

function calculateVolumeAcceleration(bars, source = null) {
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
    volumeAccelerationSource: source,
    volumeAccelerationStatus: availableScores.length ? "ok" : "데이터 부족",
  };
}

function calculateSurgeAccelerationScore(bars, item = {}, liveQuote = {}, commonSignals = {}) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return {
      surgeAccelerationScore: 0,
      volumeAcceleration5mWindow: null,
      tradeValueAcceleration5mWindow: null,
    };
  }

  const windowStats = (items) => {
    const clean = items
      .map((bar) => ({
        close: positive(bar.close),
        volume: positive(bar.volume),
      }))
      .filter((bar) => bar.close !== null && bar.volume !== null);
    if (clean.length < 5) return { volume: null, tradeValue: null };
    return {
      volume: sum(clean.map((bar) => bar.volume)),
      tradeValue: sum(clean.map((bar) => bar.close * bar.volume)),
    };
  };
  const current = windowStats(bars.slice(-5));
  const prior = windowStats(bars.slice(-20, -15));
  const minVolumeDenominator = 10_000;
  const minTradeValueDenominator = 10_000;
  const volumeAcceleration5mWindow = current.volume !== null && prior.volume !== null && prior.volume >= minVolumeDenominator
    ? current.volume / prior.volume
    : null;
  const tradeValueAcceleration5mWindow = current.tradeValue !== null && prior.tradeValue !== null && prior.tradeValue >= minTradeValueDenominator
    ? current.tradeValue / prior.tradeValue
    : null;
  const accelerationPoints = (value) => {
    if (value === null) return 0;
    if (value >= 5) return 35;
    if (value >= 3) return 25;
    if (value >= 2) return 15;
    if (value >= 1.3) return 8;
    return 0;
  };

  const relativeVolume = num(liveQuote.relativeVolume) ?? num(liveQuote.volumeRatio) ?? num(item.relativeVolume) ?? num(item.volumeRatio);
  const aboveVwap = liveQuote.aboveVwap === true || item.aboveVwap === true || (num(commonSignals.vwapHoldMinutes) ?? 0) > 0 || (num(commonSignals.vwapReclaimScore) ?? 0) >= 58;
  const higherLow = (num(commonSignals.higherLowScore) ?? num(item.higherLowScore) ?? 50) >= 58;
  const trendText = String(liveQuote.oneMinuteTrend || item.oneMinuteTrend || item.technical?.oneMinuteTrend || "").toLowerCase();
  const oneMinuteUp = trendText.includes("up") || trendText.includes("상승");
  const changePercent = num(liveQuote.changePercent) ?? num(item.changePercent) ?? num(item.preMarketChangePercent);
  const rsi = num(liveQuote.rsi) ?? num(item.rsi) ?? num(item.technical?.rsi);

  let score = accelerationPoints(volumeAcceleration5mWindow) + accelerationPoints(tradeValueAcceleration5mWindow);
  if (relativeVolume !== null) score += relativeVolume >= 5 ? 15 : relativeVolume >= 3 ? 10 : 0;
  if (aboveVwap) score += 5;
  if (higherLow) score += 5;
  if (oneMinuteUp) score += 5;
  if ((changePercent ?? 0) >= 80) score -= 20;
  if ((rsi ?? 0) >= 88) score -= 15;

  return {
    surgeAccelerationScore: Math.round(clamp(score)),
    volumeAcceleration5mWindow,
    tradeValueAcceleration5mWindow,
  };
}

function scannerTopPickItemField(item, key) {
  return num(item?.[key]) ?? num(item?.technical?.[key]);
}

function scannerTopPickLivePrice(item) {
  return num(item?.normalizedLivePriceUsd)
    ?? num(item?.price)
    ?? num(item?.preMarketPrice)
    ?? num(item?.postMarketPrice)
    ?? num(item?.regularMarketPrice);
}

function scannerTopPickRvol(item) {
  return num(item?.volumeRatio ?? item?.relativeVolume);
}

function topPickSetupProfile(item, price, change) {
  const rvol = scannerTopPickRvol(item);
  const rsi = num(item?.rsi ?? item?.technical?.rsi);
  const dayHigh = num(item?.dayHigh ?? item?.regularMarketDayHigh);
  const dayLow = num(item?.dayLow ?? item?.regularMarketDayLow);
  const vwap = num(item?.technical?.vwap ?? item?.vwap);
  const vwapState = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const highPullbackPct = price > 0 && dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : null;
  const highPosition = price > 0 && dayHigh > 0 && dayLow > 0 && dayHigh > dayLow
    ? ((price - dayLow) / (dayHigh - dayLow)) * 100
    : null;
  const vwapAbove = item?.aboveVwap === true || vwapState === "above" || (price > 0 && vwap > 0 && price >= vwap);
  const vwapNear = !vwapAbove && price > 0 && vwap > 0 && price >= vwap * 0.985;
  const vwapBelow = item?.aboveVwap === false || vwapState === "below" || (price > 0 && vwap > 0 && price < vwap * 0.985);
  const volumeAcceleration = num(item?.volumeAccelerationScore) ?? 50;
  const higherLow = num(item?.higherLowScore) ?? 50;
  const resurge = num(item?.reSurgeSetupScore) ?? 50;
  const reclaim = num(item?.vwapReclaimScore) ?? 50;

  const overheated = change >= 80 || (rsi !== null && rsi >= 80 && change >= 20);
  const veryExtended = change >= 120 || (highPosition !== null && highPosition >= 88 && change >= 60);
  const highFailed = highPullbackPct !== null && highPullbackPct >= 18 && change >= 25;
  const extremeRvolWeak = rvol !== null && rvol >= 8 && highPullbackPct !== null && highPullbackPct >= 22 && !vwapAbove;
  const lowRecovery = highPosition !== null && highPosition >= 15 && highPosition <= 70;
  const notOverChased = change >= 1 && change <= 45;
  const volumeStarting = rvol !== null && rvol >= 3;
  const vwapRecovering = vwapAbove || vwapNear || reclaim >= 60;

  const earlyBonus = Math.max(0, Math.min(14, Math.round(
    (volumeStarting ? 3 : 0)
    + (volumeAcceleration >= 65 ? 2 : 0)
    + (notOverChased ? 3 : change <= 70 ? 1 : 0)
    + (vwapRecovering ? 3 : 0)
    + (higherLow >= 65 ? 2 : 0)
    + (resurge >= 65 ? 2 : 0)
    + (lowRecovery ? 2 : 0),
  )));
  const riskPenalty = Math.max(0, Math.min(32, Math.round(
    (overheated ? 12 : 0)
    + (veryExtended ? 10 : 0)
    + (highFailed ? 8 : 0)
    + (extremeRvolWeak ? 10 : 0)
    + (vwapBelow && change < 0 ? 8 : 0),
  )));

  return {
    rvol,
    rsi,
    vwapAbove,
    vwapNear,
    vwapBelow,
    volumeAcceleration,
    higherLow,
    resurge,
    reclaim,
    earlyBonus,
    riskPenalty,
    overheated,
    highFailed,
    extremeRvolWeak,
    volumeStarting,
    vwapRecovering,
  };
}

function topPickSignalScore(item, price, volume, change) {
  const setup = topPickSetupProfile(item, price, change);
  const volumeAcceleration = num(item?.volumeAccelerationScore) ?? 50;
  const higherLow = num(item?.higherLowScore) ?? 50;
  const vwapHold = num(item?.vwapHoldScore) ?? 50;
  const compression = num(item?.compressionScore) ?? 50;
  const resurge = num(item?.reSurgeSetupScore) ?? 50;
  const reclaim = num(item?.vwapReclaimScore) ?? 50;
  const volumeBonus = volume >= 5_000_000 ? 14 : volume >= 1_000_000 ? 8 : 0;
  const changeBonus = change >= 4 && change <= 35 ? 8 : change > 35 && change <= 60 ? 3 : change >= 80 ? -8 : 0;
  const rawSignalBonus =
    (volumeAcceleration - 50) * 0.03
    + (higherLow - 50) * 0.025
    + (vwapHold - 50) * 0.025
    + (compression - 50) * 0.03
    + (resurge - 50) * 0.04
    + (reclaim - 50) * 0.025
    + (setup.rvol !== null && setup.rvol >= 3 ? 1 : 0)
    + setup.earlyBonus
    - setup.riskPenalty;
  const signalBonus = Math.max(-32, Math.min(14, Math.round(rawSignalBonus)));
  return { signalBonus, volumeBonus, changeBonus, rvol: setup.rvol, setup };
}

function computeTopPickChaseRisk(item, setup, change, risk) {
  const trendRaw = String(item?.oneMinuteTrend ?? item?.technical?.oneMinuteTrend ?? "").toLowerCase();
  const trendGood = trendRaw.includes("up") || trendRaw.includes("상승") || item?.technical?.ma5vs20 === "above";
  const vwapGood = setup.vwapAbove || setup.vwapNear || setup.vwapRecovering;
  return Math.round(clamp(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
      + setup.riskPenalty * 0.8,
  ));
}

function computeTopPickGrade(score) {
  const value = num(score) ?? 0;
  if (value >= 85) return "S";
  if (value >= 75) return "A";
  if (value >= 65) return "B";
  if (value >= 55) return "C";
  return "D";
}

function rvolScore(value) {
  const rvol = num(value) ?? 0;
  return rvol >= 8 ? 96
    : rvol >= 5 ? 86
      : rvol >= 3 ? 74
        : rvol >= 1.5 ? 58
          : rvol > 0 ? 38
            : 24;
}

function changeConfirmationScore(change) {
  const value = num(change) ?? 0;
  if (value >= 80) return 18;
  if (value >= 45) return 42;
  if (value >= 18) return 78;
  if (value >= 4) return 88;
  if (value >= 0) return 58;
  return value <= -20 ? 18 : 34;
}

function calculateQuantitativeScore(item, setup = {}, quality = {}, surgeAcceleration = {}, chaseRisk = 0) {
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const rvol = scannerTopPickRvol(item);
  const finalProbability = num(item?.finalProbabilityScore ?? item?.scannerScore) ?? 50;
  const acceleration = num(surgeAcceleration.surgeAccelerationScore ?? item?.surgeAccelerationScore) ?? 50;
  const accumulation = num(item?.reSurgeSetupScore) ?? setup.resurge ?? 50;
  const breakoutReady = num(item?.compressionScore) ?? setup.compression ?? 50;
  const higherLow = num(item?.higherLowScore) ?? setup.higherLow ?? 50;
  const vwapScore = setup.vwapAbove ? 90 : setup.vwapNear || setup.vwapRecovering ? 72 : setup.vwapBelow ? 28 : 50;
  const pullbackScore = setup.highPullbackPct === null || setup.highPullbackPct === undefined
    ? 50
    : setup.highPullbackPct <= 4 ? 86
      : setup.highPullbackPct <= 12 ? 74
        : setup.highPullbackPct <= 22 ? 52
          : 28;
  const overheatGuard = 100 - Math.max(0, Math.min(100, chaseRisk));

  const score =
    finalProbability * 0.20
    + acceleration * 0.16
    + accumulation * 0.13
    + breakoutReady * 0.11
    + rvolScore(rvol) * 0.10
    + higherLow * 0.10
    + vwapScore * 0.08
    + pullbackScore * 0.06
    + changeConfirmationScore(change) * 0.04
    + overheatGuard * 0.02;
  return Math.round(clamp(score));
}

function calculateVolumeConfirmationScore(item, quality = {}, surgeAcceleration = {}) {
  const qualityScore = num(quality.score ?? item?.volumeQualityScore) ?? 50;
  const acceleration = num(surgeAcceleration.surgeAccelerationScore ?? item?.surgeAccelerationScore ?? item?.volumeAccelerationScore) ?? 50;
  const rvol = scannerTopPickRvol(item);
  return Math.round(clamp(qualityScore * 0.55 + acceleration * 0.30 + rvolScore(rvol) * 0.15));
}

function finalSelectionBadge(score) {
  const value = num(score) ?? 0;
  if (value >= 90) return "최우선";
  if (value >= 75) return "매수 후보";
  if (value >= 70) return "빠른 확인";
  if (value >= 50) return "관찰";
  return "제외 후보";
}

function selectionGroupRank(group) {
  const label = String(group || "");
  if (label === "상단 후보") return 0;
  if (label === "거래량 미확인") return 1;
  if (label === "관찰 필요") return 2;
  if (label === "차트 구조 미흡") return 3;
  if (label === "진입 부적합") return 4;
  if (label === "추격 위험") return 5;
  return 2;
}

function classifySelectionGroup(item, finalSelectionScore, chartPatternScore, chaseRisk, setup = {}, entrySuitability = null) {
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const rvol = scannerTopPickRvol(item);
  const volume = Math.max(num(item?.volume) ?? 0, num(item?.preMarketVolume) ?? 0, num(item?.regularMarketVolume) ?? 0);
  if (change >= 80 || chaseRisk >= 80 || setup.overheated) return "추격 위험";
  if ((num(entrySuitability) ?? 50) < 30) return "진입 부적합";
  if (chartPatternScore < 40) return "차트 구조 미흡";
  if (rvol === null && volume <= 0) return "거래량 미확인";
  if (finalSelectionScore < 50) return "관찰 필요";
  if (change <= -20 && !setup.lowRecovery && !setup.vwapRecovering) return "관찰 필요";
  return "상단 후보";
}

function buildFinalSelectionScores(item, setup = {}, quality = {}, surgeAcceleration = {}, entrySuitability = null) {
  const chaseRisk = computeTopPickChaseRisk(
    item,
    setup,
    num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0,
    Math.round(num(item?.riskScore) ?? 50),
  );
  const chartPatternScore = Math.round(num(item?.chartPatternScore ?? item?.patternSimilarityScore) ?? 50);
  const quantitativeScore = calculateQuantitativeScore(item, setup, quality, surgeAcceleration, chaseRisk);
  const volumeConfirmationScore = calculateVolumeConfirmationScore(item, quality, surgeAcceleration);
  const finalSelectionScore = Math.round(clamp(
    quantitativeScore * 0.50
      + chartPatternScore * 0.25
      + volumeConfirmationScore * 0.15
      - chaseRisk * 0.10,
  ));
  const selectionGroup = classifySelectionGroup(item, finalSelectionScore, chartPatternScore, chaseRisk, setup, entrySuitability);
  return {
    quantitativeScore,
    chartPatternScore,
    volumeConfirmationScore,
    finalSelectionScore,
    chaseRisk,
    selectionGroup,
    statusBadge: finalSelectionBadge(finalSelectionScore),
  };
}

function evaluateTopPickForSnapshot(item) {
  const price = scannerTopPickLivePrice(item) ?? 0;
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const volume = num(item?.volume ?? item?.preMarketVolume) ?? 0;
  const surge = Math.round(num(item?.finalProbabilityScore ?? item?.scannerScore) ?? 0);
  const risk = Math.round(num(item?.riskScore) ?? 50);
  const pattern = Math.round(num(item?.chartPatternScore ?? item?.patternSimilarityScore) ?? 50);
  const signal = topPickSignalScore(item, price, volume, change);
  const changePenalty = num(item?.changePenalty) ?? getChangePenalty(change);
  const baseScore = surge * 0.55 + pattern * 0.2 + signal.volumeBonus + signal.changeBonus - risk * 0.12 - changePenalty;
  const setup = signal.setup;
  const chaseRisk = computeTopPickChaseRisk(item, setup, change, risk);
  const entrySuitability = Math.round(clamp(baseScore + signal.signalBonus));
  const selectionScores = buildFinalSelectionScores(item, setup, { score: item?.volumeQualityScore }, {
    surgeAccelerationScore: item?.surgeAccelerationScore,
  }, entrySuitability);
  const finalScore = selectionScores.finalSelectionScore;
  const reasonCodes = [];

  if (setup.overheated) reasonCodes.push("overheated");
  if (setup.highFailed) reasonCodes.push("highFailed");
  if (setup.extremeRvolWeak) reasonCodes.push("extremeRvolWeak");
  if (risk >= 78) reasonCodes.push("riskHigh");
  if (finalScore < 58) reasonCodes.push("scoreWeak");

  let verdict = "관찰";
  if (setup.overheated || setup.highFailed || setup.extremeRvolWeak || risk >= 78 || finalScore < 58) {
    verdict = "진입 금지";
  } else if (finalScore >= 74 && setup.volumeStarting && setup.vwapRecovering && !setup.vwapBelow && risk < 70) {
    verdict = "매수 가능";
    reasonCodes.push("buySetup");
  } else {
    reasonCodes.push("watchSetup");
  }

  return {
    topPickVerdict: verdict,
    topPickFinalScore: entrySuitability,
    topPickDisplayFinalScore: finalScore,
    topPickChaseRisk: chaseRisk,
    changePenalty,
    topPickVerdictReasonCodes: reasonCodes,
    topPickGrade: computeTopPickGrade(finalScore),
    quantitativeScore: selectionScores.quantitativeScore,
    chartPatternScore: selectionScores.chartPatternScore,
    patternName: item.bestPatternName ?? item.patternName ?? (selectionScores.chartPatternScore <= 0 ? "데이터 부족" : "패턴 약함"),
    volumeConfirmationScore: selectionScores.volumeConfirmationScore,
    finalSelectionScore: selectionScores.finalSelectionScore,
    entrySuitability,
    chaseRisk,
    rvol: scannerTopPickRvol(item),
    selectionGroup: selectionScores.selectionGroup,
    statusBadge: selectionScores.statusBadge,
    changePenalty,
  };
}

function preMoveLabelKo(stage) {
  const labels = {
    COMPRESSION_BUILD: "가격 압축 예열",
    VWAP_RECLAIM: "VWAP 회복 예열",
    PRE_MOVE_READY: "급등 전 준비",
    QUIET_ACCUMULATION: "조용한 매집",
  };
  return labels[stage] || "오르기 전 후보";
}

function scannerItemPrice(item) {
  return num(item?.price)
    ?? num(item?.normalizedLivePriceUsd)
    ?? num(item?.preMarketPrice)
    ?? num(item?.postMarketPrice)
    ?? num(item?.regularMarketPrice);
}

function scannerItemVolume(item) {
  return Math.max(
    num(item?.volume) ?? 0,
    num(item?.preMarketVolume) ?? 0,
    num(item?.regularMarketVolume) ?? 0,
    num(item?.postMarketVolume) ?? 0,
  );
}

function scannerItemRelativeVolume(item) {
  return num(item?.relativeVolume) ?? num(item?.volumeRatio) ?? num(item?.rvol);
}

function scannerItemVwap(item) {
  return num(item?.vwap) ?? num(item?.technical?.vwap);
}

function vwapDistancePercent(item) {
  const price = scannerItemPrice(item);
  const vwap = scannerItemVwap(item);
  if (price === null || vwap === null || vwap <= 0) return null;
  return ((price - vwap) / vwap) * 100;
}

function compressionSignalScore(item) {
  const direct = num(item?.compressionScore)
    ?? num(item?.boxCompression)
    ?? num(item?.volatilityContraction)
    ?? num(item?.technical?.compressionScore)
    ?? num(item?.technical?.boxCompression)
    ?? num(item?.technical?.volatilityContraction);
  if (direct !== null) return clamp(direct);

  const price = scannerItemPrice(item);
  const dayHigh = num(item?.dayHigh) ?? num(item?.regularMarketDayHigh);
  const dayLow = num(item?.dayLow) ?? num(item?.regularMarketDayLow);
  if (price !== null && dayHigh !== null && dayLow !== null && price > 0 && dayHigh >= dayLow) {
    const rangePercent = ((dayHigh - dayLow) / price) * 100;
    if (rangePercent <= 3) return 88;
    if (rangePercent <= 5) return 76;
    if (rangePercent <= 8) return 62;
    if (rangePercent <= 12) return 48;
    return 34;
  }

  return 50;
}

function higherLowSignalScore(item) {
  return clamp(
    num(item?.higherLowScore)
    ?? num(item?.technical?.higherLowScore)
    ?? 50,
  );
}

function preMovePriceScore(change) {
  if (change <= 0) return 23;
  if (change <= 1.5) return 25;
  if (change <= 3) return 22;
  if (change <= 5) return 16;
  if (change <= 8) return 10;
  return 0;
}

function preMoveVolumeWarmupScore(relativeVolume) {
  if (relativeVolume < 1.2) return 0;
  if (relativeVolume <= 1.8) return 18;
  if (relativeVolume <= 2.8) return 25;
  if (relativeVolume <= 4) return 22;
  if (relativeVolume <= 6) return 14;
  if (relativeVolume <= 8) return 6;
  return 0;
}

function preMoveVwapScore(item, distancePercent) {
  const state = String(item?.vwapState ?? item?.technical?.vwapState ?? "").toLowerCase();
  const aboveVwap = item?.aboveVwap === true || state === "above" || (distancePercent !== null && distancePercent >= 0);
  const nearVwap = state === "near" || (distancePercent !== null && distancePercent >= -2 && distancePercent <= 3);
  const reclaimScore = num(item?.vwapReclaimScore) ?? num(item?.technical?.vwapReclaimScore) ?? 0;
  if (aboveVwap && nearVwap) return 20;
  if (nearVwap || reclaimScore >= 65) return 18;
  if (aboveVwap) return 15;
  if (distancePercent !== null && distancePercent >= -3 && distancePercent <= 4) return 12;
  return 5;
}

function preMoveStageOf(item, change, relativeVolume, compressionScore, distancePercent) {
  const state = String(item?.vwapState ?? item?.technical?.vwapState ?? "").toLowerCase();
  const aboveVwap = item?.aboveVwap === true || state === "above" || (distancePercent !== null && distancePercent >= 0);
  const nearVwap = state === "near" || (distancePercent !== null && distancePercent >= -2 && distancePercent <= 3);
  if (change <= 3 && compressionScore >= 68) return "COMPRESSION_BUILD";
  if (nearVwap || aboveVwap || (num(item?.vwapReclaimScore) ?? num(item?.technical?.vwapReclaimScore) ?? 0) >= 60) {
    return "VWAP_RECLAIM";
  }
  if (relativeVolume >= 1.5 && relativeVolume <= 4 && change <= 5) return "PRE_MOVE_READY";
  return "QUIET_ACCUMULATION";
}

function buildPreMoveReasons(item, metrics = {}) {
  const reasons = [];
  const change = num(metrics.changePercent) ?? 0;
  const relativeVolume = num(metrics.relativeVolume) ?? 0;
  const compressionScore = num(metrics.compressionScore) ?? 0;
  const higherLowScore = num(metrics.higherLowScore) ?? 0;
  const distancePercent = num(metrics.vwapDistancePercent);
  const stage = String(metrics.preMoveStage || "");

  if (change <= 3) reasons.push(`상승률 ${change.toFixed(1)}%로 아직 초기 구간`);
  else reasons.push(`상승률 ${change.toFixed(1)}%로 과열 전 구간 유지`);

  if (relativeVolume >= 1.2) reasons.push(`상대거래량 ${relativeVolume.toFixed(1)}배로 거래량 예열`);
  if (stage === "COMPRESSION_BUILD" || compressionScore >= 68) reasons.push(`압축 점수 ${Math.round(compressionScore)}점으로 박스권 응축`);
  if (stage === "VWAP_RECLAIM" || (distancePercent !== null && distancePercent >= -2 && distancePercent <= 3)) {
    reasons.push(distancePercent !== null ? `VWAP 대비 ${distancePercent >= 0 ? "+" : ""}${distancePercent.toFixed(1)}% 구간` : "VWAP 근처에서 회복 시도");
  }
  if (higherLowScore >= 60) reasons.push(`Higher Low ${Math.round(higherLowScore)}점`);

  return reasons.slice(0, 3);
}

function buildPreMoveCandidate(item) {
  if (!item || !item.symbol) return null;

  const change = num(item.changePercent) ?? num(item.preMarketChangePercent);
  const price = scannerItemPrice(item);
  const volume = scannerItemVolume(item);
  const relativeVolume = scannerItemRelativeVolume(item);
  const stage = String(item.stage || "");
  const riskScore = num(item.riskScore) ?? 50;

  if (change === null || price === null || price <= 0) return null;
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (relativeVolume === null || !Number.isFinite(relativeVolume)) return null;
  if (change < -3 || change > 8) return null;
  if (change > 10) return null;
  if (relativeVolume < 1.2 || relativeVolume > 6) return null;
  const preMoveRangeAudit = deriveRangeAuditFields(item);
  if (preMoveRangeAudit.highDropPercent !== null && preMoveRangeAudit.highDropPercent >= 12) return null;
  if (item.isOverheated === true || item.isChasingRisk === true) return null;
  if (stage === "OVERHEATED" || stage === "CHASING_RISK") return null;

  const allowedStage = stage === "PRE_SURGE" || stage === "ACCUMULATION" || stage === "NEUTRAL";
  if (!allowedStage) return null;
  if (stage === "NEUTRAL" && (num(item.scannerScore) ?? 0) < 45) return null;

  const distancePercent = vwapDistancePercent(item);
  const compressionScore = compressionSignalScore(item);
  const higherLowScore = higherLowSignalScore(item);
  const priceScore = preMovePriceScore(change);
  const volumeScore = preMoveVolumeWarmupScore(relativeVolume);
  const vwapScore = preMoveVwapScore(item, distancePercent);
  const compressionPoints = Math.round((compressionScore / 100) * 15);
  const higherLowPoints = Math.round((higherLowScore / 100) * 10);
  const stageBonus = stage === "PRE_SURGE" ? 6 : stage === "ACCUMULATION" ? 4 : 2;
  let penalty = 0;
  if (change > 8) penalty += 15;
  if (relativeVolume > 8) penalty += 10;
  if (riskScore >= 80) penalty += 15;
  else if (riskScore >= 70) penalty += 10;
  else if (riskScore >= 60) penalty += 5;

  const preMoveScore = Math.round(clamp(
    priceScore
      + volumeScore
      + vwapScore
      + compressionPoints
      + higherLowPoints
      + stageBonus
      - penalty,
  ));

  if (preMoveScore < 45) return null;

  const preMoveStage = preMoveStageOf(item, change, relativeVolume, compressionScore, distancePercent);
  const preMoveLabel = preMoveLabelKo(preMoveStage);
  const reasons = buildPreMoveReasons(item, {
    changePercent: change,
    relativeVolume,
    compressionScore,
    higherLowScore,
    vwapDistancePercent: distancePercent,
    preMoveStage,
  });

  return {
    symbol: item.symbol,
    name: item.name || item.symbol,
    price,
    changePercent: change,
    volume,
    relativeVolume,
    stage,
    stageLabelKo: item.stageLabelKo || stageLabelKo(stage),
    riskLabelKo: item.riskLabelKo || riskLabelKo(stage),
    preMoveScore,
    preMoveStage,
    preMoveLabelKo: preMoveLabel,
    preMoveReasons: reasons,
    scannerScore: num(item.scannerScore) ?? 0,
    finalSelectionScore: num(item.finalSelectionScore) ?? 0,
    isPreSurgeCandidate: item.isPreSurgeCandidate === true,
    isChasingRisk: item.isChasingRisk === true,
    isOverheated: item.isOverheated === true,
  };
}

function buildPreMoveCandidates(items = []) {
  return items
    .map(buildPreMoveCandidate)
    .filter(Boolean)
    .sort((a, b) => (num(b.preMoveScore) ?? 0) - (num(a.preMoveScore) ?? 0)
      || (num(b.scannerScore) ?? 0) - (num(a.scannerScore) ?? 0)
      || (num(b.finalSelectionScore) ?? 0) - (num(a.finalSelectionScore) ?? 0)
      || (num(a.changePercent) ?? 0) - (num(b.changePercent) ?? 0)
      || (num(a.relativeVolume) ?? 0) - (num(b.relativeVolume) ?? 0))
    .slice(0, PRE_MOVE_CANDIDATE_LIMIT);
}

function buildVwapEvaluations(bars, lookback = 30) {
  const sample = bars.slice(-lookback);
  let totalNotional = 0;
  let totalVolume = 0;
  let usedAmount = false;
  const evaluated = [];

  for (const bar of bars) {
    const close = positive(bar.close);
    const volume = positive(bar.volume);
    if (close === null || volume === null) continue;

    const high = positive(bar.high) ?? close;
    const low = positive(bar.low) ?? close;
    const amount = barAmount(bar);
    const notional = amount ?? (((high + low + close) / 3) * volume);
    if (!Number.isFinite(notional) || notional <= 0) continue;

    if (amount !== null) usedAmount = true;
    totalNotional += notional;
    totalVolume += volume;
    if (!sample.includes(bar) || totalVolume <= 0) continue;
    const vwap = totalNotional / totalVolume;
    evaluated.push({ close, volume, vwap, above: close >= vwap });
  }

  return {
    evaluated,
    vwapSource: usedAmount ? "kis-amount-volume" : "yahoo-fallback",
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
  const { evaluated, vwapSource } = buildVwapEvaluations(bars, 24);
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
    vwapSource,
    vwapHoldScore: Math.round(clamp(score)),
  };
}

function calculateCompressionScore(bars) {
  const sample = bars.slice(-20);
  if (sample.length < 8) return 50;
  const clean = sample.map((bar) => ({
    high: positive(bar.high),
    low: positive(bar.low),
    close: positive(bar.close),
    volume: positive(bar.volume),
  })).filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);
  const highs = clean.map((bar) => bar.high);
  const lows = clean.map((bar) => bar.low);
  const lastClose = positive(clean.at(-1)?.close);
  if (!highs.length || !lows.length || lastClose === null) return 50;

  const rangePct = ((Math.max(...highs) - Math.min(...lows)) / lastClose) * 100;
  const recent = clean.slice(-8);
  const prior = clean.slice(0, Math.max(clean.length - 8, 1));
  const avgRange = (items) => average(items.map((bar) => ((bar.high - bar.low) / Math.max(bar.close, 0.0001)) * 100)) ?? null;
  const recentRange = avgRange(recent);
  const priorRange = avgRange(prior);
  const rangeContracting = recentRange !== null && priorRange !== null ? recentRange <= priorRange * 0.82 : false;
  const recentHighRange = recent.length >= 4 ? ((Math.max(...recent.map((bar) => bar.high)) - Math.min(...recent.map((bar) => bar.high))) / lastClose) * 100 : null;
  const lowsDefended = Math.min(...recent.map((bar) => bar.low)) >= Math.min(...clean.slice(0, -4).map((bar) => bar.low)) * 0.995;
  const volumes = clean.map((bar) => bar.volume).filter((value) => value !== null);
  const recentVol = average(volumes.slice(-3));
  const middleVol = average(volumes.slice(-12, -3));
  const volumeRebuilding = recentVol !== null && middleVol !== null ? recentVol >= middleVol * 1.08 : false;
  const highTightnessBonus = recentHighRange !== null && recentHighRange <= 2.5 ? 10 : recentHighRange !== null && recentHighRange <= 4 ? 5 : 0;
  const base = rangePct <= 3 ? 88
    : rangePct <= 5 ? 78
      : rangePct <= 8 ? 64
        : rangePct <= 12 ? 52
          : 38;
  const score = base
    + (rangeContracting ? 12 : -4)
    + (lowsDefended ? 10 : -12)
    + (volumeRebuilding ? 7 : 0)
    + highTightnessBonus
    + (calculateHigherLowScore(sample) - 50) * 0.10;
  return Math.round(clamp(score));
}

function vwapEvaluations(bars, lookback = 30) {
  return buildVwapEvaluations(bars, lookback).evaluated;
}

function calculateVwapReclaimScore(bars, vwapHoldMinutes = null) {
  const evaluated = vwapEvaluations(bars, 30);
  if (evaluated.length < 8) return 50;
  let reclaimIndex = -1;
  for (let index = 1; index < evaluated.length; index += 1) {
    if (!evaluated[index - 1].above && evaluated[index].above) reclaimIndex = index;
  }
  if (reclaimIndex < 0) return evaluated.at(-1)?.above ? 58 : 32;

  const after = evaluated.slice(reclaimIndex);
  const before = evaluated.slice(Math.max(0, reclaimIndex - 5), reclaimIndex);
  const holdMinutes = num(vwapHoldMinutes) ?? after.filter((bar) => bar.above).length;
  const reclaimVolume = average(after.slice(0, 3).map((bar) => bar.volume));
  const priorVolume = average(before.map((bar) => bar.volume));
  const volumeExpanded = reclaimVolume !== null && priorVolume !== null ? reclaimVolume >= priorVolume * 1.15 : false;
  const last = evaluated.at(-1);
  const didNotLoseVwap = last && last.close >= last.vwap * 0.996;
  const score = 40
    + Math.min(holdMinutes, 10) * 5
    + (volumeExpanded ? 16 : 0)
    + (didNotLoseVwap ? 12 : -14)
    + (last?.above ? 8 : 0);
  return Math.round(clamp(score));
}

function calculateReSurgeSetupScore(bars, signals = {}) {
  const sample = bars.slice(-40)
    .map((bar) => ({
      high: positive(bar.high),
      low: positive(bar.low),
      close: positive(bar.close),
      volume: positive(bar.volume),
    }))
    .filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);
  if (sample.length < 15) return 50;

  const last = sample.at(-1);
  const firstHalf = sample.slice(0, -10);
  const recent = sample.slice(-14);
  const priorLow = Math.min(...firstHalf.map((bar) => bar.low));
  const impulseHigh = Math.max(...firstHalf.map((bar) => bar.high));
  const impulseMovePct = priorLow > 0 ? ((impulseHigh - priorLow) / priorLow) * 100 : null;
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const recentHigh = Math.max(...recent.map((bar) => bar.high));
  const pullbackPct = impulseHigh > 0 ? ((impulseHigh - recentLow) / impulseHigh) * 100 : null;
  const closeNearBreakout = recentHigh > 0 ? last.close >= recentHigh * 0.985 : false;
  const didNotCollapse = pullbackPct !== null && pullbackPct <= 18 && last.close >= impulseHigh * 0.72;
  const sidewaysRangePct = ((recentHigh - recentLow) / Math.max(last.close, 0.0001)) * 100;
  const notDeadVolume = (() => {
    const recentVol = average(recent.slice(-5).map((bar) => bar.volume));
    const priorVol = average(sample.slice(-25, -10).map((bar) => bar.volume));
    return recentVol !== null && priorVol !== null ? recentVol >= priorVol * 0.35 : true;
  })();
  const higherLow = (num(signals.higherLowScore) ?? 50) >= 50;
  const vwapHealthy = (num(signals.vwapHoldScore) ?? 50) >= 60 || (num(signals.vwapReclaimScore) ?? 50) >= 65;

  let score = 28;
  if (impulseMovePct !== null && impulseMovePct >= 18) score += 18;
  else if (impulseMovePct !== null && impulseMovePct >= 9) score += 10;
  if (didNotCollapse) score += 16;
  if (sidewaysRangePct <= 8) score += 12;
  else if (sidewaysRangePct <= 13) score += 6;
  if (notDeadVolume) score += 10;
  if (higherLow) score += 10;
  if (vwapHealthy) score += 10;
  if (closeNearBreakout) score += 12;
  return Math.round(clamp(score));
}

function cleanPatternCandles(bars) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => {
      const close = positive(bar.close);
      return {
        open: positive(bar.open) ?? close,
        high: positive(bar.high) ?? close,
        low: positive(bar.low) ?? close,
        close,
        volume: positive(bar.volume),
      };
    })
    .filter((bar) => bar.close !== null && bar.high !== null && bar.low !== null && bar.high >= bar.low);
}

function candleRangePct(bar) {
  if (!bar || !bar.close) return 0;
  return ((bar.high - bar.low) / Math.max(bar.close, 0.0001)) * 100;
}

function volumeRatio(recent, prior) {
  const recentVol = average(recent.map((bar) => bar.volume));
  const priorVol = average(prior.map((bar) => bar.volume));
  return recentVol !== null && priorVol !== null && priorVol > 0 ? recentVol / priorVol : null;
}

function scoreBoxCompressionFromCandles(candles) {
  const sample = candles.slice(-24);
  if (sample.length < 12) return 0;
  const recent = sample.slice(-8);
  const prior = sample.slice(0, -8);
  const last = sample.at(-1);
  const priorRange = average(prior.map(candleRangePct));
  const recentRange = average(recent.map(candleRangePct));
  const highs = recent.map((bar) => bar.high);
  const lows = recent.map((bar) => bar.low);
  const resistance = Math.max(...highs);
  const support = Math.min(...lows);
  const resistanceTests = highs.filter((high) => high >= resistance * 0.988).length;
  const lowerBreak = last.close < support * 0.992;
  const volumeHold = volumeRatio(recent, prior);
  const alreadyExtended = last.close > resistance * 1.03;
  let score = 35;
  if (priorRange !== null && recentRange !== null && recentRange <= priorRange * 0.78) score += 24;
  if (last.close >= resistance * 0.975 && last.close <= resistance * 1.015) score += 18;
  if (resistanceTests >= 2) score += 12;
  if (!lowerBreak) score += 10;
  if (volumeHold === null || volumeHold >= 0.35) score += 8;
  if (lowerBreak) score -= 24;
  if (volumeHold !== null && volumeHold < 0.18) score -= 16;
  if (alreadyExtended) score -= 18;
  return Math.round(clamp(score));
}

function scoreAscendingTriangleFromCandles(candles) {
  const sample = candles.slice(-24);
  if (sample.length < 12) return 0;
  const recent = sample.slice(-10);
  const prior = sample.slice(0, -10);
  const lows = recent.map((bar) => bar.low);
  const highs = recent.map((bar) => bar.high);
  const last = recent.at(-1);
  let higherLowPairs = 0;
  for (let index = 1; index < lows.length; index += 1) {
    if (lows[index] >= lows[index - 1] * 0.998) higherLowPairs += 1;
  }
  const resistance = Math.max(...highs);
  const highBandPct = ((resistance - Math.min(...highs)) / Math.max(last.close, 0.0001)) * 100;
  const recentRange = average(recent.map(candleRangePct));
  const priorRange = average(prior.map(candleRangePct));
  const nearResistance = last.close >= resistance * 0.975;
  const lostRecentLow = last.close < Math.min(...lows.slice(0, -1)) * 0.992;
  let score = 30;
  score += (higherLowPairs / Math.max(1, lows.length - 1)) * 30;
  if (highBandPct <= 4) score += 14;
  if (priorRange !== null && recentRange !== null && recentRange <= priorRange * 0.88) score += 12;
  if (nearResistance) score += 18;
  if (lostRecentLow) score -= 28;
  return Math.round(clamp(score));
}

function scorePullbackBreakoutFromCandles(candles) {
  const sample = candles.slice(-36);
  if (sample.length < 16) return 0;
  const first = sample.slice(0, -12);
  const recent = sample.slice(-12);
  const last = sample.at(-1);
  const impulseLow = Math.min(...first.map((bar) => bar.low));
  const impulseHigh = Math.max(...first.map((bar) => bar.high));
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const recentHigh = Math.max(...recent.map((bar) => bar.high));
  const impulsePct = impulseLow > 0 ? ((impulseHigh - impulseLow) / impulseLow) * 100 : 0;
  const pullbackPct = impulseHigh > 0 ? ((impulseHigh - recentLow) / impulseHigh) * 100 : 100;
  const closeNearHigh = recentHigh > 0 && last.close >= recentHigh * 0.982;
  const pullbackVolume = volumeRatio(recent.slice(0, 6), first.slice(-8));
  const reboundVolume = volumeRatio(recent.slice(-4), recent.slice(0, 6));
  let score = 28;
  if (impulsePct >= 6) score += 16;
  if (pullbackPct <= 8) score += 22;
  else if (pullbackPct <= 16) score += 12;
  else if (pullbackPct > 28) score -= 24;
  if (pullbackVolume === null || pullbackVolume <= 0.9) score += 10;
  if (reboundVolume !== null && reboundVolume >= 1.15) score += 14;
  if (closeNearHigh) score += 16;
  if (last.close < recentLow * 1.015) score -= 16;
  return Math.round(clamp(score));
}

function scoreRoundedBottomFromCandles(candles) {
  const sample = candles.slice(-36);
  if (sample.length < 18) return 0;
  const first = sample.slice(0, 12);
  const middle = sample.slice(12, 24);
  const recent = sample.slice(24);
  const firstClose = average(first.map((bar) => bar.close));
  const middleClose = average(middle.map((bar) => bar.close));
  const recentClose = average(recent.map((bar) => bar.close));
  const middleLow = Math.min(...middle.map((bar) => bar.low));
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const volumeRecovery = volumeRatio(recent, middle);
  const last = sample.at(-1);
  let score = 26;
  if (firstClose !== null && middleClose !== null && recentClose !== null && middleClose <= firstClose * 1.03 && recentClose >= middleClose * 1.015) score += 26;
  if (recentLow >= middleLow * 0.99) score += 16;
  if (volumeRecovery !== null && volumeRecovery >= 1.05) score += 14;
  if (last.close >= Math.max(...middle.map((bar) => bar.high)) * 0.995) score += 14;
  if (recentLow < middleLow * 0.97) score -= 24;
  return Math.round(clamp(score));
}

function scoreVolatilityContractionFromCandles(candles) {
  const sample = candles.slice(-24);
  if (sample.length < 12) return 0;
  const first = sample.slice(0, 8);
  const middle = sample.slice(8, 16);
  const recent = sample.slice(16);
  const firstRange = average(first.map(candleRangePct));
  const middleRange = average(middle.map(candleRangePct));
  const recentRange = average(recent.map(candleRangePct));
  const floor = Math.min(...sample.slice(0, -4).map((bar) => bar.low));
  const last = sample.at(-1);
  const priorHigh = Math.max(...sample.slice(0, -3).map((bar) => bar.high));
  const volumeWake = volumeRatio(recent.slice(-3), sample.slice(-10, -3));
  let score = 30;
  if (firstRange !== null && middleRange !== null && recentRange !== null && recentRange <= middleRange * 0.9 && middleRange <= firstRange * 0.95) score += 28;
  if (last.close >= floor * 1.01) score += 14;
  if (last.close >= priorHigh * 0.975) score += 14;
  if (volumeWake !== null && volumeWake >= 1.05) score += 12;
  if (volumeWake !== null && volumeWake < 0.18) score -= 20;
  if (last.close < floor * 0.995) score -= 22;
  return Math.round(clamp(score));
}

function calculateChartPatternScore(bars) {
  const candles = cleanPatternCandles(bars);
  const emptyDetails = {
    boxCompression: 0,
    ascendingTriangle: 0,
    pullbackBreakout: 0,
    roundedBottom: 0,
    volatilityContraction: 0,
  };
  if (candles.length < 12) {
    return {
      score: 0,
      patternName: "데이터 부족",
      status: "차트 유사도 데이터 부족",
      details: emptyDetails,
    };
  }
  const details = {
    boxCompression: scoreBoxCompressionFromCandles(candles),
    ascendingTriangle: scoreAscendingTriangleFromCandles(candles),
    pullbackBreakout: scorePullbackBreakoutFromCandles(candles),
    roundedBottom: scoreRoundedBottomFromCandles(candles),
    volatilityContraction: scoreVolatilityContractionFromCandles(candles),
  };
  const labels = {
    boxCompression: "박스권 압축",
    ascendingTriangle: "저점 상승",
    pullbackBreakout: "짧은 눌림",
    roundedBottom: "둥근 바닥",
    volatilityContraction: "변동성 축소",
  };
  const bestKey = Object.keys(details).sort((a, b) => details[b] - details[a])[0];
  const bestScore = details[bestKey] ?? 0;
  return {
    score: Math.round(clamp(bestScore)),
    patternName: bestScore >= 40 ? labels[bestKey] : "패턴 약함",
    status: bestScore >= 40 ? "ok" : "패턴 판단 불가",
    details,
  };
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
      vwapReclaimScore: 50,
      reSurgeSetupScore: 50,
      chartPatternScore: 0,
      patternSimilarityScore: 0,
      bestPatternName: "데이터 부족",
      chartPatternStatus: "차트 유사도 데이터 부족",
      chartPatternDetails: {
        boxCompression: 0,
        ascendingTriangle: 0,
        pullbackBreakout: 0,
        roundedBottom: 0,
        volatilityContraction: 0,
      },
      commonSignalStatus: "데이터 부족",
    };
  }

  const volumeAcceleration = calculateVolumeAcceleration(bars);
  const higherLowScore = calculateHigherLowScore(bars);
  const vwapHold = calculateVwapHold(bars);
  const compressionScore = calculateCompressionScore(bars);
  const vwapReclaimScore = calculateVwapReclaimScore(bars, vwapHold.vwapHoldMinutes);
  const reSurgeSetupScore = calculateReSurgeSetupScore(bars, {
    higherLowScore,
    vwapHoldScore: vwapHold.vwapHoldScore,
    vwapReclaimScore,
  });
  const chartPattern = calculateChartPatternScore(bars);
  return {
    ...volumeAcceleration,
    higherLowScore,
    ...vwapHold,
    compressionScore,
    vwapReclaimScore,
    reSurgeSetupScore,
    chartPatternScore: chartPattern.score,
    patternSimilarityScore: chartPattern.score,
    bestPatternName: chartPattern.patternName,
    chartPatternStatus: chartPattern.status,
    chartPatternDetails: chartPattern.details,
    commonSignalStatus: "ok",
  };
}

function commonSignalBoost(signals = {}) {
  const score =
    (num(signals.volumeAccelerationScore) ?? 50) * 0.18
    + (num(signals.higherLowScore) ?? 50) * 0.14
    + (num(signals.vwapHoldScore) ?? 50) * 0.14
    + (num(signals.compressionScore) ?? 50) * 0.18
    + (num(signals.reSurgeSetupScore) ?? 50) * 0.22
    + (num(signals.vwapReclaimScore) ?? 50) * 0.14;
  return Math.round(clamp(Math.max(0, (score - 50) * 0.20), 0, 10));
}

function pickDisplayPrice({ marketState, regularPrice, preMarketPrice, postMarketPrice, latestClose }) {
  const normalizedState = String(marketState || "").toUpperCase();
  if (normalizedState === "PRE" && preMarketPrice !== null) return preMarketPrice;
  if ((normalizedState === "POST" || normalizedState === "POSTPOST") && postMarketPrice !== null) return postMarketPrice;
  if (!normalizedState && latestClose !== null) return latestClose;
  return latestClose ?? regularPrice ?? preMarketPrice ?? postMarketPrice ?? null;
}

function buildChartSnapshotFromHistory(historySnapshot = {}) {
  const bars = Array.isArray(historySnapshot.bars) ? historySnapshot.bars : [];
  const latestBar = bars.at(-1) || {};
  const latestTimestampMs = num(latestBar.timestamp) ?? (latestBar.time ? Date.parse(latestBar.time) : null);
  const volumes = bars.map((bar) => positive(bar.volume)).filter((value) => value !== null);
  const vwapEvaluation = buildVwapEvaluations(bars, 30);
  const latestVwap = vwapEvaluation.evaluated.at(-1)?.vwap ?? null;
  const historySource = historySnapshot.historySource || "yahoo";
  const isKisHistory = historySource === "kis-daymarket-bars";

  return {
    latestClose: positive(latestBar.close),
    latestBarAge: latestTimestampMs ? Math.max(0, Math.round((Date.now() - latestTimestampMs) / 60000)) : null,
    priceUpdatedAt: latestTimestampMs ? new Date(latestTimestampMs).toISOString() : null,
    marketState: null,
    regularMarketPrice: positive(historySnapshot.regularMarketPrice) ?? positive(latestBar.close),
    previousClose: positive(historySnapshot.previousClose),
    chartPreviousClose: positive(historySnapshot.previousClose),
    regularMarketVolume: positive(historySnapshot.regularMarketVolume),
    volume: volumes.length ? volumes.reduce((total, value) => total + value, 0) : null,
    bars,
    commonSignals: {
      ...calculateCommonSignals(bars),
      vwapSource: vwapEvaluation.vwapSource,
      volumeAccelerationSource: isKisHistory ? "kis-bars" : "yahoo-fallback",
    },
    historySource,
    volumeSource: historySnapshot.volumeSource || (isKisHistory ? "kis-evol" : "yahoo-fallback"),
    sessionType: historySnapshot.sessionType || getSessionType(new Date()),
    kisMarketCode: historySnapshot.kisMarketCode || null,
    kisBarCount: positive(historySnapshot.kisBarCount) ?? bars.length,
    vwap: latestVwap,
    vwapSource: vwapEvaluation.vwapSource,
  };
}

function mergeSnapshots(...snapshots) {
  return snapshots.reduce((merged, snapshot) => ({ ...merged, ...compactObject(snapshot) }), {});
}

function debugQuoteSourceLabel(localQuoteSnapshot, hasYahooBatch) {
  if (localQuoteSnapshot?.priceSource?.startsWith("kis")) return "local-quote-kis";
  if (localQuoteSnapshot?.priceSource) return `local-quote-${localQuoteSnapshot.priceSource}`;
  return hasYahooBatch ? "yahoo" : "none";
}

function debugHistorySourceLabel(localHistorySnapshot, hasYahooChart) {
  if (localHistorySnapshot?.historySource === "kis-daymarket-bars") return "local-history-kis";
  if (localHistorySnapshot?.historySource) return `local-history-${localHistorySnapshot.historySource}`;
  return hasYahooChart ? "yahoo-chart" : "none";
}

function debugFallbackReason({
  sessionType,
  localQuoteSnapshot,
  localHistorySnapshot,
  mergedQuoteSnapshot,
  liveQuote,
  chartSnapshot,
}) {
  if (sessionType !== "DAY") return null;

  const reasons = [];
  const quoteHasKis = Boolean(localQuoteSnapshot?.priceSource?.startsWith("kis") && num(localQuoteSnapshot?.kisPrice) !== null);
  const historyHasKis = localHistorySnapshot?.historySource === "kis-daymarket-bars" && Array.isArray(localHistorySnapshot?.bars) && localHistorySnapshot.bars.length > 0;

  if (!quoteHasKis) {
    reasons.push(`quote-${localQuoteSnapshot?.priceSource || "empty"}`);
    if (num(localQuoteSnapshot?.kisPrice) === null) reasons.push("quote-kis-price-missing");
    if (num(localQuoteSnapshot?.kisVolume) === null) reasons.push("quote-kis-volume-missing");
  }

  if (!historyHasKis) {
    reasons.push(`history-${localHistorySnapshot?.historySource || "empty"}`);
    if (localHistorySnapshot?.fallbackReason) reasons.push(`history-fallback-${localHistorySnapshot.fallbackReason}`);
    if (localHistorySnapshot?.kisError) reasons.push(`history-kis-error-${localHistorySnapshot.kisError}`);
    if (!Array.isArray(localHistorySnapshot?.bars) || localHistorySnapshot.bars.length === 0) reasons.push("history-bars-empty");
  }

  if (quoteHasKis && mergedQuoteSnapshot?.priceSource !== localQuoteSnapshot?.priceSource) {
    reasons.push("merge-quote-priceSource-overwrite");
  }
  if (quoteHasKis && num(mergedQuoteSnapshot?.kisPrice) !== num(localQuoteSnapshot?.kisPrice)) {
    reasons.push("merge-quote-kisPrice-overwrite");
  }
  if (historyHasKis && chartSnapshot?.historySource !== "kis-daymarket-bars") {
    reasons.push("merge-historySource-overwrite");
  }
  if (quoteHasKis && liveQuote?.priceSource !== localQuoteSnapshot?.priceSource) {
    reasons.push("final-priceSource-overwrite");
  }
  if (historyHasKis && liveQuote?.historySource !== "kis-daymarket-bars") {
    reasons.push("final-historySource-overwrite");
  }

  return reasons.length ? [...new Set(reasons)].join("|") : null;
}

function normalizeLiveQuote(item, quoteSnapshot = {}, chartSnapshot = {}) {
  const sessionType = String(
    quoteSnapshot.sessionType
    ?? item.sessionType
    ?? chartSnapshot.sessionType
    ?? getSessionType(new Date()),
  ).toUpperCase();
  const marketState = String(
    quoteSnapshot.marketState
    ?? item.marketState
    ?? chartSnapshot.marketState
    ?? "",
  ).toUpperCase();
  const kisPrice = num(quoteSnapshot.kisPrice)
    ?? num(item.kisPrice)
    ?? null;
  const regularPrice = num(quoteSnapshot.regularMarketPrice)
    ?? num(item.regularMarketPrice)
    ?? num(chartSnapshot.regularMarketPrice)
    ?? (sessionType === "REGULAR" ? num(quoteSnapshot.price) ?? num(item.price) : null);
  const preMarketPrice = num(quoteSnapshot.preMarketPrice)
    ?? num(item.preMarketPrice)
    ?? num(chartSnapshot.preMarketPrice)
    ?? (sessionType === "PRE" ? num(quoteSnapshot.price) ?? num(chartSnapshot.latestClose) ?? num(item.price) : null);
  const postMarketPrice = num(quoteSnapshot.postMarketPrice)
    ?? num(item.postMarketPrice)
    ?? num(chartSnapshot.postMarketPrice)
    ?? (sessionType === "AFTER" ? num(quoteSnapshot.price) ?? num(chartSnapshot.latestClose) ?? num(item.price) : null);
  const latestClose = num(chartSnapshot.latestClose);
  const displayPrice = sessionType === "PRE"
    ? preMarketPrice
    : sessionType === "AFTER"
      ? postMarketPrice
      : sessionType === "REGULAR"
        ? regularPrice
        : num(quoteSnapshot.price) ?? kisPrice ?? pickDisplayPrice({
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
  const regularMarketPreviousClose = num(quoteSnapshot.regularMarketPreviousClose)
    ?? num(item.regularMarketPreviousClose)
    ?? previousClose;
  const regularChangePercent = num(quoteSnapshot.regularMarketChangePercent)
    ?? num(item.regularMarketChangePercent)
    ?? pctFromBasis(regularPrice, regularMarketPreviousClose);
  const preChangePercent = num(quoteSnapshot.preMarketChangePercent)
    ?? pctFromBasis(preMarketPrice, regularPrice);
  const postChangePercent = num(quoteSnapshot.postMarketChangePercent)
    ?? pctFromBasis(postMarketPrice, regularPrice);
  let changePercent = null;
  let changeBasis = null;
  if (sessionType === "PRE") {
    changePercent = preChangePercent;
    changeBasis = changePercent !== null ? "preMarketPrice-vs-regularMarketPrice" : "preMarketChangePercent-unavailable";
  } else if (sessionType === "AFTER") {
    changePercent = postChangePercent;
    changeBasis = changePercent !== null ? "postMarketPrice-vs-regularMarketPrice" : "postMarketChangePercent-unavailable";
  } else if (sessionType === "REGULAR") {
    changePercent = regularChangePercent;
    changeBasis = "regularMarketPrice-vs-previousClose";
  } else {
    changePercent = num(quoteSnapshot.changePercent) ?? num(item.changePercent) ?? null;
    changeBasis = quoteSnapshot.changeBasis ?? item.changeBasis ?? "daymarket";
  }
  const change = displayPrice !== null && changePercent !== null
    ? displayPrice - (displayPrice / (1 + changePercent / 100))
    : num(quoteSnapshot.change) ?? num(item.change) ?? null;
  let currentVolume = null;
  let volumeSource = null;
  if (sessionType === "PRE") {
    currentVolume = num(quoteSnapshot.preMarketVolume) ?? num(item.preMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-preMarketVolume" : "premarket-volume-unconfirmed";
  } else if (sessionType === "AFTER") {
    currentVolume = num(quoteSnapshot.postMarketVolume) ?? num(item.postMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-postMarketVolume" : "postmarket-volume-unconfirmed";
  } else if (sessionType === "REGULAR") {
    currentVolume = num(quoteSnapshot.regularMarketVolume)
      ?? num(item.regularMarketVolume)
      ?? num(chartSnapshot.regularMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-regularMarketVolume" : "regular-volume-unconfirmed";
  } else {
    currentVolume = num(quoteSnapshot.kisVolume) ?? num(item.kisVolume);
    volumeSource = currentVolume !== null ? "kis-tvol" : "daymarket-volume-unconfirmed";
  }
  const priceSource = quoteSnapshot.priceSource
    ?? item.priceSource
    ?? (kisPrice !== null ? (sessionType === "DAY" ? "kis-daymarket" : "kis") : "yahoo");
  const dataReliability = currentVolume !== null && changePercent !== null
    ? "high"
    : sessionType === "REGULAR" && changePercent !== null
      ? "medium"
      : "low";
  const historySource = chartSnapshot.historySource
    ?? item.historySource
    ?? null;
  const kisVolume = num(quoteSnapshot.kisVolume)
    ?? num(item.kisVolume)
    ?? null;
  const kisMarketCode = quoteSnapshot.kisMarketCode
    ?? chartSnapshot.kisMarketCode
    ?? item.kisMarketCode
    ?? null;
  const kisBarCount = positive(chartSnapshot.kisBarCount)
    ?? positive(item.kisBarCount)
    ?? 0;
  const vwap = num(chartSnapshot.vwap)
    ?? num(item.vwap);
  const vwapSource = chartSnapshot.vwapSource
    ?? chartSnapshot.commonSignals?.vwapSource
    ?? item.vwapSource
    ?? null;
  const volumeAccelerationSource = chartSnapshot.commonSignals?.volumeAccelerationSource
    ?? chartSnapshot.volumeAccelerationSource
    ?? item.volumeAccelerationSource
    ?? null;

  return {
    price: displayPrice ?? item.price,
    normalizedLivePriceUsd: displayPrice,
    regularMarketPrice: regularPrice,
    preMarketPrice,
    postMarketPrice,
    previousClose: previousClose ?? item.previousClose ?? null,
    regularMarketPreviousClose,
    change: change ?? null,
    changePercent: changePercent ?? null,
    preMarketChange: num(quoteSnapshot.preMarketChange) ?? num(item.preMarketChange) ?? null,
    preMarketChangePercent: preChangePercent,
    regularMarketChangePercent: regularChangePercent,
    postMarketChangePercent: postChangePercent,
    marketState,
    extendedHours: marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST",
    latestClose,
    latestBarAge: num(chartSnapshot.latestBarAge),
    priceUpdatedAt: chartSnapshot.priceUpdatedAt ?? null,
    volume: currentVolume,
    regularMarketVolume: num(quoteSnapshot.regularMarketVolume) ?? num(item.regularMarketVolume) ?? num(chartSnapshot.regularMarketVolume) ?? null,
    preMarketVolume: num(quoteSnapshot.preMarketVolume) ?? num(item.preMarketVolume) ?? null,
    postMarketVolume: num(quoteSnapshot.postMarketVolume) ?? num(item.postMarketVolume) ?? null,
    chartVolume: num(chartSnapshot.volume) ?? null,
    averageVolume: num(quoteSnapshot.averageDailyVolume3Month)
      ?? num(quoteSnapshot.averageDailyVolume10Day)
      ?? num(item.averageVolume),
    avgVolume: num(quoteSnapshot.avgVolume) ?? num(item.avgVolume) ?? num(item.averageVolume),
    sessionType,
    priceSource,
    volumeSource,
    changeBasis,
    dataReliability,
    dataReliabilityLabel: confidenceLabel(dataReliability),
    sessionLabel: sessionLabel(sessionType),
    historySource,
    vwap,
    vwapSource,
    volumeAccelerationSource,
    rvolSource: item.rvolSource ?? null,
    kisMarketCode,
    kisPrice,
    kisVolume,
    kisBarCount,
    aboveVwap: vwap !== null && displayPrice !== null ? displayPrice >= vwap : num(item.aboveVwap),
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
    const vwapEvaluation = buildVwapEvaluations(bars, 30);
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
      bars,
      commonSignals: {
        ...calculateCommonSignals(bars),
        vwapSource: vwapEvaluation.vwapSource,
        volumeAccelerationSource: "yahoo-fallback",
      },
      historySource: "yahoo",
      volumeSource: "yahoo-fallback",
      sessionType: getSessionType(new Date()),
      kisMarketCode: null,
      kisBarCount: bars.length,
      vwap: vwapEvaluation.evaluated.at(-1)?.vwap ?? null,
      vwapSource: vwapEvaluation.vwapSource,
    };
  } catch {
    return {};
  }
}

async function fetchVolumeProfile(symbol, currentVolume, currentVolumeSource = "yahoo") {
  if (!symbol) return {};
  if (!isTrustedCurrentVolumeSource(currentVolumeSource) || num(currentVolume) === null) {
    return {
      averageVolume: null,
      previousDayVolume: null,
      relativeVolume: null,
      volumeRatio: null,
      previousDayVolumeRatio: null,
      rvolSource: "disabled-non-session-volume",
      volumeProfileStatus: "current-session-volume-unconfirmed",
    };
  }
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

    const liveVolume = num(currentVolume);
    const previousDayVolume = volumes.length > 1 ? volumes.at(-2) : null;
    const averageVolume20d = average(volumes.slice(0, -1).slice(-20));
    return {
      averageVolume: averageVolume20d,
      previousDayVolume,
      relativeVolume: averageVolume20d ? liveVolume / averageVolume20d : null,
      volumeRatio: averageVolume20d ? liveVolume / averageVolume20d : null,
      previousDayVolumeRatio: previousDayVolume ? liveVolume / previousDayVolume : null,
      volume: liveVolume,
      rvolSource: String(currentVolumeSource || "").startsWith("kis") ? "kis-current-volume-yahoo-average" : "yahoo",
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

async function normalizeItem(item, enrichVolume = true, metrics = null) {
  if (!item || typeof item !== "object") return item;

  const rawVolume = isTrustedCurrentVolumeSource(item.volumeSource) ? (num(item.volume) ?? num(item.preMarketVolume) ?? 0) : 0;
  const needsVolumeProfile = enrichVolume
    && isTrustedCurrentVolumeSource(item.volumeSource)
    && rawVolume > 0
    && ((num(item.relativeVolume) ?? num(item.volumeRatio)) === null || num(item.averageVolume) === null);
  let volumeProfile = {};
  if (needsVolumeProfile) {
    const volumeStartedAt = Date.now();
    volumeProfile = await fetchVolumeProfile(item.symbol, rawVolume, item.volumeSource);
    if (metrics) {
      metrics.volumeProfileCount += 1;
      metrics.volumeProfileMs += Date.now() - volumeStartedAt;
    }
  }
  const merged = { ...item, ...compactObject(volumeProfile) };
  const boosted = boostedScore(merged);
  const correctedVolumeScore = volumeStrength(merged);
  const quality = volumeQualityScore(merged);
  const stageMeta = buildStageMetadata(merged);
  const baseScannerScore = withChangePenalty(Math.max(num(merged.scannerScore) ?? 0, boosted), stageMeta.changePenalty);
  const baseFinalScore = withChangePenalty(Math.max(num(merged.finalProbabilityScore) ?? 0, boosted), stageMeta.changePenalty);

  return {
    ...merged,
    ...stageMeta,
    volumeComputationVersion: "pro-rvol-v2",
    volume: isTrustedCurrentVolumeSource(merged.volumeSource) ? ((num(merged.volume) ?? rawVolume) || null) : null,
    volumeStrengthScore: correctedVolumeScore,
    volumeQualityScore: quality.score,
    tradeValueKrw: quality.tradeValueKrw,
    scannerScore: baseScannerScore,
    finalProbabilityScore: baseFinalScore,
    selectionReasons: [
      ...(Array.isArray(merged.selectionReasons) ? merged.selectionReasons : []),
      volumeProfile.relativeVolume ? `RVOL ${volumeProfile.relativeVolume.toFixed(1)}x from 20D avg volume` : null,
      volumeProfile.previousDayVolumeRatio ? `Volume ${volumeProfile.previousDayVolumeRatio.toFixed(1)}x vs previous day` : null,
      boosted > (num(merged.finalProbabilityScore) ?? 0) ? "Premarket surge volume boost" : null,
      quality.score < 30 ? "Volume quality demotion: low absolute volume or KRW trade value" : null,
    ].filter(Boolean),
  };
}

const BASE_SCANNER_SCREENER_IDS = [
  "most_actives",
  "day_gainers",
  "small_cap_gainers",
  "undervalued_large_caps",
];
const UNDER_ONE_SCANNER_IDS = [
  "small_cap_stocks",
  "aggressive_small_caps",
];
const BASE_SCANNER_ITEM_LIMIT = 80;
const UNDER_ONE_MIN_ITEMS = 30;
const BASE_SCANNER_SOURCE = "yahoo-screener-local";

async function fetchYahooScreenerQuotes(screenerId, count = 100) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${encodeURIComponent(screenerId)}`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    const quotes = payload?.finance?.result?.[0]?.quotes;
    if (!response.ok || !Array.isArray(quotes)) return [];
    return quotes;
  } catch {
    return [];
  }
}

async function collectBaseScannerQuotes() {
  const quoteBySymbol = new Map();
  const screenerSources = [
    ...BASE_SCANNER_SCREENER_IDS.map((screenerId) => ({
      screenerId,
      sourceTag: `yahoo-screener-${screenerId}`,
    })),
    ...UNDER_ONE_SCANNER_IDS.map((screenerId) => ({
      screenerId,
      sourceTag: `yahoo-screener-under1-${screenerId}`,
    })),
  ];
  await Promise.all(screenerSources.map(async ({ screenerId, sourceTag }) => {
    const quotes = await fetchYahooScreenerQuotes(screenerId);
    for (const quote of quotes) {
      const symbol = String(quote?.symbol || "").toUpperCase();
      if (!symbol) continue;
      const existing = quoteBySymbol.get(symbol);
      if (!existing) {
        quoteBySymbol.set(symbol, { quote, sourceTags: new Set([sourceTag]) });
        continue;
      }
      existing.sourceTags.add(sourceTag);
      const existingVolume = Math.max(num(existing.quote.regularMarketVolume) ?? 0, num(existing.quote.preMarketVolume) ?? 0);
      const nextVolume = Math.max(num(quote.regularMarketVolume) ?? 0, num(quote.preMarketVolume) ?? 0);
      if (nextVolume > existingVolume) existing.quote = quote;
    }
  }));
  return quoteBySymbol;
}

function scannerLivePriceUsd(item) {
  return num(item?.price) ?? num(item?.preMarketPrice) ?? num(item?.postMarketPrice);
}

function isUnderOneScannerItem(item) {
  const price = scannerLivePriceUsd(item);
  return price !== null && price > 0 && price < 1;
}

function compareScannerItems(a, b) {
  const groupDiff = selectionGroupRank(a.selectionGroup) - selectionGroupRank(b.selectionGroup);
  if (groupDiff !== 0) return groupDiff;
  const finalSelectionDiff = (num(b.finalSelectionScore) ?? -1) - (num(a.finalSelectionScore) ?? -1);
  if (finalSelectionDiff !== 0) return finalSelectionDiff;
  const entryDiff = (num(b.entrySuitability ?? b.topPickFinalScore) ?? num(b.finalProbabilityScore) ?? 0) - (num(a.entrySuitability ?? a.topPickFinalScore) ?? num(a.finalProbabilityScore) ?? 0);
  if (entryDiff !== 0) return entryDiff;
  const patternDiff = (num(b.chartPatternScore) ?? num(b.patternSimilarityScore) ?? 0) - (num(a.chartPatternScore) ?? num(a.patternSimilarityScore) ?? 0);
  if (patternDiff !== 0) return patternDiff;
  const chaseDiff = (num(a.chaseRisk ?? a.topPickChaseRisk) ?? 100) - (num(b.chaseRisk ?? b.topPickChaseRisk) ?? 100);
  if (chaseDiff !== 0) return chaseDiff;
  const rvolDiff = (num(b.rvol ?? b.relativeVolume ?? b.volumeRatio) ?? 0) - (num(a.rvol ?? a.relativeVolume ?? a.volumeRatio) ?? 0);
  if (rvolDiff !== 0) return rvolDiff;
  const scoreDiff = (num(b.finalProbabilityScore) ?? 0) - (num(a.finalProbabilityScore) ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
  const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
  return bVolume - aVolume;
}

function compareUnderOneScannerItems(a, b) {
  const aChange = num(a.changePercent) ?? num(a.preMarketChangePercent) ?? 0;
  const bChange = num(b.changePercent) ?? num(b.preMarketChangePercent) ?? 0;
  const aUp = aChange > 0 ? 1 : 0;
  const bUp = bChange > 0 ? 1 : 0;
  if (bUp !== aUp) return bUp - aUp;
  return compareScannerItems(a, b);
}

function selectBalancedScannerItems(rawItems, limit = BASE_SCANNER_ITEM_LIMIT) {
  const underOneItems = [];
  const otherItems = [];
  for (const item of rawItems) {
    if (isUnderOneScannerItem(item)) underOneItems.push(item);
    else otherItems.push(item);
  }
  underOneItems.sort(compareUnderOneScannerItems);
  otherItems.sort(compareScannerItems);

  const selected = [];
  const seen = new Set();
  const underOneTarget = Math.min(UNDER_ONE_MIN_ITEMS, underOneItems.length);
  for (const item of underOneItems.slice(0, underOneTarget)) {
    selected.push(item);
    seen.add(item.symbol);
  }
  for (const item of otherItems) {
    if (selected.length >= limit) break;
    if (seen.has(item.symbol)) continue;
    selected.push(item);
    seen.add(item.symbol);
  }
  for (const item of underOneItems.slice(underOneTarget)) {
    if (selected.length >= limit) break;
    if (seen.has(item.symbol)) continue;
    selected.push(item);
    seen.add(item.symbol);
  }
  selected.sort(compareScannerItems);
  return selected;
}

function inferVolumeSourceFromQuote(quote) {
  const marketState = String(quote?.marketState || "").toUpperCase();
  const preVol = num(quote?.preMarketVolume);
  const regVol = num(quote?.regularMarketVolume);
  const postVol = num(quote?.postMarketVolume);
  if (marketState === "PRE" || marketState === "PREPRE") {
    return preVol !== null ? "yahoo-preMarketVolume" : "premarket-volume-unconfirmed";
  }
  if (marketState === "POST" || marketState === "POSTPOST") {
    return postVol !== null ? "yahoo-postMarketVolume" : "postmarket-volume-unconfirmed";
  }
  if (regVol !== null) return "yahoo-regularMarketVolume";
  if (preVol !== null) return "yahoo-preMarketVolume";
  if (postVol !== null) return "yahoo-postMarketVolume";
  return "regular-volume-unconfirmed";
}

function computeBaseScannerScores({ changePercent, volumeRatio, price, volume }) {
  const change = Math.abs(changePercent ?? 0);
  const rvol = volumeRatio ?? 0;
  const rawVolume = volume ?? 0;

  const surgePrecursorScore = Math.round(clamp(
    40
    + (change >= 5 ? 12 : change >= 2 ? 6 : 0)
    + (rvol >= 5 ? 18 : rvol >= 3 ? 12 : rvol >= 1.5 ? 6 : 0)
    + (price !== null && price < 5 ? 8 : 0),
  ));

  const momentumExpansionScore = Math.round(clamp(
    40
    + (change >= 10 && change <= 45 ? 22 : change >= 5 ? 10 : 0)
    + (rvol >= 3 ? 15 : rvol >= 2 ? 8 : 0)
    + (rawVolume >= 5_000_000 ? 12 : rawVolume >= 1_000_000 ? 6 : 0),
  ));

  const patternSimilarityScore = Math.round(clamp(
    45
    + (change >= 8 ? 12 : 0)
    + (rvol >= 2 ? 10 : 0)
    + (price !== null && price < 1 ? 8 : price !== null && price < 5 ? 4 : 0),
  ));

  const riskScore = Math.round(clamp(
    35
    + (change >= 100 ? 28 : change >= 60 ? 18 : change >= 35 ? 10 : 0)
    + (price !== null && price < 1 ? 12 : 0)
    + (rvol >= 10 && rawVolume < 500_000 ? 15 : 0),
  ));

  const scannerScore = Math.round(clamp(
    surgePrecursorScore * 0.28
    + momentumExpansionScore * 0.32
    + patternSimilarityScore * 0.22
    + (100 - riskScore) * 0.18,
  ));

  return {
    scannerScore,
    finalProbabilityScore: scannerScore,
    surgePrecursorScore,
    momentumExpansionScore,
    patternSimilarityScore,
    riskScore,
    stage: scannerScore >= 75 ? "MOMENTUM EXPANSION" : scannerScore >= 60 ? "SURGE PRECURSOR" : "ACCUMULATION",
    stageLabel: scannerScore >= 75 ? "추가 확장 가능" : scannerScore >= 60 ? "급등 전 조짐" : "누적 관찰",
  };
}

function buildBaseScannerItem(quote, sourceTags = []) {
  const symbol = String(quote.symbol || "").toUpperCase();
  const previousClose = num(quote.regularMarketPreviousClose) ?? num(quote.previousClose);
  const regularMarketPrice = num(quote.regularMarketPrice);
  const preMarketPrice = num(quote.preMarketPrice);
  const postMarketPrice = num(quote.postMarketPrice);
  const marketState = String(quote.marketState || "").toUpperCase();
  const price = regularMarketPrice ?? preMarketPrice ?? postMarketPrice;
  const preMarketChangePercent = num(quote.preMarketChangePercent)
    ?? pctFromBasis(preMarketPrice, previousClose);
  const changePercent = num(quote.regularMarketChangePercent)
    ?? preMarketChangePercent
    ?? num(quote.postMarketChangePercent);
  const preMarketVolume = num(quote.preMarketVolume);
  const regularMarketVolume = num(quote.regularMarketVolume);
  const postMarketVolume = num(quote.postMarketVolume);
  const volumeSource = inferVolumeSourceFromQuote(quote);
  const volume = volumeSource.includes("preMarket") ? preMarketVolume
    : volumeSource.includes("postMarket") ? postMarketVolume
      : regularMarketVolume ?? preMarketVolume ?? postMarketVolume;
  const averageVolume = num(quote.averageDailyVolume3Month) ?? num(quote.averageDailyVolume10Day);
  const volumeRatio = averageVolume && volume ? volume / averageVolume : null;
  const scores = computeBaseScannerScores({
    changePercent: Math.abs(changePercent ?? 0),
    volumeRatio,
    price,
    volume,
  });

  // Prevent "급등 전 조짐" stageLabel for already-surged stocks
  const rawChange = changePercent ?? 0;
  if (rawChange >= 20) {
    scores.stage = "LATE_CHASE_RISK";
    scores.stageLabel = "추격 위험";
  } else if (rawChange >= 15) {
    scores.stage = "MOMENTUM_EXPANSION";
    scores.stageLabel = "이미 상승 진행";
  }

  return {
    symbol,
    name: quote.shortName || quote.longName || symbol,
    price,
    preMarketPrice,
    postMarketPrice,
    regularMarketPrice,
    previousClose,
    changePercent,
    preMarketChangePercent,
    preMarketVolume,
    regularMarketVolume,
    postMarketVolume,
    volume,
    volumeSource,
    averageVolume,
    volumeRatio,
    relativeVolume: volumeRatio,
    marketCap: num(quote.marketCap),
    exchange: quote.fullExchangeName || quote.exchange || null,
    currency: quote.currency || "USD",
    marketState: quote.marketState || null,
    extendedHours: marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST",
    sourceTags: [...sourceTags, "yahoo-v7-batch-base"],
    included: true,
    inScanUniverse: true,
    ...scores,
    selectionReasons: [
      changePercent !== null ? `Session move ${changePercent.toFixed(1)}%` : null,
      volumeRatio ? `Relative volume ${volumeRatio.toFixed(1)}x` : null,
    ].filter(Boolean),
  };
}

async function fetchBaseScannerPayload() {
  const candidateQuotes = await collectBaseScannerQuotes();
  const symbols = [...candidateQuotes.keys()];
  const quoteMap = await fetchBatchQuoteMap(symbols);
  const rawItems = [];

  for (const [symbol, entry] of candidateQuotes) {
    const quote = quoteMap.get(symbol) || entry.quote;
    if (!quote?.symbol) continue;
    rawItems.push(buildBaseScannerItem(quote, [...entry.sourceTags]));
  }

  rawItems.sort(compareScannerItems);

  const items = selectBalancedScannerItems(rawItems, BASE_SCANNER_ITEM_LIMIT);

  return {
    ok: true,
    data: {
      updatedAt: new Date().toISOString(),
      source: BASE_SCANNER_SOURCE,
      candidateCount: rawItems.length,
      underOneCandidateCount: rawItems.filter(isUnderOneScannerItem).length,
      items,
    },
  };
}

function sendCachedScannerResponse(res, status, payload, cacheState) {
  res.setHeader("cache-control", cacheControlValue(status >= 200 && status < 300));
  res.setHeader("x-kbk-scanner-cache", cacheState);
  res.status(status).json(payload);
}

async function buildScannerResponse(req, { includeDebug: includeDebugOption } = {}) {
  const requestStartedAt = Date.now();
  const headers = req?.headers || {};
  const includeDebug = includeDebugOption === true || (includeDebugOption !== false && isDebugScannerRequest(req));
  const requestId = headerValue(headers, "x-request-id") || makeRequestId("scanner");
  const generatedAt = new Date();
  const baselineAudit = buildBaselineAudit(generatedAt);
  console.log(`[SCANNER] start requestId=${requestId}`);
  try {
    const baseStartedAt = Date.now();
    const payload = await fetchBaseScannerPayload();
    const upstreamItems = Array.isArray(payload?.data?.items) ? payload.data.items.length : 0;
    logScannerStep("base scanner fetch", baseStartedAt, {
      requestId,
      status: 200,
      items: upstreamItems,
    });

    if (payload?.data?.items && Array.isArray(payload.data.items)) {
      payload.data.items = payload.data.items.filter(isPrimaryCommonStockCandidate);
      const rankedForVolume = [...payload.data.items]
        .sort((a, b) => {
          const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
          const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
          const aScore = num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0;
          const bScore = num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0;
          return bVolume - aVolume || bScore - aScore;
        })
        .slice(0, ENRICH_SYMBOL_LIMIT);
      const enrichSymbols = new Set(rankedForVolume.map((item) => item.symbol));
      const symbols = payload.data.items.map((item) => String(item?.symbol || "").toUpperCase()).filter(Boolean);
      const sessionType = getSessionType(new Date());
      const chartSymbols = symbols.filter((symbol) => enrichSymbols.has(symbol));
      const batchQuotePromise = (async () => {
        const batchQuoteStartedAt = Date.now();
        const map = await fetchBatchQuoteMap(symbols);
        logScannerStep("batch quote fetch", batchQuoteStartedAt, {
          requestId,
          symbols: symbols.length,
          quotes: map.size,
        });
        return map;
      })();
      const chartSnapshotsPromise = (async () => {
        const chartStartedAt = Date.now();
        const snapshots = await mapWithLimit(chartSymbols, 4, async (symbol) => [symbol, await fetchChartSnapshot(symbol)]);
        logScannerStep("chart enrich", chartStartedAt, {
          requestId,
          symbols: chartSymbols.length,
        });
        return snapshots;
      })();
      const localQuoteSnapshotsPromise = (async () => {
        const quoteStartedAt = Date.now();
        const snapshots = await mapWithLimit(chartSymbols, 2, async (symbol) => [symbol, await fetchLocalQuoteSnapshot(symbol, requestId)]);
        logScannerStep("quote enrich", quoteStartedAt, {
          requestId,
          symbols: chartSymbols.length,
          enabled: true,
        });
        return snapshots;
      })();
      const localHistorySnapshotsPromise = (async () => {
        const historyStartedAt = Date.now();
        const snapshots = sessionType === "DAY"
          ? await mapWithLimit(chartSymbols, 2, async (symbol) => [symbol, await fetchLocalHistorySnapshot(symbol, "1m", requestId)])
          : [];
        logScannerStep("history enrich", historyStartedAt, {
          requestId,
          symbols: chartSymbols.length,
          enabled: sessionType === "DAY",
        });
        return snapshots;
      })();
      const [batchQuoteMap, chartSnapshots, localQuoteSnapshots, localHistorySnapshots] = await Promise.all([
        batchQuotePromise,
        chartSnapshotsPromise,
        localQuoteSnapshotsPromise,
        localHistorySnapshotsPromise,
      ]);
      const chartMap = new Map(chartSnapshots);
      const localQuoteMap = new Map(localQuoteSnapshots);
      const localHistoryMap = new Map(localHistorySnapshots);
      const normalizeStartedAt = Date.now();
      const metrics = {
        volumeProfileCount: 0,
        volumeProfileMs: 0,
      };

      payload.data.items = (await mapWithLimit(payload.data.items, 2, async (item) => {
        const symbolKey = String(item?.symbol || "").toUpperCase();
        const yahooChartSnapshot = chartMap.get(symbolKey) || {};
        const localQuoteSnapshot = localQuoteMap.get(symbolKey) || {};
        const localHistorySnapshot = localHistoryMap.get(symbolKey) || {};
        const chartSnapshot = Array.isArray(localHistorySnapshot?.bars) && localHistorySnapshot.bars.length
          ? buildChartSnapshotFromHistory(localHistorySnapshot)
          : yahooChartSnapshot;
        const quoteSnapshot = mergeSnapshots(batchQuoteMap.get(symbolKey) || {}, localQuoteSnapshot);
        const preNormalizedLiveQuote = normalizeLiveQuote(item, quoteSnapshot, chartSnapshot);
        const normalizedItem = await normalizeItem(
          { ...item, ...compactObject(preNormalizedLiveQuote) },
          enrichSymbols.has(item.symbol),
          metrics,
        );
        const liveQuote = normalizeLiveQuote(
          normalizedItem,
          quoteSnapshot,
          chartSnapshot,
        );
        const commonSignals = chartSnapshot.commonSignals || calculateCommonSignals([]);
        const rankAuxiliaryScore = commonSignalBoost(commonSignals);
        const baseScannerScore = num(normalizedItem.scannerScore) ?? 0;
        const baseFinalScore = num(normalizedItem.finalProbabilityScore) ?? 0;
        const boostedScannerScore = Math.round(clamp(baseScannerScore + rankAuxiliaryScore));
        const boostedFinalScore = Math.round(clamp(baseFinalScore + rankAuxiliaryScore));
        const quality = volumeQualityScore({ ...normalizedItem, ...compactObject(liveQuote) });
        const surgeAcceleration = calculateSurgeAccelerationScore(chartSnapshot.bars || [], normalizedItem, liveQuote, commonSignals);
        const earlyMomentumBonus = computeEarlyMomentumBonus(normalizedItem, quality, surgeAcceleration, liveQuote, commonSignals);
        const liquidityMomentumBonus = computeLiquidityMomentumBonus({ ...normalizedItem, ...compactObject(liveQuote) }, quality, surgeAcceleration);
        const preliminarySetup = topPickSetupProfile(
          { ...normalizedItem, ...compactObject(liveQuote), ...commonSignals },
          liveQuote.price ?? normalizedItem.price ?? 0,
          liveQuote.changePercent ?? normalizedItem.changePercent ?? 0,
        );
        const selectionScores = buildFinalSelectionScores(
          { ...normalizedItem, ...compactObject(liveQuote), ...commonSignals },
          preliminarySetup,
          quality,
          surgeAcceleration,
        );
        const stageMeta = buildStageMetadata({ ...normalizedItem, ...compactObject(liveQuote) });
        const volumeAdjustedFinalScore = Math.round(clamp(
          boostedFinalScore * 0.58
          + quality.score * 0.22
          + surgeAcceleration.surgeAccelerationScore * 0.20
          + earlyMomentumBonus,
        ));
        const rawFinalProbabilityScore = quality.score < 30
          ? Math.min(volumeAdjustedFinalScore, 69)
          : volumeAdjustedFinalScore;
        const rawScannerScore = quality.score < 30
          ? Math.min(boostedScannerScore, 69)
          : Math.max(baseScannerScore, boostedScannerScore);
        const finalProbabilityScore = withChangePenalty(rawFinalProbabilityScore, stageMeta.changePenalty);
        const scannerScore = withChangePenalty(rawScannerScore, stageMeta.changePenalty);
        const debugQuoteSource = debugQuoteSourceLabel(localQuoteSnapshot, batchQuoteMap.has(symbolKey));
        const debugHistorySource = debugHistorySourceLabel(localHistorySnapshot, chartMap.has(symbolKey));
        const debugFallback = debugFallbackReason({
          sessionType,
          localQuoteSnapshot,
          localHistorySnapshot,
          mergedQuoteSnapshot: quoteSnapshot,
          liveQuote,
          chartSnapshot,
        });
        const responseItem = {
          ...normalizedItem,
          ...compactObject(liveQuote),
          price: liveQuote.price ?? null,
          normalizedLivePriceUsd: liveQuote.normalizedLivePriceUsd ?? null,
          change: liveQuote.change ?? null,
          changePercent: liveQuote.changePercent ?? null,
          preMarketChange: liveQuote.preMarketChange ?? null,
          preMarketChangePercent: liveQuote.preMarketChangePercent ?? null,
          regularMarketChangePercent: liveQuote.regularMarketChangePercent ?? null,
          postMarketChangePercent: liveQuote.postMarketChangePercent ?? null,
          volume: liveQuote.volume ?? null,
          ...commonSignals,
          ...stageMeta,
          rankAuxiliaryScore,
          ...surgeAcceleration,
          volumeQualityScore: quality.score,
          tradeValueKrw: quality.tradeValueKrw,
          earlyMomentumBonus,
          liquidityMomentumBonus,
          quantitativeScore: selectionScores.quantitativeScore,
          volumeConfirmationScore: selectionScores.volumeConfirmationScore,
          finalSelectionScore: selectionScores.finalSelectionScore,
          selectionGroup: selectionScores.selectionGroup,
          statusBadge: selectionScores.statusBadge,
          scannerScore,
          finalProbabilityScore,
        };
        const dataQuality = buildDataQuality(responseItem, commonSignals);
        const scannerMode = buildScannerMode(responseItem, generatedAt);
        const signalLifecycle = buildSignalLifecycle(responseItem, scannerMode, generatedAt);
        if (symbolKey === "RMSG") {
          console.log("[SCANNER:RMSG:SESSION_FIELDS] " + JSON.stringify({
            symbol: responseItem.symbol,
            price: responseItem.price,
            regularMarketPrice: responseItem.regularMarketPrice,
            preMarketPrice: responseItem.preMarketPrice,
            postMarketPrice: responseItem.postMarketPrice ?? null,
            previousClose: responseItem.previousClose,
            regularMarketPreviousClose: responseItem.regularMarketPreviousClose,
            change: responseItem.change,
            changePercent: responseItem.changePercent,
            preMarketChange: responseItem.preMarketChange,
            preMarketChangePercent: responseItem.preMarketChangePercent,
            volume: responseItem.volume,
            regularMarketVolume: responseItem.regularMarketVolume ?? null,
            preMarketVolume: responseItem.preMarketVolume ?? null,
            chartVolume: responseItem.chartVolume ?? null,
            avgVolume: responseItem.avgVolume ?? responseItem.averageVolume,
            source: "scanner",
            priceSource: responseItem.priceSource,
            volumeSource: responseItem.volumeSource,
            marketState: responseItem.marketState,
            sessionType: responseItem.sessionType
          }));
        }
        const topPickEvaluation = evaluateTopPickForSnapshot(responseItem);
        const forbiddenPenalty = computeForbiddenPenalty(topPickEvaluation.topPickVerdict, topPickEvaluation.topPickChaseRisk);
        const marketPrioritySortScore = (num(topPickEvaluation.finalSelectionScore ?? responseItem.finalSelectionScore) ?? finalProbabilityScore)
          + earlyMomentumBonus
          + liquidityMomentumBonus
          - forbiddenPenalty
          - stageMeta.changePenalty;
        const finalSelectionScore = Math.round(clamp(marketPrioritySortScore));
        const experimentalScore = buildExperimentalScore(responseItem);
        const operationalRankScore = getOperationalRankScore({
          ...responseItem,
          ...experimentalScore,
          finalSelectionScore,
        });
        const operationalRankSourceValue = operationalRankSource({
          ...experimentalScore,
          finalSelectionScore,
        });
        const sparseNoCatalyst = isSparseNoCatalystCandidate(responseItem);
        const dataQualityPenalty = sparseNoCatalyst ? 30 : 0;

        return {
          ...responseItem,
          ...topPickEvaluation,
          ...experimentalScore,
          dataQuality,
          scannerMode,
          signalLifecycle,
          scoreReasons: buildScoreReasons(responseItem, dataQuality, scannerMode, signalLifecycle, topPickEvaluation),
          baselineAudit,
          ...experimentalScore,
          forbiddenPenalty,
          finalSelectionScore: Math.round(clamp(finalSelectionScore - dataQualityPenalty)),
          operationalRankScore,
          operationalRankSource: operationalRankSourceValue,
          marketPrioritySortScore: marketPrioritySortScore - dataQualityPenalty,
          volumeQualitySortScore: marketPrioritySortScore + (quality.score * 0.03) + (surgeAcceleration.surgeAccelerationScore * 0.04) - (stageMeta.changePenalty * 0.25) - dataQualityPenalty,
          included: sparseNoCatalyst ? false : responseItem.included,
          dataQualityStatus: sparseNoCatalyst ? "insufficient-data" : quality.volumeDataStatus,
          sourceTags: [...new Set([
            ...(Array.isArray(normalizedItem.sourceTags) ? normalizedItem.sourceTags : []),
            batchQuoteMap.has(symbolKey) ? "yahoo-v7-batch" : null,
            chartMap.has(symbolKey) ? "yahoo-1m-live" : null,
            localQuoteSnapshot?.priceSource?.startsWith("kis") ? "kis-local-quote" : null,
            localHistorySnapshot?.historySource === "kis-daymarket-bars" ? "kis-local-history" : null,
            rankAuxiliaryScore > 0 ? "common-signal-rank-boost" : null,
          ].filter(Boolean))],
          debugQuoteSource,
          debugHistorySource,
          debugFallbackReason: debugFallback,
          selectionReasons: [
            ...(Array.isArray(normalizedItem.selectionReasons) ? normalizedItem.selectionReasons : []),
            rankAuxiliaryScore > 0 ? `Common signal boost +${rankAuxiliaryScore}` : null,
            quality.score < 30 ? "Volume quality under 30: demoted from top candidates" : null,
            sparseNoCatalyst ? "Insufficient data: flat price, missing volume, no catalyst" : null,
          ].filter(Boolean),
        };
      }))
      .filter((item) => item?.included !== false)
      .sort((a, b) => {
        const groupDiff = selectionGroupRank(a.selectionGroup) - selectionGroupRank(b.selectionGroup);
        if (groupDiff !== 0) return groupDiff;
        return ((num(b.finalSelectionScore) ?? 0) - (num(a.finalSelectionScore) ?? 0))
          || ((num(b.entrySuitability ?? b.topPickFinalScore) ?? 0) - (num(a.entrySuitability ?? a.topPickFinalScore) ?? 0))
          || ((num(b.chartPatternScore) ?? 0) - (num(a.chartPatternScore) ?? 0))
          || ((num(a.chaseRisk ?? a.topPickChaseRisk) ?? 100) - (num(b.chaseRisk ?? b.topPickChaseRisk) ?? 100))
          || ((num(b.rvol ?? b.relativeVolume ?? b.volumeRatio) ?? 0) - (num(a.rvol ?? a.relativeVolume ?? a.volumeRatio) ?? 0))
          || ((num(b.changePercent ?? b.preMarketChangePercent) ?? 0) - (num(a.changePercent ?? a.preMarketChangePercent) ?? 0));
        });
      logScannerElapsed("volume profile", metrics.volumeProfileMs, {
        requestId,
        calls: metrics.volumeProfileCount,
      });
      logScannerStep("normalize items", normalizeStartedAt, {
        requestId,
        items: payload.data.items.length,
      });

      payload.data.preMoveCandidates = buildPreMoveCandidates(payload.data.items);
      payload.data.baselineAudit = baselineAudit;
      payload.data.preMoveCandidates = buildPreMoveCandidates(payload.data.items);
    }
    sanitizeScannerPayload(payload, { debug: includeDebug });
    payload.data.baselineAudit = baselineAudit;
    attachQuickAudit(payload);
    await captureScannerCandidateSnapshot(payload.data);
    logScannerStep("completed", requestStartedAt, {
      requestId,
      status: 200,
      enrichLimit: ENRICH_SYMBOL_LIMIT,
    });
    console.log(`[SCANNER] end requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms status=200`);
    return { status: 200, payload };
  } catch (error) {
    logScannerStep("completed", requestStartedAt, {
      requestId,
      status: 502,
    });
    console.log(`[SCANNER] end requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms status=502`);
    return {
      status: 502,
      payload: {
        ok: false,
        message: error instanceof Error ? error.message : "scanner proxy failed",
      },
    };
  }
}

module.exports = async function handler(req, res) {
  const modeKey = isDebugScannerRequest(req) ? "debug" : "default";
  const now = Date.now();
  const successCache = scannerSuccessCacheByMode[modeKey];
  if (successCache && successCache.expiresAt > now) {
    sendCachedScannerResponse(res, 200, successCache.payload, "hit");
    return;
  }
  const failureCache = scannerFailureCacheByMode[modeKey];
  if (failureCache && failureCache.expiresAt > now) {
    sendCachedScannerResponse(res, failureCache.status, failureCache.payload, "cooldown");
    return;
  }

  if (!scannerInFlightPromiseByMode[modeKey]) {
    scannerInFlightPromiseByMode[modeKey] = buildScannerResponse(req, { includeDebug: modeKey === "debug" })
      .then((result) => {
        if (result.status >= 200 && result.status < 300) {
          scannerSuccessCacheByMode[modeKey] = {
            expiresAt: Date.now() + SCANNER_SUCCESS_TTL_MS,
            payload: result.payload,
          };
          scannerFailureCacheByMode[modeKey] = null;
        } else {
          scannerFailureCacheByMode[modeKey] = {
            expiresAt: Date.now() + SCANNER_FAILURE_TTL_MS,
            status: result.status,
            payload: result.payload,
          };
        }
        return result;
      })
      .finally(() => {
        scannerInFlightPromiseByMode[modeKey] = null;
      });
  }

  const result = await scannerInFlightPromiseByMode[modeKey];
  sendCachedScannerResponse(
    res,
    result.status,
    result.payload,
    result.status >= 200 && result.status < 300 ? "miss" : "error",
  );
};
