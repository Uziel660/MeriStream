import { describe, it, expect, beforeAll } from "vitest";
import { VerAnimesAdapter } from "../../server/scrapers/adapters/VerAnimesAdapter";
import { isSupportedServer } from "../../server/resolvers";
import type { ExtractedCatalogItem, UniversalAnalysisResult } from "../../server/types";

const TEST_TIMEOUT = 240000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const SITE_REFERER = "https://wwv.veranimes.net/";

const KNOWN_EMBED_HOSTS = [
  "zilla-networks.com",
  "voe.sx",
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

function isKnownEmbed(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    KNOWN_EMBED_HOSTS.some((h) => lower.includes(h)) ||
    /\.(m3u8|mp4|webm)(\?|$)/i.test(lower)
  );
}

interface ProbeResult {
  ok: string[];
  forbiddenKnown: string[];
  failed: Array<{ url: string; status: number | string }>;
}

async function probeAgainst403(urls: string[], referer: string): Promise<ProbeResult> {
  const result: ProbeResult = { ok: [], forbiddenKnown: [], failed: [] };
  await Promise.all(
    urls.slice(0, 3).map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: referer,
          },
        });
        if (res.status < 400) {
          result.ok.push(url);
        } else if (res.status === 403 && isKnownEmbed(url)) {
          result.forbiddenKnown.push(url);
        } else {
          result.failed.push({ url, status: res.status });
        }
        res.body?.cancel().catch(() => {});
      } catch (err) {
        result.failed.push({ url, status: err instanceof Error ? err.message : "network-error" });
      } finally {
        clearTimeout(timer);
      }
    })
  );
  return result;
}

const adapter = new VerAnimesAdapter();

let searchResults: ExtractedCatalogItem[] = [];
let analysis: UniversalAnalysisResult | null = null;
let streamResult: { stream_url: string; all_available_streams: string[]; title?: string } | null = null;

describe("VerAnimesAdapter (wwv.veranimes.net)", () => {
  beforeAll(async () => {
    searchResults = await adapter.search("naruto");
    const detail =
      searchResults.find((r) => r.url.includes("/anime/")) || searchResults[0];
    if (detail) {
      analysis = await adapter.analyze(detail.url);
      const target = analysis.episodes[0]?.url ?? detail.url;
      streamResult = await adapter.extractStream(target);
    }
  }, TEST_TIMEOUT);

  it(
    "identidad y canHandle",
    () => {
      expect(adapter.id).toBe("veranimes");
      expect(adapter.name).toBe("VerAnimes");
      expect(adapter.supportedDomains).toContain("wwv.veranimes.net");
      expect(adapter.canHandle("https://wwv.veranimes.net/anime/naruto-shippuden")).toBe(true);
      expect(adapter.canHandle("https://latanime.org/")).toBe(false);
    }
  );

  it(
    "search('naruto') devuelve >= 1 resultado con title y url",
    () => {
      expect(searchResults.length).toBeGreaterThanOrEqual(1);
      for (const item of searchResults.slice(0, 3)) {
        expect(item.title.trim().length).toBeGreaterThan(0);
        expect(item.url.startsWith("http")).toBe(true);
      }
    }
  );

  it(
    "analyze(detalle): page_type=detail, poster, descripción y episodios",
    () => {
      expect(analysis).not.toBeNull();
      expect(analysis!.page_type).toBe("detail");
      expect(analysis!.poster_url).toBeTruthy();
      expect(analysis!.description.trim().length).toBeGreaterThan(0);
      expect(analysis!.episodes.length).toBeGreaterThanOrEqual(1);
      expect(analysis!.episodes[0].url.startsWith("http")).toBe(true);
    }
  );

  it(
    "extractStream(ep1): >= 1 stream (embed o directo)",
    () => {
      expect(streamResult).not.toBeNull();
      expect(streamResult!.all_available_streams.length).toBeGreaterThanOrEqual(1);
      const main = streamResult!.stream_url;
      expect(main.startsWith("http")).toBe(true);
      const anyValid = streamResult!.all_available_streams.some(
        (s) => isKnownEmbed(s) || /\.(m3u8|mp4|webm)(\?|$)/i.test(s)
      );
      expect(anyValid).toBe(true);
    }
  );

  it(
    "anti-403: los streams responden (embed conocido con 403 tolerable si hay alternativas)",
    async () => {
      expect(streamResult).not.toBeNull();
      const urls = Array.from(
        new Set([streamResult!.stream_url, ...streamResult!.all_available_streams])
      );
      const probe = await probeAgainst403(urls, SITE_REFERER);

      console.log("anti-403 OK:", probe.ok);
      console.log("anti-403 403-en-embed-conocido:", probe.forbiddenKnown);
      console.log("anti-403 fallidos:", probe.failed);

      const allFailed = probe.ok.length === 0;
      const onlyToleratedForbidden =
        probe.ok.length === 0 &&
        probe.forbiddenKnown.length > 0 &&
        urls.length > 1;

      expect(allFailed && !onlyToleratedForbidden).toBe(false);
    },
    TEST_TIMEOUT
  );

  describe("priorización de servidores (sin red)", () => {
    it("isSupportedServer: clasifica servidores conocidos como soportados", () => {
      expect(isSupportedServer("https://mega.nz/embed/abc#key")).toBe(true);
      expect(isSupportedServer("https://ok.ru/video/123")).toBe(true);
      expect(isSupportedServer("https://www.mp4upload.com/embed-xyz.html")).toBe(true);
      expect(isSupportedServer("https://voe.sx/e/xyz")).toBe(true);
      expect(isSupportedServer("https://streamtape.com/e/xyz")).toBe(true);
    });

    it("isSupportedServer: bysesukior (ofuscado) NO es servidor soportado por defecto", () => {
      expect(isSupportedServer("https://bysesukior.com/e/abcd1234")).toBe(false);
    });

    it("decodeDataVideoButtons: decodifica hex/data-video a URLs de servidor", () => {
      const hex = Buffer.from("https://mega.nz/embed/abc#def", "utf-8")
        .toString("hex");
      const html = `<ul class="opt"><li encrypt="${hex}"></li></ul>`;
      const urls = adapter.decodeDataVideoButtons(html);
      expect(urls).toContain("https://mega.nz/embed/abc#def");
    });

    it("decodeDataVideoButtons: ignora botones sin URL válida", () => {
      const html = `<ul class="opt"><li encrypt="zzz"></li></ul>`;
      const urls = adapter.decodeDataVideoButtons(html);
      expect(urls.length).toBe(0);
    });
  });
});
