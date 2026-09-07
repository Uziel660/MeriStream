import { BaseScraperAdapter } from "../BaseAdapter";
import { EmbedResolvers } from "../../resolvers";
import { resolveZokoAnime } from "../../resolvers/zokoanimeResolver";
import {
  episodeLinks,
  fetchHianimesAnime,
  fetchHianimesEpisode,
  fetchHianimesFilter,
  hianimesSlugFromUrl,
  isHianimesUrl,
  isHianimesWatchUrl,
  HianimesAnimeRecord,
  HianimesEpisodeRecord,
} from "../../resolvers/hianimesResolver";
import { UniversalAnalysisResult, ExtractedCatalogItem, ExtractedEpisode } from "../../types";
import { classifySourceKind } from "../../resolutionMetadata";

const BASE_URL = "https://hianimes.se";
const PAGE_SIZE = 20;

function emptyResult(contentType: "anime" | "movie" = "anime"): UniversalAnalysisResult {
  return {
    page_type: "detail",
    content_type: contentType,
    title: "",
    description: "",
    poster_url: null,
    banner_url: null,
    rating: 0,
    year: 0,
    status: "",
    genres: [],
    episodes: [],
    catalog_items: [],
  };
}

export class HiAnimesAdapter extends BaseScraperAdapter {
  readonly id = "hianimes";
  readonly name = "HiAnimes (API multi-host)";
  readonly supportedDomains = ["hianimes.se"];

  canHandle(url: string): boolean {
    return isHianimesUrl(url);
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const url = input.trim();
    if (explicitType === "stream" || isHianimesWatchUrl(url)) return this.analyzeWatch(url);
    if (explicitType === "catalog" || this.isCatalogUrl(url)) return this.analyzeCatalog(url);
    return this.analyzeDetail(url);
  }

  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const slug = hianimesSlugFromUrl(targetUrl);
    if (!slug) return { stream_url: "", all_available_streams: [] };
    const { anime, episode } = await fetchHianimesEpisode(slug);
    if (!episode) return { stream_url: "", all_available_streams: [], title: anime?.title };

