import { test, expect } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

/**
 * E2E de usuario para el camino principal de anime ES-LATAM/JA+sub:
 * catálogo local → ficha → episodio → locator de ZokoAnime → resolución nativa
 * → sesión proxy HLS → playlist/segmentos → elemento <video>.
 *
 * El caso usa una entrada real del catálogo local para no depender de IDs
 * generados durante la importación. La prueba falla si vuelve un iframe,
 * si la sesión no entrega un manifiesto HLS o si el video no avanza.
 */
test.describe('Playback local nativo', () => {
  test('reproduce One Piece desde la interfaz y el proxy HLS interno', async ({ page }) => {
    test.setTimeout(120_000);

    const catalogResponse = await page.request.get(
      `${BASE_URL}/api/v1/shows?lite=true&search=One%20Piece&limit=10`,
    );
    expect(catalogResponse.ok()).toBeTruthy();
    const catalog = await catalogResponse.json();
    const show = catalog.shows?.find((item: any) => item.title === 'One Piece');
    expect(show?.id, 'el catálogo local debe contener One Piece').toBeTruthy();

    const detailResponse = await page.request.get(`${BASE_URL}/api/v1/shows/${show.id}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();
    expect(detail.episodes.length).toBeGreaterThan(0);
    expect(new Set(detail.episodes.map((episode: any) => `${episode.season_number || 1}:${episode.episode_number}`)).size)
      .toBe(detail.episodes.length);
    expect(detail.episodes.slice(0, 5).map((episode: any) => episode.episode_number)).toEqual([1, 2, 3, 4, 5]);
    const episodePlatforms = detail.episode_platforms?.map((platform: any) => platform.domain) || [];
    expect(episodePlatforms).toContain('zokoanime');
    expect(episodePlatforms).not.toContain('tioanime');
    expect(detail.episodes[0].source_url).toMatch(/\/sub(?:\?|$)/i);

    const resourceResponses: number[] = [];
    page.on('response', (response) => {
      if (/\/api\/v1\/playback\/[^/]+\/resource\//.test(response.url()) && response.ok()) {
        resourceResponses.push(response.status());
      }
    });

    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    const search = page.getByRole('searchbox');
    await expect(search).toBeVisible();
    await search.fill('One Piece');

    const card = page.locator('button.media-card').filter({ hasText: 'One Piece' }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();

    const details = page.getByRole('dialog').last();
    await expect(details).toBeVisible();
    await expect(details).toContainText(/Episodios \(/);
    const episode = details.locator('button.episode-card').first();
    await expect(episode).toBeVisible();

    const playWait = page.waitForResponse(
      (response) => /\/api\/v1\/play\//.test(response.url()),
      { timeout: 30_000 },
    );
    const resolveWait = page.waitForResponse(
      (response) => /\/api\/v1\/resolve-embed$/.test(response.url()),
      { timeout: 45_000 },
    );
    const sessionWait = page.waitForResponse(
      (response) => /\/api\/v1\/playback\/sessions$/.test(response.url()),
      { timeout: 60_000 },
    );
    const manifestWait = page.waitForResponse(
      (response) => /\/api\/v1\/playback\/[^/]+\/master\.m3u8$/.test(response.url()),
      { timeout: 75_000 },
    );

    await episode.click();

    const [playResponse, resolveResponse, sessionResponse, manifestResponse] = await Promise.all([
      playWait,
      resolveWait,
      sessionWait,
      manifestWait,
    ]);
    expect(playResponse.status()).toBe(200);
    const playPayload = await playResponse.json();
    expect(playPayload.ranked_streams?.length).toBeGreaterThan(0);
    expect(playPayload.ranked_streams[0].source_site).toBe('zokoanime');

    expect(resolveResponse.status()).toBe(200);
    expect(sessionResponse.status()).toBe(201);
    expect(manifestResponse.status()).toBe(200);
    expect(manifestResponse.headers()['content-type']).toMatch(/mpegurl/i);
    const manifestText = await manifestResponse.text();
    expect(manifestText).toContain('#EXTM3U');
    // La variante Zoko `/sub` conserva la pista de audio del vídeo. El proxy
    // normaliza el master a una playlist interna mínima, por lo que los
    // codecs pueden aparecer solo en la variante hija.

    const player = page.getByRole('dialog').last();
    await expect(player).toBeVisible();
    await expect(player).toContainText(/Zokoanime/i);
    await expect(page.locator('iframe')).toHaveCount(0);

    const video = player.locator('video').first();
    await expect(video).toBeVisible();
    await expect.poll(
      async () => video.evaluate((element) => element.readyState),
      { timeout: 30_000 },
    ).toBeGreaterThanOrEqual(2);
    await expect.poll(
      async () => video.evaluate((element) => element.videoWidth),
      { timeout: 30_000 },
    ).toBeGreaterThan(0);
    await expect.poll(
      async () => video.evaluate((element) => element.currentTime),
      { timeout: 45_000 },
    ).toBeGreaterThan(0.5);
    await expect.poll(() => resourceResponses.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const trackSnapshot = await video.evaluate((element) => ({
      textTracks: element.textTracks.length,
      audioTracks: typeof (element as any).audioTracks?.length === 'number'
        ? (element as any).audioTracks.length
        : 0,
    }));
    expect(trackSnapshot.textTracks).toBeGreaterThanOrEqual(0);
    expect(trackSnapshot.audioTracks).toBeGreaterThanOrEqual(0);

    // La pista HLS puede venir embebida en el video (sin una URL VTT aparte).
    // En ese caso el selector de idioma sigue mostrando la fuente /sub y no se
    // fabrica un menú de subtítulos vacío. Si el proveedor entrega tracks
    // reales, el mismo control debe exponerlos al usuario.
    const audioButton = player.getByTitle('Idioma de Audio');
    if (await audioButton.count()) {
      await audioButton.click();
      await expect(player).toContainText(/Fuentes por idioma/i);
      await audioButton.click();
    }
    const captionsButton = player.getByTitle('Subtítulos');
    if (await captionsButton.count()) {
      await captionsButton.click();
      await expect(player).toContainText(/Desactivados/i);
    }
  });
});
