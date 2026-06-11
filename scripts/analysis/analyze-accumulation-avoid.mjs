const SCANNER_URL = "https://kbk-theta-accumulation.vercel.app/api/scanner";

function P(e, t = 0, n = 100) {
  return Math.max(t, Math.min(n, e));
}
function Xn(e) {
  return e.price ?? e.preMarketPrice ?? 0;
}
function Zn(e) {
  return e.changePercent ?? e.preMarketChangePercent ?? 0;
}
function $n(e) {
  return e.technical?.vwap ?? e.vwap ?? null;
}
function kbkHasTradeVolume(e) {
  return (
    $n(e) !== null
    && (e.technical?.vwapStatus ?? e.vwapStatus) !== "insufficient-volume"
    && ((e.technical?.vwapBars ?? e.vwapBars ?? 0) >= 3
      || (e.technical?.vwapTotalVolume ?? e.vwapTotalVolume ?? 0) > 0)
  );
}
function er(e, t) {
  return !t || t <= 0 ? 0 : ((e - t) / t) * 100;
}
function rr(e) {
  return P(e.technical?.closePosition ?? 52);
}
function ir(e) {
  return P(e.technical?.upperWickRisk ?? 45);
}
function Qn(e) {
  if (typeof e.relativeVolume === "number") return e.relativeVolume;
  if (typeof e.volumeRatio === "number") return e.volumeRatio;
  if (!kbkHasTradeVolume(e)) return 0;
  const t = e.volume ?? 0;
  const n = e.averageVolume ?? 0;
  return t > 0 && n > 0 ? t / n : t >= 2e7 ? 5.2 : t >= 8e6 ? 3.1 : t >= 2e6 ? 1.8 : 1;
}
function tr(e) {
  if (!kbkHasTradeVolume(e)) return 24;
  const t = er(Xn(e), $n(e));
  const n = e.technical?.vwapState ?? (e.aboveVwap ? "above" : "unknown");
  if (n === "above" || t >= 0.7) return 90;
  if (n === "near" || t >= -0.4) return 74;
  if (t >= -1.2) return 58;
  return 34;
}
function sr(e, t) {
  return !e.dayHigh || e.dayHigh <= 0 ? 0 : ((e.dayHigh - t) / e.dayHigh) * 100;
}
function cr(e) {
  const t = e.sourceTags ?? [];
  const n = e.selectionReasons ?? [];
  const r = e.storyTags ?? [];
  let i = 32;
  if (t.includes("news-story-signal")) i += 18;
  if (t.includes("sec-8k-signal")) i += 16;
  if (t.includes("benchmark-catalyst-seed")) i += 8;
  if (t.includes("structural-event-monitor")) i += 10;
  if (n.some((x) => x.toLowerCase().includes("news"))) i += 8;
  if (r.length >= 2) i += 8;
  return P(i);
}
function gr(e) {
  const t = [e.storySignalText, ...(e.selectionReasons ?? []), ...(e.sourceTags ?? [])]
    .join(" ")
    .toLowerCase();
  const r = [];
  for (const [key, label] of [
    ["offering", "오퍼링"],
    ["warrant", "워런트"],
    ["reverse split", "리버스 스플릿"],
    ["delist", "상장폐지"],
    ["dilution", "희석"],
    ["lockup", "락업"],
    ["terminate", "계약 해지"],
    ["failure", "실패"],
    ["going concern", "계속기업"],
  ]) {
    if (t.includes(key)) r.push(label);
  }
  if (t.includes("sec-8k")) r.push("8-K");
  if (t.includes("structural-event-monitor")) r.push("구조 이벤트");
  if (r.length >= 3) return { level: "높음", reasons: r };
  if (r.length >= 2) return { level: "보통", reasons: r };
  return { level: r.length ? "보통" : "낮음", reasons: r.length ? r : ["특이 공시 위험 신호 낮음"] };
}
function mr(e) {
  const t = Math.max(Zn(e), 0);
  const n = P(e.riskScore ?? 50);
  const r = ir(e);
  const i = tr(e);
  const a = e.oneMinuteTrend?.toLowerCase() === "down" ? 14 : 0;
  const o = cr(e) < 50 && t >= 35 ? 10 : 0;
  const s = (e.marketCap ?? 0) > 0 && (e.marketCap ?? 0) < 25e6 ? 8 : 0;
  return Math.round(P(t * 0.35 + n * 0.36 + r * 0.16 + (100 - i) * 0.18 + a + o + s));
}
function hr(e) {
  const t = Xn(e);
  const n = tr(e);
  const r = rr(e);
  const i = ir(e);
  const a = P(e.riskScore ?? 50);
  const o = sr(e, t);
  const s = e.oneMinuteTrend?.toLowerCase() === "down" ? 12 : 0;
  return Math.round(P((100 - n) * 0.28 + (100 - r) * 0.2 + i * 0.2 + o * 2.1 + a * 0.18 + s));
}
function Tr(e, scores, filing) {
  const r = Zn(e);
  const i = kbkHasTradeVolume(e);
  if (!i && r < 40) return { section: "avoid", rule: "no-trade-volume-and-change<40" };
  if ((filing.level === "높음" && scores.dropRisk >= 72) || scores.dropRisk >= 82) {
    return { section: "avoid", rule: "dropRisk-or-filing-high" };
  }
  if (scores.chasingRisk >= 78) return { section: "chasingRisk", rule: "chasingRisk>=78" };
  if (r >= 40) return { section: "surgedContinuation", rule: "change>=40" };
  if (i && scores.preSurge >= 78 && scores.accumulation >= 72 && scores.breakoutReady >= 74) {
    return { section: "preSurge", rule: "pre-surge-combo" };
  }
  if (i && scores.accumulation >= 76 && r <= 20) return { section: "accumulating", rule: "accumulating" };
  if (i && scores.breakoutReady >= 76 && r <= 30) return { section: "breakoutReady", rule: "breakout-ready" };
  return { section: "pullbackRebound", rule: "default-pullback" };
}
function Dr(section, scores, filing) {
  let r;
  if (section === "avoid") r = "매매 금지";
  else if (scores.dropRisk >= 80) r = "손절 우선";
  else if (section === "chasingRisk" || scores.chasingRisk >= 78) r = "추격 금지";
  else if (scores.preSurge >= 82 && scores.accumulation >= 74 && scores.chasingRisk < 55) r = "소액 진입 가능";
  else if (scores.breakoutReady >= 80 && scores.chasingRisk < 62) r = "돌파 확인 후 진입";
  else if (scores.preSurge >= 74 || scores.accumulation >= 72) r = "급등 직전 후보";
  else if (scores.breakoutReady >= 65 || scores.upsideRoom >= 62) r = "대기";
  else r = "관찰";

  if (filing.level === "높음") {
    const order = ["관찰", "대기", "급등 직전 후보", "소액 진입 가능", "돌파 확인 후 진입", "추격 금지", "손절 우선", "매매 금지"];
    const cap = order.indexOf("소액 진입 가능");
    if (order.indexOf(r) > cap) r = "소액 진입 가능";
  }
  return r;
}

