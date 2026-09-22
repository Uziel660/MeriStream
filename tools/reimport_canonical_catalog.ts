// tools/reimport_canonical_catalog.ts
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle, normalizeBaseTitle } from "../server/db";
import { parseStreamExpiry } from "../server/resolutionMetadata";
import { maskUrlTokens, extractHost } from "./audit_stream_sources";

export interface CanonicalSource {
  url: string;
  source_site: string;
  source_kind: "page" | "embed" | "stable_direct";
}

export interface CanonicalImportEpisode {
  number: number;
  title?: string;
  canonical_sources: CanonicalSource[];
}

export interface CanonicalImportRecord {
  title: string;
  kind: "movie" | "series" | "anime";
  /** Identidad TMDB conocida; evita crear un MediaItem paralelo por idioma. */
  tmdb_id?: number | null;
  year?: number;
  season?: number;
  episodes: CanonicalImportEpisode[];
}

export interface ReimportOptions {
  dryRun?: boolean;
  apply?: boolean;
  source?: string;
  batchSize?: number;
  concurrency?: number;
  cursorFile?: string;
  limit?: number;
  reportPath?: string;
  inputPath?: string;
  records?: CanonicalImportRecord[];
  prismaClient?: PrismaClient;
  onProgress?: (progress: {
    processed: number;
    total: number;
    currentTitle?: string;
  }) => void;
  abortSignal?: AbortSignal;
}

export interface ReimportCursorState {
  version: 1;
  lastProcessedIndex: number;
  lastProcessedTitle?: string;
  source?: string;
  processedCount: number;
  updatedAt: string;
}

export interface ReimportSummaryReport {
  dry_run: boolean;
  start_time: string;
  end_time: string;
  duration_ms: number;
  total_records_considered: number;
  processed_records: number;
  imported_media_items: number;
  imported_media_episodes: number;
  imported_canonical_sources: number;
  excluded_ephemeral_sources: number;
  skipped_records: number;
  cursor_state?: ReimportCursorState;
  errors: Array<{ title?: string; error: string }>;
}

/**
 * Checks if a stream URL has signed / temporary tokens or query parameters.
 * Signed URLs must NEVER be persisted as canonical sources.
 */
export function isEphemeralSignedUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  const { expiresAt } = parseStreamExpiry(rawUrl);
  if (expiresAt !== undefined) return true;
  return /([?&](?:s|e|exp|expires|expiry|token|jwt|h|hdnts|sig|auth)=)/i.test(rawUrl);
}

/**
 * Validates whether the backend canonical persistence contract is ready.
 * Refuses --apply if required models or database connections are unavailable.
 */
export async function verifyBackendCanonicalContract(
  prisma: PrismaClient
): Promise<{ ready: boolean; reason?: string }> {
  if (process.env.SIMULATE_BACKEND_CONTRACT_UNAVAILABLE === "1") {
    return {
      ready: false,
      reason: "Simulated unavailable backend contract (SIMULATE_BACKEND_CONTRACT_UNAVAILABLE=1)",
    };
  }

  if (!prisma || !prisma.mediaItem || !prisma.mediaEpisode || !prisma.sourceLink) {
    return {
      ready: false,
      reason: "Prisma client does not expose canonical models (MediaItem, MediaEpisode, SourceLink)",
    };
  }

  try {
    // Validate read connectivity on canonical tables without executing migrations
    await prisma.mediaItem.findFirst({ take: 1 });
    return { ready: true };
  } catch (error: any) {
    return {
      ready: false,
      reason: `Cannot query backend canonical tables: ${error?.message || error}`,
    };
  }
}

/**
 * Helper to execute an async action with bounded retries and backoff.
 */
