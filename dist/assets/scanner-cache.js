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
  var SCANNER_ITEM_LIMIT = 120;
  var SCANNER_TOP_PICK_LIMIT = 20;
  var SCANNER_BUCKET_LIMIT = 30;
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

  function isFullScannerRequest(input) {
    var url = scannerUrl(input);
    if (!url) return false;
    return url.searchParams.has("debug") || url.searchParams.has("full");
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

  function compactReasons(reasons) {
    return (Array.isArray(reasons) ? reasons : [])
      .filter(function validReason(reason) {
        return typeof reason === "string" && reason.trim();
      })
      .map(function trimReason(reason) {
        return reason.length > 120 ? reason.slice(0, 117) + "..." : reason;
      })
      .slice(0, 3);
  }

  function sanitizeScannerItem(item) {
    if (!item || typeof item !== "object") return item;
    return {
      symbol: item.symbol,
      name: item.name,
      price: item.price,
      changePercent: item.changePercent,
      volume: item.volume,
      relativeVolume: item.relativeVolume ?? item.volumeRatio,
      stage: item.stage,
      stageLabelKo: item.stageLabelKo,
      riskLabelKo: item.riskLabelKo,
      scannerScore: item.scannerScore,
      finalProbabilityScore: item.finalProbabilityScore,
      finalSelectionScore: item.finalSelectionScore,
      marketPrioritySortScore: item.marketPrioritySortScore,
      changePenalty: item.changePenalty,
      isPreSurgeCandidate: item.isPreSurgeCandidate,
      isChasingRisk: item.isChasingRisk,
      isOverheated: item.isOverheated,
      selectionReasons: compactReasons(item.selectionReasons),
      included: item.included,
      volumeRatio: item.volumeRatio ?? item.relativeVolume,
      rvol: item.rvol ?? item.relativeVolume ?? item.volumeRatio,
      preMarketVolume: item.preMarketVolume,
      regularMarketVolume: item.regularMarketVolume,
      postMarketVolume: item.postMarketVolume,
      previousClose: item.previousClose,
      regularMarketPreviousClose: item.regularMarketPreviousClose,
      preMarketPrice: item.preMarketPrice,
      regularMarketPrice: item.regularMarketPrice,
      postMarketPrice: item.postMarketPrice,
      priceSource: item.priceSource,
      volumeSource: item.volumeSource,
      changeBasis: item.changeBasis,
      sessionType: item.sessionType,
      dataReliability: item.dataReliability,
      dataReliabilityLabel: item.dataReliabilityLabel,
      riskScore: item.riskScore,
      surgePrecursorScore: item.surgePrecursorScore,
      momentumExpansionScore: item.momentumExpansionScore,
      patternSimilarityScore: item.patternSimilarityScore,
      chartPatternScore: item.chartPatternScore,
      patternName: item.patternName,
      bestPatternName: item.bestPatternName,
      entrySuitability: item.entrySuitability,
      topPickFinalScore: item.topPickFinalScore,
      topPickDisplayFinalScore: item.topPickDisplayFinalScore,
      topPickChaseRisk: item.topPickChaseRisk,
      topPickVerdict: item.topPickVerdict,
      topPickGrade: item.topPickGrade,
      quantitativeScore: item.quantitativeScore,
      volumeConfirmationScore: item.volumeConfirmationScore,
      selectionGroup: item.selectionGroup,
      statusBadge: item.statusBadge,
      volumeQualityScore: item.volumeQualityScore,
      surgeAccelerationScore: item.surgeAccelerationScore,
      volumeAccelerationScore: item.volumeAccelerationScore,
      higherLowScore: item.higherLowScore,
      vwapHoldScore: item.vwapHoldScore,
      vwapReclaimScore: item.vwapReclaimScore,
      reSurgeSetupScore: item.reSurgeSetupScore,
      vwap: item.vwap,
      vwapState: item.vwapState,
      aboveVwap: item.aboveVwap,
      oneMinuteTrend: item.oneMinuteTrend,
      rsi: item.rsi,
      dayHigh: item.dayHigh ?? item.regularMarketDayHigh,
      dayLow: item.dayLow ?? item.regularMarketDayLow,
      sourceTags: Array.isArray(item.sourceTags) ? item.sourceTags.slice(0, 5) : undefined,
    };
  }

  function limitItems(items, limit) {
    return (Array.isArray(items) ? items : [])
      .slice(0, limit)
      .map(sanitizeScannerItem);
  }

  function normalizeScannerPayload(payload) {
    if (!payload || typeof payload !== "object") return payload;
    var data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : null;
    var items = Array.isArray(data?.items) ? data.items : Array.isArray(payload.items) ? payload.items : [];
    if (!data && !items.length) return payload;
    var normalizedData = data ? { ...data } : {};
    normalizedData.items = limitItems(items, SCANNER_ITEM_LIMIT);
    if (Array.isArray(data?.topPicks)) normalizedData.topPicks = limitItems(data.topPicks, SCANNER_TOP_PICK_LIMIT);
    if (Array.isArray(data?.shortTermCandidates)) normalizedData.shortTermCandidates = limitItems(data.shortTermCandidates, SCANNER_BUCKET_LIMIT);
    if (Array.isArray(data?.underOneCandidates)) normalizedData.underOneCandidates = limitItems(data.underOneCandidates, SCANNER_BUCKET_LIMIT);
    if (Array.isArray(data?.overOneCandidates)) normalizedData.overOneCandidates = limitItems(data.overOneCandidates, SCANNER_BUCKET_LIMIT);
    if (Array.isArray(data?.accumulationCandidates)) normalizedData.accumulationCandidates = limitItems(data.accumulationCandidates, SCANNER_BUCKET_LIMIT);
    return {
      ...payload,
      data: normalizedData,
      items: Array.isArray(payload.items) ? limitItems(payload.items, SCANNER_ITEM_LIMIT) : payload.items,
      topPicks: Array.isArray(payload.topPicks) ? limitItems(payload.topPicks, SCANNER_TOP_PICK_LIMIT) : payload.topPicks,
      candidates: Array.isArray(payload.candidates) ? limitItems(payload.candidates, SCANNER_ITEM_LIMIT) : payload.candidates,
    };
  }

  function normalizeScannerBody(body) {
    try {
      return JSON.stringify(normalizeScannerPayload(JSON.parse(body)));
    } catch (_error) {
      return body;
    }
  }

  function setCachedEntry(entry) {
    entry.body = normalizeScannerBody(entry.body);
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
      body = normalizeScannerBody(body);
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

    var entry = createEntry(normalizeScannerBody(body), response.status, response.statusText, headers, now());
    if (response.ok && body) {
      setCachedEntry(entry);
    }

    return entry;
  }

  function parseEntryBody(entry) {
    try {
      return entry ? normalizeScannerPayload(JSON.parse(entry.body)) : null;
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

    if (isFullScannerRequest(input)) {
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
