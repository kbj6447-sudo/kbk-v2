const SCANNER_URL = "https://kbk-theta-accumulation.vercel.app/api/scanner";
const HISTORY_URL = (symbol) =>
  `https://kbk-theta-accumulation.vercel.app/api/history?symbol=${encodeURIComponent(symbol)}&from=${new Date().toISOString().slice(0, 10)}`;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function priceOf(item) {
  return (
    num(item?.normalizedLivePriceUsd)
    ?? num(item?.price)
    ?? num(item?.preMarketPrice)
    ?? num(item?.regularMarketPrice)
    ?? num(item?.latestClose)
  );
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
  ]
    .join(" ")
    .toLowerCase();
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

  return Math.round(Math.max(0, Math.min(100, score)));
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

function classifyReasons(item) {
  const score = num(item?.accumulationScore);
  const accel1 = num(item?.volumeAcceleration1m);
  const accel5 = num(item?.volumeAcceleration5m);
  const rsi = rsiOf(item) ?? 0;
  const change = changeOf(item);
  const risk = riskOf(item);
  const belowVwap = isBelowVwap(item);
  const nearVwap = isNearOrAboveVwap(item);
  const volStatus = item?.volumeAccelerationStatus ?? item?.accumulationDataStatus;
  const disclosure = hasRiskDisclosure(item);

  return {
    belowVwap,
    nearVwap,
    rsiOverheated: rsi > 72,
    rsiBlockBand: belowVwap && (accel1 === null || accel1 < 1) && rsi >= 70,
    changeOverheated: change >= 45,
    changeExtreme: change >= 90,
    riskHigh: risk !== null && risk >= 75,
    riskDisclosure: disclosure,
    volumeAccelInsufficient:
      volStatus === "데이터 부족"
      || (belowVwap && (accel5 === null || accel5 < 0.8))
      || (belowVwap && (accel1 === null || accel1 < 1) && rsi >= 70),
    lowScore: score !== null && score < 65,
    defaultBlock: true,
  };
}

function explainBlock(item) {
  const score = num(item?.accumulationScore);
  const accel1 = num(item?.volumeAcceleration1m);
  const accel5 = num(item?.volumeAcceleration5m);
  const rsi = rsiOf(item) ?? 0;
  const change = changeOf(item);
  const label = determineActionLabel(item);
  if (label !== "진입 금지") return { label, primary: null, all: [] };

  const reasons = [];
  if (score === null || item?.accumulationDataStatus === "데이터 부족") {
    reasons.push("데이터 부족");
  }
  if (isBelowVwap(item) && (accel1 === null || accel1 < 1) && rsi >= 70) {
    reasons.push("VWAP 아래 + RSI≥70 + 1m 가속<1");
  }
  if (isBelowVwap(item) && (accel5 === null || accel5 < 0.8)) {
    reasons.push("VWAP 아래 + 5m 가속<0.8");
  }
  if (!(score >= 80 && (accel1 ?? 0) >= 2 && isNearOrAboveVwap(item)) && !(score >= 65)) {
    if (change >= 45 || rsi > 72) {
      // would be 눌림 대기 - not block
    } else {
      reasons.push("기본값 진입금지 (score<65, 눌림대기 조건 미충족)");
    }
  }
  if (riskOf(item) !== null && riskOf(item) >= 75) reasons.push("riskScore≥75");
  if (hasRiskDisclosure(item)) reasons.push("공시/위험 키워드");

  const flags = classifyReasons(item);
  const tagged = [];
  if (flags.belowVwap) tagged.push("VWAP 아래");
  if (flags.rsiOverheated) tagged.push("RSI 과열");
  if (flags.changeOverheated) tagged.push("상승률 과열");
  if (flags.riskHigh) tagged.push("riskScore 높음");
  if (flags.riskDisclosure) tagged.push("공시 위험");
  if (flags.volumeAccelInsufficient) tagged.push("volumeAcceleration 부족");
  if (label === "진입 금지" && reasons.some((r) => r.includes("기본값"))) tagged.push("기본값 진입금지");

  return { label, primary: reasons[0] ?? tagged[0] ?? "기본값", all: [...new Set([...reasons, ...tagged])], flags };
}

