/**
 * 통합 최종 후보 — 최종 판단 엔진 (표시 전용, 정렬/기존 점수식 비침투)
 */

export const FINAL_DECISION = {
  BUY_NOW: { key: "buy_now", label: "🟢 즉시 매수", tone: "buy", minConf: 85, maxConf: 100 },
  PULLBACK: { key: "pullback", label: "🟡 눌림 대기", tone: "pullback", minConf: 70, maxConf: 85 },
  WATCH: { key: "watch", label: "⚪ 관찰", tone: "watch", minConf: 50, maxConf: 70 },
  BLOCK: { key: "block", label: "🔴 진입 금지", tone: "block", minConf: 0, maxConf: 50 },
};

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function field(item, key) {
  return num(item?.[key]) ?? num(item?.technical?.[key]);
}

/** legacy scalpProfile + vt() 정렬 — scanner item 단독 */
export function deriveScalpSignal(item, setup = {}) {
  const rvol = num(item?.volumeRatio ?? item?.relativeVolume) ?? setup.rvol ?? 0;
  const volumeAcceleration = field(item, "volumeAccelerationScore") ?? setup.volumeAcceleration ?? 50;
  const higherLow = field(item, "higherLowScore") ?? setup.higherLow ?? 50;
  const reSurge = field(item, "reSurgeSetupScore") ?? setup.resurge ?? 50;
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? 0;
  const rsi = num(item?.rsi ?? item?.technical?.rsi) ?? setup.rsi ?? null;

  const vwapAbove = setup.vwapAbove === true;
  const vwapNear = setup.vwapNear === true;
  const vwapBelow = setup.vwapBelow === true;
  const vwapGood = vwapAbove || vwapNear || setup.vwapRecovering === true;

  const price = num(item?.price ?? item?.preMarketPrice) ?? 0;
  const dayHigh = num(item?.dayHigh ?? item?.regularMarketDayHigh);
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
  risk = clamp(risk, 0, 50);

  const volumeOk = rvol >= 3 || (rvol >= 1.2 && (volumeAcceleration >= 70 || reSurge >= 70));
  const caution = risk >= 38 || overheated || (highPullbackPct !== null && highPullbackPct >= 25) || (vwapWeak && priceWeak);
  const buyReady = vwapGood
    && !vwapBelow
    && higherLow >= 58
    && volumeAcceleration >= 50
    && volumeOk
    && risk < 34
    && !overheated;

  if (buyReady) {
    return { action: "매수 가능", tone: "buy" };
  }
  if (caution) {
    return { action: "진입 주의", tone: "avoid" };
  }
  if ((vwapNear || field(item, "vwapReclaimScore") >= 60) && volumeOk && higherLow >= 50 && change >= 1 && change <= 55) {
    return { action: "관심 유지", tone: "watch" };
  }
  return { action: "관찰", tone: "hold" };
}

/** kbk-symbol-detail scoreTopPick 과 동일 chaseRisk */
export function computeChaseRisk(item, ctx = {}) {
  const risk = num(item?.riskScore) ?? ctx.risk ?? 50;
  const change = num(item?.changePercent ?? item?.preMarketChangePercent) ?? ctx.change ?? 0;
  const vwapGood = ctx.vwapGood === true;
  const trendGood = ctx.trendGood === true;
  const riskPenalty = num(ctx.riskPenalty) ?? num(ctx.setup?.riskPenalty) ?? 0;

  return clamp(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
      + riskPenalty * 0.8,
  );
}

function vwapFlags(setup = {}, vwapLabel = "") {
  const label = String(vwapLabel ?? "");
  const above = setup.vwapAbove === true || label.includes("위");
  const near = setup.vwapNear === true || label.includes("근처") || label.toLowerCase().includes("near");
  const below = setup.vwapBelow === true || label.includes("아래") || label.toLowerCase().includes("below");
  return { above, near, below, farBelow: below && !near };
}

