const PRO_ROUTES = {
  "/backtest": "backtest-panel",
  "/ai-analysis": "debug-panel",
};

function ready(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function money(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "-";
  return value >= 10 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

function wonMoney(n, rate = currentUsdKrw()) {
  const value = Number(n);
  if (!Number.isFinite(value) || !Number.isFinite(rate) || rate <= 0) return "-";
  return `${Math.round(value * rate).toLocaleString("ko-KR")}원`;
}

function pairedMoney(n, rate = currentUsdKrw()) {
  const usd = money(n);
  const krw = wonMoney(n, rate);
  if (usd === "-" || krw === "-") return usd;
  return `${krw} (${usd})`;
}

function pct(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function compact(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function livePriceOf(item) {
  return toNumber(item?.normalizedLivePriceUsd)
    ?? toNumber(item?.price)
    ?? toNumber(item?.preMarketPrice)
    ?? toNumber(item?.postMarketPrice)
    ?? toNumber(item?.regularMarketPrice);
}

function rvolValue(item) {
  return toNumber(item?.volumeRatio ?? item?.relativeVolume);
}

function topPickItemField(item, key) {
  return toNumber(item?.[key]) ?? toNumber(item?.technical?.[key]);
}

function clampTopPickScore(value, min = 0, max = 100) {
  const n = toNumber(value);
  if (n === null) return min;
  return Math.max(min, Math.min(max, n));
}

const FINAL_DECISION = {
  BUY_NOW: { key: "buy_now", label: "🟢 즉시 매수", tone: "buy", minConf: 85, maxConf: 100 },
  PULLBACK: { key: "pullback", label: "🟡 눌림 대기", tone: "pullback", minConf: 70, maxConf: 85 },
  WATCH: { key: "watch", label: "⚪ 관찰", tone: "watch", minConf: 50, maxConf: 70 },
  BLOCK: { key: "block", label: "🔴 진입 금지", tone: "block", minConf: 0, maxConf: 50 },
};

function fdClamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function fdConfidenceInBand(band, score01) {
  const span = band.maxConf - band.minConf;
  return fdClamp(band.minConf + span * Math.max(0, Math.min(1, score01)));
}

function deriveScalpSignal(item, setup = {}) {
  const rvol = toNumber(item?.volumeRatio ?? item?.relativeVolume) ?? setup.rvol ?? 0;
  const volumeAcceleration = topPickItemField(item, "volumeAccelerationScore") ?? setup.volumeAcceleration ?? 50;
  const higherLow = topPickItemField(item, "higherLowScore") ?? setup.higherLow ?? 50;
  const reSurge = topPickItemField(item, "reSurgeSetupScore") ?? setup.resurge ?? 50;
  const change = toNumber(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const rsi = toNumber(item?.rsi ?? item?.technical?.rsi) ?? setup.rsi ?? null;

  const vwapAbove = setup.vwapAbove === true;
  const vwapNear = setup.vwapNear === true;
  const vwapBelow = setup.vwapBelow === true;
  const vwapGood = vwapAbove || vwapNear || setup.vwapRecovering === true;

  const price = toNumber(item?.price ?? item?.preMarketPrice) ?? 0;
  const dayHigh = toNumber(item?.dayHigh ?? item?.regularMarketDayHigh);
  const highPullbackPct = price > 0 && dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : null;

  const overheated = setup.overheated === true || change >= 80 || (rsi !== null && rsi >= 80);
  const priceWeak = change < 0 || String(item?.oneMinuteTrend ?? "").toLowerCase().includes("down");
  const vwapWeak = vwapBelow && !vwapNear;

  let risk = 0;
  if (overheated) risk += 12;
  if (highPullbackPct !== null && highPullbackPct >= 25) risk += 10;
  if (vwapWeak && priceWeak) risk += 10;
  if (setup.highFailed) risk += 8;
  if (setup.extremeRvolWeak) risk += 10;
  risk = fdClamp(risk, 0, 50);

  const volumeOk = rvol >= 3 || (rvol >= 1.2 && (volumeAcceleration >= 70 || reSurge >= 70));
  const caution = risk >= 38 || overheated || (highPullbackPct !== null && highPullbackPct >= 25) || (vwapWeak && priceWeak);
  const buyReady = vwapGood
    && !vwapBelow
    && higherLow >= 58
    && volumeAcceleration >= 50
    && volumeOk
    && risk < 34
    && !overheated;

  if (buyReady) return { action: "매수 가능", tone: "buy" };
  if (caution) return { action: "진입 주의", tone: "avoid" };
  if ((vwapNear || (topPickItemField(item, "vwapReclaimScore") ?? 0) >= 60) && volumeOk && higherLow >= 50 && change >= 1 && change <= 55) {
    return { action: "관심 유지", tone: "watch" };
  }
  return { action: "관찰", tone: "hold" };
}

function computeChaseRisk(item, ctx = {}) {
  const risk = toNumber(item?.riskScore) ?? ctx.risk ?? 50;
  const change = toNumber(item?.changePercent ?? item?.preMarketChangePercent) ?? ctx.change ?? 0;
  const vwapGood = ctx.vwapGood === true;
  const trendGood = ctx.trendGood === true;
  const riskPenalty = toNumber(ctx.riskPenalty) ?? toNumber(ctx.setup?.riskPenalty) ?? 0;

  return fdClamp(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
      + riskPenalty * 0.8,
  );
}

function fdVwapFlags(setup = {}, vwapLabel = "") {
  const label = String(vwapLabel ?? "");
  const above = setup.vwapAbove === true || label.includes("위");
  const near = setup.vwapNear === true || label.includes("근처") || label.toLowerCase().includes("near");
  const below = setup.vwapBelow === true || label.includes("아래") || label.toLowerCase().includes("below");
  return { above, near, below, farBelow: below && !near };
}

function buildFinalDecisionReasons(input, scalp) {
  const positive = [];
  const warning = [];
  const accelerationLabel = String(input.accelerationLabel ?? "");

  if (input.volumeQualityScore >= 60) positive.push("거래량 품질 우수");
  if (accelerationLabel === "수급 가속도 강함") positive.push(accelerationLabel);
  else if (accelerationLabel === "수급 가속도 보통") positive.push(accelerationLabel);
  else if (accelerationLabel === "가속도 데이터 부족") positive.push(accelerationLabel);
  else if (input.surgeAccelerationScore >= 60) positive.push("최근 거래량 가속도 강함");
  if (input.vwapAbove) positive.push("VWAP 위 유지");
  else if (input.vwapNear) positive.push("VWAP 근처");
  if (input.higherLow >= 60) positive.push("Higher Low 형성");
  if (scalp.action === "매수 가능") positive.push(`실시간 단타 시그널: ${scalp.action}`);

  warning.push(`추격 위험 ${input.chaseRisk}`);
  if (input.rsi !== null && input.rsi >= 70) warning.push(`RSI ${Math.round(input.rsi)}`);
  if (input.change >= 42) warning.push(`당일 +${input.change.toFixed(1)}% 상승`);
  if (input.vwapFarBelow) warning.push("VWAP 크게 이탈");
  if (accelerationLabel === "수급 가속도 약함") warning.push(accelerationLabel);
  else if (!accelerationLabel && input.surgeAccelerationScore < 60) warning.push("수급 가속도 약함");
  if (scalp.action === "진입 주의") warning.push(`실시간 단타 시그널: ${scalp.action}`);
  if (scalp.action === "관심 유지") warning.push(`실시간 단타 시그널: ${scalp.action}`);

  return { positive: positive.slice(0, 6), warning: warning.slice(0, 6) };
}

function finalDecision(input) {
  const item = input.item ?? {};
  const setup = input.setup ?? {};
  const scalp = input.scalpAction
    ? { action: input.scalpAction, tone: "custom" }
    : deriveScalpSignal(item, setup);

  const top = toNumber(input.topPickScore) ?? 0;
  const vq = toNumber(input.volumeQualityScore) ?? 0;
  const sa = toNumber(input.surgeAccelerationScore) ?? 0;
  const chaseRisk = toNumber(input.chaseRisk) ?? 0;
  const rsi = toNumber(input.rsi) ?? setup.rsi ?? null;
  const change = toNumber(input.change) ?? 0;
  const higherLow = toNumber(input.higherLow) ?? topPickItemField(item, "higherLowScore") ?? setup.higherLow ?? 0;
  const vw = fdVwapFlags(setup, input.vwapLabel);
  const vwapAbove = input.vwapAbove === true || vw.above;
  const vwapNear = input.vwapNear === true || vw.near;
  const vwapFarBelow = input.vwapFarBelow === true || vw.farBelow;

  const ctx = {
    topPickScore: top,
    volumeQualityScore: vq,
    surgeAccelerationScore: sa,
    accelerationLabel: input.accelerationLabel,
    chaseRisk,
    vwapAbove,
    vwapNear,
    vwapFarBelow,
    rsi,
    change,
    higherLow,
  };
  const reasons = buildFinalDecisionReasons(ctx, scalp);

  const blockHit =
    (rsi !== null && rsi >= 80)
    || change >= 80
    || vwapFarBelow
    || chaseRisk >= 75
    || sa < 40
    || setup.overheated
    || setup.highFailed
    || setup.extremeRvolWeak
    || scalp.action === "진입 주의";

  if (blockHit) {
    const severity =
      (change >= 80 ? 0.25 : 0)
      + (vwapFarBelow ? 0.2 : 0)
      + (chaseRisk >= 75 ? 0.25 : 0)
      + (sa < 40 ? 0.15 : 0)
      + (scalp.action === "진입 주의" ? 0.15 : 0);
    return {
      ...FINAL_DECISION.BLOCK,
      confidence: fdConfidenceInBand(FINAL_DECISION.BLOCK, 1 - Math.min(1, severity)),
      scalpAction: scalp.action,
      chaseRisk,
      reasons,
    };
  }

  const buyReady =
    top >= 80
    && vq >= 60
    && sa >= 60
    && vwapAbove
    && !vwapFarBelow
    && scalp.action === "매수 가능"
    && chaseRisk < 35;

  if (buyReady) {
    const fit =
      (top >= 80 ? 0.2 : 0)
      + (vq >= 60 ? 0.2 : 0)
      + (sa >= 60 ? 0.2 : 0)
      + (chaseRisk < 25 ? 0.2 : chaseRisk < 35 ? 0.1 : 0)
      + (scalp.action === "매수 가능" ? 0.2 : 0);
    return {
      ...FINAL_DECISION.BUY_NOW,
      confidence: fdConfidenceInBand(FINAL_DECISION.BUY_NOW, 0.85 + fit * 0.15),
      scalpAction: scalp.action,
      chaseRisk,
      reasons,
    };
  }

  const pullbackHit =
    scalp.action === "관심 유지"
    || (top >= 75 && (vwapNear || chaseRisk >= 35 || (change >= 45 && change < 80)));

  if (pullbackHit) {
    const fit =
      (scalp.action === "관심 유지" ? 0.35 : 0.15)
      + (top >= 75 ? 0.25 : 0)
      + (vwapNear ? 0.2 : 0)
      + (chaseRisk >= 35 && chaseRisk < 75 ? 0.2 : 0);
    return {
      ...FINAL_DECISION.PULLBACK,
      confidence: fdConfidenceInBand(FINAL_DECISION.PULLBACK, 0.55 + fit * 0.45),
      scalpAction: scalp.action,
      chaseRisk,
      reasons,
    };
  }

  const watchFit = Math.min(1, (top / 100) * 0.4 + (vq / 100) * 0.3 + (sa / 100) * 0.3);
  return {
    ...FINAL_DECISION.WATCH,
    confidence: fdConfidenceInBand(FINAL_DECISION.WATCH, watchFit),
    scalpAction: scalp.action,
    chaseRisk,
    reasons,
  };
}

function renderFinalDecisionHeroHtml(decision, escapeHtml = (v) => String(v ?? "")) {
  const tone = decision.tone || "watch";
  const pos = (decision.reasons?.positive ?? []).map((line) => `<li class="ok">✓ ${escapeHtml(line)}</li>`).join("");
  const warn = (decision.reasons?.warning ?? []).map((line) => `<li class="warn">⚠ ${escapeHtml(line)}</li>`).join("");
  return `
    <section class="kbk-final-decision-hero kbk-final-${tone}" aria-label="최종 판단">
      <p class="kbk-final-kicker">최종 판단</p>
      <strong class="kbk-final-label">${escapeHtml(decision.label)}</strong>
      <p class="kbk-final-confidence">신뢰도 <b>${escapeHtml(decision.confidence)}</b>점</p>
      <div class="kbk-final-reasons">
        <p class="kbk-final-reasons-title">판단 근거</p>
        <ul>${pos}${warn}</ul>
      </div>
    </section>
  `;
}

function formatKrwFromUsdDollar(dollarUsd) {
  const usd = toNumber(dollarUsd);
  const rate = currentUsdKrw();
  if (usd === null || usd <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  const krw = usd * rate;
  if (krw >= 100_000_000) return `약 ${(krw / 100_000_000).toFixed(1)}억원`;
  if (krw >= 10_000_000) return `약 ${Math.round(krw / 10_000_000)}천만 원`;
  return `약 ${Math.round(krw).toLocaleString("ko-KR")}원`;
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
  const score = Math.round(clampTopPickScore(volumeScore * 0.35 + rvolScore * 0.35 + dollarScore * 0.3));
  return {
    score,
    dollarVolume,
    rvolScore,
    strong: score >= 72,
    moderate: score >= 58,
    contributed: score >= 58 && (volume >= 500_000 || rvol >= 1.2 || (dollarVolume !== null && dollarVolume >= 500_000)),
  };
}

function computeSurgeAccelerationScore(item) {
  const volumeAccelerationScore = topPickItemField(item, "volumeAccelerationScore") ?? 50;
  const momentumExpansionScore = topPickItemField(item, "momentumExpansionScore") ?? 50;
  const surgePrecursorScore = topPickItemField(item, "surgePrecursorScore") ?? 50;
  const accel1m = topPickItemField(item, "volumeAcceleration1m");
  const accel5m = topPickItemField(item, "volumeAcceleration5m");
  const accel5mWindow = topPickItemField(item, "volumeAcceleration5mWindow");
  const tradeValueAccel5mWindow = topPickItemField(item, "tradeValueAcceleration5mWindow");
  const hasAccelerationData = [accel1m, accel5m, accel5mWindow, tradeValueAccel5mWindow].some((value) => value !== null);
  let score = Math.round(clampTopPickScore(
    volumeAccelerationScore * 0.42
    + momentumExpansionScore * 0.28
    + surgePrecursorScore * 0.3
  ));
  if (accel5m !== null && accel5m >= 2.2) score = Math.round(clampTopPickScore(score + 8));
  else if (accel5m !== null && accel5m >= 1.5) score = Math.round(clampTopPickScore(score + 4));
  if (accel1m !== null && accel1m >= 2) score = Math.round(clampTopPickScore(score + 3));
  const accelerationLabel = !hasAccelerationData
    ? "가속도 데이터 부족"
    : score >= 72
      ? "수급 가속도 강함"
      : score >= 58
        ? "수급 가속도 보통"
        : "수급 가속도 약함";
  return {
    score,
    volumeAccelerationScore,
    accel1m,
    accel5m,
    accel5mWindow,
    tradeValueAccel5mWindow,
    hasAccelerationData,
    accelerationLabel,
    strong: score >= 72,
    moderate: score >= 58,
    contributed: score >= 58 && (
      volumeAccelerationScore >= 60
      || (accel5m !== null && accel5m >= 1.35)
      || (accel1m !== null && accel1m >= 1.35)
      || momentumExpansionScore >= 65
    ),
  };
}

function renderTopPickSectionHtml(sections) {
  return sections.map((section) => `
    <div class="kbk-pro-top-explain-block">
      <strong>${textEscape(section.title)}</strong>
      <ul>${section.lines.map((line) => `<li>• ${textEscape(line)}</li>`).join("")}</ul>
    </div>
  `).join("");
}

function topPickSetupProfile(item, price, volume, change) {
  const rvol = rvolValue(item);
  const rsi = toNumber(item?.rsi ?? item?.technical?.rsi);
  const dayHigh = toNumber(item?.dayHigh ?? item?.regularMarketDayHigh);
  const dayLow = toNumber(item?.dayLow ?? item?.regularMarketDayLow);
  const vwap = toNumber(item?.technical?.vwap ?? item?.vwap);
  const vwapState = String(item?.technical?.vwapState ?? item?.vwapState ?? "").toLowerCase();
  const highPullbackPct = price > 0 && dayHigh > 0 ? ((dayHigh - price) / dayHigh) * 100 : null;
  const highPosition = price > 0 && dayHigh > 0 && dayLow > 0 && dayHigh > dayLow
    ? ((price - dayLow) / (dayHigh - dayLow)) * 100
    : null;
  const vwapAbove = item?.aboveVwap === true || vwapState === "above" || (price > 0 && vwap > 0 && price >= vwap);
  const vwapNear = !vwapAbove && price > 0 && vwap > 0 && price >= vwap * 0.985;
  const vwapBelow = item?.aboveVwap === false || vwapState === "below" || (price > 0 && vwap > 0 && price < vwap * 0.985);
  const volumeAcceleration = toNumber(item?.volumeAccelerationScore) ?? 50;
  const higherLow = toNumber(item?.higherLowScore) ?? 50;
  const vwapHold = toNumber(item?.vwapHoldScore) ?? 50;
  const compression = toNumber(item?.compressionScore) ?? 50;
  const resurge = toNumber(item?.reSurgeSetupScore) ?? 50;
  const reclaim = toNumber(item?.vwapReclaimScore) ?? 50;

  const overheated = change >= 80 || rsi >= 80;
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
    + (lowRecovery ? 2 : 0)
  )));
  const riskPenalty = Math.max(0, Math.min(32, Math.round(
    (overheated ? 12 : 0)
    + (veryExtended ? 10 : 0)
    + (highFailed ? 8 : 0)
    + (extremeRvolWeak ? 10 : 0)
    + (vwapBelow && change < 0 ? 8 : 0)
  )));

  return {
    rvol,
    rsi,
    highPullbackPct,
    highPosition,
    vwapAbove,
    vwapNear,
    vwapBelow,
    volumeAcceleration,
    higherLow,
    vwapHold,
    compression,
    resurge,
    reclaim,
    earlyBonus,
    riskPenalty,
    overheated,
    highFailed,
    extremeRvolWeak,
    volumeStarting,
    lowRecovery,
    vwapRecovering,
    notOverChased,
  };
}

function topPickSignalScore(item, price, volume, change) {
  const setup = topPickSetupProfile(item, price, volume, change);
  const volumeAcceleration = toNumber(item?.volumeAccelerationScore) ?? 50;
  const higherLow = toNumber(item?.higherLowScore) ?? 50;
  const vwapHold = toNumber(item?.vwapHoldScore) ?? 50;
  const compression = toNumber(item?.compressionScore) ?? 50;
  const resurge = toNumber(item?.reSurgeSetupScore) ?? 50;
  const reclaim = toNumber(item?.vwapReclaimScore) ?? 50;
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

function topPickReasoning(item, metrics) {
  const setup = metrics.setup ?? {};
  const price = metrics.price ?? livePriceOf(item) ?? 0;
  const volume = metrics.volume ?? toNumber(item?.volume ?? item?.preMarketVolume) ?? 0;
  const rvol = metrics.rvol ?? rvolValue(item) ?? 1;
  const volumeQuality = computeVolumeQualityScore(item, price, volume, rvol);
  const surgeAcceleration = computeSurgeAccelerationScore(item);

  const legacyReasons = [];
  if (setup.volumeStarting) legacyReasons.push("거래량이 증가하기 시작했습니다");
  if (metrics.rvol !== null && metrics.rvol >= 3) legacyReasons.push(`RVOL ${metrics.rvol.toFixed(1)}배로 기준 이상입니다`);
  if (topPickItemField(item, "volumeAccelerationScore") >= 65) legacyReasons.push("거래량 가속도가 양호합니다");
  if (setup.vwapRecovering) legacyReasons.push(setup.vwapAbove ? "VWAP 위에서 상승 흐름입니다" : "VWAP 회복을 시도 중입니다");
  if (topPickItemField(item, "higherLowScore") >= 65) legacyReasons.push("Higher Low 구조가 감지됩니다");
  if (topPickItemField(item, "reSurgeSetupScore") >= 65) legacyReasons.push("눌림 후 재상승 가능성이 있습니다");
  if (setup.lowRecovery) legacyReasons.push("가격이 하단에서 회복 중입니다");
  if (topPickItemField(item, "compressionScore") >= 70) legacyReasons.push("박스권 압축이 확인됩니다");

  const volumeQualityLines = [];
  const surgeAccelerationLines = [];
  const technicalLines = [];
  const cautions = [];

  if (volumeQuality.contributed) {
    volumeQualityLines.push(`거래량 품질 점수 ${volumeQuality.score}점`);
    if (volume >= 500_000) volumeQualityLines.push(`거래량 ${compact(volume)}`);
    const dollarText = formatKrwFromUsdDollar(volumeQuality.dollarVolume);
    if (dollarText) volumeQualityLines.push(`거래대금 ${dollarText}`);
    if (rvol >= 1.5 && volumeQuality.rvolScore >= 48) {
      volumeQualityLines.push(`RVOL ${rvol.toFixed(1)}배로 평균 대비 거래가 붙었습니다`);
    }
  }

  if (surgeAcceleration.contributed) {
    if (surgeAcceleration.accel5m !== null && surgeAcceleration.accel5m >= 1.35) {
      surgeAccelerationLines.push(`최근 5분 거래량 ${surgeAcceleration.accel5m.toFixed(1)}배 증가`);
      surgeAccelerationLines.push(`최근 5분 거래대금 ${surgeAcceleration.accel5m.toFixed(1)}배 증가`);
    }
    if (surgeAcceleration.accel1m !== null && surgeAcceleration.accel1m >= 1.35) {
      surgeAccelerationLines.push(`최근 1분 거래량 ${surgeAcceleration.accel1m.toFixed(1)}배 증가`);
    }
    if (surgeAcceleration.strong) {
      surgeAccelerationLines.push(`급등 가속도 점수 ${surgeAcceleration.score}점`);
    } else if (surgeAcceleration.moderate) {
      surgeAccelerationLines.push(`수급 가속 점수 ${surgeAcceleration.score}점`);
    }
  }

  if (setup.vwapAbove) technicalLines.push("VWAP 위 유지");
  else if (topPickItemField(item, "vwapReclaimScore") >= 60) technicalLines.push("VWAP 회복 시도");
  if (topPickItemField(item, "higherLowScore") >= 60) technicalLines.push("Higher Low 형성");
  if (topPickItemField(item, "compressionScore") >= 70) technicalLines.push("박스권 돌파 시도");
  if (topPickItemField(item, "reSurgeSetupScore") >= 65) technicalLines.push("눌림 후 재상승 구조");

  if (setup.highFailed) cautions.push("이미 단기 고점 대비 급락 후 반등에 실패했습니다");
  if (setup.rsi !== null && setup.rsi >= 70) cautions.push(`RSI ${Math.round(setup.rsi)}`);
  if (metrics.change >= 42) cautions.push(`당일 ${pct(metrics.change)} 상승`);
  if (setup.extremeRvolWeak) cautions.push("RVOL은 높지만 가격 추세가 약합니다");
  if (setup.vwapBelow) cautions.push("VWAP 아래");
  if (metrics.risk >= 70) cautions.push("추격 위험 점수가 높습니다");

  const sections = [];
  if (volumeQualityLines.length) sections.push({ title: "거래량 품질", lines: volumeQualityLines });
  if (surgeAccelerationLines.length) sections.push({ title: "수급 가속도", lines: surgeAccelerationLines });
  if (technicalLines.length) sections.push({ title: "기술적 패턴", lines: technicalLines });

  let decision = "관찰";
  if (setup.overheated || setup.highFailed || setup.extremeRvolWeak || metrics.risk >= 78 || metrics.finalScore < 58) {
    decision = "진입 금지";
  } else if (metrics.finalScore >= 74 && setup.volumeStarting && setup.vwapRecovering && !setup.vwapBelow && metrics.risk < 70) {
    decision = "매수 가능";
  }

  const reasons = legacyReasons.length ? legacyReasons.slice(0, 6) : ["초입 회복 조건을 관찰 중입니다"];

  return {
    reasons,
    cautions: cautions.length ? cautions.slice(0, 5) : ["실제 진입 전 VWAP/체결 반응을 확인하세요"],
    sections,
    decision,
    priority: decision === "매수 가능" ? 3 : decision === "관찰" ? 2 : 0,
    volumeQualityScore: volumeQuality.score,
    surgeAccelerationScore: surgeAcceleration.score,
    hasAccelerationData: surgeAcceleration.hasAccelerationData,
    accelerationLabel: surgeAcceleration.accelerationLabel,
  };
}

function textEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function patchFloatingPointText(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const before = node.nodeValue;
    if (!before || !/\d+\.\d{3,}점/.test(before)) continue;
    node.nodeValue = before.replace(/(\d+\.\d{3,})점/g, (_, raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? `${Math.round(value)}점` : `${raw}점`;
    });
  }
}

function ensureStyles() {
  if (document.getElementById("kbk-pro-trading-style")) return;
  const style = document.createElement("style");
  style.id = "kbk-pro-trading-style";
  style.textContent = `
    .topbar{padding:16px 20px!important;border-radius:18px!important;align-items:center!important}
    .brand-block h1{font-size:clamp(1.45rem,2.2vw,2.25rem)!important;margin:4px 0 6px!important;letter-spacing:0!important}
    .summary{font-size:.92rem!important;max-width:88ch!important}
    .disclaimer-pill{padding:9px 12px!important;border-radius:14px!important;font-size:.82rem!important}
    .menu-bar{margin:12px 0 14px!important;gap:8px!important}
    .menu-link{padding:9px 13px!important;border-radius:12px!important;font-size:.92rem!important}
    .accumulation-hero{padding:18px!important;border-radius:18px!important;grid-template-columns:minmax(0,1.3fr) minmax(280px,.7fr)!important}
    .accumulation-hero h2{font-size:clamp(1.35rem,2.2vw,2.1rem)!important;margin:4px 0 8px!important}
    .score-card{border-radius:12px!important;padding:12px 14px!important}
    .score-card strong{font-size:1.12rem!important}
    .toolbar{align-items:center!important;gap:10px!important}
    .search-box input,.holdings-form input{border-radius:10px!important;padding:11px 12px!important}
    .filter-chip{border-radius:12px!important;padding:10px 13px!important}
    .weight-guide{grid-template-columns:repeat(5,minmax(130px,1fr))!important;gap:8px!important}
    .weight-guide div{border-radius:12px!important;padding:12px 14px!important}
    .stock-grid{grid-template-columns:repeat(3,minmax(260px,1fr))!important;gap:10px!important}
    .stock-card{border-radius:14px!important;padding:14px!important;box-shadow:0 10px 28px rgba(15,23,42,.08)!important}
    .ticker-row h3{font-size:1.28rem!important}
    .company-name,.stock-note{font-size:.86rem!important;margin-top:7px!important}
    .price-row{gap:8px!important;margin-top:10px!important;font-size:.86rem!important}
    .score-number{font-size:2.1rem!important}
    .signal-box{min-width:86px!important}
    .metric-grid,.score-copy-grid,.forecast-grid{gap:8px!important;margin-top:12px!important}
    .metric-grid div,.score-copy-grid div,.forecast-card{border-radius:12px!important;padding:10px 12px!important}
    .reason-strip{margin-top:12px!important}
    .reason-chip,.type-chip,.accent-badge,.signal-tag{font-size:.72rem!important;padding:5px 8px!important}
    .kbk-empty-note{background:#fff7ed;border:1px solid rgba(249,115,22,.24);border-radius:14px;padding:14px 16px;color:#7c2d12;line-height:1.55}
    .kbk-route-note{background:#eff6ff;border:1px solid rgba(37,99,235,.22);border-radius:14px;padding:12px 14px;margin-bottom:12px;color:#1e3a8a;font-weight:800}
    .kbk-pro-refresh{position:fixed;right:18px;bottom:18px;z-index:50;border:0;border-radius:999px;background:#0f172a;color:#fff;padding:12px 16px;font-weight:900;box-shadow:0 12px 30px rgba(15,23,42,.24)}
    .kbk-pro-chart{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:12px;padding:12px;margin:12px 14px 0;box-shadow:0 10px 24px rgba(15,23,42,.08)}
    .kbk-pro-chart-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:8px}
    .kbk-pro-chart-head strong{display:block;color:#0f172a}
    .kbk-pro-chart-head span{display:block;color:#64748b;font-size:.78rem;margin-top:2px}
    .kbk-pro-chart svg{width:100%;height:auto;display:block}
    .kbk-pro-chart .axis{stroke:#e2e8f0;stroke-width:1}
    .kbk-pro-chart .wick{stroke-width:1.2}
    .kbk-pro-chart .up{stroke:#059669;fill:#10b981}
    .kbk-pro-chart .down{stroke:#dc2626;fill:#ef4444}
    .kbk-pro-chart .vwap{stroke:#2563eb;stroke-width:1.5;stroke-dasharray:5 4;fill:none}
    .kbk-pro-chart .level{stroke:#f59e0b;stroke-width:1.2;stroke-dasharray:4 4}
    .kbk-pro-chart .label{fill:#64748b;font-size:10px;font-weight:800}
    .kbk-pro-basis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 14px 0}
    .kbk-pro-basis div{background:#f8fafc;border:1px solid rgba(15,23,42,.08);border-radius:10px;padding:10px}
    .kbk-pro-basis span{display:block;color:#64748b;font-size:.76rem;font-weight:800}
    .kbk-pro-basis b{display:block;color:#0f172a;margin-top:4px}
    .kbk-pro-basis small{display:block;color:#64748b;margin-top:4px;line-height:1.35}
    .kbk-pro-fast-signal{border-radius:12px;padding:18px;margin:12px 14px;border:1px solid rgba(15,23,42,.12)}
    .kbk-pro-fast-signal span{display:block;font-size:.78rem;font-weight:900;margin-bottom:8px}
    .kbk-pro-fast-signal strong{display:block;font-size:2rem;line-height:1.05;margin-bottom:8px}
    .kbk-pro-fast-signal small{display:block;font-weight:900;color:#334155;margin-bottom:8px}
    .kbk-pro-fast-signal p{margin:0;color:#475569;font-weight:800;line-height:1.45}
    .kbk-pro-fast-buy{background:#ecfdf5;border-color:#86efac}
    .kbk-pro-fast-buy span,.kbk-pro-fast-buy strong{color:#047857}
    .kbk-pro-fast-profit{background:#fff7ed;border-color:#fdba74}
    .kbk-pro-fast-profit span,.kbk-pro-fast-profit strong{color:#c2410c}
    .kbk-pro-fast-hold{background:#fffbeb;border-color:#fbbf24}
    .kbk-pro-fast-hold span,.kbk-pro-fast-hold strong{color:#d97706}
    .kbk-pro-alert-box{background:#ecfeff;border:1px solid rgba(14,116,144,.24);border-radius:12px;padding:12px 14px;color:#155e75;margin:12px 0;font-weight:800;line-height:1.5}
    #kbk-pro-top-picks{display:grid;gap:12px}
    .kbk-pro-top-card{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:12px;padding:13px;display:grid;gap:9px;box-shadow:0 10px 28px rgba(15,23,42,.08)}
    .kbk-pro-top-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    .kbk-pro-top-head h3{margin:0;font-size:1.25rem;color:#0f172a}
    .kbk-pro-top-head p{margin:4px 0 0;color:#475569;font-size:.86rem}
    .kbk-pro-top-score{font-size:2rem;font-weight:950;color:#0f172a;line-height:1;text-align:right}
    .kbk-pro-top-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    .kbk-pro-top-grid div{background:#f8fafc;border-radius:10px;padding:9px}
    .kbk-pro-top-grid span{display:block;color:#64748b;font-size:.76rem}
    .kbk-pro-top-grid b{display:block;margin-top:4px;color:#0f172a}
    .kbk-pro-top-meta{display:grid;grid-template-columns:1fr 1fr 150px;gap:8px}
    .kbk-pro-top-meta div{background:#f8fafc;border:1px solid rgba(15,23,42,.08);border-radius:10px;padding:9px}
    .kbk-pro-top-meta span{display:block;color:#64748b;font-size:.74rem;font-weight:900;margin-bottom:5px}
    .kbk-pro-top-meta p{margin:0;color:#0f172a;font-size:.82rem;font-weight:800;line-height:1.45}
    .kbk-pro-top-decision{background:#eff6ff!important;border-color:rgba(37,99,235,.18)!important}
    .kbk-pro-top-decision b{display:block;color:#1d4ed8;font-size:.95rem}
    .kbk-pro-top-explain{display:grid;gap:10px;margin-top:8px}
    .kbk-pro-top-explain-block{background:#fff;border:1px solid rgba(15,23,42,.08);border-radius:10px;padding:10px}
    .kbk-pro-top-explain-block strong{display:block;color:#0f172a;margin-bottom:6px;font-size:.82rem}
    .kbk-pro-top-explain-block ul{margin:0;padding:0;list-style:none;display:grid;gap:5px}
    .kbk-pro-top-explain-block li{color:#334155;font-size:.8rem;font-weight:800;line-height:1.4}
    .kbk-pro-top-caution li{color:#b45309}
    .kbk-final-decision-hero{border-radius:14px;padding:16px 18px;margin-bottom:12px;border:2px solid rgba(15,23,42,.1)}
    .kbk-final-kicker{margin:0 0 6px;font-size:.78rem;font-weight:900;color:#64748b;letter-spacing:.04em}
    .kbk-final-label{display:block;font-size:clamp(1.45rem,3vw,2rem);font-weight:950;line-height:1.15;margin:0 0 8px}
    .kbk-final-confidence{margin:0 0 12px;font-size:.92rem;font-weight:800;color:#334155}
    .kbk-final-confidence b{font-size:1.15rem;color:inherit}
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
    @media (max-width:1100px){
      .accumulation-hero{grid-template-columns:1fr!important}
      .stock-grid{grid-template-columns:repeat(2,minmax(240px,1fr))!important}
      .weight-guide{grid-template-columns:repeat(2,minmax(0,1fr))!important}
    }
    @media (max-width:760px){
      .app-shell{padding:10px!important}
      .topbar{display:grid!important;padding:12px!important}
      .brand-block h1{font-size:1.28rem!important}
      .summary,.disclaimer-pill{font-size:.78rem!important}
      .stock-grid,.weight-guide,.hero-scoreboard,.metric-grid{grid-template-columns:1fr!important}
      .terminal-layout{grid-template-columns:1fr!important}
      .candidate-table,.signal-table,.debug-table{min-width:760px!important}
      .kbk-pro-top-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .kbk-pro-top-meta{grid-template-columns:1fr}
      .kbk-pro-basis{grid-template-columns:1fr}
    }
  `;
  document.head.appendChild(style);
}

function addRefreshShortcut() {
  if (!document.getElementById("kbk-pro-refresh")) {
    const button = document.createElement("button");
    button.id = "kbk-pro-refresh";
    button.className = "kbk-pro-refresh";
    button.type = "button";
    button.textContent = "?덈줈怨좎묠 R";
    button.addEventListener("click", () => refreshCurrentView());
    document.body.appendChild(button);
  }
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "r") return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    event.preventDefault();
    refreshCurrentView();
  });
}

