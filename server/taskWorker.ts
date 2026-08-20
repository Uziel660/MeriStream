// server/taskWorker.ts
// Background Worker with Rate Limiting, Anti-Blocking Jitter, Queue & Persistent Execution

import { analyzeUniversalUrl, extractCatalogListing } from "./universalScraper";

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
  rate_limit_delay_ms: number; // Configurable polite delay per request
  items_queue: Array<{ title: string; url: string; status: "pending" | "processing" | "done" | "error"; error?: string }>;
  current_item_title?: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  logs: Array<{ timestamp: string; level: "info" | "success" | "warn" | "error"; message: string }>;
}

export interface WorkerSettings {
  default_delay_ms: number; // e.g. 1500ms
  jitter_enabled: boolean; // add 300-800ms random delay
  max_concurrent_jobs: number; // usually 1 or 2 for rate safety
  user_agent_rotation: boolean;
}

const DEFAULT_SETTINGS: WorkerSettings = {
  default_delay_ms: 1500,
  jitter_enabled: true,
  max_concurrent_jobs: 1,
  user_agent_rotation: true,
};

class BackgroundCrawlerWorker {
  private jobs = new Map<string, CrawlJob>();
  private activeJobId: string | null = null;
  private isProcessing = false;
  private settings: WorkerSettings = { ...DEFAULT_SETTINGS };
  private onShowImportedCallback?: (show: any) => void;

  constructor() {
    // Start background tick loop
    setInterval(() => this.processNextInQueue(), 1000);
  }

  public setImportCallback(cb: (show: any) => void) {
    this.onShowImportedCallback = cb;
  }

  public getSettings(): WorkerSettings {
    return { ...this.settings };
  }

  public updateSettings(newSettings: Partial<WorkerSettings>) {
    this.settings = { ...this.settings, ...newSettings };
  }

  public getAllJobs(): CrawlJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  public getJob(id: string): CrawlJob | undefined {
    return this.jobs.get(id);
  }

  public createJob(options: {
    target_url: string;
    scope?: "single" | "catalog_pages" | "full_catalog";
    max_pages?: number;
    delay_ms?: number;
    name?: string;
  }): CrawlJob {
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

    const job: CrawlJob = {
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
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      logs: [
        {
          timestamp: new Date().toISOString(),
          level: "info",
          message: `Tarea creada para ${targetUrl}. En cola de ejecución del worker con delay cortés de ${delay}ms.`,
        },
      ],
    };

    this.jobs.set(id, job);
    this.addLog(job, "info", `Protección de IP activa: Rate limit ${delay}ms + jitter anti-baneo.`);
    return job;
  }

