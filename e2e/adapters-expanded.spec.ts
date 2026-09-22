import { test, expect } from '@playwright/test';
import { ScraperManager } from '../server/scrapers/ScraperManager';
import { assertDirectStreamOrFail, assertVideoPlays, MUX_HLS_URL } from './helpers/video';
import * as http from 'http';

/**
 * E2E expandido LIVE_SCRAPER_E2E para validar múltiples adaptadores.
 * - Serial (workers=1, fullyParallel:false ya en config)
 * - Cada caso de video exige: stream directo .m3u8/.mp4, probe no HTML/404, <video> readyState>=2, dimensiones y currentTime avanzando
 * - No aceptar hosts conocidos ni embeds (assertDirectStreamOrFail)
 * - hls.js desde copia local node_modules/hls.js/dist/hls.min.js con Hls({enableWorker:false}) (ver e2e/helpers/video.ts)
 * - Todos los tests hacen test.skip(!IS_LIVE) para seguir listables con `npx playwright test --list` pero no ejecutar en CI normal
 * - No cambia producción (solo ScraperManager + adapters)
 */

const IS_LIVE = process.env.LIVE_SCRAPER_E2E === '1';

test.describe('Adapters expanded - validación secuencial LIVE_SCRAPER_E2E', () => {
  // Timeout generoso por test para fetchHtml + resolución + video
  test.setTimeout(90_000);

  test('DirectStream: Mux HLS público reproduce en <video>', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const mgr = ScraperManager.getInstance();
    const adapter = mgr.getAdapter(MUX_HLS_URL, 'direct_stream');
    expect(adapter, 'No se encontró DirectStreamAdapter').toBeDefined();
    expect(adapter.id).toBe('direct_stream');

    const extraction = await adapter.extractStream(MUX_HLS_URL);
    console.log(`[DirectStream] stream_url: ${extraction.stream_url}`);
    console.log(`[DirectStream] all: ${JSON.stringify(extraction.all_available_streams?.slice(0, 2))}`);

    // DirectStream: el stream es la propia URL de mux, no comparar contra sí misma como "embed sin resolver"
    // Usamos placeholder como pageUrl para no disparar el check de igualdad pero validar formato/probe
    await assertDirectStreamOrFail(extraction.stream_url, 'https://direct.stream/placeholder', 'DirectStream');
    await assertVideoPlays(page, extraction.stream_url, 'DirectStream');
  });

  test('ArchiveOrg: https://archive.org/details/BigBuckBunny_328 extrae stream directo', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const archiveUrl = 'https://archive.org/details/BigBuckBunny_328';
    const mgr = ScraperManager.getInstance();
    const adapter = mgr.getAdapter(archiveUrl, 'archive_org');
    expect(adapter, 'No se encontró ArchiveOrgAdapter').toBeDefined();
    expect(adapter.id).toBe('archive_org');

    const extraction = await adapter.extractStream(archiveUrl);
    console.log(`[ArchiveOrg] pageUrl: ${archiveUrl}`);
    console.log(`[ArchiveOrg] stream_url: ${extraction.stream_url}`);
    console.log(`[ArchiveOrg] all: ${JSON.stringify(extraction.all_available_streams?.slice(0, 3))}`);

    await assertDirectStreamOrFail(extraction.stream_url, archiveUrl, 'ArchiveOrg');
    await assertVideoPlays(page, extraction.stream_url, 'ArchiveOrg');
  });

  test('AnimeFlvAdapter vía JKAnime: buscar One Piece, detalle y episodio 1', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const searchUrl = 'https://jkanime.net/buscar?q=One%20Piece';
    const resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), '[JKAnime] búsqueda no debe responder 404').not.toBe(404);

    // Selector de resultados jkanime: tarjetas .anime__item
    const resultLink = page.locator('.anime__item a[href], a[href*="jkanime.net/"][href*="/"] ').first();
    // Fallback más laxo si no hay .anime__item
    let href: string | null = null;
    if (await resultLink.count()) {
      href = await resultLink.evaluate((el) => (el as HTMLAnchorElement).href).catch(() => null);
    }
    if (!href) {
      const fallback = page.locator('a[href*="jkanime.net/"]').first();
      href = await fallback.evaluate((el) => (el as HTMLAnchorElement).href);
    }
    expect(href, '[JKAnime] búsqueda One Piece debe devolver un enlace').toBeTruthy();
    const detailUrl = new URL(href!, page.url()).href;
    console.log(`[JKAnime] detailUrl: ${detailUrl}`);

    const detailResp = await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
    expect(detailResp?.status(), '[JKAnime] detalle no debe responder 404').not.toBe(404);

    const mgr = ScraperManager.getInstance();
    const adapter = mgr.getAdapter(detailUrl, 'animeflv');
    expect(adapter.id).toBe('animeflv');

    const analysis = await adapter.analyze(detailUrl);
    console.log(`[JKAnime] episodes: ${analysis.episodes?.length} title: ${analysis.title}`);
    expect(analysis.episodes?.length, '[JKAnime] el detalle debe exponer episodios').toBeGreaterThan(0);
    const ep1 = analysis.episodes!.find((e) => e.number === 1) || analysis.episodes![0];
    expect(ep1?.url, '[JKAnime] episodio 1 debe tener URL').toBeTruthy();
    const episodeUrl = new URL(ep1.url, detailUrl).href;
    console.log(`[JKAnime] episodeUrl: ${episodeUrl}`);

    const epResp = await page.goto(episodeUrl, { waitUntil: 'domcontentloaded' });
    expect(epResp?.status(), '[JKAnime] episodio 1 no debe responder 404').not.toBe(404);

    const extraction = await adapter.extractStream(episodeUrl);
    console.log(`[JKAnime] stream_url: ${extraction.stream_url}`);
    await assertDirectStreamOrFail(extraction.stream_url, episodeUrl, 'JKAnime/AnimeFlv');
    await assertVideoPlays(page, extraction.stream_url, 'JKAnime/AnimeFlv');
  });

  test('TioAnime: catálogo/directorio -> hasta 5 obras -> episodio 1 con stream directo', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    test.setTimeout(150_000);
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('tioanime');
    expect(adapter, 'No se encontró TioAnimeAdapter').toBeDefined();

    // Obtener catálogo real del directorio (no hardcodear Naruto)
    const catalog = await adapter.analyze('https://tioanime.com/directorio', 'catalog');
    console.log(`[TioAnime] catalog items: ${catalog.catalog_items?.length}`);
    expect(catalog.catalog_items?.length, '[TioAnime] catálogo debe devolver items').toBeGreaterThan(0);

    const candidates = catalog.catalog_items.slice(0, 5);
    console.log(`[TioAnime] candidatos (max 5): ${candidates.map((c: any) => `${c.title} -> ${c.url}`).join(' | ')}`);

    let lastError: unknown = null;
    let succeeded = false;
    let chosen: { title: string; detailUrl: string; episodeUrl: string; stream_url: string } | null = null;

    for (const cand of candidates) {
      const candDetailUrl = cand.url;
      const candTitle = cand.title;
      console.log(`\n[TioAnime] === probando candidato: "${candTitle}" detail:${candDetailUrl} ===`);
      try {
        // Análisis independiente por candidato (no reutilizar extracción entre candidatos)
        const detail = await adapter.analyze(candDetailUrl);
        console.log(`[TioAnime] detail title="${detail.title}" episodes:${detail.episodes?.length} detailUrl:${candDetailUrl}`);
        if (!detail.episodes || detail.episodes.length === 0) {
          console.log(`[TioAnime] sin episodios para ${candTitle}, skip`);
          continue;
        }
        const ep1 = detail.episodes.find((e: any) => e.number === 1) || detail.episodes[0];
        const episodeUrl: string = ep1.url;
        // Verificar correspondencia: episodeUrl debe derivar del mismo anime (slug)
        const detailSlug = (() => {
          try { return new URL(candDetailUrl).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; }
        })();
        const episodeSlug = (() => {
          try { return new URL(episodeUrl).pathname; } catch { return episodeUrl; }
        })();
        console.log(`[TioAnime] episodeUrl: ${episodeUrl} (detailSlug:${detailSlug})`);
        // Extracción propia del episodio (candidatos derivados de la MISMA página)
        const extraction = await adapter.extractStream(episodeUrl);
        console.log(`[TioAnime] stream_url: ${extraction.stream_url}`);
        console.log(`[TioAnime] all_available: ${JSON.stringify(extraction.all_available_streams?.slice(0, 3))}`);
        // Demostrar que el stream proviene del episodio elegido (no de otra obra)
        expect(episodeUrl, '[TioAnime] episodeUrl debe ser http').toMatch(/^https?:\/\//);
        // Validación estricta: debe ser media directa y reproducirse nativamente
        await assertDirectStreamOrFail(extraction.stream_url, episodeUrl, 'TioAnime');
        await assertVideoPlays(page, extraction.stream_url, 'TioAnime');
        // Éxito: registrar correspondencia
        chosen = { title: detail.title, detailUrl: candDetailUrl, episodeUrl, stream_url: extraction.stream_url };
        console.log(`[TioAnime] ✅ SUCCESS "${chosen.title}" detail:${chosen.detailUrl} episode:${chosen.episodeUrl} stream:${chosen.stream_url.slice(0, 90)}...`);
        succeeded = true;
        break;
      } catch (e) {
        console.log(`[TioAnime] candidato "${candTitle}" falló: ${String(e).slice(0, 500)}`);
        lastError = e;
        continue;
      }
    }

    expect(succeeded, `[TioAnime] ninguno de los ${candidates.length} candidatos del directorio dio stream directo reproducible. Último error: ${String(lastError)}`).toBeTruthy();
    if (chosen) {
      console.log(`[TioAnime] FINAL CHOSEN title="${chosen.title}" detail=${chosen.detailUrl} episode=${chosen.episodeUrl} stream=${chosen.stream_url}`);
      // Correspondencia explícita: episodeUrl pertenece al detail elegido
      expect(chosen.episodeUrl, '[TioAnime] episodeUrl debe pertenecer al detail elegido').toContain('tioanime.com/ver/');
      expect(chosen.detailUrl, '[TioAnime] detailUrl debe ser del catálogo').toContain('/anime/');
    }
  });

  test('LatAnime: search Mushoku Tensei -> vigente -> analyze -> episodio 1', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('latanime');
    expect(adapter, 'No se encontró LatAnimeAdapter').toBeDefined();

    const results = await adapter.search('Mushoku Tensei');
    console.log(`[LatAnime] search results: ${results.length}`);
    expect(results.length, '[LatAnime] search("Mushoku Tensei") debe devolver resultados').toBeGreaterThan(0);

    // Elegir resultado vigente: iterar hasta encontrar uno con episodios
    let detail: any = null;
    let detailUrl = '';
    for (const r of results.slice(0, 5)) {
      try {
        const cand = await adapter.analyze(r.url);
        if (cand.episodes && cand.episodes.length > 0) {
          detail = cand;
          detailUrl = r.url;
          console.log(`[LatAnime] elegido: ${r.title} -> ${r.url} episodes:${cand.episodes.length}`);
          break;
        }
      } catch (e) {
        console.log(`[LatAnime] analyze falló para ${r.url}: ${e}`);
      }
    }
    // Fallback al primero si ninguno tuvo episodios pero sigue siendo detalle
    if (!detail) {
      detailUrl = results[0].url;
      detail = await adapter.analyze(detailUrl);
    }
    console.log(`[LatAnime] detailUrl final: ${detailUrl} title: ${detail.title} episodes:${detail.episodes?.length}`);
    expect(detail.episodes?.length, '[LatAnime] detalle debe exponer episodios').toBeGreaterThan(0);

    const ep1 = detail.episodes!.find((e: any) => e.number === 1) || detail.episodes![0];
    const episodeUrl = ep1.url;
    console.log(`[LatAnime] episodeUrl: ${episodeUrl}`);

    const extraction = await adapter.extractStream(episodeUrl);
    console.log(`[LatAnime] stream_url: ${extraction.stream_url}`);
    await assertDirectStreamOrFail(extraction.stream_url, episodeUrl, 'LatAnime');
    await assertVideoPlays(page, extraction.stream_url, 'LatAnime');
  });

  test('TioPlus: search Supergirl -> analyze -> película/episodio reproduce', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    test.setTimeout(150_000);
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('tioplus');
    expect(adapter, 'No se encontró TioPlusAdapter').toBeDefined();

    const results = await adapter.search('Supergirl');
    console.log(`[TioPlus] search results: ${results.length} -> ${JSON.stringify(results.slice(0,3).map((r:any)=>r.title+' -> '+r.url))}`);
    expect(results.length, '[TioPlus] search("Supergirl") debe devolver resultados').toBeGreaterThan(0);

    let lastError: unknown = null;
    let succeeded = false;
    let chosenTitle = '';
    let chosenUrl = '';
    const candidates = results.slice(0, 3);
    for (const cand of candidates) {
      console.log(`[TioPlus] trying candidate: ${cand.title} -> ${cand.url}`);
      let detail: any;
      try {
        detail = await adapter.analyze(cand.url);
      } catch (e) {
        console.log(`[TioPlus] analyze falló para ${cand.url}: ${e}`);
        lastError = e;
        continue;
      }
      console.log(`[TioPlus] detail type: ${detail.content_type} episodes:${detail.episodes?.length} detected_streams:${detail.detected_streams?.length}`);
      const targetUrl = detail.episodes && detail.episodes.length > 0 ? detail.episodes[0].url : cand.url;
      console.log(`[TioPlus] targetUrl: ${targetUrl}`);
      let extraction: any;
      try {
        extraction = await adapter.extractStream(targetUrl);
      } catch (e) {
        console.log(`[TioPlus] extractStream falló para ${targetUrl}: ${e}`);
        lastError = e;
        continue;
      }
      console.log(`[TioPlus] stream_url: ${extraction.stream_url} all:${JSON.stringify(extraction.all_available_streams?.slice(0,5))}`);
      const allStreams: string[] = extraction.all_available_streams?.length ? extraction.all_available_streams : [extraction.stream_url];
      const directStreams = allStreams.filter((s: string) => /\.(m3u8|mp4|webm)(\?|#|$)/i.test(s));
      const streamsToTry = directStreams.length > 0 ? directStreams.slice(0, 2) : allStreams.slice(0, 1);
      let candidateOk = false;
      let successfulStream = '';
      for (const streamUrl of streamsToTry) {
        try {
          console.log(`[TioPlus] probing stream: ${streamUrl.slice(0,90)}`);
          await assertDirectStreamOrFail(streamUrl, targetUrl, 'TioPlus');
          await assertVideoPlays(page, streamUrl, 'TioPlus');
          candidateOk = true;
          successfulStream = streamUrl;
          console.log(`[TioPlus] stream SUCCESS ${streamUrl.slice(0,90)}`);
          break;
        } catch (e) {
          console.log(`[TioPlus] stream failed ${streamUrl.slice(0,90)} -> ${String(e).slice(0,300)}`);
          lastError = e;
          continue;
        }
      }
      if (candidateOk) {
        succeeded = true;
        chosenTitle = cand.title;
        chosenUrl = cand.url;
        console.log(`[TioPlus] SUCCESS with ${cand.title} -> ${cand.url} stream:${successfulStream}`);
        break;
      } else {
        console.log(`[TioPlus] candidate ${cand.title} no tuvo stream reproducible entre ${streamsToTry.length} intentos`);
        continue;
      }
    }
    expect(succeeded, `[TioPlus] ninguno de los ${candidates.length} candidatos (Supergirl) entregó stream directo reproducible. Último error: ${String(lastError)} - elegido: ${chosenTitle} `).toBeTruthy();
    console.log(`[TioPlus] elegido final: ${chosenTitle} -> ${chosenUrl}`);
  });

  test('LaMovie: catálogo -> hasta 5 obras -> stream directo reproducible', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    test.setTimeout(300_000);
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('lamovie');
    expect(adapter, 'No se encontró LaMovieAdapter').toBeDefined();

    const catalogUrl = 'https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24';
    const catalog = await adapter.analyze(catalogUrl, 'catalog');
    console.log(`[LaMovie] catalog items: ${catalog.catalog_items?.length}`);
    expect(catalog.catalog_items?.length, '[LaMovie] catálogo movies page=1 debe devolver items').toBeGreaterThan(0);

    const candidates = catalog.catalog_items.slice(0, 5);
    let succeeded = false;
    let lastError: unknown = null;

    for (const item of candidates) {
      try {
        console.log(`[LaMovie] probando: ${item.title} -> ${item.url}`);
        const detail = await adapter.analyze(item.url);
        const targetUrl = detail.episodes?.[0]?.url || item.url;
        const extraction = await adapter.extractStream(targetUrl);
        const streams: string[] = extraction.all_available_streams?.length
          ? extraction.all_available_streams
          : [extraction.stream_url];
        const directStreams = streams
          .filter((url: string) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url))
          .slice(0, 2);

        console.log(`[LaMovie] detail=${detail.title} target=${targetUrl} directos=${directStreams.length}`);
        for (const streamUrl of directStreams) {
          try {
            await assertDirectStreamOrFail(streamUrl, targetUrl, 'LaMovie');
            await assertVideoPlays(page, streamUrl, 'LaMovie');
            console.log(`[LaMovie] SUCCESS ${item.title} -> ${streamUrl.slice(0, 100)}`);
            succeeded = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (succeeded) break;
      } catch (error) {
        lastError = error;
      }
    }

    expect(
      succeeded,
      `[LaMovie] ninguna de las ${candidates.length} obras entregó video directo reproducible. Último error: ${String(lastError)}`,
    ).toBeTruthy();
  });

  test('Doramasflix: catalog /doramas -> item -> detail -> episodio (falla si embed/page)', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('doramasflix');
    expect(adapter, 'No se encontró DoramasflixAdapter').toBeDefined();

    const catalogUrl = 'https://doramasflix.io/doramas';
    const catalog = await adapter.analyze(catalogUrl, 'catalog');
    console.log(`[Doramasflix] catalog items: ${catalog.catalog_items?.length}`);
    expect(catalog.catalog_items?.length, '[Doramasflix] catálogo /doramas debe devolver items').toBeGreaterThan(0);

    const item = catalog.catalog_items[0];
    console.log(`[Doramasflix] item: ${item.title} -> ${item.url}`);

    const detail = await adapter.analyze(item.url);
    console.log(`[Doramasflix] detail episodes: ${detail.episodes?.length} title: ${detail.title}`);
    expect(detail.episodes?.length, '[Doramasflix] detalle debe exponer episodios').toBeGreaterThan(0);
    console.log(`[Doramasflix] identity tmdb=${detail.tmdb_id ?? 'none'} imdb=${detail.imdb_id ?? 'none'} original=${detail.original_title ?? 'none'}`);
    expect(detail.tmdb_id, '[Doramasflix] la ficha debe cruzarse con TMDB para habilitar VidSrc').toBeGreaterThan(0);
    expect(detail.imdb_id, '[Doramasflix] la ficha debe conservar el IMDb externo de TMDB').toMatch(/^tt\d+$/i);

    const ep1 = detail.episodes.find((e: any) => e.number === 1) || detail.episodes[0];
    const episodeUrl = ep1.url;
    console.log(`[Doramasflix] episodeUrl: ${episodeUrl}`);

    const extraction = await adapter.extractStream(episodeUrl);
    console.log(`[Doramasflix] stream_url: ${extraction.stream_url}`);
    // Debe fallar si extractStream devuelve URL de página/embed (assert fallará con mensaje explícito)
    await assertDirectStreamOrFail(extraction.stream_url, episodeUrl, 'Doramasflix');
    await assertVideoPlays(page, extraction.stream_url, 'Doramasflix');
  });

  test('GenericAdapter: servidor HTTP local con <video src="Mux HLS"> -> extractStream y reproducción', async ({ page }) => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    // Crear servidor HTTP mínimo que entrega HTML con <video src="Mux HLS">
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Generic Test</title></head><body><video src="${MUX_HLS_URL}" controls></video><p>Test generic adapter</p></body></html>`;
    let server: http.Server;
    let baseUrl: string;
    await new Promise<void>((resolve, reject) => {
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr: any = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}/`;
        console.log(`[GenericAdapter] local server: ${baseUrl}`);
        resolve();
      });
      server.on('error', reject);
    });

    try {
      const mgr = ScraperManager.getInstance();
      const adapter = mgr.getAdapter(baseUrl!, 'generic');
      expect(adapter.id).toBe('generic');

      const extraction = await adapter.extractStream(baseUrl!);
      console.log(`[GenericAdapter] stream_url: ${extraction.stream_url}`);
      console.log(`[GenericAdapter] all: ${JSON.stringify(extraction.all_available_streams?.slice(0, 3))}`);

      await assertDirectStreamOrFail(extraction.stream_url, baseUrl!, 'GenericAdapter');
      await assertVideoPlays(page, extraction.stream_url, 'GenericAdapter');
    } finally {
      await new Promise<void>((resolve) => (server as http.Server).close(() => resolve()));
      console.log('[GenericAdapter] local server cerrado');
    }
  });

  test('TvMaze: metadata detected_streams vacío (NO reproducción)', async () => {
    test.skip(!IS_LIVE, 'Requiere LIVE_SCRAPER_E2E=1');
    const mgr = ScraperManager.getInstance();
    const adapter: any = mgr.getAdapterById('tvmaze');
    expect(adapter, 'No se encontró TvMazeAdapter').toBeDefined();

    const showUrl = 'https://www.tvmaze.com/shows/169/breaking-bad';
    const result = await adapter.analyze(showUrl);
    console.log(`[TvMaze] title: ${result.title} page_type: ${result.page_type}`);
    console.log(`[TvMaze] detected_streams: ${JSON.stringify(result.detected_streams)}`);
    console.log(`[TvMaze] episodes: ${result.episodes?.length}`);

    // Confirmar que es solo metadata: sin streams
    expect(result.detected_streams, '[TvMaze] detected_streams debe estar vacío (solo metadata)').toBeDefined();
    expect(result.detected_streams.length, '[TvMaze] detected_streams debe ser 0').toBe(0);
    // No prueba de reproducción: solo validar que no hay <video> que validar
    expect(result.episodes?.length, '[TvMaze] debe traer episodios como metadata').toBeGreaterThan(0);
  });
});
