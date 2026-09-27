import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import type {
  ContentKind,
  ExtractedCatalogItem,
  ExtractedEpisode,
  UniversalAnalysisResult,
} from "../../types";
import { EmbedResolvers } from "../../resolvers";

const BASE_URL = "https://doramasia.com";
const SITE_HOST = "doramasia.com";
const GRAPHQL_URL = "https://userapi.cloudfleir.xyz/graphql";
const GRAPHQL_APP = "com.asiapp.doramasgo";
const CATALOG_PAGE_SIZE = 100;

const BLACKLISTED_SERVERS = /(?:voe|filemoon|mixdrop|vudeo)/i;
const BLACKLISTED_SERVER_IDS = new Set(["1230", "958695"]); // VOE / Filemoon in the live API
const SERVER_ORDER: Record<string, number> = {
  primeload: 1,
  "4721": 1,
  streamwish: 2,
  streamwishto: 2,
  "38585": 2,
  filemoon: 90,
  "958695": 90,
  voe: 95,
  "1230": 95,
};

type GraphqlPayload = { data?: Record<string, any>; errors?: unknown[] };

/**
 * Doramasia is the Doramasgo frontend branded for doramasia.com. Its public
 * GraphQL API is the stable catalog/episode source; the signed embedshortener
 * URLs are intentionally resolved only at playback time.
 */
export class DoramasiaAdapter extends BaseScraperAdapter {
  readonly id = "doramasia";
  readonly name = "Doramasia (doramas asiáticos con subtítulos en español)";
  readonly supportedDomains = [SITE_HOST];

