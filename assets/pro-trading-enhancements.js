import {
  computeChaseRisk,
  finalDecision,
  renderFinalDecisionHeroHtml,
} from "./final-decision.js";

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
  return `${Math.round(value * rate).toLocaleString("ko-KR")}??;
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

function formatKrwFromUsdDollar(dollarUsd) {
  const usd = toNumber(dollarUsd);
  const rate = currentUsdKrw();
  if (usd === null || usd <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  const krw = usd * rate;
  if (krw >= 100_000_000) return `??${(krw / 100_000_000).toFixed(1)}????;
  if (krw >= 10_000_000) return `??${Math.round(krw / 10_000_000)}泥쒕쭔 ??;
  return `??${Math.round(krw).toLocaleString("ko-KR")}??;
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
  let score = Math.round(clampTopPickScore(
    volumeAccelerationScore * 0.42
    + momentumExpansionScore * 0.28
    + surgePrecursorScore * 0.3
  ));
  if (accel5m !== null && accel5m >= 2.2) score = Math.round(clampTopPickScore(score + 8));
  else if (accel5m !== null && accel5m >= 1.5) score = Math.round(clampTopPickScore(score + 4));
  if (accel1m !== null && accel1m >= 2) score = Math.round(clampTopPickScore(score + 3));
  return {
    score,
    volumeAccelerationScore,
    accel1m,
    accel5m,
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
      <ul>${section.lines.map((line) => `<li>??${textEscape(line)}</li>`).join("")}</ul>
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
  if (setup.volumeStarting) legacyReasons.push("嫄곕옒?됱씠 利앷??섍린 ?쒖옉?덉뒿?덈떎");
  if (metrics.rvol !== null && metrics.rvol >= 3) legacyReasons.push(`RVOL ${metrics.rvol.toFixed(1)}諛곕줈 湲곗? ?댁긽?낅땲??);
  if (topPickItemField(item, "volumeAccelerationScore") >= 65) legacyReasons.push("嫄곕옒??媛?띾룄媛 ?묓샇?⑸땲??);
  if (setup.vwapRecovering) legacyReasons.push(setup.vwapAbove ? "VWAP ?꾩뿉???뚮났 ?먮쫫?낅땲?? : "VWAP ?щ룎?뚮? ?쒕룄 以묒엯?덈떎");
  if (topPickItemField(item, "higherLowScore") >= 65) legacyReasons.push("Higher Low 援ъ“媛 媛먯??⑸땲??);
  if (topPickItemField(item, "reSurgeSetupScore") >= 65) legacyReasons.push("?뚮┝ ???ъ긽??媛?μ꽦???덉뒿?덈떎");
  if (setup.lowRecovery) legacyReasons.push("媛寃⑹씠 ?섎떒遺?먯꽌 ?뚮났 以묒엯?덈떎");
  if (topPickItemField(item, "compressionScore") >= 70) legacyReasons.push("諛뺤뒪沅??뺤텞???뺤씤?⑸땲??);

  const volumeQualityLines = [];
  const surgeAccelerationLines = [];
  const technicalLines = [];
  const cautions = [];

  if (volumeQuality.contributed) {
    volumeQualityLines.push(`嫄곕옒???덉쭏 ?먯닔 ${volumeQuality.score}??);
    if (volume >= 500_000) volumeQualityLines.push(`嫄곕옒??${compact(volume)}`);
    const dollarText = formatKrwFromUsdDollar(volumeQuality.dollarVolume);
    if (dollarText) volumeQualityLines.push(`嫄곕옒?湲?${dollarText}`);
    if (rvol >= 1.5 && volumeQuality.rvolScore >= 48) {
      volumeQualityLines.push(`RVOL ${rvol.toFixed(1)}諛곕줈 ?됯퇏 ?鍮?嫄곕옒媛 遺숈뿀?듬땲??);
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
  }

  if (setup.vwapAbove) technicalLines.push("VWAP ???좎?");
  else if (topPickItemField(item, "vwapReclaimScore") >= 60) technicalLines.push("VWAP ?щ룎???쒕룄");
  if (topPickItemField(item, "higherLowScore") >= 60) technicalLines.push("Higher Low ?뺤꽦");
  if (topPickItemField(item, "compressionScore") >= 70) technicalLines.push("?뺤텞援ш컙 ?뚰뙆 ?쒕룄");
  if (topPickItemField(item, "reSurgeSetupScore") >= 65) technicalLines.push("?뚮┝ ???ъ긽??援ъ“");

  if (setup.highFailed) cautions.push("?대? ?ш쾶 ?ㅻⅨ ??怨좎젏?먯꽌 諛?몄뒿?덈떎");
  if (setup.rsi !== null && setup.rsi >= 70) cautions.push(`RSI ${Math.round(setup.rsi)}`);
  if (metrics.change >= 42) cautions.push(`?뱀씪 ${pct(metrics.change)} ?곸듅`);
  if (setup.extremeRvolWeak) cautions.push("RVOL? ?믪?留?媛寃??먮쫫???쏀빀?덈떎");
  if (setup.vwapBelow) cautions.push("VWAP ?꾨옒");
  if (metrics.risk >= 70) cautions.push("異붽꺽 ?꾪뿕 ?먯닔媛 ?믪뒿?덈떎");

  const sections = [];
  if (volumeQualityLines.length) sections.push({ title: "嫄곕옒???덉쭏", lines: volumeQualityLines });
  if (surgeAccelerationLines.length) sections.push({ title: "?섍툒 媛?띾룄", lines: surgeAccelerationLines });
  if (technicalLines.length) sections.push({ title: "湲곗닠???⑦꽩", lines: technicalLines });

  let decision = "愿李?;
  if (setup.overheated || setup.highFailed || setup.extremeRvolWeak || metrics.risk >= 78 || metrics.finalScore < 58) {
    decision = "吏꾩엯 湲덉?";
  } else if (metrics.finalScore >= 74 && setup.volumeStarting && setup.vwapRecovering && !setup.vwapBelow && metrics.risk < 70) {
    decision = "留ㅼ닔 媛??;
  }

  const reasons = legacyReasons.length ? legacyReasons.slice(0, 6) : ["珥덉엯 ?뚮났 議곌굔??愿李?以묒엯?덈떎"];

  return {
    reasons,
    cautions: cautions.length ? cautions.slice(0, 5) : ["?ㅼ젣 吏꾩엯 ??VWAP/泥닿껐 諛섏쓳 ?ы솗??],
    sections,
    decision,
    priority: decision === "留ㅼ닔 媛?? ? 3 : decision === "愿李? ? 2 : 0,
    volumeQualityScore: volumeQuality.score,
    surgeAccelerationScore: surgeAcceleration.score,
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
    if (!before || !/\d+\.\d{3,}??.test(before)) continue;
    node.nodeValue = before.replace(/(\d+\.\d{3,})??g, (_, raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? `${Math.round(value)}?? : `${raw}??;
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
    .find((button) => /?덈줈怨좎묠|媛먯떆 媛깆떊|?꾩껜 遺꾩꽍/.test(button.textContent || "") && button.offsetParent);
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
    { label: "諛깊뀒?ㅽ듃", path: "/backtest", target: "backtest-panel" },
    { label: "AI 遺꾩꽍", path: "/ai-analysis", target: "debug-panel" },
    { label: "?듯빀 理쒖쥌 ?꾨낫", path: "/top-picks", target: "kbk-pro-top-picks" },
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
        const trendRaw = String(item?.oneMinuteTrend ?? "").toLowerCase();
        const trendGood = trendRaw.includes("up") || trendRaw.includes("상승") || item?.technical?.ma5vs20 === "above";
        const vwapGood = setup.vwapAbove || setup.vwapNear || setup.vwapRecovering;
        const chaseRisk = computeChaseRisk(item, {
          change,
          risk,
          vwapGood,
          trendGood,
          riskPenalty: setup.riskPenalty,
          setup,
        });
        const fd = finalDecision({
          item,
          setup,
          topPickScore: finalScore,
          volumeQualityScore: reasoning.volumeQualityScore,
          surgeAccelerationScore: reasoning.surgeAccelerationScore,
          chaseRisk,
          vwapAbove: setup.vwapAbove,
          vwapNear: setup.vwapNear,
          vwapFarBelow: setup.vwapBelow && !setup.vwapNear,
          rsi: setup.rsi,
          change,
          higherLow: setup.higherLow ?? topPickItemField(item, "higherLowScore"),
        });
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
          <h2>?듯빀 理쒖쥌 ?꾨낫</h2>
          <p class="section-copy">?ㅼ떆媛??⑦? ?꾨낫, ??벑 媛먯떆, 留ㅼ쭛/?⑦꽩 ?먯닔瑜??④퍡 蹂닿퀬 怨쇱뿴 ?꾪뿕??媛먯젏???ㅼ쟾???곗꽑?쒖쐞?낅땲??</p>
        </div>
        <div class="hero-scoreboard">
          <div class="score-card"><span>?꾨낫</span><strong>${items.length}</strong></div>
          <div class="score-card"><span>湲곗?</span><strong>珥덉엯 ?곗꽑</strong></div>
        </div>
      </section>
      ${items.length ? items.map(({ item, price, change, volume, surge, risk, pattern, finalScore, signalBonus, reasoning, chaseRisk, finalDecision: fd }) => `
        <article class="kbk-pro-top-card">
          ${renderFinalDecisionHeroHtml(fd, textEscape)}
          <div class="kbk-pro-top-head">
            <div><h3>${textEscape(item.symbol)}</h3><p>${textEscape(item.name || item.symbol)}</p></div>
            <div class="kbk-pro-top-score">${finalScore}</div>
          </div>
          <div class="price-row">
            <strong>${pairedMoney(price)}</strong>
            <span>${pct(change)}</span>
            <span>嫄곕옒??${compact(volume)}</span>
          </div>
          <div class="kbk-pro-top-grid">
            <div><span>??벑 媛먯떆</span><b>${surge}??/b></div>
            <div><span>嫄곕옒???덉쭏</span><b>${reasoning.volumeQualityScore ?? "-"}??/b></div>
            <div><span>?섍툒 媛??/span><b>${reasoning.surgeAccelerationScore ?? "-"}??/b></div>
            <div><span>추격 위험</span><b>${chaseRisk}점</b></div>
          </div>
          <div class="kbk-pro-top-meta" style="grid-template-columns:1fr">
            <div><span>?좎젙 ?댁쑀</span><p>${reasoning.reasons.map(textEscape).join(" 쨌 ")}</p>
              <div class="kbk-pro-top-explain">${renderTopPickSectionHtml(reasoning.sections || [])}</div>
            </div>
            <div class="kbk-pro-top-caution"><span>二쇱쓽 ?붿씤</span><p>${reasoning.cautions.map((line) => `??${textEscape(line)}`).join(" 쨌 ")}</p></div>
            <div class="kbk-pro-top-decision"><span>레거시 요약</span><b>${textEscape(reasoning.decision)}</b><small> · 단타 ${textEscape(fd.scalpAction)}</small></div>
          </div>
        </article>
      `).join("") : `<section class="kbk-empty-note">?꾩옱 ?듯빀 湲곗????듦낵???꾨낫媛 ?놁뒿?덈떎. ?덈줈怨좎묠?쇰줈 ?ㅼ떆 ?뺤씤??二쇱꽭??</section>`}
    `;
  } catch (error) {
    panel.innerHTML = `<section class="kbk-empty-note">?듯빀 ?꾨낫 怨꾩궛???ㅽ뙣?덉뒿?덈떎: ${textEscape(error.message)}</section>`;
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
    routeScroll("backtest-panel", "諛깊뀒?ㅽ듃 ?붾㈃?낅땲?? ?좏깮 醫낅ぉ ?먮뒗 ?꾩껜 遺꾩꽍 踰꾪듉?쇰줈 ?쒓렇???댄썑 ?吏곸엫???뺤씤?⑸땲??");
    return;
  }
  if (path === "/ai-analysis") {
    routeScroll("debug-panel", "AI 遺꾩꽍 ?붾㈃?낅땲?? ?꾨낫 ?좎젙 洹쇨굅? 怨꾩궛 ?곗씠?곕? ?뺤씤?⑸땲??");
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
  note.textContent = "?꾩옱 議곌굔???듦낵??留ㅼ쭛/湲됰벑 吏곸쟾/?〓낫 ?뚰뙆 ?꾨낫媛 ?놁뒿?덈떎. ?곗씠??濡쒕뵫 ?ㅻ쪟媛 ?꾨땲?? 吏湲??쒖젏???꾪꽣瑜?留뚯”??醫낅ぉ???녿떎???살엯?덈떎.";
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
  return `${Math.round(value * rate).toLocaleString("ko-KR")}??;
}

function syncMonitorPriceBadge(symbol, price) {
  const summary = document.getElementById("monitor-summary");
  const value = Number(price);
  if (!summary || !symbol || !Number.isFinite(value)) return;
  const label = `?ㅼ떆媛?遺꾨큺 ${money(value)} / ${krwMoneyFromUsd(value)} 쨌 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  const candidates = Array.from(summary.querySelectorAll("*")).filter((node) =>
    node.children.length === 0 && (/?ㅼ떆媛?遺꾨큺/.test(node.textContent || "") || /^\$[\d.]+\s*\/\s*[\d,]+??.test((node.textContent || "").trim()))
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
    ? `RVOL? ?됯퇏 嫄곕옒???곗씠?곌? ?놁뼱 怨꾩궛 遺덇??낅땲?? ?꾩옱 ?꾩쟻 嫄곕옒?됱? ${compact(volume)}?낅땲??`
    : `RVOL? ${rvol.toFixed(1)}諛곗엯?덈떎.`;
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue || "";
    if (/RVOL[?댁?]?\s*1\.0諛?.test(text)) {
      node.nodeValue = text.replace(/RVOL[?댁?]?\s*1\.0諛?^.??*(\.|?낅땲??.)?/g, replacement);
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
      action: "湲곕떎由ъ꽭??,
      tone: "hold",
      headline: "VWAP ?뚮났 ?꾩엯?덈떎.",
      reason: "嫄곕옒?됱씠 ?덉뼱??VWAP ?꾨옒?먯꽌???⑦? 吏꾩엯 ?좊ː?꾧? ?⑥뼱吏묐땲??",
    };
  }
  if (tooExtended) {
    return {
      action: "異붽꺽 湲덉?",
      tone: "profit",
      headline: "?대? 湲곗??좎뿉??留롮씠 踰뚯뼱議뚯뒿?덈떎.",
      reason: "?곸듅? 媛뺥븯吏留?吏湲덉? ?뚮┝ ?먮뒗 ?щ룎???뺤씤?????좊━?⑸땲??",
    };
  }
  if (strongVolume && inEntryZone && trendUp) {
    return {
      action: "吏꾩엯 媛??,
      tone: "buy",
      headline: "嫄곕옒?됯낵 遺꾨큺 異붿꽭媛 吏꾩엯 援ш컙?먯꽌 媛숈씠 遺숈뿀?듬땲??",
      reason: `RVOL ${rvol !== null ? rvol.toFixed(1) + "諛? : "-"} / ?꾩씪?鍮?${previousDayRatio !== null ? previousDayRatio.toFixed(1) + "諛? : "-"} / 3遊?蹂??${pct(shortReturn)}`,
    };
  }
  if (strongVolume && breakout && trendUp) {
    return {
      action: "?뚰뙆 ?뺤씤",
      tone: "buy",
      headline: "吏곸쟾 遺꾨큺 怨좎젏 ?뚰뙆? 嫄곕옒??議곌굔??媛숈씠 ?≫삍?듬땲??",
      reason: `?꾩옱媛媛 理쒓렐 ?④린 怨좎젏沅뚯쓣 ?섏뼱?곌퀬 嫄곕옒??諛곗닔媛 媛뺥빀?덈떎. ?먯젅? ATR/VWAP 湲곗??쇰줈 吏㏐쾶 遊먯빞 ?⑸땲??`,
    };
  }
  if (strongVolume && trendUp) {
    return {
      action: "愿???좎?",
      tone: "watch",
      headline: "嫄곕옒?됱? 媛뺥븯吏留?吏꾩엯 湲곗????ы솗?몄씠 ?꾩슂?⑸땲??",
      reason: "媛寃⑹씠 吏꾩엯 援ш컙???욧굅???④린 怨좎젏???ㅼ떆 ?섎뒗吏 ?뺤씤?섏꽭??",
    };
  }
  return {
    action: "湲곕떎由ъ꽭??,
    tone: "hold",
    headline: "嫄곕옒???먮뒗 ?④린 異붿꽭 ?뺤씤???꾩쭅 遺議깊빀?덈떎.",
    reason: "RVOL, ?꾩씪 ?鍮?嫄곕옒?? VWAP, ?④린 怨좎젏 ?뚰뙆媛 ?숈떆??遺숈뼱??鍮좊Ⅸ 吏꾩엯 ?좏샇濡?諛붾앸땲??",
  };
}

function updateFastSignalCard(panel, decision) {
  const className = decision.tone === "buy" ? "buy" : decision.tone === "profit" ? "profit" : "hold";
  const html = `
    <span>?⑦? 湲곗? ?좏샇</span>
    <strong>${textEscape(decision.action)}</strong>
    <small>${textEscape(decision.headline)}</small>
    <p>${textEscape(decision.reason)}</p>
  `;
  const card = Array.from(panel.querySelectorAll("section, article, div"))
    .filter((node) => /?⑦? 湲곗? ?좏샇/.test(node.textContent || ""))
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
  setMetricByLabel(panel, "?꾩옱媛", krwMoneyFromUsd(levels.price));
  setMetricByLabel(panel, "吏꾩엯 寃??援ш컙", `${krwMoneyFromUsd(levels.entryLow)} ~ ${krwMoneyFromUsd(levels.entryHigh)}`);
  setMetricByLabel(panel, "?먯젅 湲곗?", krwMoneyFromUsd(levels.atrStop));
  setMetricByLabel(panel, "1李??뚰뙆 ?뺤씤媛", krwMoneyFromUsd(levels.entryHigh));
  setMetricByLabel(panel, "2李??뚰뙆 ?뺤씤媛", krwMoneyFromUsd(levels.recentHigh * 1.035));
  setMetricByLabel(panel, "紐⑺몴媛", krwMoneyFromUsd(levels.entryHigh));
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
        <div><strong>${textEscape(symbol)} ?먯껜 罹붾뱾李⑦듃</strong><span>理쒓렐 遺꾨큺 湲곗?, VWAP ?뚮? ?먯꽑 / 吏꾩엯쨌?먯젅 湲곗????쒖떆</span></div>
        <span>${new Date().toLocaleTimeString("ko-KR")}</span>
      </div>
      ${candleChartSvg(bars, price, { VWAP: vwap, 吏꾩엯: entryLow, ?먯젅: atrStop })}
    `;
    const basis = document.createElement("section");
    basis.className = "kbk-pro-basis";
    basis.innerHTML = `
      <div><span>吏꾩엯媛 怨꾩궛 洹쇨굅</span><b>${money(entryLow)} ~ ${money(entryHigh)}</b><small>VWAP ???좎? + 理쒓렐 20媛?遺꾨큺 怨좎젏 ?뚰뙆沅뚯쓣 湲곗??쇰줈 怨꾩궛?덉뒿?덈떎.</small></div>
      <div><span>ATR 湲곕컲 ?먯젅</span><b>${money(atrStop)} ${stopPct !== null ? `(${pct(stopPct)})` : ""}</b><small>理쒓렐 14媛?遺꾨큺 ATR ${atr ? money(atr) : "-"}? 吏곸쟾 吏吏?좎쓣 ?④퍡 諛섏쁺?덉뒿?덈떎.</small></div>
      <div><span>寃利??ъ씤??/span><b>VWAP / 嫄곕옒??/ 怨좎젏 ?뚰뙆</b><small>?꾩옱媛媛 VWAP ?꾨옒濡??대젮媛嫄곕굹 ?뚰뙆 嫄곕옒?됱씠 ?쏀븯硫??좉퇋 吏꾩엯??蹂대쪟?⑸땲??</small></div>
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
  box.textContent = "?밸쪧/湲곕?媛??듦퀎瑜?怨꾩궛?섎뒗 以묒엯?덈떎.";
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
      <strong>?꾩옱 ?꾨낫援?湲곕?媛??붿빟</strong><br>
      ?쒕낯 ${sample.length}媛?쨌 75???댁긽 ${high.length}媛?쨌 ?됯퇏 ?먯닔 ${Math.round(avgScore)}??쨌 ?됯퇏 ?곸듅瑜?${pct(avgMove)} 쨌 ?됯퇏 ?꾪뿕 ${Math.round(risk)}??br>
      ?ㅼ젣 ?밸쪧? ?꾨옒 ?쒓렇??湲곕줉???볦씪?섎줉 諛깊뀒?ㅽ듃 ?뚯씠釉붿뿉??寃利앸맗?덈떎. 吏湲??쒖떆???꾩옱 ?꾨낫援곗쓽 議곌굔 媛뺣룄 ?붿빟?낅땲??
    `;
  } catch (error) {
    box.textContent = `?밸쪧/湲곕?媛??듦퀎 怨꾩궛 ?ㅽ뙣: ${error.message}`;
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
