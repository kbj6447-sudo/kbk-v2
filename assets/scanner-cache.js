(function installScannerCache() {
  if (typeof window === "undefined" || typeof window.fetch !== "function" || window.__kbkScannerCacheInstalled) {
    return;
  }

  window.__kbkScannerCacheInstalled = true;

  var SCANNER_CACHE_TTL_MS = 120 * 1000;
  var SCANNER_STALE_MS = 30 * 60 * 1000;
  var FORCE_REFRESH_WINDOW_MS = 2500;
  var SCANNER_CACHE_KEY = "kbk:scanner:lastResponse";
  var SCANNER_CACHE_UPDATED_AT_KEY = "kbk:scanner:lastUpdatedAt";
  var SCANNER_FORCE_UNTIL_KEY = "kbk:scanner:forceUntil";
  var FORCE_REFRESH_LABELS = ["새로고침", "전체 분석", "감시 갱신", "Refresh"];
  var originalFetch = window.fetch.bind(window);
  var cachedEntry = null;
  var inFlightEntryPromise = null;
  var forceRefreshUntil = readPersistedForceUntil();
  var fetchStats = window.__kbkFetchStats || {
    scanner: 0,
    scannerNetwork: 0,
    scannerCacheHits: 0,
    history: 0,
    quote: 0,
    exchange: 0,
  };

  window.__kbkFetchStats = fetchStats;

  function now() {
    return Date.now();
  }

  function readPersistedForceUntil() {
    try {
      var stored = Number(sessionStorage.getItem(SCANNER_FORCE_UNTIL_KEY) || 0);
      return Number.isFinite(stored) ? stored : 0;
    } catch (_error) {
      return 0;
    }
  }

  function persistForceUntil(until) {
    forceRefreshUntil = until;
    try {
      if (until > now()) {
        sessionStorage.setItem(SCANNER_FORCE_UNTIL_KEY, String(until));
      } else {
        sessionStorage.removeItem(SCANNER_FORCE_UNTIL_KEY);
      }
    } catch (_error) {}
  }

  function scannerUrl(input) {
    var raw = typeof input === "string" ? input : input && input.url;
    if (!raw) return null;
    try {
      return new URL(raw, window.location.origin);
    } catch (_error) {
      return null;
    }
  }

  function isScannerRequest(input, init) {
    var url = scannerUrl(input);
    if (!url || url.origin !== window.location.origin || url.pathname !== "/api/scanner") return false;
    var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    return method === "GET";
  }

  function apiKind(input) {
    var url = scannerUrl(input);
    if (!url || url.origin !== window.location.origin) return "";
    if (url.pathname === "/api/scanner") return "scanner";
    if (url.pathname === "/api/history") return "history";
    if (url.pathname === "/api/quote") return "quote";
    if (url.pathname === "/api/exchange") return "exchange";
    return "";
  }

  function isCacheAgeValid(cachedAt) {
    return Number.isFinite(cachedAt) && cachedAt > 0 && (now() - cachedAt) <= SCANNER_STALE_MS;
  }

  function clearPersistedCache() {
    try {
      localStorage.removeItem(SCANNER_CACHE_KEY);
      localStorage.removeItem(SCANNER_CACHE_UPDATED_AT_KEY);
    } catch (_error) {}
  }

  function buildHeaders(headers) {
    if (headers && typeof headers === "object") return headers;
    return {
      "content-type": "application/json; charset=utf-8",
      "x-kbk-scanner-cache": "localStorage",
    };
  }

  function createEntry(body, status, statusText, headers, cachedAt) {
    return {
      body: body,
      status: status || 200,
      statusText: statusText || "OK",
      headers: buildHeaders(headers),
      cachedAt: cachedAt || now(),
    };
  }

  function setCachedEntry(entry) {
    cachedEntry = entry;
    try {
      localStorage.setItem(SCANNER_CACHE_KEY, entry.body);
      localStorage.setItem(SCANNER_CACHE_UPDATED_AT_KEY, String(entry.cachedAt));
    } catch (_error) {}
  }

  function readPersistedCache() {
    try {
      var body = localStorage.getItem(SCANNER_CACHE_KEY) || "";
      var cachedAt = Number(localStorage.getItem(SCANNER_CACHE_UPDATED_AT_KEY) || 0);
      if (!body || !isCacheAgeValid(cachedAt)) {
        clearPersistedCache();
        return null;
      }
      cachedEntry = createEntry(body, 200, "OK", null, cachedAt);
      return cachedEntry;
    } catch (_error) {
      return null;
    }
  }

  function responseFromEntry(entry) {
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    });
  }

  async function fetchAndCache(input, init) {
    fetchStats.scannerNetwork += 1;
    var response = await originalFetch(input, init);
    var body = await response.clone().text();
    var headers = {};
    response.headers.forEach(function copyHeader(value, key) {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) return;
      headers[key] = value;
    });

    var entry = createEntry(body, response.status, response.statusText, headers, now());
    if (response.ok && body) {
      setCachedEntry(entry);
    }

    return entry;
  }

  function parseEntryBody(entry) {
    try {
      return entry ? JSON.parse(entry.body) : null;
    } catch (_error) {
      return null;
    }
  }

  function shouldForceRefresh() {
    return now() < forceRefreshUntil;
  }

  function requestBypassesCache(input, init) {
    var cacheMode = String((init && init.cache) || (input && input.cache) || "").toLowerCase();
    if (cacheMode === "no-store" || cacheMode === "reload") return true;
    var url = scannerUrl(input);
    if (!url) return false;
    return url.searchParams.has("fresh") || url.searchParams.has("noCache") || url.searchParams.has("_");
  }

  function markForceRefresh() {
    persistForceUntil(now() + FORCE_REFRESH_WINDOW_MS);
  }

  function isForceRefreshLabel(text) {
    var normalized = String(text || "");
    return FORCE_REFRESH_LABELS.some(function includesLabel(label) {
      return normalized.indexOf(label) >= 0;
    });
  }

  window.__kbkRefreshScannerCache = function refreshScannerCache() {
    markForceRefresh();
  };

  window.__kbkClearScannerCache = function clearScannerCache() {
    cachedEntry = null;
    inFlightEntryPromise = null;
    clearPersistedCache();
    markForceRefresh();
  };

  window.__kbkResetFetchStats = function resetFetchStats() {
    fetchStats.scanner = 0;
    fetchStats.scannerNetwork = 0;
    fetchStats.scannerCacheHits = 0;
    fetchStats.history = 0;
    fetchStats.quote = 0;
    fetchStats.exchange = 0;
  };

  window.__kbkGetSharedScannerData = function getSharedScannerData(options) {
    var force = Boolean(options && options.force);
    if (force) {
      markForceRefresh();
    }

    if (!cachedEntry || !isCacheAgeValid(cachedEntry.cachedAt)) {
      cachedEntry = readPersistedCache();
    }

    var age = cachedEntry ? now() - cachedEntry.cachedAt : Infinity;
    if (!force && cachedEntry && age <= SCANNER_CACHE_TTL_MS) {
      return Promise.resolve(parseEntryBody(cachedEntry));
    }

    if (!inFlightEntryPromise) {
      inFlightEntryPromise = fetchAndCache("/api/scanner", { cache: "default" })
        .finally(function clearInFlight() {
          inFlightEntryPromise = null;
          persistForceUntil(0);
        });
    }

    return inFlightEntryPromise.then(function toData(entry) {
      return parseEntryBody(entry);
    });
  };

  window.fetch = function cachedFetch(input, init) {
    var kind = apiKind(input);
    if (kind && Object.prototype.hasOwnProperty.call(fetchStats, kind)) {
      fetchStats[kind] += 1;
    }

    if (!isScannerRequest(input, init)) {
      return originalFetch(input, init);
    }

    var force = shouldForceRefresh() || requestBypassesCache(input, init);
    if (!cachedEntry || !isCacheAgeValid(cachedEntry.cachedAt)) {
      cachedEntry = readPersistedCache();
    }

    var age = cachedEntry ? now() - cachedEntry.cachedAt : Infinity;

    if (!force && cachedEntry && age <= SCANNER_CACHE_TTL_MS) {
      fetchStats.scannerCacheHits += 1;
      return Promise.resolve(responseFromEntry(cachedEntry));
    }

    if (!force && cachedEntry && age <= SCANNER_STALE_MS && inFlightEntryPromise) {
      fetchStats.scannerCacheHits += 1;
      return Promise.resolve(responseFromEntry(cachedEntry));
    }

    if (!inFlightEntryPromise) {
      inFlightEntryPromise = fetchAndCache(input, init)
        .finally(function clearInFlight() {
          inFlightEntryPromise = null;
          persistForceUntil(0);
        });
    }

    return inFlightEntryPromise.then(function buildResponse(entry) {
      return responseFromEntry(entry);
    });
  };

  document.addEventListener("click", function markRefreshClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var button = target.closest("button,[role='button'],[data-kbk-page-refresh],#refresh-btn,.kbk-pro-refresh,.kbk-page-refresh");
    if (!button) return;
    var text = button.textContent || "";
    if (
      button.id === "refresh-btn" ||
      button.dataset.kbkPageRefresh ||
      isForceRefreshLabel(text)
    ) {
      markForceRefresh();
    }
  }, true);
})();
