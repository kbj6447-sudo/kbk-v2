// api/quote.js - Yahoo Finance 직접 호출 (데이마켓/프리마켓/정규장 실시간 반영)

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

        var yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=1m&includePrePost=true';
              var yahooRes = await fetch(yahooUrl, {
                        headers: { 'user-agent': 'Mozilla/5.0', 'accept': 'application/json' }
              });
              var payload = await yahooRes.json();

        if (!yahooRes.ok || (payload && payload.chart && payload.chart.error)) {
                  var errMsg = (payload && payload.chart && payload.chart.error && payload.chart.error.description) || ('Yahoo HTTP ' + yahooRes.status);
                  return res.status(502).json({ ok: false, code: 'UPSTREAM_ERROR', message: errMsg });
        }

        var result = payload.chart.result[0];
              var meta = result.meta || {};
              var quoteData = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
              var timestamps = result.timestamp || [];

        var closesRaw = quoteData.close || [];
              var highsRaw = quoteData.high || [];
              var lowsRaw = quoteData.low || [];
              var volumesRaw = quoteData.volume || [];

        var closes = closesRaw.map(num).filter(function(v) { return v !== null; });
              var volumes = volumesRaw.map(num).filter(function(v) { return v !== null && v > 0; });

        // 현재가 결정
        var regularPrice = orNum(meta.regularMarketPrice, closes[closes.length - 1]);
              var preMarketPrice = orNum(meta.preMarketPrice, regularPrice);
              var postMarketPrice = num(meta.postMarketPrice);
              var previousClose = orNum(meta.previousClose, meta.chartPreviousClose);

        var marketState = String(meta.marketState || '').toUpperCase();

        var displayPrice = regularPrice;
              if (marketState === 'PRE' && preMarketPrice !== null) {
                        displayPrice = preMarketPrice;
              } else if ((marketState === 'POST' || marketState === 'POSTPOST') && postMarketPrice !== null) {
                        displayPrice = postMarketPrice;
              }

        var displayChange = null;
              var displayChangePct = null;
              if (displayPrice !== null && previousClose !== null && previousClose !== 0) {
                        displayChange = displayPrice - previousClose;
                        displayChangePct = (displayChange / previousClose) * 100;
              }

        // VWAP 계산
        var vwapPV = 0;
              var vwapVol = 0;
              for (var i = 0; i < closesRaw.length; i++) {
                        var h = num(highsRaw[i]);
                        var l = num(lowsRaw[i]);
                        var c = num(closesRaw[i]);
                        var v = num(volumesRaw[i]);
                        if (h !== null && l !== null && c !== null && v !== null && v > 0) {
                                    vwapPV += ((h + l + c) / 3) * v;
                                    vwapVol += v;
                        }
              }
              var vwap = vwapVol > 0 ? vwapPV / vwapVol : null;
              var aboveVwap = (vwap !== null && displayPrice !== null) ? displayPrice >= vwap : null;

        // RSI(14)
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

        // MA5, MA20
        var ma5 = closes.length >= 5 ? avg(closes.slice(-5)) : null;
              var ma20 = closes.length >= 20 ? avg(closes.slice(-20)) : null;

        // 1분 추세
        var oneMinuteTrend = 'neutral';
              if (closes.length >= 3) {
                        var last3 = closes.slice(-3);
                        if (last3[2] > last3[0]) oneMinuteTrend = 'up';
                        else if (last3[2] < last3[0]) oneMinuteTrend = 'down';
              }

        // 거래량
        var currentVolume = num(meta.regularMarketVolume);
              if (currentVolume === null && volumes.length > 0) {
                        currentVolume = volumes.reduce(function(s, v) { return s + v; }, 0);
              }
              var avgVolume = orNum(meta.averageDailyVolume3Month, meta.averageDailyVolume10Day);
              var volumeRatio = (avgVolume && currentVolume) ? currentVolume / avgVolume : null;

        var isExtended = marketState === 'PRE' || marketState === 'POST' || marketState === 'POSTPOST';

        return res.status(200).json({
                  ok: true,
                  data: {
                              symbol: meta.symbol || symbol,
                              name: meta.longName || meta.shortName || symbol,
                              price: displayPrice,
                              regularMarketPrice: regularPrice,
                              preMarketPrice: preMarketPrice,
                              postMarketPrice: postMarketPrice,
                              change: displayChange,
                              changePercent: displayChangePct,
                              previousClose: previousClose,
                              marketState: marketState,
                              extendedHours: isExtended,
                              dayHigh: num(meta.regularMarketDayHigh),
                              dayLow: num(meta.regularMarketDayLow),
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
                              exchange: meta.exchangeName || meta.fullExchangeName || null,
                              currency: meta.currency || 'USD',
                              sourceTags: ['yahoo-direct']
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
