import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('Cinecalidad expone audio español e inglés en el player interno', async ({ page }) => {
  test.setTimeout(150_000);

  // Este caso cubre el contrato del reproductor con un manifiesto HLS controlado.
  // Las sondas live de Cinecalidad se ejecutan aparte; aquí no dependemos de que
  // un token efímero de Vimeos esté vivo justo durante la suite.
  await page.route('**/api/v1/providers/movie/986056*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sources: [
          {
            provider: 'Cinecalidad',
            providerGroup: 'spanish-local',
            url: 'https://cinecalidad.test/master.m3u8',
            streamType: 'hls',
            audioLanguage: 'es',
            subtitleLanguage: null,
            subtitles: [],
            quality: '720p',
          },
          {
            provider: 'Cinecalidad',
            providerGroup: 'spanish-local',
            url: 'https://cinecalidad.test/master-en.m3u8',
            streamType: 'hls',
            audioLanguage: 'en',
            subtitleLanguage: null,
            subtitles: [],
            quality: '720p',
          },
        ],
        fallbackCandidates: [],
      }),
    });
  });

  const hlsMaster = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Español",LANGUAGE="es",DEFAULT=YES,AUTOSELECT=YES,URI="audio-es.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,URI="audio-en.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2",AUDIO="audio"',
    'video.m3u8',
    '',
  ].join('\n');
  const hlsMedia = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  let masterRequests = 0;
  await page.route('https://cinecalidad.test/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/master.m3u8')) {
      masterRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: hlsMaster,
      });
      return;
    }
    if (/\\.m3u8(?:\\?|$)/i.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: hlsMedia,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'video/mp2t',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.alloc(188, 0),
    });
  });

  // La clave de OpenSubtitles no está configurada en este entorno. Simulamos
  // únicamente la respuesta pública que consumiría la aplicación para cubrir
  // el flujo real del usuario: API → <track> → menú → pista activa.
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
      body: 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nPrueba de subtítulos en español\n',
    });
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

  const video = player.locator('video').first();
  await expect(video).toBeVisible();
  await expect.poll(() => masterRequests, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(player.getByTitle('Idioma de Audio')).toBeVisible({ timeout: 30_000 });

  const audioButton = player.getByTitle('Idioma de Audio');
  await expect(audioButton).toBeVisible();
  await audioButton.click();
  await expect(player).toContainText('Audio ES');
  await expect(player).toContainText('Audio EN');
  await expect(player).toContainText(/Fuentes por idioma/i);

  const captionsButton = player.getByTitle('Subtítulos');
  await expect(captionsButton).toBeVisible();
  await captionsButton.click();
  await expect(player).toContainText('Español (prueba)');
  await player.getByRole('button', { name: 'Español (prueba)' }).click();
  // El fixture no contiene frames de video, así que el navegador puede dejar
  // la pista en modo disabled hasta que haya un buffer. Verificamos el contrato
  // que sí depende de la UI: el <track> se montó con la etiqueta elegida.
  await expect(video.locator('track[label="Español (prueba)"]')).toHaveCount(1);
});
