// server/verificationWorker.ts
// ══════════════════════════════════════════════════════════════════
// APARTADO DE VERIFICACIÓN: worker periódico que recorre el catálogo
// OBRA POR OBRA según el scope configurado y hace dos cosas:
//
//  (1) FASE METADATOS — re-enriquece y repara cada obra reusando
//      backfillShow() de ./metadataBackfill (solo completa huecos con
//      datos REALES del enrichment; nunca sobrescribe valores).
//  (2) FASE NOVEDADES — re-barre el catálogo de CADA plataforma del
//      scope (extractCatalogListing con la URL configurada) y cruza los
//      títulos contra la BD por CLAVE CANÓNICA (normalizeTitleKey vs
//      Show.base_normalized_title / normalized_title). Lo NUEVO se
//      importa con saveShowWithDeduplication (el dedup fusiona solo);
//      lo EXISTENTE queda anotado en el reporte (y se marca el caso
//      "conocida pero sin episodios locales").
//
// Config persistida en data/verification.config.json (cero migraciones).
// Rate-limit amable: ~1 obra cada 2s en metadatos; pausas cortas entre
// items de catálogo y extra al importar (el import dispara enrichment).
//
// NOTA de alcance: el barrido paginado profundo es territorio del
// taskWorker; este worker muestrea la URL de catálogo configurada por
// plataforma (los directorios ordenan por novedad, así que la primera
// página ya revela lo nuevo).
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { prisma } from "./db";
import { backfillShow, showNeedsBackfill } from "./metadataBackfill";
import { extractCatalogListing, analyzeUniversalUrl } from "./universalScraper";
import { saveShowWithDeduplication, quickSyncKnownShow } from "./showService";
import { normalizeTitleKey } from "./utils/titleNormalizer";
import { isPlausibleYear } from "./metadataMerge";
import type { ContentKind, ExtractedCatalogItem } from "./types";

// ── Contrato público ─────────────────────────────────────────────

export interface VerificationConfig {
  enabled: boolean;
  interval_minutes: number;
  scope_mode: "all" | "platforms" | "category";
  platforms: string[];
  category?: string;
  catalog_urls_by_platform: Record<string, string>;
  metadata_only: boolean;
  /** Re-escaneo ligero de conocidas: detecta e inserta episodios nuevos
   *  (compara la ficha contra la BD; streams JIT). Default: true. */
  sync_known_episodes: boolean;
}

export interface VerificationRunOptions {
  /** Override de modo SOLO para esta pasada (no muta config persistida).
   *  - "metadata": solo fase metadatos.
   *  - "full": metadatos + catálogo, incluso si config.metadata_only === true.
   *  - undefined: obedece config.metadata_only. */
  mode?: "metadata" | "full";
  /** Override de plataformas SOLO para esta pasada. */
  platforms?: string[];
  /** Tope de obras (fase metadatos) y de items por plataforma (fase novedades). */
  limit?: number;
  /** Uso interno: marca el origen de la pasada en el reporte. */
  trigger?: "manual" | "timer";
}

export interface VerificationProgress {
  total: number;
  done: number;
  new_works: number;
  new_sources: number;
  known: number;
  known_without_episodes: number;
  new_episodes: number;
  updated_metadata: number;
  errors: number;
  works_merged: number;
  sources_added: number;
}

export interface VerificationReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  trigger: "manual" | "timer";
  scope: { mode: string; platforms: string[]; category: string | null };
  metadata_phase: {
    works_total: number;
    works_done: number;
    updated_metadata: number;
    errors: number;
  };
  catalog_phase: {
    skipped: boolean;
    platforms_checked: string[];
    platforms_skipped_no_url: string[];
    items_seen: number;
    known: number;
    known_without_episodes: string[];
    new_detected: number;
    imported: number;
    merged_by_dedup: number;
    errors: string[];
    works_merged: number;
    sources_added: number;
  };
}

export interface VerificationStatus {
  enabled: boolean;
  interval_minutes: number;
  scope_mode: string;
  platforms: string[];
  category: string | null;
  metadata_only: boolean;
  running: boolean;
  phase: "idle" | "metadata" | "catalog";
  current_item: string | null;
  progress: VerificationProgress;
  last_run_at: string | null;
  next_run_at: string | null;
  last_report: VerificationReport | null;
  recent: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
  config: VerificationConfig;
}

// ── Defaults y persistencia ──────────────────────────────────────

