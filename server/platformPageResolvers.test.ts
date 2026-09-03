import { describe, it, expect, vi } from "vitest";
import {
  isPlatformPageUrl,
  isLaMoviePageUrl,
  isCinecalidadPageUrl,
  isTioPlusPageUrl,
  resolvePlatformPage,
  resolveLaMoviePage,
  resolveCinecalidadPage,
  resolveTioPlusPage,
  checkExpiredDirectStream,
} from "./platformPageResolvers";
import { EmbedResolvers, providerResolverRegistry } from "./resolvers";

describe("Platform Page Resolvers (LaMovie, CineCalidad, TioPlus)", () => {
  describe("URL Pattern Matching & Registry Dispatch", () => {
    it("identifies LaMovie canonical pages across supported domains", () => {
      expect(isLaMoviePageUrl("https://lamovie.org/peliculas/bolt/")).toBe(true);
      expect(isLaMoviePageUrl("https://lamovie.to/series/breaking-bad/")).toBe(true);
      expect(isLaMoviePageUrl("https://lamovie.ws/animes/naruto/")).toBe(true);
      expect(isPlatformPageUrl("https://lamovie.org/peliculas/interstellar/")).toBe(true);
    });

    it("identifies CineCalidad canonical pages across supported domains", () => {
      expect(isCinecalidadPageUrl("https://www.cinecalidad.am/ver-pelicula/thunderbolts/")).toBe(true);
      expect(isCinecalidadPageUrl("https://cinecalidad.mx/pelicula/moana-2/")).toBe(true);
      expect(isCinecalidadPageUrl("https://cinecalidad.im/ver-pelicula/gladiator-2/")).toBe(true);
      expect(isPlatformPageUrl("https://www.cinecalidad.am/ver-pelicula/thunderbolts/")).toBe(true);
    });

    it("identifies TioPlus canonical pages across supported domains", () => {
      expect(isTioPlusPageUrl("https://tioplus.app/pelicula/avatar/")).toBe(true);
      expect(isTioPlusPageUrl("https://www.tioplus.app/peliculas/sonic-3/")).toBe(true);
      expect(isPlatformPageUrl("https://tioplus.app/pelicula/avatar/")).toBe(true);
    });

    it("does not classify direct media URLs as platform pages", () => {
      expect(isPlatformPageUrl("https://lamovie.org/stream.m3u8")).toBe(false);
      expect(isPlatformPageUrl("https://www.cinecalidad.am/video.mp4")).toBe(false);
      expect(isPlatformPageUrl("https://tioplus.app/media.webm")).toBe(false);
    });

    it("finds specific ProviderResolver in providerResolverRegistry instead of GenericHtml", () => {
      const lamovieResolver = providerResolverRegistry.findResolver("https://lamovie.org/peliculas/bolt/");
      expect(lamovieResolver).toBeDefined();
      expect(lamovieResolver?.name).toBe("LaMovie");

      const cinecalidadResolver = providerResolverRegistry.findResolver("https://www.cinecalidad.am/ver-pelicula/thunderbolts/");
      expect(cinecalidadResolver).toBeDefined();
      expect(cinecalidadResolver?.name).toBe("Cinecalidad");

      const tioplusResolver = providerResolverRegistry.findResolver("https://tioplus.app/pelicula/avatar/");
      expect(tioplusResolver).toBeDefined();
      expect(tioplusResolver?.name).toBe("TioPlus");
    });
  });

  describe("LaMovie page -> stream resoluble", () => {
    it("resolves LaMovie canonical page to a complete PlaybackResolution", async () => {
      const canonicalUrl = "https://lamovie.org/peliculas/bolt/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: "https://cdn.example.com/hls/bolt/master.m3u8",
        all_available_streams: [
          "https://cdn.example.com/hls/bolt/master.m3u8",
          "https://mega.nz/embed/!abc!key",
        ],
        title: "Bolt (2008)",
      });

      const res = await resolveLaMoviePage(canonicalUrl, {
        streamExtractor: mockExtractor,
        now: () => 1700000000000,
      });

      expect(mockExtractor).toHaveBeenCalledWith(canonicalUrl);
      expect(res.resolved).toBe(true);
      expect(res.provider).toBe("LaMovie");
      expect(res.url).toBe("https://cdn.example.com/hls/bolt/master.m3u8");
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.type).toBe("direct");
      expect(["direct", "direct_trial", "proxy_required"]).toContain(res.delivery_mode);
      expect(res.is_proxyable).toBe(true);
      expect(res.is_refreshable).toBe(true);
      expect(typeof res.expires_at).toBe("number");
      expect(typeof res.refresh_after).toBe("number");
      expect(res.expires_at).toBeGreaterThan(1700000000000);
      expect(res.failure_reason).toBeUndefined();
    });

    it("resolves LaMovie canonical page via EmbedResolvers.resolveWithMeta", async () => {
      const canonicalUrl = "https://lamovie.org/peliculas/interstellar/";
      // Mocking fetch or extractor for JIT resolver
      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: async () => ({
          stream_url: "https://stream.lamovie-cdn.net/hls/interstellar.m3u8",
          all_available_streams: ["https://stream.lamovie-cdn.net/hls/interstellar.m3u8"],
          title: "Interstellar",
        }),
      });

      expect(res.resolved).toBe(true);
      expect(res.provider).toBe("LaMovie");
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.url).toBe("https://stream.lamovie-cdn.net/hls/interstellar.m3u8");
      expect(res.is_refreshable).toBe(true);
    });
  });

  describe("CineCalidad page -> stream resoluble", () => {
    it("resolves CineCalidad page and selects best stream among multiple servers", async () => {
      const canonicalUrl = "https://www.cinecalidad.am/ver-pelicula/thunderbolts/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: "https://dead-provider.voe.sx/e/123", // Dead provider
        all_available_streams: [
          "https://dead-provider.voe.sx/e/123",
          canonicalUrl, // Self reference (not a stream)
          "https://enc1.goodstream.one/hls2/thunderbolts/master.m3u8", // High quality HLS
          "https://cdn.example.com/trailer_sample_5mb.mp4", // Placeholder
        ],
        title: "Thunderbolts",
      });

      const res = await resolveCinecalidadPage(canonicalUrl, {
        streamExtractor: mockExtractor,
        now: () => 1700000000000,
      });

      expect(res.resolved).toBe(true);
      expect(res.provider).toBe("Cinecalidad");
      expect(res.url).toBe("https://enc1.goodstream.one/hls2/thunderbolts/master.m3u8");
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.type).toBe("direct");
      expect(res.is_proxyable).toBe(true);
      expect(res.is_refreshable).toBe(true);
      expect(res.failure_reason).toBeUndefined();
    });
  });

  describe("TioPlus page -> stream resoluble", () => {
    it("resolves TioPlus canonical page to playable direct stream", async () => {
      const canonicalUrl = "https://tioplus.app/pelicula/avatar/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: "https://media.tioplus.net/direct/avatar.mp4",
        all_available_streams: [
          "https://media.tioplus.net/direct/avatar.mp4",
          "https://mega.nz/embed/!avatar!key",
        ],
        title: "Avatar",
      });

      const res = await resolveTioPlusPage(canonicalUrl, {
        streamExtractor: mockExtractor,
        now: () => 1700000000000,
      });

      expect(res.resolved).toBe(true);
      expect(res.provider).toBe("TioPlus");
      expect(res.url).toBe("https://media.tioplus.net/direct/avatar.mp4");
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.type).toBe("direct");
      expect(res.delivery_mode).toBe("direct_trial");
      expect(res.is_proxyable).toBe(true);
      expect(res.is_refreshable).toBe(true);
      expect(res.failure_reason).toBeUndefined();
    });
  });

  describe("HLS firmado vencido -> expired_without_locator", () => {
    it("returns expired_without_locator for direct signed HLS without locator", async () => {
      // Past expiry timestamp (e.g. 1500000000 = year 2017)
      const expiredHls = "https://cdn.example.com/hls/vod.m3u8?expires=1650000000";

      // Test via checkExpiredDirectStream
      const directCheck = checkExpiredDirectStream(expiredHls);
      expect(directCheck).not.toBeNull();
      expect(directCheck?.resolved).toBe(false);
      expect(directCheck?.failure_reason).toBe("expired_without_locator");
      expect(directCheck?.canonical_locator).toBeUndefined();
      expect(directCheck?.is_refreshable).toBe(false);
      expect(directCheck?.is_proxyable).toBe(false);
      expect(directCheck?.delivery_mode).toBe("embed");

      // Test via EmbedResolvers.resolveWithMeta
      const meta = await EmbedResolvers.resolveWithMeta(expiredHls);
      expect(meta.resolved).toBe(false);
      expect(meta.failure_reason).toBe("expired_without_locator");
      expect(meta.canonical_locator).toBeUndefined();
      expect(meta.is_refreshable).toBe(false);
      expect(meta.is_proxyable).toBe(false);
      expect(meta.delivery_mode).toBe("embed");
    });

    it("returns expired_without_locator with exp parameter in query", async () => {
      const expiredHls = "https://stream.server.org/master.m3u8?exp=1600000000";
      const meta = await EmbedResolvers.resolveWithMeta(expiredHls);
      expect(meta.resolved).toBe(false);
      expect(meta.failure_reason).toBe("expired_without_locator");
      expect(meta.canonical_locator).toBeUndefined();
      expect(meta.is_refreshable).toBe(false);
    });
  });

  describe("página no resoluble -> unresolved, nunca éxito falso", () => {
    it("returns unresolved if extraction returns no streams", async () => {
      const canonicalUrl = "https://lamovie.org/peliculas/broken-page/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: "",
        all_available_streams: [],
      });

      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: mockExtractor,
      });

      expect(res.resolved).toBe(false);
      expect(res.failure_reason).toBe("unresolved");
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.is_proxyable).toBe(false);
      expect(res.is_refreshable).toBe(false);
      expect(res.delivery_mode).toBe("embed");
      expect(res.type).toBe("embed");
    });

    it("returns unresolved if extractor returns only the original canonical page itself", async () => {
      const canonicalUrl = "https://www.cinecalidad.am/ver-pelicula/non-existent/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: canonicalUrl,
        all_available_streams: [canonicalUrl],
      });

      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: mockExtractor,
      });

      // Must NEVER be converted into a false successful embed
      expect(res.resolved).toBe(false);
      expect(res.failure_reason).toBe("unresolved");
      expect(res.is_proxyable).toBe(false);
      expect(res.is_refreshable).toBe(false);
      expect(res.delivery_mode).toBe("embed");
    });

    it("returns unresolved if extractor throws an exception", async () => {
      const canonicalUrl = "https://tioplus.app/pelicula/server-error/";
      const mockExtractor = vi.fn().mockRejectedValue(new Error("Network timeout"));

      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: mockExtractor,
      });

      expect(res.resolved).toBe(false);
      expect(res.failure_reason).toBe("unresolved");
      expect(res.is_proxyable).toBe(false);
      expect(res.is_refreshable).toBe(false);
      expect(res.delivery_mode).toBe("embed");
    });

    it("returns unresolved if all available streams are expired or dead providers", async () => {
      const canonicalUrl = "https://lamovie.org/peliculas/all-dead/";
      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: "https://voe.sx/e/dead",
        all_available_streams: [
          "https://voe.sx/e/dead",
          "https://cdn.example.com/old.m3u8?expires=1650000000",
          "https://host.com/big_buck_bunny_5mb.mp4",
        ],
      });

      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: mockExtractor,
      });

      expect(res.resolved).toBe(false);
      expect(res.failure_reason).toBe("unresolved");
    });
  });

  describe("Multi-server selection & canonical locator preservation", () => {
    it("skips expired direct streams and selects valid server while preserving canonical_locator", async () => {
      const canonicalUrl = "https://lamovie.org/peliculas/multi-server/";
      const validHls = "https://cdn.example.com/valid/master.m3u8";
      const expiredHls = "https://cdn.example.com/expired/stream.m3u8?expires=1650000000";

      const mockExtractor = vi.fn().mockResolvedValue({
        stream_url: expiredHls, // Default stream was expired
        all_available_streams: [
          expiredHls,
          validHls, // Alternative server is valid
          "https://mega.nz/embed/!test!key",
        ],
      });

      const res = await resolvePlatformPage(canonicalUrl, {
        streamExtractor: mockExtractor,
        now: () => 1700000000000,
      });

      expect(res.resolved).toBe(true);
      expect(res.url).toBe(validHls);
      expect(res.canonical_locator).toBe(canonicalUrl);
      expect(res.original_url).toBe(canonicalUrl);
      expect(res.is_refreshable).toBe(true);
    });
  });
});
