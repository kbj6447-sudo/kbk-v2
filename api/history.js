// api/history.js — 실시간 1분봉 히스토리 (Yahoo Finance 프록시)
// kbk-symbol-detail.js 의 fetchLatestHistoryPrice() 가 호출하는 엔드포인트

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function orNum(a, b) {
  const va = num(a);
  return va !== null ? va : num(b);
}

function positiveVolume(v) {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

function findAlternateVolumeSeries(indicators) {
  if (!indicators || typeof indicators !== "object") return null;
  for (const key of Object.keys(indicators)) {
    if (key === "quote") continue;
    const entry = indicators[key];
    const series = Array.isArray(entry) ? entry[0] : entry;
    if (!series || !Array.isArray(series.volume)) continue;
    if (series.volume.some((value) => positiveVolume(value) !== null)) {
      return series.volume;
    }
  }
  return null;
}

function resolveMetaTotalVolume(meta) {
  return orNum(meta.regularMarketVolume, orNum(meta.preMarketVolume, meta.postMarketVolume));
}

function barActivityWeight(bar) {
  const { open, high, low, close } = bar;
  if (high !== null && low !== null && high >= low) {
    const range = high - low;
    if (range > 0) return range;
  }
  if (open !== null && close !== null) return Math.abs(close - open);
  if (close !== null) return 1;
  return 0;
}

function roundVolumeAllocations(allocations, targetSum) {
  const target = Math.max(0, Math.round(targetSum));
  if (!allocations.length) return [];
  const floors = allocations.map((value) => Math.floor(value));
  let remainder = target - floors.reduce((sum, value) => sum + value, 0);
  const ranked = allocations
    .map((value, index) => ({ index, frac: value - floors[index] }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let i = 0; i < ranked.length && remainder > 0; i += 1) {
    result[ranked[i].index] += 1;
    remainder -= 1;
  }
  return result;
}

function distributeMetaVolume(bars, totalVolume) {
  const total = num(totalVolume);
  if (!bars.length || total === null || total <= 0) {
    return { bars, volumeSource: null, volumeStatus: "missing" };
  }

  const weights = bars.map(barActivityWeight);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  let allocations;
  if (weightSum > 0) {
    allocations = weights.map((weight) => (weight / weightSum) * total);
  } else {
    const eligible = bars.filter((bar) => bar.close !== null);
    if (!eligible.length) {
      return { bars, volumeSource: null, volumeStatus: "missing" };
    }
    const perBar = total / eligible.length;
    allocations = bars.map((bar) => (bar.close !== null ? perBar : 0));
  }

  const rounded = roundVolumeAllocations(allocations, total);
  const enriched = bars.map((bar, index) => {
    const volume = rounded[index] > 0 ? rounded[index] : null;
    return {
      ...bar,
      volume,
      volumeSource: volume !== null ? "meta-regularMarketVolume-distributed" : null,
    };
  });

  return {
    bars: enriched,
    volumeSource: "meta-regularMarketVolume-distributed",
    volumeStatus: "fallback",
  };
}

function applyVolumeSeries(bars, volumeSeries, volumeSource) {
  if (!Array.isArray(volumeSeries) || !volumeSeries.length) {
    return { bars, volumeSource: null, volumeStatus: "missing" };
  }

  const enriched = bars.map((bar, index) => {
    const volume = positiveVolume(volumeSeries[index]);
    return {
      ...bar,
      volume,
      volumeSource: volume !== null ? volumeSource : null,
    };
  });

  const hasPositive = enriched.some((bar) => bar.volume !== null && bar.volume > 0);
  return {
    bars: enriched,
    volumeSource: hasPositive ? volumeSource : null,
    volumeStatus: hasPositive ? "ok" : "missing",
  };
}

function resolveBarVolumes(rawBars, quote, indicators, meta) {
  const quoteVolumes = Array.isArray(quote.volume) ? quote.volume : [];
  const withQuote = applyVolumeSeries(rawBars, quoteVolumes, "yahoo-quote-volume");
  if (withQuote.volumeStatus === "ok") {
    return withQuote;
  }

  const alternateVolumes = findAlternateVolumeSeries(indicators);
  if (alternateVolumes) {
    const withAlternate = applyVolumeSeries(rawBars, alternateVolumes, "yahoo-indicator-volume");
    if (withAlternate.volumeStatus === "ok") {
      return withAlternate;
    }
  }

  const metaTotal = resolveMetaTotalVolume(meta);
  if (metaTotal !== null && metaTotal > 0) {
    return distributeMetaVolume(rawBars, metaTotal);
  }

  return { bars: rawBars, volumeSource: null, volumeStatus: "missing" };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("cache-control", "no-store");

  try {
    const url = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    const symbol = url.searchParams.get("symbol") || "";
    const from = url.searchParams.get("from") || "";

    if (!symbol || /^\d+$/.test(symbol)) {
      return res.status(400).json({ ok: false, code: "BAD_SYMBOL", message: "Invalid symbol: " + symbol });
    }

    const fromMs = from ? new Date(from).getTime() : Date.now() - 6 * 60 * 60 * 1000;
    const rangeMs = Date.now() - fromMs;
    const range = rangeMs <= 60 * 60 * 1000
      ? "1h"
      : rangeMs <= 2 * 60 * 60 * 1000
        ? "2h"
        : "1d";

    const yahooUrl =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${range}&interval=1m&includePrePost=true`;

    const yahooRes = await fetch(yahooUrl, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await yahooRes.json();

    if (!yahooRes.ok || payload?.chart?.error) {
      const errMsg = payload?.chart?.error?.description || `Yahoo HTTP ${yahooRes.status}`;
      return res.status(502).json({ ok: false, code: "UPSTREAM_ERROR", message: errMsg });
    }

    const result = payload?.chart?.result?.[0];
    const meta = result?.meta || {};
    const timestamps = result?.timestamp || [];
    const quote = result?.indicators?.quote?.[0] || {};
    const indicators = result?.indicators || {};

    const fromSec = fromMs / 1000;
    const rawBars = timestamps
      .map((ts, i) => ({
        time: new Date(ts * 1000).toISOString(),
        open: num(quote.open?.[i]),
        high: num(quote.high?.[i]),
        low: num(quote.low?.[i]),
        close: num(quote.close?.[i]),
        volume: null,
      }))
      .filter((bar) => bar.close !== null && new Date(bar.time).getTime() / 1000 >= fromSec);

    const volumeResolution = resolveBarVolumes(rawBars, quote, indicators, meta);
    const bars = volumeResolution.bars;
    const barsWithVolume = bars.filter((bar) => bar.volume !== null && bar.volume > 0).length;

    return res.status(200).json({
      ok: true,
      data: {
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        regularMarketPrice: num(meta.regularMarketPrice),
        previousClose: num(meta.previousClose) || num(meta.chartPreviousClose),
        regularMarketVolume: resolveMetaTotalVolume(meta),
        volumeSource: volumeResolution.volumeSource,
        volumeStatus: volumeResolution.volumeStatus,
        barsWithVolume,
        bars,
      },
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      code: "HANDLER_ERROR",
      message: error instanceof Error ? error.message : "history handler failed",
    });
  }
};
