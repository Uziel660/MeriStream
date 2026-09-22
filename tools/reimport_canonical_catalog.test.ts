// tools/reimport_canonical_catalog.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  reimportCanonicalCatalog,
  verifyBackendCanonicalContract,
  isEphemeralSignedUrl,
  saveCursorAtomic,
  loadCursor,
  CanonicalImportRecord,
} from "./reimport_canonical_catalog";
import { maskUrlTokens, classifyStreamUrl } from "./audit_stream_sources";

describe("Herramientas de Auditoría y Reimportación Canónica", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "reimport-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  const sampleRecords: CanonicalImportRecord[] = [
    {
      title: "Steins;Gate",
      kind: "anime",
      year: 2011,
      season: 1,
      episodes: [
        {
          number: 1,
          title: "Turning Point",
          canonical_sources: [
            {
              url: "https://animeflv.net/ver/steins-gate-1",
              source_site: "animeflv.net",
              source_kind: "page",
            },
            {
              url: "https://mega.nz/embed/sample-embed",
              source_site: "mega.nz",
              source_kind: "embed",
            },
            {
              url: "https://cdn.example.com/stream.m3u8?s=1700000000&e=3600&token=SECRET_AUTH_TOKEN_XYZ",
              source_site: "vimeocdn",
              source_kind: "stable_direct", // Erroneously tagged as stable direct, but is signed
            },
          ],
        },
      ],
    },
    {
      title: "Cowboy Bebop",
      kind: "anime",
      year: 1998,
      season: 1,
      episodes: [
        {
          number: 1,
          title: "Asteroid Blues",
          canonical_sources: [
            {
              url: "https://stream.example.com/video/direct_master.m3u8",
              source_site: "archive",
              source_kind: "stable_direct",
            },
          ],
        },
      ],
    },
  ];

  // 1. --dry-run no ejecuta ninguna escritura
  it("1. --dry-run no ejecuta ninguna escritura en la base de datos", async () => {
    const mockPrisma = {
      mediaItem: {
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      mediaEpisode: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      sourceLink: {
        upsert: vi.fn(),
      },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      records: sampleRecords,
      prismaClient: mockPrisma,
    });

    expect(report.dry_run).toBe(true);
    expect(report.imported_media_items).toBe(2);
    // Verified: No DB create or upsert called during dry run
    expect(mockPrisma.mediaItem.create).not.toHaveBeenCalled();
    expect(mockPrisma.mediaEpisode.create).not.toHaveBeenCalled();
    expect(mockPrisma.sourceLink.upsert).not.toHaveBeenCalled();
  });

  // 2. --apply sin contrato backend confirmado se niega a empezar
  it("2. --apply sin contrato backend confirmado se niega a empezar", async () => {
    // Missing models on prisma client
    const brokenPrisma = {
      mediaItem: null,
      $disconnect: vi.fn(),
    } as any;

    await expect(
      reimportCanonicalCatalog({
        apply: true,
        dryRun: false,
        records: sampleRecords,
        prismaClient: brokenPrisma,
      })
    ).rejects.toThrow(/Backend canonical contract is not ready/i);

    // Simulated offline/unavailable environment flag
    process.env.SIMULATE_BACKEND_CONTRACT_UNAVAILABLE = "1";
    try {
      const mockPrisma = {
        mediaItem: { findFirst: vi.fn().mockResolvedValue(null) },
        mediaEpisode: {},
        sourceLink: {},
      } as any;

      const check = await verifyBackendCanonicalContract(mockPrisma);
      expect(check.ready).toBe(false);
      expect(check.reason).toContain("SIMULATE_BACKEND_CONTRACT_UNAVAILABLE");
    } finally {
      delete process.env.SIMULATE_BACKEND_CONTRACT_UNAVAILABLE;
    }
  });

  // 3. Concurrencia mayor de 2 se recorta o rechaza
  it("3. Concurrencia mayor de 2 se recorta al máximo permitido de 2", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mockPrisma = {
      mediaItem: { findFirst: vi.fn(), create: vi.fn() },
      mediaEpisode: { findUnique: vi.fn(), create: vi.fn() },
      sourceLink: { upsert: vi.fn() },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      concurrency: 8, // Exceeds limit
      records: sampleRecords,
      prismaClient: mockPrisma,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Requested concurrency 8 exceeds maximum (2). Clamping to 2.")
    );
    expect(report.processed_records).toBe(2);
    consoleSpy.mockRestore();
  });

  // 4. Batch mayor de 50 se recorta o rechaza
  it("4. Batch mayor de 50 se recorta al máximo permitido de 50", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const mockPrisma = {
      mediaItem: { findFirst: vi.fn(), create: vi.fn() },
      mediaEpisode: { findUnique: vi.fn(), create: vi.fn() },
      sourceLink: { upsert: vi.fn() },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      batchSize: 100, // Exceeds limit
      records: sampleRecords,
      prismaClient: mockPrisma,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Requested batch-size 100 exceeds maximum (50). Clamping to 50.")
    );
    expect(report.processed_records).toBe(2);
    consoleSpy.mockRestore();
  });

  // 5. Un HLS firmado se excluye de canonical_sources
  it("5. Un HLS firmado se excluye de canonical_sources y nunca se persiste", async () => {
    const signedUrl1 = "https://vimeos.net/playlist.m3u8?s=1700000000&e=1800&token=abc123secret";
    const signedUrl2 = "https://cdn.example.com/live.m3u8?expires=1700000000&sig=abcdef";
    const stableUrl = "https://archive.org/video/master.m3u8";

    expect(isEphemeralSignedUrl(signedUrl1)).toBe(true);
    expect(isEphemeralSignedUrl(signedUrl2)).toBe(true);
    expect(isEphemeralSignedUrl(stableUrl)).toBe(false);

    const recordWithSigned: CanonicalImportRecord = {
      title: "Signed Only Test",
      kind: "movie",
      episodes: [
        {
          number: 1,
          canonical_sources: [
            {
              url: signedUrl1,
              source_site: "vimeos",
              source_kind: "stable_direct",
            },
          ],
        },
      ],
    };

    const mockPrisma = {
      mediaItem: { findFirst: vi.fn(), create: vi.fn() },
      mediaEpisode: { findUnique: vi.fn(), create: vi.fn() },
      sourceLink: { upsert: vi.fn() },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      records: [recordWithSigned],
      prismaClient: mockPrisma,
    });

    expect(report.excluded_ephemeral_sources).toBe(1);
    expect(report.imported_canonical_sources).toBe(0);
    expect(report.skipped_records).toBe(1);
  });

  // 6. Reanudar desde cursor no repite lotes confirmados
  it("6. Reanudar desde cursor no repite lotes confirmados", async () => {
    const cursorFile = path.join(tempDir, "cursor.json");

    // Save cursor simulating that item at index 0 (Steins;Gate) has already been processed
    await saveCursorAtomic(cursorFile, {
      version: 1,
      lastProcessedIndex: 0,
      lastProcessedTitle: "Steins;Gate",
      processedCount: 1,
      updatedAt: new Date().toISOString(),
    });

    const mockPrisma = {
      mediaItem: { findFirst: vi.fn(), create: vi.fn() },
      mediaEpisode: { findUnique: vi.fn(), create: vi.fn() },
      sourceLink: { upsert: vi.fn() },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      cursorFile,
      records: sampleRecords, // Contains 2 records (index 0 and index 1)
      prismaClient: mockPrisma,
    });

    // Only index 1 (Cowboy Bebop) was processed
    expect(report.processed_records).toBe(1);
    expect(report.cursor_state?.lastProcessedIndex).toBe(1);
    expect(report.cursor_state?.lastProcessedTitle).toBe("Cowboy Bebop");
  });

  // 7. Interrupción guarda cursor válido
  it("7. Interrupción guarda cursor válido y atómico", async () => {
    const cursorFile = path.join(tempDir, "cursor-interrupt.json");
    const abortController = new AbortController();

    const tenRecords: CanonicalImportRecord[] = Array.from({ length: 10 }, (_, i) => ({
      title: `Show #${i + 1}`,
      kind: "series",
      episodes: [
        {
          number: 1,
          canonical_sources: [
            {
              url: `https://example.com/embed/${i + 1}`,
              source_site: "example.com",
              source_kind: "embed",
            },
          ],
        },
      ],
    }));

    // Abort after first item
    let processed = 0;
    const mockPrisma = {
      mediaItem: { findFirst: vi.fn(), create: vi.fn() },
      mediaEpisode: { findUnique: vi.fn(), create: vi.fn() },
      sourceLink: { upsert: vi.fn() },
      $disconnect: vi.fn(),
    } as any;

    const report = await reimportCanonicalCatalog({
      dryRun: true,
      batchSize: 2,
      cursorFile,
      records: tenRecords,
      abortSignal: abortController.signal,
      prismaClient: mockPrisma,
      onProgress: () => {
        processed++;
        if (processed >= 2) {
          abortController.abort();
        }
      },
    });

    const savedCursor = await loadCursor(cursorFile);
    expect(savedCursor).not.toBeNull();
    expect(savedCursor?.version).toBe(1);
    expect(savedCursor?.lastProcessedIndex).toBeGreaterThanOrEqual(1);
    expect(savedCursor?.updatedAt).toBeDefined();
  });

  // 8. Tokens de URLs no aparecen completos en reportes
  it("8. Tokens de URLs no aparecen completos en reportes", () => {
    const rawUrl =
      "https://cdn.stream.com/hls/live.m3u8?token=SUPER_SECRET_TOKEN_99999&s=1700000000&e=3600&auth=BEARER_XYZ";
    const masked = maskUrlTokens(rawUrl);

    expect(masked).not.toContain("SUPER_SECRET_TOKEN_99999");
    expect(masked).not.toContain("BEARER_XYZ");
    expect(masked).toContain("[REDACTED]");

    const classification = classifyStreamUrl(rawUrl);
    expect(classification.category).toBe("signed_expired");
  });

  // 9. Repetir un lote conserva idempotencia
  it("9. Repetir un lote conserva idempotencia", async () => {
    // In-memory fake database to verify idempotency
    const inMemoryItems = new Map<string, any>();
    const inMemoryEpisodes = new Map<string, any>();
    const inMemoryLinks = new Map<string, any>();

    const fakePrisma = {
      mediaItem: {
        findFirst: vi.fn().mockImplementation(async (args) => {
          if (!args || !args.where) return inMemoryItems.values().next().value || null;
          const where = args.where;
          return inMemoryItems.get(`${where.normalized_title}_${where.kind}_${where.year}`) || null;
        }),
        create: vi.fn().mockImplementation(async ({ data }) => {
          const item = { id: `item_${inMemoryItems.size + 1}`, ...data };
          inMemoryItems.set(`${data.normalized_title}_${data.kind}_${data.year}`, item);
          return item;
        }),
      },
      mediaEpisode: {
        findUnique: vi.fn().mockImplementation(async ({ where }) => {
          const key = `${where.media_item_id_season_number_episode_number.media_item_id}_${where.media_item_id_season_number_episode_number.season_number}_${where.media_item_id_season_number_episode_number.episode_number}`;
          return inMemoryEpisodes.get(key) || null;
        }),
        create: vi.fn().mockImplementation(async ({ data }) => {
          const key = `${data.media_item_id}_${data.season_number}_${data.episode_number}`;
          const episode = { id: `ep_${inMemoryEpisodes.size + 1}`, ...data };
          inMemoryEpisodes.set(key, episode);
          return episode;
        }),
      },
      sourceLink: {
        upsert: vi.fn().mockImplementation(async ({ where, create, update }) => {
          const key = `${where.media_episode_id_source_site_url.media_episode_id}_${where.media_episode_id_source_site_url.source_site}_${where.media_episode_id_source_site_url.url}`;
          if (inMemoryLinks.has(key)) {
            const existing = inMemoryLinks.get(key);
            const updated = { ...existing, ...update };
            inMemoryLinks.set(key, updated);
            return updated;
          } else {
            const created = { id: `link_${inMemoryLinks.size + 1}`, ...create };
            inMemoryLinks.set(key, created);
            return created;
          }
        }),
      },
      $disconnect: vi.fn(),
    } as any;

    // Run 1: Apply batch
    await reimportCanonicalCatalog({
      apply: true,
      dryRun: false,
      records: sampleRecords,
      prismaClient: fakePrisma,
    });

    const itemsCountFirst = inMemoryItems.size;
    const episodesCountFirst = inMemoryEpisodes.size;
    const linksCountFirst = inMemoryLinks.size;

    expect(itemsCountFirst).toBe(2);
    expect(episodesCountFirst).toBe(2);
    expect(linksCountFirst).toBe(3); // 2 from Steins;Gate (page + embed), 1 from Cowboy Bebop (stable_direct)

    // Run 2: Re-apply exact same batch
    await reimportCanonicalCatalog({
      apply: true,
      dryRun: false,
      records: sampleRecords,
      prismaClient: fakePrisma,
    });

    // Verify: Count of stored entities remained EXACTLY the same (0 duplicates created)
    expect(inMemoryItems.size).toBe(itemsCountFirst);
    expect(inMemoryEpisodes.size).toBe(episodesCountFirst);
    expect(inMemoryLinks.size).toBe(linksCountFirst);
  });
});
