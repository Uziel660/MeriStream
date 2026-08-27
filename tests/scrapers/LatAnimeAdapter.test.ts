import { describe, it, expect } from "vitest";
import { LatAnimeAdapter } from "../../server/scrapers/adapters/LatAnimeAdapter";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SITE_REFERER = "https://latanime.org/";

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

describe("LatAnimeAdapter - integración real contra latanime.org", () => {
  const adapter = new LatAnimeAdapter();
  let searchResults: ExtractedCatalogItem[] = [];
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "search('Mushoku Tensei') devuelve >= 1 resultado con title y url http",
    async () => {
      searchResults = await adapter.search("Mushoku Tensei");
      console.log(`search resultados: ${searchResults.length}`);
      for (const r of searchResults.slice(0, 5)) {
        console.log(`  - [${r.year ?? "?"}] ${r.title} -> ${r.url}`);
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      const relevant =
        searchResults.find((r) => /mushoku tensei/i.test(r.title)) ??
        searchResults[0];
      expect(relevant.title.trim().length).toBeGreaterThan(0);
      expect(relevant.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "analyze(primer resultado relevante) -> detail con poster, descripción y episodios reales",
    async () => {
      if (searchResults.length === 0) {
        searchResults = await adapter.search("Mushoku Tensei");
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);

      const target =
        searchResults.find((r) => /mushoku tensei/i.test(r.title)) ??
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

      // Episodios reales: URLs válidas apuntando a páginas de reproducción
      const eps = analysis.episodes;
      const uniqueUrls = new Set(eps.map((e) => e.url));
      expect(uniqueUrls.size).toBe(eps.length);
      for (const ep of eps.slice(0, 3)) {
        console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
        expect(ep.url.startsWith("http")).toBe(true);
        expect(ep.url).toMatch(/\/ver\//);
        expect(ep.number).toBeGreaterThan(0);
      }
    },
    240000
  );

  it(
    "extractStream(episodes[0].url) -> >= 1 stream con embed conocido o directo .m3u8/.mp4",
    async () => {
      if (!analysis || analysis.episodes.length === 0) {
        const results = await adapter.search("Mushoku Tensei");
        const target =
          results.find((r) => /mushoku tensei/i.test(r.title)) ?? results[0];
        analysis = await adapter.analyze(target.url);
      }
      expect(analysis!.episodes.length).toBeGreaterThanOrEqual(1);

      const episodeUrl = analysis!.episodes[0].url;
      console.log(`extractStream de: ${episodeUrl}`);

      const stream = await adapter.extractStream(episodeUrl);
      allStreams = stream.all_available_streams;
      console.log(`stream_url: ${stream.stream_url}`);
      console.log(`all_available_streams (${allStreams.length}):`);
      for (const s of allStreams.slice(0, 12)) console.log(`  * ${s}`);
      console.log(`title: ${stream.title}`);

      expect(allStreams.length).toBeGreaterThanOrEqual(1);
      const hasKnown = allStreams.some(isKnownEmbed);
      const hasDirect = allStreams.some(isDirectMedia);
      // REGLA DE ORO: embeds conocidos cuentan como éxito aunque el .m3u8 crudo dé 403
      expect(hasKnown || hasDirect).toBe(true);
      // Regresión: el <h1> de la página de episodio es el botón "Reportar episodio",
      // el título debe salir de og:title y no del botón.
      expect(stream.title).toBeTruthy();
      expect(stream.title).not.toBe("Reportar episodio");
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
