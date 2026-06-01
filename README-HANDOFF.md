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

## Current caveat

This project is a reconstructed deployable copy, not a full source repo with the original framework files.
For fast fixes, edit the overlay files above and redeploy the pro project.
