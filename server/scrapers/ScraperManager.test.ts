import { describe, it, expect } from "vitest";
import { ScraperManager } from "./ScraperManager";
import { BaseScraperAdapter } from "./BaseAdapter";
import { UniversalAnalysisResult } from "../types";

describe("ScraperManager (Hybrid Strategy Pattern)", () => {
  const manager = ScraperManager.getInstance();

  it("resolves DirectStreamAdapter for direct stream files (.m3u8, .mp4, mux.dev)", () => {
    const adapter1 = manager.getAdapter("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
    expect(adapter1.id).toBe("direct_stream");

    const adapter2 = manager.getAdapter("https://example.com/video.mp4");
    expect(adapter2.id).toBe("direct_stream");

    const adapter3 = manager.getAdapter("https://commondatastorage.googleapis.com/sample.webm");
    expect(adapter3.id).toBe("direct_stream");
  });

  it("resolves ArchiveOrgAdapter for archive.org URLs", () => {
    const adapter = manager.getAdapter("https://archive.org/details/night_of_the_living_dead");
    expect(adapter.id).toBe("archive_org");
  });

  it("resolves TvMazeAdapter for tvmaze.com URLs", () => {
    const adapter = manager.getAdapter("https://www.tvmaze.com/shows/169/breaking-bad");
    expect(adapter.id).toBe("tvmaze");
  });

  it("resolves AnimeFlvAdapter for animeflv and jkanime URLs", () => {
    const adapter1 = manager.getAdapter("https://www3.animeflv.net/anime/sousou-no-frieren");
    expect(adapter1.id).toBe("animeflv");

    const adapter2 = manager.getAdapter("https://jkanime.net/one-piece");
    expect(adapter2.id).toBe("animeflv");
  });

  it("resolves GenericAdapter for unhandled / generic websites", () => {
    const adapter = manager.getAdapter("https://cuevana.biz/pelicula/oppenheimer");
    expect(adapter.id).toBe("generic");
  });

  it("respects explicit adapter selection via adapter id", () => {
    const adapter = manager.getAdapter("https://some-custom-url.com", "animeflv");
    expect(adapter.id).toBe("animeflv");
  });

  it("lists all available adapters", () => {
    const adapters = manager.getAvailableAdapters();
    expect(adapters.length).toBeGreaterThanOrEqual(5);
    expect(adapters.some((a) => a.id === "direct_stream")).toBe(true);
    expect(adapters.some((a) => a.id === "archive_org")).toBe(true);
    expect(adapters.some((a) => a.id === "tvmaze")).toBe(true);
    expect(adapters.some((a) => a.id === "animeflv")).toBe(true);
    expect(adapters.some((a) => a.id === "generic")).toBe(true);
  });

  it("allows registering dynamic custom adapters", () => {
    class CustomMockAdapter extends BaseScraperAdapter {
      readonly id = "custom_test";
      readonly name = "Custom Test Adapter";
      readonly supportedDomains = ["testdomain.com"];

      canHandle(url: string): boolean {
        return url.includes("testdomain.com");
      }

      async analyze(url: string): Promise<UniversalAnalysisResult> {
        return {
          page_type: "detail",
          content_type: "movie",
          title: "Custom Movie",
          description: "Test",
          poster_url: null,
          banner_url: null,
          rating: 9.0,
          year: 2025,
          status: "Test",
          genres: ["Custom"],
          detected_streams: ["https://testdomain.com/stream.m3u8"],
          episodes: [],
          catalog_items: [],
        };
      }
    }

    manager.registerAdapter(new CustomMockAdapter());
    const matched = manager.getAdapter("https://testdomain.com/watch/123");
    expect(matched.id).toBe("custom_test");
  });
});
