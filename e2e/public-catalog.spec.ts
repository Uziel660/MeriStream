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

test('el respaldo local queda acotado si TMDB está temporalmente fuera de servicio', async ({ page }) => {
  test.setTimeout(90_000);
  let fallbackUrl = '';
  await page.route('**/api/v1/catalog/public**', async (route) => {
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'TMDB unavailable' }) });
  });
  await page.route('**/api/v1/shows**', async (route) => {
    fallbackUrl = route.request().url();
    await route.continue();
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => fallbackUrl, { timeout: 30_000 }).not.toBe('');
  expect(new URL(fallbackUrl).searchParams.get('limit')).toBe('60');
  expect(fallbackUrl).not.toContain('25000');
});

test('la búsqueda conserva la ficha local y descarta el PNG de título de TMDB', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('Te irás al infierno');

  const matches = page.locator('button.media-card').filter({ hasText: 'Te irás al infierno' });
  await expect(matches).toHaveCount(1, { timeout: 30_000 });
  const image = matches.locator('img').first();
  await image.scrollIntoViewIfNeeded();
  await expect(image).toHaveAttribute('src', /\.jpg(?:\?|$)/i);
  await expect.poll(() => image.evaluate((element) => element.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  const dimensions = await image.evaluate((element) => ({ width: element.naturalWidth, height: element.naturalHeight }));
  expect(dimensions.width).toBeGreaterThan(0);
  expect(dimensions.height / dimensions.width).toBeGreaterThan(1);
});

test('la ficha local usa el título localizado de TMDB sin perder sus episodios', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('The Wrong Babysitter');
  const card = page.locator('button.media-card').filter({ hasText: 'The Wrong Babysitter' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  const details = page.getByRole('dialog').last();
  await expect(details).toBeVisible();
  await expect(details).toContainText('Muerte en familia', { timeout: 30_000 });
  await expect(details).toContainText('Reproducir película');
});

test('la búsqueda tolera un error de escritura y mantiene los títulos en otros idiomas', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('one pecie');
  await expect(page.locator('button.media-card').filter({ hasText: 'One Piece' }).first()).toBeVisible({ timeout: 30_000 });
});

test('la búsqueda del usuario consulta TMDB con el texto completo', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  const tmdbSearch = page.waitForResponse((response) => {
    if (!response.url().includes('/api/v1/catalog/public?') || response.status() !== 200) return false;
    const url = new URL(response.url());
    return url.searchParams.get('query') === 'The Creator';
  });
  await search.fill('The Creator');
  const response = await tmdbSearch;
  const payload = await response.json();
  expect(payload.source).toBe('tmdb');
  expect(payload.total).toBeGreaterThan(0);
  expect(payload.shows.some((show: any) => show.title === 'The Creator')).toBe(true);
  await expect(page.locator('button.media-card').filter({ hasText: 'The Creator' }).first()).toBeVisible({ timeout: 30_000 });
});

test('Explorar catálogo carga el siguiente lote TMDB sin quedarse en 60 fichas', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('button.media-card').first()).toBeVisible({ timeout: 60_000 });
  await page.getByText('Explorar', { exact: true }).first().click();
  await expect(page.locator('.catalog-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cargar más desde TMDB' })).toBeVisible();
  const nextBatch = page.waitForResponse((response) => {
    if (!response.url().includes('/api/v1/catalog/public?') || response.status() !== 200) return false;
    return new URL(response.url()).searchParams.get('page') === '4';
  });
  await page.getByRole('button', { name: 'Cargar más desde TMDB' }).click();
  await nextBatch;
  await expect(page.locator('.catalog-count')).toContainText('títulos');
  await expect.poll(async () => page.locator('.catalog-grid .media-card').count()).toBeGreaterThan(60);
});

test('Explorar mantiene paginación independiente para cada categoría', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('button.media-card').first()).toBeVisible({ timeout: 60_000 });
  await page.getByText('Explorar', { exact: true }).first().click();
  await expect(page.locator('.catalog-category-loadmore')).toBeVisible();
  const seriesRequest = page.waitForResponse((response) => {
    if (!response.url().includes('/api/v1/catalog/public?') || response.status() !== 200) return false;
    const url = new URL(response.url());
    return url.searchParams.get('kind') === 'series' && url.searchParams.get('page') === '4';
  });
  await page.getByRole('button', { name: 'Cargar más Series' }).click();
  await seriesRequest;
  await expect(page.getByRole('button', { name: 'Cargar más Series' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cargar más Películas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cargar más Anime' })).toBeVisible();
});

