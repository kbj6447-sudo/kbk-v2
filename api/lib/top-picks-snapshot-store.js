const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data", "top-picks-snapshots");
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const INDEX_FILE = path.join(DATA_DIR, "index.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toSafeSnapshotId(value) {
  const base = String(value || new Date().toISOString());
  return base.replace(/[^\w.-]+/g, "-");
}

function snapshotFile(snapshotId) {
  return path.join(SNAPSHOT_DIR, `${toSafeSnapshotId(snapshotId)}.json`);
}

async function ensureStore() {
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  try {
    await fs.access(INDEX_FILE);
  } catch {
    await fs.writeFile(INDEX_FILE, JSON.stringify({ items: [] }, null, 2), "utf8");
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") return clone(fallback);
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readIndex() {
  await ensureStore();
  const index = await readJson(INDEX_FILE, { items: [] });
  if (!Array.isArray(index.items)) index.items = [];
  return index;
}

async function writeIndex(index) {
  await ensureStore();
  await writeJson(INDEX_FILE, index);
}

function summarizeSnapshot(snapshot) {
  const summary = snapshot.summary || {};
  return {
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt || null,
    status: snapshot.status,
    resolveAfter: snapshot.resolveAfter || null,
    resolvedAt: snapshot.resolvedAt || null,
    itemCount: Array.isArray(snapshot.items) ? snapshot.items.length : 0,
    buyAvgReturn: summary.buyAvgReturn ?? null,
    watchAvgReturn: summary.watchAvgReturn ?? null,
    blockAvgReturn: summary.blockAvgReturn ?? null,
    buyCount: summary.buyCount ?? 0,
    watchCount: summary.watchCount ?? 0,
    blockCount: summary.blockCount ?? 0,
    notes: Array.isArray(snapshot.notes) ? snapshot.notes : [],
  };
}

async function saveSnapshot(snapshot) {
  await ensureStore();
  const filePath = snapshotFile(snapshot.snapshotId);
  await writeJson(filePath, snapshot);

  const index = await readIndex();
  const summary = summarizeSnapshot(snapshot);
  const nextItems = index.items.filter((item) => item.snapshotId !== snapshot.snapshotId);
  nextItems.unshift(summary);
  index.items = nextItems.sort((a, b) => String(b.capturedAt || "").localeCompare(String(a.capturedAt || "")));
  await writeIndex(index);
  return summary;
}

async function loadSnapshot(snapshotId) {
  await ensureStore();
  return readJson(snapshotFile(snapshotId), null);
}

async function listSnapshots() {
  const index = await readIndex();
  return index.items;
}

async function listPendingSnapshots(nowIso = new Date().toISOString()) {
  const items = await listSnapshots();
  const eligible = items.filter((item) => {
    if (item.status !== "pending") return false;
    if (!item.resolveAfter) return false;
    return String(item.resolveAfter) <= String(nowIso);
  });
  const snapshots = await Promise.all(eligible.map((item) => loadSnapshot(item.snapshotId)));
  return snapshots.filter(Boolean);
}

module.exports = {
  DATA_DIR,
  SNAPSHOT_DIR,
  INDEX_FILE,
  ensureStore,
  toSafeSnapshotId,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  listPendingSnapshots,
};
