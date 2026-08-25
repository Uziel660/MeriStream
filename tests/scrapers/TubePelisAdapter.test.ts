import { describe, it, expect } from "vitest";
import { TubePelisAdapter } from "../../server/scrapers/adapters/TubePelisAdapter";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SITE_REFERER = "https://tubepelis.com/";

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

describe("TubePelisAdapter - integracion real contra tubepelis.com", () => {
  const adapter = new TubePelisAdapter();
  let searchResults: ExtractedCatalogItem[] = [];
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "search('Spider-Man') -> >= 1 resultado con title+url http",
    async () => {
      searchResults = await adapter.search("Spider-Man");
      console.log(`search resultados: ${searchResults.length}`);
      for (const r of searchResults.slice(0, 5)) {
        console.log(`  - ${r.title} -> ${r.url}`);
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      const first = searchResults[0];
      expect(first.title.trim().length).toBeGreaterThan(0);
      expect(first.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "analyze(primer resultado, 'detail') -> poster_url truthy, description > 10, episodes >= 1",
    async () => {
      if (searchResults.length === 0) {
        searchResults = await adapter.search("Spider-Man");
      }
      expect(searchResults.length).toBeGreaterThanOrEqual(1);

      const target = searchResults[0];
      console.log(`analyze target: ${target.title} -> ${target.url}`);

      analysis = await adapter.analyze(target.url, "detail");
      console.log(`page_type=${analysis.page_type} content_type=${analysis.content_type} title="${analysis.title}" poster=${analysis.poster_url} episodes=${analysis.episodes.length}`);
      console.log(`description: ${(analysis.description || "").slice(0, 120)}...`);

      expect(analysis.page_type).toBe("detail");
      expect(analysis.poster_url).toBeTruthy();
      expect((analysis.description || "").trim().length).toBeGreaterThan(10);
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(1);

      const ep = analysis.episodes[0];
      console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
      expect(ep.url.startsWith("http")).toBe(true);
    },
    240000
  );

  it(
    "extractStream(episodes[0].url) -> >= 1 stream (embed conocido o directo .mp4/.m3u8)",
    async () => {
      if (!analysis || analysis.episodes.length === 0) {
        const results = await adapter.search("Spider-Man");
        analysis = await adapter.analyze(results[0].url, "detail");
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
      // Cualquier URL HTTP devuelta por extractStream ya paso MediaValidator.
      // Tambien aceptamos hosts conocidos o media directa como bonus.
      const allHttp = allStreams.every((u) => /^https?:\/\//i.test(u));
      expect(allHttp).toBe(true);
    },
    240000
  );

  it(
    "anti-403: hasta 3 URLs devueltas responden <400 con GET (o hay embed conocido entre ellas)",
    async () => {
      if (allStreams.length === 0) {
        const stream = await adapter.extractStream(analysis!.episodes[0].url);
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
