const KIS_BASE_URL = "https://openapi.koreainvestment.com:9443";
const TOKEN_CACHE_TTL_MS = 23 * 60 * 60 * 1000;

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let pendingTokenPromise = null;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function issueKisAccessToken() {
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
  console.log("[KIS] New token issued");
  return cachedToken;
}

async function getKisAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpiresAt > now) {
    console.log("[KIS] Reusing cached token");
    return cachedToken;
  }

  if (cachedToken && cachedTokenExpiresAt <= now) {
    console.log("[KIS] Token expired, issuing new token");
  }

  if (pendingTokenPromise) {
    console.log("[KIS] Waiting for pending token request");
    return pendingTokenPromise;
  }

  pendingTokenPromise = issueKisAccessToken()
    .catch((error) => {
      console.error("[KIS] Token request failed", error instanceof Error ? error.message : error);
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
  // Exported for narrow tests/debugging without exposing tokens through API responses.
  _internal: {
    get cachedToken() {
      return cachedToken;
    },
    get cachedTokenExpiresAt() {
      return cachedTokenExpiresAt;
    },
    get pendingTokenPromise() {
      return pendingTokenPromise;
    },
    TOKEN_CACHE_TTL_MS,
    num,
  },
};
