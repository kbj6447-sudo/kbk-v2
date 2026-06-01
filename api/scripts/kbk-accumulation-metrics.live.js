(function () {
  "use strict";

  const HISTORY_LIMIT = 60;
  const scannerCache = new Map();

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function clamp(value, min = 0, max = 100) {
    return Math.max(min, Math.min(max, value));
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function apiInput(input) {
    return input;
  }

  function priceOf(item) {
    return num(item?.normalizedLivePriceUsd)
      ?? num(item?.price)
      ?? num(item?.preMarketPrice)
      ?? num(item?.regularMarketPrice)
      ?? num(item?.latestClose);
  }

  function vwapOf(item) {
    return num(item?.technical?.vwap) ?? num(item?.vwap);
  }

  function rsiOf(item) {
    return num(item?.technical?.rsi) ?? num(item?.rsi);
  }

  function rvolOf(item) {
    return num(item?.relativeVolume) ?? num(item?.volumeRatio);
  }

  function riskOf(item) {
    return num(item?.riskScore);
  }

  function changeOf(item) {
    return Math.abs(num(item?.changePercent) ?? num(item?.preMarketChangePercent) ?? 0);
  }

  function hasRiskDisclosure(item) {
    const risk = riskOf(item);
    if (risk !== null && risk >= 65) return true;
    const haystack = [
      ...(item?.sourceTags ?? []),
      ...(item?.storyTags ?? []),
      ...(item?.selectionReasons ?? []),
    ].join(" ").toLowerCase();
    return /(dilution|offering|listing|compliance|overheat|risk|공시|희석|상장|과열)/.test(haystack);
  }

  function normalizeBars(payload) {
    const bars = payload?.data?.bars ?? payload?.bars ?? [];
    if (!Array.isArray(bars)) return [];
    return bars
      .map((bar) => ({
        time: bar.time ?? bar.t ?? bar.date,
        open: num(bar.open ?? bar.o),
        high: num(bar.high ?? bar.h),
        low: num(bar.low ?? bar.l),
        close: num(bar.close ?? bar.c),
        volume: num(bar.volume ?? bar.v),
      }))
      .filter((bar) => bar.close !== null);
  }

  function sumVolume(bars) {
    return bars.reduce((sum, bar) => sum + Math.max(num(bar.volume) ?? 0, 0), 0);
  }

  function calculateVolumeAcceleration(bars) {
    const usable = bars.filter((bar) => bar.volume !== null);
    const positive = usable.filter((bar) => (bar.volume ?? 0) > 0);
    if (usable.length < 31 || positive.length < 6) {
      return {
        current1mVolume: null,
        volumeLast5m: null,
        averageVolumeLast5m: null,
        averageVolumeLast30m: null,
        volumeAcceleration1m: null,
        volumeAcceleration5m: null,
        volumeAccelerationStatus: "데이터 부족",
      };
    }

    const last1 = usable.at(-1);
    const prev5 = usable.slice(-6, -1);
    const last5 = usable.slice(-5);
    const prev30 = usable.slice(-35, -5);
    const current1mVolume = Math.max(last1?.volume ?? 0, 0);
    const volumeLast5m = sumVolume(last5);
    const averageVolumeLast5m = prev5.length === 5 ? sumVolume(prev5) / 5 : null;
    const averageVolumeLast30m = prev30.length === 30 ? sumVolume(prev30) / 6 : null;

    return {
      current1mVolume,
      volumeLast5m,
      averageVolumeLast5m,
      averageVolumeLast30m,
      volumeAcceleration1m: averageVolumeLast5m > 0 ? current1mVolume / averageVolumeLast5m : null,
      volumeAcceleration5m: averageVolumeLast30m > 0 ? volumeLast5m / averageVolumeLast30m : null,
      volumeAccelerationStatus:
        averageVolumeLast5m > 0 && averageVolumeLast30m > 0 ? "ok" : "데이터 부족",
    };
  }

  function isNearOrAboveVwap(item) {
    const state = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
    if (state === "above" || item?.aboveVwap === true) return true;
    const price = priceOf(item);
    const vwap = vwapOf(item);
    return price !== null && vwap !== null && price >= vwap * 0.985;
  }

  function isBelowVwap(item) {
    const state = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
    if (state === "below" || item?.aboveVwap === false) return true;
    const price = priceOf(item);
    const vwap = vwapOf(item);
    return price !== null && vwap !== null && price < vwap * 0.985;
  }

  function higherLowScore(item, bars) {
    const lows = bars.map((bar) => bar.low).filter((value) => value !== null);
    if (lows.length >= 12) {
      const recent = Math.min(...lows.slice(-6));
      const prior = Math.min(...lows.slice(-12, -6));
      if (recent > prior * 1.003) return 14;
      if (recent >= prior * 0.995) return 8;
      return 0;
    }
    const closePosition = num(item?.technical?.closePosition);
    if (closePosition !== null) return closePosition >= 45 && closePosition <= 80 ? 8 : 0;
    return 0;
  }

  function calculateAccumulationScore(item, bars) {
    const accel1 = num(item?.volumeAcceleration1m);
    const accel5 = num(item?.volumeAcceleration5m);
    const rsi = rsiOf(item);
    const rvol = rvolOf(item);
    const change = changeOf(item);
    let score = 0;

    if (change <= 5) score += 18;
    else if (change <= 12) score += 14;
    else if (change <= 25) score += 8;
    else if (change <= 45) score += 3;

    if (accel1 !== null || accel5 !== null) {
      if ((accel1 ?? 0) >= 2) score += 14;
      else if ((accel1 ?? 0) >= 1.25) score += 9;
      else if ((accel1 ?? 0) >= 0.9) score += 4;
      if ((accel5 ?? 0) >= 1.5) score += 10;
      else if ((accel5 ?? 0) >= 1.1) score += 6;
    }

    if (isNearOrAboveVwap(item)) score += 16;
    else if (!isBelowVwap(item)) score += 7;

    score += higherLowScore(item, bars);

    if (rsi !== null) {
      if (rsi >= 45 && rsi <= 70) score += 14;
      else if (rsi >= 38 && rsi < 45) score += 6;
      else if (rsi > 70 && rsi <= 76) score += 2;
    }

    if (rvol !== null) {
      if (rvol >= 8) score += 12;
      else if (rvol >= 4) score += 10;
      else if (rvol >= 2) score += 7;
      else if (rvol >= 1.2) score += 4;
    }

    if (!hasRiskDisclosure(item)) score += 12;
    else if ((riskOf(item) ?? 50) < 65) score += 5;

    const risk = riskOf(item);
    if (risk !== null && risk >= 75) score -= 10;
    if (change >= 120) score -= 18;
    else if (change >= 70) score -= 10;
    if ((rsi ?? 0) >= 78) score -= 10;

    return Math.round(clamp(score));
  }

  function determineActionLabel(item) {
    const score = num(item?.accumulationScore);
    const accel1 = num(item?.volumeAcceleration1m);
    const accel5 = num(item?.volumeAcceleration5m);
    const rsi = rsiOf(item);
    const change = changeOf(item);

    if (score === null || item?.accumulationDataStatus === "데이터 부족") return "데이터 부족";
    if (change >= 90 || String(item?.stage ?? "").toUpperCase() === "EXHAUSTION") return "눌림 대기";
    if (isBelowVwap(item) && (accel1 === null || accel1 < 1) && (rsi ?? 0) >= 70) return "진입 금지";
    if (isBelowVwap(item) && (accel5 === null || accel5 < 0.8)) return "진입 금지";
    if (score >= 80 && (accel1 ?? 0) >= 2 && isNearOrAboveVwap(item)) return "소액 진입 가능";
    if (score >= 65) return "즉시 관찰";
    if (change >= 45 || (rsi ?? 0) > 72) return "눌림 대기";
    return "진입 금지";
  }

  function mergeMetrics(item, bars) {
    const volumeMetrics = calculateVolumeAcceleration(bars);
    const enriched = Object.assign(item, volumeMetrics);
    enriched.accumulationDataStatus = volumeMetrics.volumeAccelerationStatus;
    enriched.accumulationScore = calculateAccumulationScore(enriched, bars);
    enriched.actionLabel = determineActionLabel(enriched);
    return enriched;
  }

  async function fetchHistory(symbol) {
    const response = await originalFetch(apiInput(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${todayIso()}`), {
      cache: "no-store",
    });
    if (!response.ok) return [];
    return normalizeBars(await response.json().catch(() => null));
  }

  async function enrichItem(item) {
    if (!item?.symbol) return item;
    try {
      const bars = await fetchHistory(item.symbol);
      return mergeMetrics(item, bars);
    } catch (error) {
      item.volumeAcceleration1m = null;
      item.volumeAcceleration5m = null;
      item.accumulationDataStatus = "데이터 부족";
      item.accumulationScore = calculateAccumulationScore(item, []);
      item.actionLabel = "데이터 부족";
      return item;
    }
  }

  async function enrichScannerPayload(payload) {
    const items = payload?.data?.items;
    if (!Array.isArray(items)) return payload;
    const selected = items.slice(0, HISTORY_LIMIT);
    await Promise.all(selected.map(enrichItem));
    for (const item of items) {
      if (!item.accumulationScore) {
        item.volumeAcceleration1m ??= null;
        item.volumeAcceleration5m ??= null;
        item.accumulationDataStatus ??= "데이터 부족";
        item.accumulationScore = calculateAccumulationScore(item, []);
        item.actionLabel = determineActionLabel(item);
      }
      scannerCache.set(item.symbol, item);
    }
    payload.data.accumulationMetricVersion = "accumulation-v1";
    return payload;
  }

  function cloneJsonResponse(source, payload) {
    const headers = new Headers(source.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(payload), {
      status: source.status,
      statusText: source.statusText,
      headers,
    });
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url ?? "";
    const response = await originalFetch(apiInput(input), init);
    try {
      if (/\/api\/scanner(?:\?|$)/.test(url)) {
        const payload = await response.clone().json();
        return cloneJsonResponse(response, await enrichScannerPayload(payload));
      }
      if (/\/api\/quote\?/.test(url)) {
        const payload = await response.clone().json();
        if (payload?.data?.symbol) {
          const cached = scannerCache.get(payload.data.symbol);
          Object.assign(payload.data, cached ?? {});
          await enrichItem(payload.data);
        }
        return cloneJsonResponse(response, payload);
      }
    } catch (error) {
      console.warn("[KBK] accumulation metric enrichment skipped", error);
    }
    return response;
  };

  function fmtRatio(value, status) {
    if (status === "데이터 부족") return "데이터 부족";
    const n = num(value);
    return n === null ? "데이터 부족" : `${n.toFixed(2)}x`;
  }

  function actionClass(label) {
    if (label === "소액 진입 가능") return "kbk-action-buy";
    if (label === "즉시 관찰") return "kbk-action-watch";
    if (label === "눌림 대기") return "kbk-action-wait";
    if (label === "진입 금지") return "kbk-action-block";
    return "kbk-action-neutral";
  }

  function renderKeyFor(item) {
    return `${item?.accumulationScore ?? "na"}-${item?.actionLabel ?? "na"}-${item?.volumeAcceleration1m ?? "na"}-${item?.volumeAcceleration5m ?? "na"}`;
  }

  function injectStyles() {
    if (document.getElementById("kbk-accumulation-metrics-style")) return;
    const style = document.createElement("style");
    style.id = "kbk-accumulation-metrics-style";
    style.textContent = `
      .kbk-accumulation-panel{border:1px solid rgba(15,23,42,.10);background:#f8fafc;border-radius:14px;margin-top:14px;padding:12px;display:grid;gap:10px}
      .kbk-accumulation-head{display:flex;justify-content:space-between;align-items:center;gap:10px}
      .kbk-accumulation-head span{color:#64748b;font-size:.78rem;font-weight:800}
      .kbk-accumulation-score{color:#0f172a;font-size:1.45rem;font-weight:900}
      .kbk-action-label{border-radius:999px;padding:6px 10px;font-size:.78rem;font-weight:900;white-space:nowrap}
      .kbk-action-buy{color:#ecfeff;background:linear-gradient(135deg,#0284c7,#0f766e)}
      .kbk-action-watch{color:#172554;background:#dbeafe}
      .kbk-action-wait{color:#7c2d12;background:#ffedd5}
      .kbk-action-block{color:#f8fafc;background:#111827}
      .kbk-action-neutral{color:#475569;background:#e2e8f0}
      .kbk-accumulation-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .kbk-accumulation-grid div{background:#fff;border:1px solid rgba(15,23,42,.07);border-radius:10px;padding:9px}
      .kbk-accumulation-grid span{display:block;color:#64748b;font-size:.72rem;font-weight:800}
      .kbk-accumulation-grid strong{display:block;color:#0f172a;margin-top:4px;font-size:.88rem}
      @media (max-width:720px){.kbk-accumulation-grid{grid-template-columns:1fr}.kbk-accumulation-head{align-items:flex-start;flex-direction:column}}
    `;
    document.head.appendChild(style);
  }

  function panelHtml(item) {
    const label = item?.actionLabel ?? "데이터 부족";
    const score = num(item?.accumulationScore);
    const renderKey = renderKeyFor(item);
    const status = item?.volumeAccelerationStatus ?? item?.accumulationDataStatus;
    return `
      <div class="kbk-accumulation-panel" data-kbk-accumulation-panel="true" data-render-key="${renderKey}">
        <div class="kbk-accumulation-head">
          <div>
            <span>매집 점수</span>
            <strong class="kbk-accumulation-score">${score === null ? "데이터 부족" : `${score}점`}</strong>
          </div>
          <b class="kbk-action-label ${actionClass(label)}">${label}</b>
        </div>
        <div class="kbk-accumulation-grid">
          <div><span>1분 거래량 가속도</span><strong>${fmtRatio(item?.volumeAcceleration1m, status)}</strong></div>
          <div><span>5분 거래량 가속도</span><strong>${fmtRatio(item?.volumeAcceleration5m, status)}</strong></div>
          <div><span>VWAP/RSI</span><strong>${isNearOrAboveVwap(item) ? "VWAP 위/근처" : isBelowVwap(item) ? "VWAP 아래" : "VWAP 데이터 부족"} · ${rsiOf(item)?.toFixed(0) ?? "-"}</strong></div>
        </div>
      </div>
    `;
  }

  function decorateCards() {
    injectStyles();
    document.querySelectorAll(".stock-card").forEach((card) => {
      const symbol = card.querySelector(".ticker-row h3")?.textContent?.trim();
      const item = scannerCache.get(symbol);
      if (!symbol || !item) return;
      const html = panelHtml(item);
      const existing = card.querySelector("[data-kbk-accumulation-panel]");
      if (existing) {
        if (existing.dataset.renderKey !== renderKeyFor(item)) {
          existing.outerHTML = html;
        }
      } else {
        card.querySelector(".metric-grid")?.insertAdjacentHTML("afterend", html);
      }
    });
  }

  function startDomObserver() {
    const observer = new MutationObserver(() => {
      window.requestAnimationFrame(decorateCards);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.setInterval(decorateCards, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startDomObserver, { once: true });
  } else {
    startDomObserver();
  }
})();
