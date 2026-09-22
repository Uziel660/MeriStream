export type ContentKind = "movie" | "series" | "anime" | "documentary" | "open_archive";

export interface ExtractedEpisode {
  number: number;
  /** Temporada de origen cuando la ficha expone series multi-temporada. */
  season?: number;
  title: string;
  url: string;
  source_type?: string;
  server_name?: string;
  /** All provider candidates found for this episode; url remains the primary. */
  sources?: Array<{
    url: string;
    source_site?: string;
    link_type?: string;
    host?: string;
    is_verified?: boolean;
    language?: string;
    audio_language?: string;
    subtitle_language?: string;
    subtitles?: Array<{ id?: string; label?: string; language?: string; src: string; is_default?: boolean }>;
  }>;
}

export interface ExtractedCatalogItem {
  title: string;
  url: string;
  image_url?: string | null;
  kind?: ContentKind;
  year?: number | null;
  rating?: number | null;
  genres?: string[];
}

export interface UniversalAnalysisResult {
  page_type: "detail" | "catalog" | "direct_stream" | "embed";
  content_type: ContentKind;
  title: string;
  original_title?: string | null;
  mal_id?: number | null;
  anilist_id?: number | null;
  kitsu_id?: string | null;
  anidb_id?: string | null;
  tmdb_id?: number | null;
  /** Identificador IMDb cuando TMDB lo expone; se usa para matching externo. */
  imdb_id?: string | null;
  tvdb_id?: number | null;
  japanese_title?: string | null;
  english_title?: string | null;
  description: string;
  poster_url: string | null;
  banner_url: string | null;
  rating: number;
  year: number;
  status: string;
  genres: string[];
  duration?: string | null;
  source_domain?: string;
  detected_streams?: string[];
  episodes: ExtractedEpisode[];
  catalog_items: ExtractedCatalogItem[];
  next_page_url?: string | null;
  raw_metadata?: {
    og?: Record<string, string>;
    json_ld?: any[];
    embeds?: string[];
  };
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

export interface SourceLinkInput {
  url: string;
  source_site?: string;
  link_type?: string;
  host?: string;
  source_kind?: SourceKind;
  is_verified?: boolean;
  /** Optional rendition metadata; persisted in nullable SourceLink columns. */
  language?: string;
  audio_language?: string;
  subtitle_language?: string;
  subtitles?: Array<{ id?: string; label?: string; language?: string; src: string; is_default?: boolean }>;
  main_path_override?: boolean | null;
}

export type SourceKind = "page" | "embed" | "stable_direct" | "ephemeral_direct";

export interface CanonicalSourceInput {
  url: string;
  source_site: string;
  source_kind: SourceKind;
}

export interface PlaybackResolution {
  url: string;
  original_url: string;
  canonical_locator?: string;
  resolved: boolean;
  type: "direct" | "embed";
  delivery_mode: "direct" | "direct_trial" | "proxy_required" | "embed";
  is_proxyable: boolean;
  is_refreshable: boolean;
  resolved_at?: number;
  refresh_after?: number;
  expires_at?: number;
  resolution_id?: string;
  generation?: string;
  requiredHeaders?: Record<string, string>;
  failure_reason?:
    | "expired_without_locator"
    | "unresolved"
    | "unsafe_url"
    | "empty_locator"
    | "provider_blocked"
    | "drm_or_captcha";
}
