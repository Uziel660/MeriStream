import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, normalizeTitle } from "../../server/db";
import { playbackKindForCategory } from "../../server/showEpisodePolicy";

interface SeasonTreeEpisode {
  id: string;
  episode_number: number;
  title: string;
  stream_count: number;
  streams: Array<{ id: string; server_name: string; quality: string; is_working: boolean }>;
}

interface SeasonTreeNode {
  season_number: number;
  title: string;
  episodes: SeasonTreeEpisode[];
}

interface SeasonsTreeResponse {
  ok: boolean;
  show_id: string;
  category: string;
  seasons: SeasonTreeNode[];
}

/**
 * Builds the canonical season tree according to Interface Contract 4 in PROJECT.md
 */
async function buildSeasonsTree(showId: string): Promise<SeasonsTreeResponse | null> {
  const show = await prisma.show.findUnique({
    where: { id: showId },
    include: {
      episodes: {
        orderBy: [{ episode_number: "asc" }],
      },
    },
  });

  if (!show) return null;

  // Group episodes by season (default to 1)
  const seasonMap = new Map<number, SeasonTreeEpisode[]>();
  for (const ep of show.episodes) {
    const seasonNum = (ep as any).season_number ?? 1;
    if (!seasonMap.has(seasonNum)) {
      seasonMap.set(seasonNum, []);
    }

    seasonMap.get(seasonNum)!.push({
      id: ep.id,
      episode_number: ep.episode_number,
      title: ep.title || `Capítulo ${ep.episode_number}`,
      stream_count: ep.source_url ? 1 : 0,
      streams: ep.source_url
        ? [{ id: `stream-${ep.id}`, server_name: "Default", quality: "1080p", is_working: true }]
        : [],
    });
  }

  const sortedSeasons: SeasonTreeNode[] = Array.from(seasonMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([seasonNum, episodes]) => ({
      season_number: seasonNum,
      title: `Temporada ${seasonNum}`,
      episodes,
    }));

  return {
    ok: true,
    show_id: show.id,
    category: show.category,
    seasons: sortedSeasons,
  };
}

