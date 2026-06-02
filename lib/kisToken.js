const KIS_BASE_URL = "https://openapi.koreainvestment.com:9443";
const TOKEN_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

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

  cachedToken = accessToken;
  cachedTokenExpiresAt = Date.now() + TOKEN_CACHE_TTL_MS;
  logKis(caller, "New token issued", details);
  return cachedToken;
}

async function getKisAccessToken(caller = "unknown", details = {}) {
  const safeCaller = normalizeKisCaller(caller);
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now) {
    logKis(safeCaller, "Reusing cached token", details);
    return cachedToken;
  }

  if (cachedToken && cachedTokenExpiresAt <= now) {
    logKis(safeCaller, "Token expired, issuing new token", details);
  }

  if (pendingTokenPromise) {
    logKis(safeCaller, "Waiting for pending token request", details);
    return pendingTokenPromise;
  }

  pendingTokenPromise = issueKisAccessToken(safeCaller, details)
    .catch((error) => {
      console.error(`[KIS][${safeCaller}] Token request failed${formatLogDetails(details)}`, error instanceof Error ? error.message : error);
      return null;
    })
    .finally(() => {
      pendingTokenPromise = null;
    });

  return pendingTokenPromise;
}

module.exports = {
  KIS_BASE_URL,
  getKisAccessToken,
};
