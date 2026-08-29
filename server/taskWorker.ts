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

function siteOf(url: string | undefined): string {
  try {
    const host = new URL(url || "").hostname.replace(/^www\./, "") || "unknown";
    // Return first label only: "lamovie.org" → "lamovie"
    return host.split(".")[0] || host;
  } catch {
    return "unknown";
  }
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

const DEFAULT_SETTINGS: WorkerSettings = {
  default_delay_ms: 0,
  jitter_enabled: false,
  max_concurrent_jobs: 5,
  user_agent_rotation: true,
  page_concurrency: 16,
  item_concurrency: 24,
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
        items_queue: stripDiscoveryMarkers(parseJsonArray<QueueItem>(t.items_queue)),
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: parseJsonArray(t.logs),
      }));
    } catch (e) {
      console.error("Error buscando jobs en DB:", e);
      return [];
    }
  }

  public async getJob(id: string): Promise<CrawlJob | null> {
    try {
      const t = await prisma.crawlTask.findUnique({ where: { id } });
      if (!t) return null;
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
        items_queue: stripDiscoveryMarkers(parseJsonArray<QueueItem>(t.items_queue)),
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: parseJsonArray(t.logs),
      };
    } catch {
      return null;
    }
  }

  /** Lee items_queue CRUDO desde DB (con marcador de descubrimiento). Uso interno/resume. */
  private async getRawQueueItems(id: string): Promise<QueueItem[]> {
    try {
      const t = await prisma.crawlTask.findUnique({ where: { id }, select: { items_queue: true } });
      return parseJsonArray<QueueItem>(t?.items_queue);
    } catch {
      return [];
    }
  }

  public async createJob(options: {
    target_url: string;
    scope?: "single" | "catalog_pages" | "full_catalog";
    max_pages?: number;
    delay_ms?: number;
    name?: string;
  }): Promise<CrawlJob> {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const targetUrl = options.target_url.trim();
    const scope = options.scope || "catalog_pages";
    // En full_catalog max_pages se ignora en runtime (barrido autónomo); 0 = "todas".
    const maxPages = options.max_pages ?? (scope === "full_catalog" ? 0 : 1);
    const delay = options.delay_ms && options.delay_ms >= 500 ? options.delay_ms : this.settings.default_delay_ms;

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
        scope === "full_catalog"
          ? `Tarea de BARRIDO COMPLETO creada para ${targetUrl}. Se recorrerá todo el catálogo automáticamente (delay cortés de ${delay}ms).`
          : `Tarea creada para ${targetUrl}. En cola de ejecución del worker con delay cortés de ${delay}ms.`,
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

  private async addLog(id: string, level: "info" | "success" | "warn" | "error", message: string) {
    if (!this.logBuffers.has(id)) this.logBuffers.set(id, []);
    this.logBuffers.get(id)!.push({ timestamp: new Date().toISOString(), level, message });
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
        try {
          analysis = await analyzeUniversalUrl(job.target_url);
        } catch (err: any) {
          await this.addLog(job.id, "warn", `No se pudo analizar la página inicial: ${String(err?.message || err)}. Se reintentará vía descubrimiento de páginas.`);
          analysis = {
            page_type: "catalog",
            content_type: "movie",
            title: "",
            description: "",
            poster_url: null,
            banner_url: null,
            rating: 0,
            year: 0,
            status: "Publicado",
            genres: [],
            episodes: [],
            catalog_items: [],
          } as UniversalAnalysisResult;
        }

        if (analysis.page_type === "catalog" && analysis.catalog_items.length > 0) {
          isCatalogFlow = true;
          const seen = new Set(queue.map((q) => q.url));
          for (const item of analysis.catalog_items) {
            if (item?.url && !seen.has(item.url)) {
              seen.add(item.url);
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
        } else {
          await this.addLog(job.id, "info", `Ficha individual detectada: '${analysis.title}'.`);
          queue.push({ title: analysis.title || job.target_url, url: job.target_url, status: "pending" });
          job.total_discovered = 1;
          job.current_page = 1;
          await this.updateJobState(job.id, {
            items_queue: queue,
            total_discovered: 1,
            current_page: 1,
          });
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
    const concurrency = clampConcurrency(this.settings.item_concurrency, DEFAULT_SETTINGS.item_concurrency);
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
              select: { id: true, title: true, year: true },
              orderBy: { created_at: "asc" },
              take: 20,
            });
            const itemYear = isPlausibleYear(item.year) ? item.year! : null;
            const knownShow = itemYear
              ? knownCandidates.find((show) => show.year === itemYear) ??
                knownCandidates.find((show) => !isPlausibleYear(show.year)) ??
                null
              : knownCandidates[0] ?? null;
            if (knownShow) {
              // Modo "detail": SOLO lista de episodios — sin extracción de streams
              // (los nuevos se resuelven Just-In-Time al reproducir). Full fast.
              const itemAnalysis = await analyzeUniversalUrl(item.url || item.title, "detail");
              const eps = (itemAnalysis.episodes || []).map((e: any) => ({
                number: Number(e.number),
                title: String(e.title || `Episodio ${e.number}`),
                url: String(e.url || ""),
              }));
              const { added } = await quickSyncKnownShow(knownShow.id, {
                title: itemAnalysis.title || item.title,
                episodes: eps,
                source_site: siteOf(item.url || job.target_url),
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
              continue;
            }
          }

          const itemAnalysis = await analyzeUniversalUrl(item.url || item.title);

          const parsedItemTitle = parseTitleQuery(itemAnalysis.title || item.title);
          const sourceSite = siteOf(item.url || job.target_url);

          // El adapter ya consultó APIs externas dentro de analyzeUniversalUrl.
          // Se propaga la metadata como pre-enriquecida para que saveShowWithDeduplication
          // no repita la cascada TMDB/AniList/TVMaze (ahorro ~40-70% por show).
          const result = await saveShowWithDeduplication({
            title: itemAnalysis.title || parsedItemTitle.baseTitle || item.title,
            season: parsedItemTitle.season,
            japanese_title: itemAnalysis.japanese_title,
            english_title: itemAnalysis.english_title,
            description: itemAnalysis.description,
            poster_url: itemAnalysis.poster_url,
            banner_url: itemAnalysis.banner_url,
            content_type: itemAnalysis.content_type,
            rating: itemAnalysis.rating,
            year: itemAnalysis.year ?? parsedItemTitle.year ?? undefined,
            status: itemAnalysis.status,
            genres: itemAnalysis.genres,
            source_site: sourceSite,
            episodes: itemAnalysis.episodes,
            detected_streams: itemAnalysis.detected_streams,
            original_title: (itemAnalysis as any).original_title,
            tmdb_id: (itemAnalysis as any).tmdb_id,
            ...(() => {
              const extra = itemAnalysis as any;
              return extra.poster_path || extra.backdrop_path
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
          await this.updateJobState(job.id, { items_queue: queue });
          await this.addLog(job.id, "warn", `Error en '${item.title}': ${item.error}. Continuando con el siguiente...`);
        }
        // Pausa entre items: dar tiempo al write buffer para aplicar.
        await this.sleep(2000);
      }
    };

    // ── PRODUCTOR (descubrimiento): corre EN PARALELO con los savers ──
    const saversRunning = Promise.all(
      Array.from({ length: concurrency }, (_, w) => worker(w))
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
   *  - MAX_CONSECUTIVE_PAGE_ERRORS fallos seguidos → fin defensivo;
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
    const seen = new Set(queue.map((q) => q.url));
    let consecutiveErrors = 0;
    let consecutiveNoNew = 0;
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

      const batchUrls = batchPages.map((p) => ({ page: p, url: this.buildPageUrl(job.target_url, p) }));
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
          if (consecutiveErrors >= MAX_CONSECUTIVE_PAGE_ERRORS) {
            await this.addLog(
              job.id,
              "error",
              `${MAX_CONSECUTIVE_PAGE_ERRORS} páginas consecutivas fallaron: se detiene el descubrimiento por seguridad y se indexa lo ya descubierto (${queue.length} obras).`
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

        let newAdded = 0;
        for (const item of r.items) {
          if (item?.url && !seen.has(item.url)) {
            seen.add(item.url);
            queue.push({ title: item.title, url: item.url, status: "pending" });
            newAdded++;
          }
        }

        if (newAdded === 0) {
          consecutiveNoNew++;
          await this.addLog(
            job.id,
            "warn",
            `Página ${pageNo} sin obras nuevas (${consecutiveNoNew}/${NO_NEW_ITEM_PAGES_BEFORE_STOP}): posible fin del catálogo o repetición del sitio.`
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
   *      animeflv.or.at (+mirrors) → /anime/page/N/
   *      tioplus.app         → /peliculas/N
   *      latanime.org        → /animes?p=N
   *      tioanime.com        → /directorio?p=N
   *      veranimes.net       → /animes?pag=N
   *      cinecalidad.am      → /page/N/
   * 3) Genérico: ?page=N (si el sitio usa otro esquema, el detector de
   *    "páginas consecutivas sin obras nuevas" corta el barrido solo).
   */
  private buildPageUrl(baseUrl: string, pageNumber: number): string {
    try {
      const url = new URL(baseUrl);
      if (url.searchParams.has("page")) {
        url.searchParams.set("page", String(pageNumber));
        return url.toString();
      }
      if (url.searchParams.has("p")) {
        url.searchParams.set("p", String(pageNumber));
        return url.toString();
      }
      if (url.searchParams.has("pag")) {
        url.searchParams.set("pag", String(pageNumber));
        return url.toString();
      }
      if (/\/page\/\d+\/?$/.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/page\/\d+/, `/page/${pageNumber}`);
        return url.toString();
      }

      const host = url.hostname.toLowerCase();
      const path = url.pathname.replace(/\/+$/, "");
      const origin = url.origin;

      // Mirrors de AnimeFLV (or.at y similares): path-segment /page/N/
      if (/(^|\.)animeflv\.(or\.at|la|cc|pe|iu|se)$/.test(host)) {
        return `${origin}${path}/page/${pageNumber}/`;
      }
      // TioPlus: segmento numérico directo
      if (/(^|\.)tioplus\.app$/.test(host)) {
        return `${origin}${path}/${pageNumber}`;
      }
      // LatAnime: query ?p=
      if (/(^|\.)latanime\.org$/.test(host)) {
        return `${origin}${path || "/animes"}?p=${pageNumber}`;
      }
      // TioAnime: query ?p=
      if (/(^|\.)tioanime\.com$/.test(host)) {
        return `${origin}${path || "/directorio"}?p=${pageNumber}`;
      }
      // VerAnimes: query ?pag=
      if (/(^|\.)veranimes\.(net|com)$/.test(host)) {
        return `${origin}${path || "/animes"}?pag=${pageNumber}`;
      }
      // Cinecalidad: path /page/N/
      if (/(^|\.)cinecalidad\.[a-z.]+$/.test(host)) {
        return `${origin}${path}/page/${pageNumber}/`;
      }
      // AnimeFLV principal: /browse?page=N
      if (/(^|\.)animeflv\.net$/.test(host)) {
        return `${origin}${path || "/browse"}?page=${pageNumber}`;
      }

      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    } catch {
      if (baseUrl.includes("?")) {
        return `${baseUrl}&page=${pageNumber}`;
      }
      return `${baseUrl}?page=${pageNumber}`;
    }
  }
}

export const taskWorker = new BackgroundCrawlerWorker();

/**
 * Atajo para el coordinador/UI: encola un BARRIDO COMPLETO autónomo.
 * El endpoint existente POST /api/v1/catalog/crawl ya acepta scope:"full_catalog"
 * directamente, así que server.ts NO necesita cambios obligatorios.
 */
export async function enqueueFullCatalogSweep(
  targetUrl: string,
  opts?: { delay_ms?: number; name?: string }
): Promise<CrawlJob> {
  return taskWorker.createJob({
    target_url: targetUrl,
    scope: "full_catalog",
    delay_ms: opts?.delay_ms,
    name: opts?.name,
  });
}
