// server/taskWorker.ts
// Background Worker with Rate Limiting, Anti-Blocking Jitter, Queue & Persistent PostgreSQL Execution

import { analyzeUniversalUrl, extractCatalogListing } from "./universalScraper";
import { saveShowWithDeduplication } from "./showService";
import { prisma } from "./db";

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
}

const DEFAULT_SETTINGS: WorkerSettings = {
  default_delay_ms: 1500,
  jitter_enabled: true,
  max_concurrent_jobs: 1,
  user_agent_rotation: true,
};

class BackgroundCrawlerWorker {
  private activeJobId: string | null = null;
  private isProcessing = false;
  private settings: WorkerSettings = { ...DEFAULT_SETTINGS };

  constructor() {
    this.initSettings();
    setInterval(() => this.processNextInQueue(), 1000);
  }

  private async initSettings() {
    try {
      const stored = await prisma.workerSettingsStore.findUnique({ where: { id: "default" } });
      if (stored) {
        this.settings = {
          default_delay_ms: stored.default_delay_ms,
          jitter_enabled: stored.jitter_enabled,
          max_concurrent_jobs: stored.max_concurrent_jobs,
          user_agent_rotation: stored.user_agent_rotation,
        };
      } else {
        await prisma.workerSettingsStore.create({
          data: {
            id: "default",
            ...DEFAULT_SETTINGS,
          },
        });
      }
    } catch {}
  }

  public setImportCallback(_cb: (show: any) => void) {
    // Deprecated legacy callback - taskWorker now saves directly to PostgreSQL via saveShowWithDeduplication
  }

  public getSettings(): WorkerSettings {
    return { ...this.settings };
  }

