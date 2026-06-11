import fs from "fs";
import vm from "vm";

const block = fs.readFileSync(
  new URL("./accumulation-scoring-block.js", import.meta.url),
  "utf8",
);
const ctx = { Kn: 1365, console };
vm.createContext(ctx);
vm.runInContext(`${block}\nthis.Pr = Pr; this.kbkHasTradeVolume = kbkHasTradeVolume; this.Tr = Tr; this.Dr = Dr; this.Zn = Zn; this.tr = tr; this.er = er; this.Xn = Xn; this.$n = $n;`, ctx);

const { Pr, kbkHasTradeVolume, Tr, Dr, Zn, tr, er, Xn, $n } = ctx;

const SCANNER_URL = "https://kbk-theta-accumulation.vercel.app/api/scanner";
const res = await fetch(SCANNER_URL, { cache: "no-store" });
const items = (await res.json())?.data?.items ?? [];

function matchesFilter(section, filter) {
  if (filter === "all") return true;
  if (filter === "preSurge") return section === "preSurge";
  if (filter === "accumulating") return section === "accumulating";
  if (filter === "breakoutReady") return section === "breakoutReady";
  if (filter === "pullback") return section === "pullbackRebound";
  if (filter === "surged") return section === "surgedContinuation";
  if (filter === "chasingRisk") return section === "chasingRisk";
  if (filter === "avoid") return section === "avoid";
  return true;
}

function classifyAvoidReason(item, scores, filing) {
  const change = Math.abs(Zn(item));
  const hasVol = kbkHasTradeVolume(item);
  const vwap = $n(item);
  const vwapDist = vwap ? er(Xn(item), vwap) : null;
  const rsi = item.technical?.rsi ?? null;

  if (!hasVol && change < 40) return "상승률<40% + VWAP/1분봉 거래량 부족";
  if (filing.level === "높음" && scores.dropRisk >= 72) return "공시 높음 + dropRisk≥72";
  if (scores.dropRisk >= 82) return "dropRisk≥82";
  return "avoid-기타";
}

function tagContributors(item, scores, filing) {
  const change = Math.abs(Zn(item));
  const rsi = item.technical?.rsi ?? null;
  const vwap = $n(item);
  const price = Xn(item);
  const tags = [];
  if (vwap && price < vwap * 0.985) tags.push("VWAP 아래");
  if (rsi !== null && rsi > 72) tags.push("RSI 과열");
  if (change >= 45) tags.push("상승률 과열");
  if ((item.riskScore ?? 0) >= 75) tags.push("riskScore 높음");
  if (!kbkHasTradeVolume(item) || (item.technical?.vwapBars ?? 0) < 3) tags.push("volumeAcceleration 부족");
  if (filing.level === "높음") tags.push("공시 위험");
  return tags;
}

const analyzed = items.map((item) => {
  const row = Pr(item, { name: item.name, reasons: item.selectionReasons });
  return { item, row };
});

const sectionCounts = {};
const decisionCounts = {};
for (const { row } of analyzed) {
  sectionCounts[row.section] = (sectionCounts[row.section] || 0) + 1;
  decisionCounts[row.currentDecision] = (decisionCounts[row.currentDecision] || 0) + 1;
}

const avoidRows = analyzed.filter(({ row }) => row.section === "avoid");
const causePrimary = {};
const causeTags = {
  "VWAP 아래": 0,
  "RSI 과열": 0,
  "상승률 과열": 0,
  "riskScore 높음": 0,
  "volumeAcceleration 부족": 0,
  "공시 위험": 0,
  "기본값 진입금지": 0,
};

let downgradeWait = 0;
let downgradeObserve = 0;

for (const { item, row } of avoidRows) {
  const reason = classifyAvoidReason(item, row.scores, row.filingRisk);
  causePrimary[reason] = (causePrimary[reason] || 0) + 1;
  for (const tag of tagContributors(item, row.scores, row.filingRisk)) {
    causeTags[tag] = (causeTags[tag] || 0) + 1;
  }
  if (reason.includes("거래량 부족")) causeTags["기본값 진입금지"] += 1;

  const change = Math.abs(row.changePct);
  const rsi = item.technical?.rsi ?? 0;
  const s = row.scores;
  const composite = s.preSurge * 0.22 + s.accumulation * 0.2 + s.breakoutReady * 0.24;
  if (change >= 45 || rsi > 72) downgradeWait += 1;
  else if (composite >= 55 || s.accumulation >= 60 || row.currentDecision === "관찰") downgradeObserve += 1;
  else if (composite >= 48) downgradeWait += 1;
}

const kbkPanel = analyzed.reduce((acc, { row }) => {
  const label = row.quote?.actionLabel;
  if (label) acc[label] = (acc[label] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      totalItems: analyzed.length,
      uiFilterNote: "칩 '매매 금지' = section 'avoid' (Jr 필터). 카드 배지 currentDecision도 대부분 '매매 금지'",
      sectionCounts,
      decisionCounts,
      avoidSectionCount: avoidRows.length,
      primaryAvoidReasons: causePrimary,
      contributorTagsAmongAvoid: causeTags,
      couldDowngradeToPullbackWait: downgradeWait,
      couldDowngradeToObserve: downgradeObserve,
      sampleAvoid: avoidRows.slice(0, 6).map(({ item, row }) => ({
        symbol: item.symbol,
        changePct: row.changePct,
        vwapBars: item.technical?.vwapBars,
        vwapStatus: item.technical?.vwapStatus,
        hasTradeVolume: kbkHasTradeVolume(item),
        dropRisk: row.scores.dropRisk,
        chasingRisk: row.scores.chasingRisk,
        filing: row.filingRisk.level,
        currentDecision: row.currentDecision,
        primaryReason: classifyAvoidReason(item, row.scores, row.filingRisk),
        tags: tagContributors(item, row.scores, row.filingRisk),
      })),
    },
    null,
    2,
  ),
);
