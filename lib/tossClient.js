// 토스증권 Open API 조회 전용 클라이언트.
// - 주문/계좌 API는 의도적으로 포함하지 않는다.
// - TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 없으면 isEnabled() 가 false 이고, 호출하는 쪽은 기존 Yahoo/KIS 경로를 그대로 쓴다.
// - 토스 키는 허용 IP(본인 PC)에서만 작동하므로 Vercel 배포본에서는 자동으로 비활성 상태가 된다.

const DEFAULT_BASE_URL = "https://openapi.tossinvest.com";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_RETRIES = 2;

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let pendingTokenPromise = null;
let lastRequestAt = 0;
let requestChain = Promise.resolve();
let disabledUntil = 0;
const lastRateLimit = {};

function baseUrl() {
  return String(process.env.TOSS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function minIntervalMs() {
  const value = Number(process.env.TOSS_MIN_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 120;
}

function isEnabled() {
  if (String(process.env.TOSS_DISABLED || "").toLowerCase() === "true") return false;
  if (Date.now() < disabledUntil) return false;
  return Boolean(process.env.TOSS_CLIENT_ID && process.env.TOSS_CLIENT_SECRET);
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[TOSS] ${message}`);
}

// 인증 오류(IP 미허용, 키 오류)가 나면 일정 시간 토스 호출을 멈추고 기존 경로로 넘긴다.
function pauseToss(reason, ms = 5 * 60 * 1000) {
  disabledUntil = Date.now() + ms;
  log(`paused ${Math.round(ms / 1000)}s: ${reason}`);
}

// 요청 간 최소 간격을 두어 호출 한도(429)를 피한다.
function throttle() {
  const run = requestChain.then(async () => {
    const wait = lastRequestAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  requestChain = run.catch(() => {});
  return run;
}

async function issueToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TOSS_CLIENT_ID || "",
    client_secret: process.env.TOSS_CLIENT_SECRET || "",
  });
  await throttle();
  const response = await fetch(`${baseUrl()}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    const code = payload?.error?.code || payload?.error || `http-${response.status}`;
    if (response.status === 401 || response.status === 403) pauseToss(`token ${code}`);
    throw new Error(`toss token failed: ${code}`);
  }
  const ttlMs = (num(payload.expires_in) ?? 3600) * 1000;
  cachedToken = payload.access_token;
  cachedTokenExpiresAt = Date.now() + ttlMs;
  log(`token issued, expires in ${Math.round(ttlMs / 60000)}m`);
  return cachedToken;
}

async function getToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedToken && cachedTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cachedToken;
  }
  // 클라이언트당 유효 토큰은 1개뿐이므로 동시 발급을 하나로 묶는다.
  if (!pendingTokenPromise) {
    pendingTokenPromise = issueToken().finally(() => {
      pendingTokenPromise = null;
    });
  }
  return pendingTokenPromise;
}

function recordRateLimit(group, headers) {
  const limit = num(headers.get("x-ratelimit-limit"));
  const remaining = num(headers.get("x-ratelimit-remaining"));
  if (limit === null && remaining === null) return;
  lastRateLimit[group] = { limit, remaining, at: new Date().toISOString() };
}

async function request(path, params = {}, group = "MARKET_DATA") {
  if (!isEnabled()) throw new Error("toss disabled");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const url = `${baseUrl()}${path}${query.toString() ? `?${query}` : ""}`;
  let tokenRefreshed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const token = await getToken();
    await throttle();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    recordRateLimit(group, response.headers);
    const payload = await response.json().catch(() => null);

    if (response.ok && payload && Object.prototype.hasOwnProperty.call(payload, "result")) {
      return payload.result;
    }
    const code = payload?.error?.code || `http-${response.status}`;

    if (response.status === 401 && !tokenRefreshed) {
      // 다른 프로그램(점검 스크립트 등)이 새 토큰을 발급하면 기존 토큰이 즉시 무효화된다.
      tokenRefreshed = true;
      await getToken({ forceRefresh: true });
      continue;
    }
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = num(response.headers.get("retry-after")) ?? 1;
      await sleep(Math.min(5, Math.max(1, retryAfter)) * 1000);
      continue;
    }
    if (response.status === 401 || response.status === 403) pauseToss(`${path} ${code}`);
    throw new Error(`toss ${path} failed: ${code}`);
  }
  throw new Error(`toss ${path} failed: retries exhausted`);
}

