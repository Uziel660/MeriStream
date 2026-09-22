import { describe, expect, it, vi, beforeEach } from "vitest";
import { EmbedResolvers } from "./resolvers";
import { PlaybackSessionStore } from "./playbackSessions";
import { ResolutionCoordinator, ResolutionLeaseCache } from "./deliveryPlanner";
import { classifySourceKind } from "./resolutionMetadata";
import { buildNormalizedEpisodes, syncEpisodeSources } from "./showService";
import { prisma } from "./db";
import { resetWriteBufferForTesting } from "./writeBuffer";

describe("Trabajo 1 — Pruebas obligatorias de fuentes canónicas y resolución JIT", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetWriteBufferForTesting();
  });

  // 1. Importar página → embed → HLS firmado conserva página/embed como fuente canónica.
  it("1. Importar página → embed → HLS firmado conserva página/embed como fuente canónica", async () => {
    vi.spyOn(prisma.mediaEpisode, "upsert").mockResolvedValue({ id: "ep-1" } as any);
    vi.spyOn(prisma.sourceLink, "findFirst").mockResolvedValue(null);

    const sources = [
      { url: "https://www3.animeflv.net/ver/frieren-1", source_site: "animeflv" },
      { url: "https://vimeos.net/embed-renewable123.html", source_site: "animeflv" },
      { url: "https://s1.vimeos.net/master.m3u8?s=1800000000&e=3600", source_site: "animeflv" },
    ];

    const added = await syncEpisodeSources("media-item-1", 1, 1, sources, "animeflv");

    // Conserva página y embed (2 fuentes canónicas), descartando el HLS firmado efímero
    expect(added).toBe(2);
  });

  // 2. Importar HLS firmado sin origen no lo promueve a fuente permanente.
  it("2. Importar HLS firmado sin origen no lo promueve a fuente permanente", async () => {
    vi.spyOn(prisma.mediaEpisode, "upsert").mockResolvedValue({ id: "ep-1" } as any);
    vi.spyOn(prisma.sourceLink, "findFirst").mockResolvedValue(null);

    const sources = [
      { url: "https://s1.vimeos.net/master.m3u8?s=1800000000&e=3600", source_site: "animeflv", source_kind: "page" as const },
      { url: "https://cdn.example.com/master.m3u8?expires=1800000000", source_site: "unknown" },
      { url: "https://edge.acek-cdn.com/master.m3u8?t=opaque-signature", source_site: "unknown" },
    ];

    const added = await syncEpisodeSources("media-item-2", 1, 1, sources, "unknown");

    // Ningún HLS firmado efímero se promueve a fuente canónica permanente
    expect(added).toBe(0);
  });

  it("2b. Un HLS efímero tampoco queda como source_url legacy", () => {
    const signedUrl = "https://s1.vimeos.net/master.m3u8?s=1800000000&e=3600";

    expect(buildNormalizedEpisodes({ title: "Solo firma", detected_streams: [signedUrl] }, "movie"))
      .toEqual([]);

    const canonicalPage = "https://catalog.example/watch/solo-firma";
    const episodes = buildNormalizedEpisodes({
      title: "Con origen",
      detected_streams: [signedUrl],
      sources: [{ url: canonicalPage, source_site: "catalog" }],
    }, "movie");

    expect(episodes).toHaveLength(1);
    expect(episodes[0].url).toBe(canonicalPage);
    expect(episodes[0].sources.map((source) => source.url)).toEqual([canonicalPage]);
  });

  it("2c. Episodios de quick-sync comparten el guard canónico", () => {
    const signedUrl = "https://edge.example/master.m3u8?expires=1800000000";
    expect(buildNormalizedEpisodes({
      title: "Quick sync",
      category: "series",
      episodes: [{ number: 1, url: signedUrl, sources: [{ url: signedUrl, source_kind: "page" }] }],
    }, "series")).toEqual([]);
  });

  it("2d. Normaliza episodios cero basados en catálogos a partir de uno", () => {
    const episodes = buildNormalizedEpisodes({
      title: "Catálogo indexado desde cero",
      category: "anime",
      episodes: [
        { number: 0, url: "https://latanime.org/ver/obra-episodio-0" },
        { number: 2, url: "https://latanime.org/ver/obra-episodio-2" },
      ],
    }, "latanime");

    expect(episodes.map((episode) => episode.number)).toEqual([1, 2]);
  });

  // 3. HLS s+e vencido nunca crea sesión.
  it("3. HLS s+e vencido nunca crea sesión", async () => {
    const expiredStart = 1_600_000_000;
    const ttl = 120;
    const expiredUrl = `https://s1.vimeos.net/master.m3u8?s=${expiredStart}&e=${ttl}`;
    const now = (expiredStart + ttl + 100) * 1000;

    const meta = await EmbedResolvers.resolveWithMeta(expiredUrl);
    expect(meta.resolved).toBe(false);
    expect(meta.is_proxyable).toBe(false);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.failure_reason).toBe("expired_without_locator");

    const store = new PlaybackSessionStore({ now: () => now });
    expect(() => store.createFromResolved(expiredUrl, meta)).toThrow();
  });

  // 4. HLS s+e vigente sí crea sesión proxy corta aunque is_refreshable=false.
  it("4. HLS s+e vigente sí crea sesión proxy corta aunque is_refreshable=false", async () => {
    const futureStart = 1_900_000_000;
    const ttl = 3600;
    const validUrl = `https://s1.vimeos.net/master.m3u8?s=${futureStart}&e=${ttl}`;
    const now = (futureStart + 100) * 1000;

    const store = new PlaybackSessionStore({ now: () => now });
    const session = await store.create(validUrl);

    expect(session.current.resolved).toBe(true);
    expect(session.current.is_proxyable).toBe(true);
    expect(session.current.is_refreshable).toBe(false);
    expect(session.current.canonical_locator).toBeUndefined();
    expect(session.current.expires_at).toBe((futureStart + ttl) * 1000);
  });

  // 5. Fuente estable sin firma sigue funcionando.
  it("5. Fuente estable sin firma sigue funcionando", async () => {
    const stableUrl = "https://cdn.example.com/archive/movie.mp4";
    const meta = await EmbedResolvers.resolveWithMeta(stableUrl);

    expect(meta.resolved).toBe(true);
    expect(meta.type).toBe("direct");
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(true);
    expect(meta.canonical_locator).toBe(stableUrl);

    const store = new PlaybackSessionStore({ now: () => 100 });
    const session = store.createFromResolved(stableUrl, meta);
    expect(session.original_url).toBe(stableUrl);
    expect(session.current.canonical_locator).toBe(stableUrl);
  });

  // 6. Dos resoluciones simultáneas del mismo locator realizan un solo trabajo.
  it("6. Dos resoluciones simultáneas del mismo locator realizan un solo trabajo", async () => {
    let resolverCalls = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    const coordinator = new ResolutionCoordinator(async (locator) => {
      resolverCalls++;
      await gate;
      return {
        url: "https://cdn.example.com/stream.m3u8",
        original_url: locator,
        canonical_locator: locator,
        resolved: true,
        type: "direct",
        provider: "TestProvider",
        is_proxyable: true,
        is_refreshable: true,
        resolution_id: "res-singleflight",
        generation: "gen-1",
      };
    });

    const promise1 = coordinator.resolve("https://vimeos.net/embed-singleflight.html");
    const promise2 = coordinator.resolve("https://vimeos.net/embed-singleflight.html");

    releaseGate();
    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(resolverCalls).toBe(1);
    expect(result1.resolution_id).toBe(result2.resolution_id);
    expect(result1.url).toBe("https://cdn.example.com/stream.m3u8");
  });

  // 7. La caché y las sesiones respetan sus límites.
  it("7. La caché y las sesiones respetan sus límites", () => {
    let now = 1000;
    const cache = new ResolutionLeaseCache({ maxEntries: 2, now: () => now });

    const item = (id: string) => ({
      url: `https://cdn.example.com/${id}.m3u8`,
      original_url: `https://embed.example.com/${id}`,
      canonical_locator: `https://embed.example.com/${id}`,
      resolved: true,
      type: "direct" as const,
      provider: "Test",
      is_proxyable: true,
      is_refreshable: true,
      resolution_id: id,
      refresh_after: now + 50_000,
      expires_at: now + 100_000,
    });

    cache.put(item("res-1"));
    cache.put(item("res-2"));
    expect(cache.size).toBe(2);

    // Acceder a res-1 para actualizar LRU
    expect(cache.get("res-1", "https://embed.example.com/res-1")).toBeDefined();

    // Insertar un 3er elemento debe desalojar res-2 (el menos recientemente usado)
    cache.put(item("res-3"));
    expect(cache.size).toBe(2);
    expect(cache.get("res-1", "https://embed.example.com/res-1")).toBeDefined();
    expect(cache.get("res-3", "https://embed.example.com/res-3")).toBeDefined();
    expect(cache.get("res-2", "https://embed.example.com/res-2")).toBeUndefined();

    // PlaybackSessionStore límites
    const store = new PlaybackSessionStore({ maxSessions: 2, now: () => now });
    const s1 = store.createFromResolved("https://embed.example/1", item("res-1"));
    now++;
    const s2 = store.createFromResolved("https://embed.example/2", item("res-2"));
    now++;
    // Acceder a s1 para actualizar LRU
    expect(store.get(s1.id)).toBeDefined();
    now++;
    const s3 = store.createFromResolved("https://embed.example/3", item("res-3"));

    expect(store.stats().sessions).toBe(2);
    expect(store.get(s1.id)).toBeDefined();
    expect(store.get(s3.id)).toBeDefined();
    expect(store.get(s2.id)).toBeUndefined();
  });

  // 8. La lectura de filas legacy no lanza excepciones por metadatos ausentes.
  it("8. La lectura de filas legacy no lanza excepciones por metadatos ausentes", async () => {
    const legacyShowWithoutMetadata = {
      id: "legacy-show-1",
      mal_id: null,
      anilist_id: null,
      tmdb_id: null,
      title: "Show Legacy Sin Metadata",
      original_title: null,
      japanese_title: null,
      english_title: null,
      normalized_title: "show legacy sin metadata",
      base_normalized_title: null,
      description: "",
      poster_url: null,
      banner_url: null,
      poster_path: null,
      backdrop_path: null,
      category: "",
      rating: 0,
      year: 0,
      status: "",
      genres: "",
      source: "",
      created_at: new Date(),
      updated_at: new Date(),
      episodes: [
        {
          id: "legacy-ep-1",
          show_id: "legacy-show-1",
          title: "Episodio 1",
          episode_number: 1,
          source_url: "",
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    };

    vi.spyOn(prisma.show, "findUnique").mockResolvedValue(legacyShowWithoutMetadata as any);
    vi.spyOn(prisma.show, "findMany").mockResolvedValue([legacyShowWithoutMetadata] as any);

    const { getShowByIdFromDb, getShowsFromDb } = await import("./showService");

    let singleShowResult: any;
    let listShowsResult: any;

    expect(async () => {
      singleShowResult = await getShowByIdFromDb("legacy-show-1");
    }).not.toThrow();

    expect(async () => {
      listShowsResult = await getShowsFromDb();
    }).not.toThrow();

    const fetched = await getShowByIdFromDb("legacy-show-1");
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe("Show Legacy Sin Metadata");
    expect(fetched?.episodes).toHaveLength(1);
  });
});
