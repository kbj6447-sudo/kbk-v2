// api/exchange.js — USD/KRW 환율 (open.er-api.com 프록시, 1시간 캐시)

let cached = null;
let cachedAt = 0;
const CACHE_MS = 60 * 60 * 1000; // 1시간

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

    try {
        const now = Date.now();

            // 캐시가 살아있으면 바로 반환
                if (cached && now - cachedAt < CACHE_MS) {
                      res.setHeader("cache-control", `public, max-age=${Math.floor((CACHE_MS - (now - cachedAt)) / 1000)}`);
                            return res.status(200).json({ ok: true, data: cached });
                                }

                                    const erRes = await fetch("https://open.er-api.com/v6/latest/USD", {
                                          headers: { accept: "application/json" },
                                              });
                                                  const payload = await erRes.json();

                                                      if (!erRes.ok || payload?.result !== "success") {
                                                            throw new Error(payload?.error_type || `HTTP ${erRes.status}`);
                                                                }

                                                                    const krw = payload?.rates?.KRW;
                                                                        if (!krw) throw new Error("KRW rate not found in response");

                                                                            cached = {
                                                                                  usdKrw: krw,
                                                                                        rate: krw,
                                                                                              base: "USD",
                                                                                                    updatedAt: payload.time_last_update_utc || new Date().toUTCString(),
                                                                                                        };
                                                                                                            cachedAt = now;
                                                                                                            
                                                                                                                res.setHeader("cache-control", `public, max-age=3600`);
                                                                                                                    return res.status(200).json({ ok: true, data: cached });
                                                                                                                      } catch (error) {
                                                                                                                          // fallback: 마지막 캐시라도 반환
                                                                                                                              if (cached) {
                                                                                                                                    res.setHeader("cache-control", "no-store");
                                                                                                                                          return res.status(200).json({ ok: true, data: cached, stale: true });
                                                                                                                                              }
                                                                                                                                                  return res.status(502).json({
                                                                                                                                                        ok: false,
                                                                                                                                                              code: "EXCHANGE_ERROR",
                                                                                                                                                                    message: error instanceof Error ? error.message : "exchange handler failed",
                                                                                                                                                                        });
                                                                                                                                                                          }
                                                                                                                                                                          };
