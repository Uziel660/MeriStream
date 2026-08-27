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

function inferProtocolFromUrl(url?: string | null): "hls" | "mp4" {
  if (!url) return "mp4";
  const normalized = url.toLowerCase();
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

export const api = {
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
  }> {
    return request<any>(`/catalog/episode-servers`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
  },

  async resolveEmbed(url: string): Promise<{
    url: string;
    original_url: string;
    resolved: boolean;
    type: "direct" | "embed";
    provider?: string;
    strategy?: string;
    /** Cabeceras que el CDN exige al consumir url (el proxy las inyecta server-side) */
    requiredHeaders?: Record<string, string>;
  }> {
    return request<any>(`/resolve-embed`, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
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

