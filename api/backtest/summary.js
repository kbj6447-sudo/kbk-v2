const snapshotsHandler = require("./snapshots");
const {
  summarizeByScoreBand,
  average,
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

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const data = await invokeSnapshots(req.query || {});
    const items = Array.isArray(data.items) ? data.items : [];
    const evaluated = items.filter((item) => item.evaluated);

    return res.status(200).json({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        snapshotCount: data.snapshotCount ?? 0,
        evaluatedCount: evaluated.length,
        avgReturnNow: average(evaluated.map((item) => item.returnNow)),
        scoreBands: summarizeByScoreBand(evaluated),
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
