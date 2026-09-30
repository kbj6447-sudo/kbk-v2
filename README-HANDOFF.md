# KBK Theta Accumulation Pro Handoff

This folder is the editable copy for the pro version of the scanner.

## Live URLs

- Original site: https://kbk-theta-accumulation.vercel.app/
- Editable pro copy: https://kbk-theta-accumulation-pro.vercel.app/

The original site should be left as-is unless intentionally changing production.
Most experiments and fixes should go to the pro copy first.

## What was changed in the pro copy

- Added compact pro UI enhancements through `assets/pro-trading-enhancements.js`.
- Added own candlestick SVG chart for the selected day-trade symbol.
- Added VWAP, entry zone, and ATR-based stop basis cards.
- Added backtest expectancy summary UI.
- Added server-side Telegram alert endpoint at `api/pro-alert-scan.js`.
- Removed aggressive auto-refresh behavior from the main scanner pages.
- Added/kept direct routes such as `/top-picks`, `/backtest`, and `/ai-analysis`.

## Important files

- `index.html`: loads the deployed asset scripts.
- `assets/pro-trading-enhancements.js`: most pro overlay UI and scanner improvements.
- `api/pro-alert-scan.js`: server-side Telegram alert scan endpoint.
- `vercel.json`: Vercel routing, proxying `/api/*` to the original API where no local function exists.
- `build.mjs`: copies the app into `dist` for deployment.
- `deploy-pro.mjs`: deploys this folder to the pro Vercel project.

## Local check

Use Node.js 18 or newer.

```bash
npm run build
node --check assets/pro-trading-enhancements.js
node --check api/pro-alert-scan.js
```

To preview locally:

```bash
node local-server.mjs
```

Then open the localhost URL shown in the terminal.

## Deploy from another computer

1. Log in to Vercel in the browser.
2. Create a Vercel access token.
3. In the terminal, set the token as an environment variable.

PowerShell:

```powershell
$env:VERCEL_TOKEN="vcp_your_token_here"
node deploy-pro.mjs
```

macOS/Linux:

```bash
export VERCEL_TOKEN="vcp_your_token_here"
node deploy-pro.mjs
```

The deploy script targets:

- Team ID: `team_PR3WVWq1OllFG0qODrsah0o0`
- Project: `kbk-theta-accumulation-pro`

Do not commit or share raw Vercel tokens.

## Telegram alert setup

The endpoint exists here:

```text
https://kbk-theta-accumulation-pro.vercel.app/api/pro-alert-scan
```

Required Vercel environment variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional:

- `PRO_ALERT_MIN_SCORE`, default `75`
- `PRO_ALERT_MAX_ITEMS`, default `5`
- `CRON_SECRET`, only use this if the scheduler can send an Authorization bearer token

Vercel Hobby cannot run every-5-minute Cron Jobs. For real-time-like alerts, use one of these:

- Upgrade Vercel to Pro and add a `*/5 * * * *` cron.
- Use an external scheduler to call `/api/pro-alert-scan` every 1-5 minutes.

## 토스증권 Open API (본인 PC 실행 전용)

토스 키는 허용 IP 로 등록한 PC 에서만 작동하므로, 토스 연동은 `local-server.mjs` 로 PC 에서 실행할 때만 켜집니다.
Vercel 배포본에는 키를 넣지 않으며, 기존 Yahoo/KIS 경로로 그대로 동작합니다.

- `lib/tossClient.js`: 조회 전용 클라이언트 (랭킹, 현재가, 1분봉, 호가). 주문/계좌 API 없음.
- `api/scanner.js`: 토스가 켜져 있으면
  - 종목 발굴에 토스 랭킹(시장 거래량·거래대금 실시간, 급상승 1일) 상위 50개씩 추가
  - 1분봉을 토스 우선 사용 (토스 봉이 Yahoo 보다 3분 이상 늦으면 Yahoo 유지)
  - 점수 공식은 변경하지 않음
- 토스 인증 오류(IP 미허용 등) 시 5분간 토스를 멈추고 Yahoo 로 자동 전환

설정:

1. `toss-env.example.txt` 를 복사해 `.env` 로 이름 변경, `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET` 입력
2. `npm run toss-check` : 인증·랭킹·1분봉(연장거래 포함 여부)·호가·호출 한도 점검
3. `npm run local` : 스캐너 실행 후 브라우저에서 `http://localhost:4173`

`.env` 는 `.gitignore` 에 포함되어 있습니다. 이 저장소는 공개 저장소이므로 키를 코드에 넣지 마세요.

## Current caveat

This project is a reconstructed deployable copy, not a full source repo with the original framework files.
For fast fixes, edit the overlay files above and redeploy the pro project.