  canHandle(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return host === SITE_HOST || host.endsWith(`.${SITE_HOST}`);
    } catch {
      return false;
    }
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream",
  ): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    if (!/^https?:\/\//i.test(cleanUrl)) return this.emptyResult("detail", "series");

    let parsed: URL;
    try {
      parsed = new URL(cleanUrl);
    } catch {
      return this.emptyResult("detail", "series");
    }

    const path = parsed.pathname.toLowerCase();
    if (explicitType === "stream" || path.startsWith("/capitulos/")) {
      const stream = await this.extractStream(cleanUrl);
      return {
        ...this.emptyResult("direct_stream", path.startsWith("/peliculas/") ? "movie" : "series"),
        title: stream.title || this.titleFromUrl(cleanUrl),
        source_domain: SITE_HOST,
        detected_streams: stream.all_available_streams,
      };
    }

    if (explicitType === "catalog" || this.isCatalogPath(path)) {
      return this.extractCatalogResult(cleanUrl);
    }

    return this.extractDetail(cleanUrl);
  }

  public override async extractStream(targetUrl: string): Promise<{
    stream_url: string;
    all_available_streams: string[];
    title?: string;
  }> {
    const cleanUrl = targetUrl.trim();
    try {
      const parsed = new URL(cleanUrl);
      const path = parsed.pathname.toLowerCase();

      if (/\.(?:m3u8|mpd|mp4|webm|mkv)(?:[?#]|$)/i.test(cleanUrl)) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title: this.titleFromUrl(cleanUrl) };
      }

      if (path.startsWith("/capitulos/")) {
        const slug = this.lastPathPart(parsed.pathname);
        const episode = await this.fetchEpisodeBySlug(slug, cleanUrl);
        if (!episode?._id) return { stream_url: "", all_available_streams: [], title: episode?.name_es || episode?.name };
        const links = await this.fetchEpisodeLinks(String(episode._id), cleanUrl);
        const streams = await this.resolveLinks(links);
        return {
          stream_url: streams[0] || "",
          all_available_streams: streams,
          title: this.firstString(episode.name_es, episode.name) || this.titleFromUrl(cleanUrl),
        };
      }

      if (path.startsWith("/peliculas/")) {
        const slug = this.lastPathPart(parsed.pathname);
        const movie = await this.fetchMovieDetail(slug, cleanUrl);
        if (!movie?._id) return { stream_url: "", all_available_streams: [], title: movie?.name_es || movie?.name };
        const links = await this.fetchMovieLinks(String(movie._id), cleanUrl);
        const streams = await this.resolveLinks(links);
        return {
          stream_url: streams[0] || "",
          all_available_streams: streams,
          title: this.firstString(movie.name_es, movie.name) || this.titleFromUrl(cleanUrl),
        };
      }
    } catch {
      // A failed upstream request is represented as an empty JIT result. The
      // caller can then try the next provider without treating the page as a
      // playable stream.
    }
    return { stream_url: "", all_available_streams: [] };
  }

  private async extractCatalogResult(url: string): Promise<UniversalAnalysisResult> {
    const path = this.pathOf(url);
    const isMovie = path.includes("/peliculas");
    const items = await this.extractCatalog(url);
    const next = this.nextCatalogUrl(url, items.length);
    return {
      ...this.emptyResult("catalog", isMovie ? "movie" : "series"),
      title: `Catálogo ${isMovie ? "de películas" : "de doramas"} - Doramasia`,
      source_domain: SITE_HOST,
      description: "Catálogo GraphQL público de Doramasia.",
      catalog_items: items,
      next_page_url: next,
    };
  }

  private async extractCatalog(url: string): Promise<ExtractedCatalogItem[]> {
    const page = this.catalogPageNumber(url);
    const path = this.pathOf(url);
    const isMovie = path.includes("/peliculas");
    const isVariety = path.includes("/variedades");

    const query = isMovie
      ? `query PaginationMovie($page:Int!,$limit:Int!){ paginationMovie(page:$page,limit:$limit){ count pageInfo{currentPage pageCount hasNextPage} items{ _id slug name name_es poster_path poster backdrop_path backdrop release_date commingSoon } } }`
      : `query PaginationDorama($page:Int!,$limit:Int!,$filter:FilterDoramasInput){ paginationDorama(page:$page,limit:$limit,filter:$filter){ count pageInfo{currentPage pageCount hasNextPage} items{ _id slug name name_es isTVShow first_air_date poster_path poster backdrop_path backdrop number_of_episodes number_of_episodes_online } } }`;
    const variables = isMovie
      ? { page, limit: CATALOG_PAGE_SIZE }
      : { page, limit: CATALOG_PAGE_SIZE, ...(isVariety ? { filter: { isTVShow: true } } : {}) };
    const payload = await this.fetchGraphql(query, variables, url);
    const container = isMovie ? payload?.data?.paginationMovie : payload?.data?.paginationDorama;
    const rawItems = Array.isArray(container?.items) ? container.items : [];
    const prefix = isMovie ? "/peliculas/" : isVariety ? "/variedades/" : "/doramas/";
    const seen = new Set<string>();
    return rawItems.flatMap((raw: any) => {
      const slug = typeof raw?.slug === "string" ? raw.slug.trim() : "";
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      const poster = this.firstString(raw.poster, raw.poster_path, raw.backdrop, raw.backdrop_path);
      return [{
        title: this.firstString(raw.name_es, raw.name, slug),
        url: `${BASE_URL}${prefix}${encodeURIComponent(slug)}`,
        image_url: poster ? this.imageUrl(poster) : null,
        kind: isMovie ? "movie" as const : "series" as const,
        year: this.yearFromValue(raw.release_date ?? raw.first_air_date),
      }];
    });
  }

  private async extractDetail(url: string): Promise<UniversalAnalysisResult> {
    const path = this.pathOf(url);
    const isMovie = path.includes("/peliculas/");
    const slug = this.lastPathPart(path);
    if (!slug) return this.emptyResult("detail", isMovie ? "movie" : "series");

    if (isMovie) {
      const movie = await this.fetchMovieDetail(slug, url);
      if (!movie) return this.emptyResult("detail", "movie");
      return this.movieResult(movie, url);
    }

    const detail = await this.fetchDoramaDetail(slug, url);
    if (!detail) return this.emptyResult("detail", "series");
    const episodes = await this.fetchAllEpisodes(detail, url);
    return this.seriesResult(detail, episodes, url);
  }

  private async fetchDoramaDetail(slug: string, referer: string): Promise<any | null> {
    const query = `query DetailDorama($slug:String!){ detailDorama(filter:{slug:$slug}){ _id name name_es slug original_name overview isTVShow isFinish number_of_episodes_online first_air_date tmdb_id number_of_seasons number_of_episodes episode_time poster_path backdrop_path poster backdrop premiere country subtitles_available langs{_id name slug flag} genres{name slug} networks{name slug} seasons{ref slug season_number number_of_episodes} } }`;
    const payload = await this.fetchGraphql(query, { slug }, referer);
    return payload?.data?.detailDorama || null;
  }

  private async fetchMovieDetail(slug: string, referer: string): Promise<any | null> {
    const query = `query DetailMovie($slug:String!){ detailMovie(filter:{slug:$slug}){ _id name name_es slug overview release_date status status_source backdrop_path poster_path poster backdrop country subtitles_available langs{_id name slug flag} genres{name slug} } }`;
    const payload = await this.fetchGraphql(query, { slug }, referer);
    return payload?.data?.detailMovie || null;
  }

  private async fetchAllEpisodes(detail: any, referer: string): Promise<ExtractedEpisode[]> {
    const seasons = Array.isArray(detail?.seasons) && detail.seasons.length > 0
      ? detail.seasons
      : [{ season_number: 1 }];
    const all: ExtractedEpisode[] = [];
    for (const season of seasons) {
      const seasonNumber = Number(season?.season_number) || 1;
      const query = `query PaginationEpisode($serie:ID!,$season:Int!,$page:Int!,$limit:Int!){ paginationEpisode(page:$page,limit:$limit,sort:NUMBER_ASC,filter:{serie_id:$serie,season_number:$season}){ items{_id slug name name_es episode_number season_number date_string air_date count_links} pageInfo{pageCount hasNextPage} } }`;
      const first = await this.fetchGraphql(query, {
        serie: String(detail._id), season: seasonNumber, page: 1, limit: 100,
      }, referer);
      const container = first?.data?.paginationEpisode;
      const raw = Array.isArray(container?.items) ? [...container.items] : [];
      const pageCount = Math.max(1, Number(container?.pageInfo?.pageCount) || 1);
      for (let page = 2; page <= pageCount; page += 1) {
        const next = await this.fetchGraphql(query, {
          serie: String(detail._id), season: seasonNumber, page, limit: 100,
        }, referer);
        const nextItems = next?.data?.paginationEpisode?.items;
        if (Array.isArray(nextItems)) raw.push(...nextItems);
      }

      // Doramasia lists future episodes before publishing their links. They
      // must not enter the playable catalog: importing those locators makes
      // the UI spin forever until the upstream episode is released.
      const selected = raw.filter((item: any) => Number(item?.count_links) > 0);
      for (const item of selected) {
        const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
        const number = Number(item?.episode_number);
        if (!slug || !Number.isFinite(number) || number <= 0) continue;
        all.push({
          number: Math.trunc(number),
          season: seasonNumber,
          title: this.firstString(item.name_es, item.name, `Capítulo ${number}`),
          url: `${BASE_URL}/capitulos/${encodeURIComponent(slug)}`,
        });
      }
    }
    const seen = new Set<string>();
    return all
      .sort((a, b) => (a.season || 1) - (b.season || 1) || a.number - b.number)
      .filter((episode) => !seen.has(episode.url) && seen.add(episode.url));
  }

  private async fetchEpisodeBySlug(slug: string, referer: string): Promise<any | null> {
    if (!slug) return null;
    const query = `query DetailEpisode($slug:String!){ detailEpisode(filter:{slug:$slug}){ _id slug name name_es serie_id episode_number season_number } }`;
    const payload = await this.fetchGraphql(query, { slug }, referer);
    return payload?.data?.detailEpisode || null;
  }

  private async fetchEpisodeLinks(id: string, referer: string): Promise<any[]> {
    const query = `query EpisodeLinks($id:ID!){ getEpisodeLinks(id:$id,app:"${GRAPHQL_APP}"){ links_online{server lang link _id is_recommended subtitles{language_code type} } } }`;
    const payload = await this.fetchGraphql(query, { id }, referer);
    return Array.isArray(payload?.data?.getEpisodeLinks?.links_online) ? payload.data.getEpisodeLinks.links_online : [];
  }

  private async fetchMovieLinks(id: string, referer: string): Promise<any[]> {
    const query = `query MovieLinks($id:ID!){ getMovieLinks(id:$id,app:"${GRAPHQL_APP}"){ links_online{server lang link _id is_recommended subtitles{language_code type} } } }`;
    const payload = await this.fetchGraphql(query, { id }, referer);
    return Array.isArray(payload?.data?.getMovieLinks?.links_online) ? payload.data.getMovieLinks.links_online : [];
  }

  private async resolveLinks(rawLinks: any[]): Promise<string[]> {
    const ordered = rawLinks
      .filter((entry) => typeof entry?.link === "string"
        && !BLACKLISTED_SERVERS.test(String(entry.server || ""))
        && !BLACKLISTED_SERVERS.test(String(entry.link || ""))
        && !BLACKLISTED_SERVER_IDS.has(String(entry.server || "")))
      .sort((a, b) => Number(Boolean(b.is_recommended)) - Number(Boolean(a.is_recommended)) || this.serverPriority(a.server) - this.serverPriority(b.server));
    const locators = ordered.map((entry) => this.decodeEmbedShortenerLink(entry.link)).filter((value): value is string => Boolean(value));
    const unique = [...new Set(locators)];
    const resolved = await Promise.all(unique.map(async (locator) => {
      try {
        const meta = await Promise.race([
          EmbedResolvers.resolveWithMeta(locator),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("resolver timeout")), 6000)),
        ]);
        if (meta.resolved && meta.url && !BLACKLISTED_SERVERS.test(meta.url)) {
          if (!this.isDirectMediaUrl(meta.url) || await this.isDirectReachable(meta.url, locator)) return meta.url;
          // A signed CDN URL can be returned as "resolved" while already
          // rejected by the upstream edge (Primeload currently does this).
          // Do not pass that dead URL or its same embed into the player.
          return /primeload/i.test(locator) ? null : locator;
        }
      } catch {
        // Keep the stable embed as a fallback; the platform resolver may know
        // a newer host-specific strategy than this adapter.
      }
      return locator;
    }));
    return [...new Set(resolved.filter((url): url is string => typeof url === "string" && url.length > 0 && !BLACKLISTED_SERVERS.test(url)))];
  }

  private isDirectMediaUrl(url: string): boolean {
    return /\.(?:m3u8|mpd|mp4|webm|mkv)(?:[?#]|$)/i.test(url)
      || /\/m3u8\/|hls-vod|\/get_video|tapecontent\.net|\/api\/v1\/stream\/mega/i.test(url);
  }

  private async isDirectReachable(url: string, locator: string): Promise<boolean> {
    if (!this.isDirectMediaUrl(url)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const referer = (() => {
        try { return `${new URL(locator).origin}/`; } catch { return `${BASE_URL}/`; }
      })();
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": COMMON_HEADERS["User-Agent"],
          Accept: "application/vnd.apple.mpegurl,application/x-mpegURL,video/*,*/*;q=0.8",
          Referer: referer,
          Range: "bytes=0-4095",
        },
      });
      if (!(response.status === 200 || response.status === 206)) return false;
      const body = (await response.text()).slice(0, 256).toLowerCase();
      return !body.includes("token validation failed") && !body.includes('"error"') && (!/\.m3u8(?:[?#]|$)/i.test(url) || body.includes("#extm3u"));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchGraphql(query: string, variables: Record<string, unknown>, referer: string): Promise<GraphqlPayload | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...COMMON_HEADERS,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: BASE_URL,
          Referer: referer || `${BASE_URL}/`,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) return null;
      const payload = await response.json() as GraphqlPayload;
      if (Array.isArray(payload.errors) && payload.errors.length > 0) return null;
      return payload;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private decodeEmbedShortenerLink(value: string): string | null {
    try {
      const token = value.split("/e/")[1];
      const payloadPart = token?.split(".")[1];
      if (!payloadPart) return null;
      let payloadB64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
      while (payloadB64.length % 4) payloadB64 += "=";
      const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as { link?: string };
      if (!payload.link) return null;
      let linkB64 = payload.link.replace(/-/g, "+").replace(/_/g, "/");
      while (linkB64.length % 4) linkB64 += "=";
      const decoded = Buffer.from(linkB64, "base64").toString("utf8");
      return /^https?:\/\//i.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }

  private seriesResult(detail: any, episodes: ExtractedEpisode[], url: string): UniversalAnalysisResult {
    const title = this.firstString(detail.name_es, detail.name, this.titleFromUrl(url));
    return {
      ...this.emptyResult("detail", "series"),
      title,
      original_title: this.firstString(detail.original_name, detail.name) || null,
      english_title: this.firstString(detail.name) || null,
      tmdb_id: Number.isFinite(Number(detail.tmdb_id)) ? Number(detail.tmdb_id) : null,
      description: this.firstString(detail.overview),
      poster_url: this.imageUrl(this.firstString(detail.poster, detail.poster_path)),
      banner_url: this.imageUrl(this.firstString(detail.backdrop, detail.backdrop_path)),
      year: this.yearFromValue(detail.first_air_date) || 0,
      status: detail.isFinish ? "completed" : "ongoing",
      genres: Array.isArray(detail.genres) ? detail.genres.map((genre: any) => this.firstString(genre?.name)).filter(Boolean) : [],
      episodes,
    };
  }

  private movieResult(movie: any, url: string): UniversalAnalysisResult {
    const title = this.firstString(movie.name_es, movie.name, this.titleFromUrl(url));
    return {
      ...this.emptyResult("detail", "movie"),
      title,
      original_title: this.firstString(movie.name) || null,
      english_title: this.firstString(movie.name) || null,
      description: this.firstString(movie.overview),
      poster_url: this.imageUrl(this.firstString(movie.poster, movie.poster_path)),
      banner_url: this.imageUrl(this.firstString(movie.backdrop, movie.backdrop_path)),
      year: this.yearFromValue(movie.release_date) || 0,
      status: this.firstString(movie.status_source, movie.status) || "published",
      genres: Array.isArray(movie.genres) ? movie.genres.map((genre: any) => this.firstString(genre?.name)).filter(Boolean) : [],
      detected_streams: [url],
    };
  }

  private emptyResult(pageType: UniversalAnalysisResult["page_type"], contentType: ContentKind): UniversalAnalysisResult {
    return {
      page_type: pageType,
      content_type: contentType,
      title: "",
      source_domain: SITE_HOST,
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

  private isCatalogPath(path: string): boolean {
    return path === "/" || path === "/doramas" || path === "/peliculas" || path === "/variedades";
  }

  private nextCatalogUrl(url: string, itemCount: number): string | null {
    // The worker also probes consecutive ?page=N URLs. Returning null when a
    // short final page is seen keeps the public analysis useful without
    // depending on a second GraphQL request solely for pageInfo.
    if (itemCount < CATALOG_PAGE_SIZE) return null;
    const page = this.catalogPageNumber(url);
    try {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return next.toString();
    } catch {
      return null;
    }
  }

  private catalogPageNumber(url: string): number {
    try {
      const parsed = new URL(url);
      const raw = parsed.searchParams.get("page") || parsed.searchParams.get("p") || "1";
      const page = Number.parseInt(raw, 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch {
      return 1;
    }
  }

  private serverPriority(value: unknown): number {
    const key = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    return SERVER_ORDER[key] ?? 50;
  }

  private pathOf(url: string): string {
    try { return new URL(url).pathname.toLowerCase(); } catch { return url.toLowerCase(); }
  }

  private lastPathPart(value: string): string {
    return value.split("/").filter(Boolean).pop() || "";
  }

  private titleFromUrl(url: string): string {
    const slug = this.lastPathPart(this.pathOf(url));
    return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()) || "Doramasia";
  }

  private firstString(...values: unknown[]): string {
    return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || "";
  }

  private yearFromValue(value: unknown): number | null {
    const match = String(value || "").match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
  }

  private imageUrl(value: string): string | null {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith("/")) return `https://image.tmdb.org/t/p/w500${value}`;
    return value;
  }
}
