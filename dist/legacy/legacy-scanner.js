(function(){const t=document.createElement("link").relList;if(t&&t.supports&&t.supports("modulepreload"))return;for(const s of document.querySelectorAll('link[rel="modulepreload"]'))o(s);new MutationObserver(s=>{for(const r of s)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&o(c)}).observe(document,{childList:!0,subtree:!0});function n(s){const r={};return s.integrity&&(r.integrity=s.integrity),s.referrerPolicy&&(r.referrerPolicy=s.referrerPolicy),s.crossOrigin==="use-credentials"?r.credentials="include":s.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function o(s){if(s.ep)return;s.ep=!0;const r=n(s);fetch(s.href,r)}})();const j={scanner:"/api/scanner",quote:e=>`/api/quote?symbol=${encodeURIComponent(e)}`,exchange:"/api/exchange",history:(e,t)=>`/api/history?symbol=${encodeURIComponent(e)}&from=${encodeURIComponent(t)}`,telegramAlert:"/api/telegram-alert"},Ee="scalpScanner.signalRecords.v2",Pe="scalpScanner.entryPrices.v2",ke="scalpScanner.telegramSettings.v1",He="scalpScanner.telegramAlerts.v1",Ze=1e3,Xe=5e3,Qe=3e3,et=15e3,tt=600*1e3,d={items:[],selectedSymbol:null,selectedItem:null,selectedBars:[],exchangeRate:null,lastScanAt:null,lastHistoryAt:0,scanning:!1,monitoring:!1},$=e=>document.getElementById(e),nt=new Intl.NumberFormat("en-US");function ce(e,t){try{return JSON.parse(localStorage.getItem(e)||JSON.stringify(t))??t}catch{return t}}function ie(e,t){localStorage.setItem(e,JSON.stringify(t))}function Ce(){return ce(ke,{enabled:!0,chatId:""})}function ot(e){ie(ke,{enabled:e.enabled!==!1,chatId:String(e.chatId||"").trim()})}function l(e){if(e==null||e==="")return null;const t=Number(e);return Number.isFinite(t)?t:null}function st(e){return String(e||"").toUpperCase().replace(/[^A-Z0-9.-]/g,"").slice(0,12)}function H(e,t=0,n=100){const o=l(e);return o===null?t:Math.max(t,Math.min(n,o))}async function Y(e){const t=await fetch(e,{cache:"no-store"}),n=await t.json().catch(()=>({}));if(!t.ok||n.ok===!1)throw new Error(n.message||`API error ${t.status}`);return n.data||n}function x(e){const t=l(e);return t===null||!d.exchangeRate?"-":`₩${Math.round(t*d.exchangeRate).toLocaleString("ko-KR")}`}function lt(e){const t=l(e);return t===null?"":d.exchangeRate?String(Math.round(t*d.exchangeRate)):String(t)}function rt(e){const t=l(String(e).replace(/,/g,""));return t===null?null:d.exchangeRate&&t>20?t/d.exchangeRate:t}function se(e,t){const n=l(e),o=l(t);return n===null||!o?"-":V((n-o)/o*100)}function V(e){const t=l(e);return t===null?"-":`${t>=0?"+":""}${t.toFixed(2)}%`}function Le(e){const t=l(e);return t===null?"-":Math.abs(t)>=1e9?`${(t/1e9).toFixed(1)}B`:Math.abs(t)>=1e6?`${(t/1e6).toFixed(1)}M`:Math.abs(t)>=1e3?`${(t/1e3).toFixed(0)}K`:nt.format(Math.round(t))}function B(e){const t=l(e);return t===null?"-":`${t.toFixed(t>=10?1:2)}x`}function y(e){return String(e??"").replace(/[&<>"']/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[t])}function M(e){const ms=(e.marketState??"").toUpperCase();if(ms==="PRE")return l(e.preMarketPrice)??l(e.price)??l(e.regularMarketPrice);if(ms==="POST"||ms==="POSTPOST")return l(e.postMarketPrice)??l(e.price)??l(e.regularMarketPrice);return l(e.price)??l(e.regularMarketPrice)??l(e.preMarketPrice)}function q(e){return l(e.changePercent)??l(e.preMarketChangePercent)??0}function Q(e){const t=l(e.volumeRatio)??l(e.relativeVolume);if(t!==null)return t;const n=l(e.volume),o=l(e.averageVolume);return n!==null&&o?n/o:null}function _(e){const t=M(e),n=l(e.technical?.vwap)??l(e.vwap),o=String(e.technical?.vwapState||e.vwapState||"").toLowerCase();if(o==="above"||e.aboveVwap===!0)return{value:n,state:"above",label:"VWAP 위"};if(o==="below"||e.aboveVwap===!1)return{value:n,state:"below",label:"VWAP 아래"};if(t!==null&&n!==null){const s=(t-n)/n*100;return s>=0?{value:n,state:"above",label:"VWAP 위"}:s>=-1.2?{value:n,state:"near",label:"VWAP 근처"}:{value:n,state:"below",label:"VWAP 아래"}}return{value:n,state:"unknown",label:"VWAP 대기"}}function ue(e){const t=l(e.last1mVolume)??l(e.volume1m)??l(e.technical?.last1mVolume),n=l(e.prev1mVolume)??l(e.technical?.prev1mVolume),o=l(e.last3mVolume)??l(e.volume3m)??l(e.technical?.last3mVolume),s=l(e.last5mVolume)??l(e.volume5m)??l(e.technical?.last5mVolume),r=l(e.prev5mVolume)??l(e.technical?.prev5mVolume),c=l(e.last15mVolume)??l(e.volume15m)??l(e.technical?.last15mVolume),a=l(e.fiveMinuteVolumeGrowth)??l(e.technical?.fiveMinuteVolumeGrowth),i=t!==null&&n?t/n:null,u=s!==null&&r?s/r:null,h=a!==null?1+Math.max(-90,a)/100:null,p=Math.max(i||0,u||0,h||0)||null,g=p===null?38:p>=10?100:p>=5?84:p>=3?68:H(p*18,12,56);return{one:t,three:o,five:s,fifteen:c,oneRatio:i,fiveRatio:u,acceleration:p,score:g}}function at(e){const t=Math.abs(q(e)),n=l(e.dayHigh),o=l(e.dayLow),s=M(e),r=n&&o?(n-o)/Math.max(o,1e-4)*100:t*.8,c=n&&o&&s!==null?(s-o)/Math.max(n-o,1e-4)*100:50,a=o&&s!==null?(s-o)/o*100:null,i=H(t*1.3+r*1.1+(c>=58?14:0),0,100);return{rangePct:r,highPosition:c,lowRebound:a,score:i}}function de(e){const t=String(e.oneMinuteTrend||e.technical?.oneMinuteTrend||"").toLowerCase();return t.includes("up")||t.includes("상승")?"상승":t.includes("down")||t.includes("하락")?"하락":e.technical?.ma5vs20==="above"?"상승":e.technical?.ma5vs20==="below"?"하락":q(e)>0?"상승":"횡보"}function ct(e){const t=l(e.bid),n=l(e.ask),o=M(e);return t&&n&&o?(n-t)/o*100:null}function it(e){return e>=90?{label:"매우 강함",tone:"buy"}:e>=75?{label:"관심",tone:"watch"}:e>=60?{label:"관망",tone:"hold"}:{label:"제외",tone:"avoid"}}function ut(e){const t=M(e),n=q(e),o=l(e.dayHigh),s=l(e.dayLow),r=_(e),c=de(e),a=ue(e),i=Q(e),u=o&&s&&t!==null?(t-s)/Math.max(o-s,1e-4)*100>=45:!0,h=(i??0)>=1.2||(a.acceleration??0)>=1.2||(l(e.volume)??0)>=5e5,p=c==="상승"||n>=3||u,g=r.state==="above"||r.state==="near";return n>=0&&p&&g&&h}function Oe(e){const t=M(e),n=q(e),o=l(e.volume)??l(e.preMarketVolume),s=Q(e),r=_(e),c=ue(e),a=at(e),i=t!==null&&o!==null?t*o:null,u=ct(e),h=de(e),p=a.highPosition>=70?92:a.highPosition>=50?76:a.highPosition>=35?55:25,g=n<0?0:n<=35?H(n*2.3+35,0,100):H(100-(n-35)*.8,35,100),v=i===null?42:i>=2e7?100:i>=5e6?82:i>=1e6?60:28,S=s===null?42:s>=10?100:s>=5?84:s>=3?70:s>=1.5?55:25,w=r.state==="above"?96:r.state==="near"?72:r.state==="below"?8:45,I=h==="상승"?90:h==="횡보"?45:8,R=u===null?64:u<=.6?92:u<=1.2?70:u<=2.5?42:15,A=Math.round(v*.16+S*.17+a.score*.13+c.score*.16+w*.2+I*.1+p*.05+g*.02+R*.01);return{...e,price:t,change:n,volume:o,rvol:s,vwapInfo:r,volumeVelocity:c,volatility:a,dollarVolume:i,spread:u,trend:h,upwardSetup:ut(e),scalpScore:A,scalpStatus:it(A)}}function xe(e){return[...e].sort((t,n)=>(n.upwardSetup?1:0)-(t.upwardSetup?1:0)||(n.scalpScore||0)-(t.scalpScore||0)||(n.rvol||0)-(t.rvol||0)||(n.dollarVolume||0)-(t.dollarVolume||0))}function Ne(){return ce(Pe,{})}function pe(e,t){return l(Ne()[e])??t}function dt(e,t){const n=Ne();n[e]=l(t),ie(Pe,n)}function re(e,t=[]){const n=M(e),o=_(e).value,s=t.slice(-40),r=s.map(v=>l(v.high)).filter(v=>v!==null),c=s.map(v=>l(v.low)).filter(v=>v!==null),a=r.length?Math.max(...r):l(e.dayHigh),i=c.length?Math.min(...c):l(e.dayLow),u=Math.max(...[o,i,n!==null?n*.975:null].filter(v=>v!==null)),h=Math.max(...[a,n!==null?n*1.035:null].filter(v=>v!==null)),p=a??(n!==null?n*1.03:null),g=i??(n!==null?n*.97:null);return{support:u,resistance:h,previousHigh:p,previousLow:g}}function Ae(e,t,n=[]){const o=M(e),s=_(e),r=ue(e),c=re(e,n),a=de(e),i=Q(e),u=t&&o?(o-t)/t*100:null,h=o!==null&&c.previousHigh!==null&&o>=c.previousHigh*.995,p=o!==null&&c.previousLow!==null&&o<=c.previousLow*1.002,g=s.state!=="below"&&e.volatility?.lowRebound!==null&&e.volatility.lowRebound>=2.5,v=(i||0)>=3||(r.acceleration||0)>=3||(e.volume||0)>=1e6,S=o!==null&&c.resistance!==null&&o>=c.resistance*.985,w=r.acceleration!==null&&r.acceleration<1.05,I=e.upwardSetup&&s.state==="above"&&a==="상승";let R="매수 대기";s.state==="below"?R="관망":I&&v&&(h||g)?R="지금 매수 신호":I&&v&&(R="매수 관심"),o!==null&&c.resistance!==null&&o>c.resistance*1.04&&!g&&(R="추격매수 위험");let A="보유 가능";u!==null&&u>=5?A="지금 매도/2차 익절":u!==null&&u>=3&&(A="1차 익절 구간"),S&&w?A="고점 실패, 익절 권장":w&&a==="하락"&&(A="상승 둔화, 일부 익절");let L="손절 대기";u!==null&&u<=-3?L="손절 신호":u!==null&&u<=-2&&(L="위험 구간"),s.state==="below"&&(L="VWAP 이탈, 매도 주의"),p&&(L="직전 저점 이탈");let f=R,b=R==="지금 매수 신호"?"buy":R==="매수 관심"?"watch":"hold";L==="손절 신호"||L==="VWAP 이탈, 매도 주의"||L==="직전 저점 이탈"?(f=L.includes("손절")?"하락 예상, 손절":L,b="avoid"):A!=="보유 가능"&&u!==null&&u>0&&(f=A.includes("매도")||A.includes("권장")?"지금 매도/익절":A,b="profit");const m=c.support,k=s.value?Math.max(s.value*1.012,c.support*1.012):o!==null?o*1.01:null,C=t?t*1.03:c.resistance,P=t?t*1.05:c.resistance?c.resistance*1.02:null,W=Math.min(...[t?t*.975:null,s.value,c.previousLow].filter(T=>T!==null));return{buy:R,profit:A,stop:L,current:f,tone:b,ret:u,buyZoneLow:m,buyZoneHigh:k,profit1:C,profit2:P,stopLine:W,support:c.support,resistance:c.resistance,previousHigh:c.previousHigh,previousLow:c.previousLow,reasons:[`${s.label}`,`RVOL ${B(i)}`,`거래량 속도 ${B(r.acceleration)}`,`1분봉 ${a}`,h?"직전 고점 돌파권":"직전 고점 돌파 대기",g?"눌림 후 재상승 구조":"눌림목 확인 필요"]}}function Te(e,t,n=[],o=null){const s=M(e),r=_(e),c=re(e,n),a=n.length?n:le({},e),i=a.at(-1)||{},u=a.at(-2)||{},h=l(i.close)??s,p=l(u.close)??h,g=p?(h-p)/p*100:q(e)/10,v=a.slice(-3),S=a.slice(-5),w=D=>D.length>1&&l(D[0].close)?(h-l(D[0].close))/l(D[0].close)*100:g,I=w(v),R=w(S),A=a.slice(-8,-1).map(D=>l(D.volume)).filter(D=>D!==null&&D>0),L=A.length?A.reduce((D,Je)=>D+Je,0)/A.length:null,f=l(i.volume)??e.volumeVelocity.one,b=f&&L?f/L:e.volumeVelocity.acceleration,m=a.slice(-8,-1).map(D=>l(D.low)).filter(D=>D!==null),k=a.slice(-8,-1).map(D=>l(D.high)).filter(D=>D!==null),C=m.length&&l(i.low)!==null?l(i.low)<Math.min(...m)*.998:s!==null&&c.previousLow!==null&&s<c.previousLow*.998,P=s!==null&&c.previousLow!==null?s>=c.previousLow*1.002:!0,W=s!==null&&c.previousLow!==null?s<=c.previousLow*1.012:!1,T=k.length&&s!==null?s>=Math.max(...k)*.995:!1,U=r.state==="above"||r.state==="near"||r.state==="unknown",z=r.state==="below",K=g<0&&(b??1)>=1.35,ee=g<0&&(b===null||b<=1.1),ge=l(i.low)!==null&&h!==null&&l(i.high)!==null?(h-l(i.low))/Math.max(l(i.high)-l(i.low),1e-4)>=.55:!1;let F="횡보";C&&z&&K?F="급락 위험":g>.35||T?F="상승":g<-.35&&U&&P&&ee?F="눌림":g<-.35?F="하락":I<0&&ge&&P&&(F="반등 시도");let O="분류 대기";(g<0||F==="눌림"||F==="급락 위험")&&(C&&K?O="진짜 하락":z||W||K?O="위험 하락":ee&&U&&P?O="정상 눌림":ge&&P&&!z?O="반등 준비":O="위험 하락");const Ie=H(50+g*9+I*5+R*3,0,100),Ke=r.state==="above"?18:r.state==="near"?8:r.state==="below"?-24:2,Ge=P?12:-25,Ye=K?-16:ee?8:(b??1)>=1.5&&g>0?12:0,je=H(42+(ge?18:0)+(P?12:-16)+(ee?12:0)+(U?8:-18)-(C?18:0),5,90),te=H(Ie+Ke+Ge+Ye,5,92),J=H(100-te+(C?18:0)+(z?18:0)+(K?14:0),5,92),ne=H(je,5,92),oe=H(te*.55+Ie*.25+(U?12:-15)+(T?10:0),5,92),me=H(100-oe+(O==="진짜 하락"?20:O==="위험 하락"?10:-8),5,92),ye=H(oe+(P?8:-12)+(r.state==="above"?10:0)-(K?12:0),5,92),we=U&&P&&ee&&ne>=55&&ye>=50,$e=z&&!P||C&&K&&J>te&&me>oe;let G="보유 가능";$e?G="즉시 손절":O==="위험 하락"&&J>=58?G="손절 준비":we?G="보유 가능":o?.profit?.includes("2차")||(o?.ret??0)>=5?G="익절 권장":o?.profit?.includes("1차")||(o?.ret??0)>=3?G="일부 익절":z&&ne<45&&(G="재진입 대기");const qe=ne>=J&&g<0?`반등 가능성 ${Math.round(ne)}% / 하락 지속 ${Math.round(J)}%`:`상승 가능성 ${Math.round(te)}% / 하락 가능성 ${Math.round(J)}%`,ze=`상승 재개 ${Math.round(oe)}% / 재하락 위험 ${Math.round(me)}% / 추세 유지 ${Math.round(ye)}%`;let Z="방향성 확인 중입니다. VWAP과 직전 저점 반응을 계속 확인하세요.";return $e?Z="VWAP 또는 직전 저점 이탈과 매도 거래량 증가가 겹쳤습니다. 강한 손절 신호입니다.":we?Z="정상 눌림 가능성. 아직 손절 아님. VWAP 이탈 또는 직전 저점 이탈 시 손절 준비.":O==="반등 준비"?Z="저점 방어 후 반등을 시도하는 구조입니다. 거래량 재증가와 VWAP 회복 여부를 확인하세요.":O==="위험 하락"?Z="위험 하락 구간입니다. 반등 실패 시 손절 준비가 필요합니다.":F==="상승"&&(Z="상승 흐름 유지 중입니다. 저항선 접근 시 일부 익절도 같이 고려하세요."),{currentState:F,dropType:O,oneReturn:g,up3:te,down3:J,rebound3:ne,up5:oe,redrop5:me,sustain5:ye,threeText:qe,fiveText:ze,holderDecision:G,finalText:Z,stopHold:we,immediateStop:$e,volumeRatio:b}}function _e(e,t=[]){const n=M(e),o=t.length?t:le({},e),s=o.slice(-12),r=s.at(-1)||{},c=s.at(-2)||{},a=s.map(T=>l(T.low)).filter(T=>T!==null),i=s.map(T=>l(T.high)).filter(T=>T!==null),u=s.map(T=>l(T.close)).filter(T=>T!==null),h=s.map(T=>l(T.volume)).filter(T=>T!==null&&T>0),p=a.length?Math.min(...a):l(e.dayLow),g=i.length?Math.max(...i):l(e.dayHigh),v=s.findLastIndex(T=>l(T.low)===p),S=v>=0?Math.max(0,s.length-1-v):null,w=n&&p?(n-p)/p*100:0,I=a.length>1?a.at(-2):null,R=p!==null&&I!==null?p>=I*.998:!0,A=l(r.close)??n,L=l(c.close)??A,f=L?(A-L)/L*100:0,b=h.length>1?h.slice(0,-1).reduce((T,U)=>T+U,0)/Math.max(h.length-1,1):null,m=l(r.volume)??e.volumeVelocity?.one,k=m&&b?m/b:e.volumeVelocity?.acceleration,C=f<0&&(k===null||k<=1.1),P=f<0&&(k??1)>=1.35,W=f>0&&((k??0)>=1.25||(e.volumeVelocity?.acceleration??0)>=2);return{usable:o,recentLow:p,recentHigh:g,minutesFromLow:S,recoveryPct:w,higherLow:R,lastReturn:f,volumeRatio:k,downVolumeDry:C,downVolumeHeavy:P,upVolumeStrong:W,closes:u}}function pt(e,t=[]){const n=M(e),o=_(e),s=_e(e,t),r=re(e,t),c=s.minutesFromLow!==null&&s.minutesFromLow<=5,a=o.state==="above"||o.state==="near",i=n!==null&&r.previousLow!==null?n>=r.previousLow*1.002:s.higherLow,u=H(s.recoveryPct*10+(c?22:8)+(a?22:-14)+(i?18:-18)+(s.upVolumeStrong?14:0)+(s.downVolumeDry?10:0),0,100);return{score:Math.round(u),...s,vwapRecovered:a,lowDefense:i}}function ht(e,t=[],n=null){const o=_(e),s=re(e,t),r=M(e),c=_e(e,t),a=r!==null&&s.previousLow!==null?r>=s.previousLow*1.002:!0;return c.downVolumeDry&&(o.state==="above"||o.state==="near"||o.state==="unknown")&&a?{label:"건강한 눌림",broken:!1}:c.downVolumeHeavy&&(o.state==="below"||!a)?{label:"추세 붕괴",broken:!0}:n?.dropType?.includes("진짜")||n?.immediateStop?{label:"추세 붕괴",broken:!0}:n?.dropType?.includes("위험")?{label:"위험 눌림",broken:!1}:{label:"확인 중",broken:!1}}function Me(e,t,n,o,s=[]){const r=M(e),c=_(e),a=pt(e,s),i=ht(e,s,n),u=re(e,s),h=o&&r?(r-o)/o*100:null,p=r!==null&&u.previousHigh!==null&&r>=u.previousHigh*.992,g=r!==null&&u.previousLow!==null&&r<=u.previousLow*.998,v=c.state==="above"||c.state==="near",S=c.state==="below"&&n.down3>=55&&n.redrop5>=52,I=h!==null&&h>=3&&(a.volumeRatio===null||a.volumeRatio<=1.05),R=q(e)>=80&&e.volatility?.highPosition>=78&&(a.volumeRatio===null||a.volumeRatio<=1.1),A=v&&a.higherLow&&a.lowDefense&&a.upVolumeStrong&&!a.downVolumeHeavy&&p&&a.score>=70;let L="기다리세요",f="hold",b="상승 가능성은 있지만 확인 신호가 아직 부족합니다.";g||n.immediateStop||S?(L="즉시 매도",f="avoid",b=g?"직전 저점을 이탈했습니다.":"VWAP 아래에서 회복이 약하고 하락 확률이 우세합니다."):I||R||t.profit?.includes("익절")?(L="1분 내 매도 준비",f="profit",b=I?"목표 수익 구간 도달 후 거래량이 약해지고 있습니다.":"급등 후 과열권에서 힘이 둔화되고 있습니다."):A?(L="지금 매수 가능",f="buy",b="VWAP 위에서 버티고 있고, 최근 저점이 높아졌으며 회복력이 강합니다."):i.broken||c.state==="below"&&a.score<45?(L="사지 마세요",f="avoid",b="VWAP 회복 실패와 약한 회복력 때문에 단타 진입 조건이 부족합니다."):v?p?a.score<70&&(b=`회복력 점수 ${a.score}점으로 아직 70점 기준에 못 미칩니다.`):b="직전 고점 돌파 확인이 필요합니다.":b="VWAP 회복 확인이 필요합니다.";const m=L==="지금 매수 가능"?"현재가 또는 직전 고점 돌파 시":v?"직전 고점 돌파 확인 후":"VWAP 회복 후",k="직전 저점 이탈 시",C="+3%, +5%, 직전 고점 돌파 실패 시 분할 매도",P=[r,u.previousHigh].filter(T=>T!==null),W=L==="지금 매수 가능"?r:P.length?Math.max(...P):null;return{action:L,tone:f,reason:b,recovery:a,pullback:i,entryText:m,stopText:k,takeProfitText:C,levels:{entry:W,stop:t.stopLine,profit1:o?o*1.03:r?r*1.03:t.profit1,profit2:o?o*1.05:r?r*1.05:t.profit2},lines:[b,`회복력 점수 ${a.score}점 · 눌림목: ${i.label}`,`진입: ${m} / 손절: ${k}`]}}function vt(e){const t=M(e),n=Ae(e,t,[]),o=Te(e,t,[],n),s=Me(e,n,o,t,[]);if(s.action==="지금 매수 가능")return s;const r=_(e),c=de(e),a=ue(e),i=Q(e),u=l(e.volume),h=l(e.dollarVolume),p=q(e),g=l(e.volatility?.highPosition)??50,v=(i??0)>=3||(a.acceleration??0)>=2||(u??0)>=1e6||(h??0)>=1e6;return e.upwardSetup&&e.scalpScore>=70&&r.state==="above"&&c==="상승"&&v&&g>=45&&g<=98&&(p<=90||(a.acceleration??0)>=3)?{...s,action:"지금 매수 가능",tone:"buy",reason:"VWAP 위에서 상승 추세와 거래량 확인이 동시에 잡힌 단타 후보입니다."}:{...s,action:"기다리세요",tone:"hold",reason:s.reason}}function ft(e){const t=xe(e.map(n=>{const o=vt(n);return{...n,entryAction:o}})),n=t.filter(n=>n.entryAction.action==="지금 매수 가능");if(n.length)return n;return t.filter(n=>n.included!==!1&&(n.upwardSetup||n.scalpScore>=55||n.finalProbabilityScore>=55||n.scannerScore>=55)).slice(0,30).map(n=>{let o=n.entryAction||vt(n),s=n.scalpScore>=70?"매수 후보":"빠른 확인";return{...n,entryAction:{...o,action:s,tone:o.tone==="avoid"?"hold":o.tone,reason:o.reason||"실시간 스캐너 후보로 포착되어 빠른 확인이 필요합니다."}}})}function le(e,t){const n=e?.bars||e?.data?.bars||e?.candles||[],o=n.map((a,i)=>{const u=l(a.close)??l(a.price)??l(a.c);return{time:a.time||a.date||a.timestamp||new Date(Date.now()-(n.length-i)*6e4).toISOString(),open:l(a.open)??l(a.o)??u,high:l(a.high)??l(a.h)??u,low:l(a.low)??l(a.l)??u,close:u,volume:l(a.volume)??l(a.v)}}).filter(a=>a.close!==null);if(o.length)return o.slice(-90);const s=M(t),r=l(t.dayHigh)??s,c=l(t.dayLow)??s;return s===null?[]:Array.from({length:12},(a,i)=>{const u=i/11,h=c+(s-c)*u;return{time:new Date(Date.now()-(12-i)*6e4).toISOString(),open:i?null:c,high:Math.max(h,r*(.985+u*.015)),low:Math.min(h,c),close:h,volume:null}})}async function gt(e=!1){if(!d.selectedSymbol||!e&&Date.now()-d.lastHistoryAt<et)return;const t=new Date(Date.now()-360*60*1e3).toISOString();try{const n=await Y(j.history(d.selectedSymbol,t));d.selectedBars=le(n,d.selectedItem),d.lastHistoryAt=Date.now()}catch{d.selectedBars=le({},d.selectedItem)}}function mt(e,t=[],n){const o=M(e),s=t.length?t:le({},e),r=s.flatMap(f=>[f.high,f.low,f.close]).map(l).filter(f=>f!==null);o!==null&&r.push(o),n?.support&&r.push(n.support),n?.resistance&&r.push(n.resistance);const c=Math.min(...r),a=Math.max(...r),i=Math.max(a-c,1e-4),u=720,h=260,p=22,g=f=>p+f/Math.max(s.length-1,1)*(u-p*2),v=f=>h-p-(f-c)/i*(h-p*2),S=s.map((f,b)=>`${b?"L":"M"}${g(b).toFixed(1)} ${v(f.close).toFixed(1)}`).join(" "),w=`${S} L${u-p} ${h-p} L${p} ${h-p} Z`,I=(f,b)=>f==null?"":`<line class="${b}" x1="${p}" y1="${v(f).toFixed(1)}" x2="${u-p}" y2="${v(f).toFixed(1)}"></line>`,R=(f,b,m,k=0)=>f==null?"":`<text class="chart-price-label ${b}" x="${u-p-6}" y="${(v(f)+k).toFixed(1)}">${m} ${x(f)}</text>`,A=g(Math.max(s.length-1,0)),L=v(o??s.at(-1)?.close??c);return`
    <div class="chart-card">
      <div class="chart-head">
        <div><strong>${y(e.symbol)}</strong><span>실시간 가격 흐름</span></div>
        <b>${x(o)}</b>
      </div>
      <svg class="price-chart" viewBox="0 0 ${u} ${h}" role="img" aria-label="${y(e.symbol)} 실시간 차트">
        <path class="chart-area" d="${w}"></path>
        <path class="chart-line" d="${S}"></path>
        ${I(e.vwapInfo.value,"vwap-line")}
        ${I(n.support,"support-line")}
        ${I(n.resistance,"resistance-line")}
        ${R(e.vwapInfo.value,"vwap","VWAP",-6)}
        ${R(n.support,"support","지지",13)}
        ${R(n.resistance,"resistance","저항",-10)}
        <circle class="last-dot" cx="${A.toFixed(1)}" cy="${L.toFixed(1)}" r="5"></circle>
      </svg>
      <div class="chart-legend">
        <span><i class="legend-price"></i>가격</span>
        <span><i class="legend-vwap"></i>VWAP</span>
        <span><i class="legend-support"></i>지지</span>
        <span><i class="legend-resistance"></i>저항</span>
      </div>
    </div>
  `}function he(){const e=ce(Ee,[]);return Array.isArray(e)?e:[]}function ve(e){ie(Ee,e.slice(0,Ze))}function yt(e,t){const n=e.symbol,o=he(),s=o.find(c=>c.symbol===n);if(s&&s.label===t.current&&Date.now()-new Date(s.detectedAt).getTime()<180*1e3)return;const r=t.current.includes("즉시 매도")||t.current.includes("손절")||t.current.includes("이탈")?"STOP":t.current.includes("1분 내 매도")||t.current.includes("익절")||t.current.includes("매도")?"TAKE_PROFIT":t.current.includes("지금 매수 가능")||t.current.includes("매수 신호")?"BUY":"WATCH";ve([{id:`${n}-${Date.now()}-${r}`,symbol:n,type:r,label:t.current,detectedAt:new Date().toISOString(),price:M(e),entryPrice:pe(n,M(e)),vwap:_(e).value,rvol:Q(e),scalpScore:e.scalpScore,support:t.support,resistance:t.resistance,previousHigh:t.previousHigh,previousLow:t.previousLow,stopLine:t.stopLine,result:{label:"PENDING"}},...o])}function Re(){const e=xe(d.items).slice(0,30);if($("candidate-summary").textContent=`단타 후보 ${e.length}개 · ${d.lastScanAt?new Date(d.lastScanAt).toLocaleTimeString("ko-KR"):"-"} · 10초마다 갱신`,!e.length){$("candidate-list").className="empty-state",$("candidate-list").innerHTML="지금 바로 매수 가능 신호가 뜬 단타 후보가 없습니다. 실시간으로 계속 갱신 중입니다.";return}$("candidate-list").className="table-wrap",$("candidate-list").innerHTML=`
    <table class="candidate-table">
      <thead><tr><th>선택</th><th>티커</th><th>현재가</th><th>상승률</th><th>거래량</th><th>RVOL</th><th>VWAP</th><th>추세</th><th>적합도</th><th>상태</th></tr></thead>
      <tbody>${e.map(t=>`
        <tr class="${t.symbol===d.selectedSymbol?"selected":""}" data-symbol="${y(t.symbol)}">
          <td><button class="select-btn" type="button">${t.symbol===d.selectedSymbol?"감시중":"선택"}</button></td>
          <td><strong>${y(t.symbol)}</strong><small>${y(t.name||"")}</small></td>
          <td>${x(M(t))}</td>
          <td class="${t.change>=0?"up":"down"}">${V(t.change)}</td>
          <td>${Le(t.volume)}</td>
          <td>${B(t.rvol)}</td>
          <td>${y(t.vwapInfo.label)}</td>
          <td>${y(t.trend)}</td>
          <td><b class="${t.scalpScore>=90?"hot":t.scalpScore>=75?"warm":t.scalpScore>=60?"mid":"cold"}">${t.scalpScore}</b></td>
          <td><span class="status buy">${y(t.entryAction?.action||t.scalpStatus.label)}</span></td>
        </tr>
      `).join("")}</tbody>
    </table>
  `}function X(e,t,n=""){const o=Math.round(H(t,0,100));return`
    <div class="prob-row ${n}">
      <div><span>${y(e)}</span><b>${o}%</b></div>
      <i><em style="width:${o}%"></em></i>
    </div>
  `}function wt(e){return`
    <div class="direction-panel ${e.holderDecision.includes("손절")?"avoid":e.holderDecision.includes("익절")?"profit":e.holderDecision.includes("재진입")?"hold":"buy"}">
      <div class="direction-head">
        <div>
          <span>선택 종목 단기 방향성</span>
          <strong>${y(e.currentState)}</strong>
        </div>
        <b>${y(e.holderDecision)}</b>
      </div>
      <div class="direction-grid">
        <section>
          <small>3분 예상</small>
          ${X("상승 가능성",e.up3,"up")}
          ${X("하락 가능성",e.down3,"down")}
          ${X("반등 가능성",e.rebound3,"rebound")}
          <p>${y(e.threeText)}</p>
        </section>
        <section>
          <small>5분 예상</small>
          ${X("추가 상승 가능성",e.up5,"up")}
          ${X("재하락 위험",e.redrop5,"down")}
          ${X("추세 유지 가능성",e.sustain5,"rebound")}
          <p>${y(e.fiveText)}</p>
        </section>
      </div>
      <div class="drop-type">
        <span>하락 유형</span>
        <b>${y(e.dropType)}</b>
      </div>
      <p class="direction-final">${y(e.finalText)}</p>
    </div>
  `}function $t(e,t){const n=M(t);return`
    <div class="levels-panel">
      <div class="level-card support">
        <span>지지선</span>
        <strong>${x(e.support)}</strong>
        <small>현재가 대비 ${se(e.support,n)}</small>
      </div>
      <div class="level-card resistance">
        <span>저항선</span>
        <strong>${x(e.resistance)}</strong>
        <small>현재가 대비 ${se(e.resistance,n)}</small>
      </div>
      <div class="level-card stop">
        <span>손절 기준</span>
        <strong>${x(e.stopLine)}</strong>
        <small>현재가 대비 ${se(e.stopLine,n)}</small>
      </div>
    </div>
  `}function bt(e){return`
    <div class="action-panel ${e.tone}">
      <span>단타 기준 신호</span>
      <strong>${y(e.action)}</strong>
      <p>${y(e.reason)}</p>
    </div>
    <div class="action-levels">
      <div><span>진입가</span><b>${x(e.levels.entry)}</b></div>
      <div><span>손절가</span><b>${x(e.levels.stop)}</b></div>
      <div><span>1차 익절가</span><b>${x(e.levels.profit1)}</b></div>
      <div><span>2차 익절가</span><b>${x(e.levels.profit2)}</b></div>
    </div>
    <div class="beginner-panel">
      <b>현재 판단: ${y(e.action)}</b>
      <p>이유: ${y(e.lines[0])}</p>
      <p>진입 기준: ${y(e.entryText)}</p>
      <p>손절 기준: ${y(e.stopText)}</p>
      <p>익절 기준: ${y(e.takeProfitText)}</p>
    </div>
    <div class="recovery-panel">
      <div><span>회복력 점수</span><strong>${e.recovery.score}점</strong></div>
      <div><span>눌림목 판별</span><strong>${y(e.pullback.label)}</strong></div>
      <div><span>저점 방어</span><strong>${e.recovery.lowDefense?"방어 중":"이탈 주의"}</strong></div>
    </div>
  `}function St(e){return e.action==="지금 매수 가능"?{type:"BUY",title:"지금 매수 가능"}:e.action==="1분 내 매도 준비"?{type:"SELL_READY",title:"1분 내 매도 준비"}:e.action==="즉시 매도"?{type:"SELL_NOW",title:"즉시 매도"}:null}function Fe(){const e=ce(He,[]);return Array.isArray(e)?e:[]}function Lt(e){ie(He,e.slice(0,500))}function xt(e,t,n){const s=Fe().find(c=>c.symbol===e&&c.type===t.type&&c.action===n.action);return!s||Date.now()-new Date(s.sentAt).getTime()>=tt||n.recovery?.score>=(s.recoveryScore||0)+10}function De(e,t,n,o="sent"){Lt([{symbol:e,type:t.type,action:n.action,recoveryScore:n.recovery?.score||0,status:o,sentAt:new Date().toISOString()},...Fe()])}async function At(e,t,n,o){const s=St(t);if(!s||!d.selectedSymbol||e.symbol!==d.selectedSymbol)return;const r=Ce();if(r.enabled===!1||!xt(e.symbol,s,t))return;const c={chatId:r.chatId,signal:{selectedOnly:!0,alertType:s.type,symbol:e.symbol,name:e.name||"",action:t.action,price:x(M(e)),priceRaw:M(e),entry:x(t.levels.entry),stop:x(t.levels.stop),profit1:x(t.levels.profit1),profit2:x(t.levels.profit2),vwap:`${x(e.vwapInfo.value)} · ${e.vwapInfo.label}`,change:V(e.change),volume:Le(e.volume),rvol:B(e.rvol),score:e.scalpScore,recoveryScore:t.recovery?.score,pullback:t.pullback?.label,direction:o.currentState,reason:t.reason,entryText:t.entryText,stopText:t.stopText,takeProfitText:t.takeProfitText,level:s.type==="SELL_NOW"?"urgent":s.type==="BUY"?"strong":"normal"}};try{const i=await(await fetch(j.telegramAlert,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(c)})).json().catch(()=>({}));De(e.symbol,s,t,i.skipped?"skipped":"sent")}catch{De(e.symbol,s,t,"failed")}}function Be(e){if(!e)return;const t=e.symbol,n=pe(t,M(e)),o=Ae(e,n,d.selectedBars),s=Te(e,n,d.selectedBars,o),r=Me(e,o,s,n,d.selectedBars),c={...o,current:r.action,tone:r.tone};r.action==="즉시 매도"&&(c.stop="즉시 매도"),r.action==="1분 내 매도 준비"&&(c.profit="분할 매도 준비"),Object.assign(o,c),d.items=xe(d.items.map(a=>a.symbol===t?{...d.selectedItem,entryAction:r}:a)),yt(e,c),At(e,r,c,s),$("monitor-summary").textContent=`${t} 선택 감시 · ${new Date().toLocaleTimeString("ko-KR")}`,$("monitor-panel").className="",$("monitor-panel").innerHTML=`
    ${bt(r)}
    <div class="selected-banner">
      <div><span>선택 종목</span><strong>${y(t)}</strong><small>${y(e.name||"")}</small></div>
      <b class="${c.tone}">${y(c.current)}</b>
    </div>
    ${$t(c,e)}
    <div class="signal-card ${c.tone}">
      <span>왜 이 신호가 나왔나요?</span>
      <strong>${y(c.current)}</strong>
      <p>${r.lines.map(y).join(" · ")}</p>
    </div>
    ${mt(e,d.selectedBars,c)}
    ${wt(s)}
    <div class="monitor-grid">
      ${E("현재가",x(e.price))}
      ${E("매수가",`<input id="entry-price" class="mini-input" value="${lt(n)}" inputmode="numeric" />`)}
      ${E("VWAP",`${x(e.vwapInfo.value)} · ${e.vwapInfo.label}`)}
      ${E("1분봉 상태",e.trend)}
      ${E("5분 거래량",`${B(e.volumeVelocity.acceleration)} · ${Le(e.volumeVelocity.five)}`)}
      ${E("거래량 변화",`RVOL ${B(e.rvol)}`)}
      ${E("직전 고점",x(o.previousHigh))}
      ${E("직전 저점",x(o.previousLow))}
      ${E("지지선",`${x(o.support)} (${se(o.support,e.price)})`)}
      ${E("저항선",`${x(o.resistance)} (${se(o.resistance,e.price)})`)}
      ${E("예상 매수 구간",`${x(o.buyZoneLow)} ~ ${x(o.buyZoneHigh)}`)}
      ${E("익절 구간",`1차 ${x(o.profit1)} · 2차 ${x(o.profit2)}`)}
      ${E("손절 구간",x(o.stopLine))}
      ${E("수익률",V(o.ret))}
      ${E("매수 판단",o.buy)}
      ${E("익절 판단",o.profit)}
      ${E("손절 판단",o.stop)}
    </div>
  `,$("entry-price")?.addEventListener("change",a=>{dt(t,rt(a.target.value)),Be(e)})}function E(e,t){return`<div class="metric"><span>${y(e)}</span><b>${t}</b></div>`}async function be(e){d.selectedSymbol=st(e),d.selectedBars=[],d.lastHistoryAt=0,$("monitor-panel").className="loading-card",$("monitor-panel").innerHTML='<div class="spinner"></div>선택 종목 차트와 시그널 분석 중...',Re(),await fe(!0)}async function fe(e=!1){if(d.selectedSymbol&&!d.monitoring){d.monitoring=!0;try{const t=await Y(j.quote(d.selectedSymbol)),n=d.items.find(o=>o.symbol===d.selectedSymbol)||{};d.selectedItem=Oe({...n,...t}),await gt(e),Be(d.selectedItem),Re(),Ue()}catch(t){$("monitor-panel").className="",$("monitor-panel").innerHTML=`<div class="error-card"><strong>${d.selectedSymbol} 감시 실패</strong><small>${y(t.message)}</small></div>`}finally{d.monitoring=!1}}}async function Ve(e=!1){if(!d.scanning){d.scanning=!0,$("refresh-btn").disabled=!0,$("candidate-list").className="loading-card",$("candidate-list").innerHTML='<div class="spinner"></div>지금 매수 가능 단타 후보만 실시간 분석 중...';try{const t=await Y(`${j.scanner}${e?"?force=1":""}`),n=(t.items||[]).map(Oe);d.items=ft(n),d.lastScanAt=t.debug?.lastScanAt||t.updatedAt||new Date().toISOString(),!d.selectedSymbol&&d.items[0]&&(d.selectedSymbol=d.items[0].symbol),Re(),d.selectedSymbol&&await fe(!1),ae(),Ue()}catch(t){$("candidate-list").className="",$("candidate-list").innerHTML=`<div class="error-card"><strong>스캔 실패</strong><small>${y(t.message)}</small></div>`}finally{$("refresh-btn").disabled=!1,d.scanning=!1}}}function Tt(e,t){const n=new Date(e.detectedAt),o=(t||[]).map(w=>({at:new Date(w.time||w.date||w.timestamp),high:l(w.high)??l(w.price),low:l(w.low)??l(w.price),close:l(w.close)??l(w.price)})).filter(w=>Number.isFinite(w.at.getTime())&&w.at>n&&w.high!==null&&w.low!==null);if(!o.length)return e.result||{label:"PENDING"};const s=e.price,r=new Date(n.getTime()+60*1e3),c=new Date(n.getTime()+180*1e3),a=new Date(n.getTime()+300*1e3),i=new Date(n.getTime()+600*1e3),u=new Date(n.getTime()+1800*1e3),h=w=>o.filter(I=>I.at<=w).at(-1),p=Math.max(...o.map(w=>w.high)),g=Math.min(...o.map(w=>w.low)),v=w=>s?(w-s)/s*100:null,S={return1:v(h(r)?.close),return3:v(h(c)?.close),return5:v(h(a)?.close),return10:v(h(i)?.close),return30:v(h(u)?.close),futureHigh:p,futureLow:g,maxReturn:v(p),maxDrawdown:v(g),label:"PENDING"};return e.type==="BUY"?S.label=Math.max(S.return3??-99,S.return5??-99,S.return10??-99,S.maxReturn??-99)>=1.5?"SUCCESS":"FAIL":e.type==="WATCH"?S.label=(S.maxReturn??0)>=2?"SUCCESS":"FAIL":e.type==="STOP"?S.label=(S.maxDrawdown??0)<=-1.5?"SUCCESS":"FAIL":e.type==="TAKE_PROFIT"&&(S.label=(S.maxDrawdown??0)<=-.8||(S.maxReturn??0)<=1.5?"SUCCESS":"FAIL"),S}function Mt(e,t,n,o){const s=e.symbol,r=t.action==="지금 매수 가능"?"BUY":t.action==="즉시 매도"?"STOP":t.action==="1분 내 매도 준비"?"TAKE_PROFIT":"WATCH";return{id:`${s}-${Date.now()}-SELECTED-${o}`,symbol:s,type:r,label:t.action,detectedAt:new Date().toISOString(),horizonMinutes:o,price:M(e),entryPrice:pe(s,M(e)),vwap:_(e).value,rvol:Q(e),scalpScore:e.scalpScore,support:n.support,resistance:n.resistance,previousHigh:n.previousHigh,previousLow:n.previousLow,stopLine:n.stopLine,selectedBacktest:!0,result:{label:"PENDING",reason:`${o}분 뒤 데이터가 쌓이면 평가됩니다.`}}}function We(e,t){const n=new Date(e.detectedAt),o=Number(e.horizonMinutes||5),s=new Date(n.getTime()+o*60*1e3),r=(t||[]).map(m=>({at:new Date(m.time||m.date||m.timestamp),high:l(m.high)??l(m.price),low:l(m.low)??l(m.price),close:l(m.close)??l(m.price)})).filter(m=>Number.isFinite(m.at.getTime())&&m.at>n&&m.at<=s&&m.high!==null&&m.low!==null&&m.close!==null),c=Date.now()>=s.getTime();if(!r.length||!c){const m=Math.max(0,Math.ceil((s.getTime()-Date.now())/6e4));return{label:"PENDING",reason:m?`아직 ${m}분 정도 더 지나야 ${o}분 검증이 끝납니다.`:"검증할 분봉 데이터가 아직 부족합니다."}}const a=e.price,i=Math.max(...r.map(m=>m.high)),u=Math.min(...r.map(m=>m.low)),h=r.at(-1)?.close,p=m=>a?(m-a)/a*100:null,g=p(i),v=p(u),S=p(h),w=l(e.previousHigh)??l(e.resistance),I=w!==null?i>=w*1.002:(g??0)>=2,R=l(e.vwap),A=R?r.filter(m=>m.close>=R).length/r.length*100:null,L=l(e.previousLow)!==null?u<=l(e.previousLow)*.998:(v??0)<=-3;let f=!1,b="";if(e.type==="BUY"||e.type==="WATCH"){const m=o<=5?1.2:o<=60?2.5:4;f=I&&(g??0)>=m&&(S??-99)>=0&&!L&&(A===null||A>=55),b=f?`검증 시간 안에 직전 고점 돌파와 ${V(g)} 최대 상승이 확인됐습니다.`:`고점 돌파/수익률/VWAP 유지 중 일부가 부족했습니다. 최대상승 ${V(g)}, 최대하락 ${V(v)}.`}else e.type==="STOP"?(f=(v??0)<=-1.5||L,b=f?`매도 신호 이후 추가 하락이 확인됐습니다. 최대하락 ${V(v)}.`:"매도 신호 이후 뚜렷한 추가 하락이 확인되지 않았습니다."):(f=(v??0)<=-.8||(g??0)<=1.5,b=f?"매도 준비 이후 상승 둔화 또는 하락 전환이 확인됐습니다.":"매도 준비 이후에도 추가 상승 여지가 남아 있었습니다.");return{label:f?"SUCCESS":"FAIL",horizonMinutes:o,closeReturn:S,maxReturn:g,maxDrawdown:v,futureHigh:i,futureLow:u,brokeHigh:I,vwapHoldRatio:A,reason:b}}async function Rt(e){if(!d.selectedItem){alert("먼저 백테스트할 종목을 선택해주세요.");return}const t=d.selectedItem,n=pe(t.symbol,M(t)),o=Ae(t,n,d.selectedBars),s=Te(t,n,d.selectedBars,o),r=Me(t,o,s,n,d.selectedBars),c=Mt(t,r,o,e);$("backtest-panel").innerHTML=`<div class="loading-card"><div class="spinner"></div>${y(t.symbol)} ${e}분 추세 전환 검증 중...</div>`;try{const a=await Y(j.history(c.symbol,c.detectedAt));c.result=We(c,a.bars||a.data?.bars||[])}catch(a){c.result={label:"PENDING",reason:`데이터 조회 실패: ${a.message}`}}ve([c,...he()]),ae()}async function Vt(){const e=he();$("backtest-panel").innerHTML='<div class="loading-card"><div class="spinner"></div>시그널 이후 1/3/5/10/30분 흐름 분석 중...</div>';const t=[];for(const n of e.slice(0,80))try{const o=await Y(j.history(n.symbol,n.detectedAt)),s=o.bars||o.data?.bars||[];t.push({...n,result:n.selectedBacktest?We(n,s):Tt(n,s)})}catch{t.push(n)}ve([...t,...e.slice(80)]),ae()}function ae(){const e=he(),t=e.filter(i=>i.result?.label&&i.result.label!=="PENDING"),n=t.filter(i=>i.result.label==="SUCCESS"),o=Se(t.map(i=>i.result?.return10??i.result?.return30??i.result?.maxReturn)),s=Se(t.map(i=>i.result?.return3)),r=Se(t.map(i=>i.result?.maxDrawdown)),c=t.length?n.length/t.length*100:null,a=i=>{const u=t.filter(h=>h.type===i);return u.length?u.filter(h=>h.result.label==="SUCCESS").length/u.length*100:null};$("backtest-panel").innerHTML=`
    <div class="stats-row">
      ${N("전체 시그널",e.length)}
      ${N("평가 완료",t.length)}
      ${N("승률",V(c),"good")}
      ${N("매수 성공률",V(a("BUY")),"good")}
      ${N("대기 후 돌파",V(a("WATCH")),"warn")}
      ${N("즉시 매도 적중",V(a("STOP")),"bad")}
      ${N("매도 준비 적중",V(a("TAKE_PROFIT")),"warn")}
      ${N("평균 3분 수익률",V(s),"good")}
      ${N("평균 10분 수익률",V(o),"good")}
      ${N("평균 하락률",V(r),"bad")}
      ${N("손익비",r?Math.abs((o||0)/r).toFixed(2):"-")}
    </div>
    <div class="table-wrap">
      <table class="signal-table">
        <thead><tr><th>시간</th><th>티커</th><th>종류</th><th>시그널</th><th>가격</th><th>검증</th><th>1분</th><th>3분</th><th>5분</th><th>10분</th><th>30분</th><th>최대상승</th><th>최대하락</th><th>결과</th><th>판단 이유</th></tr></thead>
        <tbody>${e.slice(0,120).map(i=>`
          <tr>
            <td>${new Date(i.detectedAt).toLocaleString("ko-KR")}</td>
            <td><strong>${y(i.symbol)}</strong></td>
            <td>${i.type}</td>
            <td>${y(i.label)}</td>
            <td>${x(i.price)}</td>
            <td>${i.horizonMinutes?`${i.horizonMinutes}분`:"-"}</td>
            <td>${V(i.result?.return1)}</td>
            <td>${V(i.result?.return3)}</td>
            <td>${V(i.result?.return5)}</td>
            <td>${V(i.result?.return10)}</td>
            <td>${V(i.result?.return30)}</td>
            <td>${V(i.result?.maxReturn)}</td>
            <td>${V(i.result?.maxDrawdown)}</td>
            <td><span class="status ${i.result?.label==="SUCCESS"?"buy":i.result?.label==="FAIL"?"avoid":"hold"}">${i.result?.label||"PENDING"}</span></td>
            <td class="reason-cell">${y(i.result?.reason||"-")}</td>
          </tr>
        `).join("")||'<tr><td colspan="15">아직 저장된 시그널이 없습니다.</td></tr>'}</tbody>
      </table>
    </div>
  `}function N(e,t,n=""){return`<div class="stat ${n}"><span>${y(e)}</span><b>${y(t)}</b></div>`}function Se(e){const t=e.map(l).filter(n=>n!==null);return t.length?t.reduce((n,o)=>n+o,0)/t.length:null}function Ue(){const e=d.items.slice(0,40);$("debug-panel").innerHTML=`
    <div class="table-wrap">
      <table class="debug-table">
        <thead><tr><th>티커</th><th>거래대금</th><th>RVOL</th><th>속도</th><th>고점 위치</th><th>VWAP</th><th>추세</th><th>포착 이유</th></tr></thead>
        <tbody>${e.map(t=>`
          <tr>
            <td><strong>${y(t.symbol)}</strong></td>
            <td>${x(t.dollarVolume)}</td>
            <td>${B(t.rvol)}</td>
            <td>${B(t.volumeVelocity.acceleration)}</td>
            <td>${Math.round(t.volatility.highPosition??0)}%</td>
            <td>${y(t.vwapInfo.label)}</td>
            <td>${y(t.trend)}</td>
            <td class="reason-cell">상승률 양수, VWAP 위/근처, 거래량 생존, 1분 추세를 우선 반영해 단타 적합도 ${t.scalpScore}점</td>
          </tr>
        `).join("")}</tbody>
      </table>
    </div>
  `}async function It(){try{let e;try{e=await Y(j.exchange)}catch{e=await Y("https://open.er-api.com/v6/latest/USD")}d.exchangeRate=l(e.rate)??l(e.usdKrw)??l(e.exchangeRate),!d.exchangeRate&&e.rates?.KRW&&(d.exchangeRate=l(e.rates.KRW)),$("exchange-rate").textContent=d.exchangeRate?`USD/KRW ${Math.round(d.exchangeRate).toLocaleString("ko-KR")}`:"환율 없음"}catch{$("exchange-rate").textContent="환율 조회 실패"}}function Dt(){$("refresh-btn").addEventListener("click",()=>Ve(!0)),$("monitor-refresh").addEventListener("click",()=>fe(!0)),$("telegram-settings").addEventListener("click",()=>{const e=Ce(),t=prompt("텔레그램 Chat ID를 입력하세요. Vercel 환경변수 TELEGRAM_CHAT_ID를 쓰면 비워둬도 됩니다.",e.chatId||"");t!==null&&(ot({...e,enabled:!0,chatId:t}),alert("텔레그램 알림 설정을 저장했습니다. 선택 종목에서 매수/매도 신호가 뜰 때만 알림을 보냅니다."))}),$("search-btn").addEventListener("click",()=>be($("ticker-input").value)),$("ticker-input").addEventListener("keydown",e=>{e.key==="Enter"&&be($("ticker-input").value)}),$("candidate-list").addEventListener("click",e=>{const t=e.target.closest("[data-symbol]");t&&be(t.dataset.symbol)}),document.querySelectorAll("[data-selected-backtest]").forEach(e=>{e.addEventListener("click",()=>Rt(Number(e.dataset.selectedBacktest)))}),$("run-backtest").addEventListener("click",Vt),$("clear-signals").addEventListener("click",()=>{confirm("저장된 시그널 기록을 삭제할까요?")&&(ve([]),ae())})}Dt();ae();It().then(()=>Ve(!1));
