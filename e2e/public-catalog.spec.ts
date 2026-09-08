import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('el catálogo público usa identidad TMDB y el detalle crea episodios virtuales', async ({ page }) => {
  test.setTimeout(60_000);
  const catalogResponse = await page.request.get(`${BASE_URL}/api/v1/catalog/public?kind=movie&limit=3`);
  expect(catalogResponse.status()).toBe(200);
  const catalog = await catalogResponse.json();
  expect(catalog.source).toBe('tmdb');
  expect(catalog.shows.length).toBeGreaterThan(0);
  expect(catalog.shows[0].id).toMatch(/^tmdb-movie-\d+$/);
  expect(catalog.shows[0].tmdb_id).toBeGreaterThan(0);

  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/catalog/public/movie/550`);
  expect(detailResponse.status()).toBe(200);
  const detail = await detailResponse.json();
  expect(detail.id).toBe('tmdb-movie-550');
  expect(detail.imdb_id).toBe('tt0137523');
  expect(detail.episodes[0].source_url).toBe('tmdb://movie/550/1/1');
});

test('el catálogo unificado muestra películas, series y anime desde TMDB', async ({ page }) => {
  test.setTimeout(60_000);
  const response = await page.request.get(`${BASE_URL}/api/v1/catalog/public?kind=all&mode=trending&limit=60`);
  expect(response.status()).toBe(200);
  const catalog = await response.json();
  expect(catalog.source).toBe('tmdb');
  expect(catalog.shows).toHaveLength(60);
  const counts = catalog.shows.reduce((result: Record<string, number>, show: any) => {
    result[show.kind] = (result[show.kind] || 0) + 1;
    return result;
  }, {});
  expect(counts.movie).toBeGreaterThan(0);
  expect(counts.series).toBeGreaterThan(0);
  expect(counts.anime).toBeGreaterThan(0);
  expect(catalog.shows.slice(0, 3).map((show: any) => show.kind)).toEqual(['movie', 'series', 'anime']);
});

test('la portada renderiza tarjetas del catálogo público como un usuario', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('searchbox')).toBeVisible();
  await expect(page.locator('button.media-card').first()).toBeVisible({ timeout: 60_000 });
});

