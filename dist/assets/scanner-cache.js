(function installScannerCache() {
  if (typeof window === "undefined" || typeof window.fetch !== "function" || window.__kbkScannerCacheInstalled) {
    return;
  }

  window.__kbkScannerCacheInstalled = true;

  var SCANNER_CACHE_TTL_MS = 45 * 1000;
  var SCANNER_STALE_MS = 5 * 60 * 1000;
  var FORCE_REFRESH_WINDOW_MS = 2500;
  var originalFetch = window.fetch.bind(window);
  var cachedEntry = null;
  var inFlightEntryPromise = null;
  var forceRefreshUntil = 0;

  function now() {
    return Date.now();
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

  function responseFromEntry(entry) {
    return new Response(entry.body, {
      status: entry.status,
      statusText: entry.statusText,
      headers: entry.headers,
    });
  }

  async function fetchAndCache(input, init) {
    var response = await originalFetch(input, init);
    var body = await response.clone().text();
    var headers = {};
    response.headers.forEach(function copyHeader(value, key) {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) return;
      headers[key] = value;
    });

    if (response.ok) {
      cachedEntry = {
        body: body,
        status: response.status,
        statusText: response.statusText,
        headers: headers,
        cachedAt: now(),
      };
    }

    return {
      body: body,
      status: response.status,
      statusText: response.statusText,
      headers: headers,
      cachedAt: now(),
    };
  }

  function refreshInBackground(input, init) {
    if (inFlightEntryPromise) return;
    inFlightEntryPromise = fetchAndCache(input, init)
      .catch(function logRefreshFailure(error) {
        console.warn("[SCANNER_CACHE] background refresh failed", error);
        return null;
      })
      .finally(function clearInFlight() {
        inFlightEntryPromise = null;
      });
  }

  function shouldForceRefresh() {
    return now() < forceRefreshUntil;
  }

  function markForceRefresh() {
    forceRefreshUntil = now() + FORCE_REFRESH_WINDOW_MS;
  }

  window.__kbkRefreshScannerCache = function refreshScannerCache() {
    markForceRefresh();
  };

  window.__kbkClearScannerCache = function clearScannerCache() {
    cachedEntry = null;
    inFlightEntryPromise = null;
    markForceRefresh();
  };

  window.fetch = function cachedFetch(input, init) {
    if (!isScannerRequest(input, init)) {
      return originalFetch(input, init);
    }

    var age = cachedEntry ? now() - cachedEntry.cachedAt : Infinity;
    var force = shouldForceRefresh();

    if (!force && cachedEntry && age <= SCANNER_CACHE_TTL_MS) {
      return Promise.resolve(responseFromEntry(cachedEntry));
    }

    if (!force && cachedEntry && age <= SCANNER_STALE_MS) {
      refreshInBackground(input, init);
      return Promise.resolve(responseFromEntry(cachedEntry));
    }

    if (!inFlightEntryPromise) {
      inFlightEntryPromise = fetchAndCache(input, init)
        .finally(function clearInFlight() {
          inFlightEntryPromise = null;
          forceRefreshUntil = 0;
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
      /새로고침|전체 분석|감시 갱신|Refresh/i.test(text)
    ) {
      markForceRefresh();
    }
  }, true);
})();
