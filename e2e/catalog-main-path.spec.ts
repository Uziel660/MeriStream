import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('el catálogo público no muestra obras que solo tienen fuentes legacy', async ({ page }) => {
  test.setTimeout(90_000);
  const response = await page.request.get(`${BASE_URL}/api/v1/shows?lite=true&search=Project%20ARMS&limit=20`);
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.shows).toEqual([]);
  expect(payload.total).toBe(0);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('searchbox')).toBeVisible();
  await page.getByRole('searchbox').fill('Project ARMS');
  await expect(page.locator('button.media-card').filter({ hasText: 'Project ARMS' })).toHaveCount(0);
});
