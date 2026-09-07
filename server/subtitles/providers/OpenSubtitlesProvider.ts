import type { SubtitleCandidate, SubtitleProvider, SubtitleSearchRequest } from "../types";
import { normalizeSubtitleLanguage, subtitleLanguageLabel } from "../SubtitleNormalizer";

type RawSubtitle = {
  id?: string | number;
  url?: string;
  lang?: string;
  SubFormat?: string;
  fpsMilli?: number;
  subtitleFileName?: string;
  movieReleaseName?: string;
  releaseGroup?: string;
  releaseFormat?: string;
  m?: string;
};

const DEFAULT_ENDPOINTS = [
  "https://opensubtitles-v3.strem.io",
  "https://opensubtitles.stremio.homes",
  "https://opensubtitles.strem.io",
];

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly id = "opensubtitles-v3";
  readonly kinds = ["movie", "series", "anime"] as const;
  private readonly endpoints: string[];

  constructor(
    endpoints = String(process.env.OPENSUBTITLES_V3_ENDPOINTS || DEFAULT_ENDPOINTS.join(","))
      .split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean),
    private readonly timeoutMs = Math.max(1_000, Number(process.env.OPENSUBTITLES_V3_TIMEOUT_MS || 7_000)),
  ) {
    this.endpoints = endpoints;
  }

  async search(request: SubtitleSearchRequest): Promise<SubtitleCandidate[]> {
    const imdbId = request.imdbId && /^tt\d+$/i.test(request.imdbId) ? request.imdbId.toLowerCase() : "";
    if (!imdbId) return [];
    const isEpisode = request.season != null && request.episode != null;
    const type = isEpisode || request.kind !== "movie" ? "series" : "movie";
    const id = isEpisode
      ? `${imdbId}:${Math.max(1, request.season || 1)}:${Math.max(1, request.episode || 1)}`
      : imdbId;

    for (const endpoint of this.endpoints) {
      const list = await this.fetchEndpoint(`${endpoint}/subtitles/${type}/${id}.json`);
      if (list.length > 0) return list.map((entry, index) => this.toCandidate(entry, index));
    }
    return [];
  }

  private async fetchEndpoint(url: string): Promise<RawSubtitle[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "MeriStream/1.0" }, signal: controller.signal });
      if (!response.ok) return [];
      const body = await response.json().catch(() => null) as { subtitles?: RawSubtitle[] } | null;
      return Array.isArray(body?.subtitles) ? body.subtitles.filter((entry) => /^https:\/\//i.test(String(entry?.url || ""))) : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toCandidate(entry: RawSubtitle, index: number): SubtitleCandidate {
    const language = normalizeSubtitleLanguage(entry.lang) || "en";
    const release = [entry.movieReleaseName, entry.releaseGroup, entry.releaseFormat].filter(Boolean).join(" ") || null;
    const fileName = entry.subtitleFileName || null;
    return {
      id: `opensubtitles-v3:${String(entry.id || index)}:${language}`,
      provider: this.id,
      language,
      label: `${subtitleLanguageLabel(language)}${release ? ` · ${release}` : ""}`,
      sourceUrl: String(entry.url),
      format: String(entry.SubFormat || fileName || "srt").toLowerCase() as SubtitleCandidate["format"],
      fileName,
      release,
      fps: entry.fpsMilli ? entry.fpsMilli / 1000 : null,
      hearingImpaired: /\b(?:hi|hearing)\b/i.test(`${entry.m || ""} ${fileName || ""}`),
    };
  }
}
