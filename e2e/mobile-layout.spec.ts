import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});

test.describe('Responsive móvil', () => {
  test('home y ficha mantienen el viewport, prioridades de imagen y targets táctiles', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.feature-image').first()).toBeVisible({ timeout: 60_000 });

    const homeGeometry = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      heroPriority: document.querySelector<HTMLElement>('.feature-image') &&
        (document.querySelector<HTMLImageElement>('.feature-image')?.fetchPriority || null),
      heroWidth: document.querySelector<HTMLImageElement>('.feature-image')?.getAttribute('width') || null,
      heroHeight: document.querySelector<HTMLImageElement>('.feature-image')?.getAttribute('height') || null,
      controls: [...document.querySelectorAll<HTMLElement>('.search-toggle, .preferences-trigger, .account-login')]
        .map((element) => element.getBoundingClientRect().height),
    }));
    expect(homeGeometry.scrollWidth).toBeLessThanOrEqual(homeGeometry.width + 1);
    expect(homeGeometry.heroPriority).toBe('high');
    expect(homeGeometry.heroWidth).toBe('1920');
    expect(homeGeometry.heroHeight).toBe('1080');
    expect(homeGeometry.controls.every((height) => height >= 40)).toBeTruthy();

    await page.getByRole('button', { name: 'Abrir búsqueda' }).click();
    await page.getByRole('searchbox').fill('Forgotten Island');
    const card = page.locator('button.media-card').filter({ hasText: 'La isla olvidada' }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();

    const details = page.getByRole('dialog').last();
    await expect(details).toBeVisible();
    await page.waitForTimeout(650); // dejar terminar la entrada lateral del panel
    const detailGeometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('.details-panel')?.getBoundingClientRect();
      const body = document.querySelector<HTMLElement>('.details-body');
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        panelLeft: panel?.left ?? -1,
        panelRight: panel?.right ?? Number.POSITIVE_INFINITY,
        bodyClientWidth: body?.clientWidth ?? 0,
        bodyScrollWidth: body?.scrollWidth ?? Number.POSITIVE_INFINITY,
        playHeight: document.querySelector<HTMLElement>('.details-hero-play')?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(detailGeometry.scrollWidth).toBeLessThanOrEqual(detailGeometry.width + 1);
    expect(detailGeometry.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(detailGeometry.panelRight).toBeLessThanOrEqual(detailGeometry.width + 1);
    expect(detailGeometry.bodyScrollWidth).toBeLessThanOrEqual(detailGeometry.bodyClientWidth + 1);
    expect(detailGeometry.playHeight).toBeGreaterThanOrEqual(40);
  });

  test('login de admin es usable con toque y conserva sus etiquetas accesibles', async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.admin-login-card')).toBeVisible();
    const geometry = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inputs: [...document.querySelectorAll<HTMLElement>('.admin-login-input')]
        .map((element) => element.getBoundingClientRect().height),
      submit: document.querySelector<HTMLElement>('.admin-login-submit')?.getBoundingClientRect().height ?? 0,
      labels: [...document.querySelectorAll<HTMLLabelElement>('.admin-login-card label')].map((label) => label.htmlFor),
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.inputs.every((height) => height >= 44)).toBeTruthy();
    expect(geometry.submit).toBeGreaterThanOrEqual(44);
    expect(geometry.labels).toEqual(['admin-user', 'admin-password']);
  });
});
