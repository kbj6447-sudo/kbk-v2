const POLL_MS = 3000;

let selectedSymbol = null;
let pollTimer = null;
let lastQuote = null;
let lastBars = [];
let usdKrw = 1365;

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
  const n = num(value);
  if (n === null) return "-";
  return `${krwText(n)} (${usdText(n)})`;
}

function priceUsd(quote) {
  return positiveNum(quote?.price) ?? positiveNum(quote?.preMarketPrice) ?? positiveNum(quote?.regularMarketPrice);
}

function changePct(quote) {
  return num(quote?.changePercent) ?? num(quote?.preMarketChangePercent) ?? 0;
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
  if (raw.includes("up")) return "상승";
  if (raw.includes("down")) return "하락";
  return changePct(quote) > 0 ? "상승" : "횡보";
}

function supportResistance(quote, bars) {
  const lows = bars.map((bar) => positiveNum(bar.low ?? bar.l)).filter((v) => v !== null);
  const highs = bars.map((bar) => positiveNum(bar.high ?? bar.h)).filter((v) => v !== null);
  const support = lows.length ? Math.min(...lows) : positiveNum(quote?.dayLow);
  const resistance = highs.length ? Math.max(...highs) : positiveNum(quote?.dayHigh);
  return { support, resistance };
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

  let action = "관찰 후 눌림 대기";
  let tone = "neutral";
  let reason = "거래량과 가격 구조는 감시할 만하지만, 실제 진입 전에는 눌림 후 재지지와 VWAP 반응을 다시 확인해야 합니다.";

  if (risk >= 80 || change >= 120) {
    action = "신규 진입 리스크 높음";
    tone = "danger";
    reason = "당일 상승률 또는 리스크 점수가 높아 추격 매수보다 눌림과 지지 확인이 우선입니다.";
  } else if (trend === "상승" && vwap === "VWAP 위" && probability >= 65 && risk < 65) {
    action = "단타 관심 후보";
    tone = "strong";
    reason = "상승 흐름과 VWAP 우위가 같이 잡혀 있어, 직전 고점 돌파 또는 짧은 눌림 후 재상승을 확인할 후보입니다.";
  } else if (vwap === "VWAP 아래") {
    action = "VWAP 회복 대기";
    tone = "wait";
    reason = "현재는 VWAP 아래라서 바로 따라가기보다 회복 후 유지되는지 보는 쪽이 안전합니다.";
  } else if (pattern >= 70 && probability >= 55) {
    action = "패턴 감시 후보";
    tone = "watch";
    reason = "유사 급등 패턴과 확률 점수는 살아 있으나, 체결 강도와 박스권 돌파를 추가로 확인해야 합니다.";
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
  if (!usable.length) return `<div class="kbk-empty-chart">차트 데이터를 기다리는 중입니다.</div>`;

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
    <svg class="kbk-detail-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(selectedSymbol)} 실시간 차트">
      <path class="kbk-chart-area" d="${area}"></path>
      <path class="kbk-chart-line" d="${path}"></path>
      ${level(signal.support, "kbk-line-support", "지지")}
      ${level(signal.resistance, "kbk-line-resistance", "저항")}
      ${level(vwapValue(lastQuote), "kbk-line-vwap", "VWAP")}
    </svg>
  `;
}

function detailHtml(quote, bars, loading = false) {
  const signal = analyzeSignal(quote, bars);
  const price = signal.price;
  const krw = pricePairText(price);
  const usd = price === null ? "-" : `USD ${usdText(price)}`;
  const scoreText = signal.probability === null ? "계산중" : Math.round(signal.probability);
  const badge = signal.tone === "danger" ? "위험" : signal.tone === "strong" ? "관심" : signal.tone === "wait" ? "대기" : "감시";

  return `
    <div class="kbk-detail-head">
      <div>
        <p class="kbk-kicker">선택 종목 상세 감시</p>
        <h3>${esc(quote.symbol ?? selectedSymbol)} <span>${esc(quote.name ?? "")}</span></h3>
        <p>${esc(signal.reason)}</p>
      </div>
      <div class="kbk-detail-score">
        <strong>${scoreText}</strong>
        <span>${badge}</span>
      </div>
      <button type="button" class="kbk-detail-close" aria-label="상세 닫기">×</button>
    </div>

    <div class="kbk-detail-price">
      <strong>${krw}</strong>
      <span>${usd}</span>
      <span>${pct(signal.change)}</span>
      <span>거래량 ${compact(signal.volume)}</span>
      <span>${esc(signal.vwap)}</span>
      ${loading ? `<span class="kbk-live-chip">실시간 갱신 중</span>` : ""}
    </div>

    <section class="kbk-signal-panel kbk-${signal.tone}">
      <div>
        <span>선택 종목 실시간 차트/시그널</span>
        <strong>${esc(signal.action)}</strong>
      </div>
      <div class="kbk-signal-grid">
        <div><span>현재 위치</span><strong>${esc(signal.position)}</strong><small>박스권 내 위치</small></div>
        <div><span>진입 확인선</span><strong>${levelText(signal.entryLine, "계산중")}</strong><small>돌파/재지지 확인</small></div>
        <div><span>손절 기준선</span><strong>${levelText(signal.stopLine, "데이터 부족")}</strong><small>지지 이탈 시 주의</small></div>
        <div><span>1차 익절 참고</span><strong>${levelText(signal.profitLine, "계산중")}</strong><small>단기 +3% 기준</small></div>
      </div>
      ${chartSvg(bars, signal)}
    </section>

    <section class="kbk-explain-grid">
      <div><span>개별 설명</span><p>${esc(quote.symbol ?? selectedSymbol)}는 현재 ${esc(signal.trend)} 흐름, ${esc(signal.vwap)} 상태입니다. 점수만 보지 말고 거래량 유지, 고점 돌파 실패 여부, 눌림 후 재상승을 같이 보셔야 합니다.</p></div>
      <div><span>리스크 설명</span><p>추격 위험 ${Math.round(signal.risk)}점, 유사 패턴 ${Math.round(signal.pattern)}점입니다. 상승률이 큰 종목은 신호가 좋아도 신규 진입 리스크가 빠르게 커집니다.</p></div>
      <div><span>확인 순서</span><p>1. VWAP 회복/유지 2. 직전 고점 돌파 3. 눌림 시 거래량 감소 4. 재상승 거래량 증가 순서로 확인하세요.</p></div>
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

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.message || `API error ${res.status}`);
  return json;
}