function refreshCurrentView() {
  const visibleRefresh = Array.from(document.querySelectorAll("button"))
    .find((button) => /새로고침|감시 갱신|전체 분석/.test(button.textContent || "") && button.offsetParent);
  if (visibleRefresh) {
    visibleRefresh.click();
    return;
  }
  window.location.reload();
}

function ensureRouteLinks() {
  const menu = document.querySelector(".menu-bar");
  if (!menu) return;

  const configs = [
    { label: "백테스트", path: "/backtest", target: "backtest-panel" },
    { label: "AI 분석", path: "/ai-analysis", target: "debug-panel" },
    { label: "통합 최종 후보", path: "/top-picks", target: "kbk-pro-top-picks" },
  ];

  for (const config of configs) {
    let node = Array.from(menu.querySelectorAll(".menu-link"))
      .find((item) => item.textContent?.trim() === config.label);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "menu-link menu-button";
      node.textContent = config.label;
      menu.appendChild(node);
    }
    node.addEventListener("click", (event) => {
      event.preventDefault();
      history.pushState({}, "", config.path);
      handleRoute();
    });
  }
}

function isTopPicksViewActive() {
  return window.location.pathname === "/top-picks" || window.location.hash === "#top-picks";
}

function hideNonTopPicksPanels() {
  document.querySelectorAll(".page-stack > .page-panel").forEach((panel) => {
    panel.style.display = "none";
  });
  const legacyTopPicks = document.getElementById("kbk-top-picks-panel");
  if (legacyTopPicks) {
    legacyTopPicks.hidden = true;
    legacyTopPicks.style.display = "none";
  }
}

