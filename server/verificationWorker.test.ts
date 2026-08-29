// server/verificationWorker.test.ts
// ══════════════════════════════════════════════════════════════════
// Tests de comportamiento del sistema de verificación refactorizado.
// Mockea Prisma y dependencias externas para aislar la lógica del worker.
// ══════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────

// Variables de estado para mocks
let mockDbShows: any[] = [];
let mockDbEpisodes: any[] = [];
let mockDbMediaItems: any[] = [];
let mockDbSourceLinks: any[] = [];

vi.mock("./db", () => ({
  normalizeTitle: (t: string) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, ""),
  prisma: {
    show: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(mockDbShows)),
      findUnique: vi.fn().mockImplementation(({ where }) => Promise.resolve(mockDbShows.find((s) => s.id === where.id) || null)),
      findFirst: vi.fn().mockImplementation(({ where }) => {
        if (where?.tmdb_id !== undefined) {
          return Promise.resolve(mockDbShows.find((s) => s.tmdb_id === where.tmdb_id) || null);
        }
        return Promise.resolve(mockDbShows[0] || null);
      }),
      groupBy: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      create: vi.fn(),
    },
    episode: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(mockDbEpisodes)),
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(mockDbEpisodes[0] || null)),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      createMany: vi.fn(),
    },
    mediaItem: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(mockDbMediaItems)),
      findFirst: vi.fn().mockImplementation(() => Promise.resolve(mockDbMediaItems[0] || null)),
      delete: vi.fn(),
    },
    mediaEpisode: {
      aggregate: vi.fn().mockResolvedValue({ _max: { season_number: 0 } }),
    },
    sourceLink: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(mockDbSourceLinks)),
      findFirst: vi.fn().mockImplementation(({ where }) => {
        return Promise.resolve(mockDbSourceLinks.find((s) => s.url === where.url) || null);
      }),
    },
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("./metadataBackfill", () => ({
  backfillShow: vi.fn().mockResolvedValue({ title: "Test", changed: [] }),
  showNeedsBackfill: vi.fn().mockReturnValue(false),
}));

// Mock controlable para el scraper
let mockCatalogItems: any[] = [];
let mockAnalysisResults: Record<string, any> = {};

vi.mock("./universalScraper", () => ({
  extractCatalogListing: vi.fn().mockImplementation(() => Promise.resolve(mockCatalogItems)),
  analyzeUniversalUrl: vi.fn().mockImplementation((url: string) => {
    return Promise.resolve(
      mockAnalysisResults[url] || {
        title: "Test",
        episodes: [],
        tmdb_id: null,
      }
    );
  }),
}));

vi.mock("./showService", () => ({
  saveShowWithDeduplication: vi.fn().mockImplementation((input) => {
    const existing = mockDbShows.find((s) => (input.tmdb_id && s.tmdb_id === input.tmdb_id) || s.title === input.title);
    if (existing) {
      return Promise.resolve({
        show: existing,
        isDuplicate: true,
        episodesAdded: 0,
        sourcesAdded: input.episodes?.length || 1,
        season: 1,
      });
    }
    const newShow = {
      id: `s_${Date.now()}_${Math.random()}`,
      title: input.title,
      tmdb_id: input.tmdb_id,
      _count: { episodes: input.episodes?.length || 1 },
    };
    mockDbShows.push(newShow);
    return Promise.resolve({
      show: newShow,
      isDuplicate: false,
      episodesAdded: input.episodes?.length || 1,
      sourcesAdded:
        (input.detected_streams?.length || 0) +
        (input.episodes?.reduce((acc: number, ep: any) => acc + (ep.sources?.length || (ep.url ? 1 : 0)), 0) || 0),
      season: 1,
    });
  }),
  quickSyncKnownShow: vi.fn().mockImplementation((_id, data) =>
    Promise.resolve({
      added: data.episodes?.length || 0,
      sourcesAdded: data.episodes?.reduce((acc: number, ep: any) => acc + (ep.sources?.length || 0), 0) || 0,
    })
  ),
}));

vi.mock("./writeBuffer", () => ({
  enqueueWrite: vi.fn(),
}));

// Suppress filesystem config reads
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn().mockReturnValue("{}"),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ── Imports (after mocks) ────────────────────────────────────────

import {
  runVerification,
  getVerificationStatus,
} from "./verificationWorker";
import { reconcileSequelsByTmdb } from "./reconcileCatalog";

// ── Utils ────────────────────────────────────────────────────────

const waitForStatus = (condition: (status: any) => boolean, timeout = 2000) => {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (condition(getVerificationStatus())) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error("Timeout waiting for status condition"));
      }
    }, 50);
  });
};

// ── Tests ────────────────────────────────────────────────────────