async function refreshDetail(symbol, loading = false) {
  const shell = ensureShell();
  shell.hidden = false;
  if (loading && !lastQuote) {
    shell.innerHTML = `<div class="kbk-detail-head"><div><p class="kbk-kicker">선택 종목 상세 감시</p><h3>${esc(symbol)}</h3><p>실시간 시세와 분봉 차트를 불러오는 중입니다.</p></div><button type="button" class="kbk-detail-close" aria-label="상세 닫기">×</button></div>`;
  }

  try {
    const from = encodeURIComponent(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString());
    const [quotePayload, historyPayload, exchangePayload] = await Promise.all([
      fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`),
      fetchJson(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${from}`).catch(() => null),
      fetchJson(`/api/exchange`).catch(() => null),
    ]);
    lastQuote = quotePayload.data ?? quotePayload;
    lastBars = historyPayload ? normalizeBars(historyPayload) : fallbackBars(lastQuote);
    usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
    shell.innerHTML = detailHtml(lastQuote, lastBars, loading);
  } catch (error) {
    shell.innerHTML = `
      <div class="kbk-detail-head">
        <div><p class="kbk-kicker">선택 종목 상세 감시</p><h3>${esc(symbol)}</h3><p>${esc(error.message || "상세 데이터를 불러오지 못했습니다.")}</p></div>
        <button type="button" class="kbk-detail-close" aria-label="상세 닫기">×</button>
      </div>
    `;
  }
}

