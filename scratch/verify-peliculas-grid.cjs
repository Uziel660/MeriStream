const { chromium } = require('playwright');
const path = require('path');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Navegando a http://127.0.0.1:3010 ...');
  await page.goto('http://127.0.0.1:3010', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Click on "Películas" in header
  const peliculasBtn = page.locator('button, a').filter({ hasText: /^Películas$/i }).first();
  await peliculasBtn.click();
  await page.waitForTimeout(2000);

  // Scroll down slightly to view the grid cards
  await page.evaluate(() => window.scrollBy(0, 700));
  await page.waitForTimeout(2000);

  const screenshotPath = path.join('C:', 'Users', 'Uziel', '.gemini', 'antigravity', 'brain', '710239f3-e67a-4f47-aa15-b4a9b1e3479c', 'scratch', 'screenshots', 'val_peliculas_grid.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Captura guardada en:', screenshotPath);

  await browser.close();
}

run().catch(console.error);
