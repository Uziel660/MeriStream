// server/taskWorker.ts
// Background Worker with Rate Limiting, Anti-Blocking Jitter, Queue & Persistent Database Execution
// Barrido completo autónomo: en scope "full_catalog" la paginación es auto-descubierta
// (avanza página a página hasta que el sitio se agota), reanudable sin saltar páginas,
// con pools de concurrencia configurables y tolerancia a fallos por página/item.

import { analyzeUniversalUrl, extractCatalogListingsBatch } from "./universalScraper";
import { UniversalAnalysisResult } from "./types";
import { saveShowWithDeduplication, quickSyncKnownShow } from "./showService";
import { prisma } from "./db";
import { parseTitleQuery } from "./metadataEngine";
import { normalizeTitleKey } from "./utils/titleNormalizer";
import { isPlausibleYear } from "./metadataMerge";
import {
  detectAntiBot,
  recordAntiBotHit,
  countRecentAntiBotHits,
  getAntiBotReport,
  ANTIBOT_HIT_WINDOW_MS,
} from "./utils/antiBot";
import { enqueueWrite } from "./writeBuffer";
import { canonicalCatalogUrl, catalogPageFingerprint, dedupeCatalogItems, isRepeatedCatalogPage } from "./catalogIntegrity";
import { normalizeExtractedEpisodes } from "./catalogFusion";
import { buildCatalogPageUrl } from "./catalogPagination";
import { normalizeProviderId } from "./providers/providerPolicy";

export function sourceSiteFromUrl(url: string | undefined): string {
  try {
    const normalized = normalizeProviderId(url || "");
    if (normalized && normalized !== "unknown") return normalized;
    const host = new URL(url || "").hostname.replace(/^www\./, "") || "unknown";
    return host.split(".")[0] || host;
  } catch {
    return "unknown";
  }
}

function siteOf(url: string | undefined): string {
  return sourceSiteFromUrl(url);
}

export interface CrawlJob {
  id: string;
  name: string;
  target_url: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  scope: "single" | "catalog_pages" | "full_catalog";
  max_pages: number;
  current_page: number;
  total_discovered: number;
  shows_imported: number;
  episodes_imported: number;
  rate_limit_delay_ms: number;
  items_queue: Array<{ title: string; url: string; status: "pending" | "processing" | "done" | "error"; error?: string }>;
  current_item_title?: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  logs: Array<{ timestamp: string; level: "info" | "success" | "warn" | "error"; message: string }>;
  resolver_hint?: string | null;
  content_kind?: string | null;
  pagination_mode: "auto" | "template" | "examples" | string;
  pagination_template?: string | null;
  pagination_examples: string[];
}

export interface WorkerSettings {
  default_delay_ms: number;
  jitter_enabled: boolean;
  max_concurrent_jobs: number;
  user_agent_rotation: boolean;
  /** Páginas de catálogo pedidas en paralelo (RTT solapado; el ritmo cortés lo espacia igual). */
  page_concurrency: number;
  /** Obras procesadas en paralelo dentro de un job (solapa fetch del sitio con TMDB/DB). */
  item_concurrency: number;
}

// Valores conservadores para el equipo que aloja la aplicación (ASUS T100TA,
// 2 GB de RAM). El worker comparte proceso con Express, Prisma y el proxy de
// reproducción: abrir varios crawls y pools grandes puede consumir toda la
// memoria aunque el catálogo se importe más rápido. El usuario puede elevar
// estos valores explícitamente desde la configuración del worker cuando haga
// falta; estos son únicamente los valores de arranque seguros.
const DEFAULT_SETTINGS: WorkerSettings = {
  default_delay_ms: 1500,
  jitter_enabled: true,
  max_concurrent_jobs: 1,
  user_agent_rotation: true,
  page_concurrency: 1,
  item_concurrency: 1,
};

// Columnas que EXISTEN en la tabla WorkerSettingsStore (schema.prisma).
// page_concurrency/item_concurrency son nuevas y viven en memoria hasta migración de schema.
const DB_SETTING_KEYS: Array<keyof WorkerSettings> = [
  "default_delay_ms",
  "jitter_enabled",
  "max_concurrent_jobs",
  "user_agent_rotation",
];

// ── Barrido completo autónomo (full_catalog) ─────────────────────────────
// La paginación NO usa max_pages: avanza hasta que el sitio deja de devolver
// obras. Este techo existe SOLO como fusible anti-bucle-infinite.
const FULL_CATALOG_HARD_PAGE_CAP = 10000;
const MAX_CONSECUTIVE_PAGE_ERRORS = 5;
// HiAnimes has intermittently returned deterministic 500s for individual
// filter pages (the upstream projection error `__v`). Keep walking the
// catalogue through those holes instead of truncating a full crawl after the
// generic five-page safety fuse. The per-page request deadline and the global
// endPageExclusive bound still protect the worker from an endless loop.
const MAX_HIANIMES_CONSECUTIVE_PAGE_ERRORS = 50;
const NO_NEW_ITEM_PAGES_BEFORE_STOP = 2;

// Marcador persistido dentro de items_queue ("descubrimiento terminado").
// Evita tocar schema.prisma y permite REANUDAR sin repetir ni saltar páginas:
// si el proceso muere a mitad del barrido, al no estar el marcador se continúa
// desde current_page+1; si está, se salta directo a indexar lo descubierto.
const DISCOVERY_MARKER_URL = "__nitiflix_discovery_complete__";

// ── Auto-throttle anti-bot (por host, NO toca settings globales) ──
// Si un sitio acumula ≥3 señales en 10 min, se duplica el delay efectivo SOLO
// para ese dominio (máx x4). El override expira con la ventana.
const ANTIBOT_HITS_TO_THROTTLE = 3;
const ANTIBOT_MAX_THROTTLE_FACTOR = 4;

type QueueItem = CrawlJob["items_queue"][number];

export type CrawlPaginationMode = "auto" | "template" | "examples";

/** Extrae URLs de un textarea que puede incluir etiquetas como "Página 2:". */
export function extractPaginationUrls(value: unknown): string[] {
  const lines = Array.isArray(value) ? value : String(value || "").split(/\r?\n/);
  const urls: string[] = [];
  for (const line of lines) {
    const matches = String(line || "").match(/https?:\/\/[^\s<>"]+/gi) || [];
    for (const raw of matches) {
      const cleaned = raw.replace(/[),.;]+$/, "");
      try {
        const parsed = new URL(cleaned);
        if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !urls.includes(parsed.toString())) {
          urls.push(parsed.toString());
        }
      } catch {}
    }
  }
  return urls.slice(0, 12);
}

/**
 * Detecta el número de página que cambia entre dos enlaces y conserva el resto
 * de la URL como plantilla. También funciona con un solo enlace que use una
 * marca reconocible (page=2, /page/2, pagina-2, etc.).
 */
export function detectPaginationTemplate(input: unknown): { template: string; page_start: number; examples: string[] } | null {
  const examples = extractPaginationUrls(input);
  if (examples.length === 0) return null;
  const numberPattern = /\d+/g;
  const replaceAt = (source: string, start: number, length: number) => `${source.slice(0, start)}{page}${source.slice(start + length)}`;
  const first = examples[0];
  const firstMatches = Array.from(first.matchAll(numberPattern));

  for (let i = 1; i < examples.length; i++) {
    const other = examples[i];
    const a = Array.from(first.matchAll(numberPattern));
    const b = Array.from(other.matchAll(numberPattern));
    for (let idx = 0; idx < Math.min(a.length, b.length); idx++) {
      const av = Number(a[idx][0]);
      const bv = Number(b[idx][0]);
      if (!Number.isFinite(av) || !Number.isFinite(bv) || av === bv) continue;
      // El resto de la URL debe coincidir al quitar el número; esto evita
      // convertir un año del título en un falso paginador.
      const template = replaceAt(first, a[idx].index!, a[idx][0].length);
      const expected = replaceAt(other, b[idx].index!, b[idx][0].length);
      if (template === expected) return { template, page_start: av, examples };
    }
  }

  for (const match of firstMatches) {
    const index = match.index ?? 0;
    const before = first.slice(Math.max(0, index - 16), index).toLowerCase();
    if (/(?:page|pagina|página|pag|p)[^a-z0-9]{0,5}$/.test(before) || /\/\d+\/?$/.test(first.slice(Math.max(0, index - 7), index + match[0].length + 2))) {
      return { template: replaceAt(first, index, match[0].length), page_start: Number(match[0]), examples };
    }
  }
  return null;
}