function topPicksOnlyPanel() {
  let panel = document.getElementById("kbk-pro-top-picks");
  const stack = document.querySelector(".page-stack");
  if (!panel && stack) {
    panel = document.createElement("section");
    panel.id = "kbk-pro-top-picks";
    stack.prepend(panel);
  }
  if (panel) {
    panel.hidden = false;
    panel.style.display = "grid";
  }
  return panel;
}

function showAllPanels() {
  if (isTopPicksViewActive()) {
    hideNonTopPicksPanels();
    return;
  }
  document.querySelectorAll(".page-stack > .page-panel").forEach((panel) => {
    panel.style.display = "";
  });
  const top = document.getElementById("kbk-pro-top-picks");
  if (top) top.remove();
}

function routeScroll(targetId, message) {
  showAllPanels();
  const target = document.getElementById(targetId);
  if (!target) return;
  if (!target.previousElementSibling?.classList?.contains("kbk-route-note")) {
    const note = document.createElement("div");
    note.className = "kbk-route-note";
    note.textContent = message;
    target.parentElement?.insertBefore(note, target);
  }
  window.setTimeout(() => target.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
  if (targetId === "backtest-panel") window.setTimeout(renderBacktestExpectation, 300);
}

let topPicksRouteBusyUntil = 0;

async function renderTopPicksOnly() {
  const now = Date.now();
  if (topPicksRouteBusyUntil > now) return;
  topPicksRouteBusyUntil = now + 800;
  hideNonTopPicksPanels();
  if (window.location.hash !== "#top-picks") {
    window.location.hash = "top-picks";
  }
  history.replaceState({}, "", "/top-picks");
  window.setTimeout(() => {
    topPicksRouteBusyUntil = 0;
  }, 250);
  const panel = topPicksOnlyPanel();
  if (!panel) return;
  panel.innerHTML = `<section class="kbk-route-note">?듯빀 理쒖쥌 ?꾨낫瑜?怨꾩궛?섎뒗 以묒엯?덈떎.</section>`;
  try {
    const payload = await fetch("/api/scanner", { cache: "no-store" }).then((res) => res.json());
    const items = (payload?.data?.items || [])
      .filter((item) => item?.symbol && item.included !== false)
      .map((item) => {
        const price = livePriceOf(item) ?? 0;
        const change = Number(item.changePercent ?? item.preMarketChangePercent ?? 0);
        const volume = Number(item.volume ?? item.preMarketVolume ?? 0);
        const surge = Math.round(Number(item.finalProbabilityScore ?? item.scannerScore ?? 0));
        const risk = Math.round(Number(item.riskScore ?? 50));
        const pattern = Math.round(Number(item.patternSimilarityScore ?? 50));
        const signal = topPickSignalScore(item, price, volume, change);
        const baseScore = surge * .55 + pattern * .2 + signal.volumeBonus + signal.changeBonus - risk * .12;
        const finalScore = Math.round(Math.max(0, Math.min(100, baseScore + signal.signalBonus)));
        const reasoning = topPickReasoning(item, {
          change,
          volume,
          price,
          surge,
          risk,
          pattern,
          finalScore,
          rvol: signal.rvol,
          setup: signal.setup,
        });
        const setup = signal.setup ?? {};
        let chaseRisk = 0;
        let fd = null;
        try {
          const trendRaw = String(item?.oneMinuteTrend ?? "").toLowerCase();
          const trendGood = trendRaw.includes("up") || trendRaw.includes("상승") || item?.technical?.ma5vs20 === "above";
          const vwapGood = setup.vwapAbove || setup.vwapNear || setup.vwapRecovering;
          chaseRisk = computeChaseRisk(item, {
            change,
            risk,
            vwapGood,
            trendGood,
            riskPenalty: setup.riskPenalty,
            setup,
          });
          fd = finalDecision({
            item,
            setup,
            topPickScore: finalScore,
            volumeQualityScore: reasoning.volumeQualityScore,
            surgeAccelerationScore: reasoning.surgeAccelerationScore,
            accelerationLabel: reasoning.accelerationLabel,
            chaseRisk,
            vwapAbove: setup.vwapAbove,
            vwapNear: setup.vwapNear,
            vwapFarBelow: setup.vwapBelow && !setup.vwapNear,
            rsi: setup.rsi,
            change,
            higherLow: setup.higherLow ?? topPickItemField(item, "higherLowScore"),
          });
        } catch (_) {
          chaseRisk = 0;
          fd = null;
        }
        return {
          item,
          price,
          change,
          volume,
          surge,
          risk,
          pattern,
          finalScore,
          signalBonus: signal.signalBonus,
          reasoning,
          chaseRisk,
          finalDecision: fd,
        };
      })
      .filter((pick) => pick.finalScore >= 58 || pick.reasoning.priority >= 2)
      .sort((a, b) => b.reasoning.priority - a.reasoning.priority || b.finalScore - a.finalScore)
      .slice(0, 20);
    panel.innerHTML = `
      <section class="accumulation-hero">
        <div>
          <p class="section-kicker">Integrated Picks</p>
          <h2>통합 최종 후보</h2>
          <p class="section-copy">실시간 단타 후보, 급등 감시, 매집/패턴 점수를 함께 보고 과열 위험은 감점해 우선순위를 둡니다.</p>
        </div>
        <div class="hero-scoreboard">
          <div class="score-card"><span>후보</span><strong>${items.length}</strong></div>
          <div class="score-card"><span>기준</span><strong>초입 우선</strong></div>
        </div>
      </section>
      ${items.length ? items.map(({ item, price, change, volume, surge, risk, pattern, finalScore, signalBonus, reasoning, chaseRisk, finalDecision: fd }) => `
        <article class="kbk-pro-top-card">
          ${fd ? renderFinalDecisionHeroHtml(fd, textEscape) : ""}
          <div class="kbk-pro-top-head">
            <div><h3>${textEscape(item.symbol)}</h3><p>${textEscape(item.name || item.symbol)}</p></div>
            <div class="kbk-pro-top-score">${finalScore}</div>
          </div>
          <div class="price-row">
            <strong>${pairedMoney(price)}</strong>
            <span>${pct(change)}</span>
            <span>거래량 ${compact(volume)}</span>
          </div>
          <div class="kbk-pro-top-grid">
            <div><span>급등 감시</span><b>${surge}점</b></div>
            <div><span>거래량 품질</span><b>${reasoning.volumeQualityScore ?? "-"}점</b></div>
            <div><span>수급 가속</span><b>${reasoning.surgeAccelerationScore ?? "-"}점</b></div>
            <div><span>추격 위험</span><b>${chaseRisk}점</b></div>
          </div>
          <div class="kbk-pro-top-meta" style="grid-template-columns:1fr">
            <div><span>선정 사유</span><p>${reasoning.reasons.map(textEscape).join(" · ")}</p>
              <div class="kbk-pro-top-explain">${renderTopPickSectionHtml(reasoning.sections || [])}</div>
            </div>
            <div class="kbk-pro-top-caution"><span>주의 포인트</span><p>${reasoning.cautions.map((line) => `• ${textEscape(line)}`).join(" · ")}</p></div>
            <div class="kbk-pro-top-decision"><span>레거시 요약</span><b>${textEscape(reasoning.decision)}</b>${fd ? `<small> · 단타 ${textEscape(fd.scalpAction)}</small>` : ""}</div>
          </div>
        </article>
      `).join("") : `<section class="kbk-empty-note">현재 통합 기준을 통과한 후보가 없습니다. 새로고침으로 다시 확인해 주세요.</section>`}
    `;
  } catch (error) {
    panel.innerHTML = `<section class="kbk-empty-note">통합 후보 계산에 실패했습니다: ${textEscape(error.message)}</section>`;
  }
}

async function renderTopPicks() {
  return renderTopPicksOnly();
}

window.__kbkRenderTopPicksOnly = renderTopPicksOnly;

function handleRoute() {
  const path = window.location.pathname;
  if (path === "/top-picks" || window.location.hash === "#top-picks") {
    renderTopPicksOnly();
    return;
  }
  if (path === "/backtest") {
    routeScroll("backtest-panel", "백테스트 화면입니다. 선택 종목 또는 전체 분석 버튼으로 스캔 이후 움직임을 확인합니다.");
    return;
  }
  if (path === "/ai-analysis") {
    routeScroll("debug-panel", "AI 분석 화면입니다. 후보 선정 근거와 계산 데이터를 확인합니다.");
    return;
  }
  if (!PRO_ROUTES[path]) showAllPanels();
}

function clarifyEmptyAccumulation() {
  if (!/\/scanner\/accumulation|\/accumulation/.test(location.pathname)) return;
  const hero = document.querySelector(".accumulation-hero");
  if (!hero || document.getElementById("kbk-accumulation-empty-note")) return;
  const counts = Array.from(hero.querySelectorAll(".score-card strong")).map((node) => Number((node.textContent || "").replace(/\D/g, "")));
  if (!counts.length || counts.some((value) => value > 0)) return;
  const note = document.createElement("section");
  note.id = "kbk-accumulation-empty-note";
  note.className = "kbk-empty-note";
  note.textContent = "현재 조건을 통과한 매집/급등 직전/돌파 후보가 없습니다. 데이터 로딩 오류가 아니라 지금 시점의 필터를 만족할 종목이 없다는 뜻입니다.";
  hero.insertAdjacentElement("afterend", note);
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.message || `API ${response.status}`);
  return payload.data || payload;
}

