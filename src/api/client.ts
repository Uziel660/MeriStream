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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (err) {
    const apiErr: ApiError = { status: 0, message: "No se pudo conectar con el servidor. Verifica tu conexión." };
    throw apiErr;
  }

  if (!res.ok) {
    let message = `Error ${res.status}`;
    try {
      const body = await res.json();
      message = body.detail ?? body.message ?? message;
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

  async getEpisodeStream(episodeId: string): Promise<PlayStreamResponse> {
    const data = await request<any>(`/play/${encodeURIComponent(episodeId)}`);
    return {
      episode_id: data.episode_id,
      stream_url: data.stream_url,
      title: data.title,
      all_available_streams: Array.isArray(data.all_available_streams) ? data.all_available_streams : [data.stream_url],
    };
  },

  async getPresets(): Promise<any[]> {
    return request<any[]>(`/scraper/presets`);
  },

  async analyzeUniversal(url: string): Promise<any> {
    return request<any>(`/catalog/analyze`, {
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
};
