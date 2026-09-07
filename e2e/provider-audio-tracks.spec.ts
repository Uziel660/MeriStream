import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('Cinecalidad expone audio español e inglés en el player interno', async ({ page }) => {
  test.setTimeout(150_000);

  // La clave de OpenSubtitles no está configurada en este entorno. Simulamos
  // únicamente la respuesta pública que consumiría la aplicación para cubrir
  // el flujo real del usuario: API → <track> → menú → pista activa. El vídeo y
  // su manifiesto siguen siendo los de Cinecalidad y no se mockean.
  let subtitleApiCalls = 0;
  await page.route('**/api/v1/subtitles**', async (route) => {
    subtitleApiCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        tracks: [{
          id: 'e2e-es',
          label: 'Español (prueba)',
          language: 'es',
          url: 'https://subtitles.test/es.vtt',
          is_default: false,
        }],
      }),
    });
  });
  await page.route('https://subtitles.test/es.vtt', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/vtt',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'WEBVTT\\n\\n00:00:00.000 --> 00:00:05.000\\nPrueba de subtítulos en español\\n',
    });
  });

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
  await expect.poll(() => subtitleApiCalls, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(page.locator('iframe')).toHaveCount(0);

  // El ranking puede poner temporalmente Gnula/ Vidara delante mientras
  // Cinecalidad resuelve su ficha. Para probar las pistas de Cinecalidad de
  // forma determinista, seguimos el mismo control de failover que tendría el
  // usuario y avanzamos una vez si el primer locator es Gnula.
  if (await player.getByText(/Resolviendo fuente de GNULA/i).count()) {
    const nextServer = player.getByRole('button', { name: /Probar siguiente servidor/i });
    await expect(nextServer).toBeVisible({ timeout: 15_000 });
    await nextServer.click();
  }

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

  const captionsButton = player.getByTitle('Subtítulos');
  await expect(captionsButton).toBeVisible();
  await captionsButton.click();
  await expect(player).toContainText('Español (prueba)');
  await player.getByRole('button', { name: 'Español (prueba)' }).click();
  await expect.poll(
    () => player.locator('video').evaluate((element) =>
      Array.from(element.textTracks).some((track) => track.mode === 'showing')),
    { timeout: 10_000 },
  ).toBeTruthy();
});
