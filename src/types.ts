// src/types.ts

export type StreamProtocol = "hls" | "mp4";

export interface Episode {
  id: string;
  show_id?: string;
  title: string;
  episode_number: number;
  source_url?: string;
  created_at?: string;
}

export interface Show {
  id: string;
  title: string;
  original_title?: string;
  japanese_title?: string;
  english_title?: string;
  overview?: string;
  description?: string;
  synopsis?: string;
  poster_url?: string | null;
  banner_url?: string | null;
  backdrop_url?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  category: string;
  kind?: string;
  genres?: string | string[];
  year?: number | null;
  release_year?: number | null;
  rating?: number;
  duration?: string;
  runtime_minutes?: number | null;
  quality?: string;
  is_trending?: boolean;
  is_featured?: boolean;
  status?: string;
  dominant_color_hex?: string;
  license?: string;
  created_at?: string;
  updated_at?: string;
  episode_count?: number;
  episodes?: Episode[];
  sources?: {
    master_m3u8: string;
    fallback_mp4?: string | null;
    qualities: any[];
    subtitles: any[];
  };
}

export type MediaItemOut = Show;
export type MediaItem = Show;

export interface ShowDetail extends Show {
  episodes: Episode[];
}

/** Stream ordenado por la jerarquía de tiers del backend (ranked_streams). */
export interface RankedStream {
  url: string;
  type: "direct" | "embed";
  tier: number;
  host: string | null;
  source_site?: string;
  rating?: number;
  /** Provider-declared rendition label (sub/dub/audio). */
  link_type?: string;
  language?: string;
  audio_language?: string;
  subtitle_language?: string;
  subtitles?: SubtitleTrack[];
}

export interface PlayStreamResponse {
  episode_id: string;
  stream_url: string;
  title: string;
  all_available_streams: string[];
  ranked_streams?: RankedStream[];
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  url: string;
  is_default: boolean;
}

export interface MediaStreamVariant {
  id: string;
  protocol: StreamProtocol;
  url: string;
  resolution_label: string | null;
  bandwidth: number | null;
  is_default: boolean;
}

export interface MediaStreamOut {
  media_id: string;
  title: string;
  protocol: StreamProtocol;
  variants: MediaStreamVariant[];
  subtitles: SubtitleTrack[];
  poster_url: string | null;
  /** Cabeceras que el CDN exige al consumir las variantes (ej. vimeos: Origin/Referer) */
  requiredHeaders?: Record<string, string>;
}

export interface MediaListResponse {
  items: MediaItemOut[];
  total: number;
  page: number;
  page_size: number;
}

export interface MediaSearchParams {
  page?: number;
  page_size?: number;
  search?: string;
  category?: string;
  [key: string]: any;
}

export interface ExtractRequest {
  url: string;
  headless?: boolean;
}

export interface ExtractResponse {
  status: string;
  title: string | null;
  detected_stream_url: string | null;
  protocol: StreamProtocol;
  thumbnail_url: string | null;
  message: string;
}

export interface DiscoverRequest {
  url: string;
  max_pages?: number;
}

export interface DiscoverResponse {
  task_id: string;
  status: string;
  message: string;
}

export interface TaskOut {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  updated_at: string;
  progress: {
    pages_scanned: number;
    pages_total?: number;
    videos_imported: number;
    videos_skipped: number;
  };
  logs: string[];
  error_message: string | null;
  result_media_ids: string[];
}

export interface ScraperPreset {
  id: string;
  name: string;
  category: "anime" | "movies" | "series" | "archive" | "direct";
  description: string;
  example_url: string;
  icon: string;
  original_url?: string;
  is_custom?: boolean;
}

export interface UniversalAnalysisResult {
  page_type: "detail" | "catalog" | "direct_stream" | "embed";
  content_type: string;
  title: string;
  original_title?: string | null;
  tmdb_id?: number | null;
  japanese_title?: string | null;
  english_title?: string | null;
  description: string;
  poster_url: string | null;
  banner_url: string | null;
  rating: number;
  year: number;
  status: string;
  genres: string[];
  source_domain?: string;
  detected_streams?: string[];
  episodes: Array<{
    number: number;
    title: string;
    url: string;
  }>;
  catalog_items: Array<{
    title: string;
    url: string;
    image_url?: string | null;
    kind?: string;
  }>;
  raw_metadata?: any;
}

export interface BackgroundWorkerJob {
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
  current_item_title?: string;
  items_queue: Array<{
    title: string;
    url: string;
    status: "pending" | "processing" | "done" | "error";
    error?: string;
  }>;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  logs: Array<{
    timestamp: string;
    level: "info" | "success" | "warn" | "error";
    message: string;
  }>;
}

export interface WorkerSettings {
  default_delay_ms: number;
  jitter_enabled: boolean;
  max_concurrent_jobs: number;
  user_agent_rotation: boolean;
}

export interface CrawlTaskResponse {
  task_id: string;
  name?: string;
  status: string;
  pages_crawled?: number;
  shows_imported?: number;
  episodes_imported?: number;
  total_discovered?: number;
  current_item_title?: string;
  rate_limit_delay_ms?: number;
  items_queue?: Array<{
    title: string;
    url: string;
    status: "pending" | "processing" | "done" | "error";
    error?: string;
  }>;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
  logs?: string[];
  detailed_logs?: Array<{
    timestamp: string;
    level: "info" | "success" | "warn" | "error";
    message: string;
  }>;
}

export interface ApiError {
  status: number;
  message: string;
}
