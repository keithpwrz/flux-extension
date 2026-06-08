
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '..', '.playwright-monitor');

const GAME_ID = (process.argv.find(a => a.startsWith('--game-id=')) || '--game-id=2753915549').split('=')[1];
const GAME_URL = `https://www.roblox.com/games/${GAME_ID}/`;
const MONITOR_MINUTES = 5;
const CHECK_INTERVAL = 5000;

function ts() { return new Date().toISOString().substring(11, 19); }

(async () => {
  console.log(`\n🔬 Flux Monitor — ${MONITOR_MINUTES} minute observation`);
  console.log(`   Extension: ${EXTENSION_PATH}`);
  console.log(`   Game:      ${GAME_URL}\n`);

  try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch(e) {}

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    ignoreHTTPSErrors: true,
    viewport: { width: 1400, height: 900 },
  });

  const page = await context.newPage();

  const fluxLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[Flux]')) {
      const entry = `[${ts()}] ${text}`;
      fluxLogs.push(entry);
      console.log(`  📋 ${entry}`);
    }
  });

  console.log(`[${ts()}] Navigating to ${GAME_URL}...`);
  await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {
    console.log(`[${ts()}] Page load timeout — continuing anyway...`);
  });
  console.log(`[${ts()}] Page loaded. Current URL: ${page.url()}`);

  console.log(`\n[${ts()}] ═══ WAITING FOR LOGIN ═══`);
  console.log(`[${ts()}] Please log into Roblox in the browser window.`);
  console.log(`[${ts()}] Monitor will auto-detect game page and begin checks.\n`);

  let onGamePage = false;
  let loggedIn = false;

  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(5000);
    const url = page.url();
    const isGamePage = url.includes('/games/') && !url.includes('/login');

    if (isGamePage && !onGamePage) {
      onGamePage = true;
      console.log(`\n[${ts()}] ✅ DETECTED GAME PAGE: ${url.split('?')[0]}`);
    }

    const hasContainer = await page.$('#game-details-play-button-container');
    if (hasContainer && !loggedIn) {
      loggedIn = true;
      console.log(`[${ts()}] ✅ LOGGED IN — play button container visible`);
      break;
    }

    if (i % 12 === 0 && i > 0) {
      console.log(`[${ts()}] Still waiting for login... (${(i * 5 / 60).toFixed(1)} min)`);
    }
  }

  if (!loggedIn) {
    console.log(`[${ts()}] ⚠️  Timed out waiting for login. Starting checks anyway.`);
  }

  console.log(`\n[${ts()}] ═══ MONITORING STARTED (${MONITOR_MINUTES} min) ═══\n`);

  const checks = [];
  let lastState = null;
  const startTime = Date.now();
  const endTime = startTime + (MONITOR_MINUTES * 60000);

  while (Date.now() < endTime) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    try {
      const state = await page.evaluate(() => {
        return {
          url: location.href,
          title: document.title,
          container: !!document.getElementById('game-details-play-button-container'),
          fluxWrapper: !!document.getElementById('flux-btn-wrapper'),
          fluxBtn: !!document.getElementById('flux-our-play-btn'),
          fluxStyles: !!document.getElementById('flux-play-btn-styles'),
          nativeBtn: (() => {
            const b = document.querySelector('.btn-common-play-game-lg');
            return b ? { visible: b.offsetParent !== null, width: b.offsetWidth, height: b.offsetHeight } : null;
          })(),
          overlay: !!document.querySelector('.flux-overlay'),
        };
      });

      const stateKey = JSON.stringify({ w: state.fluxWrapper, b: state.fluxBtn, c: state.container, n: !!state.nativeBtn });
      if (stateKey !== lastState) {
        lastState = stateKey;
        const elapsedSec = String(elapsed).padStart(3);
        const flags = [
          state.container ? '🔲container' : '❌NO-CONTAINER',
          state.fluxWrapper ? '✅wrapper' : '❌NO-WRAPPER',
          state.fluxBtn ? '✅btn' : '❌NO-BTN',
          state.nativeBtn ? '✅native' : '❌NO-NATIVE',
          state.overlay ? '🔷overlay-open' : '',
        ].filter(Boolean).join(' | ');
        console.log(`[${ts()}] T+${elapsedSec}s | ${flags}`);
      }

      if (state.container && !state.fluxWrapper && elapsed > 10) {
        console.log(`[${ts()}] ⚠️  WRAPPER DISAPPEARED at T+${elapsed}s! Recovery should kick in...`);
      }
      if (!state.container && elapsed > 10 && checks.length > 0 && checks[checks.length - 1].container) {
        console.log(`[${ts()}] 🚨 CONTAINER DISAPPEARED at T+${elapsed}s!`);
      }

      checks.push({ elapsed, ...state });
    } catch (e) {
      console.log(`[${ts()}] ⚠️  eval failed: ${e.message}`);
    }

    await page.waitForTimeout(CHECK_INTERVAL);
  }

  const screenshotPath = path.join(__dirname, '..', 'flux-monitor-final.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`\n[${ts()}] 📸 Final screenshot saved: ${screenshotPath}`);

  console.log(`\n[${ts()}] ═══ MONITORING COMPLETE ═══`);

  const disappearances = [];
  for (let i = 1; i < checks.length; i++) {
    if (checks[i-1].fluxWrapper && !checks[i].fluxWrapper) {
      disappearances.push(checks[i].elapsed);
    }
  }

  console.log(`   Total checks:     ${checks.length}`);
  console.log(`   Duration:          ${MONITOR_MINUTES} min`);
  console.log(`   Disappearances:    ${disappearances.length}`);
  if (disappearances.length) {
    console.log(`   Disappeared at:    ${disappearances.map(d => 'T+' + d + 's').join(', ')}`);
  }

  const finalState = checks.length ? checks[checks.length - 1] : null;
  if (finalState) {
    console.log(`   Final state:`);
    console.log(`     Container:       ${finalState.container}`);
    console.log(`     Flux wrapper:    ${finalState.fluxWrapper}`);
    console.log(`     Flux button:     ${finalState.fluxBtn}`);
    console.log(`     Native button:   ${!!finalState.nativeBtn}`);
    if (finalState.nativeBtn) {
      console.log(`     Native size:     ${finalState.nativeBtn.width}x${finalState.nativeBtn.height}`);
    }
  }

  console.log(`\n   Flux console logs (last 20):`);
  fluxLogs.slice(-20).forEach(l => console.log(`     ${l}`));

  console.log('\n   Browser will stay open. Press Ctrl+C to exit.');
  console.log('══════════════════════════════════════════════\n');

  await new Promise(() => {});
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
