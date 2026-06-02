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
var kisToken = require('../lib/kisToken');
var KIS_BASE_URL = kisToken.KIS_BASE_URL;
var getKisAccessToken = kisToken.getKisAccessToken;

function getKstParts(date) {
  var shifted = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return {
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes()
  };
}

function getSessionType(date) {
  var parts = getKstParts(date);
  var totalMinutes = parts.hour * 60 + parts.minute;
  if (totalMinutes >= 9 * 60 && totalMinutes < 17 * 60) return 'DAY';
  if (totalMinutes >= 17 * 60 && totalMinutes < 22 * 60 + 30) return 'PRE';
  if (totalMinutes >= 22 * 60 + 30 || totalMinutes < 5 * 60) return 'REGULAR';
  return 'AFTER';
}

function getPreferredKisMarketCodes(exchangeName) {
  var normalized = String(exchangeName || '').toUpperCase();
  if (normalized.indexOf('NYSE') >= 0 || normalized.indexOf('NYQ') >= 0) {
    return ['BAY', 'BAQ', 'BAA'];
  }
  if (normalized.indexOf('AMEX') >= 0 || normalized.indexOf('ASE') >= 0) {
    return ['BAA', 'BAQ', 'BAY'];
  }
  return ['BAQ', 'BAY', 'BAA'];
}

async function fetchJson(url, options) {
  var response = await fetch(url, options);
  var payload = await response.json().catch(function() { return null; });
  return { response: response, payload: payload };
}

async function fetchKisQuoteForCode(symbol, marketCode, token) {
  var appKey = process.env.KIS_APP_KEY;
  var appSecret = process.env.KIS_APP_SECRET;
  if (!token || !appKey || !appSecret) return null;

  var result = await fetchJson(
    KIS_BASE_URL + '/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=' + encodeURIComponent(marketCode) + '&SYMB=' + encodeURIComponent(symbol),
    {
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'authorization': 'Bearer ' + token,
        'appkey': appKey,
        'appsecret': appSecret,
        'tr_id': 'HHDFS00000300',
        'custtype': 'P'
      }
    }
  );

  if (!result.response.ok || !result.payload || result.payload.rt_cd !== '0') return null;
  return result.payload.output || null;
}

