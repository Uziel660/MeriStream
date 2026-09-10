// src/api/client.ts
// Cliente fetch centralizado hacia el backend FastAPI (/api/v1), compatibilizado con la arquitectura Just-In-Time.

import type {
  MediaListResponse,
  MediaSearchParams,
  MediaStreamOut,
  ExtractRequest,
  ExtractResponse,
  DiscoverRequest,
  DiscoverResponse,
  TaskOut,
  ApiError,
  MediaItemOut,
  Show,
  ShowDetail,
  PlayStreamResponse,
  CrawlTaskResponse,
  ScraperPreset,
  UniversalAnalysisResult,
} from "../types";

const BASE_URL = "/api/v1";

function inferProtocolFromUrl(url?: string | null): "hls" | "dash" | "mp4" {
  if (!url) return "mp4";
  const normalized = url.toLowerCase();
  if (normalized.includes(".mpd") || normalized.includes("dash")) return "dash";
  return normalized.includes(".m3u8") || normalized.includes("m3u8") ? "hls" : "mp4";
}

function inferQualityFromUrl(url?: string | null): MediaItemOut["quality"] {
  if (!url) return "HD";
  const normalized = url.toLowerCase();
  if (normalized.includes(".m3u8")) return "HLS";
  if (normalized.includes("1080") || normalized.includes("fhd")) return "FHD";
  if (normalized.includes("720") || normalized.includes("hd")) return "HD";
  return "SD";
}

function normalizeMediaItem(item: any): MediaItemOut {
  const title = item.title ?? "Sin título";
  const streamUrl = item.stream_url ?? item.master_m3u8 ?? item.url ?? "";

  return {
    id: String(item.id ?? `media-${Math.random().toString(36).slice(2)}`),
    title,
    original_title: item.original_title ?? title,
    overview: item.description ?? item.overview ?? "",
    kind: item.kind ?? "movie",
    category: item.category ?? "general",
    genres: Array.isArray(item.genres) ? item.genres : [],
    poster_url: item.poster_url ?? null,
    backdrop_url: item.backdrop_url ?? item.poster_url ?? null,
    release_year: item.release_year ?? null,
    runtime_minutes: item.runtime_minutes ?? null,
    rating: typeof item.rating === "number" ? item.rating : 0,
    quality: inferQualityFromUrl(streamUrl),
    is_trending: Boolean(item.is_trending),
    is_featured: Boolean(item.is_featured),
    created_at: item.created_at ?? new Date().toISOString(),
    updated_at: item.updated_at ?? item.created_at ?? new Date().toISOString(),
  };
}

export const AUTH_TOKEN_KEY = "nitiflix_auth_token_v1";

export type VerificationPhase = "idle" | "metadata" | "catalog";
export type VerificationRunMode = "metadata" | "full";

export interface VerificationConfig {
  enabled: boolean;
  interval_minutes: number;
  scope_mode: "all" | "platforms" | "category" | string;
  platforms: string[];
  category?: string | null;
  catalog_urls_by_platform: Record<string, string>;
  catalog_pages_per_platform?: number;
  metadata_only: boolean;
  sync_known_episodes: boolean;
}

export interface VerificationProgress {
  total: number;
  done: number;
  percent?: number;
  new_works?: number;
  new_sources?: number;
  new_episodes?: number;
  updated_metadata?: number;
  metadata_updated?: number;
  works_created?: number;
  works_merged?: number;
  sources_added?: number;
  errors: number;
}

export interface VerificationReport {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  trigger: "manual" | "timer" | string;
  scope: { mode: string; platforms: string[]; category: string | null };
  metadata_phase?: { works_total: number; works_done: number; updated_metadata: number; errors: number };
  catalog_phase?: {
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
  };
}

export interface VerificationStatus {
  is_running: boolean;
  running?: boolean;
  paused?: boolean;
  phase: VerificationPhase | string;
  current_target?: string | null;
  current_item?: string | null;
  progress: VerificationProgress | null;
  last_report: VerificationReport | null;
  last_run_at: string | null;
  next_run_at: string | null;
  recent: Array<{ at: string; level: "info" | "warn" | "error" | string; message: string }>;
  config: VerificationConfig;
}

export interface VerificationRunResponse {
  ok: boolean;
  started: boolean;
  reason?: string;
  status: VerificationStatus;
}

