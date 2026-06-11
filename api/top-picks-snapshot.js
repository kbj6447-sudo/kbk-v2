const scannerHandler = require("./scanner");
const {
  ensureStore,
  saveSnapshot,
  toSafeSnapshotId,
} = require("./lib/top-picks-snapshot-store");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
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
  return items
    .filter((item) => item?.symbol && item.included !== false)
    .slice(0, limit)
    .map((item, index) => ({
      rank: index + 1,
      symbol: item.symbol,
      scanTime: null,
      category: item.category ?? item.stage ?? "top-picks",
      verdict: item.topPickVerdict ?? item.verdict ?? null,
      actionSignal: item.actionSignal ?? item.decision ?? item.topPickVerdict ?? item.verdict ?? null,
      decision: item.decision ?? item.topPickVerdict ?? item.verdict ?? null,
      score: num(item.topPickFinalScore ?? item.finalProbabilityScore ?? item.scannerScore),
      finalScore: num(item.topPickFinalScore ?? item.finalScore),
      displayFinalScore: num(item.topPickDisplayFinalScore ?? item.displayFinalScore),
      chaseRisk: num(item.topPickChaseRisk ?? item.chaseRisk),
      grade: item.topPickGrade ?? null,
      verdictReasonCodes: Array.isArray(item.topPickVerdictReasonCodes) ? item.topPickVerdictReasonCodes : [],
      rsi: num(item?.rsi ?? item?.technical?.rsi),
      rvol: num(item.relativeVolume ?? item.volumeRatio),
      vwapStatus: item?.technical?.vwapState ?? item?.vwapState ?? (item.aboveVwap === true ? "VWAP 위" : item.aboveVwap === false ? "VWAP 아래" : null),
      vwapState: item?.technical?.vwapState ?? item?.vwapState ?? null,
      oneMinuteTrend: item?.oneMinuteTrend ?? item?.technical?.oneMinuteTrend ?? null,
      entryPrice: num(item.price ?? item.preMarketPrice ?? item.regularMarketPrice),
      priceAtScan: num(item.price ?? item.preMarketPrice ?? item.regularMarketPrice),
      changePercentAtScan: num(item.changePercent ?? item.preMarketChangePercent),
      volume: num(item.volume ?? item.preMarketVolume ?? item.regularMarketVolume),
      source: item.source ?? item.sourceTag ?? "scanner",
    }));
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
    const requestedCount = Math.max(1, Math.min(50, num(req?.body?.count) ?? 13));
    const items = normalizeItems(payload?.data?.items ?? [], requestedCount);
    const notes = [];

    if (!items.length) {
      notes.push("scanner response did not include any candidate items");
    }
    if (items.some((item) => item.verdict === null)) {
      notes.push("scanner response did not include Top Picks verdict; stored as null");
    }
    if (items.some((item) => item.finalScore === null)) {
      notes.push("scanner response did not include Top Picks finalScore; stored as null");
    }
    if (items.some((item) => item.displayFinalScore === null)) {
      notes.push("scanner response did not include Top Picks displayFinalScore; stored as null");
    }
    if (items.some((item) => item.chaseRisk === null)) {
      notes.push("scanner response did not include Top Picks chaseRisk; stored as null");
    }

    const snapshot = {
      snapshotId,
      capturedAt,
      sourceUpdatedAt,
      source: payload?.data?.source ?? "scanner",
      status: "pending",
      resolveAfter: addMinutes(capturedAt, 30),
      notes,
      items: items.map((item) => ({ ...item, scanTime: capturedAt })),
    };

    const summary = await saveSnapshot(snapshot);
    return res.status(200).json({
      ok: true,
      snapshotId,
      capturedAt,
      sourceUpdatedAt,
      status: "pending",
      resolveAfter: snapshot.resolveAfter,
      count: items.length,
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
