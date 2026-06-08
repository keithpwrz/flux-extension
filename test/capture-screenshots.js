// Flux — CWS Screenshot Capture
// Usage: node test/capture-screenshots.js
// Takes screenshots for Chrome Web Store listing (1280x800)

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');
const GAME_URL = 'https://www.roblox.com/games/2753915549/Blox-Fruits';

(async () => {
  console.log('📸 Flux CWS Screenshot Capture\n');

  // Ensure screenshot directory exists
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, '..', '.playwright-mcp'),
    {
      headless: false, // false = headed for clean renders
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

  // Collect Flux console logs
  const fluxLogs = [];
  page.on('console', msg => {
    if (msg.text().includes('[Flux]')) {
      fluxLogs.push(msg.text());
      console.log(`  ${msg.text()}`);
    }
  });

  try {
    // 1. Navigate to Roblox game page
    console.log('1. Navigating to Roblox game page...');
    await page.goto(GAME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`   URL: ${page.url()}`);

    // 2. Wait for Flux to inject
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

    // Extra wait for server data to load
    await page.waitForTimeout(3000);

    // 3. Screenshot 1: Full page with Flux button
    console.log('3. Taking screenshots...');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'screenshot-1-hero.png'),
      fullPage: false,
    });
    console.log('   ✅ screenshot-1-hero.png (1280x800)');

    // 4. Screenshot 2: Focus on play button area (cropped in post)
    const playBtnContainer = await page.$('#game-details-play-button-container');
    if (playBtnContainer) {
      await playBtnContainer.screenshot({
        path: path.join(SCREENSHOT_DIR, 'screenshot-2-button-closeup.png'),
      });
      console.log('   ✅ screenshot-2-button-closeup.png');
    }

    // 5. Screenshot 3: Server list if visible
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