// 랭킹: type = MARKET_TRADING_VOLUME | MARKET_TRADING_AMOUNT | TOP_GAINERS | TOP_LOSERS ...
// TOP_GAINERS / TOP_LOSERS 는 duration=realtime 을 지원하지 않는다.
async function getRankings({ type, duration = "realtime", marketCountry = "US", count = 100, excludeInvestmentCaution = false } = {}) {
  const result = await request("/api/v1/rankings", {
    type,
    duration,
    marketCountry,
    count,
    excludeInvestmentCaution,
  }, "RANKING");
  const rankings = Array.isArray(result?.rankings) ? result.rankings : [];
  return {
    rankedAt: result?.rankedAt || null,
    items: rankings.map((entry) => {
      const changeRate = num(entry?.price?.changeRate);
      return {
        rank: num(entry?.rank),
        symbol: String(entry?.symbol || "").toUpperCase(),
        lastPrice: num(entry?.price?.lastPrice),
        basePrice: num(entry?.price?.basePrice),
        changePercent: changeRate === null ? null : changeRate * 100,
        tradingVolume: num(entry?.tradingVolume),
        tradingAmount: num(entry?.tradingAmount),
        currency: entry?.currency || null,
      };
    }).filter((entry) => entry.symbol),
  };
}

// 현재가: 최대 200종목.
async function getPrices(symbols = []) {
  const clean = [...new Set(symbols.map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  const map = new Map();
  for (let start = 0; start < clean.length; start += 200) {
    const chunk = clean.slice(start, start + 200);
    const result = await request("/api/v1/prices", { symbols: chunk.join(",") }, "MARKET_DATA");
    for (const entry of Array.isArray(result) ? result : []) {
      const symbol = String(entry?.symbol || "").toUpperCase();
      if (!symbol) continue;
      map.set(symbol, { symbol, lastPrice: num(entry.lastPrice), timestamp: entry.timestamp || null });
    }
  }
  return map;
}

// 1분봉: 토스는 최신순으로 주고 timestamp 가 "봉 종료 시각"이다.
// 반환값은 오래된 순서, time = 봉 시작 시각(Yahoo 와 동일 기준).
async function getMinuteBars(symbol, count = 120) {
  const result = await request("/api/v1/candles", {
    symbol: String(symbol || "").toUpperCase(),
    interval: "1m",
    count: Math.min(200, Math.max(1, count)),
  }, "MARKET_DATA_CHART");
  const candles = Array.isArray(result?.candles) ? result.candles : [];
  return candles
    .map((candle) => {
      const endMs = Date.parse(candle?.timestamp);
      const close = num(candle?.closePrice);
      return {
        time: Number.isFinite(endMs) ? new Date(endMs - 60 * 1000).toISOString() : null,
        endTime: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
        open: num(candle?.openPrice) ?? close,
        high: num(candle?.highPrice) ?? close,
        low: num(candle?.lowPrice) ?? close,
        close,
        volume: num(candle?.volume),
      };
    })
    .filter((bar) => bar.time && bar.close !== null && bar.close > 0)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

async function getOrderbook(symbol) {
  const result = await request("/api/v1/orderbook", { symbol: String(symbol || "").toUpperCase() }, "MARKET_DATA");
  const asks = (result?.asks || []).map((e) => ({ price: num(e.price), volume: num(e.volume) })).filter((e) => e.price !== null);
  const bids = (result?.bids || []).map((e) => ({ price: num(e.price), volume: num(e.volume) })).filter((e) => e.price !== null);
  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const mid = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  return {
    timestamp: result?.timestamp || null,
    bestAsk,
    bestBid,
    spreadPercent: mid ? ((bestAsk - bestBid) / mid) * 100 : null,
    asks,
    bids,
  };
}

function getStatus() {
  return {
    enabled: isEnabled(),
    configured: Boolean(process.env.TOSS_CLIENT_ID && process.env.TOSS_CLIENT_SECRET),
    pausedUntil: disabledUntil > Date.now() ? new Date(disabledUntil).toISOString() : null,
    hasToken: Boolean(cachedToken && cachedTokenExpiresAt > Date.now()),
    rateLimit: { ...lastRateLimit },
  };
}

module.exports = {
  isEnabled,
  getRankings,
  getPrices,
  getMinuteBars,
  getOrderbook,
  getStatus,
};
