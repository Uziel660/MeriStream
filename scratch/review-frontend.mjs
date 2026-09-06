import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true });
await mkdir('scratch/frontend-review', { recursive: true });
try {
  for (const [name, width, height, touch] of [
    ['desktop', 1440, 1000, false], ['mobile', 390, 844, true],
    ['tablet', 768, 1024, true], ['small', 320, 780, true],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:3010');
    await page.locator('.feature h1').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'scratch/frontend-review/' + name + '.png' });
    console.log(name, JSON.stringify(await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      images: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length,
      title: document.querySelector('h1')?.textContent
    }))), errors);
    if (name === 'desktop' || name === 'mobile') {
      await page.getByRole('button', { name: 'Detalles', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.locator('.details-body').waitFor();
      await page.screenshot({ path: 'scratch/frontend-review/' + name + '-details.png' });
      await page.getByRole('button', { name: 'Cerrar detalles' }).click();
      await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.screenshot({ path: 'scratch/frontend-review/' + name + '-account.png' });
      await page.getByRole('button', { name: 'Cerrar modal' }).click();
      await page.getByRole('button', { name: 'Explorar', exact: true }).click();
      await page.getByRole('combobox', { name: 'Filtrar por género' }).waitFor();
      await page.screenshot({ path: 'scratch/frontend-review/' + name + '-explore.png' });
    }
    await context.close();
  }
} finally { await browser.close(); }
