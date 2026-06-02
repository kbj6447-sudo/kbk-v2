const KIS_BASE_URL = "https://openapi.koreainvestment.com:9443";
const DEFAULT_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const TOKEN_REFRESH_BUFFER_MS = 60 * 60 * 1000;
const REDIS_TOKEN_KEY = "kis:access_token";
const REDIS_EXPIRES_AT_KEY = "kis:access_token_expires_at";
const REDIS_LOCK_KEY = "kis:token_lock";
const REDIS_LOCK_TTL_SECONDS = 30;
const REDIS_LOCK_WAIT_MS = 35 * 1000;
const REDIS_LOCK_POLL_MS = 300;

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let pendingTokenPromise = null;

function normalizeKisCaller(caller) {
  const normalized = String(caller || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return normalized || "unknown";
}

function formatLogDetails(details = {}) {
  const text = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return text ? ` ${text}` : "";
}

function logKis(caller, message, details) {
  console.log(`[KIS][${caller}] ${message}${formatLogDetails(details)}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTokenFresh(expiresAt, now = Date.now()) {
  return Boolean(expiresAt && expiresAt > now + TOKEN_REFRESH_BUFFER_MS);
}

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return {
    url: url.replace(/\/+$/, ""),
    token,
  };
}

async function redisCommand(command, ...args) {
  const config = redisConfig();
  if (!config) return { configured: false, result: null };

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify([command, ...args]),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || `Upstash Redis HTTP ${response.status}`);
  }

  return { configured: true, result: payload?.result };
}

async function readRedisToken() {
  const tokenResult = await redisCommand("GET", REDIS_TOKEN_KEY);
  if (!tokenResult.configured) return { configured: false, token: "", expiresAt: 0 };

  const expiresAtResult = await redisCommand("GET", REDIS_EXPIRES_AT_KEY);
  return {
    configured: true,
    token: typeof tokenResult.result === "string" ? tokenResult.result : "",
    expiresAt: num(expiresAtResult.result) || 0,
  };
}

async function writeRedisToken(token, expiresAt) {
  const ttlSeconds = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
  await redisCommand("SET", REDIS_TOKEN_KEY, token, "EX", ttlSeconds);
  await redisCommand("SET", REDIS_EXPIRES_AT_KEY, String(expiresAt), "EX", ttlSeconds);
}

async function acquireRedisLock(lockValue) {
  const result = await redisCommand("SET", REDIS_LOCK_KEY, lockValue, "NX", "EX", REDIS_LOCK_TTL_SECONDS);
  return result.configured && result.result === "OK";
}

async function releaseRedisLock(lockValue) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisCommand("EVAL", script, "1", REDIS_LOCK_KEY, lockValue);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function issueKisAccessToken(caller, details) {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) return null;

  const tokenResult = await fetchJson(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      appsecret: appSecret,
    }),
  });

  const accessToken = tokenResult?.payload?.access_token || null;
  if (!tokenResult.response.ok || !accessToken) return null;

  const expiresInSeconds = num(tokenResult.payload?.expires_in) || DEFAULT_TOKEN_TTL_SECONDS;
  cachedToken = accessToken;
  cachedTokenExpiresAt = Date.now() + expiresInSeconds * 1000;
  logKis(caller, "New token issued", details);
  return {
    token: cachedToken,
    expiresAt: cachedTokenExpiresAt,
  };
}

async function getKisAccessToken(caller = "unknown", details = {}) {
  const safeCaller = normalizeKisCaller(caller);
  const now = Date.now();
  if (cachedToken && isTokenFresh(cachedTokenExpiresAt, now)) {
    logKis(safeCaller, "Reusing cached token", details);
    return cachedToken;
  }

  if (pendingTokenPromise) {
    logKis(safeCaller, "Waiting for pending token request", details);
    return pendingTokenPromise;
  }

  pendingTokenPromise = resolveKisAccessToken(safeCaller, details)
    .catch((error) => {
      console.error(`[KIS][${safeCaller}] Token request failed${formatLogDetails(details)}`, error instanceof Error ? error.message : error);
      return null;
    })
    .finally(() => {
      pendingTokenPromise = null;
    });

  return pendingTokenPromise;
}

async function resolveKisAccessToken(caller, details) {
  try {
    const redisToken = await readRedisToken();
    if (redisToken.configured) {
      if (redisToken.token && isTokenFresh(redisToken.expiresAt)) {
        cachedToken = redisToken.token;
        cachedTokenExpiresAt = redisToken.expiresAt;
        logKis(caller, "Reusing cached token", details);
        return cachedToken;
      }

      if (redisToken.token) {
        logKis(caller, "Token expired, issuing new token", details);
      }

      return issueTokenWithRedisLock(caller, details);
    }
  } catch (error) {
    console.error(`[KIS][${caller}] Redis token lookup failed${formatLogDetails(details)}`, error instanceof Error ? error.message : error);
  }

  if (cachedToken && !isTokenFresh(cachedTokenExpiresAt)) {
    logKis(caller, "Token expired, issuing new token", details);
  }

  const issued = await issueKisAccessToken(caller, details);
  return issued?.token || null;
}

async function issueTokenWithRedisLock(caller, details) {
  const lockValue = `${caller}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const waitStartedAt = Date.now();
  let loggedWait = false;

  while (Date.now() - waitStartedAt < REDIS_LOCK_WAIT_MS) {
    const redisToken = await readRedisToken();
    if (redisToken.configured && redisToken.token && isTokenFresh(redisToken.expiresAt)) {
      cachedToken = redisToken.token;
      cachedTokenExpiresAt = redisToken.expiresAt;
      logKis(caller, "Reusing cached token", details);
      return cachedToken;
    }

    const locked = await acquireRedisLock(lockValue);
    if (locked) {
      try {
        const latestToken = await readRedisToken();
        if (latestToken.configured && latestToken.token && isTokenFresh(latestToken.expiresAt)) {
          cachedToken = latestToken.token;
          cachedTokenExpiresAt = latestToken.expiresAt;
          logKis(caller, "Reusing cached token", details);
          return cachedToken;
        }

        const issued = await issueKisAccessToken(caller, details);
        if (issued?.token && issued.expiresAt) {
          await writeRedisToken(issued.token, issued.expiresAt);
          return issued.token;
        }
        return null;
      } finally {
        await releaseRedisLock(lockValue).catch((error) => {
          console.error(`[KIS][${caller}] Redis lock release failed${formatLogDetails(details)}`, error instanceof Error ? error.message : error);
        });
      }
    }

    if (!loggedWait) {
      logKis(caller, "Waiting for pending token request", details);
      loggedWait = true;
    }
    await sleep(REDIS_LOCK_POLL_MS);
  }

  console.error(`[KIS][${caller}] Timed out waiting for Redis token lock${formatLogDetails(details)}`);
  return null;
}

module.exports = {
  KIS_BASE_URL,
  getKisAccessToken,
};
