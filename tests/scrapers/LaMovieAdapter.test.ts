import { describe, it, expect } from "vitest";
import { LaMovieAdapter } from "../../server/scrapers/adapters/LaMovieAdapter";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SITE_REFERER = "https://lamovie.org/";

const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.",
  "byselapuix.com",
  "mp4upload.com",
  "mega.nz",
  "streamtape.com",
  "streamwish.",
  "hlswish.",
  "filemoon.",
  "yourupload.com",
  "vidmoly.",
  "luluvdo.",
  "streamhide.",
  "ok.ru",
  "vimeo.com",
  "goodstream.",
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

const BOLT_URL = "https://lamovie.org/peliculas/bolt-un-perro-fuera-de-serie-2008/";

describe("LaMovieAdapter - integracion real contra lamovie.org", () => {
  const adapter = new LaMovieAdapter();
  let catalogItems: ExtractedCatalogItem[] = [];
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "catalogo: analyze('https://lamovie.org/peliculas','catalog') -> catalog_items.length > 500",
    async () => {
      const result = await adapter.analyze("https://lamovie.org/peliculas", "catalog");
      console.log(`page_type: ${result.page_type}`);
      console.log(`title: ${result.title}`);
      console.log(`catalog_items: ${result.catalog_items.length}`);
      expect(result.page_type).toBe("catalog");
      expect(result.catalog_items.length).toBeGreaterThan(500);

      catalogItems = result.catalog_items;
      const first = catalogItems[0];
      console.log(`primer item: ${first.title} -> ${first.url}`);
      expect(first.title.trim().length).toBeGreaterThan(0);
      expect(first.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "paginacion: analyze('https://lamovie.org/peliculas?page=2','catalog') -> items > 0",
    async () => {
      const result = await adapter.analyze("https://lamovie.org/peliculas?page=2", "catalog");
      console.log(`pagina 2 items: ${result.catalog_items.length}`);
      expect(result.page_type).toBe("catalog");
      expect(result.catalog_items.length).toBeGreaterThan(0);
    },
    240000
  );

  it(
    "detalle Bolt: title contiene 'Bolt', description > 20, poster_url truthy, year === 2008, episodes >= 1",
    async () => {
      analysis = await adapter.analyze(BOLT_URL, "detail");
      console.log(`page_type: ${analysis.page_type}`);
      console.log(`title: "${analysis.title}"`);
      console.log(`description: "${(analysis.description || "").slice(0, 120)}..."`);
      console.log(`poster_url: ${analysis.poster_url}`);
      console.log(`year: ${analysis.year}`);
      console.log(`episodes: ${analysis.episodes.length}`);

      expect(analysis.page_type).toBe("detail");
      expect(analysis.title).toContain("Bolt");
      expect((analysis.description || "").trim().length).toBeGreaterThan(20);
      expect(analysis.poster_url).toBeTruthy();
      expect(analysis.year).toBe(2008);
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(1);

      const ep = analysis.episodes[0];
      console.log(`ep #${ep.number} "${ep.title}" -> ${ep.url}`);
      expect(ep.url).toBe(BOLT_URL);
    },
    240000
  );

  it(
    "extractStream(Bolt URL) -> all_available_streams.length >= 3 con >= 1 host conocido; stream_url no vacio",
    async () => {
      if (!analysis) {
        analysis = await adapter.analyze(BOLT_URL, "detail");
      }
      expect(analysis!.episodes.length).toBeGreaterThanOrEqual(1);

      const stream = await adapter.extractStream(BOLT_URL);
      allStreams = stream.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
      console.log(`stream_url: ${stream.stream_url}`);
      console.log(`all_available_streams (${allStreams.length}):`);
      for (const s of allStreams.slice(0, 10)) console.log(`  * ${s}`);

      expect(allStreams.length).toBeGreaterThanOrEqual(3);
      expect(allStreams.some(isKnownEmbed) || allStreams.some(isDirectMedia)).toBe(true);
      expect(stream.stream_url.length).toBeGreaterThan(0);
    },
    240000
  );

  it(
    "anti-403: hasta 2 embeds devueltos con UA Chrome + Referer responden <400 o son host conocido",
    async () => {
      if (allStreams.length === 0) {
        const stream = await adapter.extractStream(BOLT_URL);
        allStreams = stream.all_available_streams;
      }
      expect(allStreams.length).toBeGreaterThanOrEqual(1);

      let anyOk = false;
      let anyKnown = false;

      for (const url of allStreams.slice(0, 2)) {
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
          console.log(`GET ${url.slice(0, 100)} -> ${res.status}`);
          if (res.status < 400) {
            anyOk = true;
            break;
          }
        } catch (e) {
          console.log(`GET ${url.slice(0, 100)} -> EXCEPCION ${(e as Error).message?.slice(0, 80)}`);
        }
      }

      console.log(`anyOk=${anyOk} anyKnown=${anyKnown}`);
      expect(anyOk || anyKnown).toBe(true);
    },
    240000
  );
});
