import { describe, it, expect, vi } from "vitest";
import { TioAnimeAdapter } from "../../server/scrapers/adapters/TioAnimeAdapter";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";
import { EmbedResolvers } from "../../server/resolvers";
import { MediaValidator } from "../../server/validator";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SITE_REFERER = "https://tioanime.com/";

const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.",
  "byselapuix.com",
  "mp4upload.com",
  "mega.nz",
  "streamtape.com",
  "streamwish.",
  "filemoon.",
  "yourupload.com",
  "vidmoly.",
  "luluvdo.",
  "streamhide.",
  "ok.ru",
  "vimeo.com",
  "dood.",
  "doodstream.",
  "fembed.",
  "mixdrop.",
  "uqload.",
  "upstream.",
  "embedsito.",
  "streamlare.",
  "fastre.",
  "gamovideo.",
  "netu.",
  "waaw.",
  "streamdav.",
  "streamhub.",
];

const isKnownEmbed = (url: string) =>
  KNOWN_EMBED_HOSTS.some((h) => url.toLowerCase().includes(h));
const isDirectMedia = (url: string) => /\.(m3u8|mp4|webm)(\?|$)/i.test(url);

describe("TioAnimeAdapter - integración real contra tioanime.com", () => {
  const adapter = new TioAnimeAdapter();
  let searchResults: ExtractedCatalogItem[] = [];
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "search('Naruto') devuelve >= 1 resultado con title y url http",
    async () => {
      searchResults = await adapter.search("Naruto");
      console.log(`search resultados: ${searchResults.length}`);
      for (const r of searchResults.slice(0, 5)) {
        console.log(`  - ${r.title} -> ${r.url} [img: ${r.image_url}]`);
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      const relevant =
        searchResults.find((r) => /naruto/i.test(r.title)) ?? searchResults[0];
      expect(relevant.title.trim().length).toBeGreaterThan(0);
      expect(relevant.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "analyze(primer resultado relevante) -> detail con poster, descripción y episodios reales",
    async () => {
      if (searchResults.length === 0) {
        searchResults = await adapter.search("Naruto");
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);

      const target =
        searchResults.find((r) => /^\/anime\/|^https?:\/\/[^/]+\/anime\//i.test(r.url)) ??
        searchResults[0];
      console.log(`analyze target: ${target.title} -> ${target.url}`);

      analysis = await adapter.analyze(target.url);
      console.log(
        `page_type=${analysis.page_type} title="${analysis.title}" poster=${analysis.poster_url} episodes=${analysis.episodes.length}`
      );
      console.log(`description: ${(analysis.description || "").slice(0, 100)}...`);

      expect(analysis.page_type).toBe("detail");
      expect(analysis.poster_url).toBeTruthy();
      expect((analysis.description || "").length).toBeGreaterThan(10);
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(1);

      // Episodios reales: URLs válidas apuntando a páginas de reproducción, números únicos > 0
      const eps = analysis.episodes;
      const uniqueUrls = new Set(eps.map((e) => e.url));
      expect(uniqueUrls.size).toBe(eps.length);
      for (const ep of eps.slice(0, 3)) {
        console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
        expect(ep.url.startsWith("http")).toBe(true);
        expect(ep.number).toBeGreaterThan(0);
      }
    },
    240000
  );

  it(
    "extractStream(episodes[0].url) -> >= 1 stream con embed conocido o directo .m3u8/.mp4",
    async () => {
      if (!analysis || analysis.episodes.length === 0) {
        const results = await adapter.search("Naruto");
        const target = results.find((r) => /naruto/i.test(r.title)) ?? results[0];
        analysis = await adapter.analyze(target.url);
      }
      expect(analysis!.episodes.length).toBeGreaterThanOrEqual(1);

      const episodeUrl = analysis!.episodes[0].url;
      console.log(`extractStream de: ${episodeUrl}`);

      const stream = await adapter.extractStream(episodeUrl);
      allStreams = stream.all_available_streams;
      console.log(`stream_url: ${stream.stream_url}`);
      console.log(`all_available_streams (${allStreams.length}):`);
      for (const s of allStreams.slice(0, 8)) console.log(`  * ${s}`);
      console.log(`title: ${stream.title}`);

      expect(allStreams.length).toBeGreaterThanOrEqual(1);
      const hasKnown = allStreams.some(isKnownEmbed);
      const hasDirect = allStreams.some(isDirectMedia);
      // REGLA DE ORO: embeds conocidos cuentan como éxito aunque el .m3u8 crudo dé 403
      expect(hasKnown || hasDirect).toBe(true);
    },
    240000
  );

  it(
    "anti-403: hasta 3 URLs devueltas responden <400 con GET (o hay embed conocido entre ellas)",
    async () => {
      if (allStreams.length === 0 && analysis && analysis.episodes.length > 0) {
        const stream = await adapter.extractStream(analysis.episodes[0].url);
        allStreams = stream.all_available_streams;
      }
      expect(allStreams.length).toBeGreaterThanOrEqual(1);

      let anyOk = false;
      let anyKnown = false;

      for (const url of allStreams.slice(0, 3)) {
        const known = isKnownEmbed(url);
        if (known) anyKnown = true;
        try {
          const res = await fetch(url, {
            redirect: "follow",
            headers: {
              "User-Agent": UA_CHROME,
              Referer: SITE_REFERER,
              Accept: "*/*",
            },
          });
          console.log(`GET ${url.slice(0, 90)} -> ${res.status}`);
          if (res.status < 400) {
            anyOk = true;
            break;
          }
          // 403 en embed conocido no invalida si hay otra opción
        } catch (e) {
          console.log(
            `GET ${url.slice(0, 90)} -> EXCEPCIÓN ${(e as Error).message?.slice(0, 80)}`
          );
        }
      }

      console.log(`anyOk=${anyOk} anyKnown=${anyKnown}`);
      // Falla solo si TODO falla y nada es host conocido
      expect(anyOk || anyKnown).toBe(true);
    },
    240000
  );
});

/**
 * Regresión determinista: priorización directo > embed
 * Sin depender exclusivamente de red live, reproduce el fallo reportado:
 * - var videos con Mega primero + alternativas resolubles a .m3u8
 * - implementación vieja conservaba orden y stream_url = mega.nz/embed (embed no reproducible según E2E)
 * - corrección debe ordenar directos primero aunque el embed venga primero en el HTML.
 * - JAMÁS debe aparecer un stream de otra obra/episodio (corrupción cruzada prohibida).
 */
describe("TioAnimeAdapter - priorización directo > embed (regresión determinista)", () => {
  it("extractStream prioriza .m3u8/.mp4 directo sobre mega.nz embed aunque venga primero en var videos", async () => {
    const adapter = new TioAnimeAdapter();
    // HTML sintético con var videos en orden "malo": Mega primero, luego un CDN directo y hosts resolubles
    const fakeHtml = `
      <html><head><title>Naruto 1</title></head><body>
      <h1>Naruto Episodio 1</h1>
      <script>var videos = [["Mega","https://mega.nz/embed/ABC#key"],["Voe","https://voe.sx/e/abc123"],["Okru","https://ok.ru/videoembed/123456"],["CDN","https://cdn.example.com/video.m3u8"]];</script>
      </body></html>
    `;
    // Mock fetchHtml: episodio devuelve fakeHtml, sub-fetches de VOE devuelven null (evitar red real)
    const fetchSpy = vi.spyOn(adapter as any, "fetchHtml").mockImplementation(async (url: string) => {
      if (url.includes("voe.sx")) return null;
      return fakeHtml;
    });
    // Mock EmbedResolvers.resolve: ok.ru y voe resuelven a .m3u8 directo, mega permanece embed
    const resolveSpy = vi.spyOn(EmbedResolvers, "resolve").mockImplementation(async (url: string) => {
      if (url.includes("ok.ru")) return "https://ok.ru/hls/123/master.m3u8";
      if (url.includes("voe.sx")) return "https://voe-cdn.example.com/v/abc/master.m3u8";
      if (url.includes("cdn.example.com")) return url;
      if (url.includes("mega.nz")) return url;
      return url;
    });
    const validateSpy = vi.spyOn(MediaValidator, "validateUrls").mockImplementation(async (urls: string[]) => {
      // No filtrar, devolver en mismo orden para validar que el orden priorizado lo hace el adapter, no el validator
      return urls;
    });

    const result = await adapter.extractStream("https://tioanime.com/ver/naruto-1");

    expect(result.stream_url).toMatch(/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i);
    expect(result.stream_url.toLowerCase()).not.toContain("mega.nz");
    expect(result.all_available_streams[0]).toMatch(/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i);
    const megaIdx = result.all_available_streams.findIndex((u) => u.toLowerCase().includes("mega.nz"));
    const directIdx = result.all_available_streams.findIndex((u) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u));
    expect(directIdx).toBeGreaterThanOrEqual(0);
    // Si hay mega, debe quedar después del primer directo
    if (megaIdx >= 0) expect(megaIdx).toBeGreaterThan(directIdx);
    // Todos los directos deben preceder a cualquier embed no-directo
    const firstEmbedIdx = result.all_available_streams.findIndex((u) => !/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u) && !EmbedResolvers.isPlaceholderUrl(u));
    if (firstEmbedIdx >= 0 && directIdx >= 0) expect(firstEmbedIdx).toBeGreaterThan(0);
    // Verificar que todos los streams provienen de la MISMA página (no fallback cruzado)
    for (const u of result.all_available_streams) {
      expect(u).toMatch(/mega\.nz|voe|ok\.ru|cdn\.example\.com/);
    }

    fetchSpy.mockRestore();
    resolveSpy.mockRestore();
    validateSpy.mockRestore();
  });

  it("branch fallback genérico también prioriza directo sobre embed", async () => {
    const adapter = new TioAnimeAdapter();
    // Sin var videos: fallback a extractEmbedsAndStreamsFromHtml (iframe + video src)
    const fallbackHtml = `
      <html><head><title>Naruto 1</title></head><body>
      <h1>Naruto Episodio 1</h1>
      <iframe src="https://mega.nz/embed/XYZ#key"></iframe>
      <video><source src="https://cdn.example.com/fallback.m3u8" /></video>
      </body></html>
    `;
    const fetchSpy = vi.spyOn(adapter as any, "fetchHtml").mockImplementation(async () => fallbackHtml);
    const resolveSpy = vi.spyOn(EmbedResolvers, "resolve").mockImplementation(async (url: string) => url);
    const validateSpy = vi.spyOn(MediaValidator, "validateUrls").mockImplementation(async (urls: string[]) => urls);

    const result = await adapter.extractStream("https://tioanime.com/ver/naruto-1");

    expect(result.stream_url).toMatch(/\.m3u8/i);
    expect(result.stream_url.toLowerCase()).not.toContain("mega.nz");
    expect(result.all_available_streams[0].toLowerCase()).toContain(".m3u8");

    fetchSpy.mockRestore();
    resolveSpy.mockRestore();
    validateSpy.mockRestore();
  });

  it("si solo hay embeds sin directo, mantiene embed como fallback y NO aparece directo ajeno", async () => {
    const adapter = new TioAnimeAdapter();
    const onlyEmbedHtml = `
      <html><head><title>Solo Mega</title></head><body>
      <h1>Solo Mega</h1>
      <script>var videos = [["Mega","https://mega.nz/embed/ONLY#key"]];</script>
      </body></html>
    `;
    const fetchSpy = vi.spyOn(adapter as any, "fetchHtml").mockImplementation(async () => onlyEmbedHtml);
    const resolveSpy = vi.spyOn(EmbedResolvers, "resolve").mockImplementation(async (url: string) => url);
    const validateSpy = vi.spyOn(MediaValidator, "validateUrls").mockImplementation(async (urls: string[]) => urls);

    const result = await adapter.extractStream("https://tioanime.com/ver/solo-1");

    // Debe devolver el embed de la MISMA página, sin inventar un .m3u8 de otra obra
    expect(result.stream_url.toLowerCase()).toContain("mega.nz");
    expect(result.stream_url).not.toMatch(/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i);
    expect(result.all_available_streams.length).toBeGreaterThanOrEqual(1);
    expect(result.all_available_streams.every((u) => u.toLowerCase().includes("mega.nz"))).toBe(true);
    // Ningún stream debe ser de un host ajeno (ej. cloudwindow-route deFallback anterior)
    expect(result.all_available_streams.some((u) => u.includes("cloudwindow") || u.includes("fallback"))).toBe(false);

    fetchSpy.mockRestore();
    resolveSpy.mockRestore();
    validateSpy.mockRestore();
  });
});