export const DEFAULT_CATALOG_URLS: Record<string, string> = {
  animeflv: "https://www3.animeflv.net/browse",
  tioanime: "https://tioanime.com/directorio",
  latanime: "https://latanime.org/animes",
  cinecalidad: "https://www.cinecalidad.am/",
  tioplus: "https://tioplus.app/peliculas",
  doramasflix: "https://doramasflix.io/doramas",
  doramasflix_peliculas: "https://doramasflix.io/peliculas",
  doramasflix_variedades: "https://doramasflix.io/variedades",
  lamovie_movies: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
  lamovie_series: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
  lamovie_animes: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24",
};

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "verification.config.json");

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 525600; // 1 año
const SCOPE_MODES = ["all", "platforms", "category"] as const;

/** Plataformas típicas por categoría (scope_mode="category", fase novedades). */
const CATEGORY_PLATFORM_MAP: Record<string, string[]> = {
  anime: ["animeflv", "tioanime", "latanime", "lamovie_animes"],
  movie: ["cinecalidad", "tioplus", "lamovie_movies", "doramasflix_peliculas"],
  movies: ["cinecalidad", "tioplus", "lamovie_movies", "doramasflix_peliculas"],
  series: ["lamovie_series", "doramasflix", "doramasflix_variedades"],
};

function defaultConfig(): VerificationConfig {
  return {
    enabled: true,
    interval_minutes: 1440,
    scope_mode: "all",
    platforms: [],
    category: undefined,
    catalog_urls_by_platform: { ...DEFAULT_CATALOG_URLS },
    metadata_only: false,
    sync_known_episodes: true,
  };
}

function loadConfigFromDisk(): VerificationConfig {
  const base = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return base;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    // Fusión tolerante: un archivo viejo/corrupto parcialmente válido no tumba al worker.
    if (typeof raw?.enabled === "boolean") base.enabled = raw.enabled;
    if (Number.isFinite(raw?.interval_minutes)) {
      base.interval_minutes = clampInterval(raw.interval_minutes);
    }
    if (SCOPE_MODES.includes(raw?.scope_mode)) base.scope_mode = raw.scope_mode;
    if (Array.isArray(raw?.platforms)) {
      base.platforms = raw.platforms.map(cleanPlatform).filter(Boolean);
    }
    if (typeof raw?.category === "string" && raw.category.trim()) base.category = raw.category.trim().toLowerCase();
    if (raw?.catalog_urls_by_platform && typeof raw.catalog_urls_by_platform === "object") {
      for (const [k, v] of Object.entries(raw.catalog_urls_by_platform)) {
        if (typeof v === "string") base.catalog_urls_by_platform[cleanPlatform(k)] = v.trim();
      }
    }
    if (typeof raw?.metadata_only === "boolean") base.metadata_only = raw.metadata_only;
    if (typeof raw?.sync_known_episodes === "boolean") base.sync_known_episodes = raw.sync_known_episodes;
  } catch (e) {
    console.error("[verificationWorker] config corrupta, usando defaults:", e);
  }
  return base;
}

function persistConfig(config: VerificationConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function clampInterval(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return defaultConfig().interval_minutes;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, n));
}

function cleanPlatform(p: unknown): string {
  return String(p ?? "").trim().toLowerCase();
}

function isValidUrlOrEmpty(u: string): boolean {
  if (!u) return true;
  try {
    new URL(u);
    return true;
  } catch {
    return false;
  }
}

// ── Estado en memoria (progreso en vivo) ─────────────────────────

type RecentEntry = { at: string; level: "info" | "warn" | "error"; message: string };

const state = {
  config: loadConfigFromDisk(),
  timer: null as ReturnType<typeof setInterval> | null,
  running: false,
  phase: "idle" as "idle" | "metadata" | "catalog",
  currentItem: null as string | null,
  startedAt: null as string | null,
  lastRunAt: null as string | null,
  nextRunAt: null as string | null,
  progress: {
    total: 0,
    done: 0,
    new_works: 0,
    new_sources: 0,
    known: 0,
    known_without_episodes: 0,
    new_episodes: 0,
    updated_metadata: 0,
    errors: 0,
    works_merged: 0,
    sources_added: 0,
  } as VerificationProgress,
  lastReport: null as VerificationReport | null,
  recent: [] as RecentEntry[],
};

/** Contadores de la pasada en curso, separados por fase para el reporte. */
const runCounters = { metaTotal: 0, metaDone: 0, metaUpdated: 0, metaErrors: 0 };

function resetRunCounters(): void {
  runCounters.metaTotal = 0;
  runCounters.metaDone = 0;
  runCounters.metaUpdated = 0;
  runCounters.metaErrors = 0;
}

