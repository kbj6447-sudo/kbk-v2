const quoteHandler = require("../quote");
const {
  ensureStore,
  listSnapshots,
  loadSnapshot,
} = require("../../lib/top-picks-snapshot-store");
const {
  num,
  normalizeSnapshotItem,
  attachCurrentResult,
  mapWithLimit,
} = require("../../lib/backtest-snapshot-utils");

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
        returnPct: num(item.returnPct),
        exitPrice: num(item.exitPrice),
      });
      if (rows.length >= maxItems) break;
    }
    if (rows.length >= maxItems) break;
  }

  const priceCache = new Map();
  return mapWithLimit(rows, 4, async (row) => {
    let currentPrice = row.exitPrice;
    if (!priceCache.has(row.symbol)) {
      try {
        priceCache.set(row.symbol, await invokeQuote(row.symbol));
      } catch (error) {
        priceCache.set(row.symbol, currentPrice ?? null);
      }
    }
    currentPrice = priceCache.get(row.symbol);
    return attachCurrentResult(row, currentPrice);
  });
}

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  await ensureStore();

  try {
    const maxSnapshots = Math.max(1, Math.min(20, num(req.query?.snapshots) ?? 5));
    const maxItems = Math.max(1, Math.min(200, num(req.query?.limit) ?? 80));
    const items = await buildRows(maxSnapshots, maxItems);
    const evaluatedCount = items.filter((item) => item.evaluated).length;

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
