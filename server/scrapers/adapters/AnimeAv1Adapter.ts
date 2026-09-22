import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import type { ExtractedCatalogItem, ExtractedEpisode, SourceLinkInput, UniversalAnalysisResult } from "../../types";
import { enrichUniversalMetadata } from "../../metadataEngine";
import { EmbedResolvers } from "../../resolvers";

const BASE_URL = "https://animeav1.com";
const CDN_BASE = "https://cdn.animeav1.com";

interface AnimeAv1Mirror {
  server?: string;
  url?: string;
}

interface AnimeAv1EpisodePayload {
  episode?: {
    id?: number;
    number?: number;
    title?: string | null;
    season?: number | null;
    variants?: { SUB?: number; DUB?: number };
  };
  embeds?: {
    SUB?: AnimeAv1Mirror[];
    DUB?: AnimeAv1Mirror[];
  };
}

export class AnimeAv1Adapter extends BaseScraperAdapter {
  readonly id = "animeav1";
  readonly name = "AnimeAV1 (Anime Español)";
  readonly supportedDomains = ["animeav1.com"];

  canHandle(url: string): boolean {
    const host = this.hostOf(url).toLowerCase().replace(/^www\./, "");
    return host === "animeav1.com";
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const clean = input.trim();
    const parsed = this.tryUrl(clean);
    if (!parsed) {
      const item = await this.search(clean);
      return {
        page_type: "catalog",
        content_type: "anime",
        title: `Resultados AnimeAV1 para ${clean}`,
        description: "Resultados del catálogo AnimeAV1.",
        poster_url: item[0]?.image_url || null,
        banner_url: item[0]?.image_url || null,
        rating: 0,
        year: 0,
        status: "Catálogo",
        genres: ["Anime"],
        source_domain: "animeav1.com",
        episodes: [],
        catalog_items: item,
      };
    }

    if (explicitType === "catalog" || parsed.pathname.startsWith("/catalogo")) {
      return this.analyzeCatalog(parsed.toString());
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "media" && parts.length >= 3 && /^\d+(?:\.\d+)?$/.test(parts[2])) {
      const ep = await this.getEpisode(parts[1], Number(parts[2]));
      const sources = this.sourcesFromEpisode(ep);
      return {
        page_type: "detail",
        content_type: "anime",
        title: ep?.episode?.title || `Episodio ${parts[2]}`,
        description: "Episodio de AnimeAV1.",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Publicado",
        genres: ["Anime"],
        source_domain: "animeav1.com",
        detected_streams: sources.map((s) => s.url),
        episodes: [{ number: Number(parts[2]), title: ep?.episode?.title || `Episodio ${parts[2]}`, url: clean, sources }],
        catalog_items: [],
      };
    }

    if (parts[0] === "media" && parts[1]) {
      return this.analyzeAnime(parts[1]);
    }

    return this.analyzeCatalog(`${BASE_URL}/catalogo`);
  }

  async extractStream(url: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const parsed = this.tryUrl(url);
    if (!parsed) return { stream_url: "", all_available_streams: [] };
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "media" || parts.length < 3) {
      return { stream_url: "", all_available_streams: [] };
    }
    const episodeNumber = Number(parts[2]);
    if (!Number.isFinite(episodeNumber)) return { stream_url: "", all_available_streams: [] };

    const payload = await this.getEpisode(parts[1], episodeNumber);
    const sources = this.sourcesFromEpisode(payload);
    const playable = await this.resolvePlayableSources(sources);

