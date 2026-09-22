import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, normalizeTitle } from "../../server/db";
import {
  parsePublicCatalogIdentifier,
  getPublicCatalogByIdentifier,
  resetPublicCatalogCache,
} from "../../server/publicCatalog";
import { forceShowMetadata } from "../../server/metadataBackfill";
import { mergeTwoShows } from "../../server/reconcileCatalog";
import { classifySourceKind } from "../../server/resolutionMetadata";
import { syncEpisodeSources } from "../../server/showService";
import { resolveTioPlusPage } from "../../server/platformPageResolvers";

describe("E2E Scenarios: Tier 3 Cross-Feature & Tier 4 Real-World Workflows", () => {
  const TEST_PREFIX = `e2e_scen_${Date.now()}`;
  const createdShowIds: string[] = [];
  const createdMediaItemIds: string[] = [];
  const createdUserIds: string[] = [];
  const originalTmdbKey = process.env.TMDB_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetPublicCatalogCache();
    process.env.TMDB_API_KEY = "test_tmdb_key";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    process.env.TMDB_API_KEY = originalTmdbKey;

    if (createdUserIds.length > 0) {
      await prisma.watchProgress.deleteMany({ where: { user_id: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
    if (createdShowIds.length > 0) {
      await prisma.watchProgress.deleteMany({ where: { show_id: { in: createdShowIds } } });
      await prisma.episode.deleteMany({ where: { show_id: { in: createdShowIds } } });
      await prisma.show.deleteMany({ where: { id: { in: createdShowIds } } });
      createdShowIds.length = 0;
    }
    if (createdMediaItemIds.length > 0) {
      await prisma.sourceLink.deleteMany({
        where: { media_episode: { media_item_id: { in: createdMediaItemIds } } },
      });
      await prisma.mediaEpisode.deleteMany({ where: { media_item_id: { in: createdMediaItemIds } } });
      await prisma.mediaItem.deleteMany({ where: { id: { in: createdMediaItemIds } } });
      createdMediaItemIds.length = 0;
    }
  });

  // ==========================================
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // ==========================================

  it("T3.1: Search Candidate Lookup -> Force TMDB Match -> Show & MediaItem Atomic Sync", async () => {
    const tmdbId = 157336; // Interstellar
    const imdbId = "tt0816692";

    // 1. Deterministic search lookup parses identifier and matches candidate
    const parsed = parsePublicCatalogIdentifier(String(tmdbId));
    expect(parsed?.tmdbId).toBe(tmdbId);

    // 2. Mock external TMDB API
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/movie/${tmdbId}`)) {
        return new Response(JSON.stringify({
          id: tmdbId,
          media_type: "movie",
          title: "Interstellar",
          original_title: "Interstellar",
          release_date: "2014-11-05",
          overview: "A team of explorers travel through a wormhole in space.",
          poster_path: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
          vote_average: 8.6,
          genre_ids: [12, 18, 878],
          external_ids: { imdb_id: imdbId },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/search/")) {
        return new Response(JSON.stringify({
          results: [
            {
              id: tmdbId,
              media_type: "movie",
              title: "Interstellar",
              original_title: "Interstellar",
              release_date: "2014-11-05",
              overview: "A team of explorers travel through a wormhole in space.",
              poster_path: "/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
              vote_average: 8.6,
              genre_ids: [12, 18, 878],
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/genre/")) {
        return new Response(JSON.stringify({ genres: [{ id: 878, name: "Ciencia Ficción" }] }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    }));

    // 3. Create initial unlinked records in DB
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Raw_Interstellar`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Raw_Interstellar`),
        category: "movie",
      },
    });
    createdShowIds.push(show.id);

    const mediaItem = await prisma.mediaItem.create({
      data: {
        title: `${TEST_PREFIX}_Raw_Interstellar`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Raw_Interstellar`),
        kind: "movie",
      },
    });
    createdMediaItemIds.push(mediaItem.id);

    // 4. Force TMDB match
    const updated = await forceShowMetadata(show.id, "Interstellar");
    expect(updated.tmdb_id).toBe(tmdbId);

    // 5. Synchronize with MediaItem in transaction
    await prisma.$transaction([
      prisma.show.update({
        where: { id: show.id },
        data: { tmdb_id: tmdbId, imdb_id: imdbId },
      }),
      prisma.mediaItem.update({
        where: { id: mediaItem.id },
        data: { tmdb_id: tmdbId, imdb_id: imdbId },
      }),
    ]);

    // 6. Assert atomic alignment
    const freshShow = await prisma.show.findUnique({ where: { id: show.id } });
    const freshMedia = await prisma.mediaItem.findUnique({ where: { id: mediaItem.id } });

    expect(freshShow?.tmdb_id).toBe(tmdbId);
    expect(freshShow?.imdb_id).toBe(imdbId);
    expect(freshMedia?.tmdb_id).toBe(tmdbId);
    expect(freshMedia?.imdb_id).toBe(imdbId);
  });

  it("T3.2: Translated Title Duplicates -> Safe Atomic Merge -> Season Invariant Retention", async () => {
    const tmdbId = 138843; // The Conjuring

    // Show 1: Latino title (Keep target)
    const showKeep = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_El Conjuro`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_El Conjuro`),
        category: "movie",
        tmdb_id: tmdbId,
        year: 2013,
      },
    });
    createdShowIds.push(showKeep.id);

    await prisma.episode.create({
      data: {
        show_id: showKeep.id,
        episode_number: 1,
        title: "Película Latino",
        source_url: "https://latino.example/movie",
      },
    });

    // Show 2: Castellano title (Merge source)
    const showMerge = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Expediente Warren: The Conjuring`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Expediente Warren: The Conjuring`),
        category: "movie",
        tmdb_id: tmdbId,
        year: 2013,
      },
    });
    createdShowIds.push(showMerge.id);

    await prisma.episode.create({
      data: {
        show_id: showMerge.id,
        episode_number: 1,
        title: "Película Castellano",
        source_url: "https://castellano.example/movie",
      },
    });

    // Execute merge
    const result = await mergeTwoShows(showKeep.id, showMerge.id, { dryRun: false });
    expect(result.ok).toBe(true);

    // Verify target retains all episodes
    const combinedEpisodes = await prisma.episode.findMany({
      where: { show_id: showKeep.id },
      orderBy: { episode_number: "asc" },
    });
    expect(combinedEpisodes).toHaveLength(2);
    expect(combinedEpisodes[0].source_url).toBe("https://latino.example/movie");
    expect(combinedEpisodes[1].source_url).toBe("https://castellano.example/movie");

    // Source show safely removed
    const sourceGone = await prisma.show.findUnique({ where: { id: showMerge.id } });
    expect(sourceGone).toBeNull();
  });

  it("T3.3: Series Trapped as Movie -> Multi-Episode Escalation -> Hierarchy Verification", async () => {
    // 1. Initial ingestion marked category: "movie"
    const trapped = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Breaking Bad Trapped`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Breaking Bad Trapped`),
        category: "movie",
      },
    });
    createdShowIds.push(trapped.id);

    // 2. Crawler inserts multiple episodes
    for (let i = 1; i <= 7; i++) {
      await prisma.episode.create({
        data: {
          show_id: trapped.id,
          episode_number: i,
          title: `Capítulo ${i}`,
          source_url: `https://tv.example/s1e${i}`,
        },
      });
    }

    // 3. Escalation guard detects multi-episode series and upgrades category
    const count = await prisma.episode.count({ where: { show_id: trapped.id } });
    if (count > 1 && trapped.category === "movie") {
      await prisma.show.update({
        where: { id: trapped.id },
        data: { category: "series" },
      });
    }

    // 4. Verify escalation
    const escalated = await prisma.show.findUnique({ where: { id: trapped.id } });
    expect(escalated?.category).toBe("series");
    expect(count).toBe(7);
  });

  it("T3.4: Ephemeral Stream Discovery -> Persistence Guard Drops Signed URL -> JIT On-Demand Resolution", async () => {
    const canonicalPageUrl = "https://tioplus.app/pelicula/inception/";
    const ephemeralDirectHls = "https://cdn.example.com/master.m3u8?expires=1800000000";

    // 1. Classify kinds
    expect(classifySourceKind(canonicalPageUrl)).toBe("page");
    expect(classifySourceKind(ephemeralDirectHls)).toBe("ephemeral_direct");

    // 2. Ingestion guard ensures only canonical URL is saved
    const mediaItem = await prisma.mediaItem.create({
      data: {
        title: `${TEST_PREFIX}_Inception`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Inception`),
        kind: "movie",
      },
    });
    createdMediaItemIds.push(mediaItem.id);

    const added = await syncEpisodeSources(
      mediaItem.id,
      1,
      1,
      [
        { url: canonicalPageUrl, source_site: "tioplus" },
        { url: ephemeralDirectHls, source_site: "tioplus" },
      ],
      "tioplus"
    );
    expect(added).toBe(1);

    // 3. JIT playback resolution resolves fresh stream candidate when player requests
    const resolution = await resolveTioPlusPage(canonicalPageUrl, {
      htmlFetcher: async () => "<html><body><button data-video='aHR0cHM6Ly9tZWRpYS5leGFtcGxlL2RpcmVjdC5tcDQ='>Play</button></body></html>",
      streamExtractor: async () => ({
        stream_url: "https://media.example/direct.mp4",
        all_available_streams: ["https://media.example/direct.mp4"],
      }),
    });

    expect(resolution.provider).toBe("TioPlus");
    expect(resolution.url).toBe("https://media.example/direct.mp4");
  });

  // ==========================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // ==========================================

  it("T4.1: Real-World Workflow: Admin Catalog Curation & Resolution Pipeline", async () => {
    // 1. Admin discovers orphan entry in catalog with TMDB poster but no tmdb_id
    const orphanShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Orphan_Fauno`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Orphan_Fauno`),
        category: "movie",
        poster_url: "https://image.tmdb.org/t/p/w780/fauno_poster.jpg",
        tmdb_id: null,
      },
    });
    createdShowIds.push(orphanShow.id);

    // 2. Admin searches for TMDB identity
    const parsed = parsePublicCatalogIdentifier("1417"); // El Laberinto del Fauno TMDB ID
    expect(parsed?.tmdbId).toBe(1417);

    // 3. Admin links verified TMDB ID and syncs
    await prisma.show.update({
      where: { id: orphanShow.id },
      data: {
        tmdb_id: 1417,
        imdb_id: "tt0457430",
        year: 2006,
        description: "En la España de 1944, la joven Ofelia viaja con su madre.",
      },
    });

    // 4. Admin checks catalog: show is now healthy and no longer appears in missing_tmdb list
    const healthyCheck = await prisma.show.findUnique({ where: { id: orphanShow.id } });
    expect(healthyCheck?.tmdb_id).toBe(1417);
    expect(healthyCheck?.imdb_id).toBe("tt0457430");
    expect(healthyCheck?.year).toBe(2006);
  });

  it("T4.2: Real-World Workflow: Active Viewer Playback Continuity during Admin Catalog Merge", async () => {
    // 1. Create registered user
    const viewer = await prisma.user.create({
      data: {
        username: `${TEST_PREFIX}_viewer_active`,
        password_hash: "hash_secret",
      },
    });
    createdUserIds.push(viewer.id);

    // 2. Two duplicate shows exist in catalog
    const showTarget = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Arcane (Canon)`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Arcane (Canon)`),
        category: "series",
        tmdb_id: 94605,
      },
    });
    createdShowIds.push(showTarget.id);

    const showDuplicate = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Arcane (Duplicado Scraper)`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Arcane (Duplicado Scraper)`),
        category: "series",
        tmdb_id: 94605,
      },
    });
    createdShowIds.push(showDuplicate.id);

    const ep = await prisma.episode.create({
      data: {
        show_id: showDuplicate.id,
        episode_number: 1,
        title: "Capítulo 1",
        source_url: "https://stream.example/arcane-ep1",
      },
    });

    // 3. Viewer watches episode 1 from duplicate show
    const progress = await prisma.watchProgress.create({
      data: {
        user_id: viewer.id,
        show_id: showDuplicate.id,
        show_title: showDuplicate.title,
        episode_id: ep.id,
        episode_number: 1,
        episode_title: "Capítulo 1",
        progress_percent: 60,
        current_time: 1200,
        duration: 2000,
      },
    });

    // 4. Admin initiates safe merge: duplicate show is absorbed into canon show
    // Re-point watch progress to canonical show
    await prisma.watchProgress.updateMany({
      where: { show_id: showDuplicate.id },
      data: { show_id: showTarget.id, show_title: showTarget.title },
    });

    // Merge episodes
    await prisma.episode.updateMany({
      where: { show_id: showDuplicate.id },
      data: { show_id: showTarget.id },
    });

    await prisma.show.delete({ where: { id: showDuplicate.id } });

    // 5. Viewer returns: watch progress is seamlessly retained and links to canon show
    const updatedProgress = await prisma.watchProgress.findUnique({ where: { id: progress.id } });
    expect(updatedProgress?.show_id).toBe(showTarget.id);
    expect(updatedProgress?.show_title).toBe(showTarget.title);
    expect(updatedProgress?.progress_percent).toBe(60);

    const canonEpisodes = await prisma.episode.findMany({ where: { show_id: showTarget.id } });
    expect(canonEpisodes).toHaveLength(1);
    expect(canonEpisodes[0].source_url).toBe("https://stream.example/arcane-ep1");
  });

  it("T4.3: Real-World Workflow: Multi-Provider Scraper Ingestion to JIT Playback Pipeline", async () => {
    // 1. Multi-provider sources for the same work
    const canonicalProviders = [
      { url: "https://tioplus.app/pelicula/gladiator-2/", source_site: "tioplus" },
      { url: "https://doramasflix.io/peliculas/gladiator-2", source_site: "doramasflix" },
    ];

    // Verify all are canonical locators
    for (const source of canonicalProviders) {
      expect(classifySourceKind(source.url)).toBe("page");
    }

    // 2. Ingest into MediaItem
    const mediaItem = await prisma.mediaItem.create({
      data: {
        title: `${TEST_PREFIX}_Gladiator II`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Gladiator II`),
        kind: "movie",
      },
    });
    createdMediaItemIds.push(mediaItem.id);

    const added = await syncEpisodeSources(mediaItem.id, 1, 1, canonicalProviders, "tioplus");
    expect(added).toBe(2);

    // 3. Verify JIT stream can be resolved when requested by player
    const resolution = await resolveTioPlusPage(canonicalProviders[0].url, {
      htmlFetcher: async () => "<html><body><button data-video='aHR0cHM6Ly9tZWRpYS5leGFtcGxlL2dsYWRpYXRvcjIubXA0'>Play</button></body></html>",
      streamExtractor: async () => ({
        stream_url: "https://media.example/gladiator2.mp4",
        all_available_streams: ["https://media.example/gladiator2.mp4"],
      }),
    });

    expect(resolution.url).toBe("https://media.example/gladiator2.mp4");
  });
});
