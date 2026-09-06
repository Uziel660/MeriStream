const { chromium } = require('playwright');
const path = require('path');

async function test() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto('http://127.0.0.1:3010');
  await page.locator('input[type="search"]').fill('Warau Salesman New');
  await page.waitForTimeout(1500);
  await page.locator('button.media-card').first().click();
  await page.waitForTimeout(1500);
  await page.locator('button:has-text("Reproducir"), button:has-text("Ver Ahora"), button:has-text("Episodio 1")').first().click();
  await page.waitForTimeout(5000);
  const res = await page.evaluate(() => {
    const v = document.querySelector('video');
    const ifr = document.querySelector('iframe');
    return {
      video: !!v,
      videoSrc: v?.src || v?.currentSrc,
      iframe: !!ifr,
      iframeSrc: ifr?.src,
      paused: v?.paused,
      readyState: v?.readyState
    };
  });
  console.log('TioAnime Test Result:', res);
  await page.screenshot({ path: path.join(__dirname, 'screenshots', 'browser_play_tioanime_fixed.png') });
  await browser.close();
}

test().catch(console.error);
