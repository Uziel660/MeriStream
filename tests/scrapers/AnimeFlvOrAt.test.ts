import { describe, it, expect } from "vitest";
import { AnimeFlvAdapter } from "../../server/scrapers/adapters/AnimeFlvAdapter";
import type { UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.",
  "byselapuix.com",
  "mp4upload.com",
  "mega.nz",
  "streamtape.",
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
  "streamwish.",
  "filemoon.",
  "sfastwish.com",
  "vidhidevip.com",
  "mdbekjwqa.pw",
  "d-s.io",
  "hlswish.com",
  "goodstream.one",
  "playmudos.com",
];

const isKnownEmbed = (url: string) =>
  KNOWN_EMBED_HOSTS.some((h) => url.toLowerCase().includes(h));
const isDirectMedia = (url: string) => /\.(m3u8|mp4|webm)(\?|$)/i.test(url);

describe("AnimeFlvOrAt - integración real contra animeflv.or.at (WordPress clone)", () => {
  const adapter = new AnimeFlvAdapter();
  let catalogResult: UniversalAnalysisResult | null = null;
  let detailResult: UniversalAnalysisResult | null = null;
  let detailUrl = "";
  let allStreams: string[] = [];

  it(
    "catálogo: analyze(/anime/page/1/, 'catalog') -> >= 10 items con title+url+image_url",
    async () => {
      catalogResult = await adapter.analyze(
        "https://animeflv.or.at/anime/page/1/",
        "catalog"
      );
      console.log(
        `[catalog] page_type=${catalogResult.page_type} title="${catalogResult.title}" items=${catalogResult.catalog_items.length}`
      );

      expect(catalogResult.page_type).toBe("catalog");
      expect(catalogResult.content_type).toBe("anime");
      expect(catalogResult.catalog_items.length).toBeGreaterThanOrEqual(10);

      for (const item of catalogResult.catalog_items.slice(0, 5)) {
        console.log(`  "${item.title}" -> ${item.url} img=${item.image_url ? "yes" : "no"}`);
        expect(item.title.length).toBeGreaterThan(1);
        expect(item.url.startsWith("http")).toBe(true);
      }

      const withImages = catalogResult.catalog_items.filter((i) => i.image_url);
      console.log(`  items con imagen: ${withImages.length}/${catalogResult.catalog_items.length}`);
      expect(withImages.length).toBeGreaterThanOrEqual(5);
    },
    240000
  );

  it(
    "detalle: analiza un anime del catálogo -> title, poster_url, episodes >= 1",
    async () => {
      if (!catalogResult || catalogResult.catalog_items.length === 0) {
        catalogResult = await adapter.analyze(
          "https://animeflv.or.at/anime/page/1/",
          "catalog"
        );
      }
      expect(catalogResult!.catalog_items.length).toBeGreaterThan(0);

      detailUrl = catalogResult!.catalog_items[0].url;
      console.log(`[detail] URL: ${detailUrl}`);

      detailResult = await adapter.analyze(detailUrl, "detail");
      console.log(
        `[detail] page_type=${detailResult.page_type} title="${detailResult.title}" poster=${detailResult.poster_url}`
      );
      console.log(
        `[detail] description: ${(detailResult.description || "").slice(0, 120)}...`
      );
      console.log(`[detail] genres: ${detailResult.genres.join(", ")}`);
      console.log(`[detail] rating: ${detailResult.rating}`);
      console.log(`[detail] episodes: ${detailResult.episodes.length}`);

      expect(detailResult.content_type).toBe("anime");
      expect(detailResult.title.length).toBeGreaterThan(1);
      expect(detailResult.poster_url).toBeTruthy();
      expect(detailResult.episodes.length).toBeGreaterThanOrEqual(1);

      for (const ep of detailResult.episodes.slice(0, 3)) {
        console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
        expect(ep.url.startsWith("http")).toBe(true);
        expect(ep.number).toBeGreaterThan(0);
      }
    },
    240000
  );

  it(
    "extractStream(episodes[0].url) -> >= 1 stream (zona WP decode + embed conocido)",
    async () => {
      if (!detailResult || detailResult.episodes.length === 0) {
        if (!detailUrl) {
          const cat = await adapter.analyze("https://animeflv.or.at/anime/page/1/", "catalog");
          detailUrl = cat.catalog_items[0].url;
        }
        detailResult = await adapter.analyze(detailUrl, "detail");
      }
      expect(detailResult!.episodes.length).toBeGreaterThanOrEqual(1);

      const episodeUrl = detailResult!.episodes[0].url;
      console.log(`[stream] extractStream de: ${episodeUrl}`);

      const stream = await adapter.extractStream(episodeUrl);
      allStreams = stream.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
      console.log(`[stream] stream_url: ${stream.stream_url}`);
      console.log(`[stream] all_available_streams (${allStreams.length}):`);
      for (const s of allStreams.slice(0, 10)) console.log(`  * ${s}`);

      expect(allStreams.length).toBeGreaterThanOrEqual(1);

      const hasKnown = allStreams.some(isKnownEmbed);
      const hasDirect = allStreams.some(isDirectMedia);
      console.log(`[stream] hasKnown=${hasKnown} hasDirect=${hasDirect}`);
      expect(hasKnown || hasDirect).toBe(true);
    },
    240000
  );

  it(
    "anti-403: GET 1-2 URLs con UA Chrome + Referer animeflv.or.at -> <400 o host conocido",
    async () => {
      if (allStreams.length === 0 && detailResult && detailResult.episodes.length > 0) {
        const stream = await adapter.extractStream(detailResult.episodes[0].url);
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
              Referer: "https://animeflv.or.at/",
              Accept: "*/*",
            },
          });
          console.log(`[403] GET ${url.slice(0, 90)} -> ${res.status}`);
          if (res.status < 400) {
            anyOk = true;
            break;
          }
        } catch (e) {
          console.log(
            `[403] GET ${url.slice(0, 90)} -> EXCEPCIÓN ${(e as Error).message?.slice(0, 80)}`
          );
        }
      }

      console.log(`[403] anyOk=${anyOk} anyKnown=${anyKnown}`);
      expect(anyOk || anyKnown).toBe(true);
    },
    240000
  );
});