  public pauseJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "running" || job.status === "pending") {
      job.status = "paused";
      this.addLog(job, "warn", "Tarea pausada por el usuario.");
      if (this.activeJobId === id) {
        this.activeJobId = null;
      }
      return true;
    }
    return false;
  }

  public resumeJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "paused") {
      job.status = "pending";
      this.addLog(job, "info", "Tarea reanudada y puesta en cola.");
      return true;
    }
    return false;
  }

  public cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.status = "cancelled";
    this.addLog(job, "warn", "Tarea cancelada.");
    if (this.activeJobId === id) {
      this.activeJobId = null;
    }
    return true;
  }

  public deleteJob(id: string): boolean {
    if (this.activeJobId === id) {
      this.activeJobId = null;
    }
    return this.jobs.delete(id);
  }

  public clearFinishedJobs() {
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        this.jobs.delete(id);
      }
    }
  }

  private addLog(job: CrawlJob, level: "info" | "success" | "warn" | "error", message: string) {
    job.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
    // Keep max 150 logs per job
    if (job.logs.length > 150) {
      job.logs.shift();
    }
    job.updated_at = new Date().toISOString();
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async applyPoliteRateLimit(job: CrawlJob) {
    let delay = job.rate_limit_delay_ms || this.settings.default_delay_ms;
    if (this.settings.jitter_enabled) {
      // Add random jitter (200-700ms) to prevent robotic pattern detection
      const jitter = Math.floor(Math.random() * 500) + 200;
      delay += jitter;
    }
    await this.sleep(delay);
  }

  private async processNextInQueue() {
    if (this.isProcessing) return;

    // Find first pending job
    const pendingJob = Array.from(this.jobs.values()).find((j) => j.status === "pending");
    if (!pendingJob) return;

    this.isProcessing = true;
    this.activeJobId = pendingJob.id;
    pendingJob.status = "running";

    try {
      await this.executeJob(pendingJob);
    } catch (err: any) {
      pendingJob.status = "failed";
      pendingJob.error_message = err.message || "Error fatal en worker";
      this.addLog(pendingJob, "error", `Fallo en tarea: ${err.message}`);
    } finally {
      this.isProcessing = false;
      this.activeJobId = null;
    }
  }

  private async executeJob(job: CrawlJob) {
    this.addLog(job, "info", `Iniciando rastreador en segundo plano para: ${job.target_url}`);

    // Step 1: Discovered items check
    if (job.items_queue.length === 0) {
      this.addLog(job, "info", `Analizando estructura inicial y paginación...`);
      await this.applyPoliteRateLimit(job);

      if (job.status !== "running") return;

      // Extract listing or single detail
      const analysis = await analyzeUniversalUrl(job.target_url);

      if (analysis.page_type === "catalog" && analysis.catalog_items.length > 0) {
        this.addLog(
          job,
          "info",
          `Página 1: Encontradas ${analysis.catalog_items.length} obras en el catálogo inicial.`
        );

        // Add discovered items
        analysis.catalog_items.forEach((item) => {
          job.items_queue.push({
            title: item.title,
            url: item.url,
            status: "pending",
          });
        });
        job.total_discovered = job.items_queue.length;
        job.current_page = 1;

        // If multi-page requested (e.g. 2 to N pages)
        const pagesToFetch = job.scope === "full_catalog" ? Math.min(job.max_pages, 20) : job.max_pages;
        if (pagesToFetch > 1) {
          for (let page = 2; page <= pagesToFetch; page++) {
            if (job.status !== "running") break;

            this.addLog(job, "info", `Paginando: Solicitando página ${page}/${pagesToFetch} con delay cortés...`);
            await this.applyPoliteRateLimit(job);

            try {
              // Guess pagination URL
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
                this.addLog(job, "info", `Página ${page}: +${newAdded} obras agregadas a la cola.`);
              } else {
                this.addLog(job, "warn", `No se detectaron más elementos en la página ${page}. Finalizando descubrimiento.`);
                break;
              }
            } catch (err: any) {
              this.addLog(job, "warn", `Aviso en página ${page}: ${err.message}. Continuando con las obras ya descubiertas.`);
            }
          }
        }
      } else {
        // Single item
        this.addLog(job, "info", `Ficha individual detectada: '${analysis.title}'.`);
        job.items_queue.push({
          title: analysis.title,
          url: job.target_url,
          status: "pending",
        });
        job.total_discovered = 1;
        job.current_page = 1;
      }
    }

    // Step 2: Ingest items from queue one by one with rate limiting & anti-ban protection
    this.addLog(
      job,
      "info",
      `Iniciando descarga e indexación por lotes de ${job.items_queue.length} obras con protección anti-bloqueo...`
    );

    for (let i = 0; i < job.items_queue.length; i++) {
      if (job.status !== "running") {
        this.addLog(job, "warn", `Procesamiento pausado o detenido en el elemento ${i + 1}/${job.items_queue.length}.`);
        return;
      }

      const item = job.items_queue[i];
      if (item.status === "done") continue; // already finished if resumed

      item.status = "processing";
      job.current_item_title = item.title;
      job.updated_at = new Date().toISOString();

      this.addLog(
        job,
        "info",
        `[${i + 1}/${job.items_queue.length}] Extrayendo metadata & streams para '${item.title}'...`
      );

      // Polite delay between individual show extractions
      await this.applyPoliteRateLimit(job);

      if (job.status !== "running") return;

      try {
        const itemAnalysis = await analyzeUniversalUrl(item.url || item.title);
        const showId = `show-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        const episodes = (itemAnalysis.episodes || []).map((ep, idx) => ({
          id: `ep-${showId}-${idx + 1}`,
          show_id: showId,
          title: ep.title || `Episodio ${idx + 1}`,
          episode_number: ep.number || idx + 1,
          source_url: ep.url || item.url,
        }));

        if (episodes.length === 0) {
          episodes.push({
            id: `ep-${showId}-1`,
            show_id: showId,
            title: itemAnalysis.content_type === "movie" ? "Película Completa" : "Episodio 1: Estreno",
            episode_number: 1,
            source_url:
              (itemAnalysis.detected_streams && itemAnalysis.detected_streams[0]) ||
              item.url,
          });
        }

        const showObject = {
          id: showId,
          mal_id: (itemAnalysis as any).mal_id || undefined,
          title: itemAnalysis.title || item.title,
          japanese_title: itemAnalysis.japanese_title || undefined,
          english_title: itemAnalysis.english_title || undefined,
          description: itemAnalysis.description || "Obra multimedia importada automáticamente por worker.",
          poster_url: itemAnalysis.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800",
          banner_url: itemAnalysis.banner_url || itemAnalysis.poster_url || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600",
          category: itemAnalysis.content_type || "anime",
          rating: itemAnalysis.rating || 8.0,
          year: itemAnalysis.year || 2024,
          status: itemAnalysis.status || "Finalizado",
          genres: Array.isArray(itemAnalysis.genres) ? itemAnalysis.genres.join(", ") : (itemAnalysis.genres || "Multimedia"),
          episodes,
        };

        if (this.onShowImportedCallback) {
          this.onShowImportedCallback(showObject);
        }

        item.status = "done";
        job.shows_imported++;
        job.episodes_imported += episodes.length;

        this.addLog(
          job,
          "success",
          `✓ Guardado: '${showObject.title}' (${episodes.length} ep/fuentes).`
        );
      } catch (err: any) {
        item.status = "error";
        item.error = err.message;
        this.addLog(job, "warn", `Error en '${item.title}': ${err.message}. Continuando con el siguiente...`);
      }

      job.updated_at = new Date().toISOString();
    }

    job.current_item_title = undefined;
    job.status = "completed";
    this.addLog(
      job,
      "success",
      `¡Tarea completada con éxito! Total: ${job.shows_imported} obras guardadas y ${job.episodes_imported} episodios/streams indexados.`
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
      // Otherwise append ?page=N
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
