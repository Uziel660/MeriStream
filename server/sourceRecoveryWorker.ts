import { prisma, normalizeBaseTitle } from "./db";
import { analyzeUniversalUrl } from "./universalScraper";
import { classifySourceKind, hasSignedQuery, parseStreamExpiry } from "./resolutionMetadata";
import { isPlayerEligible, mergeSourceEvidenceStatus, SOURCE_EVIDENCE_STATUS } from "./sourceEvidence";

/**
 * Recuperación persistente de fuentes canónicas.
 *
 * Este worker no intenta conservar streams firmados: reconstruye la ficha o
 * el embed que permite resolverlos JIT. Usa CrawlTask como cola persistente,
 * pero con estados propios para que el crawler normal no la reclame.
 */

export type RecoveryItemStatus = "pending" | "processing" | "done" | "already_canonical" | "skipped" | "error";

export interface RecoveryQueueItem {
  media_episode_id: string;
  media_item_id: string;
  title: string;
  kind: string;
  year: number | null;
  season_number: number;
  episode_number: number;
  provider_sites: string[];
  candidate_urls: string[];
  status: RecoveryItemStatus;
  canonical_url?: string;
  error?: string;
}

export interface SourceRecoveryJob {
  id: string;
  name: string;
  status: "recovery_pending" | "recovery_running" | "recovery_paused" | "completed" | "failed";
  target_url: string;
  scope: "source_recovery";
  total_discovered: number;
  current_page: number;
  episodes_imported: number;
  rate_limit_delay_ms: number;
  items_queue: RecoveryQueueItem[];
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRecoveryStartOptions {
  providers?: string[];
  limit?: number;
  delay_ms?: number;
  name?: string;
  /** expired = historical signed links; all = every non-excluded source link. */
  mode?: "expired" | "all";
}

export interface SourceRecoverySummary {
  job_id: string;
  candidates: number;
  already_canonical: number;
  recovered: number;
  skipped: number;
  errors: number;
}

const RECOVERY_SCOPE = "source_recovery";
// Todos los proveedores configurados participan en la recuperación. TubePelis
// estuvo excluido mientras su extractor no podía reconstruir las fichas; el
// adaptador actual ya devuelve localizadores canónicos y streams reproducibles.
const EXCLUDED_SITES = new Set<string>();
const SEARCH_ADAPTERS: Record<string, string> = {
  animeflv: "animeflv",
  "animeflv.net": "animeflv",
  jkanime: "animeflv",
  tioanime: "tioanime",
  "tioanime.com": "tioanime",
  tioplus: "tioplus",
  "tioplus.app": "tioplus",
  cinecalidad: "cinecalidad",
  "cinecalidad.am": "cinecalidad",
  "cinecalidad.mx": "cinecalidad",
  "cinecalidad.im": "cinecalidad",
  tubepelis: "tubepelis",
  "tubepelis.com": "tubepelis",
  tudorama: "tudorama",
  "tudorama.com": "tudorama",
};
const DEFAULT_DELAY_MS = 800;
const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
// Un elemento excepcionalmente lento no debe congelar toda la cola. El timeout
// es por episodio (no por candidato); los candidatos que queden pendientes se
// reintentan en la siguiente pasada gracias a la clave idempotente.
const RECOVERY_ITEM_TIMEOUT_MS = 60_000;
// La recuperación es principalmente I/O (localizadores canónicos + upserts
// idempotentes). Doce tareas solapadas aprovechan la máquina de 10C/16T sin
// agotar el pool de Prisma ni lanzar una ráfaga descontrolada a proveedores.
const RECOVERY_CONCURRENCY = 12;
// La cola puede contener decenas de miles de episodios. Serializar todo el
// JSON cada cinco elementos convierte el checkpoint en el cuello de botella y
// aumenta la presión de memoria/IO. Veinticinco conserva una pérdida máxima
// pequeña ante un cierre (los elementos se vuelven a intentar de forma
// idempotente) y reduce unas cinco veces las escrituras grandes.
const PERSIST_EVERY = 100;

function cleanSite(site: string): string {
  const value = (site || "").trim().toLowerCase();
  if (value.startsWith("www.")) return value.slice(4);
  return value;
}

/** Devuelve si un proveedor debe omitirse de una pasada de recuperación. */
export function isExcludedRecoverySite(siteOrUrl: string): boolean {
  const value = (siteOrUrl || "").trim();
  const site = value.includes("://") ? siteFromUrl(value) : cleanSite(value);
  return EXCLUDED_SITES.has(site);
}

export function siteFromUrl(rawUrl: string): string {
  try {
    return cleanSite(new URL(rawUrl).hostname);
  } catch {
    return "unknown";
  }
}

function isSignedQuery(rawUrl: string): boolean {
  return /[?&](?:s|e|exp|expires|expiry|token|jwt|h|hdnts|sig|signature|auth)=/i.test(rawUrl);
}

export function isExpiredDirectUrl(rawUrl: string, now = Date.now()): boolean {
  if (!rawUrl) return false;
  const parsed = parseStreamExpiry(rawUrl);
  if (parsed.expiresAt !== undefined) return parsed.expiresAt <= now;
  // Many CDN manifests use opaque signatures (`?t=...`, `?hash=...`,
  // `?policy=...`) without an explicit timestamp. They are still ephemeral;
  // treating them as recoverable here is what catches the historical 403s.
  return hasSignedQuery(rawUrl) || isSignedQuery(rawUrl);
}

export function isCatalogNavigationUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    if (/\/page\/\d+$/.test(path)) return true;
    for (const key of ["page", "p", "pag", "paged"]) {
      const value = url.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return true;
    }
    if (["/", "/peliculas", "/series", "/animes", "/browse", "/directorio", "/genero", "/year"].includes(path) || path.startsWith("/genero/")) return true;
    return false;
  } catch {
    return true;
  }
}