function couldDowngrade(item) {
  const label = determineActionLabel(item);
  if (label !== "진입 금지") return null;
  const score = num(item?.accumulationScore) ?? 0;
  const change = changeOf(item);
  const rsi = rsiOf(item) ?? 0;
  if (change >= 45 || rsi > 72 || change >= 90) return "눌림 대기";
  if (score >= 55) return "즉시 관찰";
  if (score >= 48) return "눌림 대기(완화 시)";
  return null;
}

async function enrichItem(item) {
  const response = await fetch(HISTORY_URL(item.symbol), { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  const bars = normalizeBars(payload);
  const volumeMetrics = calculateVolumeAcceleration(bars);
  const enriched = { ...item, ...volumeMetrics };
  enriched.accumulationDataStatus = volumeMetrics.volumeAccelerationStatus;
  enriched.accumulationScore = calculateAccumulationScore(enriched, bars);
  enriched.actionLabel = determineActionLabel(enriched);
  enriched._bars = bars.length;
  enriched._vwapBars = bars.filter(
    (b) => b.high !== null && b.low !== null && b.close !== null && (b.volume ?? 0) > 0,
  ).length;
  return enriched;
}

async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

const scannerRes = await fetch(SCANNER_URL, { cache: "no-store" });
const scannerPayload = await scannerRes.json();
const items = scannerPayload?.data?.items ?? [];
console.error(`Scanner items: ${items.length}`);

const enriched = await mapWithLimit(items, 6, enrichItem);

const labelCounts = {};
const blockItems = [];
for (const item of enriched) {
  const label = item.actionLabel;
  labelCounts[label] = (labelCounts[label] || 0) + 1;
  if (label === "진입 금지") blockItems.push(item);
}

const causeCounts = {
  "VWAP 아래": 0,
  "RSI 과열": 0,
  "상승률 과열": 0,
  "riskScore 높음": 0,
  "volumeAcceleration 부족": 0,
  "공시 위험": 0,
  "기본값 진입금지": 0,
};

const primaryCause = {};
let downgradeWait = 0;
let downgradeObserve = 0;

for (const item of blockItems) {
  const exp = explainBlock(item);
  for (const key of Object.keys(causeCounts)) {
    if (exp.all.some((r) => r.includes(key.replace("진입금지", "진입금지")) || exp.all.includes(key))) {
      causeCounts[key] += 1;
    }
  }
  if (exp.flags.belowVwap) causeCounts["VWAP 아래"] += 1;
  if (exp.flags.rsiOverheated) causeCounts["RSI 과열"] += 1;
  if (exp.flags.changeOverheated) causeCounts["상승률 과열"] += 1;
  if (exp.flags.riskHigh) causeCounts["riskScore 높음"] += 1;
  if (exp.flags.volumeAccelInsufficient) causeCounts["volumeAcceleration 부족"] += 1;
  if (exp.flags.riskDisclosure) causeCounts["공시 위험"] += 1;
  if (exp.all.some((r) => r.includes("기본값"))) causeCounts["기본값 진입금지"] += 1;

  primaryCause[exp.primary] = (primaryCause[exp.primary] || 0) + 1;
  const down = couldDowngrade(item);
  if (down === "눌림 대기" || down === "눌림 대기(완화 시)") downgradeWait += 1;
  if (down === "즉시 관찰") downgradeObserve += 1;
}

console.log(
  JSON.stringify(
    {
      totalItems: enriched.length,
      actionLabelCounts: labelCounts,
      blockCount: blockItems.length,
      uiLabelNote: "UI displays 진입 금지 as 매매 금지",
      causeCountsMultiLabel: causeCounts,
      primaryBlockReason: primaryCause,
      couldDowngradeToWait: downgradeWait,
      couldDowngradeToObserve: downgradeObserve,
      sampleBlocked: blockItems.slice(0, 5).map((i) => ({
        symbol: i.symbol,
        score: i.accumulationScore,
        change: changeOf(i),
        rsi: rsiOf(i),
        accel1: i.volumeAcceleration1m,
        accel5: i.volumeAcceleration5m,
        belowVwap: isBelowVwap(i),
        actionLabel: i.actionLabel,
        explain: explainBlock(i).all,
      })),
    },
    null,
    2,
  ),
);
