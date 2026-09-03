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

    const adapter3 = manager.getAdapter("https://animeflv.or.am/anime/one-piece");
    expect(adapter3.id).toBe("animeflv");
  });

  it("resolves HiAnimesAdapter for hianimes.se URLs", () => {
    const adapter = manager.getAdapter("https://hianimes.se/details/your-name.-wdzkfy");
    expect(adapter.id).toBe("hianimes");
  });


  it("resolves LaMovieAdapter for lamovie.org URLs", () => {
    const adapter1 = manager.getAdapter("https://lamovie.org/peliculas?page=2");
    expect(adapter1.id).toBe("lamovie");

    const adapter2 = manager.getAdapter("https://lamovie.org/series/ally-mcbeal-1997/");
    expect(adapter2.id).toBe("lamovie");
  });

  it("resolves TioAnimeAdapter for tioanime.com URLs", () => {
    const adapter = manager.getAdapter("https://tioanime.com/anime/naruto");
    expect(adapter.id).toBe("tioanime");
  });

  it("resolves TioPlusAdapter for tioplus.app URLs", () => {
    const adapter = manager.getAdapter("https://tioplus.app/serie/supergirl/season/1/episode/1");
    expect(adapter.id).toBe("tioplus");
  });

  it("resolves TubePelisAdapter for tubepelis.com URLs", () => {
    const adapter = manager.getAdapter("https://tubepelis.com/pelicula/4603/spider-man-un-nuevo-dia.html");
    expect(adapter.id).toBe("tubepelis");
  });

  it("resolves CinecalidadAdapter for cinecalidad URLs", () => {
    const adapter = manager.getAdapter("https://cinecalidad.am/pelicula/ejemplo.html");
    expect(adapter.id).toBe("cinecalidad");
  });

  it("resolves VerAnimesAdapter for veranimes.net URLs", () => {
    const adapter = manager.getAdapter("https://wwv.veranimes.net/anime/naruto");
    expect(adapter.id).toBe("veranimes");
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
    expect(adapters.length).toBeGreaterThanOrEqual(11);
    expect(adapters.some((a) => a.id === "direct_stream")).toBe(true);
    expect(adapters.some((a) => a.id === "archive_org")).toBe(true);
    expect(adapters.some((a) => a.id === "tvmaze")).toBe(true);
    expect(adapters.some((a) => a.id === "animeflv")).toBe(true);
    expect(adapters.some((a) => a.id === "lamovie")).toBe(true);
    expect(adapters.some((a) => a.id === "latanime")).toBe(true);
    expect(adapters.some((a) => a.id === "tioanime")).toBe(true);
    expect(adapters.some((a) => a.id === "tioplus")).toBe(true);
    expect(adapters.some((a) => a.id === "tubepelis")).toBe(true);
    expect(adapters.some((a) => a.id === "cinecalidad")).toBe(true);
    expect(adapters.some((a) => a.id === "veranimes")).toBe(true);
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
