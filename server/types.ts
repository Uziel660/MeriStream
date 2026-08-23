export type ContentKind = "movie" | "series" | "anime" | "documentary" | "open_archive";

export interface ExtractedEpisode {
  number: number;
  title: string;
  url: string;
  source_type?: string;
  server_name?: string;
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
