// server/showService.test.ts
// ══════════════════════════════════════════════════════════════════
// Tests de comportamiento de showService sin mockear su lógica interna.
// Valida deduplicación, resolución de TMDB, multi-fuente y restricciones
// compuestas de MediaEpisode y SourceLink.
// ══════════════════════════════════════════════════════════════════
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── In-Memory Database Store ─────────────────────────────────────
let dbShows: any[] = [];
let dbEpisodes: any[] = [];
let dbMediaItems: any[] = [];
let dbMediaEpisodes: any[] = [];
let dbSourceLinks: any[] = [];

vi.mock("./db", () => ({
  normalizeTitle: (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  prisma: {
    show: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const found = dbShows.find((s) => s.id === where.id);
        if (!found) return Promise.resolve(null);
        return Promise.resolve({
          ...found,
          episodes: dbEpisodes.filter((e) => e.show_id === found.id),
        });
      }),
      findFirst: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbShows];
        if (where?.tmdb_id !== undefined) {
          list = list.filter((s) => s.tmdb_id === where.tmdb_id);
        }
        if (where?.category) {
          list = list.filter((s) => s.category === where.category);
        }
        if (where?.base_normalized_title?.not) {
          list = list.filter((s) => s.base_normalized_title !== where.base_normalized_title.not);
        }
        const found = list[0] || null;
        if (!found) return Promise.resolve(null);
        return Promise.resolve({
          ...found,
          episodes: dbEpisodes.filter((e) => e.show_id === found.id),
        });
      }),
      findMany: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbShows];
        if (where?.base_normalized_title) {
          list = list.filter((s) => s.base_normalized_title === where.base_normalized_title);
        }
        if (where?.normalized_title?.in) {
          list = list.filter((s) => where.normalized_title.in.includes(s.normalized_title));
        }
        return Promise.resolve(
          list.map((s) => ({
            ...s,
            episodes: dbEpisodes.filter((e) => e.show_id === s.id),
          }))
        );
      }),
      create: vi.fn().mockImplementation(({ data }) => {
        const id = data.id || `show_${Date.now()}_${Math.random()}`;
        const newShow = { ...data, id };
        dbShows.push(newShow);
        return Promise.resolve(newShow);
      }),
      deleteMany: vi.fn().mockImplementation(() => {
        dbShows = [];
        return Promise.resolve({ count: 0 });
      }),
    },
    episode: {
      findFirst: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbEpisodes];
        if (where?.show_id) list = list.filter((e) => e.show_id === where.show_id);
        if (where?.source_url) list = list.filter((e) => e.source_url === where.source_url);
        return Promise.resolve(list[0] || null);
      }),
      findMany: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbEpisodes];
        if (where?.show_id) list = list.filter((e) => e.show_id === where.show_id);
        return Promise.resolve(list);
      }),
      create: vi.fn().mockImplementation(({ data }) => {
        const id = data.id || `ep_${Date.now()}_${Math.random()}`;
        const newEp = { ...data, id };
        dbEpisodes.push(newEp);
        return Promise.resolve(newEp);
      }),
      createMany: vi.fn().mockImplementation(({ data }) => {
        const added = (Array.isArray(data) ? data : []).map((d) => ({
          ...d,
          id: d.id || `ep_${Date.now()}_${Math.random()}`,
        }));
        dbEpisodes.push(...added);
        return Promise.resolve({ count: added.length });
      }),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockImplementation(() => {
        dbEpisodes = [];
        return Promise.resolve({ count: 0 });
      }),
    },
    mediaItem: {
      findFirst: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbMediaItems];
        if (where?.tmdb_id !== undefined) list = list.filter((m) => m.tmdb_id === where.tmdb_id);
        if (where?.kind) list = list.filter((m) => m.kind === where.kind);
        return Promise.resolve(list[0] || null);
      }),
      findMany: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbMediaItems];
        if (where?.OR) {
          list = list.filter((m) =>
            where.OR.some((cond: any) => {
              if (cond.base_normalized_title && cond.kind) {
                return m.base_normalized_title === cond.base_normalized_title && m.kind === cond.kind;
              }
              if (cond.normalized_title && cond.kind) {
                return m.normalized_title === cond.normalized_title && m.kind === cond.kind;
              }
              return false;
            })
          );
        }
        return Promise.resolve(list);
      }),
      create: vi.fn().mockImplementation(({ data }) => {
        const id = data.id || `mi_${Date.now()}_${Math.random()}`;
        const newMi = { ...data, id };
        dbMediaItems.push(newMi);
        return Promise.resolve(newMi);
      }),
      deleteMany: vi.fn().mockImplementation(() => {
        dbMediaItems = [];
        return Promise.resolve({ count: 0 });
      }),
    },
    mediaEpisode: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const key = where?.media_item_id_season_number_episode_number;
        if (!key) return Promise.resolve(null);
        const found = dbMediaEpisodes.find(
          (me) =>
            me.media_item_id === key.media_item_id &&
            me.season_number === key.season_number &&
            me.episode_number === key.episode_number
        );
        if (!found) return Promise.resolve(null);
        return Promise.resolve({
          ...found,
          links: dbSourceLinks.filter((l) => l.media_episode_id === found.id),
        });
      }),
      upsert: vi.fn().mockImplementation(({ where, create }) => {
        const key = where?.media_item_id_season_number_episode_number;
        let found = dbMediaEpisodes.find(
          (me) =>
            me.media_item_id === key.media_item_id &&
            me.season_number === key.season_number &&
            me.episode_number === key.episode_number
        );
        if (!found) {
          found = {
            id: `me_${Date.now()}_${Math.random()}`,
            media_item_id: create.media_item_id,
            season_number: create.season_number,
            episode_number: create.episode_number,
          };
          dbMediaEpisodes.push(found);
        }
        return Promise.resolve(found);
      }),
      aggregate: vi.fn().mockImplementation(() => {
        const max = dbMediaEpisodes.reduce((m, e) => Math.max(m, e.season_number || 1), 1);
        return Promise.resolve({ _max: { season_number: max } });
      }),
    },
    sourceLink: {
      findFirst: vi.fn().mockImplementation(({ where }) => {
        let list = [...dbSourceLinks];
        if (where?.url) list = list.filter((l) => l.url === where.url);
        if (where?.source_site) list = list.filter((l) => l.source_site === where.source_site);
        if (where?.media_episode) {
          const meCond = where.media_episode;
          const matchingEpisodes = dbMediaEpisodes.filter(
            (me) =>
              (!meCond.media_item_id || me.media_item_id === meCond.media_item_id) &&
              (meCond.season_number === undefined || me.season_number === meCond.season_number) &&
              (meCond.episode_number === undefined || me.episode_number === meCond.episode_number)
          );
          const meIds = new Set(matchingEpisodes.map((me) => me.id));
          list = list.filter((l) => meIds.has(l.media_episode_id));
        }
        return Promise.resolve(list[0] || null);
      }),
      create: vi.fn().mockImplementation(({ data }) => {
        const id = data.id || `sl_${Date.now()}_${Math.random()}`;
        const newSl = { ...data, id };
        dbSourceLinks.push(newSl);
        return Promise.resolve(newSl);
      }),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("./metadataBackfill", () => ({
  enqueueShowBackfill: vi.fn(),
  showNeedsBackfill: vi.fn().mockReturnValue(false),
}));

vi.mock("./metadataEngine", () => ({
  enrichUniversalMetadata: vi.fn().mockResolvedValue(null),
  cleanQueryTitle: (t: string) => t,
  parseTitleQuery: (t: string) => ({ baseTitle: t, season: 1 }),
}));

import {
  saveShowWithDeduplication,
  quickSyncKnownShow,
  syncEpisodeSources,
  resetEnqueuedSourceKeys,
} from "./showService";
import { drainWriteBuffer } from "./writeBuffer";

describe("showService - Behavioral and Deduplication Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbShows = [];
    dbEpisodes = [];
    dbMediaItems = [];
    dbMediaEpisodes = [];
    dbSourceLinks = [];
    resetEnqueuedSourceKeys();
  });

  // 1. Misma URL en episodios diferentes se guarda en ambos
  it("misma URL en episodios diferentes se guarda en ambos", async () => {
    const mediaItemId = "mi_shared_url";
    const sharedUrl = "https://stream.provider.com/common_video.mp4";

    const addedEp1 = await syncEpisodeSources(mediaItemId, 1, 1, [{ url: sharedUrl, source_site: "cinecalidad" }], "cinecalidad");
    const addedEp2 = await syncEpisodeSources(mediaItemId, 1, 2, [{ url: sharedUrl, source_site: "cinecalidad" }], "cinecalidad");

    expect(addedEp1).toBe(1);
    expect(addedEp2).toBe(1);

    await drainWriteBuffer();

    // Deben existir 2 MediaEpisode y 2 SourceLink
    expect(dbMediaEpisodes.length).toBe(2);
    expect(dbSourceLinks.length).toBe(2);
    expect(dbSourceLinks[0].url).toBe(sharedUrl);
    expect(dbSourceLinks[1].url).toBe(sharedUrl);
    expect(dbSourceLinks[0].media_episode_id).not.toBe(dbSourceLinks[1].media_episode_id);
  });

  // 2. Mismo episodio + sitio + URL es idempotente
  it("mismo episodio + sitio + URL es idempotente", async () => {
    const mediaItemId = "mi_idempotent";
    const streamUrl = "https://stream.provider.com/video1.mp4";

    const firstRun = await syncEpisodeSources(mediaItemId, 1, 1, [{ url: streamUrl, source_site: "animeflv" }], "animeflv");
    expect(firstRun).toBe(1);

    // Segunda pasada antes del drain
    const secondRunBeforeDrain = await syncEpisodeSources(mediaItemId, 1, 1, [{ url: streamUrl, source_site: "animeflv" }], "animeflv");
    expect(secondRunBeforeDrain).toBe(0);

    // Drenar hacia DB
    await drainWriteBuffer();

    // Tercera pasada después del drain
    const thirdRunAfterDrain = await syncEpisodeSources(mediaItemId, 1, 1, [{ url: streamUrl, source_site: "animeflv" }], "animeflv");
    expect(thirdRunAfterDrain).toBe(0);

    expect(dbSourceLinks.length).toBe(1);
  });

  // 3. Dos source_site distintos en un episodio producen dos SourceLink
  it("dos source_site distintos en un episodio producen dos SourceLink", async () => {
    const mediaItemId = "mi_multisite";
    const url1 = "https://server1.com/v.mp4";
    const url2 = "https://server2.com/v.mp4";

    const added = await syncEpisodeSources(
      mediaItemId,
      1,
      1,
      [
        { url: url1, source_site: "cinecalidad" },
        { url: url2, source_site: "lamovie" },
      ],
      "cinecalidad"
    );

    expect(added).toBe(2);
    await drainWriteBuffer();

    expect(dbSourceLinks.length).toBe(2);
    expect(dbSourceLinks.map((s) => s.source_site).sort()).toEqual(["cinecalidad", "lamovie"].sort());
  });

  // 4. detected_streams de una película llegan a SourceLink
  it("detected_streams de una película llegan a SourceLink", async () => {
    const res = await saveShowWithDeduplication({
      title: "Interstellar",
      content_type: "movie",
      source_site: "cinecalidad",
      detected_streams: [
        "https://stream1.cinecalidad.am/play1.mp4",
        "https://stream2.cinecalidad.am/play2.mp4",
      ],
    });

    expect(res.isDuplicate).toBe(false);
    expect(res.episodesAdded).toBe(1);
    expect(res.sourcesAdded).toBe(2);

    await drainWriteBuffer();

    expect(dbSourceLinks.length).toBe(2);
    expect(dbSourceLinks.map((s) => s.url)).toContain("https://stream1.cinecalidad.am/play1.mp4");
    expect(dbSourceLinks.map((s) => s.url)).toContain("https://stream2.cinecalidad.am/play2.mp4");
  });

  // 5. Repetir la pasada no duplica enlaces
  it("repetir la pasada no duplica enlaces", async () => {
    const showInput = {
      title: "Attack on Titan",
      content_type: "anime",
      source_site: "animeflv",
      episodes: [
        {
          number: 1,
          title: "Ep 1",
          url: "https://animeflv.net/ver/aot-1",
          sources: [
            { url: "https://stream.server.com/aot-1.mp4", source_site: "animeflv" },
          ],
        },
      ],
    };

    const run1 = await saveShowWithDeduplication(showInput);
    expect(run1.episodesAdded).toBe(1);
    expect(run1.sourcesAdded).toBeGreaterThanOrEqual(1);

    await drainWriteBuffer();
    const sourceLinksCountAfterRun1 = dbSourceLinks.length;

    // Pasada 2: quickSyncKnownShow sobre la misma obra
    const run2 = await quickSyncKnownShow(run1.show.id, {
      title: "Attack on Titan",
      episodes: showInput.episodes,
      source_site: "animeflv",
    });

    expect(run2.added).toBe(0);
    expect(run2.sourcesAdded).toBe(0);

    await drainWriteBuffer();
    expect(dbSourceLinks.length).toBe(sourceLinksCountAfterRun1);
  });

  // 6. Dos aliases distintos con el mismo tmdb_id convergen
  it("dos aliases distintos con el mismo tmdb_id convergen en la misma obra", async () => {
    // Alias 1
    const res1 = await saveShowWithDeduplication({
      title: "Kaguya-sama: Love Is War Latino",
      content_type: "anime",
      tmdb_id: 83097,
      source_site: "animeflv",
      episodes: [{ number: 1, title: "Ep 1", url: "https://siteA.com/ep1" }],
    });

    expect(res1.isDuplicate).toBe(false);
    expect(res1.show.title).toBe("Kaguya-sama: Love Is War");

    await drainWriteBuffer();

    // Alias 2 con nombre diferente pero mismo tmdb_id
    const res2 = await saveShowWithDeduplication({
      title: "Kaguya Wants to be Confessed To",
      content_type: "anime",
      tmdb_id: 83097,
      source_site: "tioanime",
      episodes: [{ number: 1, title: "Ep 1", url: "https://siteB.com/ep1" }],
    });

    expect(res2.isDuplicate).toBe(true);
    expect(res2.show.id).toBe(res1.show.id);
  });
});