function log(level: RecentEntry["level"], message: string): void {
  state.recent.unshift({ at: new Date().toISOString(), level, message });
  state.recent = state.recent.slice(0, 30);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Timer ────────────────────────────────────────────────────────

function clearTimer(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/**
 * Programa (o reprograma/cancela) el intervalo según config.enabled.
 * Al arrancar el módulo SOLO programa: nunca corre un barrido completo en boot.
 */
function scheduleTimer(): void {
  clearTimer();
  if (!state.config.enabled) {
    state.nextRunAt = null;
    return;
  }
  const ms = clampInterval(state.config.interval_minutes) * 60_000;
  const next = new Date();
  next.setMinutes(next.getMinutes() + state.config.interval_minutes);
  state.nextRunAt = next.toISOString();
  state.timer = setInterval(() => {
    const nextTick = new Date();
    nextTick.setMinutes(nextTick.getMinutes() + state.config.interval_minutes);
    state.nextRunAt = nextTick.toISOString();
    if (state.running) return; // la pasada en curso manda; la siguiente se pierde (no se acumulan)
    runVerification({ trigger: "timer" });
  }, ms);
  (state.timer as unknown as { unref?: () => void })?.unref?.(); // no mantiene vivo procesos de prueba
}

// ── API pública: config ──────────────────────────────────────────

export function getVerificationConfig(): VerificationConfig {
  return JSON.parse(JSON.stringify(state.config));
}

export async function updateVerificationConfig(patch: Partial<VerificationConfig>): Promise<VerificationConfig> {
  const next = getVerificationConfig();

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("'enabled' debe ser boolean");
    next.enabled = patch.enabled;
  }
  if (patch.interval_minutes !== undefined) {
    if (!Number.isFinite(Number(patch.interval_minutes))) throw new Error("'interval_minutes' debe ser numérico");
    next.interval_minutes = clampInterval(patch.interval_minutes);
  }
  if (patch.scope_mode !== undefined) {
    if (!SCOPE_MODES.includes(patch.scope_mode)) {
      throw new Error(`'scope_mode' inválido (${String(patch.scope_mode)}); use: ${SCOPE_MODES.join(" | ")}`);
    }
    next.scope_mode = patch.scope_mode;
  }
  if (patch.platforms !== undefined) {
    if (!Array.isArray(patch.platforms)) throw new Error("'platforms' debe ser un array de strings");
    next.platforms = [...new Set(patch.platforms.map(cleanPlatform).filter(Boolean))];
  }
  if (patch.category !== undefined) {
    const c = typeof patch.category === "string" ? patch.category.trim().toLowerCase() : "";
    next.category = c || undefined;
  }
  if (patch.catalog_urls_by_platform !== undefined) {
    if (!patch.catalog_urls_by_platform || typeof patch.catalog_urls_by_platform !== "object" || Array.isArray(patch.catalog_urls_by_platform)) {
      throw new Error("'catalog_urls_by_platform' debe ser un objeto { plataforma: url }");
    }
    for (const [k, v] of Object.entries(patch.catalog_urls_by_platform)) {
      const key = cleanPlatform(k);
      const url = String(v ?? "").trim();
      if (!key) continue;
      if (!isValidUrlOrEmpty(url)) throw new Error(`URL inválida para '${key}': ${url}`);
      next.catalog_urls_by_platform[key] = url;
    }
  }
  if (patch.metadata_only !== undefined) {
    if (typeof patch.metadata_only !== "boolean") throw new Error("'metadata_only' debe ser boolean");
    next.metadata_only = patch.metadata_only;
  }
  if (patch.sync_known_episodes !== undefined) {
    if (typeof patch.sync_known_episodes !== "boolean") throw new Error("'sync_known_episodes' debe ser boolean");
    next.sync_known_episodes = patch.sync_known_episodes;
  }

  state.config = next;
  persistConfig(next);
  scheduleTimer(); // reprograma o cancela según enabled/intervalo nuevos
  log("info", `Config actualizada (enabled=${next.enabled}, intervalo=${next.interval_minutes}min, scope=${next.scope_mode}).`);
  return getVerificationConfig();
}

// ── API pública: run/status ──────────────────────────────────────

/**
 * Inicia una pasada de verificación. Es SÍNCRONA en su decisión de arranque
 * (devuelve inmediatamente started/reason); la pasada corre en background.
 * Bloqueo compartido: manuales y automáticas comparten el mismo lock.
 */
export function runVerification(options?: VerificationRunOptions): { started: boolean; reason?: string } {
  if (state.running) {
    return { started: false, reason: "already_running" };
  }
  state.running = true;
  state.phase = "metadata";
  state.currentItem = null;
  state.startedAt = new Date().toISOString();
  state.progress = {
    total: 0,
    done: 0,
    new_works: 0,
    new_sources: 0,
    known: 0,
    known_without_episodes: 0,
    new_episodes: 0,
    updated_metadata: 0,
    errors: 0,
    works_merged: 0,
    sources_added: 0,
  } as VerificationProgress;
  resetRunCounters();
  log("info", `Pasada ${options?.trigger || "manual"} iniciada.`);

  void runPass(options || {}).finally(() => {
    state.running = false;
    state.phase = "idle";
    state.currentItem = null;
    state.lastRunAt = new Date().toISOString();
    if (state.config.enabled && !state.nextRunAt) scheduleTimer();
  });

  return { started: true };
}

export function getVerificationStatus(): VerificationStatus {
  const c = state.config;
  const p = state.progress;
  return {
    enabled: c.enabled,
    interval_minutes: c.interval_minutes,
    scope_mode: c.scope_mode,
    platforms: [...c.platforms],
    category: c.category ?? null,
    metadata_only: c.metadata_only,
    sync_known_episodes: c.sync_known_episodes !== false,
    running: state.running,
    phase: state.phase,
    current_item: state.currentItem,
    // Capa de salida canónica: nombres del contrato acordado.
    // Los internos se conservan para compatibilidad.
    progress: {
      // Internos (compat)
      ...p,
      // Canónicos
      metadata_updated: p.updated_metadata,
      works_created: p.new_works,
      episodes_added: p.new_episodes,
      works_merged: p.works_merged || 0,
      sources_added: p.sources_added || 0,
    },
    last_run_at: state.lastRunAt,
    next_run_at: state.nextRunAt,
    last_report: state.lastReport,
    recent: [...state.recent],
    config: getVerificationConfig(),
  };
}

// ── Resolución de alcance ────────────────────────────────────────

function resolveCatalogPlatforms(cfg: VerificationConfig, overridePlatforms?: string[]): string[] {
  if (overridePlatforms && overridePlatforms.length > 0) {
    return overridePlatforms.map(cleanPlatform).filter(Boolean);
  }
  if (cfg.scope_mode === "platforms") {
    return cfg.platforms.map(cleanPlatform).filter(Boolean);
  }
  if (cfg.scope_mode === "category") {
    const mapped = CATEGORY_PLATFORM_MAP[String(cfg.category || "").toLowerCase()];
    if (mapped) return mapped.filter((p) => cfg.catalog_urls_by_platform[p]);
  }
  return Object.keys(cfg.catalog_urls_by_platform).filter((p) => cfg.catalog_urls_by_platform[p]);
}

/**
 * Obras del scope para la fase metadatos.
 * - all: todas las filas Show.
 * - category: Show.category = config.category.
 * - platforms: claves canónicas de los MediaItem que tienen SourceLink cuyo
 *   source_site pertenece a la plataforma (SourceLink es la ÚNICA tabla con
 *   source_site en el schema; Episode legacy solo trae source_url), y luego
 *   Show cuya clave canónica coincida (chunked IN para no reventar SQLite).
 */
async function resolveMetadataShowIds(cfg: VerificationConfig, overridePlatforms?: string[]): Promise<string[]> {
  if (overridePlatforms && overridePlatforms.length > 0) {
    return showsLinkedToPlatforms(overridePlatforms);
  }
  if (cfg.scope_mode === "category" && cfg.category) {
    const rows = await prisma.show.findMany({
      where: { category: { contains: cfg.category.toLowerCase() } },
      select: { id: true },
      orderBy: { created_at: "asc" },
    });
    return rows.map((r) => r.id);
  }
  if (cfg.scope_mode === "platforms") {
    return showsLinkedToPlatforms(cfg.platforms);
  }
  const rows = await prisma.show.findMany({ select: { id: true }, orderBy: { created_at: "asc" } });
  return rows.map((r) => r.id);
}

async function showsLinkedToPlatforms(platforms: string[]): Promise<string[]> {
  const clean = platforms.map(cleanPlatform).filter(Boolean);
  if (clean.length === 0) return [];

  const links = await prisma.sourceLink.findMany({
    where: { OR: clean.map((p) => ({ source_site: { contains: p } })) },
    select: {
      media_episode: {
        select: { media_item: { select: { normalized_title: true, base_normalized_title: true } } },
      },
    },
  });

  const keys = new Set<string>();
  for (const link of links) {
    const mi = link.media_episode?.media_item;
    if (!mi) continue;
    if (mi.normalized_title) keys.add(mi.normalized_title);
    if (mi.base_normalized_title) keys.add(mi.base_normalized_title);
  }
  if (keys.size === 0) return [];

  const ids = new Set<string>();
  const keyList = [...keys];
  const CHUNK = 400; // margen seguro bajo el límite de variables SQL de SQLite
  for (let i = 0; i < keyList.length; i += CHUNK) {
    const group = keyList.slice(i, i + CHUNK);
    const rows = await prisma.show.findMany({
      where: { OR: [{ normalized_title: { in: group } }, { base_normalized_title: { in: group } }] },
      select: { id: true },
    });
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

// ── Fase 1: metadatos ────────────────────────────────────────────

async function metadataPhase(cfg: VerificationConfig, opts: VerificationRunOptions): Promise<void> {
  state.phase = "metadata";
  const showIds = await resolveMetadataShowIds(cfg, opts.platforms);
  const limited = opts.limit && opts.limit > 0 ? showIds.slice(0, opts.limit) : showIds;

  runCounters.metaTotal = limited.length;
  state.progress.total += limited.length;
  log("info", `Fase metadatos: ${limited.length} obra(s) en cola (scope=${cfg.scope_mode}).`);

  // POOL PARALELO (20 slots): TMDB tolera 40-50 req/s.
  // Reducimos cuellos de botella para que la fase de metadatos vuele.
  const CONCURRENCY = 20;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= limited.length) return;
      const showId = limited[idx];
      try {
        const row = await prisma.show.findUnique({
          where: { id: showId },
          select: { id: true, title: true, description: true, poster_url: true, banner_url: true, genres: true, year: true },
        });
        state.currentItem = row?.title || showId;
        if (row && showNeedsBackfill(row)) {
          const result = await backfillShow(showId);
          if (result.changed.length > 0) {
            runCounters.metaUpdated++;
            log("info", `Metadatos completados en '${result.title}': ${result.changed.join(", ")}`);
          }
          // Stagger cortísimo para no saturar la red local.
          await sleep(10 + Math.random() * 20);
        }
        // Obra completa → sin TMDB, sin espera: siguiente.
      } catch (e: any) {
        runCounters.metaErrors++;
        state.progress.errors++;
        log("warn", `Error en backfill de obra ${showId}: ${e?.message || e}`);
      }
      runCounters.metaDone++;
      state.progress.done++;
      state.progress.updated_metadata = runCounters.metaUpdated;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  state.phase = "catalog";
}

// ── Fase 2: novedades por plataforma ─────────────────────────────

function inferKindForPlatform(platformKey: string, itemKind?: ContentKind | null): ContentKind {
  if (itemKind) return itemKind;
  const k = platformKey.toLowerCase();
  if (k.includes("anime")) return "anime";
  if (k.includes("serie") || k.includes("tvshow")) return "series";
  return "movie";
}

async function findKnownWork(titleKey: string, year?: number | null, kind?: ContentKind, tmdbId?: number | null): Promise<{ id: string; title: string; episodeCount: number } | null> {
  // (1) Resolución autoritativa: tmdb_id + content kind.
  if (tmdbId && tmdbId > 0) {
    const byTmdb = await prisma.show.findFirst({
      where: { tmdb_id: tmdbId, ...(kind ? { category: kind } : {}) },
      orderBy: { created_at: "asc" },
      select: { id: true, title: true, _count: { select: { episodes: true } } },
    });
    if (byTmdb) return { id: byTmdb.id, title: byTmdb.title, episodeCount: byTmdb._count.episodes };
  }
  // (2) Fallback: título canónico + año compatible.
  if (!titleKey) return null;
  const showCandidates = await prisma.show.findMany({
    where: {
      OR: [{ base_normalized_title: titleKey }, { normalized_title: titleKey }],
      ...(kind ? { category: kind } : {}),
    },
    orderBy: { created_at: "asc" },
    select: { id: true, title: true, year: true, _count: { select: { episodes: true } } },
    take: 20,
  });
  const requestedYear = isPlausibleYear(year) ? year! : null;
  const show = requestedYear
    ? showCandidates.find((candidate) => candidate.year === requestedYear) ??
      showCandidates.find((candidate) => !isPlausibleYear(candidate.year)) ??
      null
    : showCandidates[0] ?? null;
  if (show) {
    return { id: show.id, title: show.title, episodeCount: show._count.episodes };
  }
  // Paridad multi-fuente: puede existir MediaItem sin espejo legacy aún.
  const mediaItems = await prisma.mediaItem.findMany({
    where: {
      OR: [{ base_normalized_title: titleKey }, { normalized_title: titleKey }],
      ...(kind ? { kind } : {}),
    },
    orderBy: { created_at: "asc" },
    select: { id: true, title: true, year: true },
    take: 20,
  });
  const mediaItem = requestedYear
    ? mediaItems.find((candidate) => candidate.year === requestedYear) ??
      mediaItems.find((candidate) => !isPlausibleYear(candidate.year)) ??
      null
    : mediaItems[0] ?? null;
  if (mediaItem) return { id: mediaItem.id, title: mediaItem.title, episodeCount: -1 };
  return null;
}

function buildEpisodesFromAnalysis(
  analysis: any,
  platform: string,
  kind: ContentKind
): Array<{ number: number; title: string; url: string; sources: SourceLinkInput[] }> {
  if (!analysis) return [];
  const sourceSite = analysis.source_domain || platform;
  const detectedStreams: string[] = Array.isArray(analysis.detected_streams)
    ? analysis.detected_streams.filter((s: any) => typeof s === "string" && s.trim())
    : [];
  const rawEpisodes: any[] = Array.isArray(analysis.episodes) ? analysis.episodes : [];
  const isMovie = kind === "movie" || analysis.content_type === "movie" || (rawEpisodes.length <= 1 && detectedStreams.length > 0);

  if (isMovie) {
    const firstEp = rawEpisodes[0] || null;
    const primaryUrl = firstEp?.url || detectedStreams[0] || "";
    const streamSources: SourceLinkInput[] = [];
    const seen = new Set<string>();

    if (primaryUrl) {
      streamSources.push({ url: primaryUrl, source_site: sourceSite });
      seen.add(primaryUrl);
    }
    for (const st of detectedStreams) {
      if (st && !seen.has(st)) {
        streamSources.push({ url: st, source_site: sourceSite });
        seen.add(st);
      }
    }
    if (firstEp && Array.isArray(firstEp.sources)) {
      for (const s of firstEp.sources) {
        const u = typeof s === "string" ? s : s?.url;
        if (u && !seen.has(u)) {
          streamSources.push({
            url: u,
            source_site: (typeof s === "object" && s.source_site) ? s.source_site : sourceSite,
            link_type: typeof s === "object" ? s.link_type : undefined,
            host: typeof s === "object" ? s.host : undefined,
          });
          seen.add(u);
        }
      }
    }

    if (primaryUrl || streamSources.length > 0) {
      return [{
        number: 1,
        title: firstEp?.title || "Película Completa",
        url: primaryUrl,
        sources: streamSources,
      }];
    }
    return [];
  }

  // Series / anime
  return rawEpisodes.map((e: any, idx: number) => {
    const epNum = Number.isFinite(Number(e.number)) ? Number(e.number) : idx + 1;
    const primaryUrl = String(e.url || "");
    const epSources: SourceLinkInput[] = [];
    const seen = new Set<string>();

    if (primaryUrl) {
      epSources.push({ url: primaryUrl, source_site: sourceSite });
      seen.add(primaryUrl);
    }
    if (Array.isArray(e.sources)) {
      for (const s of e.sources) {
        const u = typeof s === "string" ? s : s?.url;
        if (u && !seen.has(u)) {
          epSources.push({
            url: u,
            source_site: (typeof s === "object" && s.source_site) ? s.source_site : sourceSite,
            link_type: typeof s === "object" ? s.link_type : undefined,
            host: typeof s === "object" ? s.host : undefined,
          });
          seen.add(u);
        }
      }
    }

    return {
      number: epNum,
      title: String(e.title || `Episodio ${epNum}`),
      url: primaryUrl,
      sources: epSources,
    };
  });
}

// ── Fase 2: novedades por catálogo ──────────────────────────────

async function catalogPhase(cfg: VerificationConfig, opts: VerificationRunOptions): Promise<void> {
  state.phase = "catalog";
  const platforms = resolveCatalogPlatforms(cfg, opts.platforms);
  log("info", `Fase catálogo: ${platforms.length} plataforma(s) en cola (${platforms.join(", ") || "ninguna"}).`);

  let itemsSeen = 0;
  let known = 0;
  let newDetected = 0;
  let imported = 0;
  let mergedByDedup = 0;
  const withoutEpisodes: string[] = [];
  const checked: string[] = [];
  const noUrl: string[] = [];
  const catalogErrors: string[] = [];

  const analyzedUrls = new Set<string>();

  for (const platform of platforms) {
    const url = cfg.catalog_urls_by_platform[platform];
    if (!url) {
      noUrl.push(platform);
      log("warn", `[${platform}] Sin URL de catálogo configurada, saltando.`);
      continue;
    }
    checked.push(platform);
    log("info", `[${platform}] Escaneando catálogo: ${url}`);

    let items: any[] = [];
    try {
      items = await extractCatalogListing(platform, url, state.config.limit);
    } catch (e: any) {
      const msg = `[${platform}] error al listar catálogo: ${e?.message || e}`;
      catalogErrors.push(msg);
      log("error", msg);
      continue;
    }

    log("info", `[${platform}] ${items.length} item(s) extraído(s) del listado.`);
    state.progress.total += items.length;

    for (const item of items) {
      itemsSeen++;
      if (!item.title) {
        state.progress.done++;
        continue;
      }
      // Dedup: ficha ya analizada en otra plataforma → saltar.
      if (item.url && analyzedUrls.has(item.url)) {
        state.progress.done++;
        continue;
      }
      if (item.url) analyzedUrls.add(item.url);

      state.currentItem = `[${platform}] ${item.title}`;
      const key = normalizeTitleKey(item.title);
      const itemKind = inferKindForPlatform(platform, item.kind);

      try {
        let analysis: any = null;
        let tmdbIdToUse: number | null = null;

        // 1. Analizar item.url UNA sola vez antes de decidir
        if (item.url) {
          try {
            analysis = await analyzeUniversalUrl(item.url);
            if (analysis.tmdb_id && analysis.tmdb_id > 0) {
              tmdbIdToUse = analysis.tmdb_id;
            }
            // Cortesía
            await sleep(50 + Math.random() * 50);
          } catch (e: any) {
            log("warn", `[${platform}] análisis falló para '${item.title}': ${e?.message || e}`);
          }
        }

        // 2. Resolver identidad usando tmdb_id como prioridad, título como fallback
        const existing = await findKnownWork(key, item.year, itemKind, tmdbIdToUse);

        if (existing) {
          known++;
          state.progress.known++;
          // Anomalía anotable sin scrappear fichas: conocida pero sin episodios locales.
          if (existing.episodeCount === 0) withoutEpisodes.push(existing.title);

          // ── RE-ESCANEO LIGERO CON ÍNDICE ──
          if (state.config.sync_known_episodes !== false && analysis) {
            try {
              const eps = buildEpisodesFromAnalysis(analysis, platform, itemKind);
              const syncResult = await quickSyncKnownShow(existing.id, {
                title: analysis.title || item.title,
                episodes: eps,
                source_site: analysis.source_domain || platform,
              });
              if (syncResult.added > 0) {
                state.progress.new_episodes += syncResult.added;
                log("info", `[${platform}] '${existing.title}': +${syncResult.added} episodio(s) nuevo(s) detectado(s) por índice.`);
              }
              if (syncResult.sourcesAdded && syncResult.sourcesAdded > 0) {
                state.progress.sources_added += syncResult.sourcesAdded;
              }
            } catch (e: any) {
              log("warn", `[${platform}] re-escaneo ligero de '${existing.title}': ${e?.message || e}`);
            }
          }
        } else {
          newDetected++;
          state.progress.new_sources++;
          const kind = itemKind;
          const eps = buildEpisodesFromAnalysis(analysis, platform, kind);
          const detectedStreams: string[] = Array.isArray(analysis?.detected_streams) ? analysis.detected_streams : [];

          const result = await saveShowWithDeduplication({
            title: analysis?.title || item.title,
            original_title: analysis?.original_title || undefined,
            tmdb_id: tmdbIdToUse || undefined,
            poster_url: analysis?.poster_url || item.image_url || undefined,
            banner_url: analysis?.banner_url || undefined,
            year: analysis?.year || (item.year && Number.isFinite(item.year) && item.year > 1900 ? item.year : undefined),
            rating: analysis?.rating || (item.rating && Number.isFinite(item.rating) ? item.rating : undefined),
            genres: analysis?.genres || (Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : undefined),
            content_type: kind,
            source_site: analysis?.source_domain || platform,
            source: platform,
            description: analysis?.description || undefined,
            detected_streams: detectedStreams,
            episodes: eps,
          });

          if (result.isDuplicate) {
            mergedByDedup++;
            state.progress.works_merged++;
            log("info", `[${platform}] '${result.show.title}' llegó como nueva pero el dedup la fusionó.`);
          } else {
            imported++;
            state.progress.new_works++;
            log("info", `[${platform}] Nueva obra importada: '${result.show.title}'.`);
          }

          if (result.episodesAdded > 0) {
            state.progress.new_episodes += result.episodesAdded;
          }
          if (result.sourcesAdded && result.sourcesAdded > 0) {
            state.progress.sources_added += result.sourcesAdded;
          }

          // El import dispara cascada TMDB/AniList: pausa ligera.
          await sleep(100 + Math.random() * 100);
        }
      } catch (e: any) {
        state.progress.errors++;
        const msg = `[${platform}] item '${item.title}': ${e?.message || e}`;
        catalogErrors.push(msg);
        log("error", msg);
      }

      state.progress.done++;
      await sleep(10 + Math.random() * 10); // lookups locales por índice súper rápidos
    }
  }

  const finishedAt = new Date().toISOString();
  state.lastReport = {
    started_at: state.startedAt || finishedAt,
    finished_at: finishedAt,
    duration_ms: state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0,
    trigger: opts.trigger || "manual",
    scope: {
      mode: cfg.scope_mode,
      platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
      category: cfg.category ?? null,
    },
    metadata_phase: {
      works_total: runCounters.metaTotal,
      works_done: runCounters.metaDone,
      updated_metadata: runCounters.metaUpdated,
      errors: runCounters.metaErrors,
    },
    catalog_phase: {
      skipped: false,
      platforms_checked: checked,
      platforms_skipped_no_url: noUrl,
      items_seen: itemsSeen,
      known,
      known_without_episodes: withoutEpisodes,
      new_detected: newDetected,
      imported,
      merged_by_dedup: mergedByDedup,
      errors: catalogErrors,
      works_merged: state.progress.works_merged || 0,
      sources_added: state.progress.sources_added || 0,
    },
  };
  log(
    "info",
    `Pasada finalizada: ${imported} nueva(s) importada(s), ${known} conocida(s), ${runCounters.metaUpdated} obra(s) con metadatos reparados, ${runCounters.metaErrors + catalogErrors.length} error(es).`
  );
}

// ── Orquestación de una pasada ───────────────────────────────────

async function runPass(opts: VerificationRunOptions): Promise<void> {
  const cfg = getVerificationConfig();
  // mode override por pasada: no muta config persistida.
  // - "metadata": solo metadatos.
  // - "full": metadatos + catálogo, incluso si config.metadata_only === true.
  // - undefined: obedece config.metadata_only.
  const metadataOnly = opts.mode === "metadata" ? true : opts.mode === "full" ? false : cfg.metadata_only;
  try {
    await metadataPhase(cfg, opts);
    if (!metadataOnly) {
      await catalogPhase(cfg, opts);
    } else {
      const finishedAt = new Date().toISOString();
      state.lastReport = {
        started_at: state.startedAt || finishedAt,
        finished_at: finishedAt,
        duration_ms: state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0,
        trigger: opts.trigger || "manual",
        scope: {
          mode: cfg.scope_mode,
          platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
          category: cfg.category ?? null,
        },
        metadata_phase: {
          works_total: runCounters.metaTotal,
          works_done: runCounters.metaDone,
          updated_metadata: runCounters.metaUpdated,
          errors: runCounters.metaErrors,
        },
        catalog_phase: {
          skipped: true,
          platforms_checked: [],
          platforms_skipped_no_url: [],
          items_seen: 0,
          known: 0,
          known_without_episodes: [],
          new_detected: 0,
          imported: 0,
          merged_by_dedup: 0,
          errors: [],
          works_merged: 0,
          sources_added: 0,
        },
      };
      log("info", `Pasada (solo metadatos) finalizada: ${state.progress.updated_metadata} obra(s) reparada(s).`);
    }
  } catch (e: any) {
    state.progress.errors++;
    log("error", `Pasada abortada: ${e?.message || e}`);
    // Reporte mínimo de aborto para que el UI nunca quede sin last_report.
    const finishedAt = new Date().toISOString();
    state.lastReport = {
      started_at: state.startedAt || finishedAt,
      finished_at: finishedAt,
      duration_ms: state.startedAt ? Date.now() - new Date(state.startedAt).getTime() : 0,
      trigger: opts.trigger || "manual",
      scope: {
        mode: cfg.scope_mode,
        platforms: opts.platforms?.length ? opts.platforms : cfg.scope_mode === "platforms" ? cfg.platforms : [],
        category: cfg.category ?? null,
      },
      metadata_phase: {
        works_total: runCounters.metaTotal,
        works_done: runCounters.metaDone,
        updated_metadata: runCounters.metaUpdated,
        errors: runCounters.metaErrors + 1,
      },
      catalog_phase: {
        skipped: true,
        platforms_checked: [],
        platforms_skipped_no_url: [],
        items_seen: 0,
        known: 0,
        known_without_episodes: [],
        new_detected: 0,
        imported: 0,
        merged_by_dedup: 0,
        errors: [String(e?.message || e).slice(0, 500)],
        works_merged: 0,
        sources_added: 0,
      },
    };
  }
}

// ── Boot: SOLO programa el timer (nunca barrido completo al arrancar) ──
scheduleTimer();
