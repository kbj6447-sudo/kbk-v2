// api/exchange.js — USD/KRW 환율 (Yahoo Finance USDKRW=X 우선, open.er-api.com fallback)

const PRIMARY_SOURCE = "yahoo-finance";
const PRIMARY_SYMBOL = "USDKRW=X";
const PRIMARY_SOURCE_URL = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(PRIMARY_SYMBOL)}?range=1d&interval=1m&includePrePost=true`;
const FALLBACK_SOURCE = "open.er-api.com";
const FALLBACK_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";
const SPREAD_REVIEW_THRESHOLD = 0.01; // 1%
const CACHE_MS = 5 * 60 * 1000; // 5분
const STALE_MS = 30 * 60 * 1000; // 30분 초과 시 stale

const YAHOO_HEADERS = {
  "user-agent": "Mozilla/5.0",
  accept: "application/json",
};

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

function spreadPct(primaryRate, altRate) {
  const primary = num(primaryRate);
  const alt = num(altRate);
  if (primary === null || alt === null || primary <= 0) return null;
  return Math.abs(primary - alt) / primary;
}

function buildPayload({
  krw,
  source,
  sourceLabel,
  sourceUrl,
  updatedAt,
  fetchedAt,
  fromCache = false,
  fallback = false,
  fallbackReason = null,
  altSource = null,
  altRate = null,
  needsReview = false,
}) {
  const sourceUpdatedAtMs = parseUpdatedAt(updatedAt);
  const ageMs = fromCache ? Math.max(0, fetchedAt - cachedAt) : 0;
  const sourceAgeMs = sourceUpdatedAtMs ? Math.max(0, fetchedAt - sourceUpdatedAtMs) : null;
  const computedSpread = spreadPct(krw, altRate);
  const review = needsReview || (computedSpread !== null && computedSpread >= SPREAD_REVIEW_THRESHOLD);
  const stale = ageMs > STALE_MS || (sourceAgeMs !== null && sourceAgeMs > 24 * 60 * 60 * 1000);

  return {
    usdKrw: krw,
    rate: krw,
    base: "USD",
    source,
    sourceLabel: sourceLabel || source,
    sourceUrl,
    updatedAt: updatedAt || new Date(fetchedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    cachedAt: new Date(cachedAt).toISOString(),
    fromCache,
    fallback,
    fallbackReason,
    altSource,
    altRate,
    spreadPct: computedSpread,
    needsReview: review,
    cacheTtlMs: CACHE_MS,
    ageMs,
    sourceAgeMs,
    stale,
  };
}

async function fetchYahooRate() {
  const response = await fetch(PRIMARY_SOURCE_URL, { headers: YAHOO_HEADERS });
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.chart?.error) {
    throw new Error(payload?.chart?.error?.description || `Yahoo HTTP ${response.status}`);
  }

  const meta = payload?.chart?.result?.[0]?.meta;
  const krw = num(meta?.regularMarketPrice);
  if (krw === null) throw new Error("Yahoo KRW rate not found");

  const marketTimeSec = num(meta?.regularMarketTime);
  const updatedAt = marketTimeSec
    ? new Date(marketTimeSec * 1000).toISOString()
    : new Date().toISOString();

  return {
    krw,
    source: PRIMARY_SOURCE,
    sourceLabel: "Yahoo Finance USDKRW=X",
    sourceUrl: PRIMARY_SOURCE_URL,
    updatedAt,
  };
}

async function fetchErApiRate() {
  const response = await fetch(FALLBACK_SOURCE_URL, {
    headers: { accept: "application/json" },
  });
  const payload = await response.json();

  if (!response.ok || payload?.result !== "success") {
    throw new Error(payload?.error_type || `open.er-api HTTP ${response.status}`);
  }

  const krw = num(payload?.rates?.KRW);
  if (krw === null) throw new Error("KRW rate not found in open.er-api response");

  return {
    krw,
    source: FALLBACK_SOURCE,
    sourceLabel: FALLBACK_SOURCE,
    sourceUrl: FALLBACK_SOURCE_URL,
    updatedAt: payload.time_last_update_utc || new Date().toUTCString(),
  };
}

async function fetchLiveRate() {
  const fetchedAt = Date.now();
  let primary = null;
  let primaryError = null;
  let alt = null;

  try {
    primary = await fetchYahooRate();
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error("Yahoo fetch failed");
  }

  try {
    alt = await fetchErApiRate();
  } catch {
    // Comparison/fallback source is optional when Yahoo succeeds.
  }

  if (primary) {
    cachedAt = fetchedAt;
    const payload = buildPayload({
      krw: primary.krw,
      source: primary.source,
      sourceLabel: primary.sourceLabel,
      sourceUrl: primary.sourceUrl,
      updatedAt: primary.updatedAt,
      fetchedAt,
      fallback: false,
      altSource: alt ? alt.source : null,
      altRate: alt ? alt.krw : null,
    });

    cached = { ...payload };
    return payload;
  }

  if (alt) {
    cachedAt = fetchedAt;
    const payload = buildPayload({
      krw: alt.krw,
      source: alt.source,
      sourceLabel: alt.sourceLabel,
      sourceUrl: alt.sourceUrl,
      updatedAt: alt.updatedAt,
      fetchedAt,
      fallback: true,
      fallbackReason: primaryError?.message || "Yahoo fetch failed",
      altSource: PRIMARY_SOURCE,
      altRate: null,
    });

    cached = { ...payload };
    return payload;
  }

  throw primaryError || new Error("All exchange sources failed");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const now = Date.now();

    if (cached && now - cachedAt < CACHE_MS) {
      const payload = buildPayload({
        krw: cached.usdKrw,
        source: cached.source,
        sourceLabel: cached.sourceLabel,
        sourceUrl: cached.sourceUrl,
        updatedAt: cached.updatedAt,
        fetchedAt: now,
        fromCache: true,
        fallback: cached.fallback === true,
        fallbackReason: cached.fallbackReason || null,
        altSource: cached.altSource || null,
        altRate: cached.altRate ?? null,
        needsReview: cached.needsReview === true,
      });
      res.setHeader("cache-control", `public, max-age=${Math.floor((CACHE_MS - (now - cachedAt)) / 1000)}`);
      return res.status(200).json({ ok: true, data: payload, stale: payload.stale });
    }

    const payload = await fetchLiveRate();
    res.setHeader("cache-control", `public, max-age=${Math.floor(CACHE_MS / 1000)}`);
    return res.status(200).json({ ok: true, data: payload, stale: payload.stale });
  } catch (error) {
    if (cached) {
      const payload = buildPayload({
        krw: cached.usdKrw,
        source: cached.source,
        sourceLabel: cached.sourceLabel,
        sourceUrl: cached.sourceUrl,
        updatedAt: cached.updatedAt,
        fetchedAt: Date.now(),
        fromCache: true,
        fallback: cached.fallback === true,
        fallbackReason: cached.fallbackReason || null,
        altSource: cached.altSource || null,
        altRate: cached.altRate ?? null,
        needsReview: cached.needsReview === true,
      });
      payload.stale = true;
      res.setHeader("cache-control", "no-store");
      return res.status(200).json({
        ok: true,
        data: payload,
        stale: true,
        fallback: cached.fallback ? "open.er-api.com" : "cached",
        message: error instanceof Error ? error.message : "exchange fetch failed",
      });
    }

    return res.status(502).json({
      ok: false,
      code: "EXCHANGE_ERROR",
      message: error instanceof Error ? error.message : "exchange handler failed",
      source: PRIMARY_SOURCE,
      fallbackSource: FALLBACK_SOURCE,
    });
  }
};
