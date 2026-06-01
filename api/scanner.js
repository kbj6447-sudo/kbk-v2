const UPSTREAM = "https://kbk-theta.vercel.app/api/scanner";

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function volumeStrength(item) {
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio);
  const previousVolumeRatio = num(item.previousDayVolumeRatio);
  const bestVolumeRatio = Math.max(relativeVolume ?? 0, previousVolumeRatio ?? 0);
  const rvolScore = bestVolumeRatio >= 8 ? 96
    : bestVolumeRatio >= 5 ? 86
      : bestVolumeRatio >= 3 ? 74
        : bestVolumeRatio >= 1.5 ? 60
          : bestVolumeRatio > 0 ? 42
            : 0;
  const rawScore = rawVolume >= 20_000_000 ? 96
    : rawVolume >= 10_000_000 ? 86
      : rawVolume >= 5_000_000 ? 78
        : rawVolume >= 1_000_000 ? 65
          : 42;
  return clamp(Math.max(rvolScore, rawScore));
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
    if (!response.ok || payload?.chart?.error) {
      return { volumeProfileStatus: `chart-error-${response.status}` };
    }
    const result = payload?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0] || {};
    const volumes = Array.isArray(quote.volume) ? quote.volume.map(num).filter((value) => value !== null && value > 0) : [];
    if (!volumes.length) return { volumeProfileStatus: "no-daily-volume" };

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
      volumeProfileStatus: "ok",
    };
  } catch {
    return { volumeProfileStatus: "fetch-failed" };
  }
}

async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function boostedScore(item) {
  const premarketChange = num(item.preMarketChangePercent) ?? num(item.changePercent) ?? 0;
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const currentScore = num(item.finalProbabilityScore) ?? num(item.scannerScore) ?? 0;

  let score = currentScore;
  if (premarketChange >= 150 && rawVolume >= 1_000_000) score = Math.max(score, 82);
  if (premarketChange >= 100 && rawVolume >= 5_000_000) score = Math.max(score, 78);
  if (premarketChange >= 60 && rawVolume >= 5_000_000) score = Math.max(score, 70);

  return Math.round(clamp(score));
}

async function normalizeItem(item, enrichVolume = true) {
  if (!item || typeof item !== "object") return item;

  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const needsVolumeProfile = enrichVolume && ((num(item.relativeVolume) ?? num(item.volumeRatio)) === null || num(item.averageVolume) === null);
  const volumeProfile = needsVolumeProfile ? await fetchVolumeProfile(item.symbol, rawVolume) : {};
  const merged = { ...item, ...Object.fromEntries(Object.entries(volumeProfile).filter(([, value]) => value !== null && value !== undefined)) };
  const boosted = boostedScore(merged);
  const volumeScore = volumeStrength(item);
  const correctedVolumeScore = volumeStrength(merged);

  return {
    ...merged,
    volumeComputationVersion: "pro-rvol-v2",
    volume: Math.max(num(merged.volume) ?? 0, rawVolume) || item.volume,
    volumeStrengthScore: correctedVolumeScore,
    scannerScore: Math.max(num(merged.scannerScore) ?? 0, boosted),
    finalProbabilityScore: Math.max(num(merged.finalProbabilityScore) ?? 0, boosted),
    selectionReasons: [
      ...(Array.isArray(merged.selectionReasons) ? merged.selectionReasons : []),
      volumeProfile.relativeVolume ? `RVOL ${volumeProfile.relativeVolume.toFixed(1)}x from 20D avg volume` : null,
      volumeProfile.previousDayVolumeRatio ? `Volume ${volumeProfile.previousDayVolumeRatio.toFixed(1)}x vs previous day` : null,
      boosted > (num(merged.finalProbabilityScore) ?? 0) ? "Premarket surge volume boost" : null,
    ].filter(Boolean),
  };
}

module.exports = async function handler(req, res) {
  try {
    const upstreamUrl = new URL(UPSTREAM);
    const requestUrl = new URL(req.url, "https://kbk-theta-accumulation.vercel.app");
    upstreamUrl.search = requestUrl.search;

    const response = await fetch(upstreamUrl, {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();

    if (payload?.data?.items && Array.isArray(payload.data.items)) {
      const rankedForVolume = [...payload.data.items]
        .sort((a, b) => {
          const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
          const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
          const aScore = num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0;
          const bScore = num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0;
          return bVolume - aVolume || bScore - aScore;
        })
        .slice(0, 15);
      const enrichSymbols = new Set(rankedForVolume.map((item) => item.symbol));
      payload.data.items = (await mapWithLimit(payload.data.items, 2, (item) => normalizeItem(item, enrichSymbols.has(item.symbol))))
        .sort((a, b) => (num(b.finalProbabilityScore) ?? 0) - (num(a.finalProbabilityScore) ?? 0));
    }

    res.setHeader("cache-control", "no-store");
    res.status(response.status).json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "scanner proxy failed",
    });
  }
};
