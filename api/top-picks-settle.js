const quoteHandler = require("./quote");
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

function verdictBucket(verdict) {
  if (verdict === "매수 가능") return "buy";
  if (verdict === "진입 금지") return "block";
  return "watch";
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

function settleSnapshot(snapshot) {
  const buckets = {
    buy: [],
    watch: [],
    block: [],
  };
  const gradeBuckets = {
    S: [],
    A: [],
    B: [],
    C: [],
    D: [],
  };
  for (const item of snapshot.items) {
    if (item.returnPct === null || item.returnPct === undefined) continue;
    buckets[verdictBucket(item.verdict)].push(item.returnPct);
    const grade = String(item.grade || "").toUpperCase();
    if (gradeBuckets[grade]) gradeBuckets[grade].push(item.returnPct);
  }
  snapshot.summary = {
    buyAvgReturn: average(buckets.buy),
    watchAvgReturn: average(buckets.watch),
    blockAvgReturn: average(buckets.block),
    buyCount: buckets.buy.length,
    watchCount: buckets.watch.length,
    blockCount: buckets.block.length,
    gradeSAvgReturn: average(gradeBuckets.S),
    gradeAAvgReturn: average(gradeBuckets.A),
    gradeBAvgReturn: average(gradeBuckets.B),
    gradeCAvgReturn: average(gradeBuckets.C),
    gradeDAvgReturn: average(gradeBuckets.D),
    gradeSCount: gradeBuckets.S.length,
    gradeACount: gradeBuckets.A.length,
    gradeBCount: gradeBuckets.B.length,
    gradeCCount: gradeBuckets.C.length,
    gradeDCount: gradeBuckets.D.length,
  };
  return snapshot;
}

async function resolveSnapshot(snapshot) {
  const next = JSON.parse(JSON.stringify(snapshot));
  next.resolvedAt = new Date().toISOString();
  let failures = 0;

  next.items = await Promise.all(next.items.map(async (item) => {
    const resolved = { ...item, exitPrice: null, returnPct: null };
    try {
      const exitPrice = await invokeQuote(item.symbol);
      resolved.exitPrice = exitPrice;
      if (resolved.entryPrice !== null && resolved.entryPrice > 0 && exitPrice !== null) {
        resolved.returnPct = Number((((exitPrice - resolved.entryPrice) / resolved.entryPrice) * 100).toFixed(4));
      }
    } catch (error) {
      failures += 1;
      resolved.error = error instanceof Error ? error.message : "quote failed";
    }
    return resolved;
  }));

  next.status = failures === next.items.length ? "failed" : "completed";
  return settleSnapshot(next);
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