function normalizeBars(payload) {
  const bars = payload?.bars || payload?.data?.bars || payload?.candles || [];
  return bars.map((bar) => {
    const close = toNumber(bar.close ?? bar.c ?? bar.price);
    return {
      time: bar.time || bar.date || bar.timestamp || "",
      open: toNumber(bar.open ?? bar.o) ?? close,
      high: toNumber(bar.high ?? bar.h) ?? close,
      low: toNumber(bar.low ?? bar.l) ?? close,
      close,
      volume: toNumber(bar.volume ?? bar.v) ?? 0,
    };
  }).filter((bar) => bar.close !== null && bar.high !== null && bar.low !== null).slice(-60);
}

function calculateVwap(bars) {
  let pv = 0;
  let volume = 0;
  return bars.map((bar) => {
    const typical = (bar.high + bar.low + bar.close) / 3;
    pv += typical * bar.volume;
    volume += bar.volume;
    return volume > 0 ? pv / volume : null;
  });
}

function calculateAtr(bars, period = 14) {
  const ranges = [];
  for (let i = 0; i < bars.length; i += 1) {
    const prevClose = i ? bars[i - 1].close : bars[i].close;
    ranges.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    ));
  }
  const recent = ranges.slice(-period);
  if (!recent.length) return null;
  return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

