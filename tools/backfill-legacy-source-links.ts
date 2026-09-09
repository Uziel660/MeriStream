#!/usr/bin/env node
/**
 * Puente idempotente entre Episode/Show (modelo histórico) y
 * MediaEpisode/SourceLink (modelo multi-fuente).
 *
 * No resuelve streams ni hace peticiones externas: solo recupera localizadores
 * canónicos o directos estables que ya están guardados en la BD. Las URLs
 * firmadas se contabilizan como efímeras y se dejan para el recovery JIT.
 *
 * Por seguridad el modo por defecto es dry-run. Usar --apply cuando no haya
 * otra tarea de catálogo escribiendo, idealmente con --cursor-file para poder
 * reanudar sin repetir trabajo.
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma, normalizeBaseTitle } from "../server/db";
import { classifySourceKind } from "../server/resolutionMetadata";
import { normalizeTitleKey, parseRawTitle } from "../server/utils/titleNormalizer";
import { normalizeProviderId } from "../server/providers/providerPolicy";

type LegacyKind = "movie" | "tv";

interface CursorState {
  version: 1;
  lastEpisodeId: string;
  scanned: number;
  updatedAt: string;
}

export interface LegacyBridgeReport {
  dry_run: boolean;
  site_filter?: string;
  scanned: number;
  matched: number;
  links_created: number;
  links_existing: number;
  media_episodes_created: number;
  skipped_empty: number;
  skipped_excluded: number;
  skipped_ephemeral: number;
  skipped_navigation: number;
  skipped_no_media_item: number;
  skipped_ambiguous: number;
  errors: number;
  error_samples?: string[];
  last_episode_id: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

interface LegacyShowRow {
  id: string;
  title: string;
  normalized_title: string;
  base_normalized_title: string | null;
  tmdb_id: number | null;
  category: string;
  year: number;
}

interface MediaItemRow {
  id: string;
  title: string;
  normalized_title: string;
  base_normalized_title: string | null;
  tmdb_id: number | null;
  kind: string;
  year: number | null;
  created_at: Date;
}

interface MediaItemIndex {
  byNamespaceKey: Map<string, MediaItemRow[]>;
  byNamespaceTmdb: Map<string, MediaItemRow[]>;
}

interface ParsedArgs {
  apply: boolean;
  batchSize: number;
  concurrency: number;
  limit?: number;
  site?: string;
  cursorFile?: string;
  reportFile?: string;
}

// Todos los proveedores configurados participan en el puente. TubePelis tiene
// un adaptador estable y sus episodios legacy deben llegar al grafo canónico
// igual que los demás; excluirlo dejaba sus streams fuera del multiplexado.
const EXCLUDED_SITES = new Set<string>();
const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1_000;
const DEFAULT_CONCURRENCY = 32;
const MAX_CONCURRENCY = 32;

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { apply: false, batchSize: DEFAULT_BATCH_SIZE, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") result.apply = true;
    else if (arg === "--batch-size") result.batchSize = clampPositive(argv[++i], DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
    else if (arg === "--concurrency") result.concurrency = clampPositive(argv[++i], DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
    else if (arg === "--limit") result.limit = clampPositive(argv[++i], 0, Number.MAX_SAFE_INTEGER);
    else if (arg === "--site") result.site = String(argv[++i] || "").trim().toLowerCase() || undefined;
    else if (arg === "--cursor-file") result.cursorFile = argv[++i];
    else if (arg === "--report") result.reportFile = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(`Uso: npx tsx tools/backfill-legacy-source-links.ts [opciones]

  --dry-run             Simulación (por defecto)
  --apply               Escribe MediaEpisode/SourceLink
  --batch-size <n>      Episodios por lote (default ${DEFAULT_BATCH_SIZE}, máx ${MAX_BATCH_SIZE})
  --concurrency <n>     Filas procesadas en paralelo (default ${DEFAULT_CONCURRENCY}, máx ${MAX_CONCURRENCY})
  --limit <n>           Límite de episodios legacy a inspeccionar
  --site <host>         Filtra por el host del source_url (útil para reanudar un proveedor)
  --cursor-file <ruta>  Cursor JSON para reanudar
  --report <ruta>       Reporte JSON de la pasada`);
      process.exit(0);
    }
  }
  return result;
}

function clampPositive(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(max, Math.max(1, Math.round(value)));
}

function siteFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function isExcluded(raw: string): boolean {
  const site = raw.includes("://") ? siteFromUrl(raw) : raw.trim().toLowerCase();
  return EXCLUDED_SITES.has(site);
}

function isNavigationUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const pathname = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (/\/page\/\d+$/.test(pathname)) return true;
    if (["/", "/peliculas", "/series", "/animes", "/browse", "/directorio", "/genero", "/year"].includes(pathname)) return true;
    for (const key of ["page", "p", "pag", "paged"]) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function namespace(kind: string | null | undefined): LegacyKind {
  return String(kind || "movie").toLowerCase() === "movie" ? "movie" : "tv";
}

function itemNamespace(kind: string | null | undefined): LegacyKind {
  return namespace(kind);
}

function titleKeys(title: string, normalized?: string | null, base?: string | null): Set<string> {
  const keys = new Set<string>();
  for (const value of [title, normalized || "", base || ""]) {
    const text = String(value || "").trim();
    if (!text) continue;
    keys.add(normalizeTitleKey(text));
    keys.add(normalizeBaseTitle(text));
  }
  keys.delete("");
  return keys;
}

/**
 * Indexa una vez los MediaItem para que el puente no tenga que recorrer todo
 * el catálogo por cada Show legacy. La pasada anterior era O(shows × items)
 * y volvía el dry-run innecesariamente lento en catálogos grandes.
 */
