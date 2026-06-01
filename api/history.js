// api/history.js — 실시간 1분봉 히스토리 (Yahoo Finance 프록시)
// kbk-symbol-detail.js 의 fetchLatestHistoryPrice() 가 호출하는 엔드포인트

function num(v) {
    const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("cache-control", "no-store");

  try {
    const url = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    const symbol = url.searchParams.get("symbol") || "";
    const from   = url.searchParams.get("from")   || "";

    // symbol 유효성 검사 (숫자만 오거나 빈 값이면 400 반환)
    if (!symbol || /^\d+$/.test(symbol)) {
      return res.status(400).json({ ok: false, code: "BAD_SYMBOL", message: "Invalid symbol: " + symbol });
    }

    // from 파라미터로 범위 계산 (최대 6시간, 기본 6시간)
    const fromMs  = from ? new Date(from).getTime() : Date.now() - 6 * 60 * 60 * 1000;
    const rangeMs = Date.now() - fromMs;
    const range   = rangeMs <= 60 * 60 * 1000 ? "1h"
                  : rangeMs <= 2 * 60 * 60 * 1000 ? "2h"
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

    const result    = payload?.chart?.result?.[0];
    const meta      = result?.meta || {};
    const timestamps = result?.timestamp || [];
    const quote     = result?.indicators?.quote?.[0] || {};

    const fromSec = fromMs / 1000;
    const bars = timestamps
      .map((ts, i) => ({
        time:   new Date(ts * 1000).toISOString(),
        open:   num(quote.open?.[i]),
        high:   num(quote.high?.[i]),
        low:    num(quote.low?.[i]),
        close:  num(quote.close?.[i]),
        volume: num(quote.volume?.[i]),
}))
      .filter((bar) => bar.close !== null && new Date(bar.time).getTime() / 1000 >= fromSec);

    return res.status(200).json({
      ok: true,
      data: {
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        regularMarketPrice: num(meta.regularMarketPrice),
        previousClose: num(meta.previousClose) || num(meta.chartPreviousClose),
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
