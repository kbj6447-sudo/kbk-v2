import {
  finalDecision,
  renderFinalDecisionHeroHtml,
} from "./final-decision.js";

const POLL_MS = 3000;

let selectedSymbol = null;
let pollTimer = null;
let lastQuote = null;
let lastBars = [];
let usdKrw = 1365;
let selectedDetailCalculating = false;
let selectedDetailRefreshQueued = false;
let selectedFallbackScore = null;

const fmt = new Intl.NumberFormat("ko-KR");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveNum(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

function pct(value) {
  const n = num(value);
  return n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function compact(value) {
  const n = num(value);
  if (n === null) return "-";
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return fmt.format(Math.round(n));
}

function usdText(value) {
  const n = num(value);
  if (n === null) return "-";
  return `$${n.toFixed(n >= 10 ? 2 : 4)}`;
}

function levelText(value, fallback = "데이터 부족") {
  const n = positiveNum(value);
  return n === null ? fallback : usdText(n);
}

function krwText(value) {
  const n = num(value);
  if (n === null) return "-";
  return `${fmt.format(Math.round(n * usdKrw))}원`;
}

function pricePairText(value) {
  return krwText(value);
}

function priceUsd(quote) {
  return positiveNum(quote?.price) ?? positiveNum(quote?.preMarketPrice) ?? positiveNum(quote?.regularMarketPrice);
}

function mainChangePct(quote, priceOverride = null) {
  const provided = num(quote?.changePercent);
  if (provided !== null) return provided;
  const price = positiveNum(priceOverride) ?? priceUsd(quote);
  const previousClose = num(quote?.previousClose) ?? num(quote?.regularMarketPreviousClose);
  if (price !== null && previousClose && previousClose > 0) {
    return ((price - previousClose) / previousClose) * 100;
  }
  return provided;
}

function changePct(quote) {
  return mainChangePct(quote) ?? 0;
}

function hasConfirmedVolume(item = {}) {
  const source = String(item.volumeSource || "").toLowerCase();
  if (!source || source.includes("unconfirmed") || source.includes("fallback")) return false;
  if (source.includes("chart") || source.includes("daily") || source.includes("history")) return false;
  const volume = num(item.volume);
  return volume !== null && volume > 0;
}

function displayVolumeText(volume) {
  const n = num(volume);
  return n === null || n <= 0 ? "거래량 미확인" : `거래량 ${compact(n)}`;
}

function displayRelativeVolumeText(pick = {}) {
  const source = pick.displayVolumeSource ?? pick.quote?.volumeSource ?? pick.volumeSource;
  const volume = num(pick.displayVolume);
  if (volume === null || !hasConfirmedVolume({ volume, volumeSource: source })) return "상대거래량 미확인";
  const rvol = num(pick.displayRvol);
  return rvol === null ? "상대거래량 미확인" : `상대거래량 ${rvol.toFixed(1)}배`;
}

function mergeTopPickDisplayQuote(pick, quote) {
  const latest = quote?.symbol ? quote : null;
  const displayVolume = latest && hasConfirmedVolume(latest) ? num(latest.volume) : null;
  const displayPrice = latest ? priceUsd(latest) : null;
  const displayChange = latest ? mainChangePct(latest, displayPrice) : null;
  return {
    ...pick,
    displayPrice: displayPrice ?? pick.price,
    displayChange: displayChange ?? pick.change,
    displayVolume,
    displayVolumeSource: latest?.volumeSource ?? pick.quote?.volumeSource,
    displayRvol: displayVolume !== null
      ? (num(latest.relativeVolume) ?? num(latest.volumeRatio) ?? pick.rvol)
      : null,
    displayQuote: latest,
  };
}

async function hydrateTopPicksWithLatestQuotes(picks) {
  const symbols = [...new Set(picks.map((pick) => String(pick.symbol || "").toUpperCase()).filter(Boolean))];
  const entries = await Promise.all(symbols.map(async (symbol) => {
    try {
      const payload = await fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
      return [symbol, payload?.data || payload];
    } catch (_error) {
      return [symbol, null];
    }
  }));
  const quoteMap = new Map(entries);
  return picks.map((pick) => mergeTopPickDisplayQuote(pick, quoteMap.get(String(pick.symbol || "").toUpperCase())));
}

function vwapValue(quote) {
  return positiveNum(quote?.technical?.vwap) ?? positiveNum(quote?.vwap);
}

function vwapState(quote) {
  const state = String(quote?.technical?.vwapState ?? quote?.vwapState ?? "").toLowerCase();
  if (state === "above" || quote?.aboveVwap === true) return "VWAP 위";
  if (state === "below" || quote?.aboveVwap === false) return "VWAP 아래";
  const price = priceUsd(quote);
  const vwap = vwapValue(quote);
  if (price !== null && vwap !== null) return price >= vwap ? "VWAP 위" : "VWAP 아래";
  return "VWAP 대기";
}

function trendLabel(quote) {
  const raw = String(quote?.oneMinuteTrend ?? quote?.technical?.oneMinuteTrend ?? "").toLowerCase();
  if (raw.includes("up")) return "?곸듅";
  if (raw.includes("down")) return "?섎씫";
  return changePct(quote) > 0 ? "?곸듅" : "?〓낫";
}

function supportResistance(quote, bars) {
  const lows = bars.map((bar) => positiveNum(bar.low ?? bar.l)).filter((v) => v !== null);
  const highs = bars.map((bar) => positiveNum(bar.high ?? bar.h)).filter((v) => v !== null);
  const support = lows.length ? Math.min(...lows) : positiveNum(quote?.dayLow);
  const resistance = highs.length ? Math.max(...highs) : positiveNum(quote?.dayHigh);
  return { support, resistance };
}

function localHigherLowScore(bars) {
  const sample = bars.slice(-10)
    .map((bar) => ({
      low: positiveNum(bar.low ?? bar.l),
      close: positiveNum(bar.close ?? bar.c ?? bar.price),
    }))
    .filter((bar) => bar.low !== null && bar.close !== null);
  if (sample.length < 5) return 50;
  let defendedPairs = 0;
  for (let i = 1; i < sample.length; i += 1) {
    if (sample[i].low >= sample[i - 1].low * 0.998) defendedPairs += 1;
  }
  let consecutiveHigherLows = 0;
  for (let i = sample.length - 1; i > 0; i -= 1) {
    if (sample[i].low >= sample[i - 1].low * 1.001) consecutiveHigherLows += 1;
    else break;
  }
  const recent = sample.slice(-4);
  const recentFloor = Math.min(...recent.slice(0, -1).map((bar) => bar.low));
  const last = sample.at(-1);
  const closeMaintains = last.close >= last.low * 1.002 && last.close >= recentFloor * 0.998;
  const damaged = last.low < recentFloor * 0.992 || last.close < recentFloor * 0.995;
  let score = 35 + (defendedPairs / (sample.length - 1)) * 38 + Math.min(consecutiveHigherLows, 4) * 7;
  if (consecutiveHigherLows >= 3 && closeMaintains && !damaged) score = Math.max(score, 90);
  else if (consecutiveHigherLows >= 2 && closeMaintains && !damaged) score = Math.max(score, 74);
  else if (damaged) score = Math.min(score - 22, 38);
  if (closeMaintains) score += 6;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function localVwapHold(bars) {
  const sample = bars.slice(-24);
  if (sample.length < 3) return { vwapHoldMinutes: null, vwapHoldScore: 50 };
  let pv = 0;
  let totalVolume = 0;
  const evaluated = [];
  for (const bar of bars) {
    const high = positiveNum(bar.high ?? bar.h ?? bar.close);
    const low = positiveNum(bar.low ?? bar.l ?? bar.close);
    const close = positiveNum(bar.close ?? bar.c ?? bar.price);
    const volume = positiveNum(bar.volume ?? bar.v);
    if (high === null || low === null || close === null || volume === null) continue;
    pv += ((high + low + close) / 3) * volume;
    totalVolume += volume;
    if (!sample.includes(bar) || totalVolume <= 0) continue;
    evaluated.push({ close, vwap: pv / totalVolume });
  }
  if (evaluated.length < 3) return { vwapHoldMinutes: null, vwapHoldScore: 50 };
  let vwapHoldMinutes = 0;
  for (let i = evaluated.length - 1; i >= 0; i -= 1) {
    if (evaluated[i].close >= evaluated[i].vwap) vwapHoldMinutes += 1;
    else break;
  }
  const holdRatio = evaluated.filter((bar) => bar.close >= bar.vwap).length / evaluated.length;
  const vwapHoldScore = vwapHoldMinutes >= 10 ? 96
    : vwapHoldMinutes >= 5 ? 82
      : vwapHoldMinutes >= 3 ? 66
        : vwapHoldMinutes >= 1 ? 44
          : Math.max(22, holdRatio * 48);
  return { vwapHoldMinutes, vwapHoldScore: Math.round(Math.max(0, Math.min(100, vwapHoldScore))) };
}

function localCompressionScore(bars) {
  const sample = bars.slice(-20)
    .map((bar) => ({
      high: positiveNum(bar.high ?? bar.h ?? bar.close),
      low: positiveNum(bar.low ?? bar.l ?? bar.close),
      close: positiveNum(bar.close ?? bar.c ?? bar.price),
      volume: positiveNum(bar.volume ?? bar.v),
    }))
    .filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);
  if (sample.length < 8) return 50;
  const lastClose = sample.at(-1).close;
  const rangePct = ((Math.max(...sample.map((bar) => bar.high)) - Math.min(...sample.map((bar) => bar.low))) / Math.max(lastClose, 0.0001)) * 100;
  const recent = sample.slice(-8);
  const prior = sample.slice(0, Math.max(sample.length - 8, 1));
  const avgRange = (items) => {
    const ranges = items.map((bar) => ((bar.high - bar.low) / Math.max(bar.close, 0.0001)) * 100).filter(Number.isFinite);
    return ranges.length ? ranges.reduce((sum, value) => sum + value, 0) / ranges.length : null;
  };
  const recentRange = avgRange(recent);
  const priorRange = avgRange(prior);
  const rangeContracting = recentRange !== null && priorRange !== null && recentRange <= priorRange * 0.82;
  const lowsDefended = Math.min(...recent.map((bar) => bar.low)) >= Math.min(...sample.slice(0, -4).map((bar) => bar.low)) * 0.995;
  const volumeRebuilding = (() => {
    const volumes = sample.map((bar) => bar.volume).filter((value) => value !== null);
    const lastVol = volumes.slice(-3);
    const midVol = volumes.slice(-12, -3);
    const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const a = avg(lastVol);
    const b = avg(midVol);
    return a !== null && b !== null ? a >= b * 1.08 : false;
  })();
  const base = rangePct <= 3 ? 88 : rangePct <= 5 ? 78 : rangePct <= 8 ? 64 : rangePct <= 12 ? 52 : 38;
  const score = base + (rangeContracting ? 12 : -4) + (lowsDefended ? 10 : -12) + (volumeRebuilding ? 7 : 0) + (localHigherLowScore(sample) - 50) * 0.10;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function localVwapReclaimScore(bars, vwapHoldMinutes = null) {
  const sample = bars.slice(-30);
  if (sample.length < 8) return 50;
  let pv = 0;
  let totalVolume = 0;
  const evaluated = [];
  for (const bar of bars) {
    const high = positiveNum(bar.high ?? bar.h ?? bar.close);
    const low = positiveNum(bar.low ?? bar.l ?? bar.close);
    const close = positiveNum(bar.close ?? bar.c ?? bar.price);
    const volume = positiveNum(bar.volume ?? bar.v);
    if (high === null || low === null || close === null || volume === null) continue;
    pv += ((high + low + close) / 3) * volume;
    totalVolume += volume;
    if (!sample.includes(bar) || totalVolume <= 0) continue;
    const vwap = pv / totalVolume;
    evaluated.push({ close, volume, vwap, above: close >= vwap });
  }
  if (evaluated.length < 8) return 50;
  let reclaimIndex = -1;
  for (let i = 1; i < evaluated.length; i += 1) {
    if (!evaluated[i - 1].above && evaluated[i].above) reclaimIndex = i;
  }
  if (reclaimIndex < 0) return evaluated.at(-1)?.above ? 58 : 32;
  const after = evaluated.slice(reclaimIndex);
  const before = evaluated.slice(Math.max(0, reclaimIndex - 5), reclaimIndex);
  const avg = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const hold = num(vwapHoldMinutes) ?? after.filter((bar) => bar.above).length;
  const reclaimVol = avg(after.slice(0, 3).map((bar) => bar.volume));
  const priorVol = avg(before.map((bar) => bar.volume));
  const volumeExpanded = reclaimVol !== null && priorVol !== null && reclaimVol >= priorVol * 1.15;
  const last = evaluated.at(-1);
  const score = 40 + Math.min(hold, 10) * 5 + (volumeExpanded ? 16 : 0) + (last?.close >= last?.vwap * 0.996 ? 12 : -14) + (last?.above ? 8 : 0);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function localReSurgeSetupScore(bars, higherLowScore, vwapHoldScore, vwapReclaimScore) {
  const sample = bars.slice(-40)
    .map((bar) => ({
      high: positiveNum(bar.high ?? bar.h ?? bar.close),
      low: positiveNum(bar.low ?? bar.l ?? bar.close),
      close: positiveNum(bar.close ?? bar.c ?? bar.price),
      volume: positiveNum(bar.volume ?? bar.v),
    }))
    .filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);
  if (sample.length < 15) return 50;
  const last = sample.at(-1);
  const firstHalf = sample.slice(0, -10);
  const recent = sample.slice(-14);
  const priorLow = Math.min(...firstHalf.map((bar) => bar.low));
  const impulseHigh = Math.max(...firstHalf.map((bar) => bar.high));
  const impulseMovePct = priorLow > 0 ? ((impulseHigh - priorLow) / priorLow) * 100 : null;
  const recentLow = Math.min(...recent.map((bar) => bar.low));
  const recentHigh = Math.max(...recent.map((bar) => bar.high));
  const pullbackPct = impulseHigh > 0 ? ((impulseHigh - recentLow) / impulseHigh) * 100 : null;
  const sidewaysRangePct = ((recentHigh - recentLow) / Math.max(last.close, 0.0001)) * 100;
  let score = 28;
  if (impulseMovePct !== null && impulseMovePct >= 18) score += 18;
  else if (impulseMovePct !== null && impulseMovePct >= 9) score += 10;
  if (pullbackPct !== null && pullbackPct <= 18 && last.close >= impulseHigh * 0.72) score += 16;
  if (sidewaysRangePct <= 8) score += 12;
  else if (sidewaysRangePct <= 13) score += 6;
  if ((num(higherLowScore) ?? 50) >= 50) score += 10;
  if ((num(vwapHoldScore) ?? 50) >= 60 || (num(vwapReclaimScore) ?? 50) >= 65) score += 10;
  if (recentHigh > 0 && last.close >= recentHigh * 0.985) score += 12;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function higherLowLabel(score) {
  const value = num(score);
  if (value === null) return "데이터 부족";
  if (value >= 90) return "媛뺥븿";
  if (value >= 70) return "蹂댄넻";
  if (value >= 40) return "以묐┰";
  return "?놁쓬";
}

function vwapHoldText(minutes) {
  const value = num(minutes);
  return value === null ? "데이터 부족" : `${Math.round(value)}분`;
}

function strengthLabel(score) {
  const value = num(score);
  if (value === null) return "데이터 부족";
  if (value >= 90) return "媛뺥븿";
  if (value >= 70) return "?묓샇";
  if (value >= 40) return "관찰";
  return "?쏀븿";
}

function cardScore(card) {
  const scoreNode = card?.querySelector?.(".score-number,.kbk-top-score");
  const raw = scoreNode?.childNodes?.[0]?.textContent ?? scoreNode?.textContent ?? "";
  return num(String(raw).match(/\d+(?:\.\d+)?/)?.[0]);
}

function analyzeSignal(quote, bars) {
  const price = priceUsd(quote);
  const change = changePct(quote);
  const risk = num(quote?.riskScore) ?? 50;
  const probability = num(quote?.finalProbabilityScore) ?? num(quote?.scannerScore);
  const pattern = num(quote?.patternSimilarityScore) ?? 0;
  const vwap = vwapState(quote);
  const trend = trendLabel(quote);
  const { support, resistance } = supportResistance(quote, bars);
  const closePosition = num(quote?.technical?.closePosition);
  const volume = num(quote?.volume) ?? num(quote?.preMarketVolume);
  const localVwap = localVwapHold(bars);
  const higherLowScore = num(quote?.higherLowScore) ?? localHigherLowScore(bars);
  const vwapHoldScore = num(quote?.vwapHoldScore) ?? localVwap.vwapHoldScore;
  const vwapHoldMinutes = num(quote?.vwapHoldMinutes) ?? localVwap.vwapHoldMinutes;
  const compressionScore = num(quote?.compressionScore) ?? localCompressionScore(bars);
  const vwapReclaimScore = num(quote?.vwapReclaimScore) ?? localVwapReclaimScore(bars, vwapHoldMinutes);
  const reSurgeSetupScore = num(quote?.reSurgeSetupScore) ?? localReSurgeSetupScore(bars, higherLowScore, vwapHoldScore, vwapReclaimScore);

  let action = "관찰 후 알림 대기";
  let tone = "neutral";
  let reason = "嫄곕옒?됯낵 媛寃?援ъ“??媛먯떆??留뚰븯吏留? ?ㅼ젣 吏꾩엯 ?꾩뿉???뚮┝ ???ъ?吏? VWAP 諛섏쓳???ㅼ떆 ?뺤씤?댁빞 ?⑸땲??";

  if (risk >= 80 || change >= 120) {
    action = "?좉퇋 吏꾩엯 由ъ뒪???믪쓬";
    tone = "danger";
    reason = "?뱀씪 ?곸듅瑜??먮뒗 由ъ뒪???먯닔媛 ?믪븘 異붽꺽 留ㅼ닔蹂대떎 ?뚮┝怨?吏吏 ?뺤씤???곗꽑?낅땲??";
  } else if (trend === "?곸듅" && vwap === "VWAP 위" && probability >= 65 && risk < 65) {
    action = "?⑦? 愿???꾨낫";
    tone = "strong";
    reason = "?곸듅 ?먮쫫怨?VWAP ?곗쐞媛 媛숈씠 ?≫? ?덉뼱, 吏곸쟾 怨좎젏 ?뚰뙆 ?먮뒗 吏㏃? ?뚮┝ ???ъ긽?뱀쓣 ?뺤씤???꾨낫?낅땲??";
  } else if (vwap === "VWAP 아래") {
    action = "VWAP 회복 대기";
    tone = "wait";
    reason = "?꾩옱??VWAP ?꾨옒?쇱꽌 諛붾줈 ?곕씪媛湲곕낫???뚮났 ???좎??섎뒗吏 蹂대뒗 履쎌씠 ?덉쟾?⑸땲??";
  } else if (pattern >= 70 && probability >= 55) {
    action = "?⑦꽩 媛먯떆 ?꾨낫";
    tone = "watch";
    reason = "?좎궗 湲됰벑 ?⑦꽩怨??뺣쪧 ?먯닔???댁븘 ?덉쑝?? 泥닿껐 媛뺣룄? 諛뺤뒪沅??뚰뙆瑜?異붽?濡??뺤씤?댁빞 ?⑸땲??";
  }

  const position = closePosition === null ? "위치 확인 중" : closePosition >= 75 ? "상단권" : closePosition >= 45 ? "박스권 중앙" : "하단권";
  const stopLine = support !== null ? support * 0.985 : null;
  const entryBase = resistance ?? price;
  const entryLine = entryBase !== null ? entryBase * (resistance !== null ? 1.002 : 1) : null;
  const profitLine = entryLine !== null
    ? Math.max(price !== null ? price * 1.03 : 0, entryLine * 1.015)
    : null;

  return {
    action,
    tone,
    reason,
    price,
    change,
    risk,
    probability,
    pattern,
    vwap,
    trend,
    position,
    volume,
    higherLowScore,
    higherLowLabel: higherLowLabel(higherLowScore),
    vwapHoldScore,
    vwapHoldMinutes,
    compressionScore,
    vwapReclaimScore,
    reSurgeSetupScore,
    support,
    resistance,
    stopLine,
    entryLine,
    profitLine,
  };
}

function normalizeBars(payload) {
  const bars = payload?.data?.bars ?? payload?.bars ?? payload?.candles ?? [];
  return bars.map((bar) => ({
    time: bar.time ?? bar.date ?? bar.timestamp,
    close: positiveNum(bar.close ?? bar.c ?? bar.price),
    high: positiveNum(bar.high ?? bar.h ?? bar.close ?? bar.c ?? bar.price),
    low: positiveNum(bar.low ?? bar.l ?? bar.close ?? bar.c ?? bar.price),
    volume: num(bar.volume ?? bar.v),
  })).filter((bar) => bar.close !== null).slice(-60);
}

function fallbackBars(quote) {
  const price = priceUsd(quote);
  if (price === null) return [];
  const low = positiveNum(quote?.dayLow) ?? price * 0.97;
  const high = positiveNum(quote?.dayHigh) ?? price * 1.03;
  return Array.from({ length: 16 }, (_, i) => {
    const t = i / 15;
    const wave = Math.sin(t * Math.PI * 2) * (high - low) * 0.08;
    return { close: low + (price - low) * t + wave, high, low };
  });
}

function chartSvg(bars, signal) {
  const usable = bars.length ? bars : fallbackBars(lastQuote);
  if (!usable.length) return `<div class="kbk-empty-chart">李⑦듃 ?곗씠?곕? 湲곕떎由щ뒗 以묒엯?덈떎.</div>`;

  const width = 760;
  const height = 260;
  const pad = 28;
  const values = usable.flatMap((bar) => [bar.close, bar.high, bar.low]).filter((v) => positiveNum(v) !== null);
  if (signal.support !== null) values.push(signal.support);
  if (signal.resistance !== null) values.push(signal.resistance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.0001);
  const x = (i) => pad + (i / Math.max(usable.length - 1, 1)) * (width - pad * 2);
  const y = (v) => height - pad - ((v - min) / span) * (height - pad * 2);
  const path = usable.map((bar, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(bar.close).toFixed(1)}`).join(" ");
  const area = `${path} L${width - pad} ${height - pad} L${pad} ${height - pad} Z`;

  const level = (value, cls, label) => positiveNum(value) === null ? "" : `
    <line class="${cls}" x1="${pad}" y1="${y(value).toFixed(1)}" x2="${width - pad}" y2="${y(value).toFixed(1)}"></line>
    <text class="kbk-chart-label" x="${width - pad - 6}" y="${(y(value) - 6).toFixed(1)}">${label} $${value.toFixed(4)}</text>
  `;

  return `
    <svg class="kbk-detail-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(selectedSymbol)} ?ㅼ떆媛?李⑦듃">
      <path class="kbk-chart-area" d="${area}"></path>
      <path class="kbk-chart-line" d="${path}"></path>
      ${level(signal.support, "kbk-line-support", "吏吏")}
      ${level(signal.resistance, "kbk-line-resistance", "저항")}
      ${level(vwapValue(lastQuote), "kbk-line-vwap", "VWAP")}
    </svg>
  `;
}

function detailHtml(quote, bars, loading = false) {
  const signal = analyzeSignal(quote, bars);
  const price = signal.price;
  const krw = pricePairText(price);
  const scoreText = signal.probability === null ? "계산중" : Math.round(signal.probability);
  const badge = signal.tone === "danger" ? "위험" : signal.tone === "strong" ? "관심" : signal.tone === "wait" ? "대기" : "감시";

  return `
    <div class="kbk-detail-head">
      <div>
        <p class="kbk-kicker">?좏깮 醫낅ぉ ?곸꽭 媛먯떆</p>
        <h3>${esc(quote.symbol ?? selectedSymbol)} <span>${esc(quote.name ?? "")}</span></h3>
        <p>${esc(signal.reason)}</p>
      </div>
      <div class="kbk-detail-score">
        <strong>${scoreText}</strong>
        <span>${badge}</span>
      </div>
      <button type="button" class="kbk-detail-close" aria-label="?곸꽭 ?リ린">횞</button>
    </div>

    <div class="kbk-detail-price">
      <strong>${krw}</strong>
      <span>${pct(signal.change)}</span>
      <span>${displayVolumeText(signal.volume)}</span>
      <span>${esc(signal.vwap)}</span>
      <span>Higher Lows: ${esc(signal.higherLowLabel)}</span>
      <span>VWAP ?좎?: ${esc(vwapHoldText(signal.vwapHoldMinutes))}</span>
      <span>?ъ긽??以鍮꾨룄: ${Math.round(signal.reSurgeSetupScore)}??/span>
      ${loading ? `<span class="kbk-live-chip">?ㅼ떆媛?媛깆떊 以?/span>` : ""}
    </div>

    <section class="kbk-signal-panel kbk-${signal.tone}">
      <div>
        <span>?좏깮 醫낅ぉ ?ㅼ떆媛?李⑦듃/?쒓렇??/span>
        <strong>${esc(signal.action)}</strong>
      </div>
      <div class="kbk-signal-grid">
        <div><span>?꾩옱 ?꾩튂</span><strong>${esc(signal.position)}</strong><small>諛뺤뒪沅????꾩튂</small></div>
        <div><span>Higher Lows</span><strong>${esc(signal.higherLowLabel)}</strong><small>${Math.round(signal.higherLowScore)}점</small></div>
        <div><span>VWAP 유지</span><strong>${esc(vwapHoldText(signal.vwapHoldMinutes))}</strong><small>${Math.round(signal.vwapHoldScore)}점</small></div>
        <div><span>재상승 준비도</span><strong>${Math.round(signal.reSurgeSetupScore)}점</strong><small>${esc(strengthLabel(signal.reSurgeSetupScore))}</small></div>
        <div><span>박스 압축률</span><strong>${Math.round(signal.compressionScore)}점</strong><small>돌파 전 압축</small></div>
        <div><span>VWAP 회복</span><strong>${esc(strengthLabel(signal.vwapReclaimScore))}</strong><small>${Math.round(signal.vwapReclaimScore)}점</small></div>
        <div><span>진입 확인</span><strong>${levelText(signal.entryLine, "계산중")}</strong><small>돌파/지지 확인</small></div>
        <div><span>아래 기준선</span><strong>${levelText(signal.stopLine, "데이터 부족")}</strong><small>지지 이탈 시 주의</small></div>
        <div><span>1차 수익 참고</span><strong>${levelText(signal.profitLine, "계산중")}</strong><small>단기 +3% 기준</small></div>
      </div>
      ${chartSvg(bars, signal)}
    </section>

    <section class="kbk-explain-grid">
      <div><span>媛쒕퀎 ?ㅻ챸</span><p>${esc(quote.symbol ?? selectedSymbol)}???꾩옱 ${esc(signal.trend)} ?먮쫫, ${esc(signal.vwap)} ?곹깭?낅땲?? ?먯닔留?蹂댁? 留먭퀬 嫄곕옒???좎?, 怨좎젏 ?뚰뙆 ?ㅽ뙣 ?щ?, ?뚮┝ ???ъ긽?뱀쓣 媛숈씠 蹂댁뀛???⑸땲??</p></div>
      <div><span>由ъ뒪???ㅻ챸</span><p>異붽꺽 ?꾪뿕 ${Math.round(signal.risk)}?? ?좎궗 ?⑦꽩 ${Math.round(signal.pattern)}?먯엯?덈떎. ?곸듅瑜좎씠 ??醫낅ぉ? ?좏샇媛 醫뗭븘???좉퇋 吏꾩엯 由ъ뒪?ш? 鍮좊Ⅴ寃?而ㅼ쭛?덈떎.</p></div>
      <div><span>?뺤씤 ?쒖꽌</span><p>1. VWAP ?뚮났/?좎? 2. Higher Lows ?좎? 3. 吏곸쟾 怨좎젏 ?뚰뙆 4. ?뚮┝ ??嫄곕옒??媛먯냼 5. ?ъ긽??嫄곕옒??利앷? ?쒖꽌濡??뺤씤?섏꽭??</p></div>
    </section>
  `;
}

function ensureShell() {
  let shell = document.getElementById("kbk-symbol-detail-root");
  if (shell) return shell;

  const style = document.createElement("style");
  style.textContent = `
    .stock-card,.setup-card{cursor:pointer}
    .stock-card.kbk-selected-card,.setup-card.kbk-selected-card{outline:3px solid #2563eb;box-shadow:0 22px 60px rgba(37,99,235,.24)}
    #kbk-symbol-detail-root{position:fixed;right:24px;bottom:24px;z-index:9999;width:min(760px,calc(100vw - 32px));max-height:min(86vh,860px);overflow:auto;background:rgba(255,255,255,.98);border:1px solid rgba(15,23,42,.14);border-radius:24px;box-shadow:0 28px 90px rgba(15,23,42,.24);padding:22px;font-family:IBM Plex Sans KR,Pretendard,Segoe UI,sans-serif;color:#0f172a}
    #kbk-symbol-detail-root[hidden]{display:none}
    .kbk-detail-head{display:grid;grid-template-columns:minmax(0,1fr)96px 34px;gap:16px;align-items:start}
    .kbk-kicker{margin:0 0 8px;color:#2563eb;font-weight:800;font-size:.82rem;letter-spacing:.12em;text-transform:uppercase}
    .kbk-detail-head h3{margin:0;font-size:1.8rem;letter-spacing:-.04em}
    .kbk-detail-head h3 span{font-size:1rem;color:#64748b;font-weight:700}
    .kbk-detail-head p{margin:8px 0 0;color:#475569;line-height:1.55}
    .kbk-detail-score{text-align:center;background:#eff6ff;border-radius:18px;padding:14px}
    .kbk-detail-score strong{display:block;font-size:clamp(1rem,4vw,2.5rem);line-height:1;overflow-wrap:anywhere}
    .kbk-detail-score span{display:inline-flex;margin-top:8px;padding:6px 10px;border-radius:999px;color:#fff;background:#2563eb;font-weight:800;font-size:.78rem}
    .kbk-detail-close{width:34px;height:34px;border:0;border-radius:999px;background:#e2e8f0;color:#0f172a;font-size:24px;line-height:1;cursor:pointer}
    .kbk-detail-price{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;margin:18px 0;color:#334155}
    .kbk-detail-price strong{font-size:1.25rem;color:#0f172a}
    .kbk-live-chip{color:#1d4ed8;background:#dbeafe;border-radius:999px;padding:6px 10px;font-weight:800}
    .kbk-signal-panel{border-radius:22px;border:1px solid rgba(15,23,42,.12);padding:18px;background:linear-gradient(#f8fafc,#fff)}
    .kbk-signal-panel>div:first-child span{color:#2563eb;font-size:.86rem;font-weight:800}
    .kbk-signal-panel>div:first-child strong{display:block;margin-top:4px;font-size:1.45rem}
    .kbk-signal-panel.kbk-danger{background:linear-gradient(#fff1f2,#fff)}
    .kbk-signal-panel.kbk-strong{background:linear-gradient(#ecfeff,#fff)}
    .kbk-signal-panel.kbk-wait{background:linear-gradient(#fffbeb,#fff)}
    .kbk-signal-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:16px}
    .kbk-signal-grid div,.kbk-explain-grid div{background:#fff;border-radius:16px;padding:13px;border:1px solid rgba(15,23,42,.08)}
    .kbk-signal-grid span,.kbk-explain-grid span{display:block;color:#64748b;font-size:.82rem;font-weight:800}
    .kbk-signal-grid strong{display:block;margin-top:6px}
    .kbk-signal-grid small{display:block;margin-top:6px;color:#64748b}
    .kbk-detail-chart{width:100%;height:auto;margin-top:16px;background:#f8fafc;border-radius:18px}
    .kbk-chart-area{fill:rgba(37,99,235,.12)}
    .kbk-chart-line{fill:none;stroke:#2563eb;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}
    .kbk-line-support{stroke:#0f766e;stroke-width:2;stroke-dasharray:8 6}
    .kbk-line-resistance{stroke:#dc2626;stroke-width:2;stroke-dasharray:8 6}
    .kbk-line-vwap{stroke:#9333ea;stroke-width:2;stroke-dasharray:4 5}
    .kbk-chart-label{fill:#334155;font-size:13px;text-anchor:end;font-weight:800}
    .kbk-explain-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
    .kbk-explain-grid p{margin:8px 0 0;color:#475569;line-height:1.55}
    .kbk-empty-chart{margin-top:14px;padding:30px;border-radius:16px;background:#f8fafc;color:#64748b;text-align:center}
    @media (max-width:900px){#kbk-symbol-detail-root{left:12px;right:12px;bottom:12px;width:auto}.kbk-signal-grid,.kbk-explain-grid{grid-template-columns:1fr}.kbk-detail-head{grid-template-columns:minmax(0,1fr)72px 34px}}
  `;
  document.head.appendChild(style);

  shell = document.createElement("aside");
  shell.id = "kbk-symbol-detail-root";
  shell.hidden = true;
  shell.setAttribute("aria-live", "polite");
  document.body.appendChild(shell);
  shell.addEventListener("click", (event) => {
    if (event.target.closest(".kbk-detail-close")) closeDetail();
  });
  return shell;
}

const API_CACHE_RULES = [
  { prefix: "/api/scanner", ttlMs: 120 * 1000, cooldownMs: 60 * 1000, message: "스캐너 데이터를 잠시 후 다시 시도해주세요." },
  { prefix: "/api/history", ttlMs: 5 * 60 * 1000, cooldownMs: 60 * 1000, message: "차트 데이터를 잠시 후 다시 시도해주세요." },
];
const apiResponseCache = new Map();
const apiRequestInflight = new Map();
const apiFailureCooldown = new Map();

function apiCacheConfig(url) {
  const path = String(url || "").split("?")[0];
  return API_CACHE_RULES.find((rule) => path === rule.prefix) || null;
}

function apiCacheKey(url) {
  const absolute = new URL(url, window.location.origin);
  return `${absolute.pathname}${absolute.search}`;
}

async function fetchJson(url) {
  const config = apiCacheConfig(url);
  const key = config ? apiCacheKey(url) : null;
  const now = Date.now();
  if (config && key) {
    const cooldown = apiFailureCooldown.get(key);
    if (cooldown && cooldown.until > now) {
      throw new Error(cooldown.message);
    }
    const cached = apiResponseCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.payload;
    }
    if (apiRequestInflight.has(key)) {
      return apiRequestInflight.get(key);
    }
  }

  const request = (async () => {
    const res = await fetch(url, scannerFetchOptions(url));
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      const message = json.message || config?.message || `API error ${res.status}`;
      if (config && key) {
        apiFailureCooldown.set(key, {
          until: Date.now() + config.cooldownMs,
          message,
        });
      }
      throw new Error(message);
    }
    if (config && key) {
      apiResponseCache.set(key, {
        payload: json,
        expiresAt: Date.now() + config.ttlMs,
      });
      apiFailureCooldown.delete(key);
    }
    return json;
  })();

  if (!config || !key) {
    return request;
  }

  apiRequestInflight.set(key, request);
  return request.finally(() => {
    apiRequestInflight.delete(key);
  });
}

async function refreshDetail(symbol, loading = false) {
  const requestedSymbol = symbol?.toUpperCase?.() ?? symbol;
  if (!requestedSymbol) return;
  if (selectedDetailCalculating) {
    selectedDetailRefreshQueued = true;
    return;
  }

  selectedDetailCalculating = true;
  const shell = ensureShell();
  shell.hidden = false;
  if (loading && !lastQuote) {
    shell.innerHTML = `<div class="kbk-detail-head"><div><p class="kbk-kicker">?좏깮 醫낅ぉ ?곸꽭 媛먯떆</p><h3>${esc(requestedSymbol)}</h3><p>?ㅼ떆媛??쒖꽭? 遺꾨큺 李⑦듃瑜?遺덈윭?ㅻ뒗 以묒엯?덈떎.</p></div><button type="button" class="kbk-detail-close" aria-label="?곸꽭 ?リ린">횞</button></div>`;
  }

  try {
    const from = encodeURIComponent(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
    const [quotePayload, historyPayload, exchangePayload] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(requestedSymbol)}`),
      fetchJson(`/api/history?symbol=${encodeURIComponent(requestedSymbol)}&from=${from}`).catch(() => null),
      fetchJson(`/api/exchange`).catch(() => null),
    ]);
    if (selectedSymbol !== requestedSymbol) return;
    lastQuote = { ...(quotePayload.data ?? quotePayload) };
    if (num(lastQuote.finalProbabilityScore) === null && num(lastQuote.scannerScore) === null && selectedFallbackScore !== null) {
      lastQuote.scannerScore = selectedFallbackScore;
    }
    lastBars = historyPayload ? normalizeBars(historyPayload) : fallbackBars(lastQuote);
    usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
    shell.innerHTML = detailHtml(lastQuote, lastBars, false);
  } catch (error) {
    if (selectedSymbol !== requestedSymbol) return;
    shell.innerHTML = `
      <div class="kbk-detail-head">
        <div><p class="kbk-kicker">?좏깮 醫낅ぉ ?곸꽭 媛먯떆</p><h3>${esc(requestedSymbol)}</h3><p>${esc(error.message || "?곸꽭 ?곗씠?곕? 遺덈윭?ㅼ? 紐삵뻽?듬땲??")}</p></div>
        <button type="button" class="kbk-detail-close" aria-label="?곸꽭 ?リ린">횞</button>
      </div>
    `;
  } finally {
    selectedDetailCalculating = false;
    if (selectedDetailRefreshQueued && selectedSymbol === requestedSymbol) {
      selectedDetailRefreshQueued = false;
      window.setTimeout(() => refreshDetail(requestedSymbol, false), 0);
    }
  }
}

function startSelectedSymbolMonitor() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (selectedSymbol) refreshDetail(selectedSymbol, false);
  }, POLL_MS);
}

function selectSymbol(symbol, card) {
  if (!symbol) return;
  selectedSymbol = symbol.toUpperCase();
  lastQuote = null;
  lastBars = [];
  selectedFallbackScore = cardScore(card);
  selectedDetailCalculating = false;
  selectedDetailRefreshQueued = false;
  document.querySelectorAll(".stock-card.kbk-selected-card,.setup-card.kbk-selected-card").forEach((el) => el.classList.remove("kbk-selected-card"));
  card?.classList.add("kbk-selected-card");
  refreshDetail(selectedSymbol, true);
  startSelectedSymbolMonitor();
}

function closeDetail() {
  selectedSymbol = null;
  window.clearInterval(pollTimer);
  pollTimer = null;
  selectedDetailCalculating = false;
  selectedDetailRefreshQueued = false;
  selectedFallbackScore = null;
  document.querySelectorAll(".stock-card.kbk-selected-card,.setup-card.kbk-selected-card").forEach((el) => el.classList.remove("kbk-selected-card"));
  const shell = ensureShell();
  shell.hidden = true;
  shell.innerHTML = "";
}

document.addEventListener("click", (event) => {
  const card = event.target.closest(".stock-card,.setup-card,.kbk-top-card");
  if (!card || event.target.closest("#kbk-symbol-detail-root")) return;
  const symbol = card.querySelector("h3")?.textContent?.trim();
  if (!symbol) return;
  selectSymbol(symbol, card);
});

function ensureClarifierStyles() {
  if (document.getElementById("kbk-scanner-clarifier-style")) return;
  const style = document.createElement("style");
  style.id = "kbk-scanner-clarifier-style";
  style.textContent = `
    .kbk-scanner-clarifier{background:linear-gradient(135deg,#eff6ff,#ffffff);border:1px solid rgba(37,99,235,.22);border-radius:20px;padding:18px 20px;display:grid;gap:12px;box-shadow:0 16px 38px rgba(15,23,42,.08)}
    .kbk-scanner-clarifier strong{color:#0f172a;font-size:1.02rem}
    .kbk-scanner-clarifier p{color:#334155;margin:0;line-height:1.65}
    .kbk-clarifier-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .kbk-clarifier-grid div{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:16px;padding:12px 14px}
    .kbk-clarifier-grid span{color:#64748b;display:block;font-size:.82rem;font-weight:700}
    .kbk-clarifier-grid b{color:#0f172a;display:block;margin-top:5px}
    @media (max-width:800px){.kbk-clarifier-grid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function clarifierContent(pathname) {
  if (pathname.includes("/scanner/surge-watch") || pathname.includes("/surge-watch")) {
    return `
      <strong>??벑 媛먯떆 ?꾨낫??留ㅼ닔 ?좏샇媛 ?꾨땲???쒖?吏곸엫 媛먯떆 ?깃툒?앹엯?덈떎.</strong>
      <p>?ш린?쒖쓽 愿??媛뺥븳 媛먯떆???곸듅瑜? ?댁뒪/怨듭떆, 嫄곕옒?? 紐⑤찘???媛뺥빐 怨꾩냽 蹂?醫낅ぉ?대씪???살엯?덈떎. ?대? 留롮씠 ?ㅻⅨ 醫낅ぉ??媛먯떆 ?꾨낫???????덉쑝硫? ?ㅼ젣 ?좉퇋 吏꾩엯 ?щ????뚮┝, VWAP ?ъ?吏, 怨쇱뿴 ?꾪뿕???곕줈 ?뺤씤?댁빞 ?⑸땲??</p>
      <div class="kbk-clarifier-grid">
        <div><span>愿??/span><b>?吏곸엫???덉뼱 媛먯떆</b></div>
        <div><span>媛뺥븳 媛먯떆</span><b>二쇰룄二?媛?μ꽦 ?뺤씤</b></div>
        <div><span>留ㅼ닔 ?먮떒</span><b>?꾩쭅 ?꾨떂, ?먮━ ?뺤씤 ?꾩슂</b></div>
      </div>
    `;
  }
  if (pathname.includes("/scanner/accumulation") || pathname.includes("/accumulation")) {
    return `
      <strong>留ㅼ쭛 ?ㅼ틦?덈뒗 ?쒖?湲??좉퇋 吏꾩엯?대룄 ?섎뒗 ?먮━?몄??앸? ??蹂댁닔?곸쑝濡??먮떒?⑸땲??</strong>
      <p>??벑 媛먯떆 ?꾨낫????醫낅ぉ?대씪???대? ?ш쾶 ?ㅻⅨ 援ш컙?대㈃ 留ㅻℓ 湲덉? ?먮뒗 愿李????뚮┝ ?湲곌? ?섏삱 ???덉뒿?덈떎. ???붾㈃??留ㅻℓ 湲덉???醫낅ぉ ?먯껜媛 ?섏걯?ㅻ뒗 ?살씠 ?꾨땲?? ?꾩옱 ?꾩튂?먯꽌 異붽꺽 留ㅼ닔 ?꾪뿕???щ떎???섎??낅땲??</p>
      <div class="kbk-clarifier-grid">
        <div><span>留ㅻℓ 湲덉?</span><b>吏湲??좉퇋 吏꾩엯 湲덉?</b></div>
        <div><span>?뚮┝ ?湲?/span><b>VWAP/吏吏 ?ы솗??/b></div>
        <div><span>吏꾩엯 ?꾨낫</span><b>怨쇱뿴怨?湲됰씫 ?꾪뿕 ??쓣 ??/b></div>
      </div>
    `;
  }
  return "";
}

function syncScannerClarifier() {
  ensureClarifierStyles();
  const content = clarifierContent(window.location.pathname);
  const existing = document.getElementById("kbk-scanner-clarifier");
  if (!content) {
    existing?.remove();
    return;
  }
  const anchor = document.querySelector(".page-panel:not(.hidden-panel) .scanner-disclaimer")
    ?? document.querySelector(".page-panel:not(.hidden-panel) .accumulation-hero");
  if (!anchor) return;
  const box = existing ?? document.createElement("section");
  box.id = "kbk-scanner-clarifier";
  box.className = "kbk-scanner-clarifier";
  box.innerHTML = content;
  if (!existing || box.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement("afterend", box);
  }
}

window.addEventListener("DOMContentLoaded", syncScannerClarifier);
window.addEventListener("popstate", () => window.setTimeout(syncScannerClarifier, 80));
document.addEventListener("click", () => window.setTimeout(syncScannerClarifier, 120));
window.addEventListener("DOMContentLoaded", () => {
  for (let i = 1; i <= 8; i += 1) {
    window.setTimeout(syncScannerClarifier, i * 250);
  }
});

function clampScore(value, min = 0, max = 100) {
  const n = num(value);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

function relativeVolumeOf(item) {
  return num(item?.relativeVolume) ?? num(item?.volumeRatio) ?? 1;
}

function getChangePenalty(changePercent) {
  const change = num(changePercent);
  if (change === null) return 0;
  if (change >= 80) return 70;
  if (change >= 50) return 55;
  if (change >= 25) return 40;
  if (change >= 15) return 28;
  if (change >= 10) return 20;
  if (change >= 8) return 12;
  if (change >= 5) return 5;
  return 0;
}

function classifyStageByMove({ changePercent, relativeVolume, rsi }) {
  const change = num(changePercent) ?? 0;
  const rvol = num(relativeVolume) ?? 0;
  const safeRsi = num(rsi) ?? 50;
  if (change >= 80 || safeRsi >= 95) return "OVERHEATED";
  if (change >= 25) return "CHASING_RISK";
  if (change >= 15) return "MOMENTUM_EXPANSION";
  if (change >= 8) return "EARLY_BREAKOUT";
  if (change >= -3 && change <= 8 && rvol >= 1.5) return "PRE_SURGE";
  if (change >= -5 && change <= 5 && rvol >= 1.1) return "ACCUMULATION";
  return "NEUTRAL";
}

function stageMetaOf(item, changeOverride = null) {
  const change = num(changeOverride) ?? changePct(item) ?? 0;
  const relativeVolume = relativeVolumeOf(item);
  const rsi = num(item?.rsi) ?? num(item?.technical?.rsi) ?? 50;
  const stage = String(item?.stage || classifyStageByMove({ changePercent: change, relativeVolume, rsi }));
  const changePenalty = num(item?.changePenalty) ?? getChangePenalty(change);
  const isPreSurgeCandidate = item?.isPreSurgeCandidate === true
    || ((stage === "ACCUMULATION" || stage === "PRE_SURGE") && change <= 10);
  const isChasingRisk = item?.isChasingRisk === true || stage === "CHASING_RISK" || stage === "OVERHEATED";
  const isOverheated = item?.isOverheated === true || stage === "OVERHEATED";
  return { stage, changePenalty, isPreSurgeCandidate, isChasingRisk, isOverheated };
}

function scannerFetchOptions(url) {
  return String(url || "").includes("/api/scanner") ? { cache: "default" } : { cache: "no-store" };
}

function itemField(item, key) {
  return num(item?.[key]) ?? num(item?.technical?.[key]);
}

function formatKrwFromUsdDollar(dollarUsd) {
  const usd = num(dollarUsd);
  if (usd === null || usd <= 0) return null;
  const krw = usd * usdKrw;
  if (krw >= 100_000_000) return `??${(krw / 100_000_000).toFixed(1)}????;
  if (krw >= 10_000_000) return `??${Math.round(krw / 10_000_000)}泥쒕쭔 ??;
  return `??${fmt.format(Math.round(krw))}??;
}

function computeVolumeQualityScore(item, price, volume, rvol) {
  const dollarVolume = price > 0 && volume > 0 ? price * volume : null;
  const volumeScore = volume >= 10_000_000 ? 96
    : volume >= 5_000_000 ? 88
    : volume >= 2_000_000 ? 78
    : volume >= 1_000_000 ? 68
    : volume >= 500_000 ? 52
    : 35;
  const rvolScore = rvol >= 8 ? 95
    : rvol >= 5 ? 86
    : rvol >= 3 ? 76
    : rvol >= 2 ? 62
    : rvol >= 1.2 ? 48
    : 30;
  const dollarScore = dollarVolume === null ? 38
    : dollarVolume >= 20_000_000 ? 98
    : dollarVolume >= 5_000_000 ? 85
    : dollarVolume >= 1_000_000 ? 70
    : dollarVolume >= 500_000 ? 55
    : 38;
  const score = Math.round(clampScore(volumeScore * 0.35 + rvolScore * 0.35 + dollarScore * 0.3));
  return {
    score,
    dollarVolume,
    volumeScore,
    rvolScore,
    dollarScore,
    strong: score >= 72,
    moderate: score >= 58,
    contributed: score >= 58 && (volume >= 500_000 || rvol >= 1.2 || (dollarVolume !== null && dollarVolume >= 500_000)),
  };
}

function computeSurgeAccelerationScore(item) {
  const volumeAccelerationScore = itemField(item, "volumeAccelerationScore") ?? 50;
  const momentumExpansionScore = itemField(item, "momentumExpansionScore") ?? 50;
  const surgePrecursorScore = itemField(item, "surgePrecursorScore") ?? 50;
  const accel1m = itemField(item, "volumeAcceleration1m");
  const accel5m = itemField(item, "volumeAcceleration5m");
  let score = Math.round(clampScore(
    volumeAccelerationScore * 0.42
    + momentumExpansionScore * 0.28
    + surgePrecursorScore * 0.3
  ));
  if (accel5m !== null && accel5m >= 2.2) score = Math.round(clampScore(score + 8));
  else if (accel5m !== null && accel5m >= 1.5) score = Math.round(clampScore(score + 4));
  if (accel1m !== null && accel1m >= 2) score = Math.round(clampScore(score + 3));
  return {
    score,
    volumeAccelerationScore,
    momentumExpansionScore,
    surgePrecursorScore,
    accel1m,
    accel5m,
    strong: score >= 72,
    moderate: score >= 58,
    contributed: score >= 58 && (
      volumeAccelerationScore >= 60
      || accel5m !== null && accel5m >= 1.35
      || accel1m !== null && accel1m >= 1.35
      || momentumExpansionScore >= 65
    ),
  };
}

function buildTopPickExplainSections(item, pick, volumeQuality, surgeAcceleration) {
  const existingReasons = Array.isArray(pick?.reasons) ? [...pick.reasons] : [];
  const setup = pick?.setupBias ?? {};
  const volumeQualityLines = [];
  const surgeAccelerationLines = [];
  const technicalLines = [];
  const cautions = [];

  if (volumeQuality.contributed) {
    volumeQualityLines.push(`嫄곕옒???덉쭏 ?먯닔 ${volumeQuality.score}??);
    if (pick.volume >= 500_000) {
      volumeQualityLines.push(`嫄곕옒??${compact(pick.volume)}`);
    }
    const dollarText = formatKrwFromUsdDollar(volumeQuality.dollarVolume);
    if (dollarText) {
      volumeQualityLines.push(`嫄곕옒?湲?${dollarText}`);
    }
    if (pick.rvol >= 1.5 && volumeQuality.rvolScore >= 48) {
      volumeQualityLines.push(`RVOL ${pick.rvol.toFixed(1)}諛곕줈 ?됯퇏 ?鍮?嫄곕옒媛 遺숈뿀?듬땲??);
    }
  }

  if (surgeAcceleration.contributed) {
    if (surgeAcceleration.accel5m !== null && surgeAcceleration.accel5m >= 1.35) {
      surgeAccelerationLines.push(`理쒓렐 5遺?嫄곕옒??${surgeAcceleration.accel5m.toFixed(1)}諛?利앷?`);
      surgeAccelerationLines.push(`理쒓렐 5遺?嫄곕옒?湲?${surgeAcceleration.accel5m.toFixed(1)}諛?利앷?`);
    }
    if (surgeAcceleration.accel1m !== null && surgeAcceleration.accel1m >= 1.35) {
      surgeAccelerationLines.push(`理쒓렐 1遺?嫄곕옒??${surgeAcceleration.accel1m.toFixed(1)}諛?利앷?`);
    }
    if (surgeAcceleration.strong) {
      surgeAccelerationLines.push(`湲됰벑 媛?띾룄 ?먯닔 ${surgeAcceleration.score}??);
    } else if (surgeAcceleration.moderate) {
      surgeAccelerationLines.push(`?섍툒 媛???먯닔 ${surgeAcceleration.score}??);
    }
    if (
      surgeAcceleration.volumeAccelerationScore >= 65
      && !surgeAccelerationLines.some((line) => line.includes("媛?띾룄"))
    ) {
      surgeAccelerationLines.push(`嫄곕옒??媛??吏??${Math.round(surgeAcceleration.volumeAccelerationScore)}?먯쑝濡??섍툒??遺숇뒗 以묒엯?덈떎`);
    }
  }

  const vwapGood = String(pick?.vwap ?? "").includes("위") || String(pick?.vwap ?? "").includes("near") || String(pick?.vwap ?? "").includes("근처");
  const reclaim = itemField(item, "vwapReclaimScore") ?? 50;
  const compression = itemField(item, "compressionScore") ?? 50;
  if (vwapGood) technicalLines.push("VWAP ???좎?");
  else if (reclaim >= 60) technicalLines.push("VWAP ?щ룎???쒕룄");
  if ((setup.higherLow ?? itemField(item, "higherLowScore") ?? 0) >= 60) {
    technicalLines.push("Higher Low ?뺤꽦");
  }
  if (compression >= 70) technicalLines.push("?뺤텞援ш컙 ?뚰뙆 ?쒕룄");
  if ((setup.resurge ?? itemField(item, "reSurgeSetupScore") ?? 0) >= 65) {
    technicalLines.push("?뚮┝ ???ъ긽??援ъ“");
  }
  if (pick.trend === "?곸듅" && !technicalLines.some((line) => line.includes("異붿꽭"))) {
    technicalLines.push("1遺?異붿꽭 ?곸듅");
  }

  const rsi = setup.rsi ?? itemField(item, "rsi");
  if (rsi !== null && rsi >= 70) cautions.push(`RSI ${Math.round(rsi)}`);
  if ((pick.change ?? 0) >= 42) cautions.push(`?뱀씪 ${pct(pick.change)} ?곸듅`);
  if (setup.highFailed) cautions.push("怨좎젏 ?鍮??댄깉 ?꾪뿕");
  if (String(pick?.vwap ?? "").includes("?꾨옒")) cautions.push("VWAP ?꾨옒");
  if ((pick.chaseRisk ?? 0) >= 75) cautions.push("異붽꺽 由ъ뒪???믪쓬");

  const sections = [];
  if (volumeQualityLines.length) sections.push({ title: "嫄곕옒???덉쭏", lines: volumeQualityLines });
  if (surgeAccelerationLines.length) sections.push({ title: "?섍툒 媛?띾룄", lines: surgeAccelerationLines });
  if (technicalLines.length) sections.push({ title: "湲곗닠???⑦꽩", lines: technicalLines });

  const detailReasons = [
    ...existingReasons,
    ...sections.flatMap((section) => section.lines.map((line) => `${section.title}: ${line}`)),
  ];

  return {
    existingReasons,
    sections,
    cautions,
    detailReasons: detailReasons.length ? detailReasons.slice(0, 8) : ["媛寃?嫄곕옒??援ъ“瑜?醫낇빀???곸쐞 ?꾨낫濡??щ졇?듬땲??"],
    volumeQualityScore: volumeQuality.score,
    surgeAccelerationScore: surgeAcceleration.score,
  };
}

function renderTopPickExplainHtml(pick) {
  const sections = Array.isArray(pick.selectionSections) ? pick.selectionSections : [];
  if (!sections.length) return "";
  return sections.map((section) => (
    '<div class="kbk-top-explain-block">'
    + `<h5>${esc(section.title)}</h5>`
    + `<ul>${section.lines.map((line) => `<li>??${esc(line)}</li>`).join("")}</ul>`
    + "</div>"
  )).join("");
}

function setupBiasOf(item, price, change, rvol, vwapGood, trendGood) {
  const rsi = num(item?.rsi ?? item?.technical?.rsi);
  const dayHigh = positiveNum(item?.dayHigh ?? item?.regularMarketDayHigh);
  const dayLow = positiveNum(item?.dayLow ?? item?.regularMarketDayLow);
  const highPullbackPct = price > 0 && dayHigh ? ((dayHigh - price) / dayHigh) * 100 : null;
  const highPosition = price > 0 && dayHigh && dayLow && dayHigh > dayLow
    ? ((price - dayLow) / (dayHigh - dayLow)) * 100
    : null;
  const volumeAcceleration = num(item?.volumeAccelerationScore) ?? 50;
  const higherLow = num(item?.higherLowScore) ?? 50;
  const vwapHold = num(item?.vwapHoldScore) ?? 50;
  const resurge = num(item?.reSurgeSetupScore) ?? 50;
  const reclaim = num(item?.vwapReclaimScore) ?? 50;
  const compression = num(item?.compressionScore) ?? 50;
  const underDollarLowRvol = price > 0 && price < 1 && rvol < 3;
  const volumeStarting = rvol >= 3;
  const notOverChased = change >= 1 && change <= 45;
  const lowRecovery = highPosition !== null && highPosition >= 15 && highPosition <= 70;
  const highFailed = highPullbackPct !== null && highPullbackPct >= 18 && change >= 25;
  const overheated = change >= 80 || (rsi >= 80 && change >= 20);
  const extremeRvolWeak = rvol >= 8 && highPullbackPct !== null && highPullbackPct >= 22 && (!vwapGood || !trendGood);
  const strongEarlySignal = volumeStarting
    && notOverChased
    && (vwapGood || reclaim >= 60)
    && (higherLow >= 60 || resurge >= 60 || compression >= 70);
  const earlyBonus = clampScore(
    (volumeStarting ? 8 : 0)
      + (volumeAcceleration >= 65 ? 5 : 0)
      + (notOverChased ? 8 : 0)
      + (vwapGood || reclaim >= 60 ? 7 : 0)
      + (higherLow >= 65 ? 5 : 0)
      + (resurge >= 65 ? 5 : 0)
      + (lowRecovery ? 4 : 0),
    0,
    28
  );
  const riskPenalty = clampScore(
    (overheated ? 18 : 0)
      + (change >= 120 ? 12 : 0)
      + (highFailed ? 12 : 0)
      + (extremeRvolWeak ? 14 : 0)
      + (underDollarLowRvol ? 18 : 0),
    0,
    44
  );
  return {
    rsi,
    highPullbackPct,
    highPosition,
    volumeAcceleration,
    higherLow,
    vwapHold,
    resurge,
    reclaim,
    underDollarLowRvol,
    volumeStarting,
    lowRecovery,
    highFailed,
    overheated,
    extremeRvolWeak,
    strongEarlySignal,
    earlyBonus,
    riskPenalty,
  };
}

function trendOf(item) {
  return trendLabel(item);
}

function scoreTopPick(item) {
  const price = priceUsd(item) ?? 0;
  const change = changePct(item);
  const volume = num(item?.volume) ?? num(item?.preMarketVolume) ?? 0;
  const rvol = relativeVolumeOf(item);
  const vwap = vwapState(item);
  const trend = trendOf(item);
  const scanner = num(item?.scannerScore) ?? num(item?.finalProbabilityScore) ?? 50;
  const pattern = num(item?.patternSimilarityScore) ?? 50;
  const risk = num(item?.riskScore) ?? 50;
  const sourceTags = item?.sourceTags ?? [];
  const storyTags = item?.storyTags ?? [];

  const vwapGood = vwap.includes("위") || vwap.includes("near") || vwap.includes("근처");
  const trendGood = trend === "?곸듅";
  const setupBias = setupBiasOf(item, price, change, rvol, vwapGood, trendGood);
  const stageMeta = stageMetaOf(item, change);
  const volumeGood = volume >= 1_000_000 || rvol >= 3;
  const lowPriceBonus = price > 0 && price <= 8 ? 6 : 0;
  const sweetChange = change >= 4 && change <= 35 ? 20 : change > 35 && change <= 60 ? 6 : change > 60 ? -18 : change >= 1 ? 10 : 0;

  const scalpScore = clampScore(
    35
      + (vwapGood ? 20 : -18)
      + (trendGood ? 18 : -12)
      + (volumeGood ? 16 : -8)
      + sweetChange
      + (scanner >= 70 ? 10 : scanner >= 55 ? 5 : 0)
      + lowPriceBonus
      + setupBias.earlyBonus * 0.55
      - setupBias.riskPenalty * 0.65
      - stageMeta.changePenalty
  );

  const surgeScore = clampScore(
    scanner * 0.45
      + clampScore(change <= 45 ? Math.max(change, 0) : 85 - (change - 45) * 1.4, 0, 70) * 0.25
      + (sourceTags.some((tag) => String(tag).includes("news") || String(tag).includes("sec-8k")) ? 14 : 0)
      + (storyTags.length ? Math.min(storyTags.length * 5, 12) : 0)
      + (volume >= 10_000_000 ? 10 : volume >= 2_000_000 ? 6 : 0)
      + setupBias.earlyBonus * 0.35
      - setupBias.riskPenalty * 0.45
      - stageMeta.changePenalty
  );

  const setupScore = clampScore(
    40
      + (vwapGood ? 18 : -16)
      + (trendGood ? 12 : -10)
      + (change >= 5 && change <= 35 ? 18 : change > 35 && change <= 65 ? 7 : change > 65 ? -12 : 2)
      + (pattern >= 65 ? 10 : pattern >= 55 ? 5 : 0)
      + (volumeGood ? 10 : -5)
      - (risk >= 75 ? 12 : risk >= 60 ? 6 : 0)
      + setupBias.earlyBonus * 0.65
      - setupBias.riskPenalty * 0.75
      - stageMeta.changePenalty
  );

  const chaseRisk = clampScore(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
      + setupBias.riskPenalty * 0.8
  );
  const safetyScore = clampScore(100 - chaseRisk);
  const finalScore = Math.round(clampScore(
    scalpScore * 0.38
    + surgeScore * 0.27
    + setupScore * 0.25
    + safetyScore * 0.10
    + setupBias.earlyBonus * 0.2
    - setupBias.riskPenalty * 0.25
    - stageMeta.changePenalty * 0.35
  ));

  let verdict = "愿李??꾨낫";
  if (finalScore >= 78 && chaseRisk < 62) verdict = "理쒖슦???⑦? ?꾨낫";
  else if (finalScore >= 68 && chaseRisk < 75) verdict = "?곸쐞 媛먯떆 ?꾨낫";
  else if (chaseRisk >= 80) verdict = "怨쇱뿴 二쇱쓽 ?꾨낫";

  if (setupBias.overheated || setupBias.highFailed || setupBias.extremeRvolWeak || chaseRisk >= 82) verdict = "吏꾩엯 湲덉?";
  else if (finalScore >= 76 && setupBias.strongEarlySignal && chaseRisk < 68) verdict = "매수 가능";
  else verdict = "관찰";

  const reasons = [];
  const verdictReasonCodes = [];
  if (setupBias.overheated) verdictReasonCodes.push("overheated");
  if (setupBias.highFailed) verdictReasonCodes.push("highFailed");
  if (setupBias.extremeRvolWeak) verdictReasonCodes.push("extremeRvolWeak");
  if (chaseRisk >= 82) verdictReasonCodes.push("chaseRiskBlock");
  if (finalScore >= 76 && setupBias.strongEarlySignal && chaseRisk < 68) verdictReasonCodes.push("buyableSetup");
  else verdictReasonCodes.push("watchSetup");
  if (setupBias.strongEarlySignal) reasons.push("珥덉엯 ?뚮났 ?좏샇");
  if (setupBias.underDollarLowRvol) reasons.push("RVOL 3諛?誘몃쭔 媛뺣벑");
  if (setupBias.highFailed) reasons.push("怨좎젏 ?댄깉 ?꾪뿕");
  if (setupBias.overheated) reasons.push("怨쇱뿴 援ш컙");
  if (vwapGood) reasons.push("VWAP ??洹쇱쿂");
  if (trendGood) reasons.push("1遺?異붿꽭 ?곸듅");
  if (volumeGood) reasons.push("嫄곕옒???뺤씤");
  if (sourceTags.some((tag) => String(tag).includes("news") || String(tag).includes("sec-8k"))) reasons.push("?댁뒪/怨듭떆 珥됰컻");
  if (change > 65) reasons.push("?곸듅瑜?怨쇱뿴 二쇱쓽");
  if (chaseRisk >= 75) reasons.push("異붽꺽 由ъ뒪???믪쓬");

  const volumeQuality = computeVolumeQualityScore(item, price, volume, rvol);
  const surgeAcceleration = computeSurgeAccelerationScore(item);

  return {
    item,
    symbol: item.symbol,
    name: item.name ?? item.symbol,
    price,
    change,
    volume,
    rvol,
    vwap,
    trend,
    stageMeta,
    scalpScore: Math.round(scalpScore),
    surgeScore: Math.round(surgeScore),
    setupScore: Math.round(setupScore),
    chaseRisk: Math.round(chaseRisk),
    finalScore,
    verdict,
    verdictReasonCodes,
    setupBias,
    volumeQualityScore: volumeQuality.score,
    surgeAccelerationScore: surgeAcceleration.score,
    reasons: reasons.length ? reasons : ["媛寃?嫄곕옒??援ъ“ 媛먯떆"],
  };
}

function topPickScoreGrade(score) {
  const value = num(score) ?? 0;
  if (value >= 85) return "S등급";
  if (value >= 75) return "A등급";
  if (value >= 65) return "B등급";
  if (value >= 55) return "C등급";
  return "D등급";
}

function topPickScoreInterpretation(score) {
  const value = num(score) ?? 0;
  if (value >= 85) return { title: "최상위 후보", lines: ["강한 거래량, 추세, VWAP 조건 충족", "우선 검토"] };
  if (value >= 75) return { title: "유망 후보", lines: ["진입 가능성 높음", "관찰 우선순위 높음"] };
  if (value >= 65) return { title: "관찰 후보", lines: ["일부 조건 부족", "추가 확인 필요"] };
  if (value >= 55) return { title: "보조 후보", lines: ["신호 약함", "우선순위 낮음"] };
  return { title: "낮은 우선순위", lines: ["당장 진입 비추천"] };
}

function renderTopPickScoreInterpretation(score) {
  const interpretation = topPickScoreInterpretation(score);
  return '<div class="kbk-score-interpretation">'
    + '<h4>점수 해석</h4>'
    + '<strong>' + esc(interpretation.title) + '</strong>'
    + '<ul>' + interpretation.lines.map((line) => '<li>' + esc(line) + '</li>').join('') + '</ul>'
    + '</div>';
}

function enrichTopPickDecision(pick) {
  const item = pick?.item ?? {};
  const verdict = String(pick?.verdict ?? "愿李?");
  const preMarketChange = num(item?.preMarketChangePercent) ?? pick?.change ?? 0;
  const vwap = String(pick?.vwap ?? "");
  const vwapBelow = vwap.includes("?꾨옒") || vwap.toLowerCase().includes("below");
  const negativeSession = preMarketChange < 0 || (pick?.change ?? 0) < 0;
  const severeDrop = preMarketChange <= -8 || (pick?.change ?? 0) <= -8;
  const riskScore = num(item?.riskScore) ?? pick?.chaseRisk ?? 50;
  const accumulationScore = num(item?.scannerScore) ?? num(item?.finalProbabilityScore) ?? 50;
  const patternScore = num(item?.patternSimilarityScore) ?? 50;
  const elevatedRisk = riskScore >= 72 || (pick?.chaseRisk ?? 0) >= 72;
  const overheated = (pick?.change ?? 0) >= 45;
  const veryOverheated = (pick?.change ?? 0) >= 70;
  const volumeGood = (pick?.volume ?? 0) >= 1_000_000 || (pick?.rvol ?? 0) >= 1.5;
  const priceWeak = (pick?.change ?? 0) < 0 || pick?.trend !== "?곸듅";
  const volumeButWeak = volumeGood && priceWeak;

  let displayFinalScore = num(pick?.finalScore) ?? 0;
  if (negativeSession && vwapBelow) displayFinalScore -= severeDrop ? 22 : 14;
  if (elevatedRisk && (pick?.change ?? 0) >= 12) displayFinalScore -= 10;
  if (volumeButWeak) displayFinalScore -= 8;
  if (overheated) displayFinalScore -= veryOverheated ? 12 : 6;
  displayFinalScore = Math.round(clampScore(displayFinalScore));

  const volumeQuality = computeVolumeQualityScore(item, pick?.price ?? 0, pick?.volume ?? 0, pick?.rvol ?? 1);
  const surgeAcceleration = computeSurgeAccelerationScore(item);
  const explanation = buildTopPickExplainSections(item, pick, volumeQuality, surgeAcceleration);
  const reasons = [...explanation.existingReasons];
  if (volumeGood && !reasons.includes("嫄곕옒???뺤씤")) reasons.unshift("嫄곕옒???뺤씤");

  const cautions = [...explanation.cautions];
  if (preMarketChange < 0 && !cautions.some((line) => line.includes("?꾨━留덉폆"))) {
    cautions.push(`?꾨━留덉폆 ${pct(preMarketChange)}`);
  }
  if (volumeButWeak && !cautions.includes("嫄곕옒???鍮?媛寃??쎌꽭")) {
    cautions.push("嫄곕옒???鍮?媛寃??쎌꽭");
  }

  const vwapStateRaw = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const price = positiveNum(item?.price) ?? positiveNum(item?.preMarketPrice) ?? pick?.price ?? 0;
  const vwapNum = vwapValue(item);
  const vwapAbove = item?.aboveVwap === true || vwapStateRaw === "above"
    || (price > 0 && vwapNum !== null && price >= vwapNum);
  const vwapNear = !vwapAbove && price > 0 && vwapNum !== null && price >= vwapNum * 0.985;
  const vwapFarBelow = item?.aboveVwap === false || vwapStateRaw === "below"
    || (price > 0 && vwapNum !== null && price < vwapNum * 0.985);
  const setup = pick?.setupBias ?? {};
  const fd = finalDecision({
    item,
    setup: {
      ...setup,
      vwapAbove,
      vwapNear,
      vwapBelow: vwapFarBelow,
      vwapRecovering: vwapAbove || vwapNear,
    },
    topPickScore: pick?.finalScore ?? 0,
    volumeQualityScore: explanation.volumeQualityScore,
    surgeAccelerationScore: explanation.surgeAccelerationScore,
    chaseRisk: pick?.chaseRisk ?? 0,
    vwapLabel: vwap,
    vwapAbove,
    vwapNear,
    vwapFarBelow,
    rsi: setup.rsi,
    change: pick?.change ?? 0,
    higherLow: setup.higherLow,
  });

  return {
    ...pick,
    preMarketChange,
    verdict,
    displayFinalScore,
    finalDecision: fd,
    reasons: reasons.length ? reasons : ["媛寃?嫄곕옒??援ъ“ 媛먯떆"],
    selectionSections: explanation.sections,
    detailReasons: explanation.detailReasons,
    cautions: cautions.length ? cautions : ["?ㅼ젣 吏꾩엯 ??VWAP쨌泥닿껐 諛섏쓳???ㅼ떆 ?뺤씤?섏꽭??"],
    accumulationScore: Math.round(accumulationScore),
    patternScore: Math.round(patternScore),
    riskScore: Math.round(riskScore),
    volumeQualityScore: explanation.volumeQualityScore,
    surgeAccelerationScore: explanation.surgeAccelerationScore,
    baseFinalScore: num(pick?.baseFinalScore) ?? num(pick?.finalScore) ?? 0,
  };
}

function ensureTopPickStyles() {

  if (document.getElementById("kbk-top-picks-style")) return;
  const style = document.createElement("style");
  style.id = "kbk-top-picks-style";
  style.textContent = `
    #kbk-top-picks-panel{display:grid;gap:18px}
    .kbk-top-hero{background:linear-gradient(135deg,#102033,#0f766e);border-radius:28px;color:#f8fafc;padding:28px;display:grid;gap:12px;box-shadow:0 24px 60px rgba(15,23,42,.22)}
    .kbk-top-hero p{margin:0;color:rgba(248,250,252,.82);line-height:1.65}
    .kbk-top-hero h2{margin:0;font-size:clamp(1.8rem,3vw,2.8rem);letter-spacing:0}
    .kbk-top-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
    .kbk-top-card{background:rgba(255,255,255,.94);border:1px solid rgba(15,23,42,.12);border-radius:24px;padding:22px;box-shadow:0 18px 45px rgba(15,23,42,.12);cursor:pointer}
    .kbk-top-card:first-child{border:2px solid rgba(37,99,235,.42)}
    .kbk-top-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
    .kbk-top-head h3{margin:0;color:#0f172a;font-size:1.7rem}
    .kbk-top-head p{margin:8px 0 0;color:#475569}
    .kbk-top-score{font-size:3rem;font-weight:900;line-height:1;color:#0f172a;text-align:right;overflow-wrap:anywhere}
    .kbk-top-score small{display:block;font-size:.9rem;font-weight:900;color:#334155;margin-top:6px;line-height:1.2}
    .kbk-top-score span{display:block;font-size:.78rem;color:#fff;background:#2563eb;border-radius:999px;padding:7px 10px;margin-top:8px}
    .kbk-top-row{display:flex;flex-wrap:wrap;gap:12px;color:#334155;margin-top:14px}
    .kbk-top-row strong{color:#0f172a}
    .kbk-top-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}
    .kbk-top-metrics div{background:#f8fafc;border-radius:16px;padding:12px}
    .kbk-top-metrics span{display:block;color:#64748b;font-size:.8rem}
    .kbk-top-metrics b{display:block;color:#0f172a;margin-top:5px}
    .kbk-top-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
    .kbk-top-reasons span{background:#cffafe;color:#155e75;border-radius:999px;padding:7px 10px;font-size:.78rem;font-weight:700}
    .kbk-score-interpretation{margin-top:16px;background:#f8fafc;border:1px solid rgba(15,23,42,.08);border-radius:16px;padding:13px 14px;color:#334155;overflow-wrap:anywhere}
    .kbk-score-interpretation h4{margin:0 0 7px;color:#64748b;font-size:.78rem;font-weight:900}
    .kbk-score-interpretation strong{display:block;color:#0f172a;font-size:1rem;font-weight:900;line-height:1.35}
    .kbk-score-interpretation ul{margin:8px 0 0;padding-left:18px}
    .kbk-score-interpretation li{font-size:.84rem;line-height:1.45;font-weight:700}
    .kbk-top-explain{display:grid;gap:12px;margin-top:14px}
    .kbk-top-explain-block{background:#f8fafc;border:1px solid rgba(15,23,42,.08);border-radius:14px;padding:12px 14px}
    .kbk-top-explain-block h5{margin:0 0 8px;color:#0f172a;font-size:.9rem}
    .kbk-top-explain-block ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
    .kbk-top-explain-block li{color:#334155;font-size:.84rem;line-height:1.45;font-weight:700}
    .kbk-top-caution li{color:#b45309}
    .kbk-top-card.is-open{border-color:rgba(37,99,235,.38);box-shadow:0 22px 48px rgba(37,99,235,.16)}
    .kbk-top-toggle{margin-top:14px;color:#2563eb;font-size:.85rem;font-weight:700}
    .kbk-top-detail{margin-top:18px;padding-top:18px;border-top:1px solid rgba(15,23,42,.1)}
    .kbk-top-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .kbk-top-detail-section{background:#f8fafc;border-radius:16px;padding:14px 16px}
    .kbk-top-detail-section h4{margin:0 0 10px;color:#0f172a;font-size:.96rem}
    .kbk-top-detail-section ul{margin:0;padding-left:18px;color:#334155;line-height:1.55}
    .kbk-top-judgement{display:inline-flex;align-items:center;border-radius:999px;padding:8px 12px;font-weight:800}
    .kbk-top-judgement.buy{background:#dcfce7;color:#166534}
    .kbk-top-judgement.watch{background:#fef3c7;color:#92400e}
    .kbk-top-judgement.block{background:#fee2e2;color:#991b1b}
    .kbk-final-decision-hero{border-radius:16px;padding:16px 18px;margin-bottom:14px;border:2px solid rgba(15,23,42,.1)}
    .kbk-final-kicker{margin:0 0 6px;font-size:.78rem;font-weight:900;color:#64748b}
    .kbk-final-label{display:block;font-size:clamp(1.4rem,2.8vw,1.9rem);font-weight:950;line-height:1.15;margin:0 0 8px}
    .kbk-final-confidence{margin:0 0 12px;font-size:.9rem;font-weight:800;color:#334155}
    .kbk-final-confidence b{font-size:1.1rem}
    .kbk-final-reasons-title{margin:0 0 8px;font-size:.82rem;font-weight:900;color:#475569}
    .kbk-final-reasons ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
    .kbk-final-reasons li{font-size:.84rem;font-weight:800;line-height:1.4}
    .kbk-final-reasons li.ok{color:#166534}
    .kbk-final-reasons li.warn{color:#b45309}
    .kbk-final-buy{background:#ecfdf5;border-color:#86efac}
    .kbk-final-buy .kbk-final-label{color:#047857}
    .kbk-final-pullback{background:#fffbeb;border-color:#fcd34d}
    .kbk-final-pullback .kbk-final-label{color:#b45309}
    .kbk-final-watch{background:#f8fafc;border-color:#cbd5e1}
    .kbk-final-watch .kbk-final-label{color:#475569}
    .kbk-final-block{background:#fef2f2;border-color:#fca5a5}
    .kbk-final-block .kbk-final-label{color:#b91c1c}
    .kbk-top-note{background:#fff7ed;border:1px solid rgba(249,115,22,.22);border-radius:20px;color:#7c2d12;padding:16px 18px;line-height:1.65}
    .kbk-top-loading,.kbk-top-empty{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:20px;padding:22px;color:#334155}
    @media (max-width:1100px){.kbk-top-grid{grid-template-columns:1fr}.kbk-top-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.kbk-top-detail-grid{grid-template-columns:1fr}}
    @media (max-width:700px){.kbk-top-head{display:grid}.kbk-top-score{text-align:left}.kbk-top-metrics{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
}

function topPickPanel() {
  ensureTopPickStyles();
  const stack = document.querySelector(".page-stack");
  if (!stack) return null;
  let panel = document.getElementById("kbk-top-picks-panel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "kbk-top-picks-panel";
    stack.prepend(panel);
  }
  return panel;
}

function setTopPickMode(enabled) {
  const panel = topPickPanel();
  if (!panel) return;
  if (enabled && document.getElementById("kbk-pro-top-picks")?.querySelector(".kbk-pro-top-card")) {
    panel.hidden = true;
    panel.style.display = "none";
    return;
  }
  window.__kbkActiveCategoryKey = enabled ? "top-picks" : window.location.pathname || "default";
  document.querySelectorAll(".page-stack > .page-panel").forEach((section) => {
    section.style.display = enabled ? "none" : "";
  });
  panel.hidden = !enabled;
  document.querySelectorAll(".menu-link").forEach((link) => link.classList.remove("active"));
  document.getElementById("kbk-top-picks-menu")?.classList.toggle("active", enabled);
  if (enabled && !panel.dataset.loaded && !topPicksLoadPromise) loadTopPicks();
}

function renderTopPickLoading() {
  const panel = topPickPanel();
  if (!panel) return;
  panel.innerHTML = `
    <section class="kbk-top-hero">
      <p>Integrated Top Picks</p>
      <h2>???ㅼ틦?덈? ?⑹퀜 ?꾩옱 媛??愿쒖갖? 醫낅ぉ留?異붾┰?덈떎.</h2>
      <p>?⑦? ?쒓렇?? ??벑 媛먯떆, 留ㅼ쭛/吏꾩엯 ?곹빀?꾨? ?④퍡 蹂닿퀬 怨쇱뿴怨?異붽꺽 ?꾪뿕??媛먯젏?⑸땲??</p>
      <button type="button" class="kbk-page-refresh kbk-top-refresh" data-kbk-page-refresh>?덈줈怨좎묠</button>
    </section>
    <section class="kbk-top-loading">?듯빀 ?꾨낫瑜??ㅼ떆媛꾩쑝濡?怨꾩궛?섎뒗 以묒엯?덈떎.</section>
  `;
}

function renderTopPicks(picks, updatedAt) {
  const panel = topPickPanel();
  if (!panel) return;
  const enrichedPicks = picks.map(enrichTopPickDecision);
  const top = enrichedPicks[0];
  panel.dataset.loaded = "true";
  panel.innerHTML =
    '<section class="kbk-top-hero">'
    + '<p>Integrated Top Picks</p>'
    + '<h2>?듯빀 理쒖쥌 ?꾨낫</h2>'
    + '<p>?⑦? ?쒓렇?? ??벑 媛먯떆, 留ㅼ쭛 ?먯닔瑜??⑹튂怨?嫄곕옒?됀룹닔湲?媛?띉룰린???⑦꽩?쇰줈 ?좎젙 ?댁쑀瑜?蹂댁뿬以띾땲??</p>'
    + '<button type="button" class="kbk-page-refresh kbk-top-refresh" data-kbk-page-refresh>?덈줈怨좎묠</button>'
    + '</section>'
    + '<section class="kbk-top-note">'
    + (top ? ('?꾩옱 1?꾨뒗 ' + esc(top.symbol) + ' ?낅땲?? 移대뱶瑜??쇱튂硫?嫄곕옒???덉쭏쨌?섍툒 媛?띉룰린???⑦꽩?쇰줈 ???곸쐞?몄? ?뺤씤?????덉뒿?덈떎.') : '?꾩옱 ?듯빀 湲곗????듦낵???꾨낫媛 ?놁뒿?덈떎.')
    + '<br>??? ??: ' + (updatedAt ? new Date(updatedAt).toLocaleTimeString('ko-KR') : new Date().toLocaleTimeString('ko-KR'))
    + '</section>'
    + (enrichedPicks.length ? ('<section class="kbk-top-grid">' + enrichedPicks.map((pick, index) => {
      const displayScore = pick.displayFinalScore ?? pick.finalScore;
      const scoreGrade = topPickScoreGrade(displayScore);
      const verdictTone = pick.verdict === '留ㅼ닔 媛?? || pick.verdict === '理쒖슦???⑦? ?꾨낫' ? 'buy' : pick.verdict === '愿李? || pick.verdict === '?곸쐞 媛먯떆 ?꾨낫' ? 'watch' : 'block';
      return ''
        + '<article class="kbk-top-card" data-top-pick-card="' + esc(pick.symbol) + '" tabindex="0" role="button" aria-expanded="false">'
        +   renderFinalDecisionHeroHtml(pick.finalDecision, esc)
        +   '<div class="kbk-top-head">'
        +     '<div>'
        +       '<h3>' + esc(pick.symbol) + '</h3>'
        +       '<p>' + esc(pick.name) + '</p>'
        +     '</div>'
        +     '<div class="kbk-top-score">' + displayScore + '점 <small>(' + esc(scoreGrade) + ')</small><span>' + (index === 0 ? '1?? : esc(pick.verdict)) + '</span></div>'
        +   '</div>'
        +   '<div class="kbk-top-row">'
        +     '<strong>' + pricePairText(pick.displayPrice ?? pick.price) + '</strong>'
        +     '<span>' + pct(pick.displayChange ?? pick.change) + '</span>'
        +     '<span>' + displayVolumeText(pick.displayVolume) + '</span>'
        +     '<span>' + displayRelativeVolumeText(pick) + '</span>'
        +     '<span>' + esc(pick.vwap) + '</span>'
        +   '</div>'
        +   '<div class="kbk-top-metrics">'
        +     '<div><span>?⑦? ?먯닔</span><b>' + pick.scalpScore + '??/b></div>'
        +     '<div><span>??벑 ?먯닔</span><b>' + pick.surgeScore + '??/b></div>'
        +     '<div><span>嫄곕옒???덉쭏</span><b>' + (pick.volumeQualityScore ?? '-') + '??/b></div>'
        +     '<div><span>?섍툒 媛??/span><b>' + (pick.surgeAccelerationScore ?? '-') + '??/b></div>'
        +   '</div>'
        +   renderTopPickScoreInterpretation(displayScore)
        +   '<div class="kbk-top-reasons">' + pick.reasons.map((reason) => '<span>' + esc(reason) + '</span>').join('') + '</div>'
        +   '<div class="kbk-top-toggle">移대뱶瑜??뚮윭 ?좎젙 ?댁쑀쨌二쇱쓽 ?붿씤쨌理쒖쥌 ?먮떒???쇱튌 ???덉뒿?덈떎.</div>'
        +   '<div class="kbk-top-detail" hidden>'
        +     '<div class="kbk-top-detail-grid">'
        +       '<section class="kbk-top-detail-section" style="grid-column:1/-1">'
        +         '<h4>?좎젙 ?댁쑀</h4>'
        +         '<div class="kbk-top-explain">' + renderTopPickExplainHtml(pick) + '</div>'
        +         '<ul style="margin-top:12px">' + pick.detailReasons.map((reason) => '<li>' + esc(reason) + '</li>').join('') + '</ul>'
        +       '</section>'
        +       '<section class="kbk-top-detail-section kbk-top-caution">'
        +         '<h4>二쇱쓽 ?붿씤</h4>'
        +         '<ul>' + pick.cautions.map((reason) => '<li>??' + esc(reason) + '</li>').join('') + '</ul>'
        +       '</section>'
        +       '<section class="kbk-top-detail-section">'
        +         '<h4>理쒖쥌 ?먮떒</h4>'
        +         '<div class="kbk-top-judgement ' + verdictTone + '">' + esc(pick.verdict) + '</div>'
        +         '<ul>'
        +           '<li>통합 점수: ' + (pick.displayFinalScore ?? pick.finalScore) + '점</li>'
        +           '<li>기본 점수: ' + pick.baseFinalScore + '점</li>'
        +           '<li>추격 위험: ' + pick.chaseRisk + '점</li>'
        +           '<li>단타 시그널: ' + esc(pick.finalDecision?.scalpAction ?? '-') + '</li>'
        +         '</ul>'
        +       '</section>'
        +     '</div>'
        +   '</div>'
        + '</article>';
    }).join('') + '</section>') : '<section class="kbk-top-empty">吏湲??듯빀 湲곗????듦낵???꾨낫媛 ?놁뒿?덈떎. ?좎떆 ???ㅼ떆 ?뺤씤??二쇱꽭??</section>');
  bindTopPickCardDetails(panel);
}

function bindTopPickCardDetails(panel) {
  panel.querySelectorAll('[data-top-pick-card]').forEach((card) => {
    const toggle = () => {
      const detail = card.querySelector('.kbk-top-detail');
      if (!detail) return;
      const nextOpen = detail.hidden;
      panel.querySelectorAll('[data-top-pick-card]').forEach((other) => {
        other.classList.remove('is-open');
        other.setAttribute('aria-expanded', 'false');
        const otherDetail = other.querySelector('.kbk-top-detail');
        if (otherDetail) otherDetail.hidden = true;
      });
      detail.hidden = !nextOpen;
      card.classList.toggle('is-open', nextOpen);
      card.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    };
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
  });
}

function priceUsdText(value) {

  return usdText(value);
}

let topPicksLoadPromise = null;
let topPicksRenderToken = 0;
let topPicksLastStartedAt = 0;

function isTopPicksActive() {
  return window.location.pathname === "/top-picks" || window.location.hash === "#top-picks";
}

function topPicksFromPayload(payload) {
  const raw = Array.isArray(payload?.data?.topPicks)
    ? payload.data.topPicks
    : Array.isArray(payload?.topPicks)
      ? payload.topPicks
      : [];
  if (raw.length > 0) {
    const safe = raw.filter((item) => item?.isChasingRisk !== true && item?.isOverheated !== true);
    const risky = raw.filter((item) => item?.isChasingRisk === true || item?.isOverheated === true);
    return [...safe, ...risky].slice(0, 20);
  }
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : Array.isArray(payload?.items) ? payload.items : [];
  return items
    .filter((item) => item?.symbol && item.included !== false)
    .sort((a, b) => (num(b.marketPrioritySortScore) ?? num(b.finalSelectionScore) ?? 0) - (num(a.marketPrioritySortScore) ?? num(a.finalSelectionScore) ?? 0))
    .slice(0, 20);
}

async function loadTopPicks() {
  if (typeof window.__kbkRenderTopPicksOnly === "function") {
    return null;
  }
  if (document.getElementById("kbk-pro-top-picks")?.querySelector(".kbk-pro-top-card")) {
    return null;
  }
  const panel = topPickPanel();
  if (!panel) return null;
  const startedAt = Date.now();
  if (topPicksLoadPromise && startedAt - topPicksLastStartedAt < 1200) {
    return topPicksLoadPromise;
  }
  topPicksLastStartedAt = startedAt;
  const renderToken = ++topPicksRenderToken;
  renderTopPickLoading();
  topPicksLoadPromise = (async () => {
    const [payload, exchangePayload] = await Promise.all([
      fetchJson("/api/scanner"),
      fetchJson("/api/exchange").catch(() => null),
    ]);
    usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
    const items = topPicksFromPayload(payload);
    const rankPicks = (a, b) => (a.stageMeta?.isChasingRisk ? 1 : 0) - (b.stageMeta?.isChasingRisk ? 1 : 0)
      || (a.stageMeta?.isOverheated ? 1 : 0) - (b.stageMeta?.isOverheated ? 1 : 0)
      || (b.setupBias?.strongEarlySignal ? 1 : 0) - (a.setupBias?.strongEarlySignal ? 1 : 0)
      || b.finalScore - a.finalScore
      || a.chaseRisk - b.chaseRisk;
    const scored = items
      .filter((item) => item?.symbol && item.included !== false)
      .map(scoreTopPick)
      .filter((pick) => pick.change >= 3)
      .filter((pick) => pick.vwap.includes("위") || pick.vwap.includes("근처"))
      .filter((pick) => pick.trend === "?곸듅")
      .filter((pick) => pick.volume >= 500_000 || pick.rvol >= 3)
      .filter((pick) => !pick.setupBias?.underDollarLowRvol || pick.setupBias?.strongEarlySignal)
      .filter((pick) => pick.chaseRisk < 85)
      .filter((pick) => pick.finalScore >= 62 || pick.scalpScore >= 72 || pick.surgeScore >= 72)
      .sort(rankPicks)
      .slice(0, 20);
    if (scored.length < 20) {
      const seen = new Set(scored.map((pick) => pick.symbol));
      const supplemental = items
        .filter((item) => item?.symbol && item.included !== false)
        .map(scoreTopPick)
        .filter((pick) => pick.change >= 3)
        .filter((pick) => !seen.has(pick.symbol))
        .filter((pick) => pick.volume >= 300_000 || pick.rvol >= 3 || pick.setupBias?.strongEarlySignal)
        .filter((pick) => !pick.setupBias?.underDollarLowRvol || pick.setupBias?.strongEarlySignal)
        .filter((pick) => pick.chaseRisk < 92)
        .sort(rankPicks);
      scored.push(...supplemental.slice(0, 20 - scored.length));
      scored.sort(rankPicks);
    }
    if (!isTopPicksActive() || renderToken !== topPicksRenderToken) return;
    const hydrated = await hydrateTopPicksWithLatestQuotes(scored.slice(0, 20));
    if (!isTopPicksActive() || renderToken !== topPicksRenderToken) return;
    renderTopPicks(hydrated, payload?.data?.updatedAt ?? payload?.updatedAt);
  })().catch((error) => {
    if (!isTopPicksActive() || renderToken !== topPicksRenderToken) return;
    const activePanel = topPickPanel();
    if (activePanel) activePanel.innerHTML = `<section class="kbk-top-empty">?듯빀 ?꾨낫 怨꾩궛 ?ㅽ뙣: ${esc(error.message)}</section>`;
  }).finally(() => {
    if (renderToken === topPicksRenderToken) {
      topPicksLoadPromise = null;
    }
  });
  return topPicksLoadPromise;
}

function syncTopPicksMenu() {
  const menu = document.querySelector(".menu-bar");
  if (menu && !document.getElementById("kbk-top-picks-menu")) {
    const button = document.createElement("button");
    button.id = "kbk-top-picks-menu";
    button.type = "button";
    button.className = "menu-link menu-button";
    button.textContent = "?듯빀 理쒖쥌 ?꾨낫";
    button.addEventListener("click", () => {
      if (isTopPicksActive() && topPicksLoadPromise) return;
      window.location.hash = "top-picks";
      if (typeof window.__kbkRenderTopPicksOnly === "function") {
        window.__kbkRenderTopPicksOnly();
        return;
      }
      setTopPickMode(true);
    });
    menu.appendChild(button);
  }
  if (typeof window.__kbkRenderTopPicksOnly === "function" && isTopPicksActive()) {
    const panel = document.getElementById("kbk-top-picks-panel");
    if (panel) {
      panel.hidden = true;
      panel.style.display = "none";
    }
    return;
  }
  setTopPickMode(window.location.hash === "#top-picks");
}

window.addEventListener("hashchange", syncTopPicksMenu);
function retryTopPicksMenu(attempts = 0) {
  syncTopPicksMenu();
  if (!document.getElementById("kbk-top-picks-menu") && attempts < 12) {
    window.setTimeout(() => retryTopPicksMenu(attempts + 1), 250);
  }
}
window.addEventListener("DOMContentLoaded", () => window.setTimeout(retryTopPicksMenu, 200));

let surgeLiveQuoteBusy = false;
let surgeLiveExchangeAt = 0;

function ensureSurgeLiveStyles() {
  if (document.getElementById("kbk-surge-live-style")) return;
  const style = document.createElement("style");
  style.id = "kbk-surge-live-style";
  style.textContent = `
    .kbk-live-quote-stamp{color:#1d4ed8;background:#dbeafe;border:1px solid rgba(37,99,235,.22);border-radius:999px;display:inline-flex;align-items:center;padding:5px 9px;font-size:.74rem;font-weight:800}
    .kbk-live-quote-updated{outline:2px solid rgba(37,99,235,.16)}
  `;
  document.head.appendChild(style);
}

function isSurgeWatchPage() {
  return window.location.pathname.includes("/scanner/surge-watch") || window.location.pathname.includes("/surge-watch");
}

function isSegmentedSurgeWatchPage() {
  const path = window.location.pathname;
  return path.includes("/scanner/surge-watch-under-1")
    || path.includes("/surge-watch-under-1")
    || path.includes("/scanner/surge-watch-over-1")
    || path.includes("/surge-watch-over-1");
}

function visibleSurgeCards() {
  if (!isSurgeWatchPage()) return [];
  return Array.from(document.querySelectorAll(".stock-card")).filter((card) => {
    const page = card.closest(".page-panel");
    return page && !page.classList.contains("hidden-panel") && card.querySelector("h3");
  });
}

function krwTextFromUsd(price) {
  return krwText(price);
}

function surgeRvolText(quote, volume) {
  const volumeSource = quote?.volumeSource;
  if (!hasConfirmedVolume({ volume, volumeSource })) return "상대거래량 미확인";
  const quoteRvol = num(quote?.relativeVolume) ?? num(quote?.volumeRatio);
  return quoteRvol !== null && quoteRvol > 0 ? `상대거래량 ${quoteRvol.toFixed(1)}배` : "상대거래량 미확인";
}

function updateSurgeCardQuote(card, quote, livePrice = null) {
  const priceRow = card.querySelector(".price-row");
  if (!priceRow) return;
  const price = num(livePrice) ?? priceUsd(quote);
  const change = mainChangePct(quote, price) ?? changePct(quote);
  if (isSegmentedSurgeWatchPage() && change !== null && change < 0) return;
  const volume = num(quote?.volume);
  const volumeSource = quote?.volumeSource;
  const confirmedVolume = hasConfirmedVolume({ volume, volumeSource }) ? volume : null;
  const vwap = vwapState(quote);
  const strong = priceRow.querySelector("strong");
  const spans = Array.from(priceRow.querySelectorAll("span"));

  if (strong) strong.textContent = krwTextFromUsd(price);
  if (spans[0]) spans[0].textContent = pct(change);
  if (spans[1]) spans[1].textContent = surgeRvolText(quote, volume);
  if (spans[2]) spans[2].textContent = displayVolumeText(confirmedVolume);
  if (spans[3]) spans[3].textContent = vwap;

  let stamp = priceRow.querySelector(".kbk-live-quote-stamp");
  if (!stamp) {
    stamp = document.createElement("span");
    stamp.className = "kbk-live-quote-stamp";
    priceRow.appendChild(stamp);
  }
  stamp.textContent = `?ㅼ떆媛?${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  card.classList.add("kbk-live-quote-updated");
}

async function refreshSurgeLiveQuotes() {
  if (surgeLiveQuoteBusy || !isSurgeWatchPage()) return;
  const cards = visibleSurgeCards().slice(0, 24);
  if (!cards.length) return;
  surgeLiveQuoteBusy = true;
  try {
    if (Date.now() - surgeLiveExchangeAt > 60_000) {
      const exchangePayload = await fetchJson("/api/exchange").catch(() => null);
      usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
      surgeLiveExchangeAt = Date.now();
    }
    const unique = [...new Set(cards.map((card) => card.querySelector("h3")?.textContent?.trim()).filter(Boolean))];
    const results = await Promise.allSettled(unique.map(async (symbol) => {
      const payload = await fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
      const quote = payload.data ?? payload;
      const livePrice = await fetchLatestHistoryPrice(symbol).catch(() => null);
      return [symbol, { quote, livePrice }];
    }));
    const quoteMap = new Map(results.filter((result) => result.status === "fulfilled").map((result) => result.value));
    for (const card of cards) {
      const symbol = card.querySelector("h3")?.textContent?.trim();
      const data = quoteMap.get(symbol);
      if (data?.quote) updateSurgeCardQuote(card, data.quote, data.livePrice);
    }
    if (selectedSymbol && quoteMap.has(selectedSymbol)) refreshDetail(selectedSymbol, false);
  } finally {
    surgeLiveQuoteBusy = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  ensureSurgeLiveStyles();
  window.setTimeout(refreshSurgeLiveQuotes, 1200);
});

let scalpLivePriceBusy = false;
let scalpLiveExchangeAt = 0;

function isScalpScannerPage() {
  return !window.location.pathname.includes("/scanner/")
    && !window.location.pathname.includes("/surge-watch")
    && !window.location.pathname.includes("/accumulation")
    && window.location.hash !== "#top-picks";
}

function selectedScalpSymbol() {
  const summary = document.getElementById("monitor-summary")?.textContent ?? "";
  const summaryMatch = summary.match(/\b[A-Z][A-Z0-9.-]{0,11}\b/);
  if (summaryMatch && !["USD", "KRW", "VWAP", "RVOL"].includes(summaryMatch[0])) return summaryMatch[0];

  const activeRow = Array.from(document.querySelectorAll("#candidate-list [data-symbol]"))
    .find((row) => row.classList.contains("selected") || row.getAttribute("aria-selected") === "true");
  if (activeRow?.dataset?.symbol) return activeRow.dataset.symbol;

  const input = document.getElementById("ticker-input")?.value?.trim().toUpperCase();
  if (input) return input;

  return document.querySelector("#candidate-list [data-symbol]")?.dataset?.symbol ?? null;
}

function latestHistoryClose(payload) {
  const bars = normalizeBars(payload);
  return bars.at(-1)?.close ?? null;
}

async function fetchLatestHistoryPrice(symbol) {
  const from = encodeURIComponent(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
  const payload = await fetchJson(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${from}`);
  return latestHistoryClose(payload);
}

function updateScalpCandidateRow(symbol, price) {
  const row = Array.from(document.querySelectorAll("#candidate-list [data-symbol]"))
    .find((candidate) => candidate.dataset.symbol === symbol);
  if (!row || price === null) return;
  if (row.children?.[2]) row.children[2].textContent = krwTextFromUsd(price);
  row.classList.add("kbk-live-quote-updated");
}

function updateScalpMonitorPrice(symbol, price) {
  const monitor = document.getElementById("monitor-panel");
  if (!monitor || price === null) return;

  const metricBoxes = Array.from(monitor.querySelectorAll("div"));
  for (const box of metricBoxes) {
    const label = box.querySelector("span")?.textContent?.trim();
    if (label === "?꾩옱媛") {
      const target = box.querySelector("strong,b");
      if (target) target.textContent = krwTextFromUsd(price);
    }
  }

  const summary = document.getElementById("monitor-summary");
  let badge = document.getElementById("kbk-scalp-live-price");
  if (!badge && summary) {
    badge = document.createElement("span");
    badge.id = "kbk-scalp-live-price";
    badge.className = "kbk-live-quote-stamp";
    summary.insertAdjacentElement("afterend", badge);
  }
  if (badge) {
    const time = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    badge.textContent = `실시간 분봉 ${krwTextFromUsd(price)} · ${time}`;
  }
}

async function refreshScalpLivePrices() {
  if (scalpLivePriceBusy || !isScalpScannerPage()) return;

  const selected = selectedScalpSymbol();
  const rowSymbols = Array.from(document.querySelectorAll("#candidate-list [data-symbol]"))
    .slice(0, 12)
    .map((row) => row.dataset.symbol)
    .filter(Boolean);
  const symbols = [...new Set([selected, ...rowSymbols].filter(Boolean))];
  if (!symbols.length) return;

  scalpLivePriceBusy = true;
  try {
    ensureSurgeLiveStyles();
    if (Date.now() - scalpLiveExchangeAt > 60_000) {
      const exchangePayload = await fetchJson("/api/exchange").catch(() => null);
      usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
      scalpLiveExchangeAt = Date.now();
    }

    const results = await Promise.allSettled(symbols.map(async (symbol) => {
      const price = await fetchLatestHistoryPrice(symbol);
      return [symbol, price];
    }));
    const priceMap = new Map(results
      .filter((result) => result.status === "fulfilled" && result.value[1] !== null)
      .map((result) => result.value));

    for (const [symbol, price] of priceMap) updateScalpCandidateRow(symbol, price);
    const current = selectedScalpSymbol();
    if (current && priceMap.has(current)) updateScalpMonitorPrice(current, priceMap.get(current));
  } finally {
    scalpLivePriceBusy = false;
  }
}

window.addEventListener("DOMContentLoaded", () => window.setTimeout(refreshScalpLivePrices, 1600));

function isAccumulationPage() {
  return window.location.pathname.includes("/scanner/accumulation") || window.location.pathname.includes("/accumulation");
}

function refreshCurrentScannerView() {
  if (window.location.hash === "#top-picks") {
    loadTopPicks();
    return;
  }
  if (isScalpScannerPage()) {
    document.getElementById("refresh-btn")?.click();
    window.setTimeout(refreshScalpLivePrices, 1400);
    return;
  }
  if (isSurgeWatchPage() || isAccumulationPage()) {
    window.location.reload();
  }
}

function ensurePageRefreshStyles() {
  if (document.getElementById("kbk-page-refresh-style")) return;
  const style = document.createElement("style");
  style.id = "kbk-page-refresh-style";
  style.textContent = `
    .kbk-page-refresh{border:1px solid rgba(37,99,235,.24);background:#2563eb;color:#fff;border-radius:14px;padding:10px 14px;font-weight:800;cursor:pointer;box-shadow:0 10px 24px rgba(37,99,235,.18)}
    .kbk-page-refresh:hover{background:#1d4ed8}
    .kbk-top-refresh{justify-self:start;margin-top:6px;background:#f8fafc;color:#0f172a;border-color:rgba(255,255,255,.45)}
    .kbk-top-refresh:hover{background:#e0f2fe;color:#0f172a}
    .header-actions .kbk-page-refresh{border-radius:12px;padding:9px 12px}
    .toolbar .kbk-page-refresh{align-self:end;min-height:46px}
  `;
  document.head.appendChild(style);
}

function makePageRefreshButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "kbk-page-refresh";
  button.dataset.kbkPageRefresh = "true";
  button.textContent = "?덈줈怨좎묠";
  return button;
}

function ensurePageRefreshButton() {
  ensurePageRefreshStyles();
  document.querySelectorAll(".kbk-screen-refresh").forEach((button) => button.remove());
  if (window.location.hash === "#top-picks") return;

  const host = isScalpScannerPage()
    ? document.querySelector(".legacy-host .header-actions")
    : document.querySelector(".page-panel:not(.hidden-panel) .toolbar")
      ?? document.querySelector(".page-panel:not(.hidden-panel) .accumulation-hero");
  if (!host) return;

  const button = makePageRefreshButton();
  button.classList.add("kbk-screen-refresh");
  host.appendChild(button);
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-kbk-page-refresh]")) return;
  refreshCurrentScannerView();
});

window.addEventListener("DOMContentLoaded", () => {
  for (let i = 1; i <= 10; i += 1) {
    window.setTimeout(ensurePageRefreshButton, i * 250);
  }
});
window.addEventListener("hashchange", () => window.setTimeout(ensurePageRefreshButton, 100));
window.addEventListener("popstate", () => window.setTimeout(ensurePageRefreshButton, 100));
document.addEventListener("click", () => window.setTimeout(ensurePageRefreshButton, 150));
