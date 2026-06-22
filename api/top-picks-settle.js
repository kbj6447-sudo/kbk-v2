const quoteHandler = require("./quote");
const historyHandler = require("./history");
const {
  ensureStore,
  saveSnapshot,
  loadSnapshot,
  listPendingSnapshots,
} = require("../lib/top-picks-snapshot-store");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  if (!values.length) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

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

function toTimeMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function valueFromBar(bar, key) {
  const direct = num(bar?.[key]);
  if (direct !== null) return direct;
  if (key === "timestamp") {
    const parsed = Date.parse(String(bar?.time || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nearestPriceAt(bars, targetMs) {
  if (!Number.isFinite(targetMs)) return null;
  let candidate = null;
  let smallestDiff = Number.POSITIVE_INFINITY;
  for (const bar of bars) {
    const ts = valueFromBar(bar, "timestamp");
    const close = valueFromBar(bar, "close");
    if (!Number.isFinite(ts) || close === null) continue;
    const diff = Math.abs(ts - targetMs);
    if (diff < smallestDiff) {
      smallestDiff = diff;
      candidate = close;
    }
  }
  if (!Number.isFinite(smallestDiff)) return null;
  return smallestDiff <= 20 * 60 * 1000 ? candidate : null;
}

function detectFirstBarrierHit(bars, entryMs, stopLossPrice, takeProfitPrice) {
  if (!Number.isFinite(entryMs)) return null;
  if (stopLossPrice === null && takeProfitPrice === null) return null;
  for (const bar of bars) {
    const ts = valueFromBar(bar, "timestamp");
    if (!Number.isFinite(ts) || ts < entryMs) continue;
    const high = valueFromBar(bar, "high");
    const low = valueFromBar(bar, "low");
    const open = valueFromBar(bar, "open");
    const close = valueFromBar(bar, "close");
    const hitStop = stopLossPrice !== null && low !== null && low <= stopLossPrice;
    const hitTakeProfit = takeProfitPrice !== null && high !== null && high >= takeProfitPrice;
    if (hitStop && hitTakeProfit) {
      const pivot = open ?? close ?? takeProfitPrice;
      const distStop = Math.abs(pivot - stopLossPrice);
      const distTakeProfit = Math.abs(pivot - takeProfitPrice);
      return {
        at: new Date(ts).toISOString(),
        barrier: distTakeProfit <= distStop ? "takeProfit" : "stopLoss",
        ambiguousSameBar: true,
      };
    }
    if (hitTakeProfit) {
      return { at: new Date(ts).toISOString(), barrier: "takeProfit", ambiguousSameBar: false };
    }
    if (hitStop) {
      return { at: new Date(ts).toISOString(), barrier: "stopLoss", ambiguousSameBar: false };
    }
  }
  return null;
}

async function invokeQuote(symbol) {
  const req = {
    method: "GET",
    url: `/api/quote?symbol=${encodeURIComponent(symbol)}`,
    headers: {},
    query: { symbol },
  };
  const res = makeMockRes();
  await quoteHandler(req, res);
  if (res.statusCode >= 400 || !res.body?.ok) {
    throw new Error(res.body?.message || `quote failed: ${symbol}`);
  }
  const data = res.body?.data ?? {};
  return num(data.price ?? data.preMarketPrice ?? data.regularMarketPrice);
}

async function invokeHistory(symbol, fromIso) {
  const req = {
    method: "GET",
    url: `/api/history?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(fromIso)}&interval=1m`,
    headers: { "x-kis-caller": "top-picks-settle" },
    query: {
      symbol,
      from: fromIso,
      interval: "1m",
    },
  };
  const res = makeMockRes();
  await historyHandler(req, res);
  if (res.statusCode >= 400 || !res.body?.ok) {
    throw new Error(res.body?.message || `history failed: ${symbol}`);
  }
  return Array.isArray(res.body?.data?.bars) ? res.body.data.bars : [];
}

function updateItemTracking(item, bars, nowMs) {
  const entryPrice = num(item.entryPrice ?? item.priceAtScan);
  const stopLossPrice = num(item.stopLossPrice);
  const takeProfitPrice = num(item.takeProfitPrice);
  const entryMs = toTimeMs(item.scanTime || item.timestamp);
  const tracking = item.tracking && typeof item.tracking === "object" ? item.tracking : {};
  const windows = tracking.windows && typeof tracking.windows === "object" ? tracking.windows : {};
  const firstBarrierHit = detectFirstBarrierHit(bars, entryMs, stopLossPrice, takeProfitPrice);
  const nextWindows = {};

  for (const [windowKey, windowInfo] of Object.entries(windows)) {
    const targetMs = toTimeMs(windowInfo?.targetTime);
    const due = Number.isFinite(targetMs) && targetMs <= nowMs;
    if (!due) {
      nextWindows[windowKey] = windowInfo;
      continue;
    }
    if (windowInfo?.status === "ok" || windowInfo?.status === "insufficient") {
      nextWindows[windowKey] = windowInfo;
      continue;
    }
    const checkpointPrice = nearestPriceAt(bars, targetMs);
    const returnPct = checkpointPrice !== null && entryPrice !== null && entryPrice > 0
      ? Number((((checkpointPrice - entryPrice) / entryPrice) * 100).toFixed(4))
      : null;
    nextWindows[windowKey] = {
      ...windowInfo,
      status: checkpointPrice === null ? "insufficient" : "ok",
      price: checkpointPrice,
      returnPct,
      firstBarrierHit: firstBarrierHit?.barrier ?? null,
      reachedStopLoss: firstBarrierHit?.barrier === "stopLoss",
      reachedTakeProfit: firstBarrierHit?.barrier === "takeProfit",
      settledAt: new Date().toISOString(),
    };
  }

  const eod = tracking.eod && typeof tracking.eod === "object" ? tracking.eod : null;
  let nextEod = eod;
  if (eod) {
    const targetMs = toTimeMs(eod.targetTime);
    const due = Number.isFinite(targetMs) && targetMs <= nowMs;
    if (due && eod.status !== "ok" && eod.status !== "insufficient") {
      const checkpointPrice = nearestPriceAt(bars, targetMs);
      const returnPct = checkpointPrice !== null && entryPrice !== null && entryPrice > 0
        ? Number((((checkpointPrice - entryPrice) / entryPrice) * 100).toFixed(4))
        : null;
      nextEod = {
        ...eod,
        status: checkpointPrice === null ? "insufficient" : "ok",
        price: checkpointPrice,
        returnPct,
        firstBarrierHit: firstBarrierHit?.barrier ?? null,
        reachedStopLoss: firstBarrierHit?.barrier === "stopLoss",
        reachedTakeProfit: firstBarrierHit?.barrier === "takeProfit",
        settledAt: new Date().toISOString(),
      };
    }
  }

  const orderedCheckpoints = ["m60", "m30", "m10", "m5"];
  let selectedCheckpoint = null;
  let selectedReturn = null;
  for (const checkpoint of orderedCheckpoints) {
    const info = nextWindows[checkpoint];
    if (info?.status === "ok" && num(info.returnPct) !== null) {
      selectedCheckpoint = checkpoint;
      selectedReturn = num(info.returnPct);
      break;
    }
  }
  if (selectedReturn === null && nextEod?.status === "ok") {
    selectedCheckpoint = "eod";
    selectedReturn = num(nextEod.returnPct);
  }
  const sufficient = selectedReturn !== null;
  const barrier = firstBarrierHit?.barrier ?? null;
  const finalResult = !sufficient
    ? "데이터 부족"
    : barrier === "takeProfit"
      ? "익절 선도달"
      : barrier === "stopLoss"
        ? "손절 선도달"
        : selectedReturn >= 0
          ? "수익"
          : "손실";

  const nextTracking = {
    ...tracking,
    windows: nextWindows,
    eod: nextEod,
    final: {
      status: sufficient ? "ok" : "insufficient",
      selectedCheckpoint,
      returnPct: selectedReturn,
      result: finalResult,
      dataQuality: sufficient ? "실측" : "데이터 부족",
      firstBarrierHit: barrier,
      firstBarrierHitAt: firstBarrierHit?.at ?? null,
    },
  };

  const pendingTargets = [
    ...Object.values(nextWindows).filter((windowInfo) => windowInfo?.status === "pending"),
    ...(nextEod?.status === "pending" ? [nextEod] : []),
  ]
    .map((windowInfo) => String(windowInfo.targetTime || ""))
    .filter(Boolean)
    .sort();

  return {
    ...item,
    tracking: nextTracking,
    returnPct: selectedReturn,
    exitPrice: selectedCheckpoint === "eod"
      ? num(nextEod?.price)
      : num(nextWindows?.[selectedCheckpoint]?.price),
    dataQuality: sufficient ? "실측" : "데이터 부족",
    nextResolveAfter: pendingTargets[0] || null,
  };
}

function summarizeSnapshot(snapshot) {
  const returns = snapshot.items
    .map((item) => num(item?.tracking?.final?.returnPct))
    .filter((value) => value !== null);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const winRate = returns.length ? Number(((wins.length / returns.length) * 100).toFixed(2)) : null;
  const avgWin = wins.length ? average(wins) : null;
  const avgLoss = losses.length ? Number(Math.abs(average(losses)).toFixed(4)) : null;
  const profitLossRatio = avgWin !== null && avgLoss !== null && avgLoss > 0
    ? Number((avgWin / avgLoss).toFixed(4))
    : null;
  const enoughStats = returns.length >= 5 && wins.length > 0 && losses.length > 0;
  return {
    evaluatedCount: returns.length,
    winRate: enoughStats ? winRate : null,
    avgReturn: enoughStats ? average(returns) : null,
    avgWinReturn: enoughStats ? avgWin : null,
    avgLossReturn: enoughStats ? avgLoss : null,
    profitLossRatio: enoughStats ? profitLossRatio : null,
    dataStatus: enoughStats ? "ok" : "데이터 부족",
  };
}

async function resolveSnapshot(snapshot) {
  const next = JSON.parse(JSON.stringify(snapshot));
  next.resolvedAt = new Date().toISOString();
  const nowMs = Date.now();
  const quoteCache = new Map();
  const historyCache = new Map();
  next.items = await Promise.all((Array.isArray(next.items) ? next.items : []).map(async (item) => {
    const symbol = String(item?.symbol || "").toUpperCase();
    if (!symbol) return item;
    const fromIso = item.scanTime || item.timestamp || new Date(nowMs - 6 * 60 * 60 * 1000).toISOString();

    if (!historyCache.has(symbol)) {
      historyCache.set(symbol, invokeHistory(symbol, fromIso).catch(() => []));
    }
    if (!quoteCache.has(symbol)) {
      quoteCache.set(symbol, invokeQuote(symbol).catch(() => null));
    }

    const bars = await historyCache.get(symbol);
    const withTracking = updateItemTracking(item, bars, nowMs);
    if (num(withTracking?.tracking?.final?.returnPct) === null) {
      const quotePrice = await quoteCache.get(symbol);
      if (quotePrice !== null && num(withTracking.entryPrice) > 0) {
        const fallbackReturn = Number((((quotePrice - withTracking.entryPrice) / withTracking.entryPrice) * 100).toFixed(4));
        withTracking.tracking.final = {
          ...withTracking.tracking.final,
          status: "ok",
          selectedCheckpoint: withTracking.tracking.final.selectedCheckpoint || "quote",
          returnPct: fallbackReturn,
          result: fallbackReturn >= 0 ? "수익(현재가)" : "손실(현재가)",
          dataQuality: "실측",
        };
        withTracking.returnPct = fallbackReturn;
        withTracking.exitPrice = quotePrice;
      }
    }
    return withTracking;
  }));

  const pendingResolveAfter = next.items
    .map((item) => item?.nextResolveAfter || null)
    .filter(Boolean)
    .sort()[0] || null;

  next.resolveAfter = pendingResolveAfter;
  next.status = pendingResolveAfter ? "pending" : "completed";
  next.summary = summarizeSnapshot(next);
  return next;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  await ensureStore();

  try {
    const nowIso = new Date().toISOString();
    const body = req.body || {};
    const force = body.force === true || String(req.query?.force || "") === "true";
    const snapshotId = body.snapshotId || req.query?.snapshotId || null;

    let targets = [];
    if (snapshotId) {
      const snapshot = await loadSnapshot(snapshotId);
      if (!snapshot) {
        return res.status(404).json({ ok: false, message: "snapshot not found" });
      }
      if (snapshot.status === "completed" || snapshot.status === "failed") {
        return res.status(200).json({ ok: true, processed: 0, snapshots: [snapshot] });
      }
      if (!force && String(snapshot.resolveAfter || "") > nowIso) {
        return res.status(200).json({ ok: true, processed: 0, snapshots: [], message: "snapshot is not ready to settle yet" });
      }
      targets = [snapshot];
    } else {
      targets = force ? [] : await listPendingSnapshots(nowIso);
    }

    if (!targets.length) {
      return res.status(200).json({ ok: true, processed: 0, snapshots: [] });
    }

    const results = [];
    for (const snapshot of targets) {
      const settled = await resolveSnapshot(snapshot);
      await saveSnapshot(settled);
      results.push(settled);
    }

    return res.status(200).json({
      ok: true,
      processed: results.length,
      snapshots: results,
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "settle failed",
    });
  }
}

module.exports = handler;
