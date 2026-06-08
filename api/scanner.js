const quoteHandler = require("./quote");
const historyHandler = require("./history");
const ENRICH_SYMBOL_LIMIT = 30;

function formatScannerDetails(details = {}) {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function logScannerElapsed(step, elapsedMs, details = {}) {
  const detailText = formatScannerDetails(details);
  console.log(`[SCANNER] ${step} ${elapsedMs}ms${detailText ? ` ${detailText}` : ""}`);
}

function logScannerStep(step, startedAt, details = {}) {
  logScannerElapsed(step, Date.now() - startedAt, details);
}

function makeRequestId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function headerValue(headers, name) {
  if (!headers) return "";
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || "";
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function changePercentFromPreviousClose(price, previousClose) {
  const current = num(price);
  const prev = num(previousClose);
  if (current === null || prev === null || prev <= 0) return null;
  return ((current - prev) / prev) * 100;
}

function volumeStrength(item) {
  if (!isTrustedCurrentVolumeSource(item.volumeSource)) return 18;
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

function volumeQualityScore(item) {
  const trustedVolume = isTrustedCurrentVolumeSource(item.volumeSource);
  const rawVolume = Math.max(num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const relativeVolume = num(item.relativeVolume) ?? num(item.volumeRatio);
  const priceUsd = num(item.price) ?? num(item.preMarketPrice) ?? num(item.regularMarketPrice);
  const priceKrw = num(item.priceKrw);
  const usdKrw = num(item.usdKrw) ?? num(item.exchangeRate) ?? 1350;
  const tradeValueKrw = num(item.tradeValueKrw)
    ?? num(item.tradingValueKrw)
    ?? num(item.amountKrw)
    ?? num(item.dollarVolumeKrw)
    ?? (priceKrw !== null && rawVolume ? priceKrw * rawVolume : null)
    ?? (priceUsd !== null && rawVolume ? priceUsd * rawVolume * usdKrw : null);

  let score = trustedVolume ? 50 : 20;
  if (!trustedVolume) {
    return {
      score: Math.round(clamp(score)),
      tradeValueKrw: null,
    };
  }
  if ((relativeVolume ?? 0) >= 3 && rawVolume < 100_000) score -= 25;
  else if (rawVolume > 0 && rawVolume < 100_000) score -= 12;

  if (tradeValueKrw !== null) {
    if ((relativeVolume ?? 0) >= 3 && tradeValueKrw < 100_000_000) score -= 25;
    else if (tradeValueKrw < 100_000_000) score -= 12;
  }

  if (rawVolume >= 5_000_000) score += 24;
  else if (rawVolume >= 1_000_000) score += 14;
  else if (rawVolume >= 500_000) score += 8;
  else if (rawVolume >= 100_000) score += 4;

  if (tradeValueKrw !== null) {
    if (tradeValueKrw >= 1_000_000_000) score += 24;
    else if (tradeValueKrw >= 500_000_000) score += 15;
    else if (tradeValueKrw >= 100_000_000) score += 8;
  }

  return {
    score: Math.round(clamp(score)),
    tradeValueKrw: tradeValueKrw !== null ? Math.round(tradeValueKrw) : null,
  };
}

function computeEarlyMomentumBonus(item, quality = {}, surgeAcceleration = {}, liveQuote = {}, commonSignals = {}) {
  const changePercent = num(liveQuote.changePercent) ?? num(item.changePercent) ?? num(item.preMarketChangePercent) ?? 0;
  if (changePercent < 10 || changePercent > 40) return 0;

  const rvol = num(liveQuote.relativeVolume) ?? num(liveQuote.volumeRatio) ?? num(item.relativeVolume) ?? num(item.volumeRatio) ?? 0;
  const rawVolume = Math.max(num(liveQuote.volume) ?? 0, num(item.volume) ?? 0, num(item.preMarketVolume) ?? 0);
  const tradeValueKrw = num(quality.tradeValueKrw);
  const vwapState = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const vwap = num(item?.technical?.vwap ?? item?.vwap);
  const price = num(liveQuote.price) ?? num(item.price) ?? num(item.preMarketPrice) ?? num(item.regularMarketPrice) ?? 0;
  const vwapAbove = liveQuote.aboveVwap === true || item.aboveVwap === true || vwapState === "above" || ((num(commonSignals.vwapHoldMinutes) ?? 0) > 0) || (price > 0 && vwap > 0 && price >= vwap);
  const vwapNear = !vwapAbove && (vwapState === "near" || ((num(commonSignals.vwapReclaimScore) ?? 0) >= 58) || (price > 0 && vwap > 0 && price >= vwap * 0.985));
  const surgeScore = num(surgeAcceleration.surgeAccelerationScore) ?? 0;

  let bonus = 0;
  if (rvol >= 5) bonus += 2;
  else if (rvol >= 3) bonus += 1;
  if (vwapAbove || vwapNear) bonus += 2;
  if (surgeScore >= 72) bonus += 2;
  else if (surgeScore >= 58) bonus += 1;
  if ((tradeValueKrw !== null && tradeValueKrw >= 1_000_000_000) || rawVolume >= 5_000_000) bonus += 2;
  else if ((tradeValueKrw !== null && tradeValueKrw >= 300_000_000) || rawVolume >= 1_000_000) bonus += 1;
  if (changePercent >= 10 && changePercent <= 25) bonus += 1;

  return Math.max(0, Math.min(8, Math.round(bonus)));
}

function computeLiquidityMomentumBonus(item, quality = {}, surgeAcceleration = {}) {
  const qualityScore = num(quality.score) ?? 0;
  const surgeScore = num(surgeAcceleration.surgeAccelerationScore) ?? 0;
  const rvol = num(item.relativeVolume) ?? num(item.volumeRatio) ?? 0;
  let bonus = 0;
  if (qualityScore >= 80) bonus += 4;
  else if (qualityScore >= 68) bonus += 3;
  else if (qualityScore >= 58) bonus += 2;
  if (surgeScore >= 72) bonus += 2;
  else if (surgeScore >= 58) bonus += 1;
  if (rvol >= 5) bonus += 1;
  return Math.max(0, Math.min(6, Math.round(bonus)));
}

function computeForbiddenPenalty(verdict, chaseRisk = null) {
  const label = String(verdict ?? "");
  const risk = num(chaseRisk) ?? 0;
  if (label.includes("진입 금지") || label.includes("매매 금지") || label.includes("추격 금지") || label.includes("위험 과다")) {
    return risk >= 90 ? 18 : 14;
  }
  if (label.includes("금지")) return 12;
  return 0;
}

function average(values) {
  const clean = values.map(num).filter((value) => value !== null && value > 0);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function sum(values) {
  return values.map(num).filter((value) => value !== null && value > 0).reduce((total, value) => total + value, 0);
}

function positive(value) {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function pctFromBasis(price, basis) {
  const current = num(price);
  const base = num(basis);
  if (current === null || base === null || base <= 0) return null;
  return ((current - base) / base) * 100;
}

function isTrustedCurrentVolumeSource(source) {
  const text = String(source || "").toLowerCase();
  return text.includes("premarketvolume")
    || text.includes("postmarketvolume")
    || text.includes("regularmarketvolume")
    || text.includes("kis-tvol")
    || text.includes("kis-evol");
}

function sessionLabel(sessionType) {
  if (sessionType === "PRE") return "premarket";
  if (sessionType === "REGULAR") return "regular";
  if (sessionType === "AFTER") return "afterhours";
  if (sessionType === "DAY") return "daymarket";
  return "unknown";
}

function confidenceLabel(value) {
  if (value === "high") return "높음";
  if (value === "medium") return "보통";
  return "낮음";
}

function getKstParts(date) {
  const shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function getSessionType(date) {
  const parts = getKstParts(date);
  const totalMinutes = parts.hour * 60 + parts.minute;
  if (totalMinutes >= 9 * 60 && totalMinutes < 17 * 60) return "DAY";
  if (totalMinutes >= 17 * 60 && totalMinutes < 22 * 60 + 30) return "PRE";
  if (totalMinutes >= 22 * 60 + 30 || totalMinutes < 5 * 60) return "REGULAR";
  return "AFTER";
}

function barAmount(bar) {
  return positive(bar?.tradeAmount) ?? positive(bar?.amount);
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== null && value !== undefined),
  );
}

async function invokeLocalHandler(handler, path, headers = {}) {
  let statusCode = 200;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const req = { url: path, method: "GET", headers };
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      if (!settled) {
        settled = true;
        resolveResult({ statusCode, headers: this.headers, body });
      }
      return this;
    },
  };

  Promise.resolve(handler(req, res))
    .then((body) => {
      if (!settled) {
        settled = true;
        resolveResult({ statusCode, headers: res.headers, body });
      }
    })
    .catch((error) => {
      if (!settled) {
        settled = true;
        rejectResult(error);
      }
    });

  return resultPromise;
}

async function fetchLocalQuoteSnapshot(symbol, requestId) {
  if (!symbol) return {};
  try {
    const result = await invokeLocalHandler(
      quoteHandler,
      `/api/quote?symbol=${encodeURIComponent(symbol)}`,
      { "x-kis-caller": "scanner", "x-request-id": requestId },
    );
    if (result?.statusCode !== 200 || result?.body?.ok !== true || !result?.body?.data) return {};
    return result.body.data;
  } catch {
    return {};
  }
}

async function fetchLocalHistorySnapshot(symbol, interval = "1m", requestId) {
  if (!symbol) return {};
  try {
    const result = await invokeLocalHandler(
      historyHandler,
      `/api/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`,
      { "x-kis-caller": "scanner", "x-request-id": requestId },
    );
    if (result?.statusCode !== 200 || result?.body?.ok !== true || !result?.body?.data) return {};
    return result.body.data;
  } catch {
    return {};
  }
}

function volumeAccelerationScoreFromRatio(ratio) {
  const value = num(ratio);
  if (value === null) return 50;
  if (value >= 5) return 96;
  if (value >= 3) return 84;
  if (value >= 2) return 72;
  if (value >= 1.3) return 60;
  if (value >= 0.8) return 50;
  return 38;
}

function calculateVolumeAcceleration(bars, source = null) {
  const volumes = bars.map((bar) => positive(bar.volume));
  const current1mVolume = volumes.at(-1) ?? null;
  const previous5 = volumes.slice(-6, -1).filter((value) => value !== null);
  const last5 = volumes.slice(-5).filter((value) => value !== null);
  const previous30 = volumes.slice(-35, -5).filter((value) => value !== null);
  const averageVolumeLast5m = previous5.length >= 5 ? average(previous5) : null;
  const averageVolumeLast30m = previous30.length >= 20 ? sum(previous30) / 6 : null;
  const volumeLast5m = last5.length >= 5 ? sum(last5) : null;
  const volumeAcceleration1m = current1mVolume !== null && averageVolumeLast5m ? current1mVolume / averageVolumeLast5m : null;
  const volumeAcceleration5m = volumeLast5m !== null && averageVolumeLast30m ? volumeLast5m / averageVolumeLast30m : null;
  const availableScores = [volumeAcceleration1m, volumeAcceleration5m]
    .filter((value) => num(value) !== null)
    .map(volumeAccelerationScoreFromRatio);

  return {
    averageVolumeLast5m,
    averageVolumeLast30m,
    volumeAcceleration1m,
    volumeAcceleration5m,
    volumeAccelerationScore: availableScores.length ? Math.round(average(availableScores)) : 50,
    volumeAccelerationSource: source,
    volumeAccelerationStatus: availableScores.length ? "ok" : "데이터 부족",
  };
}

function calculateSurgeAccelerationScore(bars, item = {}, liveQuote = {}, commonSignals = {}) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return {
      surgeAccelerationScore: 0,
      volumeAcceleration5mWindow: null,
      tradeValueAcceleration5mWindow: null,
    };
  }

  const windowStats = (items) => {
    const clean = items
      .map((bar) => ({
        close: positive(bar.close),
        volume: positive(bar.volume),
      }))
      .filter((bar) => bar.close !== null && bar.volume !== null);
    if (clean.length < 5) return { volume: null, tradeValue: null };
    return {
      volume: sum(clean.map((bar) => bar.volume)),
      tradeValue: sum(clean.map((bar) => bar.close * bar.volume)),
    };
  };
  const current = windowStats(bars.slice(-5));
  const prior = windowStats(bars.slice(-20, -15));
  const minVolumeDenominator = 10_000;
  const minTradeValueDenominator = 10_000;
  const volumeAcceleration5mWindow = current.volume !== null && prior.volume !== null && prior.volume >= minVolumeDenominator
    ? current.volume / prior.volume
    : null;
  const tradeValueAcceleration5mWindow = current.tradeValue !== null && prior.tradeValue !== null && prior.tradeValue >= minTradeValueDenominator
    ? current.tradeValue / prior.tradeValue
    : null;
  const accelerationPoints = (value) => {
    if (value === null) return 0;
    if (value >= 5) return 35;
    if (value >= 3) return 25;
    if (value >= 2) return 15;
    if (value >= 1.3) return 8;
    return 0;
  };

  const relativeVolume = num(liveQuote.relativeVolume) ?? num(liveQuote.volumeRatio) ?? num(item.relativeVolume) ?? num(item.volumeRatio);
  const aboveVwap = liveQuote.aboveVwap === true || item.aboveVwap === true || (num(commonSignals.vwapHoldMinutes) ?? 0) > 0 || (num(commonSignals.vwapReclaimScore) ?? 0) >= 58;
  const higherLow = (num(commonSignals.higherLowScore) ?? num(item.higherLowScore) ?? 50) >= 58;
  const trendText = String(liveQuote.oneMinuteTrend || item.oneMinuteTrend || item.technical?.oneMinuteTrend || "").toLowerCase();
  const oneMinuteUp = trendText.includes("up") || trendText.includes("상승");
  const changePercent = num(liveQuote.changePercent) ?? num(item.changePercent) ?? num(item.preMarketChangePercent);
  const rsi = num(liveQuote.rsi) ?? num(item.rsi) ?? num(item.technical?.rsi);

  let score = accelerationPoints(volumeAcceleration5mWindow) + accelerationPoints(tradeValueAcceleration5mWindow);
  if (relativeVolume !== null) score += relativeVolume >= 5 ? 15 : relativeVolume >= 3 ? 10 : 0;
  if (aboveVwap) score += 5;
  if (higherLow) score += 5;
  if (oneMinuteUp) score += 5;
  if ((changePercent ?? 0) >= 80) score -= 20;
  if ((rsi ?? 0) >= 88) score -= 15;

  return {
    surgeAccelerationScore: Math.round(clamp(score)),
    volumeAcceleration5mWindow,
    tradeValueAcceleration5mWindow,
  };
}

function scannerTopPickItemField(item, key) {
  return num(item?.[key]) ?? num(item?.technical?.[key]);
}

function scannerTopPickLivePrice(item) {
  return num(item?.normalizedLivePriceUsd)
    ?? num(item?.price)
    ?? num(item?.preMarketPrice)
    ?? num(item?.postMarketPrice)
    ?? num(item?.regularMarketPrice);
}

function scannerTopPickRvol(item) {
  return num(item?.volumeRatio ?? item?.relativeVolume);
}

function topPickSetupProfile(item, price, change) {
  const rvol = scannerTopPickRvol(item);
  const rsi = num(item?.rsi ?? item?.technical?.rsi);
  const dayHigh = num(item?.dayHigh ?? item?.regularMarketDayHigh);
  const dayLow = num(item?.dayLow ?? item?.regularMarketDayLow);
  const vwap = num(item?.technical?.vwap ?? item?.vwap);
  const vwapState = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const highPullbackPct = price > 0 && dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : null;
  const highPosition = price > 0 && dayHigh > 0 && dayLow > 0 && dayHigh > dayLow
    ? ((price - dayLow) / (dayHigh - dayLow)) * 100
    : null;
  const vwapAbove = item?.aboveVwap === true || vwapState === "above" || (price > 0 && vwap > 0 && price >= vwap);
  const vwapNear = !vwapAbove && price > 0 && vwap > 0 && price >= vwap * 0.985;
  const vwapBelow = item?.aboveVwap === false || vwapState === "below" || (price > 0 && vwap > 0 && price < vwap * 0.985);
  const volumeAcceleration = num(item?.volumeAccelerationScore) ?? 50;
  const higherLow = num(item?.higherLowScore) ?? 50;
  const resurge = num(item?.reSurgeSetupScore) ?? 50;
  const reclaim = num(item?.vwapReclaimScore) ?? 50;

  const overheated = change >= 80 || (rsi !== null && rsi >= 80 && change >= 20);
  const veryExtended = change >= 120 || (highPosition !== null && highPosition >= 88 && change >= 60);
  const highFailed = highPullbackPct !== null && highPullbackPct >= 18 && change >= 25;
  const extremeRvolWeak = rvol !== null && rvol >= 8 && highPullbackPct !== null && highPullbackPct >= 22 && !vwapAbove;
  const lowRecovery = highPosition !== null && highPosition >= 15 && highPosition <= 70;
  const notOverChased = change >= 1 && change <= 45;
  const volumeStarting = rvol !== null && rvol >= 3;
  const vwapRecovering = vwapAbove || vwapNear || reclaim >= 60;

  const earlyBonus = Math.max(0, Math.min(14, Math.round(
    (volumeStarting ? 3 : 0)
    + (volumeAcceleration >= 65 ? 2 : 0)
    + (notOverChased ? 3 : change <= 70 ? 1 : 0)
    + (vwapRecovering ? 3 : 0)
    + (higherLow >= 65 ? 2 : 0)
    + (resurge >= 65 ? 2 : 0)
    + (lowRecovery ? 2 : 0),
  )));
  const riskPenalty = Math.max(0, Math.min(32, Math.round(
    (overheated ? 12 : 0)
    + (veryExtended ? 10 : 0)
    + (highFailed ? 8 : 0)
    + (extremeRvolWeak ? 10 : 0)
    + (vwapBelow && change < 0 ? 8 : 0),
  )));

  return {
    rvol,
    rsi,
    vwapAbove,
    vwapNear,
    vwapBelow,
    volumeAcceleration,
    higherLow,
    resurge,
    reclaim,
    earlyBonus,
    riskPenalty,
    overheated,
    highFailed,
    extremeRvolWeak,
    volumeStarting,
    vwapRecovering,
  };
}

function topPickSignalScore(item, price, volume, change) {
  const setup = topPickSetupProfile(item, price, change);
  const volumeAcceleration = num(item?.volumeAccelerationScore) ?? 50;
  const higherLow = num(item?.higherLowScore) ?? 50;
  const vwapHold = num(item?.vwapHoldScore) ?? 50;
  const compression = num(item?.compressionScore) ?? 50;
  const resurge = num(item?.reSurgeSetupScore) ?? 50;
  const reclaim = num(item?.vwapReclaimScore) ?? 50;
  const volumeBonus = volume >= 5_000_000 ? 14 : volume >= 1_000_000 ? 8 : 0;
  const changeBonus = change >= 4 && change <= 35 ? 8 : change > 35 && change <= 60 ? 3 : change >= 80 ? -8 : 0;
  const rawSignalBonus =
    (volumeAcceleration - 50) * 0.03
    + (higherLow - 50) * 0.025
    + (vwapHold - 50) * 0.025
    + (compression - 50) * 0.03
    + (resurge - 50) * 0.04
    + (reclaim - 50) * 0.025
    + (setup.rvol !== null && setup.rvol >= 3 ? 1 : 0)
    + setup.earlyBonus
    - setup.riskPenalty;
  const signalBonus = Math.max(-32, Math.min(14, Math.round(rawSignalBonus)));
  return { signalBonus, volumeBonus, changeBonus, rvol: setup.rvol, setup };
}

function computeTopPickChaseRisk(item, setup, change, risk) {
  const trendRaw = String(item?.oneMinuteTrend ?? item?.technical?.oneMinuteTrend ?? "").toLowerCase();
  const trendGood = trendRaw.includes("up") || trendRaw.includes("상승") || item?.technical?.ma5vs20 === "above";
  const vwapGood = setup.vwapAbove || setup.vwapNear || setup.vwapRecovering;
  return Math.round(clamp(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
      + setup.riskPenalty * 0.8,
  ));
}

function computeTopPickGrade(score) {
  const value = num(score) ?? 0;
  if (value >= 85) return "S";
  if (value >= 75) return "A";
  if (value >= 65) return "B";
  if (value >= 55) return "C";
  return "D";
}

function evaluateTopPickForSnapshot(item) {
  const price = scannerTopPickLivePrice(item) ?? 0;
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const volume = num(item?.volume ?? item?.preMarketVolume) ?? 0;
  const surge = Math.round(num(item?.finalProbabilityScore ?? item?.scannerScore) ?? 0);
  const risk = Math.round(num(item?.riskScore) ?? 50);
  const pattern = Math.round(num(item?.patternSimilarityScore) ?? 50);
  const signal = topPickSignalScore(item, price, volume, change);
  const baseScore = surge * 0.55 + pattern * 0.2 + signal.volumeBonus + signal.changeBonus - risk * 0.12;
  const finalScore = Math.round(clamp(baseScore + signal.signalBonus));
  const setup = signal.setup;
  const chaseRisk = computeTopPickChaseRisk(item, setup, change, risk);
  const reasonCodes = [];

  if (setup.overheated) reasonCodes.push("overheated");
  if (setup.highFailed) reasonCodes.push("highFailed");
  if (setup.extremeRvolWeak) reasonCodes.push("extremeRvolWeak");
  if (risk >= 78) reasonCodes.push("riskHigh");
  if (finalScore < 58) reasonCodes.push("scoreWeak");

  let verdict = "관찰";
  if (setup.overheated || setup.highFailed || setup.extremeRvolWeak || risk >= 78 || finalScore < 58) {
    verdict = "진입 금지";
  } else if (finalScore >= 74 && setup.volumeStarting && setup.vwapRecovering && !setup.vwapBelow && risk < 70) {
    verdict = "매수 가능";
    reasonCodes.push("buySetup");
  } else {
    reasonCodes.push("watchSetup");
  }

  return {
    topPickVerdict: verdict,
    topPickFinalScore: finalScore,
    topPickDisplayFinalScore: finalScore,
    topPickChaseRisk: chaseRisk,
    topPickVerdictReasonCodes: reasonCodes,
    topPickGrade: computeTopPickGrade(finalScore),
  };
}

function buildVwapEvaluations(bars, lookback = 30) {
  const sample = bars.slice(-lookback);
  let totalNotional = 0;
  let totalVolume = 0;
  let usedAmount = false;
  const evaluated = [];

  for (const bar of bars) {
    const close = positive(bar.close);
    const volume = positive(bar.volume);
    if (close === null || volume === null) continue;

    const high = positive(bar.high) ?? close;
    const low = positive(bar.low) ?? close;
    const amount = barAmount(bar);
    const notional = amount ?? (((high + low + close) / 3) * volume);
    if (!Number.isFinite(notional) || notional <= 0) continue;

    if (amount !== null) usedAmount = true;
    totalNotional += notional;
    totalVolume += volume;
    if (!sample.includes(bar) || totalVolume <= 0) continue;
    const vwap = totalNotional / totalVolume;
    evaluated.push({ close, volume, vwap, above: close >= vwap });
  }

  return {
    evaluated,
    vwapSource: usedAmount ? "kis-amount-volume" : "yahoo-fallback",
  };
}

function calculateHigherLowScore(bars) {
  const sample = bars.slice(-10)
    .map((bar) => ({
      low: positive(bar.low),
      close: positive(bar.close),
    }))
    .filter((bar) => bar.low !== null && bar.close !== null);
  if (sample.length < 5) return 50;

  let defendedPairs = 0;
  for (let index = 1; index < sample.length; index += 1) {
    if (sample[index].low >= sample[index - 1].low * 0.998) defendedPairs += 1;
  }

  let consecutiveHigherLows = 0;
  for (let index = sample.length - 1; index > 0; index -= 1) {
    if (sample[index].low >= sample[index - 1].low * 1.001) consecutiveHigherLows += 1;
    else break;
  }

  const recent = sample.slice(-4);
  const recentFloor = Math.min(...recent.slice(0, -1).map((bar) => bar.low));
  const last = sample.at(-1);
  const closeMaintainsStructure = last.close >= last.low * 1.002 && last.close >= recentFloor * 0.998;
  const trendDamaged = last.low < recentFloor * 0.992 || last.close < recentFloor * 0.995;
  const defendedRatio = defendedPairs / (sample.length - 1);

  let score = 35 + defendedRatio * 38 + Math.min(consecutiveHigherLows, 4) * 7;
  if (consecutiveHigherLows >= 3 && closeMaintainsStructure && !trendDamaged) score = Math.max(score, 90);
  else if (consecutiveHigherLows >= 2 && closeMaintainsStructure && !trendDamaged) score = Math.max(score, 74);
  else if (trendDamaged) score = Math.min(score - 22, 38);
  if (closeMaintainsStructure) score += 6;

  return Math.round(clamp(score));
}

function calculateVwapHold(bars) {
  const { evaluated, vwapSource } = buildVwapEvaluations(bars, 24);
  if (evaluated.length < 3) return { vwapHoldMinutes: null, vwapHoldScore: 50 };

  let vwapHoldMinutes = 0;
  for (let index = evaluated.length - 1; index >= 0; index -= 1) {
    if (evaluated[index].close >= evaluated[index].vwap) vwapHoldMinutes += 1;
    else break;
  }

  const holdRatio = evaluated.filter((bar) => bar.close >= bar.vwap).length / evaluated.length;
  const score = vwapHoldMinutes >= 10 ? 96
    : vwapHoldMinutes >= 5 ? 82
      : vwapHoldMinutes >= 3 ? 66
        : vwapHoldMinutes >= 1 ? 44
          : Math.max(22, holdRatio * 48);

  return {
    vwapHoldMinutes,
    vwapSource,
    vwapHoldScore: Math.round(clamp(score)),
  };
}

function calculateCompressionScore(bars) {
  const sample = bars.slice(-20);
  if (sample.length < 8) return 50;
  const clean = sample.map((bar) => ({
    high: positive(bar.high),
    low: positive(bar.low),
    close: positive(bar.close),
    volume: positive(bar.volume),
  })).filter((bar) => bar.high !== null && bar.low !== null && bar.close !== null);
  const highs = clean.map((bar) => bar.high);
  const lows = clean.map((bar) => bar.low);
  const lastClose = positive(clean.at(-1)?.close);
  if (!highs.length || !lows.length || lastClose === null) return 50;

  const rangePct = ((Math.max(...highs) - Math.min(...lows)) / lastClose) * 100;
  const recent = clean.slice(-8);
  const prior = clean.slice(0, Math.max(clean.length - 8, 1));
  const avgRange = (items) => average(items.map((bar) => ((bar.high - bar.low) / Math.max(bar.close, 0.0001)) * 100)) ?? null;
  const recentRange = avgRange(recent);
  const priorRange = avgRange(prior);
  const rangeContracting = recentRange !== null && priorRange !== null ? recentRange <= priorRange * 0.82 : false;
  const recentHighRange = recent.length >= 4 ? ((Math.max(...recent.map((bar) => bar.high)) - Math.min(...recent.map((bar) => bar.high))) / lastClose) * 100 : null;
  const lowsDefended = Math.min(...recent.map((bar) => bar.low)) >= Math.min(...clean.slice(0, -4).map((bar) => bar.low)) * 0.995;
  const volumes = clean.map((bar) => bar.volume).filter((value) => value !== null);
  const recentVol = average(volumes.slice(-3));
  const middleVol = average(volumes.slice(-12, -3));
  const volumeRebuilding = recentVol !== null && middleVol !== null ? recentVol >= middleVol * 1.08 : false;
  const highTightnessBonus = recentHighRange !== null && recentHighRange <= 2.5 ? 10 : recentHighRange !== null && recentHighRange <= 4 ? 5 : 0;
  const base = rangePct <= 3 ? 88
    : rangePct <= 5 ? 78
      : rangePct <= 8 ? 64
        : rangePct <= 12 ? 52
          : 38;
  const score = base
    + (rangeContracting ? 12 : -4)
    + (lowsDefended ? 10 : -12)
    + (volumeRebuilding ? 7 : 0)
    + highTightnessBonus
    + (calculateHigherLowScore(sample) - 50) * 0.10;
  return Math.round(clamp(score));
}

function vwapEvaluations(bars, lookback = 30) {
  return buildVwapEvaluations(bars, lookback).evaluated;
}

function calculateVwapReclaimScore(bars, vwapHoldMinutes = null) {
  const evaluated = vwapEvaluations(bars, 30);
  if (evaluated.length < 8) return 50;
  let reclaimIndex = -1;
  for (let index = 1; index < evaluated.length; index += 1) {
    if (!evaluated[index - 1].above && evaluated[index].above) reclaimIndex = index;
  }
  if (reclaimIndex < 0) return evaluated.at(-1)?.above ? 58 : 32;

  const after = evaluated.slice(reclaimIndex);
  const before = evaluated.slice(Math.max(0, reclaimIndex - 5), reclaimIndex);
  const holdMinutes = num(vwapHoldMinutes) ?? after.filter((bar) => bar.above).length;
  const reclaimVolume = average(after.slice(0, 3).map((bar) => bar.volume));
  const priorVolume = average(before.map((bar) => bar.volume));
  const volumeExpanded = reclaimVolume !== null && priorVolume !== null ? reclaimVolume >= priorVolume * 1.15 : false;
  const last = evaluated.at(-1);
  const didNotLoseVwap = last && last.close >= last.vwap * 0.996;
  const score = 40
    + Math.min(holdMinutes, 10) * 5
    + (volumeExpanded ? 16 : 0)
    + (didNotLoseVwap ? 12 : -14)
    + (last?.above ? 8 : 0);
  return Math.round(clamp(score));
}

function calculateReSurgeSetupScore(bars, signals = {}) {
  const sample = bars.slice(-40)
    .map((bar) => ({
      high: positive(bar.high),
      low: positive(bar.low),
      close: positive(bar.close),
      volume: positive(bar.volume),
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
  const closeNearBreakout = recentHigh > 0 ? last.close >= recentHigh * 0.985 : false;
  const didNotCollapse = pullbackPct !== null && pullbackPct <= 18 && last.close >= impulseHigh * 0.72;
  const sidewaysRangePct = ((recentHigh - recentLow) / Math.max(last.close, 0.0001)) * 100;
  const notDeadVolume = (() => {
    const recentVol = average(recent.slice(-5).map((bar) => bar.volume));
    const priorVol = average(sample.slice(-25, -10).map((bar) => bar.volume));
    return recentVol !== null && priorVol !== null ? recentVol >= priorVol * 0.35 : true;
  })();
  const higherLow = (num(signals.higherLowScore) ?? 50) >= 50;
  const vwapHealthy = (num(signals.vwapHoldScore) ?? 50) >= 60 || (num(signals.vwapReclaimScore) ?? 50) >= 65;

  let score = 28;
  if (impulseMovePct !== null && impulseMovePct >= 18) score += 18;
  else if (impulseMovePct !== null && impulseMovePct >= 9) score += 10;
  if (didNotCollapse) score += 16;
  if (sidewaysRangePct <= 8) score += 12;
  else if (sidewaysRangePct <= 13) score += 6;
  if (notDeadVolume) score += 10;
  if (higherLow) score += 10;
  if (vwapHealthy) score += 10;
  if (closeNearBreakout) score += 12;
  return Math.round(clamp(score));
}

function calculateCommonSignals(bars) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return {
      volumeAcceleration1m: null,
      volumeAcceleration5m: null,
      volumeAccelerationScore: 50,
      higherLowScore: 50,
      vwapHoldMinutes: null,
      vwapHoldScore: 50,
      compressionScore: 50,
      vwapReclaimScore: 50,
      reSurgeSetupScore: 50,
      commonSignalStatus: "데이터 부족",
    };
  }

  const volumeAcceleration = calculateVolumeAcceleration(bars);
  const higherLowScore = calculateHigherLowScore(bars);
  const vwapHold = calculateVwapHold(bars);
  const compressionScore = calculateCompressionScore(bars);
  const vwapReclaimScore = calculateVwapReclaimScore(bars, vwapHold.vwapHoldMinutes);
  const reSurgeSetupScore = calculateReSurgeSetupScore(bars, {
    higherLowScore,
    vwapHoldScore: vwapHold.vwapHoldScore,
    vwapReclaimScore,
  });
  return {
    ...volumeAcceleration,
    higherLowScore,
    ...vwapHold,
    compressionScore,
    vwapReclaimScore,
    reSurgeSetupScore,
    commonSignalStatus: "ok",
  };
}

function commonSignalBoost(signals = {}) {
  const score =
    (num(signals.volumeAccelerationScore) ?? 50) * 0.18
    + (num(signals.higherLowScore) ?? 50) * 0.14
    + (num(signals.vwapHoldScore) ?? 50) * 0.14
    + (num(signals.compressionScore) ?? 50) * 0.18
    + (num(signals.reSurgeSetupScore) ?? 50) * 0.22
    + (num(signals.vwapReclaimScore) ?? 50) * 0.14;
  return Math.round(clamp(Math.max(0, (score - 50) * 0.20), 0, 10));
}

function pickDisplayPrice({ marketState, regularPrice, preMarketPrice, postMarketPrice, latestClose }) {
  const normalizedState = String(marketState || "").toUpperCase();
  if (normalizedState === "PRE" && preMarketPrice !== null) return preMarketPrice;
  if ((normalizedState === "POST" || normalizedState === "POSTPOST") && postMarketPrice !== null) return postMarketPrice;
  if (!normalizedState && latestClose !== null) return latestClose;
  return latestClose ?? regularPrice ?? preMarketPrice ?? postMarketPrice ?? null;
}

function buildChartSnapshotFromHistory(historySnapshot = {}) {
  const bars = Array.isArray(historySnapshot.bars) ? historySnapshot.bars : [];
  const latestBar = bars.at(-1) || {};
  const latestTimestampMs = num(latestBar.timestamp) ?? (latestBar.time ? Date.parse(latestBar.time) : null);
  const volumes = bars.map((bar) => positive(bar.volume)).filter((value) => value !== null);
  const vwapEvaluation = buildVwapEvaluations(bars, 30);
  const latestVwap = vwapEvaluation.evaluated.at(-1)?.vwap ?? null;
  const historySource = historySnapshot.historySource || "yahoo";
  const isKisHistory = historySource === "kis-daymarket-bars";

  return {
    latestClose: positive(latestBar.close),
    latestBarAge: latestTimestampMs ? Math.max(0, Math.round((Date.now() - latestTimestampMs) / 60000)) : null,
    priceUpdatedAt: latestTimestampMs ? new Date(latestTimestampMs).toISOString() : null,
    marketState: null,
    regularMarketPrice: positive(historySnapshot.regularMarketPrice) ?? positive(latestBar.close),
    previousClose: positive(historySnapshot.previousClose),
    chartPreviousClose: positive(historySnapshot.previousClose),
    regularMarketVolume: positive(historySnapshot.regularMarketVolume),
    volume: volumes.length ? volumes.reduce((total, value) => total + value, 0) : null,
    bars,
    commonSignals: {
      ...calculateCommonSignals(bars),
      vwapSource: vwapEvaluation.vwapSource,
      volumeAccelerationSource: isKisHistory ? "kis-bars" : "yahoo-fallback",
    },
    historySource,
    volumeSource: historySnapshot.volumeSource || (isKisHistory ? "kis-evol" : "yahoo-fallback"),
    sessionType: historySnapshot.sessionType || getSessionType(new Date()),
    kisMarketCode: historySnapshot.kisMarketCode || null,
    kisBarCount: positive(historySnapshot.kisBarCount) ?? bars.length,
    vwap: latestVwap,
    vwapSource: vwapEvaluation.vwapSource,
  };
}

function mergeSnapshots(...snapshots) {
  return snapshots.reduce((merged, snapshot) => ({ ...merged, ...compactObject(snapshot) }), {});
}

function debugQuoteSourceLabel(localQuoteSnapshot, hasYahooBatch) {
  if (localQuoteSnapshot?.priceSource?.startsWith("kis")) return "local-quote-kis";
  if (localQuoteSnapshot?.priceSource) return `local-quote-${localQuoteSnapshot.priceSource}`;
  return hasYahooBatch ? "yahoo" : "none";
}

function debugHistorySourceLabel(localHistorySnapshot, hasYahooChart) {
  if (localHistorySnapshot?.historySource === "kis-daymarket-bars") return "local-history-kis";
  if (localHistorySnapshot?.historySource) return `local-history-${localHistorySnapshot.historySource}`;
  return hasYahooChart ? "yahoo-chart" : "none";
}

function debugFallbackReason({
  sessionType,
  localQuoteSnapshot,
  localHistorySnapshot,
  mergedQuoteSnapshot,
  liveQuote,
  chartSnapshot,
}) {
  if (sessionType !== "DAY") return null;

  const reasons = [];
  const quoteHasKis = Boolean(localQuoteSnapshot?.priceSource?.startsWith("kis") && num(localQuoteSnapshot?.kisPrice) !== null);
  const historyHasKis = localHistorySnapshot?.historySource === "kis-daymarket-bars" && Array.isArray(localHistorySnapshot?.bars) && localHistorySnapshot.bars.length > 0;

  if (!quoteHasKis) {
    reasons.push(`quote-${localQuoteSnapshot?.priceSource || "empty"}`);
    if (num(localQuoteSnapshot?.kisPrice) === null) reasons.push("quote-kis-price-missing");
    if (num(localQuoteSnapshot?.kisVolume) === null) reasons.push("quote-kis-volume-missing");
  }

  if (!historyHasKis) {
    reasons.push(`history-${localHistorySnapshot?.historySource || "empty"}`);
    if (localHistorySnapshot?.fallbackReason) reasons.push(`history-fallback-${localHistorySnapshot.fallbackReason}`);
    if (localHistorySnapshot?.kisError) reasons.push(`history-kis-error-${localHistorySnapshot.kisError}`);
    if (!Array.isArray(localHistorySnapshot?.bars) || localHistorySnapshot.bars.length === 0) reasons.push("history-bars-empty");
  }

  if (quoteHasKis && mergedQuoteSnapshot?.priceSource !== localQuoteSnapshot?.priceSource) {
    reasons.push("merge-quote-priceSource-overwrite");
  }
  if (quoteHasKis && num(mergedQuoteSnapshot?.kisPrice) !== num(localQuoteSnapshot?.kisPrice)) {
    reasons.push("merge-quote-kisPrice-overwrite");
  }
  if (historyHasKis && chartSnapshot?.historySource !== "kis-daymarket-bars") {
    reasons.push("merge-historySource-overwrite");
  }
  if (quoteHasKis && liveQuote?.priceSource !== localQuoteSnapshot?.priceSource) {
    reasons.push("final-priceSource-overwrite");
  }
  if (historyHasKis && liveQuote?.historySource !== "kis-daymarket-bars") {
    reasons.push("final-historySource-overwrite");
  }

  return reasons.length ? [...new Set(reasons)].join("|") : null;
}

function normalizeLiveQuote(item, quoteSnapshot = {}, chartSnapshot = {}) {
  const sessionType = String(
    quoteSnapshot.sessionType
    ?? item.sessionType
    ?? chartSnapshot.sessionType
    ?? getSessionType(new Date()),
  ).toUpperCase();
  const marketState = String(
    quoteSnapshot.marketState
    ?? item.marketState
    ?? chartSnapshot.marketState
    ?? "",
  ).toUpperCase();
  const kisPrice = num(quoteSnapshot.kisPrice)
    ?? num(item.kisPrice)
    ?? null;
  const regularPrice = num(quoteSnapshot.regularMarketPrice)
    ?? num(item.regularMarketPrice)
    ?? num(chartSnapshot.regularMarketPrice)
    ?? (sessionType === "REGULAR" ? num(quoteSnapshot.price) ?? num(item.price) : null);
  const preMarketPrice = num(quoteSnapshot.preMarketPrice)
    ?? num(item.preMarketPrice)
    ?? num(chartSnapshot.preMarketPrice)
    ?? (sessionType === "PRE" ? num(quoteSnapshot.price) ?? num(chartSnapshot.latestClose) ?? num(item.price) : null);
  const postMarketPrice = num(quoteSnapshot.postMarketPrice)
    ?? num(item.postMarketPrice)
    ?? num(chartSnapshot.postMarketPrice)
    ?? (sessionType === "AFTER" ? num(quoteSnapshot.price) ?? num(chartSnapshot.latestClose) ?? num(item.price) : null);
  const latestClose = num(chartSnapshot.latestClose);
  const displayPrice = sessionType === "PRE"
    ? preMarketPrice
    : sessionType === "AFTER"
      ? postMarketPrice
      : sessionType === "REGULAR"
        ? regularPrice
        : num(quoteSnapshot.price) ?? kisPrice ?? pickDisplayPrice({
    marketState,
    regularPrice,
    preMarketPrice,
    postMarketPrice,
    latestClose,
  });
  const previousClose = num(quoteSnapshot.regularMarketPreviousClose)
    ?? num(quoteSnapshot.previousClose)
    ?? num(item.previousClose)
    ?? num(chartSnapshot.previousClose)
    ?? num(chartSnapshot.chartPreviousClose);
  const regularMarketPreviousClose = num(quoteSnapshot.regularMarketPreviousClose)
    ?? num(item.regularMarketPreviousClose)
    ?? previousClose;
  const regularChangePercent = num(quoteSnapshot.regularMarketChangePercent)
    ?? num(item.regularMarketChangePercent)
    ?? pctFromBasis(regularPrice, regularMarketPreviousClose);
  const preChangePercent = num(quoteSnapshot.preMarketChangePercent)
    ?? pctFromBasis(preMarketPrice, regularPrice);
  const postChangePercent = num(quoteSnapshot.postMarketChangePercent)
    ?? pctFromBasis(postMarketPrice, regularPrice);
  let changePercent = null;
  let changeBasis = null;
  if (sessionType === "PRE") {
    changePercent = preChangePercent;
    changeBasis = changePercent !== null ? "preMarketPrice-vs-regularMarketPrice" : "preMarketChangePercent-unavailable";
  } else if (sessionType === "AFTER") {
    changePercent = postChangePercent;
    changeBasis = changePercent !== null ? "postMarketPrice-vs-regularMarketPrice" : "postMarketChangePercent-unavailable";
  } else if (sessionType === "REGULAR") {
    changePercent = regularChangePercent;
    changeBasis = "regularMarketPrice-vs-previousClose";
  } else {
    changePercent = num(quoteSnapshot.changePercent) ?? num(item.changePercent) ?? null;
    changeBasis = quoteSnapshot.changeBasis ?? item.changeBasis ?? "daymarket";
  }
  const change = displayPrice !== null && changePercent !== null
    ? displayPrice - (displayPrice / (1 + changePercent / 100))
    : num(quoteSnapshot.change) ?? num(item.change) ?? null;
  let currentVolume = null;
  let volumeSource = null;
  if (sessionType === "PRE") {
    currentVolume = num(quoteSnapshot.preMarketVolume) ?? num(item.preMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-preMarketVolume" : "premarket-volume-unconfirmed";
  } else if (sessionType === "AFTER") {
    currentVolume = num(quoteSnapshot.postMarketVolume) ?? num(item.postMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-postMarketVolume" : "postmarket-volume-unconfirmed";
  } else if (sessionType === "REGULAR") {
    currentVolume = num(quoteSnapshot.regularMarketVolume)
      ?? num(item.regularMarketVolume)
      ?? num(chartSnapshot.regularMarketVolume);
    volumeSource = currentVolume !== null ? "yahoo-regularMarketVolume" : "regular-volume-unconfirmed";
  } else {
    currentVolume = num(quoteSnapshot.kisVolume) ?? num(item.kisVolume);
    volumeSource = currentVolume !== null ? "kis-tvol" : "daymarket-volume-unconfirmed";
  }
  const priceSource = quoteSnapshot.priceSource
    ?? item.priceSource
    ?? (kisPrice !== null ? (sessionType === "DAY" ? "kis-daymarket" : "kis") : "yahoo");
  const dataReliability = currentVolume !== null && changePercent !== null
    ? "high"
    : sessionType === "REGULAR" && changePercent !== null
      ? "medium"
      : "low";
  const historySource = chartSnapshot.historySource
    ?? item.historySource
    ?? null;
  const kisVolume = num(quoteSnapshot.kisVolume)
    ?? num(item.kisVolume)
    ?? null;
  const kisMarketCode = quoteSnapshot.kisMarketCode
    ?? chartSnapshot.kisMarketCode
    ?? item.kisMarketCode
    ?? null;
  const kisBarCount = positive(chartSnapshot.kisBarCount)
    ?? positive(item.kisBarCount)
    ?? 0;
  const vwap = num(chartSnapshot.vwap)
    ?? num(item.vwap);
  const vwapSource = chartSnapshot.vwapSource
    ?? chartSnapshot.commonSignals?.vwapSource
    ?? item.vwapSource
    ?? null;
  const volumeAccelerationSource = chartSnapshot.commonSignals?.volumeAccelerationSource
    ?? chartSnapshot.volumeAccelerationSource
    ?? item.volumeAccelerationSource
    ?? null;

  return {
    price: displayPrice ?? item.price,
    normalizedLivePriceUsd: displayPrice,
    regularMarketPrice: regularPrice,
    preMarketPrice,
    postMarketPrice,
    previousClose: previousClose ?? item.previousClose ?? null,
    regularMarketPreviousClose,
    change: change ?? null,
    changePercent: changePercent ?? null,
    preMarketChange: num(quoteSnapshot.preMarketChange) ?? num(item.preMarketChange) ?? null,
    preMarketChangePercent: preChangePercent,
    regularMarketChangePercent: regularChangePercent,
    postMarketChangePercent: postChangePercent,
    marketState,
    extendedHours: marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST",
    latestClose,
    latestBarAge: num(chartSnapshot.latestBarAge),
    priceUpdatedAt: chartSnapshot.priceUpdatedAt ?? null,
    volume: currentVolume,
    regularMarketVolume: num(quoteSnapshot.regularMarketVolume) ?? num(item.regularMarketVolume) ?? num(chartSnapshot.regularMarketVolume) ?? null,
    preMarketVolume: num(quoteSnapshot.preMarketVolume) ?? num(item.preMarketVolume) ?? null,
    postMarketVolume: num(quoteSnapshot.postMarketVolume) ?? num(item.postMarketVolume) ?? null,
    chartVolume: num(chartSnapshot.volume) ?? null,
    averageVolume: num(quoteSnapshot.averageDailyVolume3Month)
      ?? num(quoteSnapshot.averageDailyVolume10Day)
      ?? num(item.averageVolume),
    avgVolume: num(quoteSnapshot.avgVolume) ?? num(item.avgVolume) ?? num(item.averageVolume),
    sessionType,
    priceSource,
    volumeSource,
    changeBasis,
    dataReliability,
    dataReliabilityLabel: confidenceLabel(dataReliability),
    sessionLabel: sessionLabel(sessionType),
    historySource,
    vwap,
    vwapSource,
    volumeAccelerationSource,
    rvolSource: item.rvolSource ?? null,
    kisMarketCode,
    kisPrice,
    kisVolume,
    kisBarCount,
    aboveVwap: vwap !== null && displayPrice !== null ? displayPrice >= vwap : num(item.aboveVwap),
  };
}

async function fetchBatchQuoteMap(symbols) {
  const map = new Map();
  const cleanSymbols = [...new Set(symbols.filter(Boolean))];
  const chunkSize = 50;
  for (let start = 0; start < cleanSymbols.length; start += chunkSize) {
    const chunk = cleanSymbols.slice(start, start + chunkSize);
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(chunk.join(","))}`;
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      const results = payload?.quoteResponse?.result;
      if (!response.ok || !Array.isArray(results)) continue;
      for (const quote of results) {
        if (quote?.symbol) map.set(String(quote.symbol).toUpperCase(), quote);
      }
    } catch {
      // Keep scanner working even if Yahoo batch quote intermittently fails.
    }
  }
  return map;
}

async function fetchChartSnapshot(symbol) {
  if (!symbol) return {};
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m&includePrePost=true`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.chart?.error) return {};
    const result = payload?.chart?.result?.[0];
    const meta = result?.meta || {};
    const quote = result?.indicators?.quote?.[0] || {};
    const closes = Array.isArray(quote.close) ? quote.close.map(num) : [];
    const opens = Array.isArray(quote.open) ? quote.open.map(num) : [];
    const highs = Array.isArray(quote.high) ? quote.high.map(num) : [];
    const lows = Array.isArray(quote.low) ? quote.low.map(num) : [];
    const rawVolumes = Array.isArray(quote.volume) ? quote.volume.map(num) : [];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const bars = timestamps.map((timestamp, index) => ({
      time: timestamp ? new Date(timestamp * 1000).toISOString() : null,
      open: positive(opens[index]) ?? positive(closes[index]),
      high: positive(highs[index]) ?? positive(closes[index]),
      low: positive(lows[index]) ?? positive(closes[index]),
      close: positive(closes[index]),
      volume: positive(rawVolumes[index]),
    })).filter((bar) => bar.close !== null).slice(-90);

    let latestClose = null;
    let latestTimestamp = null;
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      if (closes[i] !== null) {
        latestClose = closes[i];
        latestTimestamp = timestamps[i] ?? null;
        break;
      }
    }

    const volumes = rawVolumes.filter((value) => value !== null && value > 0);
    const latestBarAge = latestTimestamp ? Math.max(0, Math.round((Date.now() - latestTimestamp * 1000) / 60000)) : null;
    const vwapEvaluation = buildVwapEvaluations(bars, 30);
    return {
      latestClose,
      latestBarAge,
      priceUpdatedAt: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : null,
      marketState: meta.marketState,
      regularMarketPrice: num(meta.regularMarketPrice),
      previousClose: num(meta.previousClose),
      chartPreviousClose: num(meta.chartPreviousClose),
      regularMarketVolume: num(meta.regularMarketVolume),
      volume: volumes.reduce((sum, value) => sum + value, 0) || null,
      bars,
      commonSignals: {
        ...calculateCommonSignals(bars),
        vwapSource: vwapEvaluation.vwapSource,
        volumeAccelerationSource: "yahoo-fallback",
      },
      historySource: "yahoo",
      volumeSource: "yahoo-fallback",
      sessionType: getSessionType(new Date()),
      kisMarketCode: null,
      kisBarCount: bars.length,
      vwap: vwapEvaluation.evaluated.at(-1)?.vwap ?? null,
      vwapSource: vwapEvaluation.vwapSource,
    };
  } catch {
    return {};
  }
}

async function fetchVolumeProfile(symbol, currentVolume, currentVolumeSource = "yahoo") {
  if (!symbol) return {};
  if (!isTrustedCurrentVolumeSource(currentVolumeSource) || num(currentVolume) === null) {
    return {
      averageVolume: null,
      previousDayVolume: null,
      relativeVolume: null,
      volumeRatio: null,
      previousDayVolumeRatio: null,
      rvolSource: "disabled-non-session-volume",
      volumeProfileStatus: "current-session-volume-unconfirmed",
    };
  }
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

    const liveVolume = num(currentVolume);
    const previousDayVolume = volumes.length > 1 ? volumes.at(-2) : null;
    const averageVolume20d = average(volumes.slice(0, -1).slice(-20));
    return {
      averageVolume: averageVolume20d,
      previousDayVolume,
      relativeVolume: averageVolume20d ? liveVolume / averageVolume20d : null,
      volumeRatio: averageVolume20d ? liveVolume / averageVolume20d : null,
      previousDayVolumeRatio: previousDayVolume ? liveVolume / previousDayVolume : null,
      volume: liveVolume,
      rvolSource: String(currentVolumeSource || "").startsWith("kis") ? "kis-current-volume-yahoo-average" : "yahoo",
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

async function normalizeItem(item, enrichVolume = true, metrics = null) {
  if (!item || typeof item !== "object") return item;

  const rawVolume = isTrustedCurrentVolumeSource(item.volumeSource) ? (num(item.volume) ?? num(item.preMarketVolume) ?? 0) : 0;
  const needsVolumeProfile = enrichVolume
    && isTrustedCurrentVolumeSource(item.volumeSource)
    && rawVolume > 0
    && ((num(item.relativeVolume) ?? num(item.volumeRatio)) === null || num(item.averageVolume) === null);
  let volumeProfile = {};
  if (needsVolumeProfile) {
    const volumeStartedAt = Date.now();
    volumeProfile = await fetchVolumeProfile(item.symbol, rawVolume, item.volumeSource);
    if (metrics) {
      metrics.volumeProfileCount += 1;
      metrics.volumeProfileMs += Date.now() - volumeStartedAt;
    }
  }
  const merged = { ...item, ...compactObject(volumeProfile) };
  const boosted = boostedScore(merged);
  const correctedVolumeScore = volumeStrength(merged);
  const quality = volumeQualityScore(merged);
  const baseScannerScore = Math.max(num(merged.scannerScore) ?? 0, boosted);
  const baseFinalScore = Math.max(num(merged.finalProbabilityScore) ?? 0, boosted);

  return {
    ...merged,
    volumeComputationVersion: "pro-rvol-v2",
    volume: isTrustedCurrentVolumeSource(merged.volumeSource) ? ((num(merged.volume) ?? rawVolume) || null) : null,
    volumeStrengthScore: correctedVolumeScore,
    volumeQualityScore: quality.score,
    tradeValueKrw: quality.tradeValueKrw,
    scannerScore: baseScannerScore,
    finalProbabilityScore: baseFinalScore,
    selectionReasons: [
      ...(Array.isArray(merged.selectionReasons) ? merged.selectionReasons : []),
      volumeProfile.relativeVolume ? `RVOL ${volumeProfile.relativeVolume.toFixed(1)}x from 20D avg volume` : null,
      volumeProfile.previousDayVolumeRatio ? `Volume ${volumeProfile.previousDayVolumeRatio.toFixed(1)}x vs previous day` : null,
      boosted > (num(merged.finalProbabilityScore) ?? 0) ? "Premarket surge volume boost" : null,
      quality.score < 30 ? "Volume quality demotion: low absolute volume or KRW trade value" : null,
    ].filter(Boolean),
  };
}

const BASE_SCANNER_SCREENER_IDS = [
  "most_actives",
  "day_gainers",
  "small_cap_gainers",
  "undervalued_large_caps",
];
const UNDER_ONE_SCANNER_IDS = [
  "small_cap_stocks",
  "aggressive_small_caps",
];
const BASE_SCANNER_ITEM_LIMIT = 80;
const UNDER_ONE_MIN_ITEMS = 30;
const BASE_SCANNER_SOURCE = "yahoo-screener-local";

async function fetchYahooScreenerQuotes(screenerId, count = 100) {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=${count}&scrIds=${encodeURIComponent(screenerId)}`;
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    const quotes = payload?.finance?.result?.[0]?.quotes;
    if (!response.ok || !Array.isArray(quotes)) return [];
    return quotes;
  } catch {
    return [];
  }
}

async function collectBaseScannerQuotes() {
  const quoteBySymbol = new Map();
  const screenerSources = [
    ...BASE_SCANNER_SCREENER_IDS.map((screenerId) => ({
      screenerId,
      sourceTag: `yahoo-screener-${screenerId}`,
    })),
    ...UNDER_ONE_SCANNER_IDS.map((screenerId) => ({
      screenerId,
      sourceTag: `yahoo-screener-under1-${screenerId}`,
    })),
  ];
  await Promise.all(screenerSources.map(async ({ screenerId, sourceTag }) => {
    const quotes = await fetchYahooScreenerQuotes(screenerId);
    for (const quote of quotes) {
      const symbol = String(quote?.symbol || "").toUpperCase();
      if (!symbol) continue;
      const existing = quoteBySymbol.get(symbol);
      if (!existing) {
        quoteBySymbol.set(symbol, { quote, sourceTags: new Set([sourceTag]) });
        continue;
      }
      existing.sourceTags.add(sourceTag);
      const existingVolume = Math.max(num(existing.quote.regularMarketVolume) ?? 0, num(existing.quote.preMarketVolume) ?? 0);
      const nextVolume = Math.max(num(quote.regularMarketVolume) ?? 0, num(quote.preMarketVolume) ?? 0);
      if (nextVolume > existingVolume) existing.quote = quote;
    }
  }));
  return quoteBySymbol;
}

function scannerLivePriceUsd(item) {
  return num(item?.price) ?? num(item?.preMarketPrice) ?? num(item?.postMarketPrice);
}

function isUnderOneScannerItem(item) {
  const price = scannerLivePriceUsd(item);
  return price !== null && price > 0 && price < 1;
}

function compareScannerItems(a, b) {
  const scoreDiff = (num(b.finalProbabilityScore) ?? 0) - (num(a.finalProbabilityScore) ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
  const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
  return bVolume - aVolume;
}

function compareUnderOneScannerItems(a, b) {
  const aChange = num(a.changePercent) ?? num(a.preMarketChangePercent) ?? 0;
  const bChange = num(b.changePercent) ?? num(b.preMarketChangePercent) ?? 0;
  const aUp = aChange > 0 ? 1 : 0;
  const bUp = bChange > 0 ? 1 : 0;
  if (bUp !== aUp) return bUp - aUp;
  return compareScannerItems(a, b);
}

function selectBalancedScannerItems(rawItems, limit = BASE_SCANNER_ITEM_LIMIT) {
  const underOneItems = [];
  const otherItems = [];
  for (const item of rawItems) {
    if (isUnderOneScannerItem(item)) underOneItems.push(item);
    else otherItems.push(item);
  }
  underOneItems.sort(compareUnderOneScannerItems);
  otherItems.sort(compareScannerItems);

  const selected = [];
  const seen = new Set();
  const underOneTarget = Math.min(UNDER_ONE_MIN_ITEMS, underOneItems.length);
  for (const item of underOneItems.slice(0, underOneTarget)) {
    selected.push(item);
    seen.add(item.symbol);
  }
  for (const item of otherItems) {
    if (selected.length >= limit) break;
    if (seen.has(item.symbol)) continue;
    selected.push(item);
    seen.add(item.symbol);
  }
  for (const item of underOneItems.slice(underOneTarget)) {
    if (selected.length >= limit) break;
    if (seen.has(item.symbol)) continue;
    selected.push(item);
    seen.add(item.symbol);
  }
  selected.sort(compareScannerItems);
  return selected;
}

function inferVolumeSourceFromQuote(quote) {
  const marketState = String(quote?.marketState || "").toUpperCase();
  const preVol = num(quote?.preMarketVolume);
  const regVol = num(quote?.regularMarketVolume);
  const postVol = num(quote?.postMarketVolume);
  if (marketState === "PRE" || marketState === "PREPRE") {
    return preVol !== null ? "yahoo-preMarketVolume" : "premarket-volume-unconfirmed";
  }
  if (marketState === "POST" || marketState === "POSTPOST") {
    return postVol !== null ? "yahoo-postMarketVolume" : "postmarket-volume-unconfirmed";
  }
  if (regVol !== null) return "yahoo-regularMarketVolume";
  if (preVol !== null) return "yahoo-preMarketVolume";
  if (postVol !== null) return "yahoo-postMarketVolume";
  return "regular-volume-unconfirmed";
}

function computeBaseScannerScores({ changePercent, volumeRatio, price, volume }) {
  const change = Math.abs(changePercent ?? 0);
  const rvol = volumeRatio ?? 0;
  const rawVolume = volume ?? 0;

  const surgePrecursorScore = Math.round(clamp(
    40
    + (change >= 5 ? 12 : change >= 2 ? 6 : 0)
    + (rvol >= 5 ? 18 : rvol >= 3 ? 12 : rvol >= 1.5 ? 6 : 0)
    + (price !== null && price < 5 ? 8 : 0),
  ));

  const momentumExpansionScore = Math.round(clamp(
    40
    + (change >= 10 && change <= 45 ? 22 : change >= 5 ? 10 : 0)
    + (rvol >= 3 ? 15 : rvol >= 2 ? 8 : 0)
    + (rawVolume >= 5_000_000 ? 12 : rawVolume >= 1_000_000 ? 6 : 0),
  ));

  const patternSimilarityScore = Math.round(clamp(
    45
    + (change >= 8 ? 12 : 0)
    + (rvol >= 2 ? 10 : 0)
    + (price !== null && price < 1 ? 8 : price !== null && price < 5 ? 4 : 0),
  ));

  const riskScore = Math.round(clamp(
    35
    + (change >= 100 ? 28 : change >= 60 ? 18 : change >= 35 ? 10 : 0)
    + (price !== null && price < 1 ? 12 : 0)
    + (rvol >= 10 && rawVolume < 500_000 ? 15 : 0),
  ));

  const scannerScore = Math.round(clamp(
    surgePrecursorScore * 0.28
    + momentumExpansionScore * 0.32
    + patternSimilarityScore * 0.22
    + (100 - riskScore) * 0.18,
  ));

  return {
    scannerScore,
    finalProbabilityScore: scannerScore,
    surgePrecursorScore,
    momentumExpansionScore,
    patternSimilarityScore,
    riskScore,
    stage: scannerScore >= 75 ? "MOMENTUM EXPANSION" : scannerScore >= 60 ? "SURGE PRECURSOR" : "ACCUMULATION",
    stageLabel: scannerScore >= 75 ? "추가 확장 가능" : scannerScore >= 60 ? "급등 전 조짐" : "누적 관찰",
  };
}

function buildBaseScannerItem(quote, sourceTags = []) {
  const symbol = String(quote.symbol || "").toUpperCase();
  const previousClose = num(quote.regularMarketPreviousClose) ?? num(quote.previousClose);
  const regularMarketPrice = num(quote.regularMarketPrice);
  const preMarketPrice = num(quote.preMarketPrice);
  const postMarketPrice = num(quote.postMarketPrice);
  const marketState = String(quote.marketState || "").toUpperCase();
  const price = regularMarketPrice ?? preMarketPrice ?? postMarketPrice;
  const preMarketChangePercent = num(quote.preMarketChangePercent)
    ?? pctFromBasis(preMarketPrice, previousClose);
  const changePercent = num(quote.regularMarketChangePercent)
    ?? preMarketChangePercent
    ?? num(quote.postMarketChangePercent);
  const preMarketVolume = num(quote.preMarketVolume);
  const regularMarketVolume = num(quote.regularMarketVolume);
  const postMarketVolume = num(quote.postMarketVolume);
  const volumeSource = inferVolumeSourceFromQuote(quote);
  const volume = volumeSource.includes("preMarket") ? preMarketVolume
    : volumeSource.includes("postMarket") ? postMarketVolume
      : regularMarketVolume ?? preMarketVolume ?? postMarketVolume;
  const averageVolume = num(quote.averageDailyVolume3Month) ?? num(quote.averageDailyVolume10Day);
  const volumeRatio = averageVolume && volume ? volume / averageVolume : null;
  const scores = computeBaseScannerScores({
    changePercent: Math.abs(changePercent ?? 0),
    volumeRatio,
    price,
    volume,
  });

  return {
    symbol,
    name: quote.shortName || quote.longName || symbol,
    price,
    preMarketPrice,
    postMarketPrice,
    regularMarketPrice,
    previousClose,
    changePercent,
    preMarketChangePercent,
    preMarketVolume,
    regularMarketVolume,
    postMarketVolume,
    volume,
    volumeSource,
    averageVolume,
    volumeRatio,
    relativeVolume: volumeRatio,
    marketCap: num(quote.marketCap),
    exchange: quote.fullExchangeName || quote.exchange || null,
    currency: quote.currency || "USD",
    marketState: quote.marketState || null,
    extendedHours: marketState === "PRE" || marketState === "POST" || marketState === "POSTPOST",
    sourceTags: [...sourceTags, "yahoo-v7-batch-base"],
    included: true,
    inScanUniverse: true,
    ...scores,
    selectionReasons: [
      changePercent !== null ? `Session move ${changePercent.toFixed(1)}%` : null,
      volumeRatio ? `Relative volume ${volumeRatio.toFixed(1)}x` : null,
    ].filter(Boolean),
  };
}

async function fetchBaseScannerPayload() {
  const candidateQuotes = await collectBaseScannerQuotes();
  const symbols = [...candidateQuotes.keys()];
  const quoteMap = await fetchBatchQuoteMap(symbols);
  const rawItems = [];

  for (const [symbol, entry] of candidateQuotes) {
    const quote = quoteMap.get(symbol) || entry.quote;
    if (!quote?.symbol) continue;
    rawItems.push(buildBaseScannerItem(quote, [...entry.sourceTags]));
  }

  rawItems.sort(compareScannerItems);

  const items = selectBalancedScannerItems(rawItems, BASE_SCANNER_ITEM_LIMIT);

  return {
    ok: true,
    data: {
      updatedAt: new Date().toISOString(),
      source: BASE_SCANNER_SOURCE,
      candidateCount: rawItems.length,
      underOneCandidateCount: rawItems.filter(isUnderOneScannerItem).length,
      items,
    },
  };
}

module.exports = async function handler(req, res) {
  const requestStartedAt = Date.now();
  const requestId = headerValue(req.headers, "x-request-id") || makeRequestId("scanner");
  console.log(`[SCANNER] start requestId=${requestId}`);
  try {
    const baseStartedAt = Date.now();
    const payload = await fetchBaseScannerPayload();
    const upstreamItems = Array.isArray(payload?.data?.items) ? payload.data.items.length : 0;
    logScannerStep("base scanner fetch", baseStartedAt, {
      requestId,
      status: 200,
      items: upstreamItems,
    });

    if (payload?.data?.items && Array.isArray(payload.data.items)) {
      const rankedForVolume = [...payload.data.items]
        .sort((a, b) => {
          const aVolume = Math.max(num(a.volume) ?? 0, num(a.preMarketVolume) ?? 0);
          const bVolume = Math.max(num(b.volume) ?? 0, num(b.preMarketVolume) ?? 0);
          const aScore = num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0;
          const bScore = num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0;
          return bVolume - aVolume || bScore - aScore;
        })
        .slice(0, ENRICH_SYMBOL_LIMIT);
      const enrichSymbols = new Set(rankedForVolume.map((item) => item.symbol));
      const symbols = payload.data.items.map((item) => String(item?.symbol || "").toUpperCase()).filter(Boolean);
      const sessionType = getSessionType(new Date());
      const chartSymbols = symbols.filter((symbol) => enrichSymbols.has(symbol));
      const batchQuotePromise = (async () => {
        const batchQuoteStartedAt = Date.now();
        const map = await fetchBatchQuoteMap(symbols);
        logScannerStep("batch quote fetch", batchQuoteStartedAt, {
          requestId,
          symbols: symbols.length,
          quotes: map.size,
        });
        return map;
      })();
      const chartSnapshotsPromise = (async () => {
        const chartStartedAt = Date.now();
        const snapshots = await mapWithLimit(chartSymbols, 4, async (symbol) => [symbol, await fetchChartSnapshot(symbol)]);
        logScannerStep("chart enrich", chartStartedAt, {
          requestId,
          symbols: chartSymbols.length,
        });
        return snapshots;
      })();
      const localQuoteSnapshotsPromise = (async () => {
        const quoteStartedAt = Date.now();
        const snapshots = await mapWithLimit(chartSymbols, 2, async (symbol) => [symbol, await fetchLocalQuoteSnapshot(symbol, requestId)]);
        logScannerStep("quote enrich", quoteStartedAt, {
          requestId,
          symbols: chartSymbols.length,
          enabled: true,
        });
        return snapshots;
      })();
      const localHistorySnapshotsPromise = (async () => {
        const historyStartedAt = Date.now();
        const snapshots = sessionType === "DAY"
          ? await mapWithLimit(chartSymbols, 2, async (symbol) => [symbol, await fetchLocalHistorySnapshot(symbol, "1m", requestId)])
          : [];
        logScannerStep("history enrich", historyStartedAt, {
          requestId,
          symbols: chartSymbols.length,
          enabled: sessionType === "DAY",
        });
        return snapshots;
      })();
      const [batchQuoteMap, chartSnapshots, localQuoteSnapshots, localHistorySnapshots] = await Promise.all([
        batchQuotePromise,
        chartSnapshotsPromise,
        localQuoteSnapshotsPromise,
        localHistorySnapshotsPromise,
      ]);
      const chartMap = new Map(chartSnapshots);
      const localQuoteMap = new Map(localQuoteSnapshots);
      const localHistoryMap = new Map(localHistorySnapshots);
      const normalizeStartedAt = Date.now();
      const metrics = {
        volumeProfileCount: 0,
        volumeProfileMs: 0,
      };

      payload.data.items = (await mapWithLimit(payload.data.items, 2, async (item) => {
        const symbolKey = String(item?.symbol || "").toUpperCase();
        const yahooChartSnapshot = chartMap.get(symbolKey) || {};
        const localQuoteSnapshot = localQuoteMap.get(symbolKey) || {};
        const localHistorySnapshot = localHistoryMap.get(symbolKey) || {};
        const chartSnapshot = Array.isArray(localHistorySnapshot?.bars) && localHistorySnapshot.bars.length
          ? buildChartSnapshotFromHistory(localHistorySnapshot)
          : yahooChartSnapshot;
        const quoteSnapshot = mergeSnapshots(batchQuoteMap.get(symbolKey) || {}, localQuoteSnapshot);
        const preNormalizedLiveQuote = normalizeLiveQuote(item, quoteSnapshot, chartSnapshot);
        const normalizedItem = await normalizeItem(
          { ...item, ...compactObject(preNormalizedLiveQuote) },
          enrichSymbols.has(item.symbol),
          metrics,
        );
        const liveQuote = normalizeLiveQuote(
          normalizedItem,
          quoteSnapshot,
          chartSnapshot,
        );
        const commonSignals = chartSnapshot.commonSignals || calculateCommonSignals([]);
        const rankAuxiliaryScore = commonSignalBoost(commonSignals);
        const baseScannerScore = num(normalizedItem.scannerScore) ?? 0;
        const baseFinalScore = num(normalizedItem.finalProbabilityScore) ?? 0;
        const boostedScannerScore = Math.round(clamp(baseScannerScore + rankAuxiliaryScore));
        const boostedFinalScore = Math.round(clamp(baseFinalScore + rankAuxiliaryScore));
        const quality = volumeQualityScore({ ...normalizedItem, ...compactObject(liveQuote) });
        const surgeAcceleration = calculateSurgeAccelerationScore(chartSnapshot.bars || [], normalizedItem, liveQuote, commonSignals);
        const earlyMomentumBonus = computeEarlyMomentumBonus(normalizedItem, quality, surgeAcceleration, liveQuote, commonSignals);
        const liquidityMomentumBonus = computeLiquidityMomentumBonus({ ...normalizedItem, ...compactObject(liveQuote) }, quality, surgeAcceleration);
        const volumeAdjustedFinalScore = Math.round(clamp(
          boostedFinalScore * 0.58
          + quality.score * 0.22
          + surgeAcceleration.surgeAccelerationScore * 0.20
          + earlyMomentumBonus,
        ));
        const finalProbabilityScore = quality.score < 30
          ? Math.min(volumeAdjustedFinalScore, 69)
          : volumeAdjustedFinalScore;
        const scannerScore = quality.score < 30
          ? Math.min(boostedScannerScore, 69)
          : Math.max(baseScannerScore, boostedScannerScore);
        const debugQuoteSource = debugQuoteSourceLabel(localQuoteSnapshot, batchQuoteMap.has(symbolKey));
        const debugHistorySource = debugHistorySourceLabel(localHistorySnapshot, chartMap.has(symbolKey));
        const debugFallback = debugFallbackReason({
          sessionType,
          localQuoteSnapshot,
          localHistorySnapshot,
          mergedQuoteSnapshot: quoteSnapshot,
          liveQuote,
          chartSnapshot,
        });
        const responseItem = {
          ...normalizedItem,
          ...compactObject(liveQuote),
          price: liveQuote.price ?? null,
          normalizedLivePriceUsd: liveQuote.normalizedLivePriceUsd ?? null,
          change: liveQuote.change ?? null,
          changePercent: liveQuote.changePercent ?? null,
          preMarketChange: liveQuote.preMarketChange ?? null,
          preMarketChangePercent: liveQuote.preMarketChangePercent ?? null,
          regularMarketChangePercent: liveQuote.regularMarketChangePercent ?? null,
          postMarketChangePercent: liveQuote.postMarketChangePercent ?? null,
          volume: liveQuote.volume ?? null,
          ...commonSignals,
          rankAuxiliaryScore,
          ...surgeAcceleration,
          volumeQualityScore: quality.score,
          tradeValueKrw: quality.tradeValueKrw,
          earlyMomentumBonus,
          liquidityMomentumBonus,
          scannerScore,
          finalProbabilityScore,
        };
        if (symbolKey === "RMSG") {
          console.log("[SCANNER:RMSG:SESSION_FIELDS] " + JSON.stringify({
            symbol: responseItem.symbol,
            price: responseItem.price,
            regularMarketPrice: responseItem.regularMarketPrice,
            preMarketPrice: responseItem.preMarketPrice,
            postMarketPrice: responseItem.postMarketPrice ?? null,
            previousClose: responseItem.previousClose,
            regularMarketPreviousClose: responseItem.regularMarketPreviousClose,
            change: responseItem.change,
            changePercent: responseItem.changePercent,
            preMarketChange: responseItem.preMarketChange,
            preMarketChangePercent: responseItem.preMarketChangePercent,
            volume: responseItem.volume,
            regularMarketVolume: responseItem.regularMarketVolume ?? null,
            preMarketVolume: responseItem.preMarketVolume ?? null,
            chartVolume: responseItem.chartVolume ?? null,
            avgVolume: responseItem.avgVolume ?? responseItem.averageVolume,
            source: "scanner",
            priceSource: responseItem.priceSource,
            volumeSource: responseItem.volumeSource,
            marketState: responseItem.marketState,
            sessionType: responseItem.sessionType
          }));
        }
        const topPickEvaluation = evaluateTopPickForSnapshot(responseItem);
        const forbiddenPenalty = computeForbiddenPenalty(topPickEvaluation.topPickVerdict, topPickEvaluation.topPickChaseRisk);
        const marketPrioritySortScore = finalProbabilityScore + earlyMomentumBonus + liquidityMomentumBonus - forbiddenPenalty;

        return {
          ...responseItem,
          ...topPickEvaluation,
          forbiddenPenalty,
          marketPrioritySortScore,
          volumeQualitySortScore: marketPrioritySortScore + (quality.score * 0.03) + (surgeAcceleration.surgeAccelerationScore * 0.04),
          sourceTags: [...new Set([
            ...(Array.isArray(normalizedItem.sourceTags) ? normalizedItem.sourceTags : []),
            batchQuoteMap.has(symbolKey) ? "yahoo-v7-batch" : null,
            chartMap.has(symbolKey) ? "yahoo-1m-live" : null,
            localQuoteSnapshot?.priceSource?.startsWith("kis") ? "kis-local-quote" : null,
            localHistorySnapshot?.historySource === "kis-daymarket-bars" ? "kis-local-history" : null,
            rankAuxiliaryScore > 0 ? "common-signal-rank-boost" : null,
          ].filter(Boolean))],
          debugQuoteSource,
          debugHistorySource,
          debugFallbackReason: debugFallback,
          selectionReasons: [
            ...(Array.isArray(normalizedItem.selectionReasons) ? normalizedItem.selectionReasons : []),
            rankAuxiliaryScore > 0 ? `Common signal boost +${rankAuxiliaryScore}` : null,
            quality.score < 30 ? "Volume quality under 30: demoted from top candidates" : null,
          ].filter(Boolean),
        };
      }))
        .sort((a, b) => {
          const aPrice = num(a.price) ?? num(a.preMarketPrice) ?? 0;
          const bPrice = num(b.price) ?? num(b.preMarketPrice) ?? 0;
          const sameDollarBucket = (aPrice < 1 && bPrice < 1) || (aPrice >= 1 && bPrice >= 1);
          const sortDiff = (num(b.marketPrioritySortScore) ?? num(b.volumeQualitySortScore) ?? num(b.finalProbabilityScore) ?? 0)
            - (num(a.marketPrioritySortScore) ?? num(a.volumeQualitySortScore) ?? num(a.finalProbabilityScore) ?? 0);
          if (sameDollarBucket && Math.abs(sortDiff) <= 3) {
            return (num(b.volumeQualitySortScore) ?? 0) - (num(a.volumeQualitySortScore) ?? 0);
          }
          return sortDiff;
        });
      logScannerElapsed("volume profile", metrics.volumeProfileMs, {
        requestId,
        calls: metrics.volumeProfileCount,
      });
      logScannerStep("normalize items", normalizeStartedAt, {
        requestId,
        items: payload.data.items.length,
      });
    }

    res.setHeader("cache-control", "no-store");
    logScannerStep("completed", requestStartedAt, {
      requestId,
      status: 200,
      enrichLimit: ENRICH_SYMBOL_LIMIT,
    });
    console.log(`[SCANNER] end requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms status=200`);
    res.status(200).json(payload);
  } catch (error) {
    logScannerStep("completed", requestStartedAt, {
      requestId,
      status: 502,
    });
    console.log(`[SCANNER] end requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms status=502`);
    res.status(502).json({
      ok: false,
      message: error instanceof Error ? error.message : "scanner proxy failed",
    });
  }
};
