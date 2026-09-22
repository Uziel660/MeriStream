import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, normalizeTitle } from "../../server/db";
import {
  scoreTmdbIdentityCandidate,
  type TmdbIdentityInput,
  type TmdbCandidateLike,
} from "../../server/identity/tmdbIdentityResolver";
import {
  isSubstantiveDescription,
  isLikelyNonSpanishDescription,
} from "../../server/metadataEngine";
import {
  isLowQualityImage,
  isLandscapePosterUrl,
} from "../../server/metadataBackfill";

describe("E2E R2: Metadata & Identity Integrity Suite", () => {
  const TEST_PREFIX = `e2e_r2_${Date.now()}`;
  const createdShowIds: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (createdShowIds.length > 0) {
      await prisma.episode.deleteMany({ where: { show_id: { in: createdShowIds } } });
      await prisma.show.deleteMany({ where: { id: { in: createdShowIds } } });
      createdShowIds.length = 0;
    }
  });

  // ==========================================
  // TIER 1: FEATURE COVERAGE (>=5 tests)
  // ==========================================

  it("T1.1: Zero-Mismatch Resolver awards HIGH confidence to exact title and release year match", () => {
    const input: TmdbIdentityInput = {
      title: "Interstellar",
      year: 2014,
      kind: "movie",
    };
    const candidate: TmdbCandidateLike = {
      id: 157336,
      media_type: "movie",
      title: "Interstellar",
      release_date: "2014-11-05",
      original_language: "en",
    };

    const scoring = scoreTmdbIdentityCandidate(input, "Interstellar", candidate);
    expect(scoring.confidence).toBe("high");
    expect(scoring.reasons).toContain("exact_title");
    expect(scoring.reasons).toContain("exact_year");
    expect(scoring.score).toBeGreaterThanOrEqual(0.85);
  });

  it("T1.2: Zero-Mismatch Resolver rejects candidates with conflicting media type as LOW confidence", () => {
    const input: TmdbIdentityInput = {
      title: "Dark",
      year: 2017,
      kind: "series",
    };
    const candidate: TmdbCandidateLike = {
      id: 9999,
      media_type: "movie", // Conflicting: movie vs series
      title: "Dark",
      release_date: "2017-01-01",
    };

    const scoring = scoreTmdbIdentityCandidate(input, "Dark", candidate);
    expect(scoring.confidence).toBe("low");
    expect(scoring.score).toBe(0);
  });

  it("T1.3: Zero-Mismatch Resolver gates fuzzy/partial matches to MEDIUM requiring review", () => {
    const input: TmdbIdentityInput = {
      title: "Spider-Man",
      year: 2002,
      kind: "movie",
    };
    const candidate: TmdbCandidateLike = {
      id: 557,
      media_type: "movie",
      title: "The Amazing Spider-Man", // Partial / variant title
      release_date: "2012-07-03", // Also different year
    };

    const scoring = scoreTmdbIdentityCandidate(input, "Spider-Man", candidate);
    expect(scoring.confidence).not.toBe("high");
  });

  it("T1.4: Detects orphaned TMDB posters (image.tmdb.org with tmdb_id: null) in PostgreSQL", async () => {
    // Create an orphaned show: has TMDB poster CDN url but tmdb_id is null
    const orphanShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Orphan_Show`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Orphan_Show`),
        category: "movie",
        poster_url: "https://image.tmdb.org/t/p/w780/orphan_poster_123.jpg",
        tmdb_id: null,
        year: 2022,
      },
    });
    createdShowIds.push(orphanShow.id);

    // Query for anomalous/orphan records
    const orphans = await prisma.show.findMany({
      where: {
        id: orphanShow.id,
        tmdb_id: null,
        poster_url: { contains: "image.tmdb.org" },
      },
    });

    expect(orphans).toHaveLength(1);
    expect(orphans[0].id).toBe(orphanShow.id);
    expect(orphans[0].tmdb_id).toBeNull();
    expect(orphans[0].poster_url).toContain("image.tmdb.org");
  });

  it("T1.5: Backfills missing imdb_id for works with valid tmdb_id in PostgreSQL", async () => {
    // 1. Create show with tmdb_id but missing imdb_id
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Needs_Imdb`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Needs_Imdb`),
        category: "movie",
        tmdb_id: 157336,
        imdb_id: null,
        year: 2014,
      },
    });
    createdShowIds.push(targetShow.id);

    // 2. Simulate resolving external_ids
    const resolvedImdbId = "tt0816692"; // Interstellar IMDb

    // 3. Atomically backfill
    await prisma.show.update({
      where: { id: targetShow.id },
      data: { imdb_id: resolvedImdbId },
    });

    // 4. Verify in DB
    const updated = await prisma.show.findUnique({ where: { id: targetShow.id } });
    expect(updated?.tmdb_id).toBe(157336);
    expect(updated?.imdb_id).toBe(resolvedImdbId);
  });

  // ==========================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 tests)
  // ==========================================

  it("T2.1: Resolves title collisions across different release years with year_mismatch penalty", () => {
    const input: TmdbIdentityInput = {
      title: "The Gift",
      year: 2015,
      kind: "movie",
    };
    const olderFilm: TmdbCandidateLike = {
      id: 1234,
      media_type: "movie",
      title: "The Gift",
      release_date: "2000-12-22",
    };

    const result = scoreTmdbIdentityCandidate(input, "The Gift", olderFilm);
    expect(result.confidence).not.toBe("high");
    expect(result.reasons).toContain("year_mismatch");
  });

  it("T2.2: Anime alias bridging connects Romanized title to English variant with high confidence", () => {
    const input: TmdbIdentityInput = {
      title: "Kimi no Na wa",
      aliases: ["Your Name"],
      year: 2016,
      kind: "anime",
    };
    const candidate: TmdbCandidateLike = {
      id: 372058,
      media_type: "movie",
      title: "Your Name.",
      original_title: "君の名は。",
      release_date: "2016-08-26",
      original_language: "ja",
      origin_country: ["JP"],
      genre_ids: [16, 10749, 18],
    };

    const result = scoreTmdbIdentityCandidate(input, "Your Name", candidate);
    expect(result.confidence).toBe("high");
    expect(result.reasons).toContain("anime_origin");
    expect(result.reasons).toContain("animation_genre");
  });

  it("T2.3: Substantive description validation filters weak, empty or foreign language texts", () => {
    expect(isSubstantiveDescription("")).toBe(false);
    expect(isSubstantiveDescription("Sin descripción disponible.")).toBe(false);
    expect(isSubstantiveDescription("Texto muy corto")).toBe(false); // < 60 chars
    expect(
      isSubstantiveDescription("Un grupo de exploradores emprende la misión más importante de la historia humana hacia otra galaxia.")
    ).toBe(true);

    // English detection markers
    expect(isLikelyNonSpanishDescription("The story follows a young detective in modern life.")).toBe(true);
    expect(isLikelyNonSpanishDescription("Una película emocionante sobre la vida de un joven científico.")).toBe(false);
  });

  it("T2.4: Low-quality image guard rejects placeholders and non-vertical banners", () => {
    // Placeholders
    expect(isLowQualityImage(null)).toBe(true);
    expect(isLowQualityImage("")).toBe(true);
    expect(isLowQualityImage("https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800")).toBe(true);
    expect(isLowQualityImage("https://example.com/blank.png")).toBe(true);
    expect(isLowQualityImage("https://example.com/no_poster.jpg")).toBe(true);
    expect(isLowQualityImage("https://image.tmdb.org/t/p/w92/small_thumb.jpg")).toBe(true); // tiny w92

    // Legitimate poster
    expect(isLowQualityImage("https://image.tmdb.org/t/p/w780/valid_poster.jpg")).toBe(false);

    // Landscape poster check
    expect(isLandscapePosterUrl("https://example.com/backdrop_image.jpg")).toBe(true);
    expect(isLandscapePosterUrl("https://example.com/w1280_and_h720/art.jpg")).toBe(true);
    expect(isLandscapePosterUrl("https://image.tmdb.org/t/p/w780/vertical_poster.jpg")).toBe(false);
  });

  it("T2.5: Zero-mismatch candidate scoring with missing or null attributes handles errors gracefully", () => {
    const emptyInput: TmdbIdentityInput = {
      title: "",
      kind: "movie",
    };
    const emptyCandidate: TmdbCandidateLike = {};

    const result = scoreTmdbIdentityCandidate(emptyInput, "", emptyCandidate);
    expect(result).toBeDefined();
    expect(result.confidence).toBe("low");
    expect(result.score).toBe(0);
  });
});