async function withRetry<T>(
  action: () => Promise<T>,
  maxRetries = 2,
  backoffMs = 150
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await action();
    } catch (error) {
      attempt++;
      if (attempt > maxRetries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}

/**
 * Atomic write for cursor file (write to temp file then rename).
 */
export async function saveCursorAtomic(
  cursorPath: string,
  state: ReimportCursorState
): Promise<void> {
  const fullPath = path.resolve(cursorPath);
  const dir = path.dirname(fullPath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = `${fullPath}.tmp.${Date.now()}`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tempPath, fullPath);
}

/**
 * Loads cursor from disk if it exists.
 */
export async function loadCursor(
  cursorPath: string
): Promise<ReimportCursorState | null> {
  try {
    const fullPath = path.resolve(cursorPath);
    const content = await fs.readFile(fullPath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.lastProcessedIndex === "number") {
      return parsed as ReimportCursorState;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Main reimport catalog engine.
 */
export async function reimportCanonicalCatalog(
  options: ReimportOptions
): Promise<ReimportSummaryReport> {
  const startTime = Date.now();
  const isApply = Boolean(options.apply);
  const isDryRun = !isApply || Boolean(options.dryRun && !options.apply);

  // Strict constraints for ASUS T100TA
  let batchSize = options.batchSize ?? 25;
  if (batchSize > 50) {
    console.warn(`[WARN] Requested batch-size ${batchSize} exceeds maximum (50). Clamping to 50.`);
    batchSize = 50;
  } else if (batchSize < 1) {
    batchSize = 25;
  }

  let concurrency = options.concurrency ?? 1;
  if (concurrency > 2) {
    console.warn(`[WARN] Requested concurrency ${concurrency} exceeds maximum (2). Clamping to 2.`);
    concurrency = 2;
  } else if (concurrency < 1) {
    concurrency = 1;
  }

  const prisma = options.prismaClient ?? new PrismaClient();
  const shouldDisconnect = !options.prismaClient;

  // Backend contract validation before any apply execution
  if (!isDryRun) {
    const contractCheck = await verifyBackendCanonicalContract(prisma);
    if (!contractCheck.ready) {
      if (shouldDisconnect) await prisma.$disconnect();
      throw new Error(
        `[REIMPORT REJECTED] Backend canonical contract is not ready: ${contractCheck.reason}. Reimport in --apply mode cannot proceed without backend contract confirmation.`
      );
    }
  }

  // Load records from input path if provided
  let allRecords: CanonicalImportRecord[] = options.records ?? [];
  if (allRecords.length === 0 && options.inputPath) {
    const inputPath = path.resolve(options.inputPath);
    const rawData = await fs.readFile(inputPath, "utf8");
    if (inputPath.endsWith(".ndjson") || inputPath.endsWith(".jsonl")) {
      allRecords = rawData
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } else {
      allRecords = JSON.parse(rawData);
    }
  }

  // Filter by source platform if specified
  if (options.source) {
    const filterSource = options.source.toLowerCase();
    allRecords = allRecords.filter((rec) =>
      rec.episodes.some((ep) =>
        ep.canonical_sources.some(
          (cs) => cs.source_site.toLowerCase() === filterSource
        )
      )
    );
  }

  // Resume from cursor file if available
  let startIndex = 0;
  let cursorState: ReimportCursorState | undefined = undefined;
  if (options.cursorFile) {
    const loaded = await loadCursor(options.cursorFile);
    if (loaded && loaded.lastProcessedIndex >= 0) {
      startIndex = loaded.lastProcessedIndex + 1;
      cursorState = loaded;
      console.log(`[RESUME] Resuming reimport from index ${startIndex} (last title: ${loaded.lastProcessedTitle || "N/A"})`);
    }
  }

  const report: ReimportSummaryReport = {
    dry_run: isDryRun,
    start_time: new Date(startTime).toISOString(),
    end_time: "",
    duration_ms: 0,
    total_records_considered: allRecords.length,
    processed_records: 0,
    imported_media_items: 0,
    imported_media_episodes: 0,
    imported_canonical_sources: 0,
    excluded_ephemeral_sources: 0,
    skipped_records: 0,
    errors: [],
  };

  // Process records in batches
  try {
    const recordsToProcess = allRecords.slice(startIndex);
    const maxItems = options.limit ? Math.min(options.limit, recordsToProcess.length) : recordsToProcess.length;

    for (let offset = 0; offset < maxItems; offset += batchSize) {
      if (options.abortSignal?.aborted) {
        break;
      }

      const batchRecords = recordsToProcess.slice(offset, Math.min(offset + batchSize, maxItems));
      const currentBatchStartIdx = startIndex + offset;

      // Process batch with constrained concurrency (max 2)
      for (let i = 0; i < batchRecords.length; i += concurrency) {
        if (options.abortSignal?.aborted) break;

        const slice = batchRecords.slice(i, i + concurrency);
        await Promise.all(
          slice.map(async (record, subIdx) => {
            try {
              await withRetry(async () => {
                await processSingleRecord(record, isDryRun, prisma, report);
              });
              report.processed_records++;
              options.onProgress?.({
                processed: report.processed_records,
                total: maxItems,
                currentTitle: record.title,
              });
            } catch (err: any) {
              report.errors.push({
                title: record.title,
                error: err?.message || String(err),
              });
            }
          })
        );
      }

      // Update and save atomic checkpoint cursor after completing each batch
      const lastIndexInBatch = currentBatchStartIdx + batchRecords.length - 1;
      const lastRecord = batchRecords[batchRecords.length - 1];

      cursorState = {
        version: 1,
        lastProcessedIndex: lastIndexInBatch,
        lastProcessedTitle: lastRecord?.title,
        source: options.source,
        processedCount: report.processed_records,
        updatedAt: new Date().toISOString(),
      };

      if (options.cursorFile) {
        await saveCursorAtomic(options.cursorFile, cursorState);
      }
    }
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }

  const endTime = Date.now();
  report.end_time = new Date(endTime).toISOString();
  report.duration_ms = endTime - startTime;
  report.cursor_state = cursorState;

  if (options.reportPath) {
    const fullReportPath = path.resolve(options.reportPath);
    await fs.mkdir(path.dirname(fullReportPath), { recursive: true });
    await fs.writeFile(fullReportPath, JSON.stringify(report, null, 2), "utf8");
  }

  return report;
}

/**
 * Processes a single normalized CanonicalImportRecord idempotently.
 */
async function processSingleRecord(
  record: CanonicalImportRecord,
  isDryRun: boolean,
  prisma: PrismaClient,
  report: ReimportSummaryReport
): Promise<void> {
  const normTitle = normalizeTitle(record.title);
  const baseNormTitle = normalizeBaseTitle(record.title);

  // Validate and filter episodes / sources
  const validEpisodes: Array<{
    number: number;
    title?: string;
    validSources: CanonicalSource[];
  }> = [];

  for (const ep of record.episodes || []) {
    const validSources: CanonicalSource[] = [];
    for (const src of ep.canonical_sources || []) {
      // NEVER persist ephemeral signed URLs as canonical sources
      if (isEphemeralSignedUrl(src.url)) {
        report.excluded_ephemeral_sources++;
        continue;
      }

      if (src.source_kind === "page" || src.source_kind === "embed" || src.source_kind === "stable_direct") {
        validSources.push(src);
      }
    }

    if (validSources.length > 0) {
      validEpisodes.push({
        number: ep.number,
        title: ep.title,
        validSources,
      });
    }
  }

  if (validEpisodes.length === 0) {
    report.skipped_records++;
    return;
  }

  if (isDryRun) {
    // In dry-run mode, simulate and record statistics without executing DB writes
    report.imported_media_items++;
    for (const ep of validEpisodes) {
      report.imported_media_episodes++;
      report.imported_canonical_sources += ep.validSources.length;
    }
    return;
  }

  // APPLY MODE: Idempotent DB writes. TMDB es la clave primaria de identidad
  // cuando está disponible; el título/año quedan como fallback histórico.
  // También heredamos el ID de un Show legacy equivalente para que la
  // reimportación no vuelva a crear una obra paralela localizada.
  let tmdbId = Number.isInteger(record.tmdb_id) && Number(record.tmdb_id) > 0
    ? Number(record.tmdb_id)
    : null;
  if (!tmdbId) {
    const showModel = (prisma as any).show;
    if (showModel?.findFirst) {
      const show = await showModel.findFirst({
        where: {
          category: record.kind,
          OR: [{ base_normalized_title: baseNormTitle }, { normalized_title: normTitle }],
          tmdb_id: { not: null },
        },
        select: { tmdb_id: true },
        orderBy: { created_at: "asc" },
      });
      if (Number.isInteger(show?.tmdb_id) && show.tmdb_id > 0) tmdbId = show.tmdb_id;
    }
  }

  let mediaItem = tmdbId
    ? await prisma.mediaItem.findFirst({
        where: { tmdb_id: tmdbId, kind: record.kind },
        orderBy: { created_at: "asc" },
      })
    : null;
  if (!mediaItem) {
    mediaItem = await prisma.mediaItem.findFirst({
      where: {
        normalized_title: normTitle,
        kind: record.kind,
        year: record.year ?? null,
      },
    });
  }
  if (!mediaItem) {
    mediaItem = await prisma.mediaItem.findFirst({
      where: {
        base_normalized_title: baseNormTitle,
        kind: record.kind,
        ...(record.year ? { year: record.year } : {}),
      },
      orderBy: { created_at: "asc" },
    });
  }

  if (!mediaItem) {
    mediaItem = await prisma.mediaItem.create({
      data: {
        title: record.title,
        normalized_title: normTitle,
        base_normalized_title: baseNormTitle,
        kind: record.kind,
        year: record.year ?? null,
        tmdb_id: tmdbId,
      },
    });
  } else if (tmdbId && !mediaItem.tmdb_id) {
    // No sobreescribir una identidad existente; solo completar un null.
    await prisma.mediaItem.update?.({ where: { id: mediaItem.id }, data: { tmdb_id: tmdbId } });
  }
  report.imported_media_items++;

  const seasonNumber = record.season ?? 1;

  for (const ep of validEpisodes) {
    let mediaEpisode = await prisma.mediaEpisode.findUnique({
      where: {
        media_item_id_season_number_episode_number: {
          media_item_id: mediaItem.id,
          season_number: seasonNumber,
          episode_number: ep.number,
        },
      },
    });

    if (!mediaEpisode) {
      mediaEpisode = await prisma.mediaEpisode.create({
        data: {
          media_item_id: mediaItem.id,
          season_number: seasonNumber,
          episode_number: ep.number,
        },
      });
    }
    report.imported_media_episodes++;

    for (const src of ep.validSources) {
      const linkType = src.source_kind === "embed" ? "embed" : src.source_kind === "page" ? "page" : "direct";
      const host = extractHost(src.url);

      await prisma.sourceLink.upsert({
        where: {
          media_episode_id_source_site_url: {
            media_episode_id: mediaEpisode.id,
            source_site: src.source_site,
            url: src.url,
          },
        },
        create: {
          media_episode_id: mediaEpisode.id,
          source_site: src.source_site,
          url: src.url,
          link_type: linkType,
          host,
          // La reimportación solo confirma identidad canónica. No convierte
          // una página/directo histórico en una prueba de reproducción.
          is_verified: false,
          source_status: "discovered",
          canonical_locator: src.source_kind === "page" || src.source_kind === "embed" ? src.url : null,
          extraction_method: "canonical_reimport",
          resolver_version: "catalog-v2",
        },
        update: {
          link_type: linkType,
          host,
          canonical_locator: src.source_kind === "page" || src.source_kind === "embed" ? src.url : null,
          extraction_method: "canonical_reimport",
          resolver_version: "catalog-v2",
        },
      });
      report.imported_canonical_sources++;
    }
  }
}

/**
 * CLI Entrypoint
 */
export async function runCli() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Uso: npx tsx tools/reimport_canonical_catalog.ts [opciones]

Herramienta segura y reanudable para reimportación del catálogo canónico.
Por defecto opera en modo --dry-run (sin escritura).

Opciones obligatorias / de modo:
  --dry-run          Modo simulación por defecto (sin escrituras en BD)
  --apply            Ejecuta escrituras reales (requiere contrato backend listo)

Filtros y rendimiento:
  --source <id>      Filtra por plataforma / sitio de origen (ej. animeflv.net)
  --batch-size <n>   Tamaño del lote (default: 25, máx: 50)
  --concurrency <n>  Concurrencia de procesamiento (default: 1, máx: 2)
  --limit <n>        Límite máximo de registros a procesar (para pilotos)
  --cursor-file <f>  Archivo de cursor JSON para guardar checkpoints y reanudar
  --report <ruta>    Ruta para guardar el reporte final en JSON
  --input <ruta>     Archivo JSON o NDJSON con registros CanonicalImportRecord
  --help, -h         Muestra este mensaje de ayuda
`);
    process.exit(0);
  }

  let apply = false;
  let dryRun = true;
  let source: string | undefined = undefined;
  let batchSize = 25;
  let concurrency = 1;
  let cursorFile: string | undefined = undefined;
  let limit: number | undefined = undefined;
  let reportPath: string | undefined = undefined;
  let inputPath: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") {
      apply = true;
      dryRun = false;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      batchSize = parseInt(args[++i], 10) || 25;
    } else if (arg === "--concurrency" && i + 1 < args.length) {
      concurrency = parseInt(args[++i], 10) || 1;
    } else if (arg === "--cursor-file" && i + 1 < args.length) {
      cursorFile = args[++i];
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || undefined;
    } else if (arg === "--report" && i + 1 < args.length) {
      reportPath = args[++i];
    } else if (arg === "--input" && i + 1 < args.length) {
      inputPath = args[++i];
    }
  }

  // Graceful shutdown handling (Ctrl+C)
  const abortController = new AbortController();
  const handleSigint = () => {
    console.log("\n[INTERRUPT] Recibida señal de detención (Ctrl+C). Finalizando lote y guardando cursor...");
    abortController.abort();
  };
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigint);

  try {
    console.log(`\n=== REIMPORTACIÓN DE CATÁLOGO CANÓNICO ===`);
    console.log(`Modo:              ${apply ? "APPLY (Escritura en BD)" : "DRY-RUN (Simulación segura)"}`);
    console.log(`Lote / Concur.:    ${Math.min(batchSize, 50)} / ${Math.min(concurrency, 2)}`);
    if (source) console.log(`Filtro fuente:     ${source}`);
    if (limit) console.log(`Límite:            ${limit}`);
    if (cursorFile) console.log(`Cursor:            ${cursorFile}`);
    console.log(`=========================================\n`);

    const summary = await reimportCanonicalCatalog({
      apply,
      dryRun,
      source,
      batchSize,
      concurrency,
      cursorFile,
      limit,
      reportPath,
      inputPath,
      abortSignal: abortController.signal,
      onProgress: (p) => {
        if (p.processed % 25 === 0 || p.processed === p.total) {
          console.log(`[Progreso] ${p.processed}/${p.total} - Actual: ${p.currentTitle || "N/A"}`);
        }
      },
    });

    console.log("\n============= RESUMEN FINAL =============");
    console.log(`Modo:                     ${summary.dry_run ? "DRY-RUN" : "APPLY"}`);
    console.log(`Duración:                 ${(summary.duration_ms / 1000).toFixed(2)}s`);
    console.log(`Registros considerados:   ${summary.total_records_considered}`);
    console.log(`Registros procesados:     ${summary.processed_records}`);
    console.log(`MediaItems importados:    ${summary.imported_media_items}`);
    console.log(`MediaEpisodes importados: ${summary.imported_media_episodes}`);
    console.log(`Fuentes canónicas:        ${summary.imported_canonical_sources}`);
    console.log(`Fuentes efímeras omitidas:${summary.excluded_ephemeral_sources}`);
    console.log(`Omitidos / sin fuente:    ${summary.skipped_records}`);
    console.log(`Errores:                  ${summary.errors.length}`);
    if (summary.errors.length > 0) {
      console.log(`Ejemplo de error:         ${summary.errors[0].error}`);
    }
    console.log("=========================================\n");

    if (reportPath) {
      console.log(`Reporte guardado en: ${reportPath}`);
    }
  } catch (error: any) {
    console.error(`[ERROR] ${error?.message || error}`);
    process.exit(1);
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigint);
  }
}

// Execute CLI only when this file is the direct entrypoint
const isMain = () => {
  if (!process.argv) return false;
  return process.argv.some(
    (arg) =>
      arg.endsWith("reimport_canonical_catalog.ts") ||
      arg.endsWith("reimport_canonical_catalog.js")
  );
};

if (!process.env.VITEST && isMain()) {
  runCli();
}
