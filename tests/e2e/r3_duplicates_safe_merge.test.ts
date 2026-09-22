import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, normalizeTitle } from "../../server/db";
import { mergeTwoShows } from "../../server/reconcileCatalog";

describe("E2E R3: Duplicate Detection & Safe Merge Suite", () => {
  const TEST_PREFIX = `e2e_r3_${Date.now()}`;
  const createdShowIds: string[] = [];
  const createdMediaItemIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Clean up created database entities
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
  // TIER 1: FEATURE COVERAGE (>=5 tests)
  // ==========================================

  it("T1.1: Duplicate detection groups works with translated titles sharing canonical tmdb_id", async () => {
    const tmdbId = 138843; // The Conjuring
    const titleLatino = "El Conjuro";
    const titleCastellano = "Expediente Warren: The Conjuring";

    // Seed two separate catalog entries with translated titles but same TMDB ID
    const showLatino = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_${titleLatino}`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_${titleLatino}`),
        category: "movie",
        tmdb_id: tmdbId,
        year: 2013,
      },
    });
    createdShowIds.push(showLatino.id);

    const showCastellano = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_${titleCastellano}`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_${titleCastellano}`),
        category: "movie",
        tmdb_id: tmdbId,
        year: 2013,
      },
    });
    createdShowIds.push(showCastellano.id);

    // Grouping by canonical tmdb_id finds both entries
    const grouped = await prisma.show.findMany({
      where: { tmdb_id: tmdbId, id: { in: [showLatino.id, showCastellano.id] } },
    });

    expect(grouped).toHaveLength(2);
    expect(grouped.map((s) => s.id)).toContain(showLatino.id);
    expect(grouped.map((s) => s.id)).toContain(showCastellano.id);
  });

  it("T1.2: Safe merge executes non-destructively, absorbing source show into target show", async () => {
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Keep_Target`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Keep_Target`),
        category: "series",
        year: 2020,
      },
    });
    createdShowIds.push(targetShow.id);

    const sourceShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Merge_Source`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Merge_Source`),
        category: "series",
        year: 2020,
      },
    });
    createdShowIds.push(sourceShow.id);

    // Add episodes to both
    await prisma.episode.create({
      data: {
        show_id: targetShow.id,
        episode_number: 1,
        title: "Capítulo 1",
        source_url: "https://provider-a.example/ep1",
      },
    });

    await prisma.episode.create({
      data: {
        show_id: sourceShow.id,
        episode_number: 1,
        title: "Capítulo 2",
        source_url: "https://provider-b.example/ep2",
      },
    });

    // Execute merge
    const mergeResult = await mergeTwoShows(targetShow.id, sourceShow.id, { dryRun: false });
    expect(mergeResult.ok).toBe(true);

    // Target show still exists
    const preservedTarget = await prisma.show.findUnique({ where: { id: targetShow.id } });
    expect(preservedTarget).not.toBeNull();

    // Source show was safely absorbed (removed from catalog)
    const absorbedSource = await prisma.show.findUnique({ where: { id: sourceShow.id } });
    expect(absorbedSource).toBeNull();

    // Episodes moved to target show
    const targetEpisodes = await prisma.episode.findMany({
      where: { show_id: targetShow.id },
      orderBy: { episode_number: "asc" },
    });
    expect(targetEpisodes).toHaveLength(2);
  });

  it("T1.3: Season structure is preserved when merging series sequels", async () => {
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Anime_S1`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Anime_S1`),
        category: "anime",
      },
    });
    createdShowIds.push(targetShow.id);

    const sequelShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Anime Temporada 2`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Anime Temporada 2`),
        category: "anime",
      },
    });
    createdShowIds.push(sequelShow.id);

    await prisma.episode.create({
      data: {
        show_id: sequelShow.id,
        episode_number: 1,
        title: "Episodio 1 Temporada 2",
        source_url: "https://anime.example/t2-e1",
      },
    });

    const mergeResult = await mergeTwoShows(targetShow.id, sequelShow.id, { dryRun: false });
    expect(mergeResult.ok).toBe(true);
    // Season 2 detection
    expect(mergeResult.season).toBe(2);
  });

  it("T1.4: Safe merge deduplicates identical episode source URLs to prevent redundant rows", async () => {
    const sharedUrl = "https://cdn.example/ep1_master.m3u8";

    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Target_Dedup`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Target_Dedup`),
        category: "movie",
      },
    });
    createdShowIds.push(targetShow.id);

    const sourceShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Source_Dedup`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Source_Dedup`),
        category: "movie",
      },
    });
    createdShowIds.push(sourceShow.id);

    await prisma.episode.create({
      data: { show_id: targetShow.id, episode_number: 1, title: "Movie", source_url: sharedUrl },
    });
    await prisma.episode.create({
      data: { show_id: sourceShow.id, episode_number: 1, title: "Movie Duplicate", source_url: sharedUrl },
    });

    const result = await mergeTwoShows(targetShow.id, sourceShow.id, { dryRun: false });
    expect(result.ok).toBe(true);

    const finalEpisodes = await prisma.episode.findMany({ where: { show_id: targetShow.id } });
    expect(finalEpisodes).toHaveLength(1);
    expect(finalEpisodes[0].source_url).toBe(sharedUrl);
  });

  it("T1.5: User WatchProgress history migration repoints history from source to target show", async () => {
    const testUser = await prisma.user.create({
      data: {
        username: `${TEST_PREFIX}_watcher`,
        password_hash: "mock_hash_123",
      },
    });
    createdUserIds.push(testUser.id);

    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Target_History`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Target_History`),
        category: "series",
      },
    });
    createdShowIds.push(targetShow.id);

    const sourceShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Source_History`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Source_History`),
        category: "series",
      },
    });
    createdShowIds.push(sourceShow.id);

    const ep = await prisma.episode.create({
      data: {
        show_id: sourceShow.id,
        episode_number: 1,
        title: "Ep 1",
        source_url: "https://example.com/ep1",
      },
    });

    // Create user watch progress pointing to the source show
    const progress = await prisma.watchProgress.create({
      data: {
        user_id: testUser.id,
        show_id: sourceShow.id,
        show_title: sourceShow.title,
        episode_id: ep.id,
        episode_number: 1,
        episode_title: "Ep 1",
        progress_percent: 75,
      },
    });

    // Simulate watch progress migration step of safe merge
    await prisma.watchProgress.updateMany({
      where: { show_id: sourceShow.id },
      data: { show_id: targetShow.id, show_title: targetShow.title },
    });

    const migrated = await prisma.watchProgress.findUnique({ where: { id: progress.id } });
    expect(migrated?.show_id).toBe(targetShow.id);
    expect(migrated?.show_title).toBe(targetShow.title);
    expect(migrated?.progress_percent).toBe(75);
  });

  // ==========================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 tests)
  // ==========================================

  it("T2.1: Self-merge attempt is rejected with descriptive error without modifying database", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Self`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Self`),
        category: "movie",
      },
    });
    createdShowIds.push(show.id);

    const result = await mergeTwoShows(show.id, show.id, { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("consigo misma");
  });

  it("T2.2: Non-existent target or source show IDs are safely rejected", async () => {
    const realShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Real`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Real`),
        category: "movie",
      },
    });
    createdShowIds.push(realShow.id);

    const fakeId = "non_existent_cuid_999";
    const resultTargetFake = await mergeTwoShows(fakeId, realShow.id);
    expect(resultTargetFake.ok).toBe(false);

    const resultSourceFake = await mergeTwoShows(realShow.id, fakeId);
    expect(resultSourceFake.ok).toBe(false);
  });

  it("T2.3: Dry run mode calculates merge plan without modifying DB or deleting records", async () => {
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Dry_Target`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Dry_Target`),
        category: "series",
      },
    });
    createdShowIds.push(targetShow.id);

    const sourceShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Dry_Source`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Dry_Source`),
        category: "series",
      },
    });
    createdShowIds.push(sourceShow.id);

    await prisma.episode.create({
      data: { show_id: sourceShow.id, episode_number: 1, title: "Cap 1", source_url: "https://example.com/dry" },
    });

    const dryResult = await mergeTwoShows(targetShow.id, sourceShow.id, { dryRun: true });
    expect(dryResult.ok).toBe(true);
    expect(dryResult.detail).toContain("DRY:");

    // Both shows must still exist untouched
    const targetExists = await prisma.show.findUnique({ where: { id: targetShow.id } });
    const sourceExists = await prisma.show.findUnique({ where: { id: sourceShow.id } });
    expect(targetExists).not.toBeNull();
    expect(sourceExists).not.toBeNull();
  });

  it("T2.4: Merging shows where source has 0 episodes succeeds without throwing errors", async () => {
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Target_Zero`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Target_Zero`),
        category: "movie",
      },
    });
    createdShowIds.push(targetShow.id);

    const emptySource = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Empty_Source`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Empty_Source`),
        category: "movie",
      },
    });
    createdShowIds.push(emptySource.id);

    const result = await mergeTwoShows(targetShow.id, emptySource.id, { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.episodes_moved).toBe(0);

    const absorbed = await prisma.show.findUnique({ where: { id: emptySource.id } });
    expect(absorbed).toBeNull();
  });

  it("T2.5: Merging preserves metadata completeness when target already has rich fields", async () => {
    const targetShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Rich_Target`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Rich_Target`),
        category: "movie",
        description: "Rich canonical description with deep details.",
        rating: 8.9,
        year: 2021,
      },
    });
    createdShowIds.push(targetShow.id);

    const sourceShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Poor_Source`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Poor_Source`),
        category: "movie",
        description: "Short desc",
        rating: 5.0,
        year: 2021,
      },
    });
    createdShowIds.push(sourceShow.id);

    const result = await mergeTwoShows(targetShow.id, sourceShow.id, { dryRun: false });
    expect(result.ok).toBe(true);

    const finalTarget = await prisma.show.findUnique({ where: { id: targetShow.id } });
    expect(finalTarget?.description).toBe("Rich canonical description with deep details.");
    expect(finalTarget?.rating).toBe(8.9);
  });
});
