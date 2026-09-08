export type SubtitleKind = "movie" | "series" | "anime";

export interface SubtitleSearchRequest {
  tmdbId: number;
  kind: SubtitleKind;
  season?: number;
  episode?: number;
  imdbId?: string | null;
  preferredLanguages?: string[];
  title?: string | null;
  titleAliases?: string[];
  year?: number | null;
}

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa" | "unknown";

export interface SubtitleCandidate {
  id: string;
  provider: string;
  language: string;
  label: string;
  sourceUrl: string;
  format?: SubtitleFormat;
  fileName?: string | null;
  hearingImpaired?: boolean;
  forced?: boolean;
  release?: string | null;
  fps?: number | null;
  score?: number;
  sourceHeaders?: Record<string, string>;
}

export interface SubtitleProvider {
  readonly id: string;
  readonly kinds: readonly SubtitleKind[];
  search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]>;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language: string;
  url: string;
  is_default: boolean;
  provider?: string;
}

export interface SubtitleProviderFailure {
  provider: string;
  reason: string;
}

export interface SubtitleGatewayResult {
  subtitles: SubtitleTrack[];
  /** Compatibility alias consumed by the existing player bootstrap. */
  tracks: SubtitleTrack[];
  providers: {
    queried: string[];
    failed: SubtitleProviderFailure[];
  };
  elapsedMs: number;
  cached: boolean;
}
