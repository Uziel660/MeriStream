// server/verificationWorker.ts
// ══════════════════════════════════════════════════════════════════
// APARTADO DE VERIFICACIÓN: motor unificado en 3 FASES que recorre
// el catálogo según el scope configurado:
//
//  (1) FASE 1: METADATOS INICIALES — re-enriquece y repara cada obra existente
//      reusando backfillShow() de ./metadataBackfill (completa huecos con
//      datos REALES de TMDB/AniList; nunca sobrescribe datos existentes).
//  (2) FASE 2: CATÁLOGO Y NOVEDADES — recorre las páginas de catálogo de CADA
//      plataforma del scope (con paginación multi-página autónoma hasta agotar)
//      y cruza los títulos contra la BD por CLAVE CANÓNICA en lote (0-lag fast-path).
//      Las obras conocidas se reescanean de forma ligera (incluidas películas
//      para recoger nuevas fuentes); lo NUEVO se importa con
//      saveShowWithDeduplication y los episodios nuevos se sincronizan.
//  (3) FASE 3: NORMALIZACIÓN FINAL — segunda pasada rápida de metadatos sobre
//      cualquier obra recién importada o modificada en la Fase 2, garantizando
//      que todo el catálogo quede 100% enriquecido, pulido y normalizado.
//
// Incluye control de PAUSA, REANUDACIÓN y DETENCIÓN interactivo.
// Config persistida en data/verification.config.json.
// ══════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { prisma } from "./db";
import { backfillShow, showNeedsBackfill } from "./metadataBackfill";
import { extractCatalogListing, analyzeUniversalUrl } from "./universalScraper";
import { saveShowWithDeduplication, quickSyncKnownShow } from "./showService";
import { parseTitleQuery } from "./metadataEngine";
import { normalizeTitleKey, isPlausibleTitle, cleanSlugToWords } from "./utils/titleNormalizer";
import { isPlausibleYear } from "./metadataMerge";
import { buildPageUrl } from "./utils/pageUrlBuilder";
import { sanitizeCatalogLandingPages } from "./catalogIntegrity";
import type { ContentKind, SourceLinkInput } from "./types";

// ── Contrato público ─────────────────────────────────────────────

export interface VerificationConfig {
  enabled: boolean;
  interval_minutes: number;
  scope_mode: "all" | "platforms" | "category";
  platforms: string[];
  category?: string;
  catalog_urls_by_platform: Record<string, string>;
  metadata_only: boolean;
  /** Re-escaneo ligero de conocidas: detecta e inserta episodios nuevos. Default: true. */
  sync_known_episodes: boolean;
  /** Páginas a recorrer por plataforma (0 = sin límite / hasta agotar catálogo). Default: 0. */
  catalog_pages_per_platform?: number;
}

export interface VerificationRunOptions {
  /** Override de modo SOLO para esta pasada (no muta config persistida). */
  mode?: "metadata" | "full" | "identity";
  /** Override de plataformas SOLO para esta pasada. */
  platforms?: string[];
  /** Tope de obras (fase metadatos) e items por página. */
  limit?: number;
  /** Páginas a escanear por plataforma en esta pasada (override, 0 = sin límite). */
  pages_per_platform?: number;
  /** Uso interno: marca el origen de la pasada en el reporte. */
  trigger?: "manual" | "timer";
}

export interface VerificationProgress {
  total: number;
  done: number;
  percent: number;
  new_works: number;
  new_sources: number;
  known: number;
  known_without_episodes: number;
  new_episodes: number;
  updated_metadata: number;
  errors: number;
  works_merged: number;
  sources_added: number;
  // Aliases canónicos
  metadata_updated?: number;
  works_created?: number;
  episodes_added?: number;
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
  sync_known_episodes: boolean;
  running: boolean;
  paused: boolean;
  phase: "idle" | "metadata" | "catalog" | "identity" | "finalizing" | "paused";
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
  animeflv: "https://animeflv.or.at/anime/",
  tioanime: "https://tioanime.com/directorio",
  latanime: "https://latanime.org/animes",
  cinecalidad: "https://www.cinecalidad.am/",
  tioplus: "https://tioplus.app/peliculas",
  doramasflix: "https://doramasflix.io/doramas",
  doramasflix_peliculas: "https://doramasflix.io/peliculas",
  doramasflix_variedades: "https://doramasflix.io/variedades",
  tudorama: "https://tudorama.com/genero/series/",
  tudorama_peliculas: "https://tudorama.com/genero/peliculas/",
  lamovie_movies: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
  lamovie_series: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
  lamovie_animes: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24",
};

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "verification.config.json");

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 525600; // 1 año
const SCOPE_MODES = ["all", "platforms", "category"] as const;
const SUPPORTED_CATEGORIES = ["anime", "movie", "movies", "series"] as const;

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
    catalog_pages_per_platform: 0, // 0 = sin límite / hasta agotar
  };
}

