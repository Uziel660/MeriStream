import { expect, test, type Page } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

async function playCatalogTitle(
  page: Page,
  searchTerm: string,
  expectedTitle: string,
  expectedProvider: string,
  expectedEpisodeSource: RegExp,
  seasonButtonText?: string,
) {
  if (process.env.DEBUG_E2E) {
    page.on('request', (request) => {
      if (/\/api\/v1\//.test(request.url())) console.log(`[e2e-request] ${request.method()} ${request.url()}`);
    });
    page.on('response', (response) => {
      if (/\/api\/v1\//.test(response.url())) console.log(`[e2e-response] ${response.status()} ${response.url()}`);
    });
  }
  const catalogResponse = await page.request.get(
    `${BASE_URL}/api/v1/shows?lite=true&search=${encodeURIComponent(searchTerm)}&limit=20`,
  );
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const show = catalog.shows?.find((item: any) => item.title === expectedTitle);
  expect(show?.id, `el catálogo local debe contener ${expectedTitle}`).toBeTruthy();

  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/shows/${show.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  expect(detail.episode_platforms?.map((platform: any) => platform.domain)).toContain(expectedProvider);
  expect(detail.episodes.length).toBeGreaterThan(0);
  expect(detail.episodes[0].source_url).toMatch(expectedEpisodeSource);
  expect(new Set(detail.episodes.map((episode: any) => `${episode.season_number || 1}:${episode.episode_number}`)).size)
    .toBe(detail.episodes.length);

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill(searchTerm);
  const card = page.locator('button.media-card').filter({ hasText: expectedTitle }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  const details = page.getByRole('dialog').last();
  await expect(details).toBeVisible();
  await expect(details).toContainText(/Episodios \(|Reproducir película|Continuar película/, { timeout: 30_000 });
  if (process.env.DEBUG_E2E) console.log(`[e2e-details] ${((await details.innerText()).slice(0, 1200))}`);
  if (seasonButtonText) {
    const seasonButton = details.getByRole('button', { name: seasonButtonText, exact: true });
    await expect(seasonButton).toBeVisible();
    await seasonButton.click();
  }
  const target = details.locator('button.episode-card').first();
  const playButton = details.getByRole('button', { name: /Reproducir película|Continuar película/i }).first();
  const targetButton = (await target.count()) > 0 ? target : playButton;
  await expect(targetButton).toBeVisible();

  const playWait = page.waitForResponse(
    (response) => /\/api\/v1\/play\//.test(response.url()),
    { timeout: 45_000 },
  );
  const resolveWait = page.waitForResponse(
    (response) => /\/api\/v1\/(?:resolve-embed|catalog\/episode-servers)$/.test(response.url()),
    { timeout: 60_000 },
  );
  // A source may be playable directly (Cinecalidad Vimeos/SprintCDN) or need
  // an internal proxy session when the CDN requires request headers. Both are
  // native playback paths, so observe the first actual HLS master either way.
  const manifestWait = page.waitForResponse(
    (response) => /(?:\/api\/v1\/playback\/[^/]+\/master\.m3u8|\.m3u8(?:\?|$))/i.test(response.url()),
    { timeout: 120_000 },
  );

  await targetButton.click();
  const [playResponse, resolveResponse, manifestResponse] = await Promise.all([
    playWait,
    resolveWait,
    manifestWait,
  ]);
  expect(playResponse.status()).toBe(200);
  const payload = await playResponse.json();
  expect(payload.ranked_streams?.length).toBeGreaterThan(0);
  expect(payload.ranked_streams[0].source_site).toBe(expectedProvider);
  expect(resolveResponse.status()).toBe(200);
  expect(manifestResponse.status()).toBe(200);
  expect(manifestResponse.headers()['content-type']).toMatch(/mpegurl/i);
  expect(await manifestResponse.text()).toContain('#EXTM3U');

  const player = page.getByRole('dialog').last();
  await expect(player).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  const video = player.locator('video').first();
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.videoWidth), { timeout: 45_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 60_000 })
    .toBeGreaterThan(0.5);
}

test.describe('Matriz E2E de proveedores activos', () => {
  test('Cinecalidad entrega reproducción nativa de una película', async ({ page }) => {
    test.setTimeout(180_000);
    await playCatalogTitle(page, 'A la carrera', 'A la carrera', 'cinecalidad', /cinecalidad\.am/i);
  });

  test('LatAnime entrega reproducción nativa de un anime latino', async ({ page }) => {
    test.setTimeout(180_000);
    await playCatalogTitle(page, 'Shiguang Dailiren', 'Shiguang Dailiren', 'latanime', /latanime\.org/i, 'Temporada 3');
  });
});
