import { describe, it, expect } from "vitest";
import { AnimeFlvAdapter } from "../../server/scrapers/adapters/AnimeFlvAdapter";
import type { UniversalAnalysisResult } from "../../server/types";

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Hosts conocidos (subset) solo para aserciones auxiliares; el éxito real exige directo .m3u8/.mp4
const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.",
  "byselapuix.com",
  "mp4upload.com",
  "mega.nz",
  "sfastwish.com",
  "vidhidevip.com",
  "vidmoly.",
  "streamhide.",
  "playmudos.com",
  "hlswish.com",
];
const isKnownEmbed = (url: string) => KNOWN_EMBED_HOSTS.some((h) => url.toLowerCase().includes(h));
const isDirectMedia = (url: string) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url) || /\/m3u8\//i.test(url);

/**
 * Integración live JKAnime (www3.animeflv.net obsoleto: 521/fallback vacío).
 * Flujo vigente verificado hoy E2E: búsqueda One Piece -> detalle -> episodio 1 -> HLS playmudos directo en Chromium.
 * No se acepta page URL, placeholder ni mero embed como éxito cuando existe directo reproducible.
 * No se hardcodean tokens HLS expirables: solo se valida patrón directo.
 */
describe("AnimeFlvAdapter - integración live JKAnime (animeflv.net obsoleto)", () => {
  const adapter = new AnimeFlvAdapter();

  // cache del flujo principal para encadenar pero cada test es re-ejecutable
  let detailAnalysis: UniversalAnalysisResult | null = null;
  let episodeUrl: string | null = null;

  it(
    "analyze(jkanime.net/one-piece) -> content_type anime, poster, >=10 episodios",
    async () => {
      // Reintento tolerante a flakiness de red (fetchHtml null -> fallback 1 episodio)
      for (let attempt = 1; attempt <= 3; attempt++) {
        detailAnalysis = await adapter.analyze("https://jkanime.net/one-piece/", "detail");
        console.log(`[jk detail intento ${attempt}] title="${detailAnalysis.title}" poster=${detailAnalysis.poster_url} episodes=${detailAnalysis.episodes.length}`);
        for (const ep of detailAnalysis.episodes.slice(0, 3)) console.log(`  ep #${ep.number} -> ${ep.url}`);
        if (detailAnalysis.episodes.length >= 10 && detailAnalysis.episodes.some((e) => e.url.includes("jkanime.net"))) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
      }

      expect(detailAnalysis!.content_type).toBe("anime");
      expect(detailAnalysis!.poster_url).toBeTruthy();
      expect((detailAnalysis!.description || "").length).toBeGreaterThan(20);
      expect(detailAnalysis!.episodes.length).toBeGreaterThanOrEqual(10);

      const uniqueUrls = new Set(detailAnalysis!.episodes.map((e) => e.url));
      expect(uniqueUrls.size).toBe(detailAnalysis!.episodes.length);
      for (const ep of detailAnalysis!.episodes.slice(0, 3)) {
        expect(ep.url.startsWith("http")).toBe(true);
        expect(ep.url).toContain("jkanime.net");
        expect(ep.number).toBeGreaterThan(0);
      }
      const ep1 = detailAnalysis!.episodes.find((e) => Number(e.number) === 1) ?? detailAnalysis!.episodes[0];
      episodeUrl = ep1.url;
    },
    90000
  );

  it(
    "extractStream(episodio 1 jkanime) -> stream directo .m3u8/.mp4, no page URL ni embed como único éxito",
    async () => {
      if (!detailAnalysis || !episodeUrl) {
        detailAnalysis = await adapter.analyze("https://jkanime.net/one-piece/", "detail");
        const ep1 = detailAnalysis.episodes.find((e) => Number(e.number) === 1) ?? detailAnalysis.episodes[0];
        episodeUrl = ep1.url;
      }
      expect(episodeUrl).toBeTruthy();
      console.log(`extractStream de: ${episodeUrl}`);

      // Reintento tolerante a flakiness transitorio (fetchHtml null -> fallback page URL)
      let extraction: Awaited<ReturnType<typeof adapter.extractStream>> | null = null;
      let allStreams: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        extraction = await adapter.extractStream(episodeUrl!);
        allStreams = extraction.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
        console.log(`[intento ${attempt}] stream_url: ${extraction.stream_url} (${allStreams.length} streams)`);
        for (const s of allStreams.slice(0, 6)) console.log(`  * ${s}`);
        if (allStreams.some(isDirectMedia) && isDirectMedia(extraction.stream_url)) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
      }
      expect(allStreams.length).toBeGreaterThanOrEqual(1);

      // No aceptar page URL / placeholder como éxito
      expect(extraction!.stream_url.trim().toLowerCase()).not.toBe(episodeUrl!.trim().toLowerCase());

      // Éxito real = directo .m3u8/.mp4 (E2E ya demuestra playmudos HLS); mero embed sin directo no cuenta
      const hasDirect = allStreams.some(isDirectMedia);
      expect(hasDirect, `debe incluir al menos un stream directo .m3u8/.mp4, recibido: ${allStreams.slice(0, 5).join(" | ")}`).toBe(true);

      // El stream principal debe ser directo, no un embed que falle en assertDirectStreamOrFail
      expect(isDirectMedia(extraction!.stream_url), `stream_url principal debe ser directo .m3u8/.mp4, recibido: ${extraction!.stream_url}`).toBe(true);

      // Tokens HLS no hardcodeados: validar patrón sin comparar token exacto
      const directOne = allStreams.find(isDirectMedia)!;
      expect(directOne).toMatch(/\.m3u8(\?|$)/i);

      // Normalización conocida aún válida
      for (const s of allStreams) {
        if (s.includes("mega.nz")) expect(s.includes("/embed/") || s.includes("/file/")).toBe(true);
        if (s.includes("yourupload.com")) expect(s.includes("/embed/") || s.includes("/watch/")).toBe(true);
        if (s.includes("streamtape.com")) expect(!s.includes("/v/")).toBe(true);
      }
    },
    120000
  );

  it(
    "flujo búsqueda One Piece -> detalle dinámico -> episodio 1 -> extractStream directo (búsqueda/ficha/episodio propio)",
    async () => {
      // Búsqueda vigente vía adaptador (usa fetchHtml con COMMON_HEADERS), sin depender de animeflv caído
      let hrefs: string[] = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          hrefs = await (adapter as any).searchJkanime("One Piece");
          if (hrefs.length > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 1200));
      }
      console.log(`[jk search] resultados: ${hrefs.slice(0, 3).join(" | ")}`);
      expect(hrefs.length, "búsqueda One Piece debe devolver al menos un anime").toBeGreaterThan(0);

      const detailUrl = hrefs.find((h: string) => h.toLowerCase().includes("one-piece")) ?? hrefs[0];
      console.log(`[jk search] detailUrl elegido: ${detailUrl}`);

      const analysis = await adapter.analyze(detailUrl, "detail");
      console.log(`[jk search] title="${analysis.title}" episodes=${analysis.episodes.length}`);
      expect(analysis.content_type).toBe("anime");
      expect(analysis.episodes.length).toBeGreaterThanOrEqual(1);

      const ep1 = analysis.episodes.find((e: any) => Number(e.number) === 1) ?? analysis.episodes[0];
      expect(ep1?.url, "episodio 1 debe tener URL http jkanime").toBeTruthy();
      expect(ep1.url).toMatch(/^https?:\/\/jkanime\.net\//i);
      console.log(`[jk search] episodeUrl: ${ep1.url}`);

      let extraction: Awaited<ReturnType<typeof adapter.extractStream>> | null = null;
      let streams: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        extraction = await adapter.extractStream(ep1.url);
        streams = extraction.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
        console.log(`[jk search intento ${attempt}] stream_url: ${extraction.stream_url}`);
        for (const s of streams.slice(0, 6)) console.log(`  * ${s}`);
        if (streams.some(isDirectMedia) && isDirectMedia(extraction.stream_url)) break;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
      }

      expect(streams.length).toBeGreaterThanOrEqual(1);
      expect(extraction!.stream_url.toLowerCase()).not.toBe(ep1.url.toLowerCase());
      expect(streams.some(isDirectMedia) || isDirectMedia(extraction!.stream_url), "flujo búsqueda debe culminar en directo .m3u8/.mp4").toBe(true);
      expect(isDirectMedia(extraction!.stream_url)).toBe(true);
    },
    120000
  );

  it(
    "probe: stream directo responde <400 (sin duplicar Playwright)",
    async () => {
      if (!episodeUrl) {
        const a = await adapter.analyze("https://jkanime.net/one-piece/", "detail");
        episodeUrl = (a.episodes.find((e) => Number(e.number) === 1) ?? a.episodes[0]).url;
      }
      // Reintento extractStream si flakiness previa
      let extraction: Awaited<ReturnType<typeof adapter.extractStream>> | null = null;
      let allStreams: string[] = [];
      for (let attempt = 1; attempt <= 3; attempt++) {
        extraction = await adapter.extractStream(episodeUrl!);
        allStreams = extraction.all_available_streams.filter((u) => /^https?:\/\//i.test(u));
        if (allStreams.some(isDirectMedia)) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
      expect(allStreams.length).toBeGreaterThanOrEqual(1);

      const directStreams = allStreams.filter(isDirectMedia);
      expect(directStreams.length, "debe existir al menos un directo para probe").toBeGreaterThan(0);

      let anyOk = false;
      for (const url of directStreams.slice(0, 3)) {
        try {
          const res = await fetch(url, {
            redirect: "follow",
            headers: { "User-Agent": UA_CHROME, Referer: "https://jkanime.net/", Accept: "*/*" },
          });
          console.log(`GET ${url.slice(0, 110)} -> ${res.status}`);
          if (res.status < 400) {
            anyOk = true;
            break;
          }
        } catch (e) {
          console.log(`GET ${url.slice(0, 110)} -> EXCEPCIÓN ${(e as Error).message?.slice(0, 80)}`);
        }
      }
      expect(anyOk, "al menos un directo .m3u8 debe responder <400").toBe(true);
    },
    60000
  );
});
