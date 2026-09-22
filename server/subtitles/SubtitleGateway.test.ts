import { describe, expect, it } from "vitest";
import { SubtitleGateway } from "./SubtitleGateway";
import type { SubtitleKind, SubtitleProvider } from "./types";

function provider(id: string, result: any[], delay = 0, kinds: readonly SubtitleKind[] = ["movie"]): SubtitleProvider {
  return { id, kinds, search: async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return result;
  }};
}

describe("SubtitleGateway", () => {
  it("keeps working when one provider times out", async () => {
    const gateway = new SubtitleGateway([
      provider("tvsubtitles", [], 50),
      provider("yify", [{ id: "fast", provider: "yify", language: "en", label: "English", sourceUrl: "https://www.yifysubtitles.ch/fast.srt" }]),
    ], { idResolver: { resolve: async () => "tt1234567", clear: () => {} } as any, providerTimeoutMs: 10 });
    const result = await gateway.search({ tmdbId: 1, kind: "movie", preferredLanguages: ["en"] });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].url).toMatch(/^\/api\/v1\/subtitles\/file\//);
  });

  it("queries eligible providers in parallel and returns health data", async () => {
    const gateway = new SubtitleGateway([
      provider("a", [{ id: "a", provider: "a", language: "es", label: "Español", sourceUrl: "https://subs5.strem.io/a.srt" }]),
      provider("b", [{ id: "b", provider: "b", language: "en", label: "English", sourceUrl: "https://subs5.strem.io/b.srt" }]),
    ], { idResolver: { resolve: async () => "tt1234567", clear: () => {} } as any });
    const result = await gateway.search({ tmdbId: 1, kind: "movie", preferredLanguages: ["es", "en"] });
    expect(result.providers.queried).toEqual(["a", "b"]);
    expect(Object.keys(gateway.healthSnapshot())).toEqual(["a", "b"]);
  });

  it("serves movie, series and anime through the same gateway contract", async () => {
    const gateway = new SubtitleGateway([
      provider("opensubtitles-v3", [{ id: "es", provider: "opensubtitles-v3", language: "es", label: "Español", sourceUrl: "https://subs5.strem.io/es.srt" }], 0, ["movie", "series", "anime"]),
      provider("tvsubtitles", [{ id: "tv-es", provider: "tvsubtitles", language: "es", label: "Español", sourceUrl: "https://www.tvsubtitles.net/files/show.zip" }], 0, ["series"]),
      provider("yify", [{ id: "en", provider: "yify", language: "en", label: "English", sourceUrl: "https://www.yifysubtitles.ch/subtitle/movie.zip" }], 0, ["movie"]),
    ], { idResolver: { resolve: async () => "tt1234567", clear: () => {} } as any });

    const movie = await gateway.search({ tmdbId: 1, kind: "movie", preferredLanguages: ["es", "en"] });
    const series = await gateway.search({ tmdbId: 2, kind: "series", season: 1, episode: 1, preferredLanguages: ["es", "en"] });
    const anime = await gateway.search({ tmdbId: 3, kind: "anime", season: 1, episode: 1, preferredLanguages: ["es", "en"] });

    expect(movie.tracks.length).toBeGreaterThan(0);
    expect(series.tracks.length).toBeGreaterThan(0);
    expect(anime.tracks.length).toBeGreaterThan(0);
    expect(movie.providers.queried).toEqual(expect.arrayContaining(["opensubtitles-v3", "yify"]));
    expect(series.providers.queried).toEqual(expect.arrayContaining(["opensubtitles-v3", "tvsubtitles"]));
    expect(anime.providers.queried).toEqual(["opensubtitles-v3"]);
    for (const result of [movie, series, anime]) {
      expect(result.tracks.every((track) => /^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt$/i.test(track.url))).toBe(true);
    }
  });

  it("rejects dotted episode markers from a different episode", async () => {
    const gateway = new SubtitleGateway([
      provider("subtitlecat", [
        { id: "wrong", provider: "subtitlecat", language: "en", label: "Game.Of.Thrones.S01.E04", release: "Game.Of.Thrones.S01.E04", sourceUrl: "https://subtitlecat.com/subs/wrong-en.srt" },
        { id: "right", provider: "subtitlecat", language: "en", label: "Game.Of.Thrones.S01.E01", release: "Game.Of.Thrones.S01.E01", sourceUrl: "https://subtitlecat.com/subs/right-en.srt" },
      ], 0, ["series"]),
    ], { idResolver: { resolve: async () => "tt0944947", clear: () => {} } as any });
    const result = await gateway.search({ tmdbId: 1399, kind: "series", season: 1, episode: 1, preferredLanguages: ["en"] });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].id).toBe("right");
  });

  it("rejects Spanish/Latin T3.E01 markers when querying Season 1 Episode 1", async () => {
    const gateway = new SubtitleGateway([
      provider("subtitlecat", [
        { id: "t3", provider: "subtitlecat", language: "es", label: "The Penthouse T3.E01 Español", release: "The.Penthouse.T3.E01", sourceUrl: "https://subtitlecat.com/subs/t3-es.srt" },
        { id: "t1", provider: "subtitlecat", language: "es", label: "The Penthouse T1.E01 Español", release: "The.Penthouse.T1.E01", sourceUrl: "https://subtitlecat.com/subs/t1-es.srt" },
      ], 0, ["series"]),
    ], { idResolver: { resolve: async () => "tt111110", clear: () => {} } as any });
    const result = await gateway.search({ tmdbId: 111110, kind: "series", season: 1, episode: 1, preferredLanguages: ["es"] });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].id).toBe("t1");
  });
});
