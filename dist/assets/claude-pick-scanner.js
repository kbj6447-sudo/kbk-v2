
/* ============================================
   클로드픽 (Claude Pick) Scanner
   RVOL 폭발 + 아직 가격 안 오른 급등 전조 종목 탐지
   ============================================ */

(function() {
  'use strict';

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pickLivePrice(item) {
    return num(item.normalizedLivePriceUsd)
      ?? num(item.price)
      ?? num(item.preMarketPrice)
      ?? num(item.postMarketPrice)
      ?? num(item.regularMarketPrice)
      ?? 0;
  }

  function fmtUsd(usd) {
    const price = num(usd);
    if (price === null) return '-';
    return `$${price.toFixed(price >= 10 ? 2 : 4)}`;
  }

  // ---- 클로드픽 점수 계산 알고리즘 ----
  function calcClaudeScore(item) {
    const rvol = item.relativeVolume ?? item.volumeRatio ?? 0;
    const changePct = Math.abs(item.changePercent ?? 0);
    const aboveVwap = item.aboveVwap;
    const trend = item.oneMinuteTrend?.toLowerCase();
    const stage = item.stage ?? '';
    const preSurge = item.surgePrecursorScore ?? 50;
    const rsi = item.rsi ?? 50;
    const scannerScore = item.scannerScore ?? 50;
    const hasVwap = item.vwap && item.vwap > 0;
    const pullback = item.technical?.pullbackVolumeSignal ?? false;
    const ma5vs20 = item.technical?.ma5vs20 ?? item.ma5vs20;
    const commonSignalBonus = Math.max(0, Math.min(10, Math.round(num(item.rankAuxiliaryScore) ?? 0)));

    // 1. RVOL 점수 (핵심 - 가격 대비 거래량 폭발)
    // 아직 가격은 조용한데 거래량이 먼저 터지는 것이 핵심
    let rvolScore = 0;
    if (rvol >= 50)       rvolScore = 40;
    else if (rvol >= 20)  rvolScore = 35;
    else if (rvol >= 10)  rvolScore = 28;
    else if (rvol >= 5)   rvolScore = 20;
    else if (rvol >= 3)   rvolScore = 13;
    else if (rvol >= 2)   rvolScore = 7;

    // RVOL은 높은데 가격 상승이 작으면 보너스 (핵심 매집 신호)
    const rvolVsPricePremium = (rvol >= 5 && changePct <= 20) ? 8 :
                               (rvol >= 3 && changePct <= 15) ? 5 : 0;

    // 2. 가격 아직 안 오른 점수 (낮을수록 선취매 기회)
    let priceScore = 0;
    if (changePct <= 10)       priceScore = 28;
    else if (changePct <= 20)  priceScore = 22;
    else if (changePct <= 35)  priceScore = 14;
    else if (changePct <= 50)  priceScore = 6;

    // 3. 스테이지 점수 (PRE-SURGE가 최고)
    const stageScore = stage === 'PRE-SURGE' ? 18 :
                       stage === 'EARLY SURGE' ? 13 :
                       stage === 'ACCUMULATION' ? 10 : 0;

    // 4. VWAP 관계 (VWAP 위 = 매수세 우위)
    const vwapScore = hasVwap ? (aboveVwap ? 9 : -3) : 0;

    // 5. 1분봉 추세
    const trendScore = trend === 'up' ? 8 : trend === 'down' ? -5 : 0;

    // 6. RSI (적정 구간 = 과매수 아닌 것)
    const rsiScore = rsi > 78 ? -12 : rsi > 70 ? -6 :
                     rsi >= 40 && rsi <= 65 ? 7 : 0;

    // 7. 기존 preSurge 점수 보조 반영 (20%)
    const preSurgeBonus = Math.round((preSurge - 50) * 0.08);

    // 8. 눌림목 신호 (이미 올라갔다 눌린 후 재상승 시도)
    const pullbackBonus = pullback ? 5 : 0;

    // 9. MA5 > MA20 골든크로스
    const maScore = ma5vs20 === 'above' ? 5 : 0;

    const total = rvolScore + rvolVsPricePremium + priceScore + stageScore +
                  vwapScore + trendScore + rsiScore + preSurgeBonus + pullbackBonus + maScore + commonSignalBonus;

    return {
      total: Math.max(0, Math.min(100, Math.round(total))),
      breakdown: { rvolScore, rvolVsPricePremium, priceScore, stageScore, vwapScore, trendScore, rsiScore, preSurgeBonus, pullbackBonus, maScore, commonSignalBonus }
    };
  }

  // ---- 신호 등급 분류 ----
  function getSignalLabel(score, rvol, changePct, stage) {
    if (score >= 75 && rvol >= 10 && changePct <= 20) return { label: '🔥 강력 선취매 신호', color: '#dc2626', bg: '#fef2f2' };
    if (score >= 65 && stage === 'PRE-SURGE')          return { label: '⚡ 급등 직전 포착', color: '#d97706', bg: '#fffbeb' };
    if (score >= 55 && rvol >= 3)                      return { label: '📈 매집 진행 중', color: '#2563eb', bg: '#eff6ff' };
    if (score >= 45)                                    return { label: '👀 관심 종목', color: '#6b7280', bg: '#f9fafb' };
    return { label: '대기', color: '#9ca3af', bg: '#f3f4f6' };
  }

  // ---- 패널 HTML 생성 ----
  function buildClaudePickPanel(items, usdKrw) {
    const krw = usdKrw || 1500;

    const scored = items
      .filter(item => item.symbol && item.included !== false)
      .map(item => {
        const sc = calcClaudeScore(item);
        const rvol = item.relativeVolume ?? item.volumeRatio ?? 0;
        const changePct = item.changePercent ?? 0;
        return { ...item, claudeScore: sc.total, breakdown: sc.breakdown, rvol, changePct };
      })
      .filter(item => item.claudeScore >= 40)
      .sort((a, b) => b.claudeScore - a.claudeScore);

    const top = scored.slice(0, 3); // 강력 신호
    const watch = scored.slice(3, 15); // 관심

    function fmtKrw(usd) {
      return Math.round(usd * krw).toLocaleString('ko-KR');
    }

    function itemHTML(item, rank) {
      const rvol = item.rvol;
      const changePct = item.changePct;
      const sig = getSignalLabel(item.claudeScore, rvol, Math.abs(changePct), item.stage);
      const livePrice = pickLivePrice(item);
      const priceKrw = fmtKrw(livePrice);
      const priceText = `${priceKrw}원 (${fmtUsd(livePrice)})`;
      const rvolDisplay = rvol >= 1 ? rvol.toFixed(1) + 'x' : '-';
      const changeColor = changePct >= 0 ? '#16a34a' : '#dc2626';
      const rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';

      return `
        <div class="cpick-card" data-symbol="${item.symbol}" style="
          background: white;
          border: 1.5px solid #e5e7eb;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 12px;
          cursor: pointer;
          transition: box-shadow 0.2s;
        " onmouseenter="this.style.boxShadow='0 4px 20px rgba(99,102,241,0.15)'"
           onmouseleave="this.style.boxShadow='none'">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px">
            <div>
              <span style="font-weight:800; font-size:17px; color:#111">${rankEmoji} ${item.symbol}</span>
              <span style="margin-left:8px; font-size:11px; color:#6b7280">${item.name ?? ''}</span>
            </div>
            <div style="text-align:right">
              <div style="
                background:${sig.bg};
                color:${sig.color};
                border:1px solid ${sig.color}33;
                border-radius:20px;
                padding:3px 10px;
                font-size:11px;
                font-weight:700;
              ">${sig.label}</div>
            </div>
          </div>

          <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:10px">
            <div style="background:#f8fafc; border-radius:8px; padding:8px; text-align:center">
              <div style="font-size:10px; color:#6b7280; margin-bottom:2px">RVOL</div>
              <div style="font-weight:800; font-size:16px; color:${rvol>=10?'#dc2626':rvol>=5?'#d97706':'#2563eb'}">${rvolDisplay}</div>
            </div>
            <div style="background:#f8fafc; border-radius:8px; padding:8px; text-align:center">
              <div style="font-size:10px; color:#6b7280; margin-bottom:2px">상승률</div>
              <div style="font-weight:800; font-size:14px; color:${changeColor}">${changePct>=0?'+':''}${changePct.toFixed(1)}%</div>
            </div>
            <div style="background:#f8fafc; border-radius:8px; padding:8px; text-align:center">
              <div style="font-size:10px; color:#6b7280; margin-bottom:2px">현재가</div>
              <div style="font-weight:700; font-size:13px">${priceText}</div>
            </div>
            <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6); border-radius:8px; padding:8px; text-align:center">
              <div style="font-size:10px; color:#c7d2fe; margin-bottom:2px">클로드점수</div>
              <div style="font-weight:900; font-size:18px; color:white">${item.claudeScore}</div>
            </div>
          </div>

          <div style="display:flex; gap:6px; flex-wrap:wrap">
            <span style="background:#f0fdf4; color:#15803d; border-radius:6px; padding:2px 8px; font-size:11px">
              ${item.stage ?? '-'}
            </span>
            <span style="background:${item.aboveVwap?'#eff6ff':'#fff7ed'}; color:${item.aboveVwap?'#1d4ed8':'#c2410c'}; border-radius:6px; padding:2px 8px; font-size:11px">
              VWAP ${item.aboveVwap?'위 ✅':'아래'}
            </span>
            <span style="background:#faf5ff; color:#7e22ce; border-radius:6px; padding:2px 8px; font-size:11px">
              추세 ${item.oneMinuteTrend==='up'?'↑ 상승':item.oneMinuteTrend==='down'?'↓ 하락':'→'}
            </span>
            <span style="background:#f8fafc; color:#374151; border-radius:6px; padding:2px 8px; font-size:11px">
              RSI ${item.rsi?.toFixed(0)??'-'}
            </span>
          </div>

          <div style="margin-top:10px; padding:8px; background:#fafafa; border-radius:8px; font-size:11px; color:#6b7280">
            <strong style="color:#111">왜 클로드픽?</strong>
            ${rvol>=10?'거래량이 평소 대비 '+rvol.toFixed(0)+'배 폭발하는 중. ':''}
            ${Math.abs(changePct)<=20?'아직 가격 상승은 '+Math.abs(changePct).toFixed(1)+'%로 초기 단계. ':''}
            ${item.stage==='PRE-SURGE'?'PRE-SURGE 단계 — 곧 폭발 가능성 높음. ':''}
            ${item.technical?.pullbackVolumeSignal?'눌림 후 거래량 회복 신호 감지. ':''}
          </div>
        </div>
      `;
    }

    return `
      <div id="claude-pick-panel" style="
        max-width: 760px;
        margin: 0 auto;
        padding: 20px 16px;
        font-family: -apple-system, 'Pretendard', sans-serif;
      ">
        <div style="
          background: linear-gradient(135deg, #4f46e5, #7c3aed);
          border-radius: 20px;
          padding: 24px;
          margin-bottom: 24px;
          color: white;
        ">
          <div style="font-size:12px; letter-spacing:2px; opacity:0.8; margin-bottom:6px">CLAUDE PICK / AI SURGE DETECTOR</div>
          <h1 style="font-size:22px; font-weight:900; margin:0 0 8px">🤖 클로드픽 — 급등 전조 탐지</h1>
          <p style="font-size:13px; opacity:0.85; margin:0">
            이미 오른 종목이 아닌, <strong>RVOL이 먼저 폭발하는데 가격은 아직 조용한 종목</strong>을 사전에 찾습니다.<br>
            PRE-SURGE 단계 + 높은 RVOL + 낮은 상승률 = 선취매 기회
          </p>
        </div>

        <div style="background:#fef3c7; border:1px solid #f59e0b; border-radius:10px; padding:12px 16px; margin-bottom:20px; font-size:12px; color:#92400e">
          ⚠️ 이 화면은 매수 추천이 아닙니다. 진입 전 반드시 VWAP, 체결 강도, 뉴스/공시를 직접 확인하세요.
        </div>

        ${top.length > 0 ? `
        <div style="margin-bottom:8px">
          <h2 style="font-size:15px; font-weight:800; color:#111; margin:0 0 12px">
            🔥 강력 선취매 신호 <span style="color:#6b7280; font-weight:400; font-size:12px">상위 ${top.length}개</span>
          </h2>
          ${top.map((item, i) => itemHTML(item, i+1)).join('')}
        </div>
        ` : `<div style="text-align:center; padding:40px; color:#9ca3af">강력 신호 종목이 없습니다</div>`}

        ${watch.length > 0 ? `
        <div style="margin-top:24px">
          <h2 style="font-size:14px; font-weight:800; color:#374151; margin:0 0 12px">
            👀 관심 종목 <span style="color:#6b7280; font-weight:400; font-size:12px">${watch.length}개</span>
          </h2>
          ${watch.map((item, i) => itemHTML(item, i+4)).join('')}
        </div>
        ` : ''}

        <div style="margin-top:24px; padding:16px; background:#f8fafc; border-radius:12px; font-size:12px; color:#6b7280">
          <strong style="color:#374151">클로드픽 스코어링 기준</strong><br>
          RVOL 폭발도 (40pt) + 가격 미선반영도 (28pt) + PRE-SURGE 단계 (18pt) + VWAP 위치 (9pt) + 1분 추세 (8pt) + RSI 적정 (7pt)<br>
          <span style="color:#9ca3af">※ RVOL이 높은데 가격이 아직 안 오른 종목일수록 높은 점수</span>
        </div>
      </div>
    `;
  }

  // ---- 패널 표시/숨김 토글 ----
  let claudePickVisible = false;
  let panelEl = null;

  async function showClaudePick() {
    claudePickVisible = !claudePickVisible;

    if (!claudePickVisible) {
      if (panelEl) { panelEl.style.display = 'none'; }
      // 기존 main 복원
      document.querySelector('main.page-stack').style.display = '';
      return;
    }

    // main 숨기기
    document.querySelector('main.page-stack').style.display = 'none';

    // 패널 없으면 생성
    if (!panelEl) {
      panelEl = document.createElement('div');
      panelEl.id = 'claude-pick-container';
      panelEl.style.cssText = 'overflow-y:auto; padding: 0;';
      document.querySelector('#root > div') ?
        document.querySelector('#root > div').appendChild(panelEl) :
        document.body.appendChild(panelEl);
    }

    panelEl.innerHTML = '<div style="text-align:center;padding:60px;color:#6366f1;font-size:16px">🤖 클로드픽 분석 중...</div>';
    panelEl.style.display = 'block';

    try {
      // 데이터 가져오기
      const [scanRes, exRes] = await Promise.all([
        fetch('/api/scanner', { cache: 'no-store' }).then(r => r.json()),
        fetch('/api/exchange', { cache: 'no-store' }).then(r => r.json()).catch(() => null)
      ]);

      const items = scanRes?.data?.items ?? [];
      const usdKrw = exRes?.data?.usdKrw ?? exRes?.data ?? 1500;

      panelEl.innerHTML = buildClaudePickPanel(items, usdKrw);

      // 카드 클릭 시 해당 종목 선택
      panelEl.querySelectorAll('.cpick-card').forEach(card => {
        card.addEventListener('click', () => {
          const sym = card.dataset.symbol;
          // 클로드픽 닫고 해당 종목으로
          claudePickVisible = false;
          panelEl.style.display = 'none';
          document.querySelector('main.page-stack').style.display = '';
          // 티커 검색란에 입력
          const input = document.querySelector('input[placeholder*="티커"], input[placeholder*="ticker"]');
          if(input) { input.value = sym; input.dispatchEvent(new Event('input', {bubbles:true})); }
        });
      });
    } catch(e) {
      panelEl.innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626">데이터 로드 실패: ' + e.message + '</div>';
    }
  }

  // ---- 메뉴 버튼에 이벤트 연결 ----
  function attachMenuEvent() {
    const btn = document.getElementById('claude-pick-menu');
    if(btn && !btn._claudeAttached) {
      btn.addEventListener('click', showClaudePick);
      btn._claudeAttached = true;
    }
  }

  attachMenuEvent();

  // MutationObserver로 버튼 재생성 감지
  const obs = new MutationObserver(() => {
    const nav = document.querySelector('nav.menu-bar');
    if(nav && !document.getElementById('claude-pick-menu')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-link menu-button';
      btn.id = 'claude-pick-menu';
      btn.textContent = '🤖 클로드픽';
      btn.style.cssText = 'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-weight:700;';
      nav.appendChild(btn);
      btn.addEventListener('click', showClaudePick);
      btn._claudeAttached = true;
    } else {
      attachMenuEvent();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  console.log('[ClaudePick] 클로드픽 스캐너 로드 완료');
})();
