import { describe, it, expect } from "vitest";
import { AnimeFlvAdapter } from "../../server/scrapers/adapters/AnimeFlvAdapter";
import type { UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

describe("AnimeFlvAdapter - integración real contra www3.animeflv.net + jkanime.net", () => {
  const adapter = new AnimeFlvAdapter();
  let analysis: UniversalAnalysisResult | null = null;
  let allStreams: string[] = [];

  it(
    "analyze(anime/sousou-no-frieren, 'detail') -> content_type anime, poster, descripción y >= 10 episodios",
    async () => {
      analysis = await adapter.analyze(
        "https://www3.animeflv.net/anime/sousou-no-frieren",
        "detail"
      );
      console.log(
        `page_type=${analysis.page_type} title="${analysis.title}" poster=${analysis.poster_url}`
      );
      console.log(
        `description: ${(analysis.description || "").slice(0, 100)}... episodes=${analysis.episodes.length}`
      );

      expect(analysis.content_type).toBe("anime");
      expect(analysis.poster_url).toBeTruthy();
      expect((analysis.description || "").length).toBeGreaterThan(20);
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(10);

      const uniqueUrls = new Set(analysis.episodes.map((e) => e.url));
      expect(uniqueUrls.size).toBe(analysis.episodes.length);
      for (const ep of analysis.episodes.slice(0, 3)) {
        console.log(`  ep #${ep.number} "${ep.title}" -> ${ep.url}`);
        expect(ep.url.startsWith("http")).toBe(true);
        expect(ep.number).toBeGreaterThan(0);
      }
    },
    240000
  );

  it(
    "extractStream(episodes[0].url) -> >= 1 stream (embed conocido o directo); URLs rotas normalizadas",
    async () => {
      if (!analysis || analysis.episodes.length === 0) {
        analysis = await adapter.analyze(
          "https://www3.animeflv.net/anime/sousou-no-frieren",
          "detail"
        );
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

      // REGLA DE ORO: embed conocido o stream directo cuentan como éxito
      const hasKnown = allStreams.some(isKnownEmbed);
      const hasDirect = allStreams.some(isDirectMedia);
      expect(hasKnown || hasDirect).toBe(true);

      // Normalización de URLs rotas conocidas
      for (const s of allStreams) {
        if (s.includes("mega.nz")) expect(s.includes("/embed/") || s.includes("/file/")).toBe(true);
        if (s.includes("yourupload.com")) expect(s.includes("/embed/") || s.includes("/watch/")).toBe(true);
        if (s.includes("streamtape.com")) expect(!s.includes("/v/")).toBe(true);
      }
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
              Referer: "https://www3.animeflv.net/",
              Accept: "*/*",
            },
          });
          console.log(`GET ${url.slice(0, 90)} -> ${res.status}`);
          if (res.status < 400) {
            anyOk = true;
            break;
          }
          // 403 en embed conocido es tolerable si existe otra opción válida
        } catch (e) {
          console.log(
            `GET ${url.slice(0, 90)} -> EXCEPCIÓN ${(e as Error).message?.slice(0, 80)}`
          );
        }
      }

      console.log(`anyOk=${anyOk} anyKnown=${anyKnown}`);
      // Falla solo si TODO falla sin ningún host conocido
      expect(anyOk || anyKnown).toBe(true);
    },
    240000
  );

  it(
    "[variante jkanime.net] analyze(one-piece) con episodios reales y extractStream funcional",
    async () => {
      const jkAnalysis = await adapter.analyze("https://jkanime.net/one-piece/", "detail");
      console.log(
        `[jk] title="${jkAnalysis.title}" poster=${jkAnalysis.poster_url} episodes=${jkAnalysis.episodes.length}`
      );
      expect(jkAnalysis.content_type).toBe("anime");
      expect(jkAnalysis.poster_url).toBeTruthy();
      expect(jkAnalysis.episodes.length).toBeGreaterThanOrEqual(10);

      const ep1 =
        jkAnalysis.episodes.find((e) => Number(e.number) === 1) ?? jkAnalysis.episodes[0];
      console.log(`[jk] extractStream de: #${ep1.number} ${ep1.url}`);

      const stream = await adapter.extractStream(ep1.url);
      const streams = stream.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
      console.log(`[jk] stream_url: ${stream.stream_url}`);
      for (const s of streams.slice(0, 10)) console.log(`  * ${s}`);

      expect(streams.length).toBeGreaterThanOrEqual(1);
      expect(streams.some(isKnownEmbed) || streams.some(isDirectMedia)).toBe(true);

      let ok = false;
      for (const url of streams.slice(0, 3)) {
        try {
          const res = await fetch(url, {
            redirect: "follow",
            headers: { "User-Agent": UA_CHROME, Referer: "https://jkanime.net/", Accept: "*/*" },
          });
          console.log(`[jk] GET ${url.slice(0, 90)} -> ${res.status}`);
          if (res.status < 400) {
            ok = true;
            break;
          }
        } catch {
          /* siguiente candidato */
        }
      }
      expect(ok || streams.some(isKnownEmbed)).toBe(true);
    },
    240000
  );
});
