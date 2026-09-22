import { describe, expect, it } from "vitest";
import { scoreTmdbIdentityCandidate } from "./tmdbIdentityResolver";

describe("tmdbIdentityResolver confidence scoring", () => {
  it("accepts an exact title and year as high confidence", () => {
    const result = scoreTmdbIdentityCandidate(
      { title: "Polar", aliases: [], year: 2019, kind: "movie" },
      "Polar",
      { id: 483906, media_type: "movie", title: "Polar", release_date: "2019-01-25", original_language: "en" },
    );
    expect(result.confidence).toBe("high");
    expect(result.reasons).toContain("exact_title");
    expect(result.reasons).toContain("exact_year");
  });

  it("does not accept the same title from a conflicting year automatically", () => {
    const result = scoreTmdbIdentityCandidate(
      { title: "The Gift", year: 2015, kind: "movie" },
      "The Gift",
      { id: 1, media_type: "movie", title: "The Gift", release_date: "2000-12-22" },
    );
    expect(result.confidence).not.toBe("high");
    expect(result.reasons).toContain("year_mismatch");
  });

  it("rejects a candidate of the wrong media type", () => {
    const result = scoreTmdbIdentityCandidate(
      { title: "Dark", year: 2017, kind: "series" },
      "Dark",
      { id: 1, media_type: "movie", title: "Dark", release_date: "2017-01-01" },
    );
    expect(result).toMatchObject({ score: 0, confidence: "low" });
  });

  it("lets official anime aliases bridge romanized and translated titles", () => {
    const result = scoreTmdbIdentityCandidate(
      { title: "Kimi no Na wa", aliases: ["Your Name"], year: 2016, kind: "anime" },
      "Your Name",
      {
        id: 372058,
        media_type: "movie",
        title: "Your Name.",
        original_title: "君の名は。",
        release_date: "2016-08-26",
        original_language: "ja",
        origin_country: ["JP"],
        genre_ids: [16, 10749, 18],
      },
    );
    expect(result.confidence).toBe("high");
    expect(result.reasons).toContain("anime_origin");
    expect(result.reasons).toContain("animation_genre");
  });

  it("keeps weak token-only collisions below automatic confidence", () => {
    const result = scoreTmdbIdentityCandidate(
      { title: "Love Again", year: 2023, kind: "movie" },
      "Love Again",
      { id: 2, media_type: "movie", title: "Love Story Again", release_date: "2010-01-01" },
    );
    expect(result.confidence).not.toBe("high");
  });
});