    return {
      stream_url: playable[0] || "",
      all_available_streams: playable,
      title: payload?.episode?.title || undefined,
    };
  }

  private async analyzeCatalog(url: string): Promise<UniversalAnalysisResult> {
    const html = await this.fetchHtml(url, 9000);
    const items = html ? this.extractCatalogItems(html) : [];
    return {
      page_type: "catalog",
      content_type: "anime",
      title: "AnimeAV1 Catálogo",
      description: "Anime con foco en japonés subtitulado al español y variantes en español cuando están disponibles.",
      poster_url: items[0]?.image_url || null,
      banner_url: items[0]?.image_url || null,
      rating: 0,
      year: 0,
      status: "Catálogo",
      genres: ["Anime"],
      source_domain: "animeav1.com",
      episodes: [],
      catalog_items: items,
    };
  }

  private async analyzeAnime(slug: string): Promise<UniversalAnalysisResult> {
    const url = `${BASE_URL}/media/${slug}`;
    const html = await this.fetchHtml(url, 9000);
    if (!html) throw new Error(`FETCH_FAILED: ${url}`);
    const media = this.extractSvelteData(html)?.media || null;
    const title = String(media?.title || media?.aka?.["en-us"] || slug.replace(/-/g, " ")).trim();
    const enriched = await enrichUniversalMetadata(title, "anime");
    const episodes: ExtractedEpisode[] = Array.isArray(media?.episodes)
      ? media.episodes
          .map((ep: any) => Number(ep?.number))
          .filter((n: number) => Number.isFinite(n) && n > 0)
          .map((n: number) => ({ number: n, title: `Episodio ${n}`, url: `${BASE_URL}/media/${slug}/${n}` }))
      : [];

    const malId = Number(media?.malId);
    const rawMetadata: any = {
      animeav1_id: media?.id ?? null,
      mal_id: Number.isFinite(malId) && malId > 0 ? malId : null,
      relations: media?.relations || [],
      variants: "SUB/DUB",
    };

    return {
      page_type: "detail",
      content_type: "anime",
      title: enriched.title || title,
      original_title: enriched.original_title || media?.aka?.["ja-jp"] || null,
      japanese_title: enriched.japanese_title || media?.aka?.["ja-jp"] || null,
      english_title: enriched.english_title || media?.aka?.["en-us"] || null,
      tmdb_id: enriched.tmdb_id ?? null,
      description: this.cleanSynopsis(media?.synopsis) || enriched.description || "",
      poster_url: media?.id ? `${CDN_BASE}/covers/${media.id}.jpg` : enriched.poster_url,
      banner_url: media?.id ? `${CDN_BASE}/backdrops/${media.id}.jpg` : enriched.banner_url,
      rating: Number(media?.score || enriched.rating || 0),
      year: this.yearOf(media?.startDate) || enriched.year || 0,
      status: this.statusOf(media?.statusText ?? media?.status) || enriched.status || "Publicado",
      genres: Array.isArray(media?.genres) && media.genres.length
        ? media.genres.map((g: any) => String(g?.name || "")).filter(Boolean)
        : enriched.genres,
      source_domain: "animeav1.com",
      detected_streams: [],
      episodes,
      catalog_items: [],
      raw_metadata: rawMetadata,
    };
  }

  private async search(query: string): Promise<ExtractedCatalogItem[]> {
    const html = await this.fetchHtml(`${BASE_URL}/catalogo?search=${encodeURIComponent(query)}`, 9000);
    return html ? this.extractCatalogItems(html) : [];
  }

  private extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const fromData = this.extractSvelteData(html)?.results;
    if (Array.isArray(fromData) && fromData.length > 0) {
      return fromData
        .map((item: any) => ({
          title: String(item?.title || "").trim(),
          url: item?.slug ? `${BASE_URL}/media/${item.slug}` : "",
          image_url: item?.id ? `${CDN_BASE}/covers/${item.id}.jpg` : null,
          kind: "anime" as const,
        }))
        .filter((item: ExtractedCatalogItem) => Boolean(item.title && item.url));
    }

    const $ = cheerio.load(html);
    const out: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();
    $('a[href^="/media/"]').each((_, el) => {
      const href = $(el).attr("href") || "";
      const slug = href.split("/").filter(Boolean)[1] || "";
      if (!slug || seen.has(slug)) return;
      const card = $(el).closest("article");
      const title = card.find("h3").first().text().trim() || $(el).attr("title") || slug.replace(/-/g, " ");
      const image = card.find("img").first().attr("src") || null;
      seen.add(slug);
      out.push({ title, url: `${BASE_URL}/media/${slug}`, image_url: image, kind: "anime" });
    });
    return out;
  }

  private async getEpisode(slug: string, episodeNumber: number): Promise<AnimeAv1EpisodePayload | null> {
    const html = await this.fetchHtml(`${BASE_URL}/media/${slug}/${episodeNumber}`, 9000);
    if (!html) return null;
    const data = this.extractAllSvelteSlots(html);
    for (const slot of data) {
      if (slot?.data?.episode) {
        return {
          episode: slot.data.episode,
          embeds: slot.data.embeds || { SUB: [], DUB: [] },
        };
      }
    }
    return null;
  }

  private sourcesFromEpisode(payload: AnimeAv1EpisodePayload | null): SourceLinkInput[] {
    if (!payload?.embeds) return [];
    const out: SourceLinkInput[] = [];
    const seen = new Set<string>();

    const push = (raw: AnimeAv1Mirror, variant: "SUB" | "DUB") => {
      const url = this.resolveKnownDirect(String(raw?.url || "").trim());
      if (!url) return;

      const audioLanguage = variant === "SUB" ? "ja" : "es";
      const subtitleLanguage = variant === "SUB" ? "es" : undefined;
      const identity = `${url}|${audioLanguage}|${subtitleLanguage || ""}`;
      if (seen.has(identity)) return;
      seen.add(identity);

      out.push({
        url,
        source_site: "animeav1",
        link_type: EmbedResolvers.isDirectMediaUrl(url) ? "direct" : "embed",
        language: variant === "SUB" ? "sub" : "dub",
        audio_language: audioLanguage,
        subtitle_language: subtitleLanguage,
      });
    };

    for (const source of payload.embeds.SUB || []) push(source, "SUB");
    for (const source of payload.embeds.DUB || []) push(source, "DUB");
    return out;
  }

  private async resolvePlayableSources(sources: SourceLinkInput[]): Promise<string[]> {
    const resolved = await Promise.all(
      sources.map(async (source) => {
        const raw = String(source?.url || "").trim();
        if (!raw) return "";
        if (EmbedResolvers.isDirectMediaUrl(raw)) return raw;
        try {
          const candidate = await EmbedResolvers.resolve(raw);
          return EmbedResolvers.isDirectMediaUrl(candidate) ? candidate : "";
        } catch {
          return "";
        }
      })
    );

    return Array.from(new Set(resolved.filter(Boolean)));
  }

  /** Known AnimeAV1 player locator that maps 1:1 to its public HLS route. */
  private resolveKnownDirect(url: string): string {
    const match = url.match(/^https?:\/\/player\.zilla-networks\.com\/play\/([a-f0-9]{32})\/?$/i);
    return match ? `https://player.zilla-networks.com/m3u8/${match[1]}` : url;
  }

  private extractSvelteData(html: string): any {
    const slots = this.extractAllSvelteSlots(html);
    for (const slot of slots) {
      if (slot?.data?.media || slot?.data?.results) return slot.data;
    }
    return null;
  }

  private extractAllSvelteSlots(html: string): any[] {
    const marker = html.indexOf("kit.start");
    const dataIdx = marker >= 0 ? html.indexOf("data: [", marker) : -1;
    if (dataIdx < 0) return [];
    const arrayStart = dataIdx + 6;
    let depth = 0;
    let arrayEnd = -1;
    let quote = "";
    let escaped = false;
    for (let i = arrayStart; i < html.length; i++) {
      const ch = html[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "[") depth++;
      else if (ch === "]") {
        depth--;
        if (depth === 0) {
          arrayEnd = i;
          break;
        }
      }
    }
    if (arrayEnd < 0) return [];
    const js = html.slice(arrayStart, arrayEnd + 1)
      .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
      .replace(/,"form":null/g, "")
      .replace(/,"error":null/g, "")
      .replace(/void 0/g, "null");
    try {
      return JSON.parse(js);
    } catch {
      return [];
    }
  }

  private tryUrl(value: string): URL | null {
    try { return new URL(value); } catch { return null; }
  }

  private hostOf(value: string): string {
    try { return new URL(value).hostname; } catch { return value; }
  }

  private cleanSynopsis(value: unknown): string {
    return String(value || "")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private yearOf(value: unknown): number {
    const year = Number.parseInt(String(value || "").slice(0, 4), 10);
    return Number.isFinite(year) ? year : 0;
  }

  private statusOf(value: unknown): string {
    if (typeof value === "number") {
      if (value === 0) return "Finalizado";
      if (value === 1) return "Próximamente";
      if (value === 2) return "En emisión";
    }
    const raw = String(value || "").toLowerCase();
    if (raw === "0" || raw === "finished") return "Finalizado";
    if (raw === "1" || raw === "upcoming") return "Próximamente";
    if (raw === "2" || raw === "airing") return "En emisión";
    return "";
  }
}