describe("Verification Worker - Behavioral Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbShows = [];
    mockDbEpisodes = [];
    mockDbMediaItems = [];
    mockDbSourceLinks = [];
    mockCatalogItems = [];
    mockAnalysisResults = {};
  });

  // 1. Lock
  it("espera a que status.running vuelva a false entre pruebas (lock)", async () => {
    const r1 = runVerification({ trigger: "manual" });
    expect(r1.started).toBe(true);

    // Concurrencia falla
    const r2 = runVerification({ trigger: "manual" });
    expect(r2.started).toBe(false);
    expect(r2.reason).toBe("already_running");

    // Esperar a que termine para estado limpio
    await waitForStatus((s) => !s.running);
  });

  // 2. Convergencia TMDB con 2 aliases reales
  it("dos aliases diferentes con el mismo tmdb_id convergen en una obra", async () => {
    mockCatalogItems = [
      { title: "Kaguya Latino", url: "http://siteA/kaguya" },
      { title: "Kaguya-sama: Love Is War", url: "http://siteB/kaguya" },
    ];
    mockAnalysisResults = {
      "http://siteA/kaguya": {
        title: "Kaguya Latino",
        tmdb_id: 999,
        episodes: [{ number: 1, title: "Ep 1", url: "http://siteA/ep1" }],
      },
      "http://siteB/kaguya": {
        title: "Kaguya-sama: Love Is War",
        tmdb_id: 999,
        episodes: [{ number: 1, title: "Ep 1", url: "http://siteB/ep1" }],
      },
    };

    // Run con 2 items
    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 2 });
    await waitForStatus((s) => !s.running);
    const st = getVerificationStatus();

    expect(st.progress.total).toBe(2);
    expect(st.progress.done).toBe(2);
    expect(st.progress.new_works).toBe(1);
    // El segundo item converge por tmdb_id (detectado como known en findKnownWork o merged por dedup)
    expect(st.progress.known + st.progress.works_merged).toBeGreaterThanOrEqual(1);
  });

  // 3. Multi-source
  it("dos sitios para el mismo episodio crean dos SourceLink", async () => {
    mockCatalogItems = [
      { title: "ShowA", url: "http://site/a" },
    ];
    mockAnalysisResults = {
      "http://site/a": {
        title: "ShowA",
        tmdb_id: 101,
        detected_streams: ["https://stream1.com/a.mp4", "https://stream2.com/a.mp4"],
        episodes: [{
          number: 1,
          title: "Ep 1",
          url: "http://site/ep1",
        }],
      },
    };

    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);
    const st = getVerificationStatus();
    expect(st.progress.sources_added).toBeGreaterThanOrEqual(2);
  });

  // 4. Idempotencia
  it("repetir la pasada no duplica SourceLink ni episodios", async () => {
    mockCatalogItems = [
      { title: "ShowB", url: "http://site/b" },
    ];
    mockAnalysisResults = {
      "http://site/b": {
        title: "ShowB",
        tmdb_id: null,
        episodes: [{ number: 1, title: "Ep 1", url: "http://site/ep1" }],
      },
    };

    // Pasada 1
    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);
    let st = getVerificationStatus();
    expect(st.progress.new_works).toBe(1);

    // Simulamos que ya está en DB para la segunda pasada
    mockDbShows = [{ id: "s1", title: "ShowB", _count: { episodes: 1 } }];
    mockDbSourceLinks = [{ url: "http://site/ep1" }];
    const { quickSyncKnownShow } = await import("./showService");
    vi.mocked(quickSyncKnownShow).mockResolvedValueOnce({ added: 0, sourcesAdded: 0 } as any);

    // Pasada 2
    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);
    st = getVerificationStatus();
    expect(st.progress.new_works).toBe(0);
    expect(st.progress.sources_added).toBe(0); // Idempotente
  });

  // 5. URL legacy intacta
  it("una URL legacy permanece intacta al añadir otra fuente", async () => {
    const { prisma } = await import("./db");

    // Worker ejecuta metadataPhase y catalogPhase.
    // Verificamos que no llama a updateMany modificando source_url.
    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);

    expect(vi.mocked(prisma.episode.updateMany)).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source_url: expect.anything() }),
      })
    );
  });

  // 6. Sin delete
  it("el flujo automático ejecutado con datos reales mockeados no llama delete", async () => {
    mockCatalogItems = [{ title: "C", url: "http://c" }];
    const { prisma } = await import("./db");

    runVerification({ trigger: "timer", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);

    expect(vi.mocked(prisma.show.delete)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.episode.delete)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.mediaItem.delete)).not.toHaveBeenCalled();
  });

  // 7. Mode override
  it("mode metadata omite catálogo y mode full lo ejecuta", async () => {
    mockCatalogItems = [{ title: "D", url: "http://d" }];
    const { extractCatalogListing } = await import("./universalScraper");

    // metadata only
    runVerification({ trigger: "manual", mode: "metadata", limit: 1 });
    await waitForStatus((s) => !s.running);
    expect(vi.mocked(extractCatalogListing)).not.toHaveBeenCalled();

    // full
    runVerification({ trigger: "manual", mode: "full", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);
    expect(vi.mocked(extractCatalogListing)).toHaveBeenCalled();
  });

  describe("Reconciliación dry-run", () => {
    it("reconcileSequelsByTmdb dry-run por defecto no escribe cambios", async () => {
      const result = await reconcileSequelsByTmdb({});
      expect(result.dry_run).toBe(true);
      expect(result.merges_done).toBe(0);
    });
  });
});
