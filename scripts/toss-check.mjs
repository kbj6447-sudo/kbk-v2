// 토스증권 Open API 점검 스크립트 (조회만 함, 주문 없음)
// 실행: node scripts/toss-check.mjs [종목]   예) node scripts/toss-check.mjs TSLA
// 확인 항목: 인증/허용 IP, 미국 랭킹 3종, 현재가, 1분봉(프리·애프터마켓 포함 여부), 호가 스프레드, 호출 한도 헤더
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    const value = line.slice(line.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const require = createRequire(import.meta.url);
const toss = require("../lib/tossClient.js");

function etTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function kstTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function etMinutes(iso) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
function sessionOf(iso) {
  const m = etMinutes(iso);
  if (m >= 4 * 60 && m < 9 * 60 + 30) return "PRE";
  if (m >= 9 * 60 + 30 && m < 16 * 60) return "REGULAR";
  if (m >= 16 * 60 && m < 20 * 60) return "AFTER";
  return "OTHER(데이마켓/야간)";
}

let ok = 0;
let fail = 0;
async function step(title, fn) {
  process.stdout.write(`\n■ ${title}\n`);
  try {
    await fn();
    ok += 1;
  } catch (error) {
    fail += 1;
    console.log(`  ✗ 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!toss.isEnabled()) {
  console.log("TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 이 없습니다. .env 파일을 먼저 만드세요 (toss-env.example.txt 참고).");
  process.exit(1);
}

let sampleSymbol = (process.argv[2] || "").toUpperCase();

for (const [type, duration] of [["MARKET_TRADING_VOLUME", "realtime"], ["MARKET_TRADING_AMOUNT", "realtime"], ["TOP_GAINERS", "1d"]]) {
  await step(`랭킹 ${type} (${duration})`, async () => {
    const { rankedAt, items } = await toss.getRankings({ type, duration, marketCountry: "US", count: 10 });
    console.log(`  집계 시각: KST ${kstTime(rankedAt)} / ET ${etTime(rankedAt)}  항목 ${items.length}개`);
    for (const it of items.slice(0, 5)) {
      console.log(`  ${String(it.rank).padStart(2)}. ${it.symbol.padEnd(6)} $${it.lastPrice}  ${it.changePercent?.toFixed(2)}%  거래량 ${it.tradingVolume?.toLocaleString()}`);
    }
    if (!sampleSymbol && items[0]) sampleSymbol = items[0].symbol;
    if (!items.length) console.log("  (빈 결과: 이 조합은 현재 집계되지 않음)");
  });
}

sampleSymbol = sampleSymbol || "AAPL";

await step(`현재가 ${sampleSymbol}`, async () => {
  const map = await toss.getPrices([sampleSymbol]);
  const p = map.get(sampleSymbol);
  console.log(`  $${p?.lastPrice}  시각 KST ${kstTime(p?.timestamp)} / ET ${etTime(p?.timestamp)}`);
});

await step(`1분봉 ${sampleSymbol} (최근 200개)`, async () => {
  const bars = await toss.getMinuteBars(sampleSymbol, 200);
  if (!bars.length) throw new Error("봉 없음");
  const first = bars[0];
  const last = bars.at(-1);
  const ageMin = Math.round((Date.now() - Date.parse(last.endTime)) / 60000);
  console.log(`  범위: ET ${etTime(first.time)} ~ ${etTime(last.time)} (${bars.length}개)`);
  console.log(`  마지막 봉 종료 후 경과: ${ageMin}분`);
  const counts = {};
  for (const b of bars) counts[sessionOf(b.time)] = (counts[sessionOf(b.time)] || 0) + 1;
  console.log(`  세션별 봉 수: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log("  → PRE 또는 AFTER 가 0이면 토스 1분봉에 연장거래 봉이 없을 가능성이 있음 (해당 시간대에 실행해 재확인)");
});

await step(`호가 ${sampleSymbol}`, async () => {
  const ob = await toss.getOrderbook(sampleSymbol);
  console.log(`  매수1 $${ob.bestBid} / 매도1 $${ob.bestAsk}  스프레드 ${ob.spreadPercent?.toFixed(3)}%  호가 단계 ${ob.bids.length}/${ob.asks.length}`);
});

const status = toss.getStatus();
console.log("\n■ 호출 한도(응답 헤더 기준, 초당)");
for (const [group, info] of Object.entries(status.rateLimit)) {
  console.log(`  ${group}: limit ${info.limit ?? "-"}, remaining ${info.remaining ?? "-"}`);
}
if (!Object.keys(status.rateLimit).length) console.log("  (헤더 없음)");

console.log(`\n결과: 성공 ${ok} / 실패 ${fail}`);
if (fail && status.pausedUntil) {
  console.log("인증 오류로 중단됨: 허용 IP 에 이 PC 의 IP 가 등록되어 있는지, 키를 정확히 넣었는지 확인하세요.");
}
console.log("참고: 이 스크립트가 새 토큰을 발급하므로, 실행 중인 스캐너는 다음 호출 때 토큰을 자동 재발급합니다.");