function buildMediaItemIndex(items: MediaItemRow[]): MediaItemIndex {
  const byNamespaceKey = new Map<string, MediaItemRow[]>();
  const byNamespaceTmdb = new Map<string, MediaItemRow[]>();
  const add = (map: Map<string, MediaItemRow[]>, key: string, item: MediaItemRow) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  };
  for (const item of items) {
    const itemNamespaceKey = itemNamespace(item.kind);
    for (const key of titleKeys(item.title, item.normalized_title, item.base_normalized_title)) {
      add(byNamespaceKey, `${itemNamespaceKey}:${key}`, item);
    }
    if (item.tmdb_id != null) add(byNamespaceTmdb, `${itemNamespaceKey}:${item.tmdb_id}`, item);
  }
  return { byNamespaceKey, byNamespaceTmdb };
}

function seasonFor(show: LegacyShowRow): number {
  const parsed = parseRawTitle(show.title || "");
  return parsed.season && parsed.season > 1 ? parsed.season : 1;
}

function yearCompatible(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null || left < 1900 || right < 1900) return true;
  return Math.abs(left - right) <= 1;
}

function chooseMediaItem(show: LegacyShowRow, index: MediaItemIndex): { item: MediaItemRow | null; ambiguous: boolean } {
  const showNamespace = namespace(show.category);
  const keys = titleKeys(show.title, show.normalized_title, show.base_normalized_title);
  const seen = new Set<string>();
  const candidates: MediaItemRow[] = [];
  const addCandidate = (item: MediaItemRow) => {
    if (seen.has(item.id)) return;
    if (show.tmdb_id != null && item.tmdb_id != null && item.tmdb_id !== show.tmdb_id) return;
    if (!yearCompatible(show.year, item.year)) return;
    seen.add(item.id);
    candidates.push(item);
  };

  // Un TMDB exacto tiene prioridad y, igual que antes, no exige coincidencia
  // de título. Los candidatos sin TMDB todavía pueden entrar por título/año.
  if (show.tmdb_id != null) {
    for (const item of index.byNamespaceTmdb.get(`${showNamespace}:${show.tmdb_id}`) || []) addCandidate(item);
  }
  for (const key of keys) {
    for (const item of index.byNamespaceKey.get(`${showNamespace}:${key}`) || []) {
      if (show.tmdb_id == null || item.tmdb_id == null) addCandidate(item);
    }
  }

  const exactTmdb = candidates.filter((item) => show.tmdb_id != null && item.tmdb_id === show.tmdb_id);
  const pool = exactTmdb.length > 0 ? exactTmdb : candidates;
  if (pool.length === 0) return { item: null, ambiguous: false };
  pool.sort((a, b) => {
    const aExactTitle = titleKeys(a.title, a.normalized_title, a.base_normalized_title).has(normalizeTitleKey(show.title)) ? 1 : 0;
    const bExactTitle = titleKeys(b.title, b.normalized_title, b.base_normalized_title).has(normalizeTitleKey(show.title)) ? 1 : 0;
    return bExactTitle - aExactTitle || a.created_at.getTime() - b.created_at.getTime();
  });
  // Varias filas con el mismo título pero años incompatibles ya se filtraron.
  // Si queda un único título normalizado exacto, es una coincidencia segura;
  // de lo contrario no inventar una identidad y dejar constancia para revisión.
  const showNorm = normalizeTitleKey(show.title);
  const exactTitle = pool.filter((entry) => normalizeTitleKey(entry.title) === showNorm || entry.normalized_title === show.normalized_title);
  const ambiguous = exactTmdb.length === 0 && pool.length > 1 && exactTitle.length !== 1;
  return { item: pool[0], ambiguous };
}

