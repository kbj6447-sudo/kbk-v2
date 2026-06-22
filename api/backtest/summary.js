const snapshotsHandler = require("./snapshots");
const settleHandler = require("../top-picks-settle");
const {
  summarizeByScoreBand,
  average,
} = require("../../lib/backtest-snapshot-utils");

function buildCategoryStats(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = String(item.category || "unknown");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const stats = [];
  for (const [category, rows] of grouped.entries()) {
    const returns = rows
      .map((row) => Number(row.returnNow))
      .filter((value) => Number.isFinite(value));
    const wins = returns.filter((value) => value > 0);
    const losses = returns.filter((value) => value < 0);
    const avgWin = wins.length ? Number((wins.reduce((sum, value) => sum + value, 0) / wins.length).toFixed(4)) : null;
    const avgLoss = losses.length ? Number(Math.abs(losses.reduce((sum, value) => sum + value, 0) / losses.length).toFixed(4)) : null;
    const winRate = returns.length ? Number(((wins.length / returns.length) * 100).toFixed(2)) : null;
    const enough = returns.length >= 5 && wins.length > 0 && losses.length > 0;
    stats.push({
      category,
      sampleCount: returns.length,
      winRate: enough ? winRate : null,
      avgReturn: enough ? average(returns) : null,
      avgWinReturn: enough ? avgWin : null,
      avgLossReturn: enough ? avgLoss : null,
      profitLossRatio: enough && avgWin !== null && avgLoss !== null && avgLoss > 0
        ? Number((avgWin / avgLoss).toFixed(4))
        : null,
      dataStatus: enough ? "ok" : "데이터 부족",
    });
  }
  return stats.sort((a, b) => b.sampleCount - a.sampleCount);
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

async function invokeSnapshots(query = {}) {
  const req = {
    method: "GET",
    url: "/api/backtest/snapshots",
    headers: {},
    query,
  };
  const res = makeMockRes();
  await snapshotsHandler(req, res);
  if (res.statusCode >= 400 || !res.body?.ok) {
    throw new Error(res.body?.message || `snapshots failed: ${res.statusCode}`);
  }
  return res.body?.data ?? {};
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

  try {
    await settleDueSnapshots();
    const data = await invokeSnapshots(req.query || {});
    const items = Array.isArray(data.items) ? data.items : [];
    const evaluated = items.filter((item) => item.evaluated);

    return res.status(200).json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        snapshotCount: data.snapshotCount ?? 0,
        evaluatedCount: evaluated.length,
        avgReturnNow: evaluated.length >= 5 ? average(evaluated.map((item) => item.returnNow)) : null,
        statsDataStatus: evaluated.length >= 5 ? "ok" : "데이터 부족",
        scoreBands: summarizeByScoreBand(evaluated),
        categoryStats: buildCategoryStats(evaluated),
        recentResults: evaluated
          .slice()
          .sort((a, b) => String(b.scanTime || "").localeCompare(String(a.scanTime || "")))
          .slice(0, 20),
      },
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "backtest summary failed",
    });
  }
}

module.exports = handler;
