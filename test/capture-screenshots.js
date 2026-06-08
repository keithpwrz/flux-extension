
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');
const GAME_URL = 'https://www.roblox.com/games/2753915549/Blox-Fruits';

(async () => {
  console.log('📸 Flux CWS Screenshot Capture\n');

  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, '..', '.playwright-mcp'),
    {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      viewport: { width: 1280, height: 800 },
    }
  );

  const page = await context.newPage();

  const fluxLogs = [];
  page.on('console', msg => {
    if (msg.text().includes('[Flux]')) {
      fluxLogs.push(msg.text());
      console.log(`  ${msg.text()}`);
    }
  });

  try {
    console.log('1. Navigating to Roblox game page...');
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`   URL: ${page.url()}`);

    console.log('2. Waiting for Flux injection...');
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      const btn = await page.$('#flux-our-play-btn');
      if (btn) {
        console.log('   ✅ Flux button injected');
        break;
      }
      if (i % 5 === 4) console.log(`   ...waiting (${(i + 1) * 0.5}s)`);
    }

    await page.waitForTimeout(3000);

    console.log('3. Taking screenshots...');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'screenshot-1-hero.png'),
      fullPage: false,
    });
    console.log('   ✅ screenshot-1-hero.png (1280x800)');

    const playBtnContainer = await page.$('#game-details-play-button-container');
    if (playBtnContainer) {
      await playBtnContainer.screenshot({
        path: path.join(SCREENSHOT_DIR, 'screenshot-2-button-closeup.png'),
      });
      console.log('   ✅ screenshot-2-button-closeup.png');
    }

    const serverList = await page.$('#flux-server-list');
    if (serverList) {
      await serverList.screenshot({
        path: path.join(SCREENSHOT_DIR, 'screenshot-3-server-list.png'),
      });
      console.log('   ✅ screenshot-3-server-list.png');
    } else {
      console.log('   ℹ️  Server list not visible (may need login)');
    }

    console.log('\n✅ Screenshots saved to screenshots/');
  } catch (e) {
    console.error(`❌ Error: ${e.message}`);
  } finally {
    await context.close();
  }
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