function selectSymbol(symbol, card) {
  if (!symbol) return;
  selectedSymbol = symbol.toUpperCase();
  lastQuote = null;
  lastBars = [];
  document.querySelectorAll(".stock-card.kbk-selected-card,.setup-card.kbk-selected-card").forEach((el) => el.classList.remove("kbk-selected-card"));
  card?.classList.add("kbk-selected-card");
  refreshDetail(selectedSymbol, true);
  window.clearInterval(pollTimer);
  pollTimer = null;
}

function closeDetail() {
  selectedSymbol = null;
  window.clearInterval(pollTimer);
  pollTimer = null;
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
      <strong>폭등 감시 후보는 매수 신호가 아니라 “움직임 감시 등급”입니다.</strong>
      <p>여기서의 관심/강한 감시는 상승률, 뉴스/공시, 거래량, 모멘텀이 강해 계속 볼 종목이라는 뜻입니다. 이미 많이 오른 종목도 감시 후보에 뜰 수 있으며, 실제 신규 진입 여부는 눌림, VWAP 재지지, 과열 위험을 따로 확인해야 합니다.</p>
      <div class="kbk-clarifier-grid">
        <div><span>관심</span><b>움직임이 있어 감시</b></div>
        <div><span>강한 감시</span><b>주도주 가능성 확인</b></div>
        <div><span>매수 판단</span><b>아직 아님, 자리 확인 필요</b></div>
      </div>
    `;
  }
  if (pathname.includes("/scanner/accumulation") || pathname.includes("/accumulation")) {
    return `
      <strong>매집 스캐너는 “지금 신규 진입해도 되는 자리인지”를 더 보수적으로 판단합니다.</strong>
      <p>폭등 감시 후보에 뜬 종목이라도 이미 크게 오른 구간이면 매매 금지 또는 관찰 후 눌림 대기가 나올 수 있습니다. 이 화면의 매매 금지는 종목 자체가 나쁘다는 뜻이 아니라, 현재 위치에서 추격 매수 위험이 크다는 의미입니다.</p>
      <div class="kbk-clarifier-grid">
        <div><span>매매 금지</span><b>지금 신규 진입 금지</b></div>
        <div><span>눌림 대기</span><b>VWAP/지지 재확인</b></div>
        <div><span>진입 후보</span><b>과열과 급락 위험 낮을 때</b></div>
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
  const trendGood = trend === "상승";
  const volumeGood = volume >= 1_000_000 || rvol >= 1.5;
  const lowPriceBonus = price > 0 && price <= 8 ? 6 : 0;
  const sweetChange = change >= 8 && change <= 45 ? 20 : change > 45 && change <= 80 ? 10 : change > 80 ? -12 : change >= 3 ? 12 : 0;

  const scalpScore = clampScore(
    35
      + (vwapGood ? 20 : -18)
      + (trendGood ? 18 : -12)
      + (volumeGood ? 16 : -8)
      + sweetChange
      + (scanner >= 70 ? 10 : scanner >= 55 ? 5 : 0)
      + lowPriceBonus
  );

  const surgeScore = clampScore(
    scanner * 0.45
      + clampScore(Math.max(change, 0), 0, 100) * 0.25
      + (sourceTags.some((tag) => String(tag).includes("news") || String(tag).includes("sec-8k")) ? 14 : 0)
      + (storyTags.length ? Math.min(storyTags.length * 5, 12) : 0)
      + (volume >= 10_000_000 ? 10 : volume >= 2_000_000 ? 6 : 0)
  );

  const setupScore = clampScore(
    40
      + (vwapGood ? 18 : -16)
      + (trendGood ? 12 : -10)
      + (change >= 5 && change <= 35 ? 18 : change > 35 && change <= 65 ? 7 : change > 65 ? -12 : 2)
      + (pattern >= 65 ? 10 : pattern >= 55 ? 5 : 0)
      + (volumeGood ? 10 : -5)
      - (risk >= 75 ? 12 : risk >= 60 ? 6 : 0)
  );

  const chaseRisk = clampScore(
    risk * 0.55
      + (change >= 100 ? 30 : change >= 70 ? 20 : change >= 45 ? 12 : 0)
      + (!vwapGood ? 15 : 0)
      + (trendGood ? 0 : 10)
  );
  const safetyScore = clampScore(100 - chaseRisk);
  const finalScore = Math.round(clampScore(scalpScore * 0.38 + surgeScore * 0.27 + setupScore * 0.25 + safetyScore * 0.10));

  let verdict = "관찰 후보";
  if (finalScore >= 78 && chaseRisk < 62) verdict = "최우선 단타 후보";
  else if (finalScore >= 68 && chaseRisk < 75) verdict = "상위 감시 후보";
  else if (chaseRisk >= 80) verdict = "과열 주의 후보";

  const reasons = [];
  if (vwapGood) reasons.push("VWAP 위/근처");
  if (trendGood) reasons.push("1분 추세 상승");
  if (volumeGood) reasons.push("거래량 확인");
  if (sourceTags.some((tag) => String(tag).includes("news") || String(tag).includes("sec-8k"))) reasons.push("뉴스/공시 촉발");
  if (change > 65) reasons.push("상승률 과열 주의");
  if (chaseRisk >= 75) reasons.push("추격 리스크 높음");

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
    scalpScore: Math.round(scalpScore),
    surgeScore: Math.round(surgeScore),
    setupScore: Math.round(setupScore),
    chaseRisk: Math.round(chaseRisk),
    finalScore,
    verdict,
    reasons: reasons.length ? reasons : ["가격/거래량 구조 감시"],
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
    .kbk-top-score{font-size:3rem;font-weight:900;line-height:1;color:#0f172a;text-align:right}
    .kbk-top-score span{display:block;font-size:.78rem;color:#fff;background:#2563eb;border-radius:999px;padding:7px 10px;margin-top:8px}
    .kbk-top-row{display:flex;flex-wrap:wrap;gap:12px;color:#334155;margin-top:14px}
    .kbk-top-row strong{color:#0f172a}
    .kbk-top-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}
    .kbk-top-metrics div{background:#f8fafc;border-radius:16px;padding:12px}
    .kbk-top-metrics span{display:block;color:#64748b;font-size:.8rem}
    .kbk-top-metrics b{display:block;color:#0f172a;margin-top:5px}
    .kbk-top-reasons{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
    .kbk-top-reasons span{background:#cffafe;color:#155e75;border-radius:999px;padding:7px 10px;font-size:.78rem;font-weight:700}
    .kbk-top-note{background:#fff7ed;border:1px solid rgba(249,115,22,.22);border-radius:20px;color:#7c2d12;padding:16px 18px;line-height:1.65}
    .kbk-top-loading,.kbk-top-empty{background:#fff;border:1px solid rgba(15,23,42,.12);border-radius:20px;padding:22px;color:#334155}
    @media (max-width:1100px){.kbk-top-grid{grid-template-columns:1fr}.kbk-top-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
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
  document.querySelectorAll(".page-stack > .page-panel").forEach((section) => {
    section.style.display = enabled ? "none" : "";
  });
  panel.hidden = !enabled;
  document.querySelectorAll(".menu-link").forEach((link) => link.classList.remove("active"));
  document.getElementById("kbk-top-picks-menu")?.classList.toggle("active", enabled);
  if (enabled && !panel.dataset.loaded) loadTopPicks();
}

function renderTopPickLoading() {
  const panel = topPickPanel();
  if (!panel) return;
  panel.innerHTML = `
    <section class="kbk-top-hero">
      <p>Integrated Top Picks</p>
      <h2>세 스캐너를 합쳐 현재 가장 괜찮은 종목만 추립니다.</h2>
      <p>단타 시그널, 폭등 감시, 매집/진입 적합도를 함께 보고 과열과 추격 위험을 감점합니다.</p>
      <button type="button" class="kbk-page-refresh kbk-top-refresh" data-kbk-page-refresh>새로고침</button>
    </section>
    <section class="kbk-top-loading">통합 후보를 실시간으로 계산하는 중입니다.</section>
  `;
}

function renderTopPicks(picks, updatedAt) {
  const panel = topPickPanel();
  if (!panel) return;
  const top = picks[0];
  panel.dataset.loaded = "true";
  panel.innerHTML = `
    <section class="kbk-top-hero">
      <p>Integrated Top Picks</p>
      <h2>통합 최종 후보</h2>
      <p>실시간 단타 시그널은 지금 진입 조건, 폭등 감시는 강한 움직임, 매집 스캐너는 신규 진입 리스크를 봅니다. 이 메뉴는 세 기준을 합쳐 최종 점수가 높은 종목만 보여줍니다.</p>
      <button type="button" class="kbk-page-refresh kbk-top-refresh" data-kbk-page-refresh>새로고침</button>
    </section>
    <section class="kbk-top-note">
      ${top ? `현재 1순위는 ${esc(top.symbol)}입니다. 단, 통합 점수도 매수 확정이 아니라 눌림, VWAP, 체결 강도 재확인을 위한 우선순위입니다.` : "현재 세 조건을 동시에 만족하는 강한 후보가 없습니다."}
      <br>마지막 계산: ${updatedAt ? new Date(updatedAt).toLocaleTimeString("ko-KR") : new Date().toLocaleTimeString("ko-KR")}
    </section>
    ${picks.length ? `<section class="kbk-top-grid">
      ${picks.map((pick, index) => `
        <article class="kbk-top-card">
          <div class="kbk-top-head">
            <div>
              <h3>${esc(pick.symbol)}</h3>
              <p>${esc(pick.name)}</p>
            </div>
            <div class="kbk-top-score">${pick.finalScore}<span>${index === 0 ? "1순위" : esc(pick.verdict)}</span></div>
          </div>
          <div class="kbk-top-row">
            <strong>${pricePairText(pick.price)}</strong>
            <span>${pct(pick.change)}</span>
            <span>거래량 ${compact(pick.volume)}</span>
            <span>RVOL ${pick.rvol ? pick.rvol.toFixed(1) : "-"}</span>
            <span>${esc(pick.vwap)}</span>
          </div>
          <div class="kbk-top-metrics">
            <div><span>단타 적합</span><b>${pick.scalpScore}점</b></div>
            <div><span>폭등 감시</span><b>${pick.surgeScore}점</b></div>
            <div><span>진입 구조</span><b>${pick.setupScore}점</b></div>
            <div><span>추격 위험</span><b>${pick.chaseRisk}점</b></div>
          </div>
          <div class="kbk-top-reasons">${pick.reasons.map((reason) => `<span>${esc(reason)}</span>`).join("")}</div>
        </article>
      `).join("")}
    </section>` : `<section class="kbk-top-empty">현재 통합 조건을 통과한 종목이 없습니다. 자동 갱신 중입니다.</section>`}
  `;
}

function priceUsdText(value) {
  return usdText(value);
}

async function loadTopPicks() {
  renderTopPickLoading();
  try {
    const [payload, exchangePayload] = await Promise.all([
      fetchJson("/api/scanner"),
      fetchJson("/api/exchange").catch(() => null),
    ]);
    usdKrw = num(exchangePayload?.rate) ?? num(exchangePayload?.usdKrw) ?? num(exchangePayload?.data?.rate) ?? usdKrw;
    const items = payload?.data?.items ?? payload?.items ?? [];
    const scored = items
      .filter((item) => item?.symbol && item.included !== false)
      .map(scoreTopPick)
      .filter((pick) => pick.change >= 3)
      .filter((pick) => pick.vwap.includes("위") || pick.vwap.includes("근처"))
      .filter((pick) => pick.trend === "상승")
      .filter((pick) => pick.volume >= 500_000 || pick.rvol >= 1.5)
      .filter((pick) => pick.chaseRisk < 85)
      .filter((pick) => pick.finalScore >= 62 || pick.scalpScore >= 72 || pick.surgeScore >= 72)
      .sort((a, b) => b.finalScore - a.finalScore || a.chaseRisk - b.chaseRisk)
      .slice(0, 20);
    if (scored.length < 20) {
      const seen = new Set(scored.map((pick) => pick.symbol));
      const supplemental = items
        .filter((item) => item?.symbol && item.included !== false)
        .map(scoreTopPick)
        .filter((pick) => pick.change >= 3)
        .filter((pick) => !seen.has(pick.symbol))
        .filter((pick) => pick.volume >= 300_000 || pick.rvol >= 1.2 || pick.surgeScore >= 58)
        .filter((pick) => pick.chaseRisk < 92)
        .sort((a, b) => b.finalScore - a.finalScore || a.chaseRisk - b.chaseRisk);
      scored.push(...supplemental.slice(0, 20 - scored.length));
      scored.sort((a, b) => b.finalScore - a.finalScore || a.chaseRisk - b.chaseRisk);
    }
    renderTopPicks(scored.slice(0, 20), payload?.data?.updatedAt ?? payload?.updatedAt);
  } catch (error) {
    const panel = topPickPanel();
    if (panel) panel.innerHTML = `<section class="kbk-top-empty">통합 후보 계산 실패: ${esc(error.message)}</section>`;
  }
}

function syncTopPicksMenu() {
  const menu = document.querySelector(".menu-bar");
  if (menu && !document.getElementById("kbk-top-picks-menu")) {
    const button = document.createElement("button");
    button.id = "kbk-top-picks-menu";
    button.type = "button";
    button.className = "menu-link menu-button";
    button.textContent = "통합 최종 후보";
    button.addEventListener("click", () => {
      window.location.hash = "top-picks";
      setTopPickMode(true);
      loadTopPicks();
    });
    menu.appendChild(button);
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

function visibleSurgeCards() {
  if (!isSurgeWatchPage()) return [];
  return Array.from(document.querySelectorAll(".stock-card")).filter((card) => {
    const page = card.closest(".page-panel");
    return page && !page.classList.contains("hidden-panel") && card.querySelector("h3");
  });
}

function krwTextFromUsd(price) {
  return pricePairText(price);
}

function updateSurgeCardQuote(card, quote, livePrice = null) {
  const priceRow = card.querySelector(".price-row");
  if (!priceRow) return;
  const price = num(livePrice) ?? priceUsd(quote);
  const previousClose = num(quote?.previousClose);
  const change = price !== null && previousClose ? ((price - previousClose) / previousClose) * 100 : changePct(quote);
  const volume = num(quote?.volume) ?? num(quote?.preMarketVolume);
  const rvol = relativeVolumeOf(quote);
  const vwap = vwapState(quote);
  const strong = priceRow.querySelector("strong");
  const spans = Array.from(priceRow.querySelectorAll("span"));

  if (strong) strong.textContent = krwTextFromUsd(price);
  if (spans[0]) spans[0].textContent = pct(change);
  if (spans[1]) spans[1].textContent = rvol ? `상대거래량 ${rvol.toFixed(1)}배` : "상대거래량 -";
  if (spans[2]) spans[2].textContent = `거래량 ${compact(volume)}`;
  if (spans[3]) spans[3].textContent = vwap;

  let stamp = priceRow.querySelector(".kbk-live-quote-stamp");
  if (!stamp) {
    stamp = document.createElement("span");
    stamp.className = "kbk-live-quote-stamp";
    priceRow.appendChild(stamp);
  }
  stamp.textContent = `실시간 ${new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
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
    if (label === "현재가") {
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
    badge.textContent = `실시간 분봉 ${priceUsdText(price)} / ${krwTextFromUsd(price)} · ${time}`;
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
  button.textContent = "새로고침";
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
