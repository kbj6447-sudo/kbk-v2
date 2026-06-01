// api/quote.js — Yahoo Finance에서 직접 실시간 시세 조회
// 데이마켓(장외거래) / 프리마켓 / 정규장 모두 반영

function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function average(values) {
    const clean = values.map(num).filter((v) => v !== null && v > 0);
    if (!clean.length) return null;
    return clean.reduce((s, v) => s + v, 0) / clean.length;
}

// Yahoo Finance v8 chart API로 현재가 + 메타 정보 조회
async function fetchYahooQuote(symbol) {
    // 1분봉 1d 범위로 최신 가격 + 메타 한 번에 조회
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
    const res = await fetch(url, {
          headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await res.json();
    if (!res.ok || payload?.chart?.error) {
          throw new Error(payload?.chart?.error?.description || `Yahoo HTTP ${res.status}`);
    }
    const result = payload?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0] || {};
    const timestamps = result?.timestamp || [];

  // 가장 최신 유효 close 가격
  const closes = (quote.close || []).map(num).filter((v) => v !== null);
    const volumes = (quote.volume || []).map(num).filter((v) => v !== null && v > 0);
    const latestClose = closes.at(-1);

  // 20일 평균 거래량은 일봉으로 따로 조회하지 않고 meta 값 활용
  const avgVolume = num(meta.averageDailyVolume3Month) ?? num(meta.averageDailyVolume10Day) ?? null;
    const currentVolume = num(meta.regularMarketVolume) ?? volumes.reduce((s, v) => s + v, 0) || null;

  // 현재가 결정: regularMarketPrice > 최신 1분봉 close
  const regularPrice = num(meta.regularMarketPrice) ?? latestClose;
    // 시간외(preMarket/afterHours) 가격
  const preMarketPrice = num(meta.preMarketPrice) ?? regularPrice;
    const postMarketPrice = num(meta.postMarketPrice) ?? null;
    const previousClose = num(meta.previousClose) ?? num(meta.chartPreviousClose);

  // 현재 어떤 세션인지 판단
  // marketState: "PRE", "REGULAR", "POST", "POSTPOST", "PREPRE", "CLOSED"
  const marketState = String(meta.marketState || "").toUpperCase();
    const isExtended = marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST";

  // 실제 표시할 현재가: 시간외면 해당 가격 우선
  let displayPrice = regularPrice;
    let displayChange = null;
    let displayChangePct = null;

  if (marketState === "PRE" && preMarketPrice) {
        displayPrice = preMarketPrice;
  } else if ((marketState === "POST" || marketState === "POSTPOST") && postMarketPrice) {
        displayPrice = postMarketPrice;
  }

  if (displayPrice !== null && previousClose) {
        displayChange = displayPrice - previousClose;
        displayChangePct = (displayChange / previousClose) * 100;
  }

  // VWAP 계산 (당일 1분봉 기반)
  const highs = (quote.high || []).map(num);
    const lows = (quote.low || []).map(num);
    const barVolumes = (quote.volume || []).map(num);
    let vwap = null;
    let vwapTotalVolume = 0;
    let vwapTotalPV = 0;
    for (let i = 0; i < closes.length; i++) {
          const h = highs[i], l = lows[i], c = closes[i], v = barVolumes[i];
          if (h !== null && l !== null && c !== null && v !== null && v > 0) {
                  const tp = (h + l + c) / 3;
                  vwapTotalPV += tp * v;
                  vwapTotalVolume += v;
          }
    }
    vwap = vwapTotalVolume > 0 ? vwapTotalPV / vwapTotalVolume : null;
    const aboveVwap = vwap !== null && displayPrice !== null ? displayPrice >= vwap : null;

  // RSI (14) 계산
  let rsi = null;
    if (closes.length >= 15) {
          const recent = closes.slice(-15);
          let gains = 0, losses = 0;
          for (let i = 1; i < recent.length; i++) {
                  const diff = recent[i] - recent[i - 1];
                  if (diff > 0) gains += diff; else losses += Math.abs(diff);
          }
          const avgGain = gains / 14;
          const avgLoss = losses / 14;
          rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

  // MA5, MA20
  const ma5 = closes.length >= 5 ? average(closes.slice(-5)) : null;
    const ma20 = closes.length >= 20 ? average(closes.slice(-20)) : null;

  // 1분 추세
  let oneMinuteTrend = "neutral";
    if (closes.length >= 3) {
          const last3 = closes.slice(-3);
          if (last3[2] > last3[0]) oneMinuteTrend = "up";
          else if (last3[2] < last3[0]) oneMinuteTrend = "down";
    }

  // 거래량 비율
  const volumeRatio = avgVolume && currentVolume ? currentVolume / avgVolume : null;

  return {
        ok: true,
        data: {
                symbol: meta.symbol || symbol,
                name: meta.longName || meta.shortName || symbol,
                price: displayPrice,
                regularMarketPrice: regularPrice,
                preMarketPrice: preMarketPrice,
                postMarketPrice: postMarketPrice,
                change: displayChange,
                changePercent: displayChangePct,
                previousClose,
                marketState,
                extendedHours: isExtended,
                dayHigh: num(meta.regularMarketDayHigh),
                dayLow: num(meta.regularMarketDayLow),
                volume: currentVolume,
                averageVolume: avgVolume,
                volumeRatio,
                vwap,
                aboveVwap,
                vwapStatus: vwap !== null ? "calculated" : "unavailable",
                rsi,
                ma5,
                ma20,
                ma5vs20: ma5 !== null && ma20 !== null ? (ma5 >= ma20 ? "above" : "below") : null,
                oneMinuteTrend,
                exchange: meta.exchangeName || meta.fullExchangeName || null,
                currency: meta.currency || "USD",
                marketCap: null, // Yahoo chart API에서 직접 제공 안 함
                sourceTags: ["yahoo-direct"],
        },
  };
}

module.exports = async function handler(req, res) {
    res.setHeader("cache-control", "no-store");
    try {
          const url = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
          const symbol = url.searchParams.get("symbol") || "";

      if (!symbol || /^\d+$/.test(symbol)) {
              return res.status(400).json({ ok: false, code: "BAD_SYMBOL", message: "Invalid symbol: " + symbol });
      }

      const result = await fetchYahooQuote(symbol);
          return res.status(200).json(result);
    } catch (error) {
          return res.status(502).json({
                  ok: false,
                  code: "QUOTE_ERROR",
                  message: error instanceof Error ? error.message : "quote handler failed",
          });
    }
};
