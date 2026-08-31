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
  pauseVerification,
  resumeVerification,
  stopVerification,
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

  it("un anime con un episodio y streams conserva su episodio, no se vuelve película", async () => {
    mockCatalogItems = [{ title: "Anime corto", url: "http://site/anime-corto", kind: "anime" }];
    mockAnalysisResults = {
      "http://site/anime-corto": {
        title: "Anime corto",
        content_type: "anime",
        tmdb_id: 202,
        detected_streams: ["https://cdn.example/anime-corto.mp4"],
        episodes: [{ number: 1, title: "Episodio especial", url: "https://site.example/ep-1" }],
      },
    };

    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);

    const { saveShowWithDeduplication } = await import("./showService");
    const input = vi.mocked(saveShowWithDeduplication).mock.calls[0][0] as any;
    expect(input.content_type).toBe("anime");
    expect(input.episodes[0]).toMatchObject({ number: 1, title: "Episodio especial" });
    expect(input.episodes[0].title).not.toBe("Película Completa");
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
    mockCatalogItems = [
      { title: "D1", url: "http://d1" },
      { title: "D2", url: "http://d2" },
    ];
    const { extractCatalogListing } = await import("./universalScraper");

    // metadata only
    runVerification({ trigger: "manual", mode: "metadata", limit: 1 });
    await waitForStatus((s) => !s.running);
    expect(vi.mocked(extractCatalogListing)).not.toHaveBeenCalled();

    // full
    runVerification({ trigger: "manual", mode: "full", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);
    expect(vi.mocked(extractCatalogListing)).toHaveBeenCalledWith("https://www3.animeflv.net/browse");
    expect(getVerificationStatus().progress.total).toBe(1);
  });

  // 8. MediaItem huérfano
  it("un MediaItem huérfano (sin Show) se importa vía saveShowWithDeduplication y no llama quickSyncKnownShow con el ID del MediaItem", async () => {
    mockDbShows = []; // No existe Show
    mockDbMediaItems = [{ id: "mi-orphan-99", title: "Orphan Show", tmdb_id: 777 }];
    mockCatalogItems = [{ title: "Orphan Show", url: "http://site/orphan" }];
    mockAnalysisResults = {
      "http://site/orphan": {
        title: "Orphan Show",
        tmdb_id: 777,
        episodes: [{ number: 1, title: "Ep 1", url: "http://site/orphan/ep1" }],
      },
    };

    const { saveShowWithDeduplication, quickSyncKnownShow } = await import("./showService");

    runVerification({ trigger: "manual", platforms: ["animeflv"], limit: 1 });
    await waitForStatus((s) => !s.running);

    // Debe llamar a saveShowWithDeduplication para crear el Show faltante
    expect(saveShowWithDeduplication).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Orphan Show", tmdb_id: 777 })
    );
    // NUNCA debe llamar quickSyncKnownShow con el ID del MediaItem
    expect(quickSyncKnownShow).not.toHaveBeenCalledWith("mi-orphan-99", expect.anything());
  });

  // 9. Configuración y validaciones
  describe("Validaciones de configuración y alcance", () => {
    it("rechaza plataformas sin URL de catálogo válida", async () => {
      const { updateVerificationConfig } = await import("./verificationWorker");
      await expect(
        updateVerificationConfig({ platforms: ["plataforma_inexistente_xyz"] })
      ).rejects.toThrow("no tiene una URL de catálogo válida configurada");
    });

    it("rechaza categorías inválidas", async () => {
      const { updateVerificationConfig } = await import("./verificationWorker");
      await expect(
        updateVerificationConfig({ category: "categoria_inventada_123" })
      ).rejects.toThrow("Categoría inválida");
    });

    it("rechaza alcances incompletos y URLs de catálogo que no sean HTTP(S)", async () => {
      const { updateVerificationConfig } = await import("./verificationWorker");
      await expect(
        updateVerificationConfig({ scope_mode: "platforms", platforms: [] })
      ).rejects.toThrow("requiere al menos una plataforma");
      await expect(
        updateVerificationConfig({ scope_mode: "category", category: null })
      ).rejects.toThrow("'category' es requerida");
      await expect(
        updateVerificationConfig({ catalog_urls_by_platform: { sitio_inseguro: "javascript:alert(1)" } })
      ).rejects.toThrow("URL inválida");
    });

    it("la ejecución manual respeta el alcance guardado en la configuración cuando no se pasan overrides", async () => {
      const { updateVerificationConfig } = await import("./verificationWorker");
      const { extractCatalogListing } = await import("./universalScraper");

      // Guardamos configuración con scope de plataforma cinecalidad
      await updateVerificationConfig({
        scope_mode: "platforms",
        platforms: ["cinecalidad"],
      });

      mockCatalogItems = [{ title: "Peli Cinecalidad", url: "https://www.cinecalidad.am/peli" }];

      // Ejecución manual sin pasar platforms
      runVerification({ trigger: "manual", mode: "full", limit: 1 });
      await waitForStatus((s) => !s.running);

      expect(vi.mocked(extractCatalogListing)).toHaveBeenCalledWith("https://www.cinecalidad.am/");

      // Restaurar config
      await updateVerificationConfig({
        scope_mode: "all",
        platforms: [],
      });
    });
  });

  describe("Controles interactivos de verificación (Pausa, Reanudación, Detención)", () => {
    it("pauseVerification, resumeVerification y stopVerification operan correctamente", async () => {
      // 1. Pausar cuando no hay nada corriendo
      const pauseWhenIdle = pauseVerification();
      expect(pauseWhenIdle.ok).toBe(false);

      // 2. Iniciar y pausar
      mockCatalogItems = [
        { title: "Item 1", url: "http://site/item1" },
        { title: "Item 2", url: "http://site/item2" },
      ];
      runVerification({ trigger: "manual", mode: "full", platforms: ["animeflv"], limit: 5 });
      const pauseResult = pauseVerification();
      expect(pauseResult.ok).toBe(true);
      expect(getVerificationStatus().paused).toBe(true);

      // 3. Reanudar
      const resumeResult = resumeVerification();
      expect(resumeResult.ok).toBe(true);
      expect(getVerificationStatus().paused).toBe(false);

      // 4. Detener
      const stopResult = stopVerification();
      expect(stopResult.ok).toBe(true);
      await waitForStatus((s) => !s.running);
      expect(getVerificationStatus().running).toBe(false);
    });
  });

  describe("Reconciliación dry-run", () => {
    it("reconcileSequelsByTmdb dry-run por defecto no escribe cambios", async () => {
      const result = await reconcileSequelsByTmdb({});
      expect(result.dry_run).toBe(true);
      expect(result.merges_done).toBe(0);
    });
  });
});
