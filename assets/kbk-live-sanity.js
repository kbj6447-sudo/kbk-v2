function ready(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn, { once: true });
  } else {
    fn();
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isSurgeRoute() {
  return window.location.pathname.includes("/scanner/surge-watch") || window.location.pathname.includes("/surge-watch");
}

function isUnderOneView() {
  return isSurgeRoute() && /1달러 미만|UNDER \$1/i.test(document.body.textContent || "");
}

function patchSurgeCopy() {
  if (!isUnderOneView()) return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    let text = node.nodeValue || "";
    text = text.replace("1달러 미만 프리마켓 폭등 후보", "1달러 미만 실시간 폭등 후보");
    text = text.replace("프리마켓 폭등 후보", "실시간 폭등 후보");
    text = text.replace("프리마켓 강도", "세션 강도");
    text = text.replace(/(?:현재 세션\s*){2,}/g, "현재 세션 ");
    if (text.includes("상승률과 저가주 여부") && !text.includes("현재 세션 상승률과 저가주 여부")) {
      text = text.replace("상승률과 저가주 여부", "현재 세션 상승률과 저가주 여부");
    }
    text = text.replace("프리마켓 30", "세션 30");
    if (text !== node.nodeValue) node.nodeValue = text;
  }
}

function formatUsd(usd) {
  const price = toNumber(usd);
  if (price === null) return "-";
  return `$${price.toFixed(price >= 10 ? 2 : 4)}`;
}

function formatPricePair(usd, usdKrw) {
  const krw = formatKrw(usd, usdKrw);
  const usdText = formatUsd(usd);
  if (krw === "-" || usdText === "-") return "-";
  return `${krw} (${usdText})`;
}

function formatKrw(usd, usdKrw) {
  const price = toNumber(usd);
  const rate = toNumber(usdKrw) || 1500;
  if (price === null) return "-";
  return `${Math.round(price * rate).toLocaleString("ko-KR")}원`;
}

function pct(value) {
  const n = toNumber(value);
  if (n === null) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function compact(value) {
  const n = toNumber(value);
  if (n === null) return "-";
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}ts=${Date.now()}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || response.statusText);
  return payload;
}

async function latestHistoryPrice(symbol) {
  const from = encodeURIComponent(new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString());
  const payload = await fetchJson(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${from}`);
  const bars = payload?.data?.bars || payload?.bars || [];
  const last = bars[bars.length - 1];
  return toNumber(last?.close);
}

async function usdKrwRate() {
  const payload = await fetchJson("/api/exchange").catch(() => null);
  return toNumber(payload?.rate) || toNumber(payload?.usdKrw) || toNumber(payload?.data?.rate) || 1500;
}

function updateLongDecimals(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const before = node.nodeValue || "";
    const after = before.replace(/(\d+\.\d{2,})(?=점)/g, (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? String(Math.round(n)) : raw;
    });
    if (after !== before) node.nodeValue = after;
  }
}

function updateCard(card, quote, livePrice, rate) {
  const row = card.querySelector(".price-row");
  if (!row) return;

  const price = livePrice ?? toNumber(quote?.price) ?? toNumber(quote?.preMarketPrice);
  const previousClose = toNumber(quote?.previousClose);
  const change = price !== null && previousClose ? ((price - previousClose) / previousClose) * 100 : toNumber(quote?.changePercent);
  const volume = toNumber(quote?.volume) ?? toNumber(quote?.preMarketVolume);
  const existingRvol = (() => {
    const text = row.textContent || "";
    const match = text.match(/상대거래량\s*([\d.]+)배/);
    const value = match ? toNumber(match[1]) : null;
    return value !== null && value > 0 ? value : null;
  })();
  const quoteRvol = toNumber(quote?.relativeVolume) ?? toNumber(quote?.volumeRatio);
  const rvol = quoteRvol !== null && quoteRvol > 0 ? quoteRvol : existingRvol;
  const cells = Array.from(row.querySelectorAll("span"));
  const strong = row.querySelector("strong");

  if (strong) strong.textContent = formatPricePair(price, rate);
  if (cells[0]) cells[0].textContent = pct(change);
  if (cells[1] && rvol !== null) cells[1].textContent = `상대거래량 ${rvol.toFixed(1)}배`;
  if (cells[2]) cells[2].textContent = `거래량 ${compact(volume)}`;
}

async function refreshVisibleSurgeCards() {
  if (!isSurgeRoute()) return;
  patchSurgeCopy();
  updateLongDecimals();

  const cards = Array.from(document.querySelectorAll(".page-panel:not(.hidden-panel) .stock-card")).slice(0, 24);
  if (!cards.length) return;

  const rate = await usdKrwRate();
  await Promise.allSettled(cards.map(async (card) => {
    const symbol = card.querySelector("h3")?.textContent?.trim();
    if (!symbol) return;
    const quotePayload = await fetchJson(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
    const quote = quotePayload?.data || quotePayload;
    const historyPrice = await latestHistoryPrice(symbol).catch(() => null);
    updateCard(card, quote, historyPrice, rate);
  }));
  updateLongDecimals();
}

ready(() => {
  patchSurgeCopy();
  updateLongDecimals();
  window.setTimeout(refreshVisibleSurgeCards, 1200);
  window.setTimeout(refreshVisibleSurgeCards, 3000);
});

window.addEventListener("popstate", () => window.setTimeout(refreshVisibleSurgeCards, 500));
window.addEventListener("hashchange", () => window.setTimeout(refreshVisibleSurgeCards, 500));
document.addEventListener("click", (event) => {
  window.setTimeout(() => {
    patchSurgeCopy();
    updateLongDecimals();
  }, 150);
  if (event.target.closest("[data-kbk-page-refresh]") || event.target.closest(".filter-chip") || event.target.closest(".menu-link")) {
    window.setTimeout(refreshVisibleSurgeCards, 1200);
  }
});