function isBelowVwap(item) {
  const price = Xn(item);
  const vwap = $n(item);
  return price !== null && vwap !== null && price < vwap * 0.985;
}

function analyzeItem(item, scores, filing, sectionInfo) {
  const change = Math.abs(Zn(item));
  const rsi = item.technical?.rsi ?? item.rsi ?? null;
  const flags = {
    vwapBelow: isBelowVwap(item),
    rsiOverheated: rsi !== null && rsi > 72,
    changeOverheated: change >= 45,
    changeExtreme: change >= 90,
    riskHigh: (item.riskScore ?? 0) >= 75,
    volumeAccelInsufficient: !kbkHasTradeVolume(item),
    disclosureRisk: filing.level === "높음",
    defaultBlock: sectionInfo.rule === "no-trade-volume-and-change<40",
  };
  return flags;
}

function couldDowngrade(item, scores, sectionInfo, decision) {
  if (sectionInfo.section !== "avoid" && decision !== "매매 금지") return null;
  const change = Math.abs(Zn(item));
  const scoreProxy = scores.preSurge * 0.22 + scores.accumulation * 0.2 + scores.breakoutReady * 0.24;
  if (change >= 45 || (item.technical?.rsi ?? 0) > 72) return "눌림 대기";
  if (scoreProxy >= 55 || scores.accumulation >= 60) return "즉시 관찰";
  if (scoreProxy >= 48) return "눌림 대기(완화 시)";
  return null;
}

