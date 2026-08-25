import { describe, it, expect } from "vitest";
import { CinecalidadAdapter } from "../../server/scrapers/adapters/CinecalidadAdapter";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SITE_REFERER = "https://www.cinecalidad.am/";

// Espejo de KNOWN_EMBED_HOSTS de server/validator.ts (lectura de evidencia)
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

describe("CinecalidadAdapter - integración real contra cinecalidad.am", () => {
  const adapter = new CinecalidadAdapter();
  let searchResults: ExtractedCatalogItem[] = [];
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "dominio vivo: https://www.cinecalidad.am/ responde <400 siguiendo redirects",
    async () => {
      const res = await fetch("https://www.cinecalidad.am/", {
        redirect: "follow",
        headers: { "User-Agent": UA_CHROME },
      });
      console.log(`GET home -> ${res.status} (URL final: ${res.url})`);
      expect(res.status).toBeLessThan(400);
      // El adaptador debe seguir reclamando el dominio
      expect(adapter.canHandle("https://cinecalidad.am/ver-pelicula/x/")).toBe(true);
    },
    240000
  );

  it(
    "search('Bolt') devuelve >= 1 resultado con title y url http",
    async () => {
      searchResults = await adapter.search("Bolt");
      console.log(`search resultados: ${searchResults.length}`);
      for (const r of searchResults.slice(0, 5)) {
        console.log(`  - ${r.title} -> ${r.url} [img: ${r.image_url}]`);
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      const relevant =
        searchResults.find((r) => /bolt/i.test(r.title)) ?? searchResults[0];
      expect(relevant.title.trim().length).toBeGreaterThan(0);
      expect(relevant.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "analyze(primer resultado relevante, 'detail') -> poster truthy, descripción no vacía y >= 1 episodio (película -> ficticio permitido)",
    async () => {
      if (searchResults.length === 0) {
        searchResults = await adapter.search("Bolt");
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);

      const target =
        searchResults.find((r) => /bolt/i.test(r.title)) ?? searchResults[0];
      console.log(`analyze target: ${target.title} -> ${target.url}`);

      analysis = await adapter.analyze(target.url, "detail");
      console.log(
        `page_type=${analysis.page_type} content_type=${analysis.content_type} title="${analysis.title}" poster=${analysis.poster_url} episodes=${analysis.episodes.length}`
      );
      console.log(`description: ${(analysis.description || "").slice(0, 100)}...`);

      expect(analysis.page_type).toBe("detail");
      expect(analysis.poster_url).toBeTruthy();
      expect((analysis.description || "").trim().length).toBeGreaterThan(0);
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(1);

      const ep = analysis.episodes[0];
      console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
      expect(ep.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "extractStream(ep[0].url) -> >= 1 stream válido (embed conocido o directo .m3u8/.mp4)",
    async () => {
      if (!analysis || analysis.episodes.length === 0) {
        const results = await adapter.search("Bolt");
        const target = results.find((r) => /bolt/i.test(r.title)) ?? results[0];
        analysis = await adapter.analyze(target.url, "detail");
      }
      expect(analysis!.episodes.length).toBeGreaterThanOrEqual(1);

      const episodeUrl = analysis!.episodes[0].url;
      console.log(`extractStream de: ${episodeUrl}`);

      const stream = await adapter.extractStream(episodeUrl);
      allStreams = stream.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
      console.log(`stream_url: ${stream.stream_url}`);
      console.log(`all_available_streams (${allStreams.length}):`);
      for (const s of allStreams.slice(0, 10)) console.log(`  * ${s}`);

      expect(allStreams.length).toBeGreaterThanOrEqual(1);
      // REGLA DE ORO: embed conocido cuenta como éxito aunque el m3u8 crudo dé 403
      expect(allStreams.some(isKnownEmbed) || allStreams.some(isDirectMedia)).toBe(true);
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
        } catch (e) {
          console.log(
            `GET ${url.slice(0, 90)} -> EXCEPCIÓN ${(e as Error).message?.slice(0, 80)}`
          );
        }
      }

      console.log(`anyOk=${anyOk} anyKnown=${anyKnown}`);
      expect(anyOk || anyKnown).toBe(true);
    },
    240000
  );
});