function buildReasons(input, scalp) {
  const positive = [];
  const warning = [];

  if (input.volumeQualityScore >= 60) positive.push("거래량 품질 우수");
  if (input.surgeAccelerationScore >= 60) positive.push("최근 거래량 가속도 강함");
  if (input.vwapAbove) positive.push("VWAP 위 유지");
  else if (input.vwapNear) positive.push("VWAP 근처");
  if (input.higherLow >= 60) positive.push("Higher Low 형성");
  if (scalp.action === "매수 가능") positive.push(`실시간 단타 시그널: ${scalp.action}`);

  warning.push(`추격 위험 ${input.chaseRisk}`);
  if (input.rsi !== null && input.rsi >= 70) warning.push(`RSI ${Math.round(input.rsi)}`);
  if (input.change >= 42) warning.push(`당일 +${input.change.toFixed(1)}% 상승`);
  if (input.vwapFarBelow) warning.push("VWAP 크게 이탈");
  if (input.surgeAccelerationScore < 60) warning.push("수급 가속도 약함");
  if (scalp.action === "진입 주의") warning.push(`실시간 단타 시그널: ${scalp.action}`);
  if (scalp.action === "관심 유지") warning.push(`실시간 단타 시그널: ${scalp.action}`);

  return {
    positive: positive.slice(0, 6),
    warning: warning.slice(0, 6),
  };
}

function confidenceInBand(band, score01) {
  const span = band.maxConf - band.minConf;
  return clamp(band.minConf + span * Math.max(0, Math.min(1, score01)));
}

/**
 * @param {object} input
 * @param {number} input.topPickScore — finalScore
 * @param {number} input.volumeQualityScore
 * @param {number} input.surgeAccelerationScore
 * @param {number} input.chaseRisk
 * @param {boolean} input.vwapAbove
 * @param {boolean} input.vwapNear
 * @param {boolean} input.vwapFarBelow
 * @param {number|null} input.rsi
 * @param {number} input.change
 * @param {number} input.higherLow
 * @param {object} [input.setup]
 * @param {object} [input.item]
 * @param {string} [input.scalpAction] — 미전달 시 deriveScalpSignal 사용
 */
export function finalDecision(input) {
  const item = input.item ?? {};
  const setup = input.setup ?? {};
  const scalp = input.scalpAction
    ? { action: input.scalpAction, tone: "custom" }
    : deriveScalpSignal(item, setup);

  const top = num(input.topPickScore) ?? 0;
  const vq = num(input.volumeQualityScore) ?? 0;
  const sa = num(input.surgeAccelerationScore) ?? 0;
  const chaseRisk = num(input.chaseRisk) ?? 0;
  const rsi = num(input.rsi) ?? setup.rsi ?? null;
  const change = num(input.change) ?? 0;
  const higherLow = num(input.higherLow) ?? field(item, "higherLowScore") ?? setup.higherLow ?? 0;
  const vw = vwapFlags(setup, input.vwapLabel);
  const vwapAbove = input.vwapAbove === true || vw.above;
  const vwapNear = input.vwapNear === true || vw.near;
  const vwapFarBelow = input.vwapFarBelow === true || vw.farBelow;

  const ctx = {
    topPickScore: top,
    volumeQualityScore: vq,
    surgeAccelerationScore: sa,
    chaseRisk,
    vwapAbove,
    vwapNear,
    vwapFarBelow,
    rsi,
    change,
    higherLow,
  };

  const reasons = buildReasons(ctx, scalp);

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
      confidence: confidenceInBand(FINAL_DECISION.BLOCK, 1 - Math.min(1, severity)),
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
      confidence: confidenceInBand(FINAL_DECISION.BUY_NOW, 0.85 + fit * 0.15),
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
      confidence: confidenceInBand(FINAL_DECISION.PULLBACK, 0.55 + fit * 0.45),
      scalpAction: scalp.action,
      chaseRisk,
      reasons,
    };
  }

  const watchFit = Math.min(1, (top / 100) * 0.4 + (vq / 100) * 0.3 + (sa / 100) * 0.3);
  return {
    ...FINAL_DECISION.WATCH,
    confidence: confidenceInBand(FINAL_DECISION.WATCH, watchFit),
    scalpAction: scalp.action,
    chaseRisk,
    reasons,
  };
}

export function renderFinalDecisionHeroHtml(decision, escapeHtml = (v) => String(v ?? "")) {
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
