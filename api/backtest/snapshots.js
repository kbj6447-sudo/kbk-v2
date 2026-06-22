const {
  ensureStore,
  listSnapshots,
  loadSnapshot,
} = require("../../lib/top-picks-snapshot-store");
const settleHandler = require("../top-picks-settle");
const {
  num,
  normalizeSnapshotItem,
} = require("../../lib/backtest-snapshot-utils");

async function buildRows(maxSnapshots, maxItems) {
  const indexItems = (await listSnapshots()).slice(0, maxSnapshots);
  const snapshots = (await Promise.all(indexItems.map((item) => loadSnapshot(item.snapshotId)))).filter(Boolean);
  const rows = [];

  for (const snapshot of snapshots) {
    for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
      if (!item?.symbol) continue;
      rows.push({
        snapshotId: snapshot.snapshotId,
        status: snapshot.status,
        resolvedAt: snapshot.resolvedAt ?? null,
        ...normalizeSnapshotItem(item, snapshot),
        returnPct: num(item?.tracking?.final?.returnPct ?? item.returnPct),
        returnNow: num(item?.tracking?.final?.returnPct ?? item.returnPct),
        priceNow: num(item.exitPrice),
        exitPrice: num(item.exitPrice),
        selectedCheckpoint: item?.tracking?.final?.selectedCheckpoint ?? null,
        result: item?.tracking?.final?.result ?? "데이터 부족",
        dataQuality: item?.tracking?.final?.dataQuality ?? "데이터 부족",
        firstBarrierHit: item?.tracking?.final?.firstBarrierHit ?? null,
        firstBarrierHitAt: item?.tracking?.final?.firstBarrierHitAt ?? null,
        evaluated: item?.tracking?.final?.status === "ok",
      });
      if (rows.length >= maxItems) break;
    }
    if (rows.length >= maxItems) break;
  }
  return rows;
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

async function settleDueSnapshots() {
  const req = {
    method: "POST",
    url: "/api/top-picks-settle",
    headers: {},
    body: {},
    query: {},
  };
  const res = makeMockRes();
  await settleHandler(req, res);
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  await ensureStore();

  try {
    await settleDueSnapshots();
    const maxSnapshots = Math.max(1, Math.min(20, num(req.query?.snapshots) ?? 5));
    const maxItems = Math.max(1, Math.min(200, num(req.query?.limit) ?? 80));
    const items = await buildRows(maxSnapshots, maxItems);
    const evaluatedCount = items.filter((item) => item.evaluated === true).length;

    return res.status(200).json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        snapshotCount: new Set(items.map((item) => item.snapshotId)).size,
        evaluatedCount,
        items,
      },
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "backtest snapshots failed",
    });
  }
}

module.exports = handler;