function selectedSymbolFromMonitor() {
  const text = document.getElementById("monitor-summary")?.textContent || "";
  const match = text.match(/\b[A-Z][A-Z0-9.-]{0,10}\b/);
  return match?.[0] || document.querySelector(".candidate-table tr.selected b")?.textContent?.trim() || null;
}

function currentUsdKrw() {
  const match = document.body.textContent.match(/USD\/KRW\s*([\d,]+)/);
  const parsed = match ? Number(match[1].replace(/,/g, "")) : null;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1500;
}

function krwMoneyFromUsd(usd) {
  const rate = currentUsdKrw();
  const value = Number(usd);
  if (!Number.isFinite(value) || !rate) return "-";
  return `${Math.round(value * rate).toLocaleString("ko-KR")}원`;
}

function syncMonitorPriceBadge(symbol, price) {
  const summary = document.getElementById("monitor-summary");
  const value = Number(price);
  if (!summary || !symbol || !Number.isFinite(value)) return;
  const label = `실시간 구간 ${money(value)} / ${krwMoneyFromUsd(value)} · ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  const candidates = Array.from(summary.querySelectorAll("*")).filter((node) =>
    node.children.length === 0 && (/실시간 구간/.test(node.textContent || "") || /^\$[\d.]+\s*\/\s*[\d,]+/.test((node.textContent || "").trim()))
  );
  for (const node of candidates) node.textContent = label;
  if (!candidates.length) {
    const pill = document.createElement("span");
    pill.textContent = label;
    pill.style.display = "inline-block";
    pill.style.marginTop = "6px";
    pill.style.padding = "5px 10px";
    pill.style.borderRadius = "999px";
    pill.style.background = "#dbeafe";
    pill.style.color = "#1e40af";
    pill.style.fontWeight = "800";
    summary.appendChild(pill);
  }
}

function syncRvolCopy(panel, quote) {
  const rvol = rvolValue(quote);
  const volume = toNumber(quote?.volume ?? quote?.preMarketVolume);
  const replacement = rvol === null
    ? `RVOL은 평균 거래량 데이터가 없어 계산 불가입니다. 현재 누적 거래량은 ${compact(volume)}입니다`
    : `RVOL은 ${rvol.toFixed(1)}배입니다.`;
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    if (/RVOL[은이]?\s*1\.0배/.test(text)) {
      node.nodeValue = text.replace(/RVOL[은이]?\s*1\.0배[^.]*(\.|입니다\.)?/g, replacement);
    }
  }
}

function pctFrom(a, b) {
  const first = toNumber(a);
  const second = toNumber(b);
  if (first === null || !second) return null;
  return ((first - second) / second) * 100;
}

function latestUsablePrice(quote, bars) {
  const quotePrice = livePriceOf(quote);
  const barPrice = bars.at(-1)?.close ?? null;
  if (barPrice !== null && quotePrice !== null) {
    const drift = Math.abs((barPrice - quotePrice) / quotePrice) * 100;
    if (drift >= 1) return barPrice;
  }
  return barPrice ?? quotePrice;
}

function fastSignalDecision({ quote, bars, price, vwap, entryLow, entryHigh, recentHigh }) {
  const rvol = rvolValue(quote);
  const previousDayRatio = toNumber(quote?.previousDayVolumeRatio);
  const volume = toNumber(quote?.volume ?? quote?.preMarketVolume);
  const last = bars.at(-1);
  const prev3 = bars.at(-4)?.close ?? bars.at(-2)?.close;
  const prev8High = Math.max(...bars.slice(-9, -1).map((bar) => bar.high).filter(Number.isFinite));
  const shortReturn = pctFrom(last?.close, prev3) ?? 0;
  const strongVolume = (rvol !== null && rvol >= 3) || (previousDayRatio !== null && previousDayRatio >= 3) || (volume !== null && volume >= 1_000_000);
  const aboveVwap = quote?.aboveVwap === true || (vwap && price >= vwap * 0.998);
  const trendUp = String(quote?.oneMinuteTrend || "").toLowerCase() === "up" || shortReturn >= 0.35;
  const breakout = Number.isFinite(prev8High) && price >= prev8High * 0.995;
  const inEntryZone = price >= entryLow * 0.995 && price <= entryHigh * 1.025;
  const tooExtended = (vwap && price >= vwap * 1.22) || price >= recentHigh * 1.055;

  if (!aboveVwap) {
    return {
      action: "기다리세요",
      tone: "hold",
      headline: "VWAP 회복 전입니다.",
      reason: "거래량이 살아도 VWAP 아래에서는 단타 진입 신뢰도가 낮습니다.",
    };
  }
  if (tooExtended) {
    return {
      action: "추격 금지",
      tone: "profit",
      headline: "이미 기준가에서 많이 벌어졌습니다.",
      reason: "상승은 강하지만 지금은 눌림 또는 되돌림 확인이 유리합니다.",
    };
  }
  if (strongVolume && inEntryZone && trendUp) {
    return {
      action: "진입 가능",
      tone: "buy",
      headline: "거래량과 분봉 추세가 진입 구간에서 같이 붙었습니다.",
      reason: `RVOL ${rvol !== null ? `${rvol.toFixed(1)}배` : "-"} / 전일대비 ${previousDayRatio !== null ? `${previousDayRatio.toFixed(1)}배` : "-"} / 3분 변화 ${pct(shortReturn)}`,
    };
  }
  if (strongVolume && breakout && trendUp) {
    return {
      action: "돌파 확인",
      tone: "buy",
      headline: "직전 분봉 고점 돌파와 거래량 조건이 같이 맞았습니다.",
      reason: "현재가가 최근 단기 고점대를 넘어서고 거래량 배수가 강합니다. 손절은 ATR/VWAP 기준으로 짧게 잡아야 합니다.",
    };
  }
  if (strongVolume && trendUp) {
    return {
      action: "관심 유지",
      tone: "watch",
      headline: "거래량은 강하지만 진입 구간 확인이 더 필요합니다.",
      reason: "가격이 진입 구간에 닿거나 단기 고점을 다시 넘는지 확인하세요.",
    };
  }
  return {
    action: "기다리세요",
    tone: "hold",
    headline: "거래량 또는 분봉 추세 확인이 아직 부족합니다.",
    reason: "RVOL, 전일 대비 거래량, VWAP, 단기 고점 돌파가 동시에 붙어야 빠른 진입 신호로 봅니다.",
  };
}

function updateFastSignalCard(panel, decision) {
  const className = decision.tone === "buy" ? "buy" : decision.tone === "profit" ? "profit" : "hold";
  const html = `
    <span>단타 기준 신호</span>
    <strong>${textEscape(decision.action)}</strong>
    <small>${textEscape(decision.headline)}</small>
    <p>${textEscape(decision.reason)}</p>
  `;
  const card = Array.from(panel.querySelectorAll("section, article, div"))
    .filter((node) => /단타 기준 신호/.test(node.textContent || ""))
    .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0];
  if (card) {
    card.classList.add("kbk-pro-fast-signal", `kbk-pro-fast-${className}`);
    card.innerHTML = html;
    return;
  }
  const created = document.createElement("section");
  created.className = `kbk-pro-fast-signal kbk-pro-fast-${className}`;
  created.innerHTML = html;
  panel.prepend(created);
}

function setMetricByLabel(panel, label, value) {
  const labelNodes = Array.from(panel.querySelectorAll("*")).filter((node) =>
    node.children.length === 0 && (node.textContent || "").trim() === label
  );
  for (const labelNode of labelNodes) {
    const box = labelNode.parentElement;
    if (!box) continue;
    const valueNode = Array.from(box.querySelectorAll("strong,b")).at(0)
      || Array.from(box.children).find((child) => child !== labelNode && child.children.length === 0);
    if (valueNode) valueNode.textContent = value;
  }
}

function syncLegacyPriceMetrics(panel, levels) {
  setMetricByLabel(panel, "현재가", krwMoneyFromUsd(levels.price));
  setMetricByLabel(panel, "진입 검증 구간", `${krwMoneyFromUsd(levels.entryLow)} ~ ${krwMoneyFromUsd(levels.entryHigh)}`);
  setMetricByLabel(panel, "손절 기준", krwMoneyFromUsd(levels.atrStop));
  setMetricByLabel(panel, "1차 돌파 확인가", krwMoneyFromUsd(levels.entryHigh));
  setMetricByLabel(panel, "2차 돌파 확인가", krwMoneyFromUsd(levels.recentHigh * 1.035));
  setMetricByLabel(panel, "목표가", krwMoneyFromUsd(levels.entryHigh));
}

function candleChartSvg(bars, currentPrice, levels) {
  const width = 760;
  const height = 280;
  const pad = 26;
  const values = bars.flatMap((bar) => [bar.high, bar.low]);
  for (const value of Object.values(levels)) if (Number.isFinite(value)) values.push(value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.0001);
  const x = (index) => pad + index * ((width - pad * 2) / Math.max(bars.length - 1, 1));
  const y = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const candleWidth = Math.max(3, Math.min(9, (width - pad * 2) / Math.max(bars.length, 1) * 0.58));
  const vwaps = calculateVwap(bars);
  const vwapPath = vwaps.map((value, index) => value ? `${index ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}` : "").join(" ");
  const candles = bars.map((bar, index) => {
    const up = bar.close >= bar.open;
    const cx = x(index);
    const openY = y(bar.open);
    const closeY = y(bar.close);
    const highY = y(bar.high);
    const lowY = y(bar.low);
    const bodyY = Math.min(openY, closeY);
    const bodyH = Math.max(Math.abs(openY - closeY), 2);
    const cls = up ? "up" : "down";
    return `<line class="wick ${cls}" x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${highY.toFixed(1)}" y2="${lowY.toFixed(1)}"></line><rect class="${cls}" x="${(cx - candleWidth / 2).toFixed(1)}" y="${bodyY.toFixed(1)}" width="${candleWidth.toFixed(1)}" height="${bodyH.toFixed(1)}" rx="1"></rect>`;
  }).join("");
  const levelLines = Object.entries(levels).filter(([, value]) => Number.isFinite(value)).map(([label, value], index) => {
    const yy = y(value);
    return `<line class="level" x1="${pad}" x2="${width - pad}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"></line><text class="label" x="${pad + 4}" y="${(yy - 4 - index % 2 * 10).toFixed(1)}">${label} ${money(value)}</text>`;
  }).join("");
  const last = bars.at(-1)?.close ?? currentPrice;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="?먯껜 罹붾뱾李⑦듃">
    <line class="axis" x1="${pad}" x2="${width - pad}" y1="${height - pad}" y2="${height - pad}"></line>
    <line class="axis" x1="${pad}" x2="${pad}" y1="${pad}" y2="${height - pad}"></line>
    ${levelLines}
    ${vwapPath.trim() ? `<path class="vwap" d="${vwapPath}"></path>` : ""}
    ${candles}
    <text class="label" x="${width - pad - 120}" y="${pad + 12}">?꾩옱 ${money(last)}</text>
  </svg>`;
}

async function enhanceMonitorPanel() {
  const panel = document.getElementById("monitor-panel");
  const symbol = selectedSymbolFromMonitor();
  if (!panel || !symbol || panel.dataset.proBusy === "1") return;
  const now = Date.now();
  if (panel.dataset.proSymbol === symbol && now - Number(panel.dataset.proLastRun || 0) < 2500) return;
  panel.dataset.proBusy = "1";
  panel.dataset.proSymbol = symbol;
  panel.dataset.proLastRun = String(now);
  try {
    const from = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const [quote, history] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`).catch(() => null),
      fetchJson(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(from)}`),
    ]);
    const bars = normalizeBars(history);
    if (!bars.length) return;
    const price = latestUsablePrice(quote, bars);
    if (price === null) return;
    syncMonitorPriceBadge(symbol, price);
    syncRvolCopy(panel, quote);
    const atr = calculateAtr(bars);
    const recentHigh = Math.max(...bars.slice(-20).map((bar) => bar.high));
    const recentLow = Math.min(...bars.slice(-20).map((bar) => bar.low));
    const vwap = calculateVwap(bars).filter(Boolean).at(-1);
    const entryLow = Math.max(vwap || price * .995, recentHigh * .995);
    const entryHigh = Math.max(recentHigh * 1.006, price * 1.003);
    const atrStop = atr ? Math.min(recentLow * .998, price - atr * 1.4) : recentLow * .998;
    const stopPct = price ? ((atrStop - price) / price) * 100 : null;
    updateFastSignalCard(panel, fastSignalDecision({ quote, bars, price, vwap, entryLow, entryHigh, recentHigh }));
    syncLegacyPriceMetrics(panel, { price, entryLow, entryHigh, atrStop, recentHigh });
    const chart = document.createElement("section");
    chart.className = "kbk-pro-chart";
    chart.innerHTML = `
      <div class="kbk-pro-chart-head">
        <div><strong>${textEscape(symbol)} 분봉 캔들차트</strong><span>최근 분봉 기준, VWAP 회복 여부 / 진입·손절 기준선 표시</span></div>
        <span>${new Date().toLocaleTimeString("ko-KR")}</span>
      </div>
      ${candleChartSvg(bars, price, { VWAP: vwap, entry: entryLow, stop: atrStop })}
    `;
    const basis = document.createElement("section");
    basis.className = "kbk-pro-basis";
    basis.innerHTML = `
      <div><span>진입가 계산 근거</span><b>${money(entryLow)} ~ ${money(entryHigh)}</b><small>VWAP 위 유지 + 최근 20개 분봉 고점 돌파선을 기준으로 계산했습니다.</small></div>
      <div><span>ATR 기반 손절</span><b>${money(atrStop)} ${stopPct !== null ? `(${pct(stopPct)})` : ""}</b><small>최근 14개 분봉 ATR ${atr ? money(atr) : "-"}와 직전 지지선을 함께 반영했습니다.</small></div>
      <div><span>검증 포인트</span><b>VWAP / 거래량 / 고점 돌파</b><small>현재가가 VWAP 아래로 내려가거나 돌파 거래량이 약하면 신규 진입은 보류합니다.</small></div>
    `;
    panel.querySelector(".kbk-pro-chart")?.remove();
    panel.querySelector(".kbk-pro-basis")?.remove();
    panel.prepend(basis);
    panel.prepend(chart);
  } catch {
    panel.dataset.proSymbol = "";
  } finally {
    panel.dataset.proBusy = "0";
  }
}

async function renderBacktestExpectation() {
  const target = document.getElementById("backtest-panel");
  if (!target || document.getElementById("kbk-pro-expectancy")) return;
  const box = document.createElement("section");
  box.id = "kbk-pro-expectancy";
  box.className = "kbk-pro-alert-box";
  box.textContent = "백테스트/기대값 통계를 계산하는 중입니다.";
  target.prepend(box);
  try {
    const payload = await fetchJson("/api/scanner");
    const items = (payload.items || []).filter((item) => item?.included !== false);
    const sample = items.slice(0, 80);
    const high = sample.filter((item) => Number(item.finalProbabilityScore ?? item.scannerScore ?? 0) >= 75);
    const avgScore = sample.reduce((sum, item) => sum + Number(item.finalProbabilityScore ?? item.scannerScore ?? 0), 0) / Math.max(sample.length, 1);
    const avgMove = sample.reduce((sum, item) => sum + Number(item.changePercent ?? item.preMarketChangePercent ?? 0), 0) / Math.max(sample.length, 1);
    const risk = sample.reduce((sum, item) => sum + Number(item.riskScore ?? 50), 0) / Math.max(sample.length, 1);
    box.innerHTML = `
      <strong>현재 후보군 기대값 요약</strong><br>
      샘플 ${sample.length}건 · 75점 이상 ${high.length}건 · 평균 점수 ${Math.round(avgScore)}점 · 평균 상승률 ${pct(avgMove)} · 평균 위험 ${Math.round(risk)}점<br>
      실제 백테스트는 아래 스캔 기록이 쌓이면 백테스트 테이블에서 검증됩니다. 지금 표시는 현재 후보군의 조건 강도 요약입니다.
    `;
  } catch (error) {
    box.textContent = `백테스트/기대값 통계 계산 실패: ${error.message}`;
  }
}

function boot() {
  ensureStyles();
  addRefreshShortcut();
  ensureRouteLinks();
  handleRoute();
  clarifyEmptyAccumulation();
  patchFloatingPointText();

  const observer = new MutationObserver(() => {
    patchFloatingPointText();
    ensureRouteLinks();
    clarifyEmptyAccumulation();
    enhanceMonitorPanel();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener("popstate", handleRoute);
  window.addEventListener("hashchange", handleRoute);
}

ready(() => window.setTimeout(boot, 250));
