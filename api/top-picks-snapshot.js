const scannerHandler = require("./scanner");
const {
  ensureStore,
  saveSnapshot,
  toSafeSnapshotId,
  cleanupDedupe,
  hasRecentDedupe,
  markDedupe,
} = require("../lib/top-picks-snapshot-store");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

const TRACKING_WINDOWS_MINUTES = [5, 10, 30, 60];
const DEFAULT_CATEGORY_LIMIT = 25;
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

function makeMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeScanner() {
  const req = {
    method: "GET",
    url: "/api/scanner",
    headers: {},
    query: {},
  };
  const res = makeMockRes();
  await scannerHandler(req, res);
  if (res.statusCode >= 400 || !res.body?.ok) {
    throw new Error(res.body?.message || `scanner failed: ${res.statusCode}`);
  }
  return res.body;
}

function normalizeItems(items, limit) {
  const grouped = new Map();
  for (const item of items) {
    const category = item?.category ?? item?.selectionGroup ?? item?.stage ?? "top-picks";
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(item);
  }
  const selected = [];
  for (const categoryItems of grouped.values()) {
    const top = [...categoryItems]
      .sort((a, b) => {
        const as = num(a?.finalSelectionScore ?? a?.topPickDisplayFinalScore ?? a?.topPickFinalScore ?? a?.finalProbabilityScore ?? a?.scannerScore) ?? -1;
        const bs = num(b?.finalSelectionScore ?? b?.topPickDisplayFinalScore ?? b?.topPickFinalScore ?? b?.finalProbabilityScore ?? b?.scannerScore) ?? -1;
        return bs - as;
      })
      .slice(0, limit);
    selected.push(...top);
  }
  return selected
    .filter((item) => item?.symbol && item.included !== false)
    .sort((a, b) => {
      const as = num(a?.finalSelectionScore ?? a?.topPickDisplayFinalScore ?? a?.topPickFinalScore ?? a?.finalProbabilityScore ?? a?.scannerScore) ?? -1;
      const bs = num(b?.finalSelectionScore ?? b?.topPickDisplayFinalScore ?? b?.topPickFinalScore ?? b?.finalProbabilityScore ?? b?.scannerScore) ?? -1;
      return bs - as;
    })
    .map((item, index) => {
      const entryPrice = num(item.price ?? item.preMarketPrice ?? item.regularMarketPrice);
      const stopLossPrice = num(item.stopLossPrice ?? item.atrStopPrice) ?? (entryPrice !== null ? Number((entryPrice * 0.97).toFixed(4)) : null);
      const takeProfitPrice = num(item.takeProfitPrice ?? item.targetPrice) ?? (entryPrice !== null ? Number((entryPrice * 1.05).toFixed(4)) : null);
      const riskFlags = [
        (num(item.topPickChaseRisk ?? item.chaseRisk) ?? 0) >= 75 ? "high-chase-risk" : null,
        String(item.topPickVerdict ?? "").includes("금지") ? "forbidden-verdict" : null,
        item.debugFallbackReason ? "fallback-data" : null,
      ].filter(Boolean);
      const scanTime = new Date().toISOString();
      const tracking = {
        windows: Object.fromEntries(
          TRACKING_WINDOWS_MINUTES.map((minutes) => [`m${minutes}`, {
            minutes,
            targetTime: addMinutes(scanTime, minutes),
            status: "pending",
            price: null,
            returnPct: null,
            firstBarrierHit: null,
            reachedStopLoss: false,
            reachedTakeProfit: false,
          }]),
        ),
        eod: {
          targetTime: addMinutes(scanTime, 360),
          status: "pending",
          price: null,
          returnPct: null,
          firstBarrierHit: null,
          reachedStopLoss: false,
          reachedTakeProfit: false,
        },
        final: {
          status: "pending",
          selectedCheckpoint: null,
          returnPct: null,
          result: "데이터 부족",
          dataQuality: "데이터 부족",
        },
      };
      return {
      rank: index + 1,
      symbol: item.symbol,
      timestamp: scanTime,
      scanTime,
      ticker: item.symbol,
      category: item.category ?? item.selectionGroup ?? item.stage ?? "top-picks",
      verdict: item.topPickVerdict ?? item.verdict ?? null,
      actionSignal: item.actionSignal ?? item.decision ?? item.topPickVerdict ?? item.verdict ?? null,
      decision: item.decision ?? item.topPickVerdict ?? item.verdict ?? null,
      score: num(item.topPickDisplayFinalScore ?? item.topPickFinalScore ?? item.finalProbabilityScore ?? item.scannerScore),
      finalScore: num(item.topPickFinalScore ?? item.finalScore),
      displayFinalScore: num(item.topPickDisplayFinalScore ?? item.displayFinalScore),
      chaseRisk: num(item.topPickChaseRisk ?? item.chaseRisk),
      finalSelectionScore: num(item.finalSelectionScore),
      entrySuitability: num(item.entrySuitability ?? item.topPickFinalScore),
      quantitativeScore: num(item.quantitativeScore),
      chartPatternScore: num(item.chartPatternScore ?? item.patternSimilarityScore),
      volumeConfirmationScore: num(item.volumeConfirmationScore),
      patternName: item.patternName ?? item.bestPatternName ?? null,
      bestPatternName: item.bestPatternName ?? item.patternName ?? null,
      selectionGroup: item.selectionGroup ?? null,
      statusBadge: item.statusBadge ?? null,
      grade: item.topPickGrade ?? null,
      verdictReasonCodes: Array.isArray(item.topPickVerdictReasonCodes) ? item.topPickVerdictReasonCodes : [],
      rsi: num(item?.rsi ?? item?.technical?.rsi),
      rvol: num(item.rvol ?? item.relativeVolume ?? item.volumeRatio),
      vwapStatus: item?.technical?.vwapState ?? item?.vwapState ?? (item.aboveVwap === true ? "VWAP 위" : item.aboveVwap === false ? "VWAP 아래" : null),
      vwapState: item?.technical?.vwapState ?? item?.vwapState ?? null,
      oneMinuteTrend: item?.oneMinuteTrend ?? item?.technical?.oneMinuteTrend ?? null,
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      price: entryPrice,
      priceAtScan: entryPrice,
      changePercentAtScan: num(item.changePercent ?? item.preMarketChangePercent),
      changePercent: num(item.changePercent ?? item.preMarketChangePercent),
      volume: num(item.volume ?? item.preMarketVolume ?? item.regularMarketVolume),
      relativeVolume: num(item.rvol ?? item.relativeVolume ?? item.volumeRatio),
      tradeValueKrw: num(item.tradeValueKrw),
      scannerMode: item.sessionLabel ?? item.sessionType ?? null,
      signalState: item.topPickVerdict ?? item.statusBadge ?? item.selectionGroup ?? null,
      dataQuality: item.dataReliabilityLabel ?? item.dataReliability ?? "미확인",
      riskFlags,
      source: item.source ?? item.sourceTag ?? "scanner",
      tracking,
    };
    });
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  await ensureStore();

  try {
    const payload = await invokeScanner();
    const sourceUpdatedAt = payload?.data?.updatedAt ?? null;
    const capturedAt = new Date().toISOString();
    const snapshotId = toSafeSnapshotId(sourceUpdatedAt || capturedAt);
    const requestedCount = Math.max(1, Math.min(30, num(req?.body?.count) ?? DEFAULT_CATEGORY_LIMIT));
    const dedupeWindowMs = Math.max(30_000, Math.min(10 * 60 * 1000, num(req?.body?.dedupeWindowMs) ?? DEDUPE_WINDOW_MS));
    cleanupDedupe(Date.now(), dedupeWindowMs);
    const items = normalizeItems(payload?.data?.items ?? [], requestedCount);
    const dedupedItems = items.filter((item) => {
      const key = `manual:${item.ticker}:${item.category}:${Math.floor(Date.now() / dedupeWindowMs)}`;
      if (hasRecentDedupe(key, Date.now(), dedupeWindowMs)) return false;
      markDedupe(key, Date.now());
      return true;
    });
    const notes = [];

    if (!dedupedItems.length) {
      notes.push("scanner response did not include any candidate items");
    }
    if (dedupedItems.some((item) => item.verdict === null)) {
      notes.push("scanner response did not include Top Picks verdict; stored as null");
    }
    if (dedupedItems.some((item) => item.finalScore === null)) {
      notes.push("scanner response did not include Top Picks finalScore; stored as null");
    }
    if (dedupedItems.some((item) => item.displayFinalScore === null)) {
      notes.push("scanner response did not include Top Picks displayFinalScore; stored as null");
    }
    if (dedupedItems.some((item) => item.chaseRisk === null)) {
      notes.push("scanner response did not include Top Picks chaseRisk; stored as null");
    }

    const snapshot = {
      snapshotId,
      capturedAt,
      sourceUpdatedAt,
      source: payload?.data?.source ?? "scanner",
      status: "pending",
      resolveAfter: addMinutes(capturedAt, 5),
      notes,
      items: dedupedItems.map((item) => ({ ...item, timestamp: capturedAt, scanTime: capturedAt })),
    };

    const summary = await saveSnapshot(snapshot);
    return res.status(200).json({
      ok: true,
      snapshotId,
      capturedAt,
      sourceUpdatedAt,
      status: "pending",
      resolveAfter: snapshot.resolveAfter,
      count: dedupedItems.length,
      notes,
      summary,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "snapshot save failed",
    });
  }
}

module.exports = handler;
