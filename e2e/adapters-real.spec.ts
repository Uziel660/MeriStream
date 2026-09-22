import { test, expect } from '@playwright/test';
import { ScraperManager } from '../server/scrapers/ScraperManager';
import { assertDirectStreamOrFail, assertVideoPlays } from './helpers/video';

/**
 * E2E ligero para validar adaptadores reales de video.
 * - Una prueba por Cinecalidad, TubePelis y VerAnimes
 * - Extrae mediante adaptador real (ScraperManager + BaseAdapter.extractStream)
 * - Rechaza stream_url === page URL, 404, HTML o iframe/embed sin resolver
 * - Abre HTML controlado con <video src="stream_directo"> y valida:
 *   video.error === null, readyState >= 2, videoWidth/Height > 0, currentTime avanza
 * - Si no hay URL directa (solo embed), el test FALLA - no acepta embed
 * - Chromium únicamente, workers=1, serial (ver playwright.config.ts)
 * - Habilitado solo con LIVE_SCRAPER_E2E=1 (skip en CI normal)
 * - Helpers reutilizables refactorizados a e2e/helpers/video.ts (hls.js local, enableWorker:false)
 *
 * URLs de origen: slugs estables verificados contra adaptadores.
 * Si el sitio cambió 404, el test falla explícitamente (no enmascara con embed).
 */

// Habilitación explícita: sin LIVE_SCRAPER_E2E=1 los tests se skipean pero aparecen en --list
const IS_LIVE = process.env.LIVE_SCRAPER_E2E === '1';

// Targets estables por adaptador (una por dominio)
const TARGETS = [
  {
    id: 'cinecalidad' as const,
    name: 'Cinecalidad',
    // Slug verificado en CinecalidadAdapter (cinecalidad.am) - película con reproductor dooplay
    homeUrl: 'https://www.cinecalidad.am/',
    query: 'Supergirl',
    searchBox: 'Buscar...',
    resultSelector: 'a[href*="/ver-pelicula/"]',
    adapterId: 'cinecalidad',
  },
  {
    id: 'tubepelis' as const,
    name: 'TubePelis',
    // TubePelisAdapter: /pelicula/{id}/{slug}.html con proxy reproductor.php?v=Base64
    homeUrl: 'https://www.tubepelis.com/',
    query: 'Supergirl',
    searchBox: 'Buscar películas...',
    resultSelector: 'a[href*="/pelicula/"]',
    adapterId: 'tubepelis',
  },
  {
    id: 'veranimes' as const,
    name: 'VerAnimes',
    // VerAnimesAdapter: /ver/{slug}-{ep} con botones encrypt hex -> POST /process
    homeUrl: 'https://wwv.veranimes.net/',
    query: 'Kuroneko to Majo no Kyoushitsu',
    searchBox: 'buscar...',
    resultSelector: 'a[href*="/anime/kuroneko-to-majo-no-kyoushitsu"]',
    episodeSelector: 'a[href*="/ver/kuroneko-to-majo-no-kyoushitsu-"]',
    adapterId: 'veranimes',
  },
] as const;

async function discoverPlaybackUrl(page: import('@playwright/test').Page, target: (typeof TARGETS)[number]): Promise<string> {
  const response = await page.goto(target.homeUrl, { waitUntil: 'domcontentloaded' });
  expect(response?.status(), `[${target.name}] home no debe responder 404`).not.toBe(404);
  await page.getByRole('textbox', { name: target.searchBox }).fill(target.query);
  await page.getByRole('textbox', { name: target.searchBox }).press('Enter');

  const result = page.locator(target.resultSelector).filter({ hasText: target.query }).first();
  const fallback = page.locator(target.resultSelector).first();
  const link = (await result.count()) ? result : fallback;
  const href = await link.evaluate((element) => (element as HTMLAnchorElement).href);
  expect(href, `[${target.name}] la búsqueda debe devolver un enlace`).toBeTruthy();

  const detailUrl = new URL(href, page.url()).href;
  const detailResponse = await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  expect(detailResponse?.status(), `[${target.name}] detalle no debe responder 404`).not.toBe(404);

  if ('episodeSelector' in target) {
    const episodeHref = await page.locator(target.episodeSelector).first().evaluate((element) => (element as HTMLAnchorElement).href);
    expect(episodeHref, `[${target.name}] el detalle debe exponer un episodio`).toBeTruthy();
    const episodeUrl = new URL(episodeHref!, page.url()).href;
    const episodeResponse = await page.goto(episodeUrl, { waitUntil: 'domcontentloaded' });
    expect(episodeResponse?.status(), `[${target.name}] episodio no debe responder 404`).not.toBe(404);
    return episodeUrl;
  }

  return detailUrl;
}

test.describe('Adaptadores reales - validación de stream directo', () => {
  // Timeout por test: extracción (fetchHtml ~12s) + probe + video (25s)
  for (const target of TARGETS) {
    test(`${target.name} - stream directo reproduce en <video>`, async ({ page }) => {
      // Habilitación explícita: skip si no está LIVE_SCRAPER_E2E=1 (aparece como skipped en CI normal)
      test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1 - skip en CI normal para no cargar recursos');

      const pageUrl = await discoverPlaybackUrl(page, target);
      const mgr = ScraperManager.getInstance();
      const adapter = mgr.getAdapter(pageUrl, target.adapterId);
      expect(adapter, `No se encontró adaptador para ${pageUrl}`).toBeDefined();
      expect(adapter.id, `Adaptador esperado ${target.adapterId} pero se obtuvo ${adapter.id}`).toBe(target.adapterId);

      // Extraer mediante adaptador REAL (no mock) - usa BaseAdapter.extractStream + EmbedResolvers
      const extraction = await adapter.extractStream(pageUrl);

      // Log para debugging en modo live
      console.log(`[${target.name}] pageUrl: ${pageUrl}`);
      console.log(`[${target.name}] adapter: ${adapter.name} (${adapter.id})`);
      console.log(`[${target.name}] stream_url: ${extraction.stream_url}`);
      console.log(`[${target.name}] all_available_streams: ${JSON.stringify(extraction.all_available_streams?.slice(0, 3))}`);

      // Validaciones estrictas: si no hay URL directa, FALLA (no acepta embed)
      await assertDirectStreamOrFail(extraction.stream_url, pageUrl, target.name);

      // Abrir HTML controlado con <video> apuntando al stream directo y validar reproducción
      await assertVideoPlays(page, extraction.stream_url, target.name);
    });
  }
});
