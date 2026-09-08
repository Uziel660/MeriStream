import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('TioAnime solo aparece como fallback de ZokoAnime y reproduce por el player interno', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    window.localStorage.setItem('voidstream_show_server_selector', 'true');
  });

  const catalogResponse = await page.request.get(
    `${BASE_URL}/api/v1/shows?lite=true&search=${encodeURIComponent('SPY x FAMILY')}&limit=20`,
  );
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = await catalogResponse.json();
  const show = catalog.shows?.find((item: any) => item.title === 'SPY x FAMILY');
  expect(show?.id).toBeTruthy();

  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/shows/${show.id}`);
  const detail = await detailResponse.json();
  expect(detail.episode_platforms?.map((platform: any) => platform.domain)).toEqual(
    expect.arrayContaining(['zokoanime', 'tioanime']),
  );
  expect(detail.episodes.some((episode: any) => episode.season_number === 3)).toBe(true);

  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  const search = page.getByRole('searchbox');
  await expect(search).toBeVisible();
  await search.fill('SPY x FAMILY');
  const card = page.locator('button.media-card').filter({ hasText: 'SPY x FAMILY' }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.click();

  const details = page.getByRole('dialog').last();
  await expect(details).toContainText(/Episodios \(/, { timeout: 30_000 });
  await details.getByRole('button', { name: 'Temporada 3', exact: true }).click();
  const episode = details.locator('button.episode-card').first();
  await expect(episode).toBeVisible();
  const playWait = page.waitForResponse(
    (response) => /\/api\/v1\/play\//.test(response.url()),
    { timeout: 45_000 },
  );
  await episode.click();

  const playResponse = await playWait;
  expect(playResponse.status()).toBe(200);
  const playPayload = await playResponse.json();
  // VidSrc may be the first healthy direct source. Provider order is not part
  // of the contract; the important guarantee is that Zoko remains selectable
  // and TioAnime is only its fallback.
  expect(playPayload.ranked_streams?.some((stream: any) => stream.source_site === 'zokoanime')).toBe(true);
  expect(playPayload.ranked_streams?.some((stream: any) => stream.source_site === 'tioanime')).toBe(true);

  const player = page.getByRole('dialog').last();
  const switchButton = player.locator('button[title="Cambiar o Inspeccionar Servidor de Streaming"]');
  await expect(switchButton).toBeVisible({ timeout: 30_000 });
  await switchButton.click();
  const zokoOption = player.getByRole('button').filter({ hasText: /ZOKOANIME/i }).first();
  await expect(zokoOption).toBeVisible({ timeout: 30_000 });
  const zokoResolveWait = page.waitForResponse(
    async (response) => {
      if (!/\/api\/v1\/(?:catalog\/episode-servers|resolve-embed)$/.test(response.url())) return false;
      try {
        const body = await response.json();
        return body.subtitles?.length > 0 ||
          body.ranked_streams?.some((stream: any) => stream.source_site === 'zokoanime') === true;
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  const zokoManifestWait = page.waitForResponse(
    (response) => /(?:\/api\/v1\/playback\/[^/]+\/master\.m3u8|\.m3u8(?:\?|$))/i.test(response.url()),
    { timeout: 120_000 },
  );
  await zokoOption.click();
  const [zokoResolveResponse, zokoManifestResponse] = await Promise.all([zokoResolveWait, zokoManifestWait]);
  expect(zokoResolveResponse.status()).toBe(200);
  const zokoResolution = await zokoResolveResponse.json();
  const zokoSubtitles = zokoResolution.subtitles || zokoResolution.ranked_streams?.[0]?.subtitles || [];
  expect(zokoSubtitles.length).toBeGreaterThan(0);
  expect(zokoSubtitles[0].language).toBe('en');
  const zokoSubtitleUrl = zokoSubtitles[0].src || zokoSubtitles[0].url;
  expect(zokoSubtitleUrl).toMatch(/^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt$/i);
  const zokoSubtitleResponse = await page.request.get(`${BASE_URL}${zokoSubtitleUrl}`);
  expect(zokoSubtitleResponse.status()).toBe(200);
  expect(zokoSubtitleResponse.headers()['content-type']).toMatch(/text\/vtt/i);
  expect(zokoManifestResponse.status()).toBe(200);
  expect(await zokoManifestResponse.text()).toContain('#EXTM3U');
  const zokoPlayer = page.getByRole('dialog').last();
  const zokoSubtitleButton = zokoPlayer.locator('button[title="Subtítulos"]');
  await expect(zokoSubtitleButton).toBeVisible({ timeout: 30_000 });
  await zokoSubtitleButton.click();
  await expect(zokoPlayer.getByRole('button', { name: 'English', exact: true }).first()).toBeVisible();

  await expect(switchButton).toBeVisible({ timeout: 30_000 });
  await switchButton.click();
  const tioOption = player.getByRole('button').filter({ hasText: /TIOANIME/i }).first();
  await expect(tioOption).toBeVisible();

  const resolveWait = page.waitForResponse(
    (response) => /\/api\/v1\/catalog\/episode-servers$/.test(response.url()),
    { timeout: 60_000 },
  );
  const manifestWait = page.waitForResponse(
    (response) => /(?:\/api\/v1\/playback\/[^/]+\/master\.m3u8|\.m3u8(?:\?|$))/i.test(response.url()),
    { timeout: 120_000 },
  );
  await tioOption.click();
  const [resolveResponse, manifestResponse] = await Promise.all([resolveWait, manifestWait]);
  expect(resolveResponse.status()).toBe(200);
  expect(manifestResponse.status()).toBe(200);
  expect(await manifestResponse.text()).toContain('#EXTM3U');
  await expect(page.locator('iframe')).toHaveCount(0);
  const video = player.locator('video').first();
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 45_000 })
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.videoWidth), { timeout: 45_000 })
    .toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 60_000 })
    .toBeGreaterThan(0.5);
});