export interface IdentityRepairStatus {
  state: "running" | "completed" | "failed" | "unknown";
  phase: "anime" | "shows" | "media" | null;
  pass: number | null;
  batch: number | null;
  considered: number;
  applied: number;
  unresolved: number;
  conflicts: number;
  errors: number;
  batches: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  latest_report: string | null;
  report_dir: string;
  message: string;
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    }
  } catch {}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("/api/") ? path : `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const token = getAuthToken();
  if (token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
    });
  } catch (err) {
    const apiErr: ApiError = { status: 0, message: "No se pudo conectar con el servidor. Verifica tu conexión." };
    throw apiErr;
  }

  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body = await res.json();
      message = body.detail ?? body.message ?? body.error ?? message;
    } catch {
      // respuesta sin cuerpo JSON
    }
    const apiErr: ApiError = { status: res.status, message };
    throw apiErr;
  }

  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

function buildQuery(params: Record<string, unknown> | MediaSearchParams): string {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      usp.set(key, String(value));
    }
  });
  const qs = usp.toString();
  return qs ? `?${qs}` : "";
}

export interface PlaybackResolution {
  url: string;
  original_url: string;
  canonical_locator?: string;
  resolved: boolean;
  type: "direct" | "embed";
  delivery_mode?: "direct" | "direct_trial" | "proxy_required" | "embed";
  is_proxyable?: boolean;
  is_refreshable?: boolean;
  provider?: string;
  strategy?: string;
  /** URL estable del proxy de sesión; preferirla sobre la URL upstream firmada. */
  playback_url?: string;
  session_id?: string;
  resolved_at?: number;
  expires_at?: number;
  refresh_after?: number;
  resolution_id?: string;
  generation?: string;
  expiration_source?: string;
  requiredHeaders?: Record<string, string>;
  subtitles?: Array<{
    id?: string;
    label?: string;
    language?: string;
    url?: string;
    src?: string;
    is_default?: boolean;
  }>;
  subtitle_mode?: 'external' | 'burned_in' | 'unknown';
  failure_reason?:
    | "expired_without_locator"
    | "unresolved"
    | "unsafe_url"
    | "empty_locator"
    | "provider_blocked"
    | "drm_or_captcha";
}

export const api = {
  async getIdentityRepairStatus(): Promise<IdentityRepairStatus> {
    return request<IdentityRepairStatus>("/admin/identity-repair/status");
  },

  async getVerificationStatus(): Promise<VerificationStatus> {
    return request<VerificationStatus>("/verification");
  },

  async runVerification(
    mode: VerificationRunMode = "full",
    options: { platforms?: string[]; limit?: number } = {}
  ): Promise<VerificationRunResponse> {
    return request<VerificationRunResponse>("/verification/run", {
      method: "POST",
      body: JSON.stringify({ mode, ...options }),
    });
  },

  async updateVerificationConfig(
    patch: Partial<VerificationConfig>
  ): Promise<{ ok: boolean; config: VerificationConfig; status?: VerificationStatus }> {
    return request<{ ok: boolean; config: VerificationConfig; status?: VerificationStatus }>("/verification/config", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  },

  async pauseVerification(): Promise<{ ok: boolean; status: VerificationStatus }> {
    return request<{ ok: boolean; status: VerificationStatus }>("/verification/pause", { method: "POST" });
  },

  async resumeVerification(): Promise<{ ok: boolean; status: VerificationStatus }> {
    return request<{ ok: boolean; status: VerificationStatus }>("/verification/resume", { method: "POST" });
  },

  async stopVerification(): Promise<{ ok: boolean; status: VerificationStatus }> {
    return request<{ ok: boolean; status: VerificationStatus }>("/verification/stop", { method: "POST" });
  },

  async repairCatalogLinks(): Promise<{ ok: boolean; message: string; details?: any }> {
    return request<{ ok: boolean; message: string; details?: any }>("/verification/repair-links", { method: "POST" });
  },

  // Nueva arquitectura Just-In-Time
  async getShows(search?: string, category?: string): Promise<Show[]> {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (category) params.append("category", category);
    return request<Show[]>(`/shows${params.toString() ? `?${params.toString()}` : ""}`);
  },

  async getShowDetails(showId: string): Promise<ShowDetail> {
    return request<ShowDetail>(`/shows/${encodeURIComponent(showId)}`);
  },

  /**
   * Editor de catálogo: actualiza SOLO los campos presentes en el patch.
   * El backend recalcula las claves canónicas de dedup si cambia el título.
   */
  async updateShow(
    showId: string,
    patch: Partial<{
      title: string;
      description: string;
      genres: string | string[];
      year: number;
      rating: number;
      status: string;
      category: string;
      poster_url: string | null;
      banner_url: string | null;
      japanese_title: string | null;
      english_title: string | null;
      tmdb_id: number | string | null;
      imdb_id: string | null;
      tvdb_id: number | string | null;
      mal_id: number | string | null;
      anilist_id: string | number | null;
      kitsu_id: string | number | null;
      anidb_id: string | number | null;
    }>
  ): Promise<Show> {
    return request<Show>(`/shows/${encodeURIComponent(showId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },

  /** Re-resuelve servidores JIT por episodio (lento: el backend responde 202 y trabaja en background). */
  async refreshShowStreams(showId: string): Promise<{ ok: boolean; message: string; show_id?: string }> {
    return request<{ ok: boolean; message: string; show_id?: string }>(
      `/shows/${encodeURIComponent(showId)}/refresh-streams`,
      { method: "POST" }
    );
  },

  async getEpisodeStream(episodeId: string): Promise<PlayStreamResponse> {
    const data = await request<any>(`/play/${encodeURIComponent(episodeId)}`);
    return {
      episode_id: data.episode_id,
      stream_url: data.stream_url,
      title: data.title,
      all_available_streams: Array.isArray(data.all_available_streams) ? data.all_available_streams : [data.stream_url],
      ranked_streams: Array.isArray(data.ranked_streams) ? data.ranked_streams : undefined,
    };
  },

  async getMultiSourceCascade(mediaItemId: string, season?: number): Promise<any> {
    const qs = season && season > 1 ? `?season=${season}` : "";
    return request<any>(`/play-multi/${encodeURIComponent(mediaItemId)}${qs}`);
  },

  async getSiteRatings(): Promise<{ ratings: Array<{ site: string; rating: number; enabled: boolean; notes: string | null }> }> {
    return request(`/sites/ratings`);
  },

  async saveSiteRating(payload: { site: string; rating?: number; enabled?: boolean; notes?: string }): Promise<any> {
    return request(`/sites/ratings`, { method: "POST", body: JSON.stringify(payload) });
  },

  async getPresets(): Promise<ScraperPreset[]> {
    return request<ScraperPreset[]>(`/scraper/presets`);
  },

  async analyzeUniversal(url: string): Promise<UniversalAnalysisResult> {
    return request<UniversalAnalysisResult>(`/catalog/analyze`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },

  async batchImport(urls: string[]): Promise<any> {
    return request<any>(`/catalog/batch-import`, {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
  },

  async resetSampleCatalog(): Promise<any> {
    return request<any>(`/catalog/reset-sample`, {
      method: "POST",
    });
  },

  async startCrawl(
    url: string,
    max_pages: number = 1,
    delay_ms: number = 1500,
    scope: "single" | "catalog_pages" | "full_catalog" = "catalog_pages"
  ): Promise<{ task_id: string; message: string; job?: any }> {
    return request<{ task_id: string; message: string; job?: any }>(`/catalog/crawl`, {
      method: "POST",
      body: JSON.stringify({ url, max_pages, delay_ms, scope }),
    });
  },

  async getTaskStatus(taskId: string): Promise<CrawlTaskResponse> {
    return request<CrawlTaskResponse>(`/tasks/${encodeURIComponent(taskId)}`);
  },

  async getWorkerJobs(): Promise<any[]> {
    return request<any[]>(`/worker/jobs`);
  },

  async getWorkerSettings(): Promise<any> {
    return request<any>(`/worker/settings`);
  },

  async updateWorkerSettings(settings: any): Promise<any> {
    return request<any>(`/worker/settings`, {
      method: "POST",
      body: JSON.stringify(settings),
    });
  },

  async pauseWorkerJob(jobId: string): Promise<any> {
    return request<any>(`/worker/jobs/${encodeURIComponent(jobId)}/pause`, {
      method: "POST",
    });
  },

  async resumeWorkerJob(jobId: string): Promise<any> {
    return request<any>(`/worker/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: "POST",
    });
  },

  async cancelWorkerJob(jobId: string): Promise<any> {
    return request<any>(`/worker/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
    });
  },

  async deleteWorkerJob(jobId: string): Promise<any> {
    return request<any>(`/worker/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    });
  },

  async clearFinishedWorkerJobs(): Promise<any> {
    return request<any>(`/worker/clear-finished`, {
      method: "POST",
    });
  },

  // Compatibilidad con el UI anterior
  async listMedia(params: MediaSearchParams = {}): Promise<MediaListResponse> {
    const raw = await request<any[]>(`/media${buildQuery(params)}`);
    const items = Array.isArray(raw) ? raw.map(normalizeMediaItem) : [];
    return {
      items,
      total: items.length,
      page: params.page ?? 1,
      page_size: params.page_size ?? items.length,
    };
  },

  async getStream(mediaId: string): Promise<MediaStreamOut> {
    const raw = await request<any>(`/media/${encodeURIComponent(mediaId)}/stream`);

    const variants = (raw.qualities ?? []).map((quality: any, index: number) => ({
      id: `${mediaId}-${index}`,
      protocol: inferProtocolFromUrl(quality.url ?? raw.master_m3u8 ?? raw.fallback_mp4),
      url: quality.url ?? raw.master_m3u8 ?? raw.fallback_mp4 ?? "",
      resolution_label: quality.resolution ?? null,
      bandwidth: null,
      is_default: index === 0,
    }));

    const primaryUrl = raw.master_m3u8 ?? raw.fallback_mp4 ?? variants[0]?.url ?? "";
    if (!variants.length && primaryUrl) {
      variants.push({
        id: `${mediaId}-primary`,
        protocol: inferProtocolFromUrl(primaryUrl),
        url: primaryUrl,
        resolution_label: "Auto",
        bandwidth: null,
        is_default: true,
      });
    }

    return {
      media_id: raw.media_id ?? mediaId,
      title: raw.title ?? "Sin título",
      protocol: inferProtocolFromUrl(primaryUrl),
      variants,
      subtitles: (raw.subtitles ?? []).map((sub: any, index: number) => ({
        id: sub.id ?? `${mediaId}-sub-${index}`,
        label: sub.label ?? "Subtítulo",
        language: sub.language ?? "es",
        url: sub.src ?? sub.url ?? "",
        is_default: Boolean(sub.is_default ?? index === 0),
      })),
      poster_url: raw.poster_url ?? null,
    };
  },

  async extract(payload: ExtractRequest): Promise<ExtractResponse> {
    const raw = await request<any>(`/extract`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const detectedStreamUrl = raw.stream_url ?? null;
    return {
      status: detectedStreamUrl ? "success" : "error",
      title: raw.title ?? null,
      detected_stream_url: detectedStreamUrl,
      protocol: inferProtocolFromUrl(detectedStreamUrl),
      thumbnail_url: null,
      message: detectedStreamUrl ? "Stream detectado correctamente." : "No se detectó un stream válido.",
    };
  },

  discover(payload: DiscoverRequest): Promise<DiscoverResponse> {
    return request<DiscoverResponse>(`/discover`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async getTask(taskId: string): Promise<TaskOut> {
    const raw = await request<any>(`/tasks/${encodeURIComponent(taskId)}`);
    const status = raw.status ?? "pending";
    const itemsProcessed = Number(raw.items_processed ?? 0);
    const itemsFound = Number(raw.items_found ?? 0);

    return {
      id: raw.id ?? taskId,
      kind: "discover",
      status,
      created_at: raw.created_at ?? new Date().toISOString(),
      updated_at: raw.updated_at ?? new Date().toISOString(),
      progress: {
        pages_scanned: itemsProcessed,
        pages_total: itemsFound || undefined,
        videos_imported: itemsProcessed,
        videos_skipped: 0,
      },
      logs: [],
      error_message: raw.error_message ?? null,
      result_media_ids: [],
    };
  },

  async getEpisodeServers(url: string): Promise<{
    url: string;
    stream_url: string;
    all_available_streams: string[];
    title?: string;
    resolved: boolean;
    /** Cabeceras que el CDN exige al consumir stream_url (ej. vimeos: Origin/Referer) */
    requiredHeaders?: Record<string, string>;
    ranked_streams?: Array<{
      url: string;
      type?: "direct" | "embed";
      tier?: number;
      host?: string | null;
      provider?: string;
      source_site?: string;
      original_url?: string;
      canonical_locator?: string;
      resolution_id?: string;
      generation?: string;
      delivery_mode?: "direct" | "direct_trial" | "proxy_required" | "embed";
      is_proxyable?: boolean;
      is_refreshable?: boolean;
      refresh_after?: number;
      expires_at?: number;
      resolved_at?: number;
      requiredHeaders?: Record<string, string>;
      subtitles?: Array<{ id?: string; label?: string; language?: string; src?: string; url?: string; is_default?: boolean }>;
    }>;
  }> {
    return request<any>(`/catalog/episode-servers`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },

  async resolveEmbed(url: string): Promise<PlaybackResolution> {
    return request<PlaybackResolution>(`/resolve-embed`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },

  async requestProxySession(original_url: string, resolution_id?: string): Promise<{
    session_id: string;
    playback_url: string;
    expires_at: number;
    refresh_after: number;
    generation: string;
  }> {
    return request<any>(`/playback/sessions`, {
      method: "POST",
      body: JSON.stringify({ original_url, resolution_id }),
    });
  },

  async closeProxySession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await fetch(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  },

  async reportPlayerEvent(event: {
    eventType:
      | "scraper_resolution"
      | "scraper_failed"
      | "embed_opened"
      | "playback_started"
      | "playback_buffering"
      | "black_screen_stalled"
      | "playback_error"
      | "failover_auto"
      | "failover_manual"
      | "quota_fallback"
      | "embed_unresolvable";
    provider?: string;
    serverUrl: string;
    mediaTitle?: string;
    episodeTitle?: string;
    durationBeforeErrorMs?: number;
    bufferPauseCount?: number;
    details?: string;
  }): Promise<void> {
    try {
      await request<any>(`/network/player-event`, {
        method: "POST",
        body: JSON.stringify(event),
      });
    } catch {
      // Ignorar fallos de telemetría para no afectar la UI
    }
  },

  // ==========================================
  // Auth API
  // ==========================================
  async register(username: string, password: string, avatar?: string): Promise<{ user: any; token: string }> {
    const res = await request<{ user: any; token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, avatar }),
    });
    if (res.token) {
      setAuthToken(res.token);
    }
    return res;
  },

  async login(username: string, password: string): Promise<{ user: any; token: string }> {
    const res = await request<{ user: any; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (res.token) {
      setAuthToken(res.token);
    }
    return res;
  },

  async getMe(): Promise<{ user: any }> {
    return request<{ user: any }>("/api/auth/me");
  },

  async updateAvatar(avatar: string): Promise<{ user: any }> {
    return request<{ user: any }>("/api/auth/avatar", {
      method: "PATCH",
      body: JSON.stringify({ avatar }),
    });
  },

  logout() {
    setAuthToken(null);
  },

  // ==========================================
  // Watch Progress API ("Seguir Viendo")
  // ==========================================
  async getProgress(): Promise<{ items: any[] }> {
    return request<{ items: any[] }>("/api/progress");
  },

  async saveProgress(data: {
    showId: string;
    showTitle: string;
    showPoster?: string;
    episodeId: string;
    episodeNumber: number;
    episodeTitle: string;
    progressPercent: number;
    currentTime?: number;
    duration?: number;
  }): Promise<{ success: boolean; item?: any }> {
    return request<{ success: boolean; item?: any }>("/api/progress", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async deleteProgressItem(episodeId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/progress/${episodeId}`, {
      method: "DELETE",
    });
  },

  async deleteProgressShow(showId: string): Promise<{ success: boolean }> {
    return request<{ success: boolean }>(`/api/progress/show/${showId}`, {
      method: "DELETE",
    });
  },

  // ==========================================
  // Recommendations API
  // ==========================================
  async getRecommendations(): Promise<{
    hero?: Show | null;
    rails: Array<{
      id: string;
      title: string;
      subtitle?: string;
      reason?: string;
      shows: Show[];
    }>;
  }> {
    return request<{
      hero?: Show | null;
      rails: Array<{
        id: string;
        title: string;
        subtitle?: string;
        reason?: string;
        shows: Show[];
      }>;
    }>("/api/recommendations");
  },
};