  public async updateSettings(newSettings: Partial<WorkerSettings>) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      await prisma.workerSettingsStore.upsert({
        where: { id: "default" },
        update: { ...newSettings },
        create: { id: "default", ...DEFAULT_SETTINGS, ...newSettings },
      });
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
        items_queue: (t.items_queue as any) || [],
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: (t.logs as any) || [],
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
        items_queue: (t.items_queue as any) || [],
        current_item_title: t.current_item_title || undefined,
        error_message: t.error_message,
        created_at: t.created_at.toISOString(),
        updated_at: t.updated_at.toISOString(),
        logs: (t.logs as any) || [],
      };
    } catch {
      return null;
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
    const scope = options.scope || (options.max_pages && options.max_pages > 1 ? "catalog_pages" : "catalog_pages");
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
      message: `Tarea creada para ${targetUrl}. En cola de ejecución del worker con delay cortés de ${delay}ms.`,
    };

    const taskRecord = await prisma.crawlTask.create({
      data: {
        id,
        name: jobName,
        target_url: targetUrl,
        status: "pending",
        scope,
        max_pages: options.max_pages || 1,
        current_page: 0,
        total_discovered: 0,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: delay,
        items_queue: [],
        error_message: null,
        logs: [initialLog],
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
      await this.updateJobState(id, { status: "paused" });
      await this.addLog(id, "warn", "Tarea pausada por el usuario.");
      if (this.activeJobId === id) this.activeJobId = null;
      return true;
    }
    return false;
  }

  public async resumeJob(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    if (!job) return false;
    if (job.status === "paused") {
      await this.updateJobState(id, { status: "pending" });
      await this.addLog(id, "info", "Tarea reanudada y puesta en cola.");
      return true;
    }
    return false;
  }

  public async cancelJob(id: string): Promise<boolean> {
    const job = await this.getJob(id);
    if (!job) return false;
    await this.updateJobState(id, { status: "cancelled" });
    await this.addLog(id, "warn", "Tarea cancelada.");
    if (this.activeJobId === id) this.activeJobId = null;
    return true;
  }

  public async deleteJob(id: string): Promise<boolean> {
    if (this.activeJobId === id) this.activeJobId = null;
    try {
      await prisma.crawlTask.delete({ where: { id } });
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

  private async addLog(id: string, level: "info" | "success" | "warn" | "error", message: string) {
    try {
      const task = await prisma.crawlTask.findUnique({ where: { id } });
      if (!task) return;
      const logs = (task.logs as any[]) || [];
      logs.push({
        timestamp: new Date().toISOString(),
        level,
        message,
      });
      if (logs.length > 150) logs.shift();

      await prisma.crawlTask.update({
        where: { id },
        data: { logs },
      });
    } catch {}
  }

  private async updateJobState(id: string, data: Partial<CrawlJob>) {
    try {
      const payload: any = {};
      if (data.status) payload.status = data.status;
      if (typeof data.current_page === "number") payload.current_page = data.current_page;
      if (typeof data.total_discovered === "number") payload.total_discovered = data.total_discovered;
      if (typeof data.shows_imported === "number") payload.shows_imported = data.shows_imported;
      if (typeof data.episodes_imported === "number") payload.episodes_imported = data.episodes_imported;
      if (data.items_queue) payload.items_queue = data.items_queue;
      if (data.current_item_title !== undefined) payload.current_item_title = data.current_item_title;
      if (data.error_message !== undefined) payload.error_message = data.error_message;

      await prisma.crawlTask.update({
        where: { id },
        data: payload,
      });
    } catch (e) {
      console.error("Error actualizando job state:", e);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async applyPoliteRateLimit(job: CrawlJob) {
    let delay = job.rate_limit_delay_ms || this.settings.default_delay_ms;
    if (this.settings.jitter_enabled) {
      const jitter = Math.floor(Math.random() * 500) + 200;
      delay += jitter;
    }
    await this.sleep(delay);
  }

  private async processNextInQueue() {
    if (this.isProcessing) return;

    try {
      const pendingTask = await prisma.crawlTask.findFirst({
        where: { status: "pending" },
        orderBy: { created_at: "asc" },
      });

      if (!pendingTask) return;

      this.isProcessing = true;
      this.activeJobId = pendingTask.id;
      await this.updateJobState(pendingTask.id, { status: "running" });

      const currentJob = await this.getJob(pendingTask.id);
      if (currentJob) {
        await this.executeJob(currentJob);
      }
    } catch (err: any) {
      console.error("Error en processNextInQueue:", err);
    } finally {
      this.isProcessing = false;
      this.activeJobId = null;
    }
  }

  private async executeJob(job: CrawlJob) {
    await this.addLog(job.id, "info", `Iniciando rastreador en segundo plano para: ${job.target_url}`);

    // Step 1: Discovered items check
    if (job.items_queue.length === 0) {
      await this.addLog(job.id, "info", `Analizando estructura inicial y paginación...`);
      await this.applyPoliteRateLimit(job);

      const checkJob = await this.getJob(job.id);
      if (!checkJob || checkJob.status !== "running") return;

      const analysis = await analyzeUniversalUrl(job.target_url);

      if (analysis.page_type === "catalog" && analysis.catalog_items.length > 0) {
        await this.addLog(
          job.id,
          "info",
          `Página 1: Encontradas ${analysis.catalog_items.length} obras en el catálogo inicial.`
        );

        analysis.catalog_items.forEach((item) => {
          job.items_queue.push({
            title: item.title,
            url: item.url,
            status: "pending",
          });
        });
        job.total_discovered = job.items_queue.length;
        job.current_page = 1;
        await this.updateJobState(job.id, {
          items_queue: job.items_queue,
          total_discovered: job.total_discovered,
          current_page: job.current_page,
        });

        const pagesToFetch = job.scope === "full_catalog" ? Math.min(job.max_pages, 20) : job.max_pages;
        if (pagesToFetch > 1) {
          for (let page = 2; page <= pagesToFetch; page++) {
            const liveJob = await this.getJob(job.id);
            if (!liveJob || liveJob.status !== "running") break;

            await this.addLog(job.id, "info", `Paginando: Solicitando página ${page}/${pagesToFetch} con delay cortés...`);
            await this.applyPoliteRateLimit(job);

            try {
              const pageUrl = this.buildPageUrl(job.target_url, page);
              const pageItems = await extractCatalogListing(pageUrl);

              if (pageItems.length > 0) {
                let newAdded = 0;
                pageItems.forEach((item) => {
                  if (!job.items_queue.some((q) => q.url === item.url)) {
                    job.items_queue.push({
                      title: item.title,
                      url: item.url,
                      status: "pending",
                    });
                    newAdded++;
                  }
                });
                job.current_page = page;
                job.total_discovered = job.items_queue.length;
                await this.updateJobState(job.id, {
                  items_queue: job.items_queue,
                  current_page: page,
                  total_discovered: job.total_discovered,
                });
                await this.addLog(job.id, "info", `Página ${page}: +${newAdded} obras agregadas a la cola.`);
              } else {
                await this.addLog(job.id, "warn", `No se detectaron más elementos en la página ${page}. Finalizando descubrimiento.`);
                break;
              }
            } catch (err: any) {
              await this.addLog(job.id, "warn", `Aviso en página ${page}: ${err.message}. Continuando con las obras ya descubiertas.`);
            }
          }
        }
      } else {
        await this.addLog(job.id, "info", `Ficha individual detectada: '${analysis.title}'.`);
        job.items_queue.push({
          title: analysis.title,
          url: job.target_url,
          status: "pending",
        });
        job.total_discovered = 1;
        job.current_page = 1;
        await this.updateJobState(job.id, {
          items_queue: job.items_queue,
          total_discovered: 1,
          current_page: 1,
        });
      }
    }

    await this.addLog(
      job.id,
      "info",
      `Iniciando descarga e indexación por lotes de ${job.items_queue.length} obras con deduplicación y verificación AniList...`
    );

    for (let i = 0; i < job.items_queue.length; i++) {
      const liveJob = await this.getJob(job.id);
      if (!liveJob || liveJob.status !== "running") {
        await this.addLog(job.id, "warn", `Procesamiento pausado o detenido en el elemento ${i + 1}/${job.items_queue.length}.`);
        return;
      }

      const item = job.items_queue[i];
      if (item.status === "done") continue;

      item.status = "processing";
      await this.updateJobState(job.id, {
        items_queue: job.items_queue,
        current_item_title: item.title,
      });

      await this.addLog(
        job.id,
        "info",
        `[${i + 1}/${job.items_queue.length}] Extrayendo metadata & deduplicando '${item.title}'...`
      );

      await this.applyPoliteRateLimit(job);

      const checkActive = await this.getJob(job.id);
      if (!checkActive || checkActive.status !== "running") return;

      try {
        const itemAnalysis = await analyzeUniversalUrl(item.url || item.title);

        // Deduplicated save via saveShowWithDeduplication
        const result = await saveShowWithDeduplication({
          title: itemAnalysis.title || item.title,
          japanese_title: itemAnalysis.japanese_title,
          english_title: itemAnalysis.english_title,
          description: itemAnalysis.description,
          poster_url: itemAnalysis.poster_url,
          banner_url: itemAnalysis.banner_url,
          content_type: itemAnalysis.content_type,
          rating: itemAnalysis.rating,
          year: itemAnalysis.year,
          status: itemAnalysis.status,
          genres: itemAnalysis.genres,
          episodes: itemAnalysis.episodes,
          detected_streams: itemAnalysis.detected_streams,
        });

        item.status = "done";
        job.shows_imported++;
        job.episodes_imported += result.episodesAdded;

        await this.updateJobState(job.id, {
          items_queue: job.items_queue,
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
        item.status = "error";
        item.error = err.message;
        await this.updateJobState(job.id, { items_queue: job.items_queue });
        await this.addLog(job.id, "warn", `Error en '${item.title}': ${err.message}. Continuando con el siguiente...`);
      }
    }

    await this.updateJobState(job.id, {
      status: "completed",
      current_item_title: undefined,
    });

    await this.addLog(
      job.id,
      "success",
      `¡Tarea completada con éxito! Total: ${job.shows_imported} obras procesadas y ${job.episodes_imported} episodios/streams guardados en PostgreSQL.`
    );
  }

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
      if (url.pathname.includes("/page/")) {
        url.pathname = url.pathname.replace(/\/page\/\d+/, `/page/${pageNumber}`);
        return url.toString();
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
