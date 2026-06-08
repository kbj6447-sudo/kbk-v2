// api/exchange.js — USD/KRW 환율 (open.er-api.com 프록시, 1시간 캐시)

const EXCHANGE_SOURCE = "open.er-api.com";
const EXCHANGE_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const CACHE_MS = 60 * 60 * 1000; // 1시간
const STALE_MS = 2 * 60 * 60 * 1000; // 2시간 초과 시 stale

let cached = null;
let cachedAt = 0;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseUpdatedAt(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPayload(krw, sourceUpdatedAt, fetchedAt, fromCache = false) {
  const sourceUpdatedAtMs = parseUpdatedAt(sourceUpdatedAt);
  const ageMs = Math.max(0, fetchedAt - cachedAt);
  const sourceAgeMs = sourceUpdatedAtMs ? Math.max(0, fetchedAt - sourceUpdatedAtMs) : null;
  const stale = ageMs > STALE_MS || (sourceAgeMs !== null && sourceAgeMs > 24 * 60 * 60 * 1000);

  return {
    usdKrw: krw,
    rate: krw,
    base: "USD",
    source: EXCHANGE_SOURCE,
    sourceUrl: EXCHANGE_SOURCE_URL,
    updatedAt: sourceUpdatedAt || new Date(fetchedAt).toUTCString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    cachedAt: new Date(cachedAt).toISOString(),
    fromCache,
    cacheTtlMs: CACHE_MS,
    ageMs,
    sourceAgeMs,
    stale,
  };
}

async function fetchLiveRate() {
  const response = await fetch(EXCHANGE_SOURCE_URL, {
    headers: { accept: "application/json" },
  });
  const payload = await response.json();

  if (!response.ok || payload?.result !== "success") {
    throw new Error(payload?.error_type || `HTTP ${response.status}`);
  }

  const krw = num(payload?.rates?.KRW);
  if (krw === null) throw new Error("KRW rate not found in response");

  const fetchedAt = Date.now();
  cachedAt = fetchedAt;
  cached = {
    usdKrw: krw,
    rate: krw,
    base: "USD",
    source: EXCHANGE_SOURCE,
    sourceUrl: EXCHANGE_SOURCE_URL,
    updatedAt: payload.time_last_update_utc || new Date(fetchedAt).toUTCString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    cachedAt: new Date(fetchedAt).toISOString(),
  };

  return buildPayload(krw, cached.updatedAt, fetchedAt, false);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const now = Date.now();

    if (cached && now - cachedAt < CACHE_MS) {
      const payload = buildPayload(cached.usdKrw, cached.updatedAt, now, true);
      res.setHeader("cache-control", `public, max-age=${Math.floor((CACHE_MS - (now - cachedAt)) / 1000)}`);
      return res.status(200).json({ ok: true, data: payload, stale: payload.stale });
    }

    const payload = await fetchLiveRate();
    res.setHeader("cache-control", "public, max-age=3600");
    return res.status(200).json({ ok: true, data: payload, stale: payload.stale });
  } catch (error) {
    if (cached) {
      const payload = buildPayload(cached.usdKrw, cached.updatedAt, Date.now(), true);
      payload.stale = true;
      res.setHeader("cache-control", "no-store");
      return res.status(200).json({
        ok: true,
        data: payload,
        stale: true,
        fallback: "cached",
        message: error instanceof Error ? error.message : "exchange fetch failed",
      });
    }

    return res.status(502).json({
      ok: false,
      code: "EXCHANGE_ERROR",
      message: error instanceof Error ? error.message : "exchange handler failed",
      source: EXCHANGE_SOURCE,
    });
  }
};