function normalizePaginationMode(value: unknown): CrawlPaginationMode {
  return value === "template" || value === "examples" ? value : "auto";
}

function normalizeContentKind(value: unknown): "movie" | "series" | "anime" | null {
  const kind = String(value || "").trim().toLowerCase();
  if (kind === "movie" || kind === "pelicula" || kind === "película" || kind === "documentary" || kind === "documental") return "movie";
  if (kind === "series" || kind === "serie" || kind === "tv") return "series";
  if (kind === "anime") return "anime";
  return null;
}

const isDiscoveryMarker = (it: QueueItem): boolean => Boolean(it) && it.url === DISCOVERY_MARKER_URL;
const stripDiscoveryMarkers = (items: QueueItem[]): QueueItem[] => items.filter((it) => !isDiscoveryMarker(it));

function clampConcurrency(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(24, Math.round(n)));
}

function parseJsonArray<T = any>(val: any): T[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

class BackgroundCrawlerWorker {
  /** Jobs en ejecución AHORA — permite RASPAR VARIOS CATÁLOGOS A LA VEZ
   *  (ejecución paralela hasta max_concurrent_jobs). */
  private activeJobIds = new Set<string>();
  private settings: WorkerSettings = { ...DEFAULT_SETTINGS };
  /** Debounce de persistencia de items_queue: el JSON es grande (cientos de KB)
   *  y 8 savers lo reescribian constantemente -> max 1 escritura cada 4s. */
  private lastQueuePersistAt = 0;
  private async persistQueueThrottled(jobId: string, queue: QueueItem[], force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastQueuePersistAt < 4000) return;
    this.lastQueuePersistAt = now;
    await this.updateJobState(jobId, { items_queue: queue });
  }
  /** Token-bucket por dominio: el ritmo cortés se aplica al SITIO, no a TMDB/DB. */
  private lastSiteHitByHost = new Map<string, number>();
  /** Override temporal de delay por host cuando el sitio muestra señales anti-bot. */
  private antiBotThrottle = new Map<string, { factor: number; until: number }>();

  /** Jobs en ejecución AHORA (para el GET de settings de la UI). */
  public get activeJobCount(): number {
    return this.activeJobIds.size;
  }

  /** Registro anti-bot global (para el GET de settings de la UI). */
  public getAntiBotReport() {
    return getAntiBotReport();
  }

  /** El poller no arranca hasta que la recuperación de huérfanos terminó. */
  private recoveryDone = false;

  constructor() {
    // Al arrancar, re-encolar jobs huérfanos (quedaron "running" si el
    // proceso murió) y resetear items "processing" para que no queden zombis.
    // El poller espera a que termine para no pisar la recuperación.
    this.recoverOrphanJobs()
      .catch(() => {})
      .finally(() => {
        this.recoveryDone = true;
        // No esperar a que el primer tick del intervalo rescate una cola que
        // se creó mientras arrancaba Express. El disparo es idempotente gracias
        // al mutex de processNextInQueue.
        void this.processNextInQueue();
      });
    setInterval(() => {
      if (this.recoveryDone) this.processNextInQueue();
    }, 1000);
  }

  private async recoverOrphanJobs() {
    try {
      const orphans = await prisma.crawlTask.findMany({ where: { status: "running" } });
      for (const job of orphans) {
        // No tocar jobs que ESTE proceso ya reclamó (carrera recovery vs poller).
        if (this.activeJobIds.has(job.id)) continue;
        // Re-verificar estado: pudo cambiar durante el escaneo inicial.
        const still = await prisma.crawlTask.findUnique({ where: { id: job.id }, select: { status: true } });
        if (still?.status !== "running") continue;
        await prisma.crawlTask.update({
          where: { id: job.id },
          data: { status: "pending" },
        });
        try {
          const queue = parseJsonArray<QueueItem>(job.items_queue);
          let reset = 0;
          for (const item of queue) {
            if (item.status === "processing") {
              item.status = "pending";
              reset++;
            }
          }
          if (reset > 0) {
            await prisma.crawlTask.update({
              where: { id: job.id },
              data: { items_queue: JSON.stringify(queue) },
            });
          }
          if (job.id) console.log(`[Worker] Job huérfano re-encolado: ${job.name || job.id} (${reset} items reseteados)`);
        } catch {}
      }
    } catch {}
  }

  public init() {
    this.initSettings();
  }

  private async initSettings() {
    try {
      const stored = await prisma.workerSettingsStore.findUnique({ where: { id: "default" } });
      if (stored) {
        const s: any = stored;
        // El valor del usuario MANDA tal cual (sin migraciones forzadas):
        // lo que esté guardado en la BD es lo que él eligió.
        this.settings = {
          default_delay_ms: stored.default_delay_ms,
          jitter_enabled: stored.jitter_enabled,
          max_concurrent_jobs: clampConcurrency(stored.max_concurrent_jobs, DEFAULT_SETTINGS.max_concurrent_jobs),
          user_agent_rotation: stored.user_agent_rotation,
          page_concurrency: clampConcurrency(s.page_concurrency, DEFAULT_SETTINGS.page_concurrency),
          item_concurrency: clampConcurrency(s.item_concurrency, DEFAULT_SETTINGS.item_concurrency),
        };
      } else {
        await prisma.workerSettingsStore.create({
          data: {
            id: "default",
            default_delay_ms: DEFAULT_SETTINGS.default_delay_ms,
            jitter_enabled: DEFAULT_SETTINGS.jitter_enabled,
            max_concurrent_jobs: DEFAULT_SETTINGS.max_concurrent_jobs,
            user_agent_rotation: DEFAULT_SETTINGS.user_agent_rotation,
          },
        });
      }
    } catch {}
  }

  public setImportCallback(_cb: (show: any) => void) {
    // Deprecated legacy callback - taskWorker now saves directly to DB via saveShowWithDeduplication
  }

  public getSettings(): WorkerSettings {
    return { ...this.settings };
  }

  public async updateSettings(newSettings: Partial<WorkerSettings>) {
    this.settings = {
      ...this.settings,
      ...newSettings,
      page_concurrency: clampConcurrency(newSettings.page_concurrency ?? this.settings.page_concurrency, DEFAULT_SETTINGS.page_concurrency),
      item_concurrency: clampConcurrency(newSettings.item_concurrency ?? this.settings.item_concurrency, DEFAULT_SETTINGS.item_concurrency),
    };
    try {
      // Solo columnas existentes en WorkerSettingsStore para no romper Prisma.
      const dbPayload: Record<string, unknown> = {};
      for (const key of DB_SETTING_KEYS) {
        if ((newSettings as any)[key] !== undefined) dbPayload[key] = (this.settings as any)[key];
      }
      if (Object.keys(dbPayload).length > 0) {
        await prisma.workerSettingsStore.upsert({
          where: { id: "default" },
          update: dbPayload,
          create: { id: "default", ...dbPayload },
        });
      }

      if (newSettings.default_delay_ms !== undefined) {
        await prisma.crawlTask.updateMany({
          where: { status: { in: ["pending", "running"] } },
          data: { rate_limit_delay_ms: newSettings.default_delay_ms },
        });
      }
    } catch (e) {
      console.error("Error guardando settings de worker:", e);
    }
  }

  public async getAllJobs(): Promise<CrawlJob[]> {
    try {
      const tasks = await prisma.crawlTask.findMany({
        orderBy: { created_at: "desc" },
        take: 50,
        select: {
          id: true,
          name: true,
          target_url: true,
          status: true,
          scope: true,
          max_pages: true,
          current_page: true,
          total_discovered: true,
          shows_imported: true,
          episodes_imported: true,
          rate_limit_delay_ms: true,
          current_item_title: true,
          error_message: true,
          created_at: true,
          updated_at: true,
          resolver_hint: true,
          content_kind: true,
          pagination_mode: true,
          pagination_template: true,
          pagination_examples: true,
        },
      });

      return tasks.map((t) => ({
        id: t.id,
        name: t.name,
        target_url: t.target_url,
        status: t.status as CrawlJob["status"],
        scope: t.scope as CrawlJob["scope"],
        max_pages: t.max_pages,
        current_page: t.current_page,
        total_discovered: t.total_discovered,
        shows_imported: t.shows_imported,
        episodes_imported: t.episodes_imported,
        rate_limit_delay_ms: t.rate_limit_delay_ms,
        items_queue: [],
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: [],
        resolver_hint: t.resolver_hint,
        content_kind: t.content_kind,
        pagination_mode: t.pagination_mode || "auto",
        pagination_template: t.pagination_template,
        pagination_examples: parseJsonArray<string>(t.pagination_examples),
      }));
    } catch (e) {
      console.error("Error buscando jobs en DB:", e);
      return [];
    }
  }

  public async getJob(id: string): Promise<CrawlJob | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t = await prisma.crawlTask.findUnique({ where: { id } });
        if (!t) return null;
        const allLogs = parseJsonArray(t.logs);
        const slicedLogs = allLogs.slice(-100);
        const isFinished = t.status === "completed" || t.status === "cancelled" || t.status === "failed";
        const allQueue = isFinished ? [] : parseJsonArray<QueueItem>(t.items_queue);
        const slicedQueue = isFinished ? [] : stripDiscoveryMarkers(allQueue.slice(-100));

        return {
          id: t.id,
          name: t.name,
          target_url: t.target_url,
          status: t.status as CrawlJob["status"],
          scope: t.scope as CrawlJob["scope"],
          max_pages: t.max_pages,
          current_page: t.current_page,
          total_discovered: t.total_discovered,
          shows_imported: t.shows_imported,
          episodes_imported: t.episodes_imported,
          rate_limit_delay_ms: t.rate_limit_delay_ms,
          items_queue: slicedQueue,
          current_item_title: t.current_item_title || undefined,
          error_message: t.error_message,
          created_at: t.created_at.toISOString(),
          updated_at: t.updated_at.toISOString(),
          logs: slicedLogs,
          resolver_hint: t.resolver_hint,
          content_kind: t.content_kind,
          pagination_mode: t.pagination_mode || "auto",
          pagination_template: t.pagination_template,
          pagination_examples: parseJsonArray<string>(t.pagination_examples),
        };
      } catch {
        // Una lectura transitoria (pool ocupado/P1008) no debe interpretarse
        // como una orden de pausa: executeJob conserva el checkpoint y reintenta.
        if (attempt < 2) await this.sleep(150 * (attempt + 1));
      }
    }
    return null;
  }

  /** Lee items_queue CRUDO desde DB (con marcador de descubrimiento). Uso interno/resume. */
  private async getRawQueueItems(id: string): Promise<QueueItem[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const t = await prisma.crawlTask.findUnique({ where: { id }, select: { items_queue: true } });
        return parseJsonArray<QueueItem>(t?.items_queue);
      } catch {
        if (attempt < 2) await this.sleep(150 * (attempt + 1));
      }
    }
    return [];
  }

  public async createJob(options: {
    target_url: string;
    scope?: "single" | "catalog_pages" | "full_catalog";
    max_pages?: number;
    delay_ms?: number;
    name?: string;
    resolver_hint?: string | null;
    content_kind?: string | null;
    pagination_mode?: CrawlPaginationMode;
    pagination_template?: string | null;
    pagination_examples?: string[] | string | null;
  }): Promise<CrawlJob> {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetUrl = options.target_url.trim();
    const scope = options.scope || "catalog_pages";
    // En full_catalog max_pages se ignora en runtime (barrido autónomo); 0 = "todas".
    const maxPages = options.max_pages ?? (scope === "full_catalog" ? 0 : 1);
    const delay = options.delay_ms && options.delay_ms >= 500 ? options.delay_ms : this.settings.default_delay_ms;
    const paginationMode = normalizePaginationMode(options.pagination_mode);
    const paginationExamples = extractPaginationUrls(options.pagination_examples);
    const detected = paginationMode === "examples" || (paginationMode === "auto" && paginationExamples.length > 0)
      ? detectPaginationTemplate(paginationExamples)
      : null;
    const paginationTemplate = (options.pagination_template || detected?.template || null)?.trim() || null;
    const resolverHint = String(options.resolver_hint || "").trim() || null;
    const contentKind = String(options.content_kind || "").trim() || null;

    let domainName = "Sitio Web";
    try {
      if (targetUrl.startsWith("http")) {
        domainName = new URL(targetUrl).hostname.replace(/^www\./, "");
      } else {
        domainName = targetUrl.slice(0, 30);
      }
    } catch {
      domainName = targetUrl.slice(0, 30);
    }

    const jobName = options.name || `Importación de ${domainName} (${scope === "full_catalog" ? "Catálogo Completo" : `${options.max_pages || 1} pág`})`;

    const initialLog = {
      timestamp: new Date().toISOString(),
      level: "info" as const,
      message:
        `${scope === "full_catalog" ? "Tarea de BARRIDO COMPLETO creada" : "Tarea creada"} para ${targetUrl}. ` +
        `Resolver: ${resolverHint || "automático"}; tipo: ${contentKind || "automático"}; ` +
        `paginación: ${paginationTemplate ? `plantilla ${paginationTemplate}` : paginationMode}. ` +
        `En cola de ejecución con delay cortés de ${delay}ms.`,
    };

    const taskRecord = await prisma.crawlTask.create({
      data: {
        id,
        name: jobName,
        target_url: targetUrl,
        status: "pending",
        scope,
        max_pages: maxPages,
        current_page: 0,
        total_discovered: 0,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: delay,
        items_queue: "[]",
        error_message: null,
        logs: JSON.stringify([initialLog]),
        resolver_hint: resolverHint,
        content_kind: contentKind,
        pagination_mode: paginationMode,
        pagination_template: paginationTemplate,
        pagination_examples: JSON.stringify(paginationExamples),
      },
    });

    return {
      id: taskRecord.id,
      name: taskRecord.name,
      target_url: taskRecord.target_url,
      status: "pending",
      scope: taskRecord.scope as CrawlJob["scope"],
      max_pages: taskRecord.max_pages,
      current_page: 0,
      total_discovered: 0,
      shows_imported: 0,
      episodes_imported: 0,
      rate_limit_delay_ms: delay,
      items_queue: [],
      error_message: null,
      created_at: taskRecord.created_at.toISOString(),
      updated_at: taskRecord.updated_at.toISOString(),
      logs: [initialLog],
      resolver_hint: resolverHint,
      content_kind: contentKind,
      pagination_mode: paginationMode,
      pagination_template: paginationTemplate,
      pagination_examples: paginationExamples,
    };
  }

  public async pauseJob(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    if (!job) return false;
    if (job.status === "running" || job.status === "pending") {
      // Escritura DIRECTA con retry para que el worker lo vea inmediato.
      for (let i = 0; i < 3; i++) {
        try {
          await prisma.crawlTask.update({ where: { id }, data: { status: "paused" } });
          break;
        } catch (e: any) {
          if (e?.code !== "P1008" || i === 2) break;
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
      await this.addLog(id, "warn", "Tarea pausada por el usuario.");
      return true;
    }
    return false;
  }

  public async resumeJob(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    if (!job) return false;
    if (job.status === "paused") {
      // Escritura DIRECTA con retry para que el worker lo vea inmediato.
      for (let i = 0; i < 3; i++) {
        try {
          await prisma.crawlTask.update({ where: { id }, data: { status: "pending" } });
          break;
        } catch (e: any) {
          if (e?.code !== "P1008" || i === 2) break;
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
      await this.addLog(id, "info", "Tarea reanudada y puesta en cola.");
      return true;
    }
    return false;
  }

  public async cancelJob(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    if (!job) return false;
    // Escritura DIRECTA con retry para que el worker lo vea inmediato.
    for (let i = 0; i < 3; i++) {
      try {
        await prisma.crawlTask.update({ where: { id }, data: { status: "cancelled" } });
        break;
      } catch (e: any) {
        if (e?.code !== "P1008" || i === 2) break;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
    await this.addLog(id, "warn", "Tarea cancelada.");
    return true;
  }

  public async deleteJob(id: string): Promise<boolean> {
    try {
      const existing = await prisma.crawlTask.findUnique({ where: { id } });
      if (!existing) return false;

      // Si el job está CORRIENDO: señalizar cancelación ANTES de borrar para que
      // discovery/savers corten en su siguiente checkpoint (si no, seguían
      // fetch+import varios segundos más y parecía que "no se borró").
      if (existing.status === "running" || this.activeJobIds.has(id)) {
        await prisma.crawlTask.update({ where: { id }, data: { status: "cancelled" } });
        const deadline = Date.now() + 3000;
        while (this.activeJobIds.has(id) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      await prisma.crawlTask.delete({ where: { id } });
      this.activeJobIds.delete(id);
      return true;
    } catch {
      return false;
    }
  }

  public async clearFinishedJobs() {
    try {
      await prisma.crawlTask.deleteMany({
        where: {
          status: { in: ["completed", "failed", "cancelled"] },
        },
      });
    } catch (e) {
      console.error("Error limpiando tareas terminadas:", e);
    }
  }

  /**
   * Reclama atómicamente un job pendiente (por id) y lo ejecuta INMEDIATAMENTE
   * en este proceso, sin esperar el tick de 1s de la cola. Devuelve false si
   * otro proceso/worker ya lo reclamó o si no estaba pendiente.
   */
  public async runJobNow(id: string): Promise<boolean> {
    const claimed = await prisma.crawlTask.updateMany({
      where: { id, status: "pending" },
      data: { status: "running" },
    });
    if (claimed.count !== 1) return false;
    const job = await this.getJob(id);
    if (!job) return false;
    // Inicio MANUAL: salta la cola aunque haya otros jobs corriendo (inicio
    // fuera de orden pedido por el usuario). Se registra para que deleteJob
    // espere su cierre antes de borrar la fila.
    this.activeJobIds.add(id);
    try {
      await this.executeJob(job);
      return true;
    } catch (e: any) {
      console.error(`[Worker] Fallo ejecutando job ${id}:`, e);
      await this.addLog(job.id, "error", `Fallo ejecutando tarea: ${e?.message || e}`);
      await this.updateJobState(job.id, { status: "failed", error_message: String(e?.message || e) });
      return false;
    } finally {
      this.activeJobIds.delete(id);
    }
  }

  /** Logs en memoria por job: flush al DB cada N segundos o al finalizar. */
  private logBuffers = new Map<string, Array<{ timestamp: string; level: string; message: string }>>();
  private lastLogFlush = 0;
  // Bajo presión de BD un flush puede tardar más que la generación de eventos.
  // Mantener una ventana acotada evita que un barrido grande convierta sus
  // mensajes de progreso en una segunda cola ilimitada dentro del proceso.
  private static readonly MAX_LOG_BUFFER_PER_JOB = 250;

  private async addLog(id: string, level: "info" | "success" | "warn" | "error", message: string) {
    if (!this.logBuffers.has(id)) this.logBuffers.set(id, []);
    const buffer = this.logBuffers.get(id)!;
    buffer.push({ timestamp: new Date().toISOString(), level, message });
    if (buffer.length > BackgroundCrawlerWorker.MAX_LOG_BUFFER_PER_JOB) {
      buffer.splice(0, buffer.length - BackgroundCrawlerWorker.MAX_LOG_BUFFER_PER_JOB);
    }
    // Flush cada 5 segundos como máximo
    const now = Date.now();
    if (now - this.lastLogFlush > 5000) {
      this.lastLogFlush = now;
      await this.flushLogs(id);
    }
  }

  private async flushLogs(id: string) {
    const buf = this.logBuffers.get(id);
    if (!buf || buf.length === 0) return;
    try {
      const task = await prisma.crawlTask.findUnique({ where: { id }, select: { logs: true } });
      if (!task) { this.logBuffers.delete(id); return; }
      const logs = parseJsonArray(task.logs);
      logs.push(...buf);
      while (logs.length > 150) logs.shift();
      this.logBuffers.delete(id);
      enqueueWrite({ kind: "crawlTask.update", id, data: { logs: JSON.stringify(logs) } });
    } catch {}
  }

  private async flushAllLogs() {
    for (const id of this.logBuffers.keys()) {
      await this.flushLogs(id);
    }
  }

  private async updateJobState(id: string, data: Partial<CrawlJob>) {
    try {
      const payload: any = {};
      if (data.status) payload.status = data.status;
      if (typeof data.current_page === "number") payload.current_page = data.current_page;
      if (typeof data.total_discovered === "number") payload.total_discovered = data.total_discovered;
      if (typeof data.shows_imported === "number") payload.shows_imported = data.shows_imported;
      if (typeof data.episodes_imported === "number") payload.episodes_imported = data.episodes_imported;
      if (data.items_queue !== undefined) {
        payload.items_queue = typeof data.items_queue === "string" ? data.items_queue : JSON.stringify(data.items_queue);
      }
      if (data.current_item_title !== undefined) payload.current_item_title = data.current_item_title;
      if (data.error_message !== undefined) payload.error_message = data.error_message;
      if (data.logs !== undefined) {
        payload.logs = typeof data.logs === "string" ? data.logs : JSON.stringify(data.logs);
      }

      // Bufferizar: el drainer aplica en background sin bloquear el worker.
      enqueueWrite({ kind: "crawlTask.update", id, data: payload });
    } catch (e) {
      console.error("Error encolando job state:", e);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Auto-throttle anti-bot: si el host acumula ≥3 señales en 10 min activa/sube
   * un override de delay SOLO para ese dominio (x2 → x4 máx, expira con la
   * ventana). Nunca modifica los settings globales.
   */
  private syncHostThrottle(host: string): void {
    const now = Date.now();
    const current = this.antiBotThrottle.get(host);
    if (current && current.until <= now) {
      this.antiBotThrottle.delete(host);
    }
    const recentHits = countRecentAntiBotHits(host, ANTIBOT_HIT_WINDOW_MS);
    if (recentHits < ANTIBOT_HITS_TO_THROTTLE) return;
    if (this.antiBotThrottle.has(host)) return; // override vigente: ya está aplicado

    const factor = Math.min((current?.factor ?? 1) * 2, ANTIBOT_MAX_THROTTLE_FACTOR);
    this.antiBotThrottle.set(host, { factor, until: now + ANTIBOT_HIT_WINDOW_MS });
    console.warn(
      `[AntiBot] Auto-throttle ${host}: ${recentHits} señales en 10 min → delay x${factor} temporal para ese dominio.`
    );
  }

  /**
   * Registra señales anti-bot observadas por el PROPIO worker (errores que los
   * adapters propagan como texto en discoverCatalogPages/guardado de items).
   * La vía principal de detección vive en BaseAdapter.fetchHtml; esta es la
   * red de seguridad para errores que llegan como string.
   */
  private notePossibleAntiBot(jobId: string, url: string, errMsg?: string | null): void {
    if (!errMsg) return;
    const status = Number((/\b(403|429|503)\b/.exec(errMsg) || [])[1] || 0);
    const looksLikeChallenge =
      /cloudflare|just a moment|challenge-platform|_cf_chl|cf-browser-verification|attention required/i.test(errMsg);
    if (!status && !looksLikeChallenge) return;

    let verdict = detectAntiBot(status, {}, errMsg.slice(0, 800), siteOf(url));
    if (!verdict.blocked && status > 0) {
      // Status de bloqueo sin marcadores CF (geo-bloqueo/WAF simple): genérico.
      verdict = { blocked: true, kind: "generic", evidence: `status ${status} en fallo del adapter` };
    }
    if (!verdict.blocked) return;

    const host = siteOf(url);
    recordAntiBotHit(host, verdict);
    console.warn(`[AntiBot] ${host}: ${verdict.kind} (${verdict.evidence}) [taskWorker]`);
    void this.addLog(
      jobId,
      "warn",
      `[AntiBot] El sitio ${host} muestra señales anti-bot (${verdict.kind}: ${verdict.evidence}). Si se repite, el worker elevará el delay solo para ese dominio.`
    );
  }

  private async applyPoliteRateLimit(job: CrawlJob) {
    // El ritmo cortés protege al SITIO scrapeado. Las llamadas posteriores
    // (TMDB/AniList/PostgreSQL) no necesitan sleep y son el cuello real.
    const host = (() => {
      try {
        return new URL(job.target_url).hostname.replace(/^www\./, "");
      } catch {
        return "unknown";
      }
    })();

    this.syncHostThrottle(host);

    // FIX (bug del slider en 0): `0 || 1500` evaluaba a 1500 y el mínimo nunca
    // funcionaba. Con `??` el 0 explícito es válido (= a fondo); el fallback solo
    // cubre undefined/null.
    const baseDelay = Math.max(0, job.rate_limit_delay_ms ?? 500);
    const throttle = this.antiBotThrottle.get(host);
    let delay = baseDelay * (throttle && throttle.until > Date.now() ? throttle.factor : 1);

    // Jitter PROPORCIONAL (antes eran 200-500ms FIJOS y anulaban un delay 0):
    // delay>0 → 0-40% del propio delay; delay===0 → 0-120ms.
    if (this.settings.jitter_enabled) {
      delay += delay > 0 ? Math.round(Math.random() * delay * 0.4) : Math.floor(Math.random() * 121);
    }

    // Token-bucket global por dominio: aunque N workers/páginas corran en
    // paralelo, el sitio nunca recibe dos fetches con menos de `delay` ms entre sí.
    for (;;) {
      const now = Date.now();
      const last = this.lastSiteHitByHost.get(host) ?? 0;
      const earliest = last + delay;
      if (now >= earliest) {
        this.lastSiteHitByHost.set(host, now);
        return;
      }
      await this.sleep(earliest - now);
    }
  }

  private async processNextInQueue() {
    // Mutex: los ticks del intervalo NO deben solaparse (si la BD tarda >1s,
    // dos ticks simultáneos superaban max_concurrent_jobs).
    if (this.isClaiming) return;
    this.isClaiming = true;
    try {
      // La recuperación canónica hace upserts por episodio y debe conservar
      // prioridad sobre el barrido masivo: ejecutar ambos escritores a la vez
      // satura el pool de Prisma y puede dejar el worker de fuentes esperando
      // minutos. Los catálogos quedan pending y se reanudan al cerrar recovery.
      const activeRecovery = await prisma.crawlTask.count({
        where: {
          scope: "source_recovery",
          status: { in: ["recovery_pending", "recovery_running"] },
        },
      });
      if (activeRecovery > 0) return;
      while (
        this.activeJobIds.size <
        clampConcurrency(this.settings.max_concurrent_jobs, DEFAULT_SETTINGS.max_concurrent_jobs)
      ) {
        const pendingTask = await prisma.crawlTask.findFirst({
          where: { status: "pending" },
          orderBy: { created_at: "asc" },
        });
        if (!pendingTask) return;
        if (this.activeJobIds.has(pendingTask.id)) return;

        // Reclamo ATÓMICO: si hay varios procesos worker mirando la misma BD
        // (servidor :3000 + scripts), solo uno gana y ejecuta.
        const claimed = await prisma.crawlTask.updateMany({
          where: { id: pendingTask.id, status: "pending" },
          data: { status: "running" },
        });
        if (claimed.count !== 1) continue; // otro proceso lo tomó: intenta el siguiente

        this.activeJobIds.add(pendingTask.id);
        void (async () => {
          try {
            const currentJob = await this.getJob(pendingTask.id);
            if (currentJob) {
              try {
                await this.executeJob(currentJob);
              } catch (err: any) {
                console.error(`[Worker] Job ${pendingTask.id} falló con excepción:`, err);
                await this.addLog(pendingTask.id, "error", `La tarea falló con excepción: ${err?.message || err}. Reanudable desde su progreso guardado.`);
                await this.updateJobState(pendingTask.id, { status: "failed", error_message: String(err?.message || err) });
              }
            }
          } catch (err: any) {
            // getJob/updateJobState pueden rechazar si la BD está saturada:
            // sin este catch el rechazo no capturado MATA el proceso.
            console.error(`[Worker] Job ${pendingTask.id} error de infraestructura:`, err?.message || err);
          } finally {
            this.activeJobIds.delete(pendingTask.id);
          }
        })();
      }
    } catch (err: any) {
      console.error("Error en processNextInQueue:", err);
    } finally {
      // El mutex solo protege un tick; mantenerlo levantado después del primer
      // reclamo congelaba todas las tareas pendientes para siempre.
      this.isClaiming = false;
    }
  }

  private async executeJob(job: CrawlJob) {
    await this.addLog(job.id, "info", `Iniciando rastreador en segundo plano para: ${job.target_url}`);

    const rawQueue = await this.getRawQueueItems(job.id);
    const discoveryComplete = rawQueue.some(isDiscoveryMarker);
    const queue = stripDiscoveryMarkers(rawQueue);

    // ── PIPELINE PARALELO (productor-consumidor) ──
    // El descubridor (paginación) y los guardadores (análisis+import) corren
    // SIMULTÁNEAMENTE: en cuanto la página 1 aporta obras, los savers ya las
    // importan mientras el descubridor trae la página 2. Nada espera a que
    // "se descubra TODO" para empezar a guardar.
    let discoveryDone = discoveryComplete;
    let stopped = false;

    let isCatalogFlow = false;
    if (!discoveryComplete) {
      if (queue.length === 0 && job.current_page < 1) {
        await this.addLog(job.id, "info", `Analizando estructura inicial y paginación...`);
        await this.applyPoliteRateLimit(job);

        const checkJob = await this.getJob(job.id);
        if (checkJob?.status !== "running") return;

        let analysis: UniversalAnalysisResult | null = null;
        let analysisError: string | null = null;
        try {
          analysis = await analyzeUniversalUrl(job.target_url, undefined, job.resolver_hint || undefined);
        } catch (err: any) {
          analysisError = String(err?.message || err);
          await this.addLog(job.id, "warn", `No se pudo analizar la página inicial: ${analysisError}.`);
        }

        if (analysis && analysis.page_type === "catalog" && analysis.catalog_items.length > 0) {
          isCatalogFlow = true;
          const seen = new Set(queue.map((q) => canonicalCatalogUrl(q.url)));
          for (const item of dedupeCatalogItems(analysis.catalog_items)) {
            const itemKey = canonicalCatalogUrl(item?.url);
            if (item?.url && itemKey && !seen.has(itemKey)) {
              seen.add(itemKey);
              queue.push({ title: item.title, url: item.url, status: "pending" });
            }
          }
          job.total_discovered = queue.length;
          job.current_page = 1;
          await this.updateJobState(job.id, {
            items_queue: queue,
            total_discovered: job.total_discovered,
            current_page: 1,
          });
          await this.addLog(job.id, "info", `Página 1: ${queue.length} obras. Importación arranca YA en paralelo con el descubrimiento de páginas siguientes.`);
        } else if (job.scope === "single" && analysis && analysis.page_type !== "catalog") {
          await this.addLog(job.id, "info", `Ficha individual detectada: '${analysis.title}'.`);
          queue.push({ title: analysis.title || job.target_url, url: job.target_url, status: "pending" });
          job.total_discovered = 1;
          job.current_page = 1;
          await this.updateJobState(job.id, {
            items_queue: queue,
            total_discovered: 1,
            current_page: 1,
          });
        } else {
          // Nunca guardar /browse, /peliculas u otra URL de catálogo como si
          // fuera una obra cuando el proveedor falló o devolvió cero tarjetas.
          const reason = analysisError || "el adaptador no devolvió elementos de catálogo";
          await this.addLog(job.id, "error", `Importación detenida sin escribir una obra ficticia: ${reason}`);
          await this.updateJobState(job.id, { status: "failed", error_message: reason });
          return;
        }
      } else {
        // REANUDACIÓN: el proceso murió/pausó a mitad del pipeline.
        isCatalogFlow =
          job.scope === "full_catalog" ||
          queue.length > 1 ||
          job.total_discovered > 1;
        await this.addLog(
          job.id,
          "info",
          `Reanudando barrido: progreso previo en página ${job.current_page} con ${queue.length} obras en cola. Continuando desde la página ${job.current_page + 1}...`
        );
      }
    } else {
      await this.addLog(
        job.id,
        "info",
        `Reanudando: descubrimiento ya completado anteriormente (${queue.length} obras en cola). Saltando directo a la indexación...`
      );
    }

    if (!discoveryComplete && !isCatalogFlow) {
      // Ficha individual: no hay paginación que descubrir en paralelo.
      discoveryDone = true;
    }

    // ── CONSUMIDORES (guardado): drenan la cola conforme el descubridor la llena ──
    const configuredConcurrency = clampConcurrency(this.settings.item_concurrency, DEFAULT_SETTINGS.item_concurrency);
    // Pool adaptativo por tarea: empieza con la configuración elegida, sube
    // poco a poco hasta 8 cuando el proveedor responde bien y retrocede ante
    // errores de red/anti-bot. El límite evita disparar la RAM del servidor.
    const adaptivePool = {
      limit: configuredConcurrency,
      max: Math.min(8, Math.max(configuredConcurrency, 4)),
      successes: 0,
      cooldownUntil: 0,
      waitForSlot: async (workerId: number) => {
        while (!stopped && workerId >= adaptivePool.limit) await this.sleep(250);
      },
      waitForCooldown: async () => {
        const remaining = adaptivePool.cooldownUntil - Date.now();
        if (remaining > 0) await this.sleep(Math.min(remaining, 5000));
      },
      success: () => {
        adaptivePool.successes++;
        if (adaptivePool.successes < 25 || adaptivePool.limit >= adaptivePool.max) return;
        adaptivePool.successes = 0;
        adaptivePool.limit++;
        void this.addLog(job.id, "info", `[Adaptive] ${siteOf(job.target_url)} estable: concurrencia ${adaptivePool.limit}/${adaptivePool.max}.`);
      },
      failure: (message: string) => {
        if (!/(403|429|5\d\d|timeout|timed out|abort|fetch_failed|econn|cloudflare|challenge|bloqueo|deneg)/i.test(message)) return;
        const next = Math.max(1, Math.ceil(adaptivePool.limit / 2));
        adaptivePool.limit = next;
        adaptivePool.successes = 0;
        adaptivePool.cooldownUntil = Date.now() + 5000;
        void this.addLog(job.id, "warn", `[Adaptive] ${siteOf(job.target_url)} redujo concurrencia a ${adaptivePool.limit}/${adaptivePool.max} por respuesta problemática.`);
      },
    };
    let cursor = 0;
    const claimNext = (): { index: number; item: QueueItem; position: number } | null => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const it = queue[idx];
        if (it.status !== "done") {
          return { index: idx, item: it, position: idx + 1 };
        }
      }
      return null;
    };

    const worker = async (workerId: number): Promise<void> => {
      for (;;) {
        if (stopped) return;
        const liveJob = await this.getJob(job.id);
        if (liveJob?.status !== "running") {
          stopped = true;
          return;
        }

        await adaptivePool.waitForSlot(workerId);
        await adaptivePool.waitForCooldown();

        const claimed = claimNext();
        if (!claimed) {
          // Cola momentáneamente vacía: si el descubridor sigue trabajando,
          // esperar a que empuje más obras (PIPELINE); si ya terminó, salir.
          if (discoveryDone) return;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        const { item, position } = claimed;

        item.status = "processing";
        if (workerId === 0) {
          await this.updateJobState(job.id, { current_item_title: item.title });
        }
        await this.addLog(
          job.id,
          "info",
          `[${position}/${queue.length}] Extrayendo '${item.title}'...`
        );

        // Cortesía SOLO para el fetch al sitio objetivo.
        await this.applyPoliteRateLimit(job);

        if (stopped) return;

        try {
          // ── ÍNDICE DE RE-ESCANEO ──
          // Si la obra YA existe (clave canónica del título del listado), NO se
          // re-analiza ni re-guarda con TMDB/enrichment: verificación LIGERA que
          // solo detecta e inserta EPISODIOS NUEVOS (los streams de los nuevos
          // se resuelven Just-In-Time al reproducir). Re-escanear un catálogo
          // conocido pasa de ~10-30s/obra a ~2-4s/obra.
          const titleKey = normalizeTitleKey(item.title || "");
          if (titleKey.length >= 2) {
            const knownCandidates = await prisma.show.findMany({
              where: { OR: [{ base_normalized_title: titleKey }, { normalized_title: titleKey }] },
              select: { id: true, title: true, year: true, category: true },
              orderBy: { created_at: "asc" },
              take: 20,
            });
            const kindHint = normalizeContentKind(job.content_kind) || kindHintFromCatalogUrl(job.target_url);
            const sameKindCandidates = kindHint
              ? knownCandidates.filter((show) => show.category === kindHint)
              : [];
            // Si hay varios homónimos y el catálogo no declara tipo, no
            // adivinamos: se analiza la ficha y el flujo enriquecido
            // resolverá la identidad por TMDB/título/año.
            const candidates = sameKindCandidates.length > 0
              ? sameKindCandidates
              : knownCandidates.length === 1
                ? knownCandidates
                : [];
            const itemYear = isPlausibleYear(item.year) ? item.year! : null;
            const knownShow = itemYear
              ? candidates.find((show) => show.year === itemYear) ??
                candidates.find((show) => !isPlausibleYear(show.year)) ??
                null
              : candidates[0] ?? null;
            if (knownShow) {
              const sourceSite = siteOf(item.url || job.target_url);
              // La reconciliación legacy ya puede haber creado el SourceLink
              // exacto para este proveedor. En una pasada completa no hay
              // valor en descargar otra vez miles de fichas conocidas: si la
              // fuente ya está enlazada al MediaItem, la obra ya está
              // integrada y se puede continuar con la siguiente.
              // Cinecalidad mezcla películas y series en el mismo índice, por
              // eso no aplicamos un filtro de tipo en ese proveedor; para los
              // catálogos separados sí evitamos colisiones entre categorías.
              const sourceKindHint = /cinecalidad/i.test(job.target_url) ? null : kindHint;
              const existingProviderLink = job.scope === "full_catalog"
                ? await prisma.mediaItem.findFirst({
                    where: {
                      ...(sourceKindHint ? { kind: sourceKindHint } : {}),
                      OR: [
                        { base_normalized_title: titleKey },
                        { normalized_title: titleKey },
                      ],
                      episodes: { some: { links: { some: { source_site: sourceSite } } } },
                    },
                    select: { id: true },
                  })
                : null;
              if (existingProviderLink) {
                item.status = "done";
                job.shows_imported++;
                await this.addLog(
                  job.id,
                  "info",
                  `[${position}/${queue.length}] Ya vinculada '${knownShow.title}' con ${sourceSite}; se omite descarga repetida.`
                );
                if (position % 5 === 0 || position === queue.length) {
                  await this.persistQueueThrottled(job.id, queue, position === queue.length);
                }
                await this.updateJobState(job.id, { shows_imported: job.shows_imported });
                adaptivePool.success();
                continue;
              }
              const itemKind = (item.kind || normalizeContentKind(job.content_kind) || kindHintFromCatalogUrl(job.target_url) || knownShow.category || "anime") as "movie" | "series" | "anime";
              // Las películas ya traen su ficha recuperable en el listado: no
              // hace falta descargar 23k fichas individuales. Series/anime sí
              // necesitan detalle para descubrir sus episodios.
              const itemAnalysis = itemKind === "movie"
                ? null
                : await analyzeUniversalUrl(item.url || item.title, "detail", job.resolver_hint || undefined);
              const eps = itemAnalysis
                ? normalizeExtractedEpisodes(itemAnalysis.episodes, sourceSite)
                : [];
              if (itemKind !== "movie" && eps.length === 0) {
                throw new Error(`No se encontró ningún localizador de episodio para '${item.title || knownShow.title}'`);
              }
              const { added } = await quickSyncKnownShow(knownShow.id, {
                // Esta pasada solo conserva la existencia y los locators de
                // episodios. Las identidades se resuelven después en lote.
                title: item.title || knownShow.title,
                // Algunos adaptadores quitan el sufijo de temporada del
                // título normalizado; conservarlo desde título+slug evita
                // mezclar fuentes de S2/S3 dentro de T1.
                season: parseTitleQuery(`${item.title} ${item.url || ""}`).season,
                episodes: eps,
                source_site: sourceSite,
                fallback_url: itemKind === "movie" && eps.length === 0 ? item.url : undefined,
              });
              item.status = "done";
              job.shows_imported++;
              job.episodes_imported += added;
              await this.addLog(
                job.id,
                "info",
                `[${position}/${queue.length}] Conocida '${knownShow.title}': re-escaneo ligero, +${added} episodio(s) nuevo(s).`
              );
              if (position % 5 === 0 || position === queue.length) {
                await this.persistQueueThrottled(job.id, queue, position === queue.length);
              }
              await this.updateJobState(job.id, {
                shows_imported: job.shows_imported,
                episodes_imported: job.episodes_imported,
              });
              adaptivePool.success();
              continue;
            }
          }

          // En la pasada masiva de los cuatro proveedores principales primero
          // importamos la ficha nativa y sus episodios. El enriquecimiento
          // remoto se hace después, en lote, con los reparadores de identidad;
          // hacerlo aquí multiplicaba las llamadas TMDB/MAL/AniList por cada
          // tarjeta y convertía un rastreo de catálogo en una cola de horas.
          const lightweightPrimaryCatalogImport =
            job.scope === "full_catalog" &&
            /cinecalidad|gnulahd|latanime|tioanime/i.test(job.target_url);
          const sourceSite = siteOf(item.url || job.target_url);
          const catalogKindHint = item.kind || normalizeContentKind(job.content_kind) || kindHintFromCatalogUrl(job.target_url);
          const skipMovieDetail = lightweightPrimaryCatalogImport && catalogKindHint === "movie";
          const itemAnalysis = skipMovieDetail
            ? ({ episodes: [] } as UniversalAnalysisResult)
            : await analyzeUniversalUrl(
                item.url || item.title,
                lightweightPrimaryCatalogImport ? "detail" : undefined,
                job.resolver_hint || undefined,
              );
          const parsedItemTitle = parseTitleQuery(item.title || itemAnalysis.title);
          const minimalTitle = item.title || itemAnalysis.title || parsedItemTitle.baseTitle || "Contenido indexado";
          const minimalKind = (item.kind || itemAnalysis.content_type || normalizeContentKind(job.content_kind) || kindHintFromCatalogUrl(job.target_url) || "anime") as "movie" | "series" | "anime";
          const extractedEpisodes = lightweightPrimaryCatalogImport
            ? normalizeExtractedEpisodes(itemAnalysis.episodes, sourceSite)
            : itemAnalysis.episodes;
          const episodes = extractedEpisodes.length > 0
            ? extractedEpisodes
            : lightweightPrimaryCatalogImport && minimalKind === "movie"
              ? [{ number: 1, title: minimalTitle, url: item.url }]
              : [];

          if (lightweightPrimaryCatalogImport && minimalKind !== "movie" && episodes.length === 0) {
            throw new Error(`No se encontró ningún localizador de episodio para '${minimalTitle}'`);
          }

          // En el barrido primario se persisten únicamente título/tipo y
          // locators. La ficha se descarga solo para descubrir URLs de
          // episodios; su descripción, portada, géneros e IDs se ignoran.
          const result = await saveShowWithDeduplication({
            title: lightweightPrimaryCatalogImport ? minimalTitle : itemAnalysis.title || parsedItemTitle.baseTitle || item.title,
            season: lightweightPrimaryCatalogImport ? parseTitleQuery(`${item.title} ${item.url || ""}`).season : parsedItemTitle.season,
            japanese_title: lightweightPrimaryCatalogImport ? undefined : itemAnalysis.japanese_title,
            english_title: lightweightPrimaryCatalogImport ? undefined : itemAnalysis.english_title,
            description: lightweightPrimaryCatalogImport ? "" : itemAnalysis.description,
            poster_url: lightweightPrimaryCatalogImport ? null : itemAnalysis.poster_url,
            banner_url: lightweightPrimaryCatalogImport ? null : itemAnalysis.banner_url,
            content_type: lightweightPrimaryCatalogImport ? minimalKind : itemAnalysis.content_type,
            rating: lightweightPrimaryCatalogImport ? 0 : itemAnalysis.rating,
            year: lightweightPrimaryCatalogImport
              ? (isPlausibleYear(item.year) ? item.year! : 0)
              : itemAnalysis.year ?? parsedItemTitle.year ?? undefined,
            status: lightweightPrimaryCatalogImport ? "Indexada" : itemAnalysis.status,
            genres: lightweightPrimaryCatalogImport ? [] : itemAnalysis.genres,
            source_site: sourceSite,
            episodes,
            detected_streams: lightweightPrimaryCatalogImport ? undefined : itemAnalysis.detected_streams,
            original_title: lightweightPrimaryCatalogImport ? undefined : (itemAnalysis as any).original_title,
            mal_id: lightweightPrimaryCatalogImport ? undefined : (itemAnalysis as any).mal_id,
            anilist_id: lightweightPrimaryCatalogImport ? undefined : (itemAnalysis as any).anilist_id,
            kitsu_id: lightweightPrimaryCatalogImport ? undefined : (itemAnalysis as any).kitsu_id,
            tmdb_id: lightweightPrimaryCatalogImport ? undefined : (itemAnalysis as any).tmdb_id,
            _skipEnrichment: lightweightPrimaryCatalogImport,
            ...(() => {
              const extra = itemAnalysis as any;
              return !lightweightPrimaryCatalogImport && (extra.poster_path || extra.backdrop_path)
                ? { poster_path: extra.poster_path, backdrop_path: extra.backdrop_path }
                : {};
            })(),
          } as any);

          item.status = "done";
          job.shows_imported++;
          job.episodes_imported += result.episodesAdded;

          // Persistir contadores cada item pero SIN re-serializar la cola entera;
          // la cola se guarda con debounce (máx 1 escritura cada 4s) o al finalizar.
          if (position % 5 === 0 || position === queue.length) {
            await this.persistQueueThrottled(job.id, queue, position === queue.length);
          }
          await this.updateJobState(job.id, {
            shows_imported: job.shows_imported,
            episodes_imported: job.episodes_imported,
          });
          adaptivePool.success();

          if (result.isDuplicate) {
            await this.addLog(
              job.id,
              "info",
              `ℹ Duplicado detectado para '${result.show.title}'. Se fusionaron ${result.episodesAdded} episodio(s) nuevos.`
            );
          } else {
            await this.addLog(
              job.id,
              "success",
              `✓ Guardada nueva obra: '${result.show.title}' (${result.episodesAdded} ep/fuentes).`
            );
          }
        } catch (err: any) {
          // Un item fallido NUNCA aborta el barrido: se marca y se sigue.
          item.status = "error";
          item.error = err?.message || String(err);
          this.notePossibleAntiBot(job.id, item.url || job.target_url, item.error);
          adaptivePool.failure(item.error);
          await this.updateJobState(job.id, { items_queue: queue });
          await this.addLog(job.id, "warn", `Error en '${item.title}': ${item.error}. Continuando con el siguiente...`);
        }
        // No añadir una espera fija aquí: `applyPoliteRateLimit` ya espacia
        // cada petición al dominio y el write buffer drena de forma asíncrona.
        // Los 2 s heredados por elemento hacían que un catálogo de 10k obras
        // tardara muchas horas sin aportar estabilidad.
      }
    };

    // ── PRODUCTOR (descubrimiento): corre EN PARALELO con los savers ──
    const saversRunning = Promise.all(
      Array.from({ length: adaptivePool.max }, (_, w) => worker(w))
    );

    if (!discoveryDone) {
      const startPage = Math.max(2, job.current_page + 1);
      const endPageExclusive =
        job.scope === "full_catalog"
          ? FULL_CATALOG_HARD_PAGE_CAP + 1
          : Math.max(2, job.max_pages + 1);

      const reason = await this.discoverCatalogPages(job, queue, startPage, endPageExclusive);
      if (reason === "stopped") stopped = true;

      discoveryDone = true;
      if (!stopped && queue.length > 0) {
        // Marca "descubrimiento completo": un crash ya NO repagina al reanudar.
        queue.push({ title: "", url: DISCOVERY_MARKER_URL, status: "done" });
        await this.updateJobState(job.id, { items_queue: queue });
      }
    }

    // Drenar: esperar a que los savers terminen con lo pendiente.
    await saversRunning;

    if (stopped) {
      await this.updateJobState(job.id, { items_queue: queue });
      await this.addLog(job.id, "warn", "Procesamiento pausado o detenido. El progreso quedó guardado y es reanudable.");
      // CRÍTICO: "paused", NO "pending" — el poller (setInterval 1s) reclama
      // tareas "pending" y re-arrancaría el job solo (bug de la pausa fantasma).
      await this.updateJobState(job.id, { status: "paused" });
      return;
    }

    if (queue.length === 0) {
      await this.addLog(job.id, "warn", "No se descubrió ninguna obra (catálogo vacío o sitio inaccesible). Tarea finalizada.");
      await this.flushAllLogs();
      await this.updateJobState(job.id, { items_queue: [], status: "completed", error_message: null });
      return;
    }

    await this.flushAllLogs();
    await this.updateJobState(job.id, {
      items_queue: queue,
      status: "completed",
      current_item_title: undefined,
    });

    await this.addLog(
      job.id,
      "success",
      `¡Barrido completado! Páginas recorridas: ${job.current_page}. Total: ${job.shows_imported} obras procesadas y ${job.episodes_imported} episodios/streams guardados en base de datos.`
    );
  }

  /**
   * Paginación AUTO-DESCUBIERTA: pide páginas en lotes de page_concurrency
   * (el token-bucket por host espacia las peticiones con cortesía aunque se
   * pidan en paralelo) y AVANZA HASTA AGOTAR EL CATÁLOGO:
   *  - página vacía → fin natural;
   *  - páginas consecutivas sin obras nuevas → fin (el sitio repite la última);
   *  - un umbral de fallos consecutivos por proveedor → fin defensivo
   *    (HiAnimes full_catalog tolera huecos de páginas con errores upstream);
   *  - nunca supera endPageExclusive (fusible anti-bucle en full_catalog).
   * Un fallo de UNA página jamás aborta el barrido. Persiste current_page tras
   * cada página exitosa para poder REANUDAR sin saltar ni repetir páginas.
   */
  private async discoverCatalogPages(
    job: CrawlJob,
    queue: QueueItem[],
    startPage: number,
    endPageExclusive: number
  ): Promise<"stopped" | "completed"> {
    const pageConcurrency = clampConcurrency(this.settings.page_concurrency, DEFAULT_SETTINGS.page_concurrency);
    const maxConsecutivePageErrors =
      job.scope === "full_catalog" && /hianimes\.se/i.test(job.target_url)
        ? MAX_HIANIMES_CONSECUTIVE_PAGE_ERRORS
        : MAX_CONSECUTIVE_PAGE_ERRORS;
    const seen = new Set(queue.map((q) => canonicalCatalogUrl(q.url)));
    let consecutiveErrors = 0;
    let consecutiveNoNew = 0;
    let previousPageFingerprint: string | undefined;
    let page = startPage;

    await this.addLog(
      job.id,
      "info",
      job.scope === "full_catalog"
        ? `BARRIDO COMPLETO activado: se recorrerán TODAS las páginas hasta agotar el catálogo (autónomo, sin supervisión). Concurrencia de páginas=${pageConcurrency}.`
        : `Paginando hasta la página ${endPageExclusive - 1} con concurrencia=${pageConcurrency}.`
    );

    while (page < endPageExclusive) {
      const liveJob = await this.getJob(job.id);
      if (liveJob?.status !== "running") return "stopped";

      const batchPages: number[] = [];
      for (let p = page; p < Math.min(endPageExclusive, page + pageConcurrency); p++) batchPages.push(p);

      const batchUrls = batchPages.map((p) => ({ page: p, url: this.buildPageUrl(job, p) }));
      const results = await extractCatalogListingsBatch(
        batchUrls.map((b) => b.url),
        {
          concurrency: pageConcurrency,
          beforeRequest: () => this.applyPoliteRateLimit(job),
        }
      );

      for (let i = 0; i < results.length; i++) {
        const pageNo = batchUrls[i].page;
        const r = results[i];

        if (r.error) {
          consecutiveErrors++;
          this.notePossibleAntiBot(job.id, batchUrls[i].page_url || batchUrls[i].url, r.error);
          await this.addLog(job.id, "warn", `Aviso en página ${pageNo}: ${r.error}. El barrido continúa con las siguientes.`);
          if (consecutiveErrors >= maxConsecutivePageErrors) {
            await this.addLog(
              job.id,
              "error",
              `${maxConsecutivePageErrors} páginas consecutivas fallaron: se detiene el descubrimiento por seguridad y se indexa lo ya descubierto (${queue.length} obras).`
            );
            return "completed";
          }
          continue;
        }

        consecutiveErrors = 0;

        if (r.items.length === 0) {
          await this.addLog(job.id, "info", `Página ${pageNo} vacía: FIN del catálogo alcanzado de forma autónoma.`);
          return "completed";
        }

        const repeatedPage = isRepeatedCatalogPage(r.items, previousPageFingerprint);
        const currentPageFingerprint = catalogPageFingerprint(r.items);
        let newAdded = 0;
        for (const item of r.items) {
          const itemKey = canonicalCatalogUrl(item?.url);
          if (item?.url && itemKey && !seen.has(itemKey)) {
            seen.add(itemKey);
            queue.push({ title: item.title, url: item.url, status: "pending" });
            newAdded++;
          }
        }

        // El fingerprint se actualiza incluso en una página solapada para que
        // una repetición consecutiva se distinga de una página simplemente
        // sin nuevos enlaces.
        previousPageFingerprint = currentPageFingerprint || previousPageFingerprint;

        if (newAdded === 0) {
          consecutiveNoNew++;
          await this.addLog(
            job.id,
            "warn",
            repeatedPage
              ? `Página ${pageNo} repite exactamente la anterior (${consecutiveNoNew}/${NO_NEW_ITEM_PAGES_BEFORE_STOP}): se detendrá solo tras confirmar la repetición.`
              : `Página ${pageNo} sin obras nuevas (${consecutiveNoNew}/${NO_NEW_ITEM_PAGES_BEFORE_STOP}): posible fin del catálogo o solapamiento.`
          );
          if (consecutiveNoNew >= NO_NEW_ITEM_PAGES_BEFORE_STOP) {
            await this.addLog(job.id, "info", `El sitio dejó de aportar contenido nuevo: FIN del catálogo alcanzado.`);
            return "completed";
          }
          continue;
        }

        consecutiveNoNew = 0;
        job.current_page = pageNo;
        job.total_discovered = queue.length;
        await this.updateJobState(job.id, {
          items_queue: queue,
          current_page: pageNo,
          total_discovered: job.total_discovered,
        });
        console.log(`[Worker] '${job.name}': página ${pageNo} barrida (+${newAdded} obras, total ${queue.length}).`);
        await this.addLog(job.id, "info", `Página ${pageNo}: +${newAdded} obras agregadas a la cola (total ${queue.length}).`);
      }

      page += batchPages.length;
    }

    await this.addLog(job.id, "info", `Se alcanzó el límite de seguridad de ${endPageExclusive - 1} páginas sin agotar el catálogo.`);
    return "completed";
  }

  /**
   * Construye la URL de la página N de un catálogo.
   *
   * 1) Reutiliza el patrón que YA trae la URL base (?page=, ?p=, ?pag=, /page/N/).
   * 2) Tabla de patrones verificados por sitio (2026-08-24):
   *      animeflv.net        → /browse?page=N
   *      animeflv.or.at / animeflv.or.am (+mirrors) → /anime/page/N/
   *      tioplus.app         → /peliculas/N
   *      latanime.org        → /animes?p=N
   *      tioanime.com        → /directorio?p=N
   *      veranimes.net       → /animes?pag=N
   *      cinecalidad.am      → /page/N/
   * 3) Genérico: ?page=N (si el sitio usa otro esquema, el detector de
   *    "páginas consecutivas sin obras nuevas" corta el barrido solo).
   */
  private buildPageUrl(job: CrawlJob, pageNumber: number): string {
    const template = String(job.pagination_template || "").trim();
    if (template.includes("{page}")) {
      return template.replace(/\{page\}/gi, String(pageNumber));
    }
    return buildCatalogPageUrl(job.target_url, pageNumber);
  }
}

/** Inferencia ligera del tipo del catálogo, usada solo para evitar colisiones
 * de títulos homónimos en el fast-path. La ficha detallada sigue siendo la
 * autoridad y puede corregir el tipo durante el guardado enriquecido. */
function kindHintFromCatalogUrl(url: string | undefined): "movie" | "series" | "anime" | null {
  const value = String(url || "").toLowerCase();
  if (/animeflv|tioanime|latanime|hianimes|\/animes?\b/.test(value)) return "anime";
  if (/\/series?\b|tvshows?|doramas/.test(value)) return "series";
  if (/\/pel[ií]culas?\b|\/movies?\b|cinecalidad/.test(value)) return "movie";
  return null;
}

export const taskWorker = new BackgroundCrawlerWorker();

/**
 * Atajo para el coordinador/UI: encola un BARRIDO COMPLETO autónomo.
 * El endpoint existente POST /api/v1/catalog/crawl ya acepta scope:"full_catalog"
 * directamente, así que server.ts NO necesita cambios obligatorios.
 */
export async function enqueueFullCatalogSweep(
  targetUrl: string,
  opts?: { delay_ms?: number; name?: string; resolver_hint?: string; content_kind?: string; pagination_template?: string; pagination_examples?: string[] }
): Promise<CrawlJob> {
  return taskWorker.createJob({
    target_url: targetUrl,
    scope: "full_catalog",
    delay_ms: opts?.delay_ms,
    name: opts?.name,
    resolver_hint: opts?.resolver_hint,
    content_kind: opts?.content_kind,
    pagination_template: opts?.pagination_template,
    pagination_examples: opts?.pagination_examples,
  });
}
