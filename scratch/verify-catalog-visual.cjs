const { chromium } = require('playwright');
const path = require('path');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  console.log('Navegando al catálogo en http://127.0.0.1:3010 ...');
  await page.goto('http://127.0.0.1:3010', { waitUntil: 'domcontentloaded', timeout: 30000 });

  console.log('Esperando que el catálogo cargue los shows...');
  // Wait up to 30 seconds for cards or images
  await page.waitForSelector('img[alt]', { timeout: 35000 });
  await page.waitForTimeout(3000);

  // Take screenshot of home catalog
  const screenshotPath = path.join('C:', 'Users', 'Uziel', '.gemini', 'antigravity', 'brain', '710239f3-e67a-4f47-aa15-b4a9b1e3479c', 'scratch', 'screenshots', 'val_catalog_repaired_posters.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Captura guardada en:', screenshotPath);

  await browser.close();
  console.log('Verificación visual completada.');
}

run().catch(console.error);