async function loadMediaItems(): Promise<MediaItemRow[]> {
  return prisma.mediaItem.findMany({
    select: {
      id: true,
      title: true,
      normalized_title: true,
      base_normalized_title: true,
      tmdb_id: true,
      kind: true,
      year: true,
      created_at: true,
    },
    orderBy: { created_at: "asc" },
  });
}

async function loadCursor(file?: string): Promise<CursorState | null> {
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(path.resolve(file), "utf8")) as CursorState;
    if (parsed.version === 1 && typeof parsed.lastEpisodeId === "string") return parsed;
  } catch {
    // Cursor inexistente o corrupto: empezar de forma segura desde el inicio.
  }
  return null;
}

async function saveCursor(file: string | undefined, cursor: CursorState): Promise<void> {
  if (!file) return;
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(cursor, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temp, target);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const report: LegacyBridgeReport = {
    dry_run: !args.apply,
    ...(args.site ? { site_filter: args.site } : {}),
    scanned: 0,
    matched: 0,
    links_created: 0,
    links_existing: 0,
    media_episodes_created: 0,
    skipped_empty: 0,
    skipped_excluded: 0,
    skipped_ephemeral: 0,
    skipped_navigation: 0,
    skipped_no_media_item: 0,
    skipped_ambiguous: 0,
    errors: 0,
    error_samples: [],
    last_episode_id: null,
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 0,
  };

  const cursor = await loadCursor(args.cursorFile);
  const mediaItems = await loadMediaItems();
  const mediaItemIndex = buildMediaItemIndex(mediaItems);
  const itemCache = new Map<string, { item: MediaItemRow | null; ambiguous: boolean }>();
  let afterId = cursor?.lastEpisodeId || "";
  let remaining = args.limit;

  try {
    while (remaining === undefined || remaining > 0) {
      const take = Math.min(args.batchSize, remaining ?? args.batchSize);
      const rows = await prisma.episode.findMany({
        where: {
          ...(afterId ? { id: { gt: afterId } } : {}),
          source_url: {
            not: "",
            ...(args.site ? { contains: args.site, mode: "insensitive" as const } : {}),
          },
        },
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          episode_number: true,
          source_url: true,
          show: {
            select: {
              id: true,
              title: true,
              normalized_title: true,
              base_normalized_title: true,
              tmdb_id: true,
              category: true,
              year: true,
            },
          },
        },
      });
      if (rows.length === 0) break;

      afterId = rows[rows.length - 1].id;
      report.last_episode_id = afterId;
      report.scanned += rows.length;
      remaining = remaining === undefined ? undefined : remaining - rows.length;

      const processRow = async (row: (typeof rows)[number]) => {
        const rawUrl = String(row.source_url || "").trim();
        if (!rawUrl) {
          report.skipped_empty++;
          return;
        }
        if (isExcluded(rawUrl)) {
          report.skipped_excluded++;
          return;
        }
        const sourceKind = classifySourceKind(rawUrl);
        if (sourceKind === "ephemeral_direct") {
          report.skipped_ephemeral++;
          return;
        }
        if (sourceKind !== "stable_direct" && isNavigationUrl(rawUrl)) {
          report.skipped_navigation++;
          return;
        }

        const show = row.show as LegacyShowRow;
        let match = itemCache.get(show.id);
        if (!match) {
          match = chooseMediaItem(show, mediaItemIndex);
          itemCache.set(show.id, match);
        }
        if (!match.item) {
          report.skipped_no_media_item++;
          return;
        }
        if (match.ambiguous) {
          report.skipped_ambiguous++;
          return;
        }
        report.matched++;

        const season = itemNamespace(match.item.kind) === "movie" ? 1 : seasonFor(show);
        const episodeNumber = itemNamespace(match.item.kind) === "movie" ? 1 : Number(row.episode_number);
        if (!Number.isFinite(episodeNumber) || episodeNumber < 0) {
          report.errors++;
          return;
        }
        const linkType = sourceKind === "embed" ? "embed" : sourceKind === "page" ? "page" : "direct";
        const sourceHost = siteFromUrl(rawUrl);
        const sourceSite = sourceHost === "unknown" ? "unknown" : normalizeProviderId(sourceHost);
        if (sourceSite === "unknown") {
          report.errors++;
          return;
        }

        if (!args.apply) return;
        try {
          const existingEpisode = await prisma.mediaEpisode.findUnique({
            where: {
              media_item_id_season_number_episode_number: {
                media_item_id: match.item.id,
                season_number: season,
                episode_number: episodeNumber,
              },
            },
            select: { id: true },
          });
          const mediaEpisode = await prisma.mediaEpisode.upsert({
            where: {
              media_item_id_season_number_episode_number: {
                media_item_id: match.item.id,
                season_number: season,
                episode_number: episodeNumber,
              },
            },
            create: { media_item_id: match.item.id, season_number: season, episode_number: episodeNumber },
            update: {},
            select: { id: true },
          });
          if (!existingEpisode) report.media_episodes_created++;
          const existing = await prisma.sourceLink.findUnique({
            where: {
              media_episode_id_source_site_url: {
                media_episode_id: mediaEpisode.id,
                source_site: sourceSite,
                url: rawUrl,
              },
            },
            select: { id: true },
          });
          if (existing) {
            report.links_existing++;
            return;
          }
          await prisma.sourceLink.create({
            data: {
              media_episode_id: mediaEpisode.id,
              source_site: sourceSite,
              url: rawUrl,
              link_type: linkType,
              host: sourceSite,
              priority_tier: null,
              is_verified: false,
              source_status: "discovered",
              canonical_locator: linkType === "page" || linkType === "embed" ? rawUrl : null,
              extraction_method: "legacy_bridge",
              resolver_version: "legacy-bridge-v1",
            },
          });
          report.links_created++;
        } catch (error: any) {
          if (error?.code === "P2002") report.links_existing++;
          else {
            report.errors++;
            if ((report.error_samples?.length || 0) < 20) {
              const code = error?.code ? `${error.code}: ` : "";
              report.error_samples?.push(`${code}${error?.message || String(error)}`);
            }
          }
        }
      };

      // El trabajo de cada episodio es independiente. Limitamos la cantidad de
      // promesas simultáneas para aprovechar la máquina sin desbordar el pool
      // de Prisma ni disparar demasiadas peticiones por proveedor.
      for (let index = 0; index < rows.length; index += args.concurrency) {
        await Promise.all(rows.slice(index, index + args.concurrency).map(processRow));
      }

      await saveCursor(args.cursorFile, {
        version: 1,
        lastEpisodeId: afterId,
        scanned: (cursor?.scanned || 0) + report.scanned,
        updatedAt: new Date().toISOString(),
      });
      console.log(`[LegacyBridge] ${report.scanned} legacy · ${report.matched} emparejados · ${report.links_created} enlaces nuevos`);
      if (rows.length < take) break;
    }
  } finally {
    report.finished_at = new Date().toISOString();
    report.duration_ms = Date.now() - started;
    if (args.reportFile) {
      const target = path.resolve(args.reportFile);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(report, null, 2), "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
    await prisma.$disconnect();
  }
}

// tsx conserva la ruta relativa en process.argv[1] en Windows; comparar la
// URL file:// literalmente impediría ejecutar el CLI desde `npx tsx`.
if (process.argv[1]?.toLowerCase().endsWith("backfill-legacy-source-links.ts")) {
  void main().catch((error) => {
    console.error("[LegacyBridge]", error);
    process.exitCode = 1;
  });
}
