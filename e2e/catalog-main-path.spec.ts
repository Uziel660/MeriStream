import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('la portada carga títulos del catálogo principal con el límite completo', async ({ page }) => {
  test.setTimeout(120_000);
  const response = await page.request.get(`${BASE_URL}/api/v1/shows?lite=true&limit=25000`);
  expect(response.status()).toBe(200);
  const payload = await response.json();
  expect(payload.total).toBeGreaterThan(0);
  expect(payload.shows.length).toBeGreaterThan(0);

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(page.locator('button.media-card').first()).toBeVisible({ timeout: 60_000 });
});

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

test('el detalle elige el espejo activo cuando hay una ficha legacy con el mismo TMDB', async ({ page }) => {
  const response = await page.request.get(`${BASE_URL}/api/v1/shows?lite=true&search=Tastefully%20Yours&limit=20`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  const show = payload.shows?.find((item: any) => item.title === 'Tastefully Yours');
  expect(show?.id).toBeTruthy();

  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/shows/${show.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  expect(detail.episode_platforms).toEqual([{ domain: 'gnula', episodes: expect.any(Number) }]);
  expect(detail.episode_platforms[0].episodes).toBeGreaterThan(0);
  expect(detail.episodes.length).toBeGreaterThan(0);
  expect(new Set(detail.episodes.map((episode: any) => `${episode.season_number || 1}:${episode.episode_number}`)).size)
    .toBe(detail.episodes.length);
  expect(detail.episodes[0].source_url).toMatch(/gnulahd\.nu/i);
});

test('la ruta legacy no-lite tampoco expone episodios de proveedores retirados', async ({ page }) => {
  const response = await page.request.get(`${BASE_URL}/api/v1/shows?search=Project%20ARMS`);
  expect(response.status()).toBe(200);
  const shows = await response.json();
  expect(Array.isArray(shows)).toBeTruthy();
  for (const show of shows) {
    for (const episode of show.episodes || []) {
      expect(String(episode.source_url || '')).not.toMatch(/animeflv|animeav1|veranimes|tioanime|tioplus|lamovie|hianimes|doramasflix|tubepelis|wwv/i);
    }
  }
});
