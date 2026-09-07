import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('Cinecalidad expone audio español e inglés en el player interno', async ({ page }) => {
  test.setTimeout(150_000);

  const manifests: string[] = [];
  page.on('response', async (response) => {
    if (!/(?:\/api\/v1\/playback\/[^/]+\/master\.m3u8|\.m3u8(?:\?|$))/i.test(response.url()) || !response.ok()) return;
    try {
      const body = await response.text();
      if (body.includes('#EXTM3U')) manifests.push(body);
    } catch {
      // The browser may dispose a response while the player changes rendition.
    }
  });

  const catalogResponse = await page.request.get(
    `${BASE_URL}/api/v1/shows?lite=true&search=Thunderbolts&limit=20`,
  );
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const show = catalog.shows?.find((item: any) => item.title === 'Thunderbolts*');
  expect(show?.id).toBeTruthy();

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('Thunderbolts');
  const card = page.locator('button.media-card').filter({ hasText: 'Thunderbolts*' }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();

  const details = page.getByRole('dialog').last();
  await expect(details).toBeVisible();
  const episode = details.locator('button.episode-card').first();
  const playButton = details.getByRole('button', { name: /Reproducir película|Continuar película/i }).first();
  const target = (await episode.count()) > 0 ? episode : playButton;
  await expect(target).toBeVisible();
  await target.click();

  const player = page.getByRole('dialog').last();
  await expect(player).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  const video = player.locator('video').first();
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 60_000 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.videoWidth), { timeout: 60_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => manifests.length, { timeout: 60_000 }).toBeGreaterThan(0);

  const master = manifests.find((body) => body.includes('#EXT-X-MEDIA:TYPE=AUDIO'));
  expect(master).toBeTruthy();
  expect(master).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*LANGUAGE="es"/i);
  expect(master).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*LANGUAGE="en"/i);

  const audioButton = player.getByTitle('Idioma de Audio');
  await expect(audioButton).toBeVisible();
  await audioButton.click();
  await expect(player).toContainText('Español');
  await expect(player).toContainText('English');
  await expect(player).toContainText(/Fuentes por idioma/i);
});
