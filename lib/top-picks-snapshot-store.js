const DATA_DIR = null;
const SNAPSHOT_DIR = null;
const INDEX_FILE = null;
const MAX_SNAPSHOTS = 240;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toSafeSnapshotId(value) {
  const base = String(value || new Date().toISOString());
  return base.replace(/[^\w.-]+/g, "-");
}

function getStore() {
  if (!globalThis.__KBK_TOP_PICKS_STORE__) {
    globalThis.__KBK_TOP_PICKS_STORE__ = {
      snapshots: new Map(),
      index: [],
      dedupe: new Map(),
      initializedAt: new Date().toISOString(),
    };
  }
  return globalThis.__KBK_TOP_PICKS_STORE__;
}

async function ensureStore() {
  getStore();
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
    gradeSAvgReturn: summary.gradeSAvgReturn ?? null,
    gradeAAvgReturn: summary.gradeAAvgReturn ?? null,
    gradeBAvgReturn: summary.gradeBAvgReturn ?? null,
    gradeCAvgReturn: summary.gradeCAvgReturn ?? null,
    gradeDAvgReturn: summary.gradeDAvgReturn ?? null,
    gradeSCount: summary.gradeSCount ?? 0,
    gradeACount: summary.gradeACount ?? 0,
    gradeBCount: summary.gradeBCount ?? 0,
    gradeCCount: summary.gradeCCount ?? 0,
    gradeDCount: summary.gradeDCount ?? 0,
    notes: Array.isArray(snapshot.notes) ? snapshot.notes : [],
  };
}

async function saveSnapshot(snapshot) {
  await ensureStore();
  const store = getStore();
  const safeSnapshot = clone({
    ...snapshot,
    snapshotId: toSafeSnapshotId(snapshot?.snapshotId),
  });
  store.snapshots.set(safeSnapshot.snapshotId, safeSnapshot);
  const summary = summarizeSnapshot(safeSnapshot);
  const nextItems = store.index.filter((item) => item.snapshotId !== safeSnapshot.snapshotId);
  nextItems.unshift(summary);
  store.index = nextItems
    .sort((a, b) => String(b.capturedAt || "").localeCompare(String(a.capturedAt || "")))
    .slice(0, MAX_SNAPSHOTS);

  const allowed = new Set(store.index.map((item) => item.snapshotId));
  for (const snapshotId of [...store.snapshots.keys()]) {
    if (!allowed.has(snapshotId)) store.snapshots.delete(snapshotId);
  }
  return summary;
}

async function loadSnapshot(snapshotId) {
  await ensureStore();
  const store = getStore();
  const found = store.snapshots.get(toSafeSnapshotId(snapshotId));
  return found ? clone(found) : null;
}

async function listSnapshots() {
  await ensureStore();
  return clone(getStore().index);
}

async function listPendingSnapshots(nowIso = new Date().toISOString()) {
  const items = await listSnapshots();
  const eligible = items.filter((item) => {
    if (item.status !== "pending") return false;
    if (item.resolveAfter && String(item.resolveAfter) <= String(nowIso)) return true;
    return !item.resolveAfter;
  });
  const snapshots = await Promise.all(eligible.map((item) => loadSnapshot(item.snapshotId)));
  return snapshots.filter(Boolean);
}

function cleanupDedupe(nowMs = Date.now(), windowMs = 2 * 60 * 1000) {
  const store = getStore();
  for (const [key, value] of store.dedupe.entries()) {
    if ((nowMs - value) > windowMs) store.dedupe.delete(key);
  }
}

function markDedupe(key, nowMs = Date.now()) {
  getStore().dedupe.set(key, nowMs);
}

function hasRecentDedupe(key, nowMs = Date.now(), windowMs = 2 * 60 * 1000) {
  const seenAt = getStore().dedupe.get(key);
  return Number.isFinite(seenAt) && (nowMs - seenAt) <= windowMs;
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
  cleanupDedupe,
  hasRecentDedupe,
  markDedupe,
};