async function fetchKisQuote(symbol, exchangeName, sessionType) {
  if (sessionType !== 'DAY') {
    return {
      ok: false,
      sessionType: sessionType,
      reason: 'non-day-session'
    };
  }

  var token = await getKisAccessToken();
  if (!token) {
    return {
      ok: false,
      sessionType: sessionType,
      reason: 'missing-token'
    };
  }

  var marketCodes = getPreferredKisMarketCodes(exchangeName);
  for (var i = 0; i < marketCodes.length; i++) {
    var marketCode = marketCodes[i];
    var output = await fetchKisQuoteForCode(symbol, marketCode, token);
    var last = output ? num(output.last) : null;
    var tvol = output ? num(output.tvol) : null;
    if (output && (last !== null || tvol !== null)) {
      return {
        ok: true,
        sessionType: sessionType,
        marketCode: marketCode,
        price: last,
        previousClose: num(output.base),
        diff: num(output.diff),
        rate: num(output.rate),
        volume: tvol,
        amount: num(output.tamt),
        raw: output
      };
    }
  }

  return {
    ok: false,
    sessionType: sessionType,
    reason: 'no-usable-market-code'
  };
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

    // v7: quote endpoint (may be unauthorized but try)
    var v7Url = 'https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(symbol);
    // v8: use range=5d+includePrePost=true to get today's pre-market bars even on Monday morning
    var v8Url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=5d&interval=2m&includePrePost=true';
    // Also try 1-min for more precision
    var v8aUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1m&includePrePost=true';

    var rs = await Promise.allSettled([
      fetch(v7Url, { headers: hdrs }).then(function(r) { return r.json(); }),
      fetch(v8Url, { headers: hdrs }).then(function(r) { return r.json(); }),
      fetch(v8aUrl, { headers: hdrs }).then(function(r) { return r.json(); })
    ]);

    var v7 = rs[0].status === 'fulfilled' ? rs[0].value : null;
    var v8 = rs[1].status === 'fulfilled' ? rs[1].value : null;
    var v8a = rs[2].status === 'fulfilled' ? rs[2].value : null;

    // v7 quote data (may be empty if unauthorized)
    var q = (v7 && v7.quoteResponse && v7.quoteResponse.result && v7.quoteResponse.result[0]) || {};

    // Pick best chart result: prefer v8a (1m/1d) if it has recent bars, else v8 (2m/5d)
    function getLastClose(chartData) {
      var cr = (chartData && chartData.chart && chartData.chart.result && chartData.chart.result[0]) || null;
      if (!cr) return { lastClose: null, lastTs: null, meta: {}, qi: {} };
      var meta = cr.meta || {};
      var qi = (cr.indicators && cr.indicators.quote && cr.indicators.quote[0]) || {};
      var closes = (qi.close || []).map(num);
      var timestamps = cr.timestamp || [];
      var lastClose = null, lastTs = null;
      for (var i = closes.length - 1; i >= 0; i--) {
        if (closes[i] !== null) { lastClose = closes[i]; lastTs = timestamps[i]; break; }
      }
      return { lastClose: lastClose, lastTs: lastTs, meta: meta, qi: qi, timestamps: timestamps, closes: closes };
    }

    var r8a = getLastClose(v8a);
    var r8 = getLastClose(v8);

    // Use whichever has the more recent bar
    var bestChart;
    var nowTs = Date.now() / 1000;
    var age8a = r8a.lastTs ? nowTs - r8a.lastTs : Infinity;
    var age8 = r8.lastTs ? nowTs - r8.lastTs : Infinity;
    // Prefer v8a (1m) if it's fresh (< 10 min old), else use v8 (2m/5d which covers weekend gap)
    if (age8a <= 600 && r8a.lastClose !== null) {
      bestChart = r8a;
    } else if (age8.lastClose !== null || age8 < age8a) {
      bestChart = r8;
    } else {
      bestChart = r8a;
    }
    // Always use the one with the more recent timestamp
    if (r8a.lastTs && r8.lastTs && r8a.lastTs >= r8.lastTs && r8a.lastClose !== null) {
      bestChart = r8a;
    } else if (r8.lastTs && r8a.lastTs && r8.lastTs > r8a.lastTs && r8.lastClose !== null) {
      bestChart = r8;
    }

    var meta = bestChart.meta;
    var qi = bestChart.qi;
    var cR = bestChart.closes || [];
    var hR = (qi.high || []);
    var lR = (qi.low || []);
    var vR = (qi.volume || []);

    var marketState = String(q.marketState || meta.marketState || '').toUpperCase();
    var sessionType = getSessionType(new Date());
    var regularPrice = orNum(q.regularMarketPrice, meta.regularMarketPrice);
    var latestClose = bestChart.lastClose;
    if (regularPrice === null) regularPrice = latestClose;

    var preMarketPrice = orNum(q.preMarketPrice, meta.preMarketPrice);
    if (preMarketPrice === null) preMarketPrice = regularPrice;
    var postMarketPrice = orNum(q.postMarketPrice, meta.postMarketPrice);
    var previousClose = orNum(q.regularMarketPreviousClose, orNum(q.previousClose, orNum(meta.previousClose, meta.chartPreviousClose)));
    var avgVolume = orNum(q.averageDailyVolume3Month, orNum(q.averageDailyVolume10Day, orNum(meta.averageDailyVolume3Month, meta.averageDailyVolume10Day)));
    var currentVolume = orNum(q.regularMarketVolume, meta.regularMarketVolume);
    var exchangeName = q.exchangeName || meta.exchangeName || meta.fullExchangeName || '';
    var kisQuote = await fetchKisQuote(symbol, exchangeName, sessionType);

    // 실시간 가격 우선순위:
    // latestClose (가장 최신 1분/2분봉 실거래가) 를 최우선으로 사용
    // marketState가 명확할 때만 preMarketPrice/postMarketPrice 사용
    var displayPrice;
    if (latestClose !== null) {
      // 최신 바가 있으면 그걸 기준으로 사용
      displayPrice = latestClose;
      // 단, marketState가 명확하고 extended hours 가격이 latestClose보다 더 최신이면 그것 사용
      if (marketState === 'PRE' && preMarketPrice !== null && preMarketPrice !== regularPrice) {
        displayPrice = preMarketPrice;
      } else if ((marketState === 'POST' || marketState === 'POSTPOST') && postMarketPrice !== null) {
        displayPrice = postMarketPrice;
      }
    } else if (marketState === 'PRE' && preMarketPrice !== null) {
      displayPrice = preMarketPrice;
    } else if ((marketState === 'POST' || marketState === 'POSTPOST') && postMarketPrice !== null) {
      displayPrice = postMarketPrice;
    } else {
      displayPrice = regularPrice;
    }

    var priceSource = 'yahoo';
    var volumeSource = currentVolume !== null ? 'yahoo-regularMarketVolume' : 'yahoo-chart-volume';
    if (kisQuote.ok && kisQuote.price !== null) {
      displayPrice = kisQuote.price;
      priceSource = sessionType === 'DAY' ? 'kis-daymarket' : 'kis';
    }
    if (kisQuote.ok && kisQuote.volume !== null) {
      currentVolume = kisQuote.volume;
      volumeSource = 'kis-tvol';
    }
    if (kisQuote.ok && kisQuote.previousClose !== null) {
      previousClose = kisQuote.previousClose;
    }

    var displayChange = null;
    var displayChangePct = null;
    if (kisQuote.ok && kisQuote.diff !== null && kisQuote.rate !== null) {
      displayChange = kisQuote.diff;
      displayChangePct = kisQuote.rate;
    } else if (displayPrice !== null && previousClose !== null && previousClose !== 0) {
      displayChange = displayPrice - previousClose;
      displayChangePct = (displayChange / previousClose) * 100;
    }

    // VWAP
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

    // RSI
    var validCloses = cR.filter(function(c) { return c !== null; });
    var rsi = null;
    if (validCloses.length >= 15) {
      var recent = validCloses.slice(-15);
      var gains = 0, losses = 0;
      for (var j = 1; j < recent.length; j++) {
        var diff = recent[j] - recent[j - 1];
        if (diff > 0) gains += diff; else losses += Math.abs(diff);
      }
      var ag = gains / 14, al = losses / 14;
      rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }

    var ma5 = validCloses.length >= 5 ? avg(validCloses.slice(-5)) : null;
    var ma20 = validCloses.length >= 20 ? avg(validCloses.slice(-20)) : null;
    var oneMinuteTrend = 'neutral';
    if (validCloses.length >= 3) {
      var last3 = validCloses.slice(-3);
      if (last3[2] > last3[0]) oneMinuteTrend = 'up';
      else if (last3[2] < last3[0]) oneMinuteTrend = 'down';
    }

    if (currentVolume === null && vR.length > 0) {
      var vs = vR.map(num).filter(function(v) { return v !== null && v > 0; });
      currentVolume = vs.reduce(function(s, v) { return s + v; }, 0) || null;
      if (!kisQuote.ok) volumeSource = currentVolume !== null ? 'yahoo-chart-volume' : volumeSource;
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
        relativeVolume: volumeRatio,
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
        latestBarAge: bestChart.lastTs ? Math.round((Date.now()/1000) - bestChart.lastTs) : null,
        sourceTags: ['yahoo-v7-v8-direct', age8a <= 600 ? '1m-fresh' : '2m-5d'].concat(kisQuote.ok ? ['kis-overseas-price'] : []),
        sessionType: sessionType,
        priceSource: priceSource,
        volumeSource: volumeSource,
        kisMarketCode: kisQuote.marketCode || null,
        kisPrice: kisQuote.price || null,
        kisVolume: kisQuote.volume || null,
        kisRate: kisQuote.rate || null,
        kisDiff: kisQuote.diff || null
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
