const SCANNER_URL = "https://kbk-theta-accumulation-pro.vercel.app/api/scanner";

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(value) {
  const parsed = num(value);
  if (parsed === null) return "-";
  return `${parsed >= 0 ? "+" : ""}${parsed.toFixed(1)}%`;
}

function compact(value) {
  const parsed = num(value);
  if (parsed === null) return "-";
  if (Math.abs(parsed) >= 1_000_000_000) return `${(parsed / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(parsed) >= 1_000_000) return `${(parsed / 1_000_000).toFixed(1)}M`;
  if (Math.abs(parsed) >= 1_000) return `${Math.round(parsed / 1_000)}K`;
  return String(Math.round(parsed));
}

function livePriceOf(item) {
  return num(item.normalizedLivePriceUsd)
    ?? num(item.price)
    ?? num(item.preMarketPrice)
    ?? num(item.postMarketPrice)
    ?? num(item.regularMarketPrice);
}

function shouldSend(item, minScore) {
  const score = num(item.finalProbabilityScore) ?? num(item.scannerScore) ?? 0;
  const change = num(item.preMarketChangePercent) ?? num(item.changePercent) ?? 0;
  const volume = Math.max(num(item.preMarketVolume) ?? 0, num(item.volume) ?? 0);
  return score >= minScore && change >= 20 && volume >= 500_000;
}

function formatMessage(items) {
  const lines = [
    "KBK PRO alert",
    `Time: ${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    "",
    ...items.map((item, index) => {
      const score = Math.round(num(item.finalProbabilityScore) ?? num(item.scannerScore) ?? 0);
      const price = livePriceOf(item);
      const change = num(item.preMarketChangePercent) ?? num(item.changePercent);
      const volume = Math.max(num(item.preMarketVolume) ?? 0, num(item.volume) ?? 0);
      return `${index + 1}. ${item.symbol} score ${score} / ${price ? `$${price.toFixed(price >= 10 ? 2 : 4)}` : "-"} / ${pct(change)} / volume ${compact(volume)}`;
    }),
    "",
    "Before entry, confirm VWAP, volume, and tape reaction again.",
  ];
  return lines.join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { skipped: true, reason: "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.description || `Telegram API ${response.status}`);
  }
  return { sent: true };
}

module.exports = async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      res.status(401).json({ ok: false, message: "unauthorized" });
      return;
    }

    const minScore = num(process.env.PRO_ALERT_MIN_SCORE) ?? 75;
    const maxAlerts = num(process.env.PRO_ALERT_MAX_ITEMS) ?? 5;
    const response = await fetch(SCANNER_URL, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.message || `scanner ${response.status}`);
    }

    const items = (payload?.data?.items || payload?.items || [])
      .filter((item) => item?.symbol && item.included !== false)
      .filter((item) => shouldSend(item, minScore))
      .sort((a, b) => (num(b.finalProbabilityScore) ?? num(b.scannerScore) ?? 0) - (num(a.finalProbabilityScore) ?? num(a.scannerScore) ?? 0))
      .slice(0, maxAlerts);

    if (!items.length) {
      res.status(200).json({ ok: true, sent: false, count: 0, message: "no candidates" });
      return;
    }

    const telegram = await sendTelegram(formatMessage(items));
    res.status(200).json({
      ok: true,
      count: items.length,
      telegram,
      symbols: items.map((item) => item.symbol),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : "alert scan failed",
    });
  }
};