    const candidates: string[] = [];
    for (const link of episodeLinks(episode)) {
      const resolved = await this.resolveCandidate(link.url);
      if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
      const isDirect = /\.(m3u8|mp4|webm)(\?|#|$)/i.test(resolved);
      if (!isDirect && !candidates.includes(link.url)) candidates.push(link.url);
    }
    const directMedia = candidates.filter((u) => /\.(m3u8|mp4|webm)(\?|#|$)/i.test(u));
    const backupEmbeds = candidates.filter((u) => !directMedia.includes(u));
    const topStreams: string[] = [];
    if (directMedia.length > 0) {
      topStreams.push(directMedia[0]);
      if (backupEmbeds.length > 0) {
        topStreams.push(backupEmbeds[0]);
      } else if (directMedia.length > 1) {
        topStreams.push(directMedia[1]);
      }
    } else {
      topStreams.push(...backupEmbeds.slice(0, 2));
    }
    const resultStreams = topStreams.length > 0 ? topStreams : candidates.slice(0, 2);
    return {
      stream_url: resultStreams[0] || "",
      all_available_streams: resultStreams,
      title: episode.title || anime?.title,
    };
  }

  private async analyzeCatalog(url: string): Promise<UniversalAnalysisResult> {
    const parsed = new URL(url);
    const pageRaw = Number.parseInt(parsed.searchParams.get("page") || "1", 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const type = this.catalogType(parsed.searchParams.get("type"));
    const response = await fetchHianimesFilter(page, PAGE_SIZE, type);
    if (!response) throw new Error(`FETCH_FAILED: ${url}`);

    const items = response.results.flatMap((raw) => {
      const anime = this.normalizeCatalogRecord(raw);
      return anime ? [anime] : [];
    });
    const nextPage = page < response.totalPages
      ? `${BASE_URL}/filter?type=${encodeURIComponent(type)}&page=${page + 1}`
      : null;
    return {
      page_type: "catalog",
      content_type: type === "Movie" ? "movie" : "anime",
      title: `Catálogo ${type === "Movie" ? "de películas" : "de anime"} - HiAnimes`,
      description: "Catálogo paginado de HiAnimes mediante su API pública.",
      poster_url: null,
      banner_url: null,
      rating: 0,
      year: 0,
      status: "",
      genres: [],
      episodes: [],
      catalog_items: items,
      next_page_url: nextPage,
    };
  }

  private async analyzeDetail(url: string): Promise<UniversalAnalysisResult> {
    const slug = this.detailSlug(url);
    if (!slug) return emptyResult();
    const anime = await fetchHianimesAnime(slug);
    if (!anime) return emptyResult();
    return this.detailResult(anime);
  }

  private async analyzeWatch(url: string): Promise<UniversalAnalysisResult> {
    const slug = hianimesSlugFromUrl(url);
    if (!slug) return emptyResult();
    const { anime, episode } = await fetchHianimesEpisode(slug);
    if (!episode) return emptyResult(anime?.type?.toLowerCase() === "movie" ? "movie" : "anime");
    const resolved = await this.extractStream(url);
    const sourceEpisodes: ExtractedEpisode = {
      number: episode.episodeNumber,
      title: episode.title,
      url,
      source_type: "hianimes",
      server_name: "HiAnimes",
      sources: episodeLinks(episode).map((link) => ({
        url: link.url,
        source_site: this.hostOf(link.url),
        link_type: classifySourceKind(link.url) === "embed" ? "embed" : classifySourceKind(link.url) === "page" ? "page" : "direct",
        language: link.language,
        ...(link.language === "sub"
          ? { audio_language: "ja", subtitle_language: "en" }
          : { audio_language: "en" }),
        host: this.hostOf(link.url),
        // Resolver la variante primaria no acredita automáticamente todos los
        // hosts sub/dub; cada SourceLink se verifica de forma independiente en
        // la recuperación/JIT.
        is_verified: false,
      })),
    };
    return {
      page_type: "direct_stream",
      content_type: anime?.type?.toLowerCase() === "movie" ? "movie" : "anime",
      title: anime?.title || episode.title,
      mal_id: anime?.mal_id || null,
      anilist_id: anime?.anilist_id || null,
      kitsu_id: anime?.kitsu_id || null,
      description: anime?.synopsis || "",
      poster_url: anime?.image || null,
      banner_url: anime?.landscapeImage || null,
      rating: this.numeric(anime?.score),
      year: this.year(anime?.aired),
      status: anime?.status || "",
      genres: anime?.genres || [],
      detected_streams: resolved.all_available_streams,
      episodes: [sourceEpisodes],
      catalog_items: [],
    };
  }

  private detailResult(anime: HianimesAnimeRecord): UniversalAnalysisResult {
    const episodes = anime.episodes.map((episode) => this.episodeToExtracted(episode));
    const isMovie = (anime.type || "").toLowerCase() === "movie";
    return {
      page_type: "detail",
      content_type: isMovie ? "movie" : "anime",
      title: anime.title,
      mal_id: anime.mal_id || null,
      anilist_id: anime.anilist_id || null,
      kitsu_id: anime.kitsu_id || null,
      original_title: anime.englishTitle || anime.japaneseTitle || null,
      japanese_title: anime.japaneseTitle || null,
      english_title: anime.englishTitle || null,
      description: anime.synopsis || "",
      poster_url: anime.image || null,
      banner_url: anime.landscapeImage || null,
      rating: this.numeric(anime.score),
      year: this.year(anime.aired),
      status: anime.status || "",
      genres: anime.genres,
      episodes,
      catalog_items: [],
    };
  }

  private episodeToExtracted(episode: HianimesEpisodeRecord): ExtractedEpisode {
    return {
      number: episode.episodeNumber,
      title: episode.title,
      url: `${BASE_URL}/watch/${encodeURIComponent(episode.slug)}`,
      source_type: "hianimes",
      server_name: "HiAnimes",
      sources: episodeLinks(episode).map((link) => ({
        url: link.url,
        source_site: this.hostOf(link.url),
        link_type: classifySourceKind(link.url) === "embed" ? "embed" : classifySourceKind(link.url) === "page" ? "page" : "direct",
        language: link.language,
        ...(link.language === "sub"
          ? { audio_language: "ja", subtitle_language: "en" }
          : { audio_language: "en" }),
        host: this.hostOf(link.url),
        is_verified: false,
      })),
    };
  }

  private async resolveCandidate(url: string): Promise<string> {
    if (url.includes("zokoanime.video")) {
      const zoko = await resolveZokoAnime(url);
      return zoko.url || url;
    }
    const resolved = await EmbedResolvers.resolve(url);
    return resolved || url;
  }

  private isCatalogUrl(url: string): boolean {
    try {
      return new URL(url).pathname.toLowerCase().startsWith("/filter");
    } catch {
      return false;
    }
  }

  private detailSlug(url: string): string | undefined {
    try {
      const parts = new URL(url).pathname.split("/").filter(Boolean);
      const index = parts.findIndex((part) => part.toLowerCase() === "details" || part.toLowerCase() === "anime");
      return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : undefined;
    } catch {
      return undefined;
    }
  }

  private catalogType(value: string | null): string {
    const normalized = (value || "All").trim().toLowerCase();
    if (normalized === "movie" || normalized === "movies") return "Movie";
    if (normalized === "tv" || normalized === "series") return "TV";
    return "All";
  }

  private normalizeCatalogRecord(raw: Record<string, unknown>): ExtractedCatalogItem | null {
    const title = this.firstString(raw.title, raw.English, raw.Japanese, raw.slug);
    const slug = this.firstString(raw.slug, Array.isArray(raw.slugs) ? raw.slugs[0] : undefined);
    if (!title || !slug) return null;
    const type = this.firstString(raw.Type).toLowerCase();
    return {
      title,
      url: `${BASE_URL}/details/${encodeURIComponent(slug)}`,
      image_url: this.firstString(raw.image, raw.landScapeImage) || null,
      kind: type === "movie" ? "movie" : "anime",
      year: this.year(this.firstString(raw.Aired)),
      rating: this.numeric(this.firstString(raw.Score)),
      genres: Array.isArray(raw.genres) ? raw.genres.filter((genre): genre is string => typeof genre === "string") : [],
    };
  }

  private firstString(...values: unknown[]): string {
    return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || "";
  }

  private numeric(value?: string): number {
    const parsed = Number.parseFloat(value || "");
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private year(value?: string): number {
    const match = value?.match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : 0;
  }

  private hostOf(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "hianimes.se"; }
  }
}