// stub scores - need ur, dr, fr, pr from bundle; use simplified from Pr call path
function ur(e) {
  const t = Math.abs(Zn(e));
  return Math.round(P(50 + (t < 20 ? 20 : 0)));
}
function drScore(e) {
  return Math.round(P(tr(e) * 0.5 + 30));
}
function fr(e) {
  return 50;
}
function pr(e) {
  return 50;
}

const res = await fetch(SCANNER_URL, { cache: "no-store" });
const payload = await res.json();
const items = payload?.data?.items ?? [];

const sectionCounts = {};
const decisionCounts = {};
const avoidItems = [];
const causeCounts = {
  "VWAP/거래량 부족 (kbkHasTradeVolume=false)": 0,
  "상승률 <40% + 거래량 부족": 0,
  "dropRisk≥82": 0,
  "공시 높음 + dropRisk≥72": 0,
  "RSI 과열 (보조)": 0,
  "상승률 과열 (보조)": 0,
  "riskScore≥75 (보조)": 0,
  "volumeAcceleration 부족 (vwapBars<3)": 0,
  "공시 위험 (높음)": 0,
};

let downgradeWait = 0;
let downgradeObserve = 0;

for (const item of items) {
  const scores = {
    preSurge: ur(item),
    accumulation: drScore(item),
    breakoutReady: fr(item),
    upsideRoom: pr(item),
    chasingRisk: mr(item),
    dropRisk: hr(item),
  };
  const filing = gr(item);
  const sectionInfo = Tr(item, scores, filing);
  const decision = Dr(sectionInfo.section, scores, filing);
  const flags = analyzeItem(item, scores, filing, sectionInfo);

  sectionCounts[sectionInfo.section] = (sectionCounts[sectionInfo.section] || 0) + 1;
  decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;

  if (sectionInfo.section === "avoid") {
    avoidItems.push({ symbol: item.symbol, change: Zn(item), rule: sectionInfo.rule, decision, scores, filing: filing.level, vwapBars: item.technical?.vwapBars ?? 0, flags });
    if (!kbkHasTradeVolume(item)) causeCounts["VWAP/거래량 부족 (kbkHasTradeVolume=false)"] += 1;
    if (sectionInfo.rule === "no-trade-volume-and-change<40") causeCounts["상승률 <40% + 거래량 부족"] += 1;
    if (scores.dropRisk >= 82) causeCounts["dropRisk≥82"] += 1;
    if (filing.level === "높음" && scores.dropRisk >= 72) causeCounts["공시 높음 + dropRisk≥72"] += 1;
    if (flags.rsiOverheated) causeCounts["RSI 과열 (보조)"] += 1;
    if (flags.changeOverheated) causeCounts["상승률 과열 (보조)"] += 1;
    if (flags.riskHigh) causeCounts["riskScore≥75 (보조)"] += 1;
    if (flags.volumeAccelInsufficient) causeCounts["volumeAcceleration 부족 (vwapBars<3)"] += 1;
    if (flags.disclosureRisk) causeCounts["공시 위험 (높음)"] += 1;

    const down = couldDowngrade(item, scores, sectionInfo, decision);
    if (down?.includes("눌림")) downgradeWait += 1;
    if (down === "즉시 관찰") downgradeObserve += 1;
  }
}

console.log(
  JSON.stringify(
    {
      totalScannerItems: items.length,
      sectionCounts,
      decisionCounts,
      avoidSectionCount: avoidItems.length,
      note: "UI filter '매매 금지' maps to section=avoid (Jr filter value avoid)",
      primaryAvoidRules: avoidItems.reduce((acc, x) => {
        acc[x.rule] = (acc[x.rule] || 0) + 1;
        return acc;
      }, {}),
      causeCountsAmongAvoid: causeCounts,
      couldDowngradeToWait: downgradeWait,
      couldDowngradeToObserve: downgradeObserve,
      sampleAvoid: avoidItems.slice(0, 8),
    },
    null,
    2,
  ),
);
