function num(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function avg(arr) {
  var clean = arr.map(num).filter(function(v) { return v !== null && v > 0; });
  if (!clean.length) return null;
  return clean.reduce(function(s, v) { return s + v; }, 0) / clean.length;
}
function orNum(a, b) {
  var va = num(a);
  return va !== null ? va : num(b);
}
module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    var url = new URL(req.url, 'https://kbk-theta-accumulation.vercel.app');
    var symbol = url.searchParams.get('symbol') || '';
    if (!symbol || /^\d+$/.test(symbol)) {
      return res.status(400).json({ ok: false, code: 'BAD_SYMBOL', message: 'Invalid symbol: ' + symbol });
    }
    var hdrs = { 'user-agent': 'Mozilla/5.0', 'accept': 'application/json' };
    var v7Url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbol);
    var v8Url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1m&includePrePost=true';
    var rs = await Promise.allSettled([
      fetch(v7Url, { headers: hdrs }).then(function(r) { return r.json(); }),
      fetch(v8Url, { headers: hdrs }).then(function(r) { return r.json(); })
    ]);
    var v7 = rs[0].status === 'fulfilled' ? rs[0].value : null;
    var v8 = rs[1].status === 'fulfilled' ? rs[1].value : null;
    var q = (v7 && v7.quoteResponse && v7.quoteResponse.result && v7.quoteResponse.result[0]) || {};
    var cr = (v8 && v8.chart && v8.chart.result && v8.chart.result[0]) || null;
    var meta = (cr && cr.meta) || {};
    var qi = (cr && cr.indicators && cr.indicators.quote && cr.indicators.quote[0]) || {};
    var cR = qi.close || [], hR = qi.high || [], lR = qi.low || [], vR = qi.volume || [];
    var marketState = String(q.marketState || meta.marketState || '').toUpperCase();
    var regularPrice = orNum(q.regularMarketPrice, meta.regularMarketPrice);
    var closes = cR.map(num).filter(function(v) { return v !== null; });
    var latestClose = closes.length ? closes[closes.length - 1] : null;
    if (regularPrice === null) regularPrice = latestClose;
    var preMarketPrice = orNum(q.preMarketPrice, meta.preMarketPrice);
    if (preMarketPrice === null) preMarketPrice = regularPrice;
    var postMarketPrice = orNum(q.postMarketPrice, meta.postMarketPrice);
    var previousClose = orNum(q.regularMarketPreviousClose, orNum(q.previousClose, orNum(meta.previousClose, meta.chartPreviousClose)));
    var avgVolume = orNum(q.averageDailyVolume3Month, orNum(q.averageDailyVolume10Day, orNum(meta.averageDailyVolume3Month, meta.averageDailyVolume10Day)));
    var currentVolume = orNum(q.regularMarketVolume, meta.regularMarketVolume);
    var displayPrice = regularPrice;
    if (marketState === 'PRE' && preMarketPrice !== null) {
      displayPrice = preMarketPrice;
    } else if ((marketState === 'POST' || marketState === 'POSTPOST') && postMarketPrice !== null) {
      displayPrice = postMarketPrice;
    } else if (!marketState && latestClose !== null) {
      displayPrice = latestClose;
    }
    var displayChange = null;
    var displayChangePct = null;
    if (displayPrice !== null && previousClose !== null && previousClose !== 0) {
      displayChange = displayPrice - previousClose;
      displayChangePct = (displayChange / previousClose) * 100;
    }
    var vwapPV = 0, vwapVol = 0;
    for (var i = 0; i < cR.length; i++) {
      var h = num(hR[i]), l = num(lR[i]), c = num(cR[i]), v = num(vR[i]);
      if (h !== null && l !== null && c !== null && v !== null && v > 0) {
        vwapPV += ((h + l + c) / 3) * v;
        vwapVol += v;
      }
    }
    var vwap = vwapVol > 0 ? vwapPV / vwapVol : null;
    var aboveVwap = (vwap !== null && displayPrice !== null) ? displayPrice >= vwap : null;
    var rsi = null;
    if (closes.length >= 15) {
      var recent = closes.slice(-15);
      var gains = 0, losses = 0;
      for (var j = 1; j < recent.length; j++) {
        var diff = recent[j] - recent[j - 1];
        if (diff > 0) gains += diff; else losses += Math.abs(diff);
      }
      var ag = gains / 14, al = losses / 14;
      rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    var ma5 = closes.length >= 5 ? avg(closes.slice(-5)) : null;
    var ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;
    var oneMinuteTrend = 'neutral';
    if (closes.length >= 3) {
      var last3 = closes.slice(-3);
      if (last3[2] > last3[0]) oneMinuteTrend = 'up';
      else if (last3[2] < last3[0]) oneMinuteTrend = 'down';
    }
    if (currentVolume === null && vR.length > 0) {
      var vs = vR.map(num).filter(function(v) { return v !== null && v > 0; });
      currentVolume = vs.reduce(function(s, v) { return s + v; }, 0) || null;
    }
    var volumeRatio = (avgVolume && currentVolume) ? currentVolume / avgVolume : null;
    var isExtended = marketState === 'PRE' || marketState === 'POST' || marketState === 'POSTPOST';
    return res.status(200).json({
      ok: true,
      data: {
        symbol: q.symbol || meta.symbol || symbol,
        name: q.longName || q.shortName || meta.longName || meta.shortName || symbol,
        price: displayPrice,
        regularMarketPrice: regularPrice,
        preMarketPrice: preMarketPrice,
        postMarketPrice: postMarketPrice,
        change: displayChange,
        changePercent: displayChangePct,
        previousClose: previousClose,
        marketState: marketState,
        extendedHours: isExtended,
        dayHigh: orNum(q.regularMarketDayHigh, meta.regularMarketDayHigh),
        dayLow: orNum(q.regularMarketDayLow, meta.regularMarketDayLow),
        volume: currentVolume,
        averageVolume: avgVolume,
        volumeRatio: volumeRatio,
        vwap: vwap,
        aboveVwap: aboveVwap,
        vwapStatus: vwap !== null ? 'calculated' : 'unavailable',
        rsi: rsi,
        ma5: ma5,
        ma20: ma20,
        ma5vs20: (ma5 !== null && ma20 !== null) ? (ma5 >= ma20 ? 'above' : 'below') : null,
        oneMinuteTrend: oneMinuteTrend,
        exchange: q.exchangeName || meta.exchangeName || meta.fullExchangeName || null,
        currency: q.currency || meta.currency || 'USD',
        sourceTags: ['yahoo-v7-v8-direct']
      }
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      code: 'QUOTE_ERROR',
      message: error instanceof Error ? error.message : 'quote handler failed'
    });
  }
};
