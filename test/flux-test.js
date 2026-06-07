// Flux extension — Playwright test
// Usage: node test/flux-test.js [--headed] [--game-id=2753915549]
//
// Loads the Flux extension into Chromium, navigates to a Roblox game page,
// and verifies the dashboard button is injected beside the native play button.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(__dirname, '..', '.playwright-mcp');

// Parse args
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const GAME_ID = (args.find(a => a.startsWith('--game-id=')) || '--game-id=2753915549').split('=')[1];
const GAME_URL = `https://www.roblox.com/games/${GAME_ID}/`;

const RESULTS = { passed: [], failed: [], info: [] };

function pass(msg) { RESULTS.passed.push(msg); console.log(`  ✅ ${msg}`); }
function fail(msg) { RESULTS.failed.push(msg); console.log(`  ❌ ${msg}`); }
function info(msg) { RESULTS.info.push(msg); console.log(`  ℹ️  ${msg}`); }

(async () => {
  console.log('\n🔬 Flux Extension Test');
  console.log(`   Extension: ${EXTENSION_PATH}`);
  console.log(`   Game URL:  ${GAME_URL}`);
  console.log(`   Headed:    ${HEADED}\n`);

  // ── 1. Launch browser with extension ──────────────────────────────────

  console.log('── 1. Launching Chromium with Flux extension ──');

  /** @type {import('playwright').BrowserContext} */
  let context;
  try {
    const launchArgs = [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ];

    // New headless mode supports extensions; old headless does not.
    // In headed mode, don't pass any headless flag.
    if (!HEADED) {
      launchArgs.push('--headless=new');
    }

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,  // we control headless via args for extension compat
      args: launchArgs,
      ignoreHTTPSErrors: true,
    });
    pass('Browser launched with extension loaded');
  } catch (e) {
    fail(`Browser launch failed: ${e.message}`);
    printSummary();
    return;
  }

  // ── 2. Open Roblox game page ──────────────────────────────────────────

  console.log('\n── 2. Navigating to Roblox game page ──');

  const page = await context.newPage();

  // Collect Flux console logs
  const fluxLogs = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[Flux]')) {
      fluxLogs.push(text);
      console.log(`  [Flux log] ${text}`);
    }
  });

  try {
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pass('Page loaded');
  } catch (e) {
    fail(`Page load failed: ${e.message}`);
    await context.close();
    printSummary();
    return;
  }

  // Wait a moment for any redirects to settle, then grab diagnostics
  await page.waitForTimeout(2000);

  const currentUrl = page.url();
  console.log(`  URL: ${currentUrl}`);

  // Diagnostic: check extension state
  const diag = await page.evaluate(async () => {
    const info = {};

    // Check if extension context is available
    info.hasChrome = typeof chrome !== 'undefined';
    info.hasRuntime = info.hasChrome && !!(chrome && chrome.runtime);
    info.hasRuntimeId = false;
    if (info.hasRuntime) {
      try { info.hasRuntimeId = !!(chrome.runtime && chrome.runtime.id); } catch(e) {}
    }

    // Check if Flux injected anything
    info.hasFluxStyles = !!document.getElementById('flux-play-btn-styles');
    info.hasFluxBtn = !!document.getElementById('flux-our-play-btn');
    info.hasXHROverride = false;
    try { info.hasXHROverride = window.XMLHttpRequest.toString().includes('_fluxUrl'); } catch(e) {}

    // Check the play button container
    const container = document.getElementById('game-details-play-button-container');
    info.hasContainer = !!container;
    info.containerChildren = container ? container.children.length : 0;
    info.containerHTML = container ? container.innerHTML.substring(0, 500) : 'N/A';
    info.hasNativePlayBtn = container ? !!container.querySelector('.btn-common-play-game-lg') : false;

    // Check body
    info.hasBody = !!document.body;
    info.bodyChildren = document.body ? document.body.children.length : 0;

    return info;
  });

  console.log('  Diagnostics:');
  console.log(`    chrome.runtime available: ${diag.hasRuntimeId}`);
  console.log(`    flux styles injected:    ${diag.hasFluxStyles}`);
  console.log(`    flux btn present:        ${diag.hasFluxBtn}`);
  console.log(`    XHR overridden:          ${diag.hasXHROverride}`);
  console.log(`    body exists:             ${diag.hasBody}`);
  console.log(`    body children:           ${diag.bodyChildren}`);
  console.log(`    play btn container:      ${diag.hasContainer}`);
  console.log(`    container children:      ${diag.containerChildren}`);
  console.log(`    native play btn inside:  ${diag.hasNativePlayBtn}`);
  if (diag.containerHTML) {
    console.log(`    container HTML snippet:  ${diag.containerHTML.substring(0, 200)}`);
  }

  if (currentUrl.includes('/login') || currentUrl.includes('/Login')) {
    info('Redirected to login — Roblox requires authentication. Run with --headed to log in.');
  } else if (currentUrl.includes('/games/')) {
    pass('On game page — not redirected');
  } else {
    info(`Unexpected URL: ${currentUrl}`);
  }

  // ── 3. Wait for Flux injection ────────────────────────────────────────

  console.log('\n── 3. Waiting for Flux button injection ──');

  let fluxBtn = null;
  let fluxWrapper = null;
  let containerGuarded = false;
  let contentScriptLoaded = false;

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    fluxBtn = await page.$('#flux-our-play-btn');
    fluxWrapper = await page.$('#flux-btn-wrapper');
    containerGuarded = await page.evaluate(() => {
      const c = document.getElementById('game-details-play-button-container');
      return c ? c.dataset.fluxGuarded === '1' : false;
    });
    contentScriptLoaded = await page.evaluate(() => {
      return !!(document.getElementById('flux-play-btn-styles'));
    });
    if (fluxBtn && fluxWrapper) break;
    if (i % 5 === 4) console.log(`  … waiting (${(i + 1) * 0.5}s)`);
  }

  if (contentScriptLoaded) pass('Content script ran (flux styles injected)');
  else if (currentUrl.includes('/games/')) fail('Content script did NOT run on game page');
  else info('Content script did not run (expected — not on game page)');

  if (fluxBtn) pass('Flux dashboard button (#flux-our-play-btn) injected');
  else if (currentUrl.includes('/games/')) fail('Flux dashboard button NOT found — game page loaded but injection failed');
  else info('Flux button not found (expected — not on game page)');

  if (fluxWrapper) pass('Flux button wrapper (#flux-btn-wrapper) present');
  else if (currentUrl.includes('/games/')) fail('Flux button wrapper NOT found');
  else info('Wrapper not found (expected — not on game page)');

  if (containerGuarded) pass('Container guard active');
  else info('Container guard disabled — using recovery poll instead');

  // ── 3b. Verify wrapper survives (recovery poll keeps it alive) ─────────

  if (fluxBtn && fluxWrapper) {
    console.log('\n── 3b. Verifying wrapper survives (5s wait) ──');
    await page.waitForTimeout(5000);
    var survived = await page.$('#flux-btn-wrapper');
    var survivedBtn = await page.$('#flux-our-play-btn');
    if (survived && survivedBtn) pass('Wrapper + button survived 5s (recovery poll active)');
    else fail('Wrapper disappeared after 5s — recovery poll NOT working');
  }

  // ── 4. Check Flux logs ────────────────────────────────────────────────

  console.log('\n── 4. Flux console output ──');

  const refreshLog = fluxLogs.find(l => l.includes('refresh started'));
  const fetchLog = fluxLogs.find(l => l.includes('fetching server list'));
  const mountedLog = fluxLogs.find(l => l.includes('mounted beside play button'));
  const doneLog = fluxLogs.find(l => l.includes('DONE:'));
  const resolvedLog = fluxLogs.find(l => l.includes('resolving'));

  if (mountedLog) pass('"mounted beside play button" logged');
  else info('"mounted" log not seen (may need Roblox login for game page)');

  if (refreshLog) pass('Server refresh triggered');
  else info('No refresh log — game page needs Roblox login');

  if (fetchLog) info('Server fetch started');
  if (resolvedLog) info('IP resolution running');
  if (doneLog) pass(`Servers resolved: ${doneLog}`);
  else info('Server resolution not complete (requires logged-in Roblox session)');

  // ── 5. Check error logs ───────────────────────────────────────────────

  console.log('\n── 5. Error check ──');

  const errorLogs = fluxLogs.filter(l =>
    l.includes('error') || l.includes('Error') || l.includes('ERROR')
  );
  const csrfError = errorLogs.find(l => l.includes('CSRF') || l.includes('csrf'));
  const extLost = errorLogs.find(l => l.includes('extension context lost'));

  if (extLost) fail('Extension context lost — reload the extension!');
  else pass('No extension context loss');

  if (csrfError) info('CSRF token unavailable (expected — needs Roblox login in browser)');
  if (errorLogs.length === 0) pass('No errors in Flux logs');

  // ── 6. Button appearance check (headed only) ──────────────────────────

  if (HEADED && fluxBtn) {
    console.log('\n── 6. Visual check ──');
    const btnColor = await page.evaluate(() => {
      const btn = document.getElementById('flux-our-play-btn');
      if (!btn) return null;
      const style = getComputedStyle(btn);
      return { bg: style.backgroundColor, width: style.width, height: style.height };
    });
    if (btnColor) {
      console.log(`  Button color: ${btnColor.bg}`);
      console.log(`  Button size:  ${btnColor.width} × ${btnColor.height}`);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  await context.close();
  printSummary();

  // Exit with correct code
  process.exit(RESULTS.failed.length > 0 ? 1 : 0);
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

function printSummary() {
  console.log('\n══════════════════════════════════════════════');
  console.log(`  PASSED: ${RESULTS.passed.length}  |  FAILED: ${RESULTS.failed.length}  |  INFO: ${RESULTS.info.length}`);
  console.log('══════════════════════════════════════════════\n');
}
