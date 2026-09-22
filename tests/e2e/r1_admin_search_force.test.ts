import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, normalizeTitle } from "../../server/db";
import {
  parsePublicCatalogIdentifier,
  getPublicCatalogByIdentifier,
  resetPublicCatalogCache,
} from "../../server/publicCatalog";
import {
  cleanQueryTitle,
  parseTitleQuery,
  buildSearchCandidates,
  __resetEngineCaches,
} from "../../server/metadataEngine";
import { decodeHtmlEntities, parseRawTitle } from "../../server/utils/titleNormalizer";
import { forceShowMetadata } from "../../server/metadataBackfill";

describe("E2E R1: Admin Panel & Deterministic Search Suite", () => {
  const TEST_PREFIX = `e2e_r1_${Date.now()}`;
  const createdShowIds: string[] = [];
  const createdMediaItemIds: string[] = [];
  const originalTmdbKey = process.env.TMDB_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetPublicCatalogCache();
    __resetEngineCaches();
    process.env.TMDB_API_KEY = "test_tmdb_api_key_e2e";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.TMDB_API_KEY = originalTmdbKey;
    // Clean up all created test database records
    if (createdShowIds.length > 0) {
      await prisma.episode.deleteMany({ where: { show_id: { in: createdShowIds } } });
      await prisma.show.deleteMany({ where: { id: { in: createdShowIds } } });
      createdShowIds.length = 0;
    }
    if (createdMediaItemIds.length > 0) {
      await prisma.mediaEpisode.deleteMany({ where: { media_item_id: { in: createdMediaItemIds } } });
      await prisma.mediaItem.deleteMany({ where: { id: { in: createdMediaItemIds } } });
      createdMediaItemIds.length = 0;
    }
  });

  // ==========================================
  // TIER 1: FEATURE COVERAGE (>=5 tests)
  // ==========================================

  it("T1.1: Deterministic lookup by numeric TMDB ID parses and fetches exact match", async () => {
    const tmdbId = 138843; // The Conjuring
    const parsed = parsePublicCatalogIdentifier(String(tmdbId));
    expect(parsed).not.toBeNull();
    expect(parsed?.tmdbId).toBe(tmdbId);

    // Mock TMDB upstream response deterministically
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/movie/${tmdbId}`)) {
        return new Response(JSON.stringify({
          id: tmdbId,
          title: "El conjuro",
          original_title: "The Conjuring",
          release_date: "2013-07-19",
          overview: "Una familia comienza a experimentar fenómenos extraños.",
          poster_path: "/wVYREutTvI2tmxr6ujrHT704wGF.jpg",
          vote_average: 7.5,
          genre_ids: [27, 53],
          external_ids: { imdb_id: "tt1457767" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes(`/tv/${tmdbId}`)) {
        return new Response(JSON.stringify({ status_code: 34, status_message: "Not found" }), { status: 404 });
      }
      return new Response("Not found", { status: 404 });
    }));

    const result = await getPublicCatalogByIdentifier(String(tmdbId), "mock_key");
    expect(result).not.toBeNull();
    expect(result?.shows).toHaveLength(1);
    const candidate = result!.shows[0];
    expect(candidate.tmdb_id).toBe(tmdbId);
    expect(candidate.title).toBe("El conjuro");
    expect(candidate.imdb_id).toBe("tt1457767");
    expect(candidate.year).toBe(2013);
  });

  it("T1.2: Deterministic lookup by IMDb ID (tt...) searches TMDB via /find", async () => {
    const imdbId = "tt1457767";
    const parsed = parsePublicCatalogIdentifier(imdbId);
    expect(parsed).not.toBeNull();
    expect(parsed?.imdbId).toBe(imdbId);

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/find/${imdbId}`)) {
        return new Response(JSON.stringify({
          movie_results: [
            {
              id: 138843,
              title: "The Conjuring",
              original_title: "The Conjuring",
              release_date: "2013-07-19",
              overview: "Paranormal investigators Ed and Lorraine Warren work to help a family.",
              poster_path: "/wVYREutTvI2tmxr6ujrHT704wGF.jpg",
              vote_average: 7.5,
            },
          ],
          tv_results: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }));

    const result = await getPublicCatalogByIdentifier(imdbId, "mock_key");
    expect(result).not.toBeNull();
    expect(result?.shows.length).toBeGreaterThanOrEqual(1);
    const candidate = result!.shows[0];
    expect(candidate.tmdb_id).toBe(138843);
    expect(candidate.imdb_id).toBe(imdbId);
  });

  it("T1.3: Deterministic search by title & year parses queries and builds ranked candidates", () => {
    const query = "El Conjuro (2013) Sub Español 1080p";
    const cleaned = cleanQueryTitle(query);
    expect(cleaned).toBe("El Conjuro");

    const parsed = parseTitleQuery("El Conjuro 2013");
    expect(parsed.baseTitle).toBe("El Conjuro");
    expect(parsed.year).toBe(2013);

    const candidates = buildSearchCandidates("El Conjuro 2013", "movie");
    expect(candidates).toContain("El Conjuro");
  });

  it("T1.4: Force TMDB Match atomically updates Show fields in PostgreSQL", async () => {
    // 1. Seed initial incomplete show in DB
    const initialShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Initial_Title`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Initial_Title`),
        category: "movie",
        description: "",
        tmdb_id: null,
        year: 0,
      },
    });
    createdShowIds.push(initialShow.id);

    // 2. Mock external TMDB enrichment
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/")) {
        return new Response(JSON.stringify({
          results: [
            {
              id: 138843,
              media_type: "movie",
              title: "El conjuro",
              original_title: "The Conjuring",
              original_language: "en",
              release_date: "2013-07-19",
              overview: "Historia de los investigadores de fenómenos paranormales Ed y Lorraine Warren.",
              poster_path: "/poster_conjuring.jpg",
              backdrop_path: "/banner_conjuring.jpg",
              vote_average: 7.5,
              genre_ids: [27],
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/genre/")) {
        return new Response(JSON.stringify({
          genres: [{ id: 27, name: "Terror" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }));

    // 3. Force metadata update
    const updated = await forceShowMetadata(initialShow.id, "El conjuro");
    expect(updated).not.toBeNull();
    expect(updated.tmdb_id).toBe(138843);
    expect(updated.year).toBe(2013);
    expect(updated.description).toContain("Ed y Lorraine Warren");
    expect(updated.poster_url).toContain("poster_conjuring.jpg");

    // 4. Verify directly in PostgreSQL
    const freshInDb = await prisma.show.findUnique({ where: { id: initialShow.id } });
    expect(freshInDb?.tmdb_id).toBe(138843);
    expect(freshInDb?.year).toBe(2013);
  });

  it("T1.5: Show & MediaItem Identity Synchronization mirrors tmdb_id and normalized_title", async () => {
    const title = `${TEST_PREFIX}_Sync_Show`;
    const normalized = normalizeTitle(title);

    // Create both Show and MediaItem
    const show = await prisma.show.create({
      data: {
        title,
        normalized_title: normalized,
        base_normalized_title: normalized,
        category: "movie",
        tmdb_id: null,
        imdb_id: null,
      },
    });
    createdShowIds.push(show.id);

    const mediaItem = await prisma.mediaItem.create({
      data: {
        title,
        normalized_title: normalized,
        base_normalized_title: normalized,
        kind: "movie",
        tmdb_id: null,
        imdb_id: null,
      },
    });
    createdMediaItemIds.push(mediaItem.id);

    // Synchronize identities
    const newTmdbId = 998877;
    const newImdbId = "tt9988776";

    await prisma.$transaction([
      prisma.show.update({
        where: { id: show.id },
        data: { tmdb_id: newTmdbId, imdb_id: newImdbId },
      }),
      prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: { tmdb_id: newTmdbId, imdb_id: newImdbId },
      }),
    ]);

    const updatedShow = await prisma.show.findUnique({ where: { id: show.id } });
    const updatedMedia = await prisma.mediaItem.findUnique({ where: { id: mediaItem.id } });

    expect(updatedShow?.tmdb_id).toBe(newTmdbId);
    expect(updatedShow?.imdb_id).toBe(newImdbId);
    expect(updatedMedia?.tmdb_id).toBe(newTmdbId);
    expect(updatedMedia?.imdb_id).toBe(newImdbId);
    expect(updatedShow?.normalized_title).toBe(updatedMedia?.normalized_title);
  });

  // ==========================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 tests)
  // ==========================================

  it("T2.1: Malformed TMDB IDs (negative, 0, strings with non-digits) are safely rejected", () => {
    expect(parsePublicCatalogIdentifier("-12345")).toBeNull();
    expect(parsePublicCatalogIdentifier("0")).toBeNull();
    expect(parsePublicCatalogIdentifier("tmdb:-50")).toBeNull();
    expect(parsePublicCatalogIdentifier("tmdb:abc")).toBeNull();
    expect(parsePublicCatalogIdentifier("not_an_id")).toBeNull();
    expect(parsePublicCatalogIdentifier("")).toBeNull();
    expect(parsePublicCatalogIdentifier(null)).toBeNull();
    expect(parsePublicCatalogIdentifier(undefined)).toBeNull();
  });

  it("T2.2: Malformed IMDb IDs (missing 'tt' prefix, special chars, SQLi injections) are safely rejected", () => {
    expect(parsePublicCatalogIdentifier("imdb:1457767")).toBeNull(); // Missing tt in imdb namespace
    expect(parsePublicCatalogIdentifier("tt")).toBeNull(); // No numbers
    expect(parsePublicCatalogIdentifier("tt12")).toBeNull(); // Too short (< 5 digits)
    expect(parsePublicCatalogIdentifier("tt1457767' OR '1'='1")).toBeNull();
    expect(parsePublicCatalogIdentifier("imdb:tt<script>")).toBeNull();
    expect(parsePublicCatalogIdentifier("tt12345678901234567890")).toBeNull(); // Too long (>12 digits)
  });

  it("T2.3: Extreme and edge release years are handled gracefully", () => {
    // Normalization and query extraction (valid range 1900-2099 per YEAR_PATTERN)
    const classicFilm = parseTitleQuery("Metropolis (1927)");
    expect(classicFilm.baseTitle).toBe("Metropolis");
    expect(classicFilm.year).toBe(1927);

    const futureRelease = parseTitleQuery("Avatar 5 (2031)");
    expect(futureRelease.baseTitle).toBe("Avatar 5");
    expect(futureRelease.year).toBe(2031);

    // Non-plausible release years (<1900 or >2099 or 0000) are not extracted as release years
    const ancientYear = parseTitleQuery("Roundhay Garden Scene (1888)");
    expect(ancientYear.year).toBeNull();

    const zeroYear = parseTitleQuery("Unknown Project (0000)");
    expect(zeroYear.year).toBeNull();

    const negativeYear = parseTitleQuery("Prehistoric Era (-500)");
    expect(negativeYear.year).toBeNull();
  });

  it("T2.4: Unicode diacritics, Spanish punctuation and CJK characters in queries", () => {
    const spanishQuery = "¿Quién mató a Sara? (Temporada 1)";
    const cleanedSpanish = cleanQueryTitle(spanishQuery);
    expect(cleanedSpanish).toBe("¿Quién mató a Sara?");

    const cjkQuery = "進撃の巨人 (Attack on Titan) [1080p Dual]";
    const cleanedCjk = cleanQueryTitle(cjkQuery);
    expect(cleanedCjk).toBe("進撃の巨人");

    const accentsTitle = "Amélie - Director's Cut (2001)";
    const cleanedAccents = cleanQueryTitle(accentsTitle);
    expect(cleanedAccents).toBe("Amélie");
  });

  it("T2.5: Queries with HTML entities and abnormal whitespace are normalized deterministically", () => {
    const rawEntity = "Fast &amp; Furious 7 &#40;2015&#41;";
    const decoded = decodeHtmlEntities(rawEntity);
    expect(decoded).toBe("Fast & Furious 7 (2015)");

    const parsedRaw = parseRawTitle(rawEntity);
    expect(parsedRaw.canonical).toBe("Fast Furious 7");
    expect(parsedRaw.year).toBe(2015);

    const messyWhitespace = "   The   Grand   Budapest   Hotel    (2014)   ";
    const cleanedWhitespace = cleanQueryTitle(messyWhitespace);
    expect(cleanedWhitespace).toBe("The Grand Budapest Hotel");
  });
});