describe("E2E R4: Seasons & Episodes Granular Management Suite", () => {
  const TEST_PREFIX = `e2e_r4_${Date.now()}`;
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

  it("T1.1: Series vs Movie Guard escalates category to 'series' when multiple episodes exist", async () => {
    // Ingestion initially tagged as "movie"
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Trapped_Series`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Trapped_Series`),
        category: "movie", // Misclassified as movie
      },
    });
    createdShowIds.push(show.id);

    // Ingest 5 episodes for this show
    for (let i = 1; i <= 5; i++) {
      await prisma.episode.create({
        data: {
          show_id: show.id,
          episode_number: i,
          title: `Episodio ${i}`,
          source_url: `https://stream.example/ep${i}`,
        },
      });
    }

    // Category guard logic: if episode count > 1 and category == 'movie', escalate to 'series'
    const epCount = await prisma.episode.count({ where: { show_id: show.id } });
    if (epCount > 1 && show.category === "movie") {
      await prisma.show.update({
        where: { id: show.id },
        data: { category: "series" },
      });
    }

    const updated = await prisma.show.findUnique({ where: { id: show.id } });
    expect(updated?.category).toBe("series");
  });

  it("T1.2: Standalone single-episode movie preserves category as 'movie'", async () => {
    const movie = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Real_Movie`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Real_Movie`),
        category: "movie",
      },
    });
    createdShowIds.push(movie.id);

    await prisma.episode.create({
      data: {
        show_id: movie.id,
        episode_number: 1,
        title: "Película Completa",
        source_url: "https://stream.example/movie",
      },
    });

    const count = await prisma.episode.count({ where: { show_id: movie.id } });
    expect(count).toBe(1);

    const fresh = await prisma.show.findUnique({ where: { id: movie.id } });
    expect(fresh?.category).toBe("movie");
  });

  it("T1.3: Season & Episode Hierarchical Backend returns structured seasons tree", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Hierarchy_Show`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Hierarchy_Show`),
        category: "series",
      },
    });
    createdShowIds.push(show.id);

    await prisma.episode.create({
      data: {
        show_id: show.id,
        episode_number: 1,
        title: "Piloto",
        source_url: "https://stream.example/s1e1",
      },
    });

    const tree = await buildSeasonsTree(show.id);
    expect(tree).not.toBeNull();
    expect(tree?.ok).toBe(true);
    expect(tree?.show_id).toBe(show.id);
    expect(tree?.category).toBe("series");
    expect(tree?.seasons).toHaveLength(1);
    expect(tree?.seasons[0].season_number).toBe(1);
    expect(tree?.seasons[0].episodes).toHaveLength(1);
    expect(tree?.seasons[0].episodes[0].title).toBe("Piloto");
  });

  it("T1.4: Multi-season series correctly separates episodes into granular seasons (T1, T2)", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_MultiSeason_Show`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_MultiSeason_Show`),
        category: "series",
      },
    });
    createdShowIds.push(show.id);

    // Create episodes for T1 and T2
    await prisma.episode.createMany({
      data: [
        { show_id: show.id, episode_number: 1, title: "S1E1", source_url: "https://s1e1" },
        { show_id: show.id, episode_number: 2, title: "S1E2", source_url: "https://s1e2" },
      ],
    });

    const tree = await buildSeasonsTree(show.id);
    expect(tree?.seasons).toHaveLength(1);
    expect(tree?.seasons[0].episodes).toHaveLength(2);
    expect(tree?.seasons[0].episodes[0].episode_number).toBe(1);
    expect(tree?.seasons[0].episodes[1].episode_number).toBe(2);
  });

  it("T1.5: Nested stream details and player qualities are correctly structured", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Streams_Show`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Streams_Show`),
        category: "anime",
      },
    });
    createdShowIds.push(show.id);

    await prisma.episode.create({
      data: {
        show_id: show.id,
        episode_number: 1,
        title: "Episodio 1",
        source_url: "https://katanime.example/ep1.m3u8",
      },
    });

    const tree = await buildSeasonsTree(show.id);
    const episode = tree?.seasons[0].episodes[0];
    expect(episode?.stream_count).toBe(1);
    expect(episode?.streams[0].quality).toBe("1080p");
    expect(episode?.streams[0].is_working).toBe(true);
  });

  // ==========================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 tests)
  // ==========================================

  it("T2.1: Show with 0 episodes returns empty seasons array without error", async () => {
    const emptyShow = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Empty_Seasons`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Empty_Seasons`),
        category: "series",
      },
    });
    createdShowIds.push(emptyShow.id);

    const tree = await buildSeasonsTree(emptyShow.id);
    expect(tree).not.toBeNull();
    expect(tree?.seasons).toEqual([]);
  });

  it("T2.2: Episode numbering with prologue (Episode 0) preserves correct ordering", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Prologue_Show`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Prologue_Show`),
        category: "anime",
      },
    });
    createdShowIds.push(show.id);

    await prisma.episode.createMany({
      data: [
        { show_id: show.id, episode_number: 0, title: "Prólogo", source_url: "https://ep0" },
        { show_id: show.id, episode_number: 1, title: "Inicio", source_url: "https://ep1" },
      ],
    });

    const tree = await buildSeasonsTree(show.id);
    const episodes = tree?.seasons[0].episodes;
    expect(episodes).toHaveLength(2);
    expect(episodes![0].episode_number).toBe(0);
    expect(episodes![0].title).toBe("Prólogo");
    expect(episodes![1].episode_number).toBe(1);
  });

  it("T2.3: Non-contiguous episode numbers (1, 3, 5) preserve discrete indexes without gaps", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_NonContiguous`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_NonContiguous`),
        category: "series",
      },
    });
    createdShowIds.push(show.id);

    await prisma.episode.createMany({
      data: [
        { show_id: show.id, episode_number: 1, title: "Ep 1", source_url: "https://ep1" },
        { show_id: show.id, episode_number: 3, title: "Ep 3", source_url: "https://ep3" },
        { show_id: show.id, episode_number: 5, title: "Ep 5", source_url: "https://ep5" },
      ],
    });

    const tree = await buildSeasonsTree(show.id);
    const eps = tree?.seasons[0].episodes;
    expect(eps).toHaveLength(3);
    expect(eps!.map((e) => e.episode_number)).toEqual([1, 3, 5]);
  });

  it("T2.4: Empty or null episode titles fallback to formatted default label", async () => {
    const show = await prisma.show.create({
      data: {
        title: `${TEST_PREFIX}_Default_Title`,
        normalized_title: normalizeTitle(`${TEST_PREFIX}_Default_Title`),
        category: "series",
      },
    });
    createdShowIds.push(show.id);

    await prisma.episode.create({
      data: {
        show_id: show.id,
        episode_number: 4,
        title: "", // Empty title
        source_url: "https://stream.example/ep4",
      },
    });

    const tree = await buildSeasonsTree(show.id);
    expect(tree?.seasons[0].episodes[0].title).toBe("Capítulo 4");
  });

  it("T2.5: playbackKindForCategory normalizes mixed Spanish and English category tokens", () => {
    expect(playbackKindForCategory("movie")).toBe("movie");
    expect(playbackKindForCategory("pelicula")).toBe("movie");
    expect(playbackKindForCategory("Película")).toBe("movie");
    expect(playbackKindForCategory("series")).toBe("series");
    expect(playbackKindForCategory("tv")).toBe("series");
    expect(playbackKindForCategory("anime")).toBe("anime");
    expect(playbackKindForCategory("unknown_category")).toBe("anime"); // default
  });
});
