import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('la ficha de anime expone LatAnime y ZokoAnime en el selector de fuentes', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    window.localStorage.setItem('voidstream_show_server_selector', 'true');
  });

  const catalogResponse = await page.request.get(
    `${BASE_URL}/api/v1/shows?lite=true&category=anime&search=${encodeURIComponent('Gachiakuta')}&limit=20`,
  );
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const show = catalog.shows?.find((item: any) => item.title === 'Gachiakuta');
  expect(show?.id).toBeTruthy();

  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/shows/${show.id}`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  expect(detail.episode_platforms?.map((platform: any) => platform.domain)).toEqual(
    expect.arrayContaining(['latanime', 'zokoanime']),
  );

  const gatewayResponse = await page.request.get(
    `${BASE_URL}/api/v1/providers/anime/${show.tmdb_id}?season=1&episode=1&audio=es,en,ja&subtitles=es,en`,
  );
  expect(gatewayResponse.ok()).toBeTruthy();
  const gateway = await gatewayResponse.json();
  expect(gateway.fallbackCandidates?.map((candidate: any) => candidate.provider)).toEqual(
    expect.arrayContaining(['latanime', 'zokoanime']),
  );

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('Gachiakuta');
  const card = page.locator('button.media-card').filter({ hasText: 'Gachiakuta' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  const details = page.getByRole('dialog').last();
  await expect(details).toContainText(/Episodios \(/, { timeout: 30_000 });
  const episode = details.locator('button.episode-card').first();
  await expect(episode).toBeVisible();

  const playWait = page.waitForResponse(
    (response) => /\/api\/v1\/play\//.test(response.url()),
    { timeout: 30_000 },
  );
  await episode.click();
  expect((await playWait).status()).toBe(200);

  const player = page.getByRole('dialog').last();
  const switchButton = player.locator('button[title="Cambiar o Inspeccionar Servidor de Streaming"]');
  await expect(switchButton).toBeVisible({ timeout: 30_000 });
  await switchButton.click();
  await expect(player).toContainText(/LATANIME/i);
  await expect(player).toContainText(/ZOKOANIME/i);
  await expect(page.locator('iframe')).toHaveCount(0);
});
