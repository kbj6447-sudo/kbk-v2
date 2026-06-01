const UPSTREAM = "https://kbk-theta.vercel.app/api/quote";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  const clean = values.map(num).filter((value) => value !== null && value > 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

async function fetchVolumeProfile(symbol, currentVolume) {
  if (!symbol) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d&includePrePost=true`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok || payload?.chart?.error) return {};
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0] || {};
    const volumes = Array.isArray(quote.volume) ? quote.volume.map(num).filter((value) => value !== null && value > 0) : [];
    if (!volumes.length) return {};

    const latestChartVolume = volumes.at(-1);
    const liveVolume = Math.max(num(currentVolume) ?? 0, num(result?.meta?.regularMarketVolume) ?? 0, latestChartVolume ?? 0);
    const previousDayVolume = volumes.length > 1 ? volumes.at(-2) : null;
    const averageVolume20d = average(volumes.slice(0, -1).slice(-20));
    return {
      averageVolume: averageVolume20d,
      previousDayVolume,
      relativeVolume: averageVolume20d ? liveVolume / averageVolume20d : null,
      volumeRatio: averageVolume20d ? liveVolume / averageVolume20d : null,
      previousDayVolumeRatio: previousDayVolume ? liveVolume / previousDayVolume : null,
      volume: liveVolume || currentVolume,
      volumeSource: "yahoo-daily-chart",
    };
  } catch {
    return {};
  }
}

function mergeKnownValues(base, extra) {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== undefined)),
  };
}

module.exports = async function handler(req, res) {
  try {
    const requestUrl = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    const upstreamUrl = new URL(UPSTREAM);
    upstreamUrl.search = requestUrl.search;

    const response = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();
    const quote = payload?.data;
    if (quote?.symbol) {
      const rawVolume = Math.max(num(quote.volume) ?? 0, num(quote.preMarketVolume) ?? 0);
      payload.data = mergeKnownValues(quote, await fetchVolumeProfile(quote.symbol, rawVolume));
    }

    res.setHeader("cache-control", "no-store");
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "quote proxy failed",
    });
  }
};