function loadConfigFromDisk(): VerificationConfig {
  const base = defaultConfig();
  try {
    if (!fs.existsSync(CONFIG_PATH)) return base;
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
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
    if (raw?.catalog_pages_per_platform !== undefined && Number.isFinite(Number(raw.catalog_pages_per_platform))) {
      base.catalog_pages_per_platform = Math.max(0, Math.round(Number(raw.catalog_pages_per_platform)));
    }
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
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
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
  paused: false,
  stopped: false,
  isMetadataOnlyRun: false,
  runMode: "full" as "metadata" | "full" | "identity",
  phase: "idle" as "idle" | "metadata" | "catalog" | "identity" | "finalizing" | "paused",
  currentItem: null as string | null,
  startedAt: null as string | null,
  lastRunAt: null as string | null,
  nextRunAt: null as string | null,
  progress: {
    total: 0,
    done: 0,
    percent: 0,
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

const runCounters = {
  metaTotal: 0,
  metaDone: 0,
  metaUpdated: 0,
  metaErrors: 0,
  catalogTotal: 0,
  catalogDone: 0,
  finalMetaTotal: 0,
  finalMetaDone: 0,
};

function resetRunCounters(): void {
  runCounters.metaTotal = 0;
  runCounters.metaDone = 0;
  runCounters.metaUpdated = 0;
  runCounters.metaErrors = 0;
  runCounters.catalogTotal = 0;
  runCounters.catalogDone = 0;
  runCounters.finalMetaTotal = 0;
  runCounters.finalMetaDone = 0;
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
    if (state.running) return;
    runVerification({ trigger: "timer" });
  }, ms);
  (state.timer as unknown as { unref?: () => void })?.unref?.();
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
  if (patch.platforms !== undefined) {
    if (!Array.isArray(patch.platforms)) throw new Error("'platforms' debe ser un array de strings");
    const cleaned = [...new Set(patch.platforms.map(cleanPlatform).filter(Boolean))];
    for (const p of cleaned) {
      const url = next.catalog_urls_by_platform[p];
      if (!url || typeof url !== "string" || !url.trim() || !isValidUrlOrEmpty(url)) {
        throw new Error(`Plataforma '${p}' no tiene una URL de catálogo válida configurada`);
      }
    }
    next.platforms = cleaned;
  }
  if (patch.category !== undefined) {
    if (patch.category === null || patch.category === "") {
      next.category = undefined;
    } else if (typeof patch.category === "string") {
      const c = patch.category.trim().toLowerCase();
      if (!SUPPORTED_CATEGORIES.includes(c as any)) {
        throw new Error(`Categoría inválida '${patch.category}'. Categorías soportadas: ${SUPPORTED_CATEGORIES.join(", ")}`);
      }
      next.category = c;
    } else {
      throw new Error("'category' debe ser string o null"); // NOSONAR
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
  if (patch.catalog_pages_per_platform !== undefined) {
    if (Number.isFinite(Number(patch.catalog_pages_per_platform))) {
      next.catalog_pages_per_platform = Math.max(0, Math.round(Number(patch.catalog_pages_per_platform)));
    }
  }

  if (next.scope_mode === "platforms" && next.platforms.length === 0) {
    throw new Error("'platforms' requiere al menos una plataforma cuando scope_mode es 'platforms'");
  }
  if (next.scope_mode === "category" && !next.category) {
    throw new Error("'category' es requerida cuando scope_mode es 'category'");
  }

  state.config = next;
  persistConfig(next);
  scheduleTimer();
  log("info", `Config actualizada (enabled=${next.enabled}, intervalo=${next.interval_minutes}min, scope=${next.scope_mode}, paginación=${next.catalog_pages_per_platform === 0 ? "sin límite" : next.catalog_pages_per_platform}).`);
  return getVerificationConfig();
}

// ── API pública: Control de ejecución (Run / Pause / Resume / Stop) ─

export function runVerification(options?: VerificationRunOptions): { started: boolean; reason?: string; status?: VerificationStatus } {
  if (state.running) {
    return { started: false, reason: "already_running", status: getVerificationStatus() };
  }
  state.running = true;
  state.paused = false;
  state.stopped = false;
  state.runMode = options?.mode || (state.config.metadata_only ? "metadata" : "full");
  state.phase = state.runMode === "identity" ? "identity" : "metadata";
  state.currentItem = null;
  state.startedAt = new Date().toISOString();
  state.isMetadataOnlyRun = state.runMode !== "full";
  state.progress = {
    total: 0,
    done: 0,
    percent: 0,
    new_works: 0,
    new_sources: 0,
    known: 0,
    known_without_episodes: 0,
    new_episodes: 0,
    updated_metadata: 0,
    errors: 0,
    works_merged: 0,
    sources_added: 0,
  };
  resetRunCounters();
  log("info", `Pasada ${options?.trigger || "manual"} iniciada (Saneamiento de Enlaces -> Metadatos -> Catálogo y Nuevos Episodios -> Normalización final).`);

  void runPass(options || {}).finally(() => {
    state.running = false;
    state.paused = false;
    state.stopped = false;
    state.phase = "idle";
    state.runMode = "full";
    state.currentItem = null;
    state.lastRunAt = new Date().toISOString();
    if (state.config.enabled && !state.nextRunAt) scheduleTimer();
  });

  return { started: true, status: getVerificationStatus() };
}

export function pauseVerification(): { ok: boolean; message: string; status: VerificationStatus } {
  if (!state.running) {
    return { ok: false, message: "No hay ninguna verificación en ejecución.", status: getVerificationStatus() };
  }
  if (state.paused) {
    return { ok: true, message: "La verificación ya se encuentra pausada.", status: getVerificationStatus() };
  }
  state.paused = true;
  log("warn", "Verificación pausada por el usuario.");
  return { ok: true, message: "Verificación pausada.", status: getVerificationStatus() };
}

export function resumeVerification(): { ok: boolean; message: string; status: VerificationStatus } {
  if (!state.running) {
    return { ok: false, message: "No hay ninguna verificación para reanudar.", status: getVerificationStatus() };
  }
  if (!state.paused) {
    return { ok: true, message: "La verificación ya está en ejecución activa.", status: getVerificationStatus() };
  }
  state.paused = false;
  log("info", "Verificación reanudada por el usuario.");
  return { ok: true, message: "Verificación reanudada.", status: getVerificationStatus() };
}

export function stopVerification(): { ok: boolean; message: string; status: VerificationStatus } {
  if (!state.running) {
    return { ok: false, message: "No hay ninguna verificación en ejecución.", status: getVerificationStatus() };
  }
  state.stopped = true;
  state.paused = false;
  log("warn", "Deteniendo la verificación...");
  return { ok: true, message: "Deteniendo verificación...", status: getVerificationStatus() };
}

export function getVerificationStatus(): VerificationStatus { // NOSONAR
  const c = state.config;
  const p = state.progress;

  let computedPercent = 0;
  if (state.running) {
    if (state.isMetadataOnlyRun) {
      computedPercent = runCounters.metaTotal > 0
        ? Math.min(100, Math.round((runCounters.metaDone / runCounters.metaTotal) * 100))
        : 0;
    } else {
      const metaFraction = runCounters.metaTotal > 0
        ? Math.min(1, runCounters.metaDone / runCounters.metaTotal)
        : 0;
      const catalogFraction = state.progress.total > 0
        ? Math.min(1, state.progress.done / state.progress.total)
        : 0;
      const finalMetaFraction = runCounters.finalMetaTotal > 0
        ? Math.min(1, runCounters.finalMetaDone / runCounters.finalMetaTotal)
        : 0;

    if (state.phase === "metadata" || state.phase === "identity") {
        computedPercent = Math.min(25, Math.round(metaFraction * 25));
      } else if (state.phase === "catalog") {
        computedPercent = Math.min(85, Math.round(25 + catalogFraction * 60));
      } else if (state.phase === "finalizing") {
        computedPercent = Math.min(99, Math.round(85 + finalMetaFraction * 14));
      }
    }
  } else if (state.lastReport) {
    computedPercent = 100;
  }

  const phaseName = state.paused ? "paused" : state.phase;

  return {
    enabled: c.enabled,
    interval_minutes: c.interval_minutes,
    scope_mode: c.scope_mode,
    platforms: [...c.platforms],
    category: c.category ?? null,
    metadata_only: c.metadata_only,
    sync_known_episodes: c.sync_known_episodes !== false,
    running: state.running,
    paused: state.paused,
    phase: phaseName,
    current_item: state.currentItem,
    progress: {
      ...p,
      percent: computedPercent,
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
    return overridePlatforms
      .map(cleanPlatform)
      .filter((p) => Boolean(p && cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "platforms") {
    return cfg.platforms
      .map(cleanPlatform)
      .filter((p) => Boolean(p && cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "category") {
    const cat = String(cfg.category || "").toLowerCase().trim();
    const mapped = CATEGORY_PLATFORM_MAP[cat];
    if (!mapped || mapped.length === 0) return [];
    return mapped.filter((p) => Boolean(cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p])));
  }
  if (cfg.scope_mode === "all") {
    return Object.keys(cfg.catalog_urls_by_platform).filter(
      (p) => Boolean(cfg.catalog_urls_by_platform[p] && isValidUrlOrEmpty(cfg.catalog_urls_by_platform[p]))
    );
  }
  return [];
}

async function resolveMetadataShowIds(cfg: VerificationConfig, overridePlatforms?: string[]): Promise<string[]> {
  if (overridePlatforms && overridePlatforms.length > 0) {
    return showsLinkedToPlatforms(overridePlatforms.filter((p) => Boolean(cfg.catalog_urls_by_platform[cleanPlatform(p)])));
  }
  if (cfg.scope_mode === "category") {
    const cat = String(cfg.category || "").toLowerCase().trim();
    if (!SUPPORTED_CATEGORIES.includes(cat as any)) return [];
    const rows = await prisma.show.findMany({
      where: { category: { contains: cat } },
      select: { id: true },
      orderBy: { created_at: "asc" },
    });
    return rows.map((r) => r.id);
  }
  if (cfg.scope_mode === "platforms") {
    return showsLinkedToPlatforms(cfg.platforms.filter((p) => Boolean(cfg.catalog_urls_by_platform[cleanPlatform(p)])));
  }
  if (cfg.scope_mode === "all") {
    const rows = await prisma.show.findMany({ select: { id: true }, orderBy: { created_at: "asc" } });
    return rows.map((r) => r.id);
  }
  return [];
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
  const CHUNK = 400;
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

// ── Fase 1 & 3: Metadatos (Inicial y Normalización Final) ─────────

async function metadataPhase(
  cfg: VerificationConfig,
  opts: VerificationRunOptions,
  stage: "initial" | "final" = "initial"
): Promise<void> {
  state.phase = stage === "initial" ? (state.runMode === "identity" ? "identity" : "metadata") : "finalizing";
  const showIds = await resolveMetadataShowIds(cfg, opts.platforms);
  const limited = opts.limit && opts.limit > 0 ? showIds.slice(0, opts.limit) : showIds;

  if (stage === "initial") {
    runCounters.metaTotal = limited.length;
    state.progress.total = limited.length;
    log("info", `${state.runMode === "identity" ? "Identificación del catálogo interno" : "Fase 1/3 (Metadatos existentes)"}: ${limited.length} obra(s) en cola (scope=${cfg.scope_mode}).`);
  } else {
    runCounters.finalMetaTotal = limited.length;
    log("info", `Fase 3/3 (Normalización y pulido final): verificando ${limited.length} obra(s)...`);
  }

  // Concurrencia optimizada: PostgreSQL local aguanta 30+ sin degradación
  const CONCURRENCY = 35;
  let cursor = 0;
  const worker = async (): Promise<void> => { // NOSONAR
    for (;;) {
      if (state.stopped) return;
      while (state.paused && !state.stopped) {
        await sleep(400);
      }
      if (state.stopped) return;

      const idx = cursor++;
      if (idx >= limited.length) return;
      const showId = limited[idx];
      try {
        const row = await prisma.show.findUnique({
          where: { id: showId },
          select: { id: true, title: true, description: true, poster_url: true, banner_url: true, genres: true, year: true, tmdb_id: true },
        });
        state.currentItem = row?.title || showId;
        if (row && showNeedsBackfill(row)) {
          const result = await backfillShow(showId);
          if (result.changed.length > 0) {
            runCounters.metaUpdated++;
            state.progress.updated_metadata = runCounters.metaUpdated;
            log("info", `Metadatos completados en '${result.title}': ${result.changed.join(", ")}`);
          }
          await sleep(20 + Math.random() * 20);
        }
      } catch (e: any) {
        if (stage === "initial") {
          runCounters.metaErrors++;
        }
        state.progress.errors++;
        log("warn", `Error en backfill de obra ${showId}: ${e?.message || e}`);
      }

      if (stage === "initial") {
        runCounters.metaDone++;
        state.progress.done = runCounters.metaDone;
      } else {
        runCounters.finalMetaDone++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, limited.length || 1) }, () => worker()));
}

// ── Fase 2: Novedades por plataforma ─────────────────────────────

function inferKindForPlatform(platformKey: string, itemKind?: ContentKind | null): ContentKind {
  if (itemKind) return itemKind;
  const k = platformKey.toLowerCase();
  if (k.includes("anime")) return "anime";
  if (k.includes("serie") || k.includes("tvshow")) return "series";
  return "movie";
}

async function findKnownWork(titleKey: string, year?: number | null, kind?: ContentKind, tmdbId?: number | null): Promise<{ id: string; title: string; category?: string | null; episodeCount: number } | null> {
  if (tmdbId && tmdbId > 0) {
    const byTmdb = await prisma.show.findFirst({
      where: { tmdb_id: tmdbId, ...(kind ? { category: kind } : {}) },
      orderBy: { created_at: "asc" },
      select: { id: true, title: true, category: true, _count: { select: { episodes: true } } },
    });
    if (byTmdb) return { id: byTmdb.id, title: byTmdb.title, category: byTmdb.category, episodeCount: byTmdb._count.episodes };
  }
  if (!titleKey) return null;
  const showCandidates = await prisma.show.findMany({
    where: {
      OR: [{ base_normalized_title: titleKey }, { normalized_title: titleKey }],
      ...(kind ? { category: kind } : {}),
    },
    orderBy: { created_at: "asc" },
    select: { id: true, title: true, category: true, year: true, _count: { select: { episodes: true } } },
    take: 20,
  });
  const requestedYear = isPlausibleYear(year) ? year! : null;
  const show = requestedYear
    ? showCandidates.find((candidate) => candidate.year === requestedYear) ??
      showCandidates.find((candidate) => !isPlausibleYear(candidate.year)) ??
      null
    : showCandidates[0] ?? null;
  if (show) {
    return { id: show.id, title: show.title, category: show.category, episodeCount: show._count.episodes };
  }
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
  const isMovie = kind === "movie" || analysis.content_type === "movie";

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
            language: typeof s === "object" ? s.language : undefined,
            audio_language: typeof s === "object" ? s.audio_language : undefined,
            subtitle_language: typeof s === "object" ? s.subtitle_language : undefined,
            subtitles: typeof s === "object" ? s.subtitles : undefined,
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

  return rawEpisodes.map((e: any, idx: number) => { // NOSONAR
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
            language: typeof s === "object" ? s.language : undefined,
            audio_language: typeof s === "object" ? s.audio_language : undefined,
            subtitle_language: typeof s === "object" ? s.subtitle_language : undefined,
            subtitles: typeof s === "object" ? s.subtitles : undefined,
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


interface CatalogPhaseStats {
  itemsSeen: number;
  known: number;
  newDetected: number;
  imported: number;
  mergedByDedup: number;
  withoutEpisodes: string[];
  catalogErrors: string[];
}

async function processCatalogItem( // NOSONAR
  item: any,
  platform: string,
  knownMap: Map<string, { id: string; title: string; category?: string | null; _count?: { episodes: number } } | any>,
  analyzedUrls: Set<string>,
  stats: CatalogPhaseStats
): Promise<void> {
  if (state.stopped) return;
  stats.itemsSeen++;
  runCounters.catalogDone++;
  state.progress.done = runCounters.metaDone + runCounters.catalogDone;

  if (!item.title) return;
  if (item.url && analyzedUrls.has(item.url)) return;
  if (item.url) analyzedUrls.add(item.url);

  state.currentItem = `[${platform}] ${item.title}`;
  const key = normalizeTitleKey(item.title);
  const itemKind = inferKindForPlatform(platform, item.kind);

  // 1. FAST-PATH: Detección instantánea en memoria / índice BD
  const batchMatch = knownMap.get(key);
  const existing = batchMatch
    ? { id: batchMatch.id, title: batchMatch.title, category: batchMatch.category, episodeCount: batchMatch._count.episodes }
    : await findKnownWork(key, item.year, itemKind);

  if (existing) {
    stats.known++;
    state.progress.known++;
    if (existing.episodeCount === 0) stats.withoutEpisodes.push(existing.title);

    const skipDetailFetch = state.config.sync_known_episodes === false || !item.url;
    if (skipDetailFetch) {
      return;
    }

    // Si es serie/anime y tiene activado sync_known_episodes: re-escaneo ligero
    if (state.config.sync_known_episodes !== false && item.url) {
      try {
        const analysis = await analyzeUniversalUrl(item.url);
        const eps = buildEpisodesFromAnalysis(analysis, platform, itemKind);
        const syncResult = await quickSyncKnownShow(existing.id, {
          title: analysis?.title || item.title,
          season: parseTitleQuery(`${item.title} ${item.url || ""}`).season,
          episodes: eps,
          source_site: analysis?.source_domain || platform,
        });
        if (syncResult.added > 0) {
          state.progress.new_episodes += syncResult.added;
          log("info", `[${platform}] '${existing.title}': +${syncResult.added} episodio(s) nuevo(s) detectado(s).`);
        }
        if (syncResult.sourcesAdded && syncResult.sourcesAdded > 0) {
          state.progress.sources_added += syncResult.sourcesAdded;
        }
      } catch (e: any) {
        log("warn", `[${platform}] Re-escaneo de '${existing.title}': ${e?.message || e}`);
      }
    }
    return;
  }

  // 2. OBRA NUEVA NO RECONOCIDA: Fetch y guardado enriquecido TMDB
  stats.newDetected++;
  state.progress.new_sources++;

  try {
    let analysis: any = null;
    let tmdbIdToUse: number | null = null;

    if (item.url) {
      try {
        analysis = await analyzeUniversalUrl(item.url);
        if (analysis.tmdb_id && analysis.tmdb_id > 0) {
          tmdbIdToUse = analysis.tmdb_id;
        }
      } catch (e: any) {
        log("warn", `[${platform}] Análisis falló para '${item.title}': ${e?.message || e}`);
      }
    }

    const kind = itemKind;
    const eps = buildEpisodesFromAnalysis(analysis, platform, kind);
    const detectedStreams: string[] = Array.isArray(analysis?.detected_streams) ? analysis.detected_streams : [];

    const candidateTitle = (analysis?.title && isPlausibleTitle(analysis.title))
      ? analysis.title
      : (item.title && isPlausibleTitle(item.title))
        ? item.title
        : cleanSlugToWords(analysis?.title || item.title);

    const result = await saveShowWithDeduplication({
      title: candidateTitle,
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
      stats.mergedByDedup++;
      state.progress.works_merged++;
      log("info", `[${platform}] '${result.show.title}' fusionada con obra existente por deduplicación.`);
    } else {
      stats.imported++;
      state.progress.new_works++;
      log("info", `[${platform}] Nueva obra importada: '${result.show.title}'.`);
    }

    if (result.episodesAdded > 0) {
      state.progress.new_episodes += result.episodesAdded;
    }
    if (result.sourcesAdded && result.sourcesAdded > 0) {
      state.progress.sources_added += result.sourcesAdded;
    }
  } catch (e: any) {
    state.progress.errors++;
    const msg = `[${platform}] Item '${item.title}': ${e?.message || e}`;
    stats.catalogErrors.push(msg);
    log("error", msg);
  }
}

// ── Fase 2: Novedades por catálogo multi-página ultra-optimizado ─


async function catalogPhase(cfg: VerificationConfig, opts: VerificationRunOptions): Promise<void> {
  state.phase = "catalog";
  const platforms = resolveCatalogPlatforms(cfg, opts.platforms);

  // 0 o no configurado = Sin límite / hasta agotar catálogo (fusible de seguridad en 5000 páginas)
  const configuredPages = opts.pages_per_platform !== undefined // NOSONAR
    ? opts.pages_per_platform // NOSONAR
    : (cfg.catalog_pages_per_platform !== undefined ? cfg.catalog_pages_per_platform : 0); // NOSONAR
  const maxPages = configuredPages > 0 ? configuredPages : 5000;
  const isUnlimited = configuredPages === 0; // NOSONAR

  log(
    "info",
    `Fase 2/3 (Catálogo): ${platforms.length} plataforma(s) en cola (${isUnlimited ? "recorrido autónomo hasta agotar" : `máximo ${maxPages} páginas c/u`}).` // NOSONAR
  );

  const stats: CatalogPhaseStats = {
    itemsSeen: 0,
    known: 0,
    newDetected: 0,
    imported: 0,
    mergedByDedup: 0,
    withoutEpisodes: [],
    catalogErrors: [],
  };
  const checked: string[] = [];
  const noUrl: string[] = [];
  const analyzedUrls = new Set<string>();

  state.progress.total = runCounters.metaTotal;

  for (const platform of platforms) {
    if (state.stopped) return;
    while (state.paused && !state.stopped) {
      await sleep(400);
    }
    if (state.stopped) return;

    const baseCatalogUrl = cfg.catalog_urls_by_platform[platform];
    if (!baseCatalogUrl) {
      noUrl.push(platform);
      log("warn", `[${platform}] Sin URL de catálogo configurada, saltando.`);
      continue;
    }
    checked.push(platform);

    let consecutiveEmptyPages = 0;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (state.stopped) return;
      while (state.paused && !state.stopped) {
        await sleep(400);
      }
      if (state.stopped) return;

      const pageUrl = buildPageUrl(baseCatalogUrl, pageNum);
      state.currentItem = `[${platform}] Pág. ${pageNum} - ${pageUrl}`;

      let items: any[] = [];
      try {
        const extracted = await extractCatalogListing(pageUrl);
        items = opts.limit && opts.limit > 0 ? extracted.slice(0, opts.limit) : extracted;
      } catch (e: any) {
        const msg = `[${platform}] Error al extraer página ${pageNum} (${pageUrl}): ${e?.message || e}`;
        stats.catalogErrors.push(msg);
        log("error", msg);
        consecutiveEmptyPages++;
        if (consecutiveEmptyPages >= 3) break;
        continue;
      }

      if (!items || items.length === 0) {
        consecutiveEmptyPages++;
        if (pageNum > 1) {
          log("info", `[${platform}] Fin del catálogo alcanzado en página ${pageNum}.`);
          break;
        }
        continue;
      }

      // En página > 1, si todos los items ya fueron analizados en esta pasada, el catálogo ya converge
      if (pageNum > 1 && items.every((it) => it.url && analyzedUrls.has(it.url))) {
        log("info", `[${platform}] Página ${pageNum} sin items nuevos, catálogo al día. Pasando a siguiente plataforma.`);
        break;
      }

      state.progress.total += items.length;
      consecutiveEmptyPages = 0;

      // ── FAST-PATH: BATCH PRE-LOOKUP EN BD (1 QUERY POR PÁGINA) ────
      const pageTitleKeys = items.map((it) => normalizeTitleKey(it.title)).filter(Boolean);
      let knownShowsInBatch: any[] = [];
      try {
        knownShowsInBatch = await prisma.show.findMany({
          where: {
            OR: [
              { normalized_title: { in: pageTitleKeys } },
              { base_normalized_title: { in: pageTitleKeys } },
            ],
          },
          select: {
            id: true,
            title: true,
            year: true,
            category: true,
            normalized_title: true,
            base_normalized_title: true,
            _count: { select: { episodes: true } },
          },
        });
      } catch {
        // Fallback tolerante
      }

      const knownMap = new Map<string, typeof knownShowsInBatch[0]>();
      for (const s of knownShowsInBatch) {
        if (s.normalized_title) knownMap.set(s.normalized_title, s);
        if (s.base_normalized_title) knownMap.set(s.base_normalized_title, s);
      }

      // ── PROCESAMIENTO CONCURRENTE POR CHUNKS (10 simultáneos) ──
      const CHUNK_SIZE = 10;
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        if (state.stopped) return;
        while (state.paused && !state.stopped) {
          await sleep(400);
        }
        if (state.stopped) return;

        const chunk = items.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map((item) => processCatalogItem(item, platform, knownMap, analyzedUrls, stats))
        );
      }
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
      items_seen: stats.itemsSeen,
      known: stats.known,
      known_without_episodes: stats.withoutEpisodes,
      new_detected: stats.newDetected,
      imported: stats.imported,
      merged_by_dedup: stats.mergedByDedup,
      errors: stats.catalogErrors,
      works_merged: state.progress.works_merged || 0,
      sources_added: state.progress.sources_added || 0,
    },
  };
}

// ── Orquestación de una pasada en 3 fases ─────────────────────────

async function runPass(opts: VerificationRunOptions): Promise<void> {
  const cfg = getVerificationConfig();
  const metadataOnly = opts.mode === "metadata" || opts.mode === "identity" ? true : opts.mode === "full" ? false : cfg.metadata_only;
  try {
    // ── FASE 0: Sanear y purgar automáticamente cualquier landing page residual ──
    try {
      const sanitized = await sanitizeCatalogLandingPages();
      log(
        "info",
        `[Fase 0: Saneamiento de Enlaces] Auditoría ejecutada: ${
          sanitized.totalCleaned > 0
            ? `${sanitized.totalCleaned} enlaces erróneos purgados exitosamente`
            : "0 anomalías de catálogo encontradas (base de datos 100% limpia)"
        }.`
      );
    } catch (e: any) {
      log("warn", `Aviso en saneamiento previo de enlaces: ${e?.message || e}`);
    }

    // ── FASE 1: Metadatos existentes ──
    await metadataPhase(cfg, opts, "initial");

    if (!metadataOnly && !state.stopped) {
      // ── FASE 2: Catálogo y novedades multi-página ──
      await catalogPhase(cfg, opts);

      if (!state.stopped) {
        // ── FASE 3: Normalización y enriquecimiento de metadatos de lo nuevo ──
        await metadataPhase(cfg, opts, "final");
      }

      log(
        "info",
        `Pasada completa finalizada: ${state.progress.new_works} nueva(s) importada(s), ${state.progress.known} conocida(s), ${state.progress.updated_metadata} obra(s) con metadatos normalizados/reparados.`
      );
    } else if (metadataOnly) {
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
      log("info", `${state.runMode === "identity" ? "Identificación del catálogo interno" : "Pasada (solo metadatos)"} finalizada: ${state.progress.updated_metadata} obra(s) reparada(s).`);
    }
  } catch (e: any) {
    state.progress.errors++;
    log("error", `Pasada abortada: ${e?.message || e}`);
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

// ── Boot: SOLO programa el timer ─────────────────────────────────
scheduleTimer();