export function isCanonicalLocator(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  if (isCatalogNavigationUrl(rawUrl)) return false;
  const kind = classifySourceKind(rawUrl);
  return kind === "page" || kind === "embed";
}

function uniqueUrls(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isCanonicalLocator(value)) continue;
    const clean = value.trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function uniqueRecoveryUrls(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const clean = typeof value === "string" ? value.trim() : "";
    if (!clean || (!isCanonicalLocator(clean) && classifySourceKind(clean) !== "stable_direct")) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      result.push(clean);
    }
  }
  return result;
}

function canonicalSourceLink(link: { url: string; link_type: string }): boolean {
  return (link.link_type === "page" || link.link_type === "embed") && isCanonicalLocator(link.url);
}

function clampDelay(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DELAY_MS;
  return Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(n)));
}

function clampLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  // Una pasada completa puede abarcar decenas de miles de episodios. La cola
  // solo guarda metadatos compactos (no HTML ni manifests), por lo que 50k es
  // un límite seguro y evita repetir los primeros 10k en trabajos sucesivos.
  return Number.isFinite(n) && n > 0 ? Math.min(50_000, Math.round(n)) : undefined;
}

function parseQueue(raw: unknown): Array<{ title?: string; url?: string; status?: string }> {
  if (Array.isArray(raw)) return raw as Array<{ title?: string; url?: string; status?: string }>;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function titleKey(title: string): string {
  return normalizeBaseTitle(title || "");
}

function candidateMatchesTitle(candidateTitle: string, targetTitle: string): boolean {
  const left = titleKey(candidateTitle);
  const right = titleKey(targetTitle);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mapLegacyCandidates(
  shows: Array<{ title: string; normalized_title: string; base_normalized_title: string | null; year: number; episodes: Array<{ episode_number: number; source_url: string }> }>,
  target: { title: string; year: number | null; episode_number: number },
): string[] {
  const targetKey = titleKey(target.title);
  const urls: string[] = [];
  for (const show of shows) {
    const showMatches = titleKey(show.title) === targetKey ||
      titleKey(show.normalized_title) === targetKey ||
      titleKey(show.base_normalized_title || "") === targetKey;
    if (!showMatches) continue;
    if (target.year !== null && show.year && Math.abs(show.year - target.year) > 1) continue;
    for (const episode of show.episodes) {
      if (Number(episode.episode_number) === Number(target.episode_number)) urls.push(episode.source_url);
    }
  }
  return uniqueUrls(urls);
}

function extractEpisodeUrl(analysis: { episodes?: Array<{ number: number; url: string }>; page_type?: string }, targetEpisode: number): string | undefined {
  const found = (analysis.episodes || []).find((episode) => Number(episode.number) === Number(targetEpisode) && isCanonicalLocator(episode.url));
  return found?.url;
}

function jobFromRecord(record: any): SourceRecoveryJob {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    target_url: record.target_url,
    scope: RECOVERY_SCOPE,
    total_discovered: Number(record.total_discovered || 0),
    current_page: Number(record.current_page || 0),
    episodes_imported: Number(record.episodes_imported || 0),
    rate_limit_delay_ms: Number(record.rate_limit_delay_ms || DEFAULT_DELAY_MS),
    items_queue: parseQueue(record.items_queue) as RecoveryQueueItem[],
    error_message: record.error_message || null,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
  };
}

export class SourceRecoveryWorker {
  private activeJobId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval>;
  private startupReconciled = false;

  constructor() {
    this.pollTimer = setInterval(() => {
      void this.processNext().catch((error) => console.error("[SourceRecovery] poller:", error));
    }, 2000);
    // The singleton is imported by the API process, but this timer must not
    // keep short-lived CLI/tests alive after their work has completed.
    const timer = this.pollTimer as ReturnType<typeof setInterval> & { unref?: () => void };
    timer.unref?.();
  }

  public async getJobs(limit = 20): Promise<SourceRecoveryJob[]> {
    const rows = await prisma.crawlTask.findMany({
      where: { scope: RECOVERY_SCOPE },
      orderBy: { updated_at: "desc" },
      take: Math.min(100, Math.max(1, limit)),
    });
    return rows.map(jobFromRecord);
  }

  public async getJob(id: string): Promise<SourceRecoveryJob | null> {
    const row = await prisma.crawlTask.findUnique({ where: { id } });
    return row && row.scope === RECOVERY_SCOPE ? jobFromRecord(row) : null;
  }

  /** Construye una cola DB-only; todavía no hace peticiones a proveedores. */
  public async createJob(options: SourceRecoveryStartOptions = {}): Promise<SourceRecoveryJob> {
    const mode = options.mode ?? "expired";
    const providerFilter = new Set((options.providers || []).map(cleanSite).filter(Boolean));
    // No cargar `media_episode.links` dentro de cada SourceLink: esa relación
    // repetía el mismo episodio decenas de veces y disparaba cientos de MB en
    // catálogos grandes. Cada fila trae solo su enlace y la identidad mínima;
    // luego se agrupa una sola vez por episodio.
    const linkSelect = {
      media_episode_id: true,
      source_site: true,
      url: true,
      link_type: true,
      canonical_locator: true,
      media_episode: {
        select: {
          id: true,
          season_number: true,
          episode_number: true,
          media_item: { select: { id: true, title: true, kind: true, year: true } },
        },
      },
    } as const;
    const directLinks = await prisma.sourceLink.findMany({
      where: mode === "all" ? { link_type: { in: ["direct", "page", "embed"] } } : { link_type: "direct" },
      select: linkSelect,
    });

    const grouped = new Map<string, { episode: any; providers: Set<string> }>();
    const addGroupedLink = (link: any, provider: string): void => {
      const sourceEpisode = link.media_episode;
      if (!sourceEpisode?.id || !sourceEpisode.media_item) return;
      const key = sourceEpisode.id;
      const current = grouped.get(key) || {
        episode: {
          id: sourceEpisode.id,
          season_number: sourceEpisode.season_number,
          episode_number: sourceEpisode.episode_number,
          media_item: sourceEpisode.media_item,
          links: [],
        },
        providers: new Set<string>(),
      };
      if (!current.episode.links.some((candidate: any) => candidate.url === link.url && candidate.source_site === link.source_site)) {
        current.episode.links.push({
          url: link.url,
          source_site: link.source_site,
          link_type: link.link_type,
          canonical_locator: link.canonical_locator,
        });
      }
      current.providers.add(provider);
      grouped.set(key, current);
    };
    for (const link of directLinks) {
      const provider = cleanSite(link.source_site);
      if (isExcludedRecoverySite(provider) || (providerFilter.size > 0 && !providerFilter.has(provider))) continue;
      const expired = isExpiredDirectUrl(link.url);
      if (mode !== "all" && !expired) continue;
      // In a full pass, a direct link is useful only if it is still a stable
      // locator (or carries a canonical locator saved by an earlier scan).
      // Historical signed URLs remain data for diagnosis, never identities.
      if (mode === "all" && link.link_type === "direct" &&
        classifySourceKind(link.url) !== "stable_direct" && !isCanonicalLocator(link.canonical_locator || "")) continue;
      addGroupedLink(link, provider);
    }

    // También repara el enlace de catálogo inválido detectado por la auditoría.
    const invalidCatalogs = await prisma.sourceLink.findMany({
      where: { url: { contains: "/page/" } },
      select: linkSelect,
    });
    for (const link of invalidCatalogs) {
      const provider = cleanSite(link.source_site);
      if (isExcludedRecoverySite(provider) || (providerFilter.size > 0 && !providerFilter.has(provider))) continue;
      addGroupedLink(link, provider);
    }

    // El modo `expired` comenzó con enlaces directos, pero cada objetivo puede
    // tener además una página canónica estable. Cargar esas relaciones una sola
    // vez permite reutilizar el localizador correcto sin repetir el join.
    if (mode !== "all" && grouped.size > 0) {
      const allLinks = await prisma.sourceLink.findMany({
        where: { media_episode_id: { in: [...grouped.keys()] } },
        select: {
          media_episode_id: true,
          source_site: true,
          url: true,
          link_type: true,
          canonical_locator: true,
        },
      });
      for (const link of allLinks) {
        const current = grouped.get(link.media_episode_id);
        if (!current) continue;
        if (!current.episode.links.some((candidate: any) => candidate.url === link.url && candidate.source_site === link.source_site)) {
          current.episode.links.push(link);
        }
        const provider = cleanSite(link.source_site);
        if (provider && !isExcludedRecoverySite(provider)) current.providers.add(provider);
      }
    }

    const targets = [...grouped.values()];
    const targetKeys = [...new Set(targets.map((entry) => titleKey(entry.episode.media_item.title)).filter(Boolean))];
    // El fallback legacy es útil en catálogos pequeños, pero un OR con miles
    // de títulos genera SQL enorme y vuelve a cargar toda la memoria. En una
    // cola grande cada objetivo ya trae su localizador; los demás usan la
    // búsqueda acotada por proveedor dentro de recoverItem().
    const legacyShows = targetKeys.length > 0 && targetKeys.length <= 1000
      ? await prisma.show.findMany({
        where: { OR: targetKeys.flatMap((key) => [{ normalized_title: key }, { base_normalized_title: key }]) },
        select: {
          title: true,
          normalized_title: true,
          base_normalized_title: true,
          year: true,
          episodes: { select: { episode_number: true, source_url: true } },
        },
      })
      : [];
    if (targetKeys.length > 1000) {
      console.log(`[SourceRecovery] ${targetKeys.length} títulos: se omite fallback legacy masivo para mantener memoria acotada.`);
    }

    const queueRows = await prisma.crawlTask.findMany({
      where: { scope: { not: RECOVERY_SCOPE } },
      select: { target_url: true, items_queue: true },
    });
    const queueIndex = new Map<string, Array<{ site: string; url: string }>>();
    for (const row of queueRows) {
      const targetSite = siteFromUrl(row.target_url);
      if (isExcludedRecoverySite(targetSite)) continue;
      for (const item of parseQueue(row.items_queue)) {
        if (!item.url || !item.title || !isCanonicalLocator(item.url)) continue;
        const key = titleKey(item.title);
        if (!key) continue;
        const list = queueIndex.get(key) || [];
        const itemSite = siteFromUrl(item.url) || targetSite;
        if (isExcludedRecoverySite(itemSite)) continue;
        list.push({ site: itemSite, url: item.url });
        queueIndex.set(key, list);
      }
    }

    let queue: RecoveryQueueItem[] = targets.map(({ episode, providers }) => {
      const title = episode.media_item.title;
      // Las fichas/embeds ya almacenados también se verifican: una URL con
      // forma canónica puede haber quedado retirada o cambiado de contenido.
      // Se ponen primero para evitar búsquedas innecesarias y conservar la
      // identidad del proveedor cuando todavía funciona.
      const existingCanonical = episode.links.flatMap((link: { url: string; link_type: string; canonical_locator?: string | null }) => {
        // Una recuperación anterior puede haber conservado la identidad
        // canónica mientras `url` era un manifiesto firmado. Priorizar ese
        // localizador evita volver a enviar el token muerto al extractor.
        if (link.canonical_locator && isCanonicalLocator(link.canonical_locator)) return [link.canonical_locator];
        return canonicalSourceLink(link) ? [link.url] : [];
      });
      const existingStableDirect = mode === "all"
        ? episode.links
          .filter((link: { url: string }) => classifySourceKind(link.url) === "stable_direct")
          .map((link: { url: string }) => link.url)
        : [];
      const legacy = mapLegacyCandidates(legacyShows, {
        title,
        year: episode.media_item.year,
        episode_number: episode.episode_number,
      });
      const indexed = queueIndex.get(titleKey(title)) || [];
      const sameProvider = indexed.filter((entry) => providers.has(entry.site)).map((entry) => entry.url);
      const anyProvider = indexed.map((entry) => entry.url);
      // Keep the persisted queue bounded: old task queues can contain many
      // duplicate pages for the same title and should not inflate CrawlTask.
      const candidateUrls = uniqueRecoveryUrls([...existingCanonical, ...existingStableDirect, ...legacy, ...sameProvider, ...anyProvider]).slice(0, 8);
      return {
        media_episode_id: episode.id,
        media_item_id: episode.media_item.id,
        title,
        kind: episode.media_item.kind,
        year: episode.media_item.year ?? null,
        season_number: episode.season_number,
        episode_number: episode.episode_number,
        provider_sites: [...providers],
        candidate_urls: candidateUrls,
        // Incluso las fichas ya almacenadas se vuelven a comprobar; que una
        // URL tenga forma canónica no garantiza que siga viva en el proveedor.
        status: "pending",
      } satisfies RecoveryQueueItem;
    });

    queue.sort((a, b) => a.title.localeCompare(b.title) || a.episode_number - b.episode_number);
    const limit = clampLimit(options.limit);
    if (limit) queue = queue.slice(0, limit);
    const id = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const delay = clampDelay(options.delay_ms);
    const row = await prisma.crawlTask.create({
      data: {
        id,
        name: options.name || "Recuperación canónica de fuentes",
        target_url: mode === "all" ? "source-recovery://all-sources" : "source-recovery://expired-directs",
        status: "recovery_pending",
        scope: RECOVERY_SCOPE,
        max_pages: 0,
        current_page: 0,
        total_discovered: queue.length,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: delay,
        items_queue: JSON.stringify(queue),
        error_message: null,
        logs: JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: `Cola creada con ${queue.length} episodios (modo ${mode}).` }]),
      },
    });
    return jobFromRecord(row);
  }

  public async pauseJob(id: string): Promise<boolean> {
    const result = await prisma.crawlTask.updateMany({ where: { id, scope: RECOVERY_SCOPE, status: { in: ["recovery_pending", "recovery_running"] } }, data: { status: "recovery_paused" } });
    return result.count === 1;
  }

  public async resumeJob(id: string): Promise<boolean> {
    const result = await prisma.crawlTask.updateMany({ where: { id, scope: RECOVERY_SCOPE, status: "recovery_paused" }, data: { status: "recovery_pending", error_message: null } });
    return result.count === 1;
  }

  private async processNext(): Promise<void> {
    if (this.activeJobId) return;
    if (!this.startupReconciled) {
      // Un cierre del proceso puede dejar una tarea marcada como running. En
      // este proceso nuevo no existe el worker anterior que pudiera reclamarla,
      // así que se reencolan todas; la aplicación opera con una sola instancia
      // del worker y conserva el checkpoint por elemento.
      await prisma.crawlTask.updateMany({
        where: { scope: RECOVERY_SCOPE, status: "recovery_running" },
        data: { status: "recovery_pending", error_message: null },
      });
      this.startupReconciled = true;
    }
    const pending = await prisma.crawlTask.findFirst({ where: { scope: RECOVERY_SCOPE, status: "recovery_pending" }, orderBy: { created_at: "asc" } });
    if (!pending) return;
    const claimed = await prisma.crawlTask.updateMany({ where: { id: pending.id, scope: RECOVERY_SCOPE, status: "recovery_pending" }, data: { status: "recovery_running" } });
    if (claimed.count !== 1) return;
    this.activeJobId = pending.id;
    try {
      await this.execute(pending.id);
    } catch (error) {
      const message = String((error as { message?: unknown })?.message || error).slice(0, 500);
      await prisma.crawlTask.updateMany({
        where: { id: pending.id, scope: RECOVERY_SCOPE, status: "recovery_running" },
        data: { status: "failed", error_message: message },
      });
      console.error(`[SourceRecovery] job ${pending.id} failed:`, message);
    } finally {
      this.activeJobId = null;
    }
  }

  private async execute(id: string): Promise<void> {
    const record = await prisma.crawlTask.findUnique({ where: { id } });
    if (!record) return;
    const queue = parseQueue(record.items_queue) as RecoveryQueueItem[];
    let recovered = Number(record.episodes_imported || 0);
    let errors = 0;
    for (let batchStart = 0; batchStart < queue.length; batchStart += RECOVERY_CONCURRENCY) {
      // No volver a traer la cola JSON completa (puede pesar decenas de MB) en
      // cada episodio: solo se necesitan el estado y el ritmo para controlar
      // la pausa/reanudación. La cola en memoria ya contiene el checkpoint.
      const live = await prisma.crawlTask.findUnique({
        where: { id },
        select: { status: true, rate_limit_delay_ms: true },
      });
      if (!live || live.status === "recovery_paused") return;
      if (live.status !== "recovery_running") return;

      const indexes: number[] = [];
      for (let index = batchStart; index < Math.min(queue.length, batchStart + RECOVERY_CONCURRENCY); index++) {
        const item = queue[index];
        if (item.status === "already_canonical" || item.status === "done") continue;
        item.status = "processing";
        indexes.push(index);
      }
      if (indexes.length === 0) continue;

      // El checkpoint previo deja los elementos como `processing`; si el
      // proceso muere, el reconciliador de arranque los vuelve a intentar.
      await this.persist(id, queue, batchStart);

      await Promise.all(indexes.map(async (index) => {
        const item = queue[index];
        try {
          const canonical = await withTimeout(this.recoverItem(item), RECOVERY_ITEM_TIMEOUT_MS);
          if (canonical) {
            item.status = "done";
            item.canonical_url = canonical;
            recovered++;
          } else {
            item.status = "skipped";
          }
        } catch (error: any) {
          item.status = "error";
          item.error = String(error?.message || error).slice(0, 500);
          errors++;
        }

        // Las fichas/embeds ya clasificados se guardan localmente y no generan
        // tráfico al proveedor. El delay solo se aplica cuando el elemento
        // necesita una búsqueda externa y todas las tareas del lote lo
        // comparten sin bloquear las demás recuperaciones.
        const needsExternalSearch = item.candidate_urls.length === 0 || item.candidate_urls.some((url) =>
          !isCanonicalLocator(url) && classifySourceKind(url) !== "stable_direct",
        );
        if (needsExternalSearch) {
          await new Promise((resolve) => setTimeout(resolve, clampDelay(live.rate_limit_delay_ms)));
        }
      }));

      // Escribir una sola cola grande por lote evita carreras entre savers y
      // conserva como máximo un lote pendiente ante un cierre inesperado.
      const batchEnd = Math.min(queue.length - 1, batchStart + RECOVERY_CONCURRENCY - 1);
      await this.persist(id, queue, batchEnd, recovered, errors);
    }
    await prisma.crawlTask.update({ where: { id }, data: { status: "completed", items_queue: JSON.stringify(queue), episodes_imported: recovered, error_message: errors ? `${errors} elementos no pudieron verificarse` : null } });
  }

  private async persist(id: string, queue: RecoveryQueueItem[], index: number, recovered?: number, errors?: number): Promise<void> {
    // `recovered` se pasa para actualizar contadores, pero no debe forzar una
    // escritura en cada elemento: `items_queue` contiene todo el lote y puede
    // pesar varios MB. El último elemento siempre se confirma para no dejar
    // una tarea visualmente incompleta.
    if (index % PERSIST_EVERY !== 0 && index !== queue.length - 1) return;
    const done = queue.filter((item) => item.status === "done" || item.status === "already_canonical").length;
    await prisma.crawlTask.update({
      where: { id },
      data: {
        items_queue: JSON.stringify(queue),
        current_page: index + 1,
        episodes_imported: recovered ?? done,
        error_message: errors ? `${errors} errores parciales` : null,
      },
    });
  }

  private async recoverItem(item: RecoveryQueueItem): Promise<string | undefined> {
    let candidates = [...item.candidate_urls];
    if (candidates.length === 0) {
      for (const provider of item.provider_sites) {
        const adapterId = SEARCH_ADAPTERS[cleanSite(provider)];
        if (!adapterId) continue;
        try {
          const analysis = await withTimeout(analyzeUniversalUrl(item.title, "auto", adapterId), FETCH_TIMEOUT_MS);
          const exact = (analysis.catalog_items || []).filter((entry) =>
            candidateMatchesTitle(entry.title, item.title) &&
            (!entry.year || !item.year || entry.year === item.year) &&
            isCanonicalLocator(entry.url)
          );
          candidates.push(...exact.map((entry) => entry.url));
        } catch {}
      }
      candidates = uniqueUrls(candidates);
    }
    let firstRecovered: string | undefined;
    for (const candidate of candidates) {
      try {
        const directCandidate = classifySourceKind(candidate) === "stable_direct";
        // Las URLs que ya tienen forma de ficha/embed son localizadores
        // canónicos. No hace falta volver a descargar cada página durante la
        // reimportación: el reproductor las resolverá JIT al reproducir. Esto
        // evita que un proveedor lento bloquee toda la cola durante minutos.
        // Solo se analiza una URL ambigua que no podamos clasificar localmente.
        let analysis: Awaited<ReturnType<typeof analyzeUniversalUrl>> | undefined;
        const canonicalCandidate = isCanonicalLocator(candidate);
        if (!canonicalCandidate && !directCandidate) {
          analysis = await withTimeout(analyzeUniversalUrl(candidate, "detail"), FETCH_TIMEOUT_MS);
          if (analysis.page_type === "catalog") continue;
        }
        const episodeUrl = directCandidate || canonicalCandidate || item.kind === "movie"
          ? candidate
          : extractEpisodeUrl(analysis, item.episode_number);
        const locator = episodeUrl && (isCanonicalLocator(episodeUrl) || classifySourceKind(episodeUrl) === "stable_direct")
          ? episodeUrl
          : item.kind === "movie" && directCandidate ? candidate : undefined;
        if (!locator) continue;
        const sourceSite = siteFromUrl(locator);
        const locatorKind = classifySourceKind(locator);
        const linkType = locatorKind === "embed" ? "embed" : locatorKind === "stable_direct" ? "direct" : "page";

        // A canonical page/embed is intentionally persisted as a discovery
        // result. The signed CDN URL is never used as the identity. Stream
        // extraction remains JIT (or can be enabled as a separate verification
        // pass) so a full reimport does not overload providers or the backend.
        const where = { media_episode_id_source_site_url: { media_episode_id: item.media_episode_id, source_site: sourceSite, url: locator } };
        const existing = typeof prisma.sourceLink.findUnique === "function"
          ? await prisma.sourceLink.findUnique({ where, select: { source_status: true, failure_reason: true } })
          : null;
        const priorPlayerEvidence = isPlayerEligible(existing?.source_status);
        const nextStatus = mergeSourceEvidenceStatus(existing?.source_status, SOURCE_EVIDENCE_STATUS.DISCOVERED);
        const checkedAt = new Date();
        await prisma.sourceLink.upsert({
          where,
          create: {
            media_episode_id: item.media_episode_id,
            source_site: sourceSite,
            url: locator,
            link_type: linkType,
            host: sourceSite,
            is_verified: false,
            source_status: nextStatus,
            canonical_locator: locator,
            extraction_method: "source_recovery_jit",
            resolver_version: "source-recovery-v2",
            failure_reason: priorPlayerEvidence ? undefined : null,
            last_checked: checkedAt,
            last_success: null,
            last_failure: null,
          },
          update: {
            link_type: linkType,
            host: sourceSite,
            is_verified: false,
            source_status: nextStatus,
            canonical_locator: locator,
            extraction_method: "source_recovery_jit",
            resolver_version: "source-recovery-v2",
            failure_reason: priorPlayerEvidence ? undefined : null,
            last_checked: checkedAt,
            last_success: undefined,
            last_failure: undefined,
          },
        });
        // No detenerse en el primer enlace: un episodio puede tener varias
        // fuentes/idiomas. La clave única hace que repetir la pasada sea
        // idempotente y evita duplicados aunque el mismo candidato provenga
        // de más de un índice.
        firstRecovered ||= locator;
      } catch {}
    }
    return firstRecovered;
  }
}

export const sourceRecoveryWorker = new SourceRecoveryWorker();
