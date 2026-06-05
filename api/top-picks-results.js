const {
  ensureStore,
  listSnapshots,
  loadSnapshot,
} = require("./lib/top-picks-snapshot-store");

async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  await ensureStore();

  try {
    const snapshotId = req.query?.snapshotId || null;
    if (snapshotId) {
      const snapshot = await loadSnapshot(snapshotId);
      if (!snapshot) {
        return res.status(404).json({ ok: false, message: "snapshot not found" });
      }
      return res.status(200).json({ ok: true, snapshot });
    }

    const items = await listSnapshots();
    return res.status(200).json({ ok: true, items });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "results lookup failed",
    });
  }
}

module.exports = handler;
