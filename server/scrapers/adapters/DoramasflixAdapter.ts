import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";
import { enrichUniversalMetadata, type EnrichedMetadata } from "../../metadataEngine";
import { ExternalIdResolver } from "../../subtitles/ExternalIdResolver";

const BASE_URL = "https://doramasflix.io";
const GRAPHQL_URL = "https://user-api.fluxcedene.net/graphql";
const GRAPHQL_APP = "com.asiapp.doramasgo";
const CATALOG_PAGE_SIZE = 24;
// Nuevo Next-Action vigente (descubierto live 2026-08-29 via Playwright intercept: getEpisodeLinks)
const NEXT_ACTION_ID = "406bdec544eeb53cbefa09322cbda67963eb850496";
const NEXT_ACTION_FALLBACK = "40c3671ad750012fd1bcbcb050c7894f427d37a8b1";
const externalIdResolver = new ExternalIdResolver();

export class DoramasflixAdapter extends BaseScraperAdapter {
  readonly id = "doramasflix";
  readonly name = "Doramasflix (Doramas, Películas, Variedades)";
  readonly supportedDomains = ["doramasflix.io", "doramasflix.co", "doramasflix.net", "doramasflix.in", "doramasflix.com"];

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      return this.supportedDomains.some((domain) =>
        hostname === domain || hostname.endsWith(`.${domain}`),
      );
    } catch {
      return false;
    }
  }

  public async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const url = input.trim();

    // 1. Si es un episodio o se pide stream directamente
    if (explicitType === "stream" || url.includes("/capitulos/")) {
      const streamRes = await this.extractStream(url);
      return {
        page_type: "direct_stream",
        content_type: "series",
        title: streamRes.title || "Doramasflix Stream",
        description: "",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "ongoing",
        genres: ["Dorama"],
        detected_streams: streamRes.all_available_streams,
        episodes: [],
        catalog_items: [],
      };
    }

    // 2. Si es catálogo (/peliculas, /variedades, /doramas)
    if (explicitType === "catalog" || url.endsWith("/peliculas") || url.endsWith("/variedades") || url.endsWith("/doramas")) {
      const items = await this.extractCatalog(url);
      const isMovie = url.includes("/peliculas");
      return {
        page_type: "catalog",
        content_type: isMovie ? "movie" : "series",
        title: `Catálogo ${isMovie ? "Películas" : "Doramas"} - Doramasflix`,
        description: "Catálogo extraído de Doramasflix",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "ongoing",
        genres: ["Dorama"],
        episodes: [],
        catalog_items: items,
      };
    }

    // 3. Detalle de Dorama / Película
    return this.extractDetail(url);
  }

  /**
   * Extrae el catálogo de /doramas, /peliculas o /variedades
   */
  private async extractCatalog(url: string): Promise<ExtractedCatalogItem[]> {
    // Doramasflix migró el listado a GraphQL. La vista HTML solo contiene la
    // primera página y repetirla con ?page=N provoca que el importador pierda
    // casi todo el catálogo. Consultamos la API oficial del sitio y dejamos
    // el HTML como fallback para no romper dominios/instalaciones antiguas.
    const apiItems = await this.extractCatalogFromGraphql(url);
    if (apiItems.length > 0) return apiItems;

    const html = await this.fetchHtml(url);
    if (!html) throw new Error(`FETCH_FAILED: ${url}`);

    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    const sel = "a[href*='/doramas/'], a[href*='/peliculas/'], a[href*='/variedades/'], a[href*='/pelicula/'], a[href*='/serie/'], a[href*='/anime/']";
    $(sel).each((_, el) => {
      const href = $(el).attr("href");
      if (!href || href === "/doramas" || href === "/peliculas" || href === "/variedades" || seen.has(href)) return;

      const fullUrl = this.resolveRelativeUrl(href, BASE_URL);
      if (!fullUrl || seen.has(fullUrl)) return;
      seen.add(fullUrl);

      const $parent = $(el).closest("div, article");
      const title =
        $parent.find("h2, h3, .title, .name").first().text().trim() ||
        $(el).attr("title")?.trim() ||
        $parent.find("img").attr("alt")?.trim() ||
        this.titleFromUrl(fullUrl);
      const img =
        $parent.find("img").attr("src") ||
        $parent.find("img").attr("data-src") ||
        $(el).find("img").attr("src") ||
        "";

      let kind: ContentKind = "series";
      if (url.includes("/peliculas") || href.includes("/pelicula") || href.includes("/peliculas/")) kind = "movie";

      items.push({
        title: title || this.titleFromUrl(fullUrl),
        url: fullUrl,
        image_url: img ? this.resolveRelativeUrl(img, BASE_URL) : null,
        kind,
      });
    });

    return items;
  }

  private async extractCatalogFromGraphql(url: string): Promise<ExtractedCatalogItem[]> {
    const page = this.catalogPageNumber(url);
    const path = (() => {
      try { return new URL(url).pathname.toLowerCase(); } catch { return ""; }
    })();
    const isMovie = path.includes("/peliculas");
    const isVariety = path.includes("/variedades");
    const query = isMovie
      ? `query PaginationMovie($sort: SortMovie, $limit: Int, $filter: FilterMoviesInput, $page: Int, $excludedLabelSlugs: [String!]) {
          paginationMovie(sort: $sort, limit: $limit, filter: $filter, page: $page, excludedLabelSlugs: $excludedLabelSlugs) {
            items { _id name name_es slug poster_path poster backdrop_path backdrop release_date }
          }
        }`
      : `query PaginationDorama($sort: SortDorama, $limit: Int, $filter: FilterDoramasInput, $page: Int, $excludedLabelSlugs: [String!]) {
          paginationDorama(sort: $sort, limit: $limit, filter: $filter, page: $page, excludedLabelSlugs: $excludedLabelSlugs) {
            items { _id name name_es slug isTVShow poster_path poster backdrop_path backdrop first_air_date }
          }
        }`;
    // FilterMoviesInput no incluye isTVShow; los filtros de películas van
    // vacíos. Doramas sí diferencia telenovelas de programas con isTVShow.
    const filter = isMovie ? {} : isVariety ? { isTVShow: true } : { isTVShow: false };
    const variables = { sort: "_ID_DESC", limit: CATALOG_PAGE_SIZE, filter, page, excludedLabelSlugs: null };
    const response = await this.fetchGraphql(query, variables, url);
    if (!response || typeof response !== "object") return [];

    const container = isMovie
      ? (response as { data?: { paginationMovie?: { items?: unknown[] } } }).data?.paginationMovie
      : (response as { data?: { paginationDorama?: { items?: unknown[] } } }).data?.paginationDorama;
    const rawItems = container?.items;
    if (!Array.isArray(rawItems)) return [];

    const prefix = isMovie ? "/peliculas/" : isVariety ? "/variedades/" : "/doramas/";
    const result: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const slug = typeof item.slug === "string" ? item.slug.trim() : "";
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const title = this.firstString(item.name_es, item.name, slug);
      const poster = this.firstString(item.poster, item.poster_path);
      const backdrop = this.firstString(item.backdrop, item.backdrop_path);
      const year = this.yearFromValue(item.release_date ?? item.first_air_date);
      result.push({
        title,
        url: `${BASE_URL}${prefix}${encodeURIComponent(slug)}`,
        image_url: poster || backdrop ? this.resolveRelativeUrl(poster || backdrop, BASE_URL) : null,
        kind: isMovie ? "movie" : "series",
        year,
      });
    }
    return result;
  }

  private async fetchGraphql(query: string, variables: Record<string, unknown>, referer: string): Promise<unknown | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(GRAPHQL_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...COMMON_HEADERS,
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: BASE_URL,
          Referer: referer,
          "X-App": GRAPHQL_APP,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) return null;
      const payload = await response.json() as { errors?: unknown[]; data?: unknown };
      if (Array.isArray(payload.errors) && payload.errors.length > 0) return null;
      return payload;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private catalogPageNumber(url: string): number {
    try {
      const parsed = new URL(url);
      const raw = parsed.searchParams.get("page") || parsed.searchParams.get("p") || parsed.searchParams.get("pag") || "1";
      const page = Number.parseInt(raw, 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch {
      return 1;
    }
  }

  private firstString(...values: unknown[]): string {
    return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || "";
  }

  private yearFromValue(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? Number.parseInt(match[0], 10) : null;
  }

  /**
   * Extrae metadatos y lista de episodios desde la página de detalle
   */
  private async extractDetail(url: string): Promise<UniversalAnalysisResult> {
    const html = await this.fetchHtml(url);
    if (!html) {
      return {
        page_type: "detail",
        content_type: "series",
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

    const $ = cheerio.load(html);
    const jsonLd = this.extractJsonLdMetadata($);
    const title = $("h1").first().text().trim() || jsonLd.title || $("meta[property='og:title']").attr("content") || $("title").text().trim();
    const description = $("meta[property='og:description']").attr("content") || jsonLd.description || $(".synopsis, .overview, p").first().text().trim();
    const poster_url = $("meta[property='og:image']").attr("content") || jsonLd.image || $(".poster img, img[src*='tmdb']").attr("src") || null;

    const episodes: ExtractedEpisode[] = [];
    const seenEp = new Set<string>();

    // El payload público de React Flight conserva la secuencia canónica de
    // episodios publicados y sus temporadas, mientras que el HTML puede
    // omitir algunos enlaces. Úsalo como fuente primaria y deja los anchors
    // como complemento para despliegues antiguos, sin inventar episodios aún
    // no publicados.
    for (const item of this.extractInitialEpisodes(html)) {
      const episodeUrl = item.url ? this.resolveRelativeUrl(item.url, BASE_URL) : "";
      if (!episodeUrl || seenEp.has(episodeUrl)) continue;
      seenEp.add(episodeUrl);
      episodes.push({
        number: item.number,
        ...(item.season ? { season: item.season } : {}),
        title: item.title || `Capítulo ${item.number}`,
        url: episodeUrl,
      });
    }

    $("a[href*='/capitulos/']").each((idx, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const episodeUrl = this.resolveRelativeUrl(href, BASE_URL);
      if (seenEp.has(episodeUrl)) return;
      seenEp.add(episodeUrl);

      const label = `${$(el).text().trim()} ${href}`;
      const seasonMatch = label.match(/(?:^|[^a-z])(?:s|t|temporada[- _]?)\s*0*(\d{1,2})/i);
      const episodeMatch = label.match(/(?:^|[^a-z])(?:e|ep(?:isodio)?|cap(?:itulo)?)[- ._]*0*(\d{1,4})/i)
        || href.match(/(?:-|\b)(\d{1,2})x(\d{1,4})(?:\b|-|$)/i);
      const parsedSeason = episodeMatch?.[2] ? Number.parseInt(episodeMatch[1], 10) : seasonMatch?.[1] ? Number.parseInt(seasonMatch[1], 10) : undefined;
      const parsedNumber = episodeMatch?.[2] ? Number.parseInt(episodeMatch[2], 10) : episodeMatch?.[1] ? Number.parseInt(episodeMatch[1], 10) : idx + 1;
      const epTitle = $(el).text().trim() || `Capítulo ${parsedNumber}`;
      episodes.push({
        number: Number.isFinite(parsedNumber) && parsedNumber > 0 ? parsedNumber : idx + 1,
        ...(parsedSeason && Number.isFinite(parsedSeason) ? { season: parsedSeason } : {}),
        title: epTitle,
        url: episodeUrl,
      });
    });

    const isMovie = url.includes("/pelicula/") || url.includes("/peliculas/") || episodes.length === 0;

    // Doramasflix publica el nombre localizado y un alternateName (normalmente
    // el título nativo). Probamos ambos contra TMDB para no perder la identidad
    // por buscar únicamente el alias romanizado mostrado en el encabezado.
    const metadata = await this.enrichDetailMetadata(
      [title, ...(jsonLd.aliases || []), this.titleFromUrl(url)],
      isMovie ? "movie" : "series",
    );
    const imdbId = metadata?.tmdb_id
      ? await externalIdResolver.resolve({ tmdbId: Number(metadata.tmdb_id), kind: isMovie ? "movie" : "series" })
      : null;

    return {
      page_type: "detail",
      content_type: isMovie ? "movie" : "series",
      title,
      original_title: metadata?.original_title || jsonLd.originalTitle || null,
      english_title: metadata?.english_title || null,
      tmdb_id: metadata?.tmdb_id ?? null,
      imdb_id: imdbId,
      mal_id: metadata?.mal_id ?? null,
      anilist_id: metadata?.anilist_id ?? null,
      kitsu_id: metadata?.kitsu_id ?? null,
      description: description || metadata?.description || "",
      poster_url: poster_url ? this.resolveRelativeUrl(poster_url, BASE_URL) : null,
      banner_url: metadata?.banner_url || jsonLd.image || null,
      rating: metadata?.rating || jsonLd.rating || 0,
      year: metadata?.year || jsonLd.year || 0,
      status: metadata?.status || "ongoing",
      genres: metadata?.genres?.length ? metadata.genres : (jsonLd.genres?.length ? jsonLd.genres : ["Dorama"]),
      episodes,
      catalog_items: [],
    };
  }

  /** Extrae el JSON-LD público de la ficha sin depender de la forma de React Flight. */
  private extractJsonLdMetadata($: cheerio.CheerioAPI): {
    title?: string;
    originalTitle?: string;
    aliases: string[];
    description?: string;
    image?: string;
    year?: number;
    rating?: number;
    genres: string[];
  } {
    const result: {
      title?: string;
      originalTitle?: string;
      aliases: string[];
      description?: string;
      image?: string;
      year?: number;
      rating?: number;
      genres: string[];
    } = { aliases: [], genres: [] };
    $("script[type='application/ld+json']").each((_, el) => {
      if (result.title) return;
      try {
        const parsed = JSON.parse($(el).text()) as Record<string, unknown>;
        const type = String(parsed["@type"] || "").toLowerCase();
        if (!/(tvseries|movie|tvepisode)/.test(type)) return;
        if (typeof parsed.name === "string") result.title = parsed.name.trim();
        if (typeof parsed.alternateName === "string") {
          result.originalTitle = parsed.alternateName.trim();
          result.aliases.push(result.originalTitle);
        } else if (Array.isArray(parsed.alternateName)) {
          result.aliases.push(...parsed.alternateName.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean));
          result.originalTitle = result.aliases[0];
        }
        if (typeof parsed.description === "string") result.description = parsed.description.trim();
        if (typeof parsed.image === "string") result.image = parsed.image;
        const date = String(parsed.datePublished || parsed.releaseDate || "");
        const year = Number.parseInt(date.slice(0, 4), 10);
        if (Number.isFinite(year) && year > 1800) result.year = year;
        if (Array.isArray(parsed.genre)) result.genres.push(...parsed.genre.filter((v): v is string => typeof v === "string"));
        const aggregate = parsed.aggregateRating as Record<string, unknown> | undefined;
        const rating = Number(aggregate?.ratingValue);
        if (Number.isFinite(rating)) result.rating = rating;
      } catch {
        // Algunos despliegues incluyen varios bloques o JSON-LD parcial; se continúa.
      }
    });
    return result;
  }

  private async enrichDetailMetadata(candidates: string[], kind: "movie" | "series"): Promise<EnrichedMetadata | null> {
    const unique = [...new Set(candidates.map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter((value) => value.length >= 2))].slice(0, 4);
    let fallback: EnrichedMetadata | null = null;
    for (const candidate of unique) {
      try {
        const metadata = await enrichUniversalMetadata(
          candidate,
          kind,
          // Las fichas suelen mezclar título español, romanización y nombre
          // coreano. Esta pista solo desempata resultados que ya coinciden
          // textualmente en TMDB; nunca asigna un ID por país/idioma aislado.
          { originalLanguage: "ko", originCountry: ["KR"] },
        );
        if (!fallback) fallback = metadata;
        if (metadata.tmdb_id || metadata.mal_id || metadata.anilist_id || metadata.kitsu_id) return metadata;
      } catch {
        // La ficha sigue siendo utilizable aunque el proveedor de metadata esté temporalmente caído.
      }
    }
    return fallback;
  }

  private extractInitialEpisodes(html: string): Array<{ number: number; season?: number; title?: string; url?: string }> {
    const normalized = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
    const keyIndex = normalized.indexOf("initialEpisodes");
    if (keyIndex < 0) return [];
    const start = normalized.indexOf("[", keyIndex);
    if (start < 0) return [];
    const end = this.findJsonArrayEnd(normalized, start);
    if (end <= start) return [];
    try {
      const parsed = JSON.parse(normalized.slice(start, end)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as Record<string, unknown>;
        const number = Number(item.episode_number ?? item.number);
        const season = Number(item.season_number ?? item.season);
        const href = typeof item.href === "string" ? item.href : typeof item.slug === "string" ? `/capitulos/${item.slug}` : undefined;
        if (!Number.isFinite(number) || number <= 0 || !href) return [];
        return [{
          number: Math.trunc(number),
          ...(Number.isFinite(season) && season > 0 ? { season: Math.trunc(season) } : {}),
          title: typeof item.title === "string" ? item.title.trim() : undefined,
          url: href,
        }];
      });
    } catch {
      return [];
    }
  }

  private findJsonArrayEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "[") {
        depth += 1;
      } else if (char === "]") {
        depth -= 1;
        if (depth === 0) return index + 1;
      }
    }
    return -1;
  }

  /**
   * Extrae episode_id tolerando HTML escapado de React Flight (\", \\u0022).
   */
  private extractEpisodeId(html: string): string | null {
    // Normaliza escapes más comunes de Next Flight
    const normalized = html.replace(/\\u0022/g, '"').replace(/\\"/g, '"');
    const candidates = [
      // El frontend vigente entrega `initialEpisodes[].id` (antes era
      // `episode._id`). Mantener ambos formatos evita que el adaptador se
      // quede devolviendo la página del capítulo sin consultar sus servidores.
      /initialEpisodes[^]{0,800}?\"id\"\s*:\s*\"([a-f0-9]{24})\"/i,
      /initialEpisodes[^]{0,800}?["']id["']\s*:\s*["']([a-f0-9]{24})["']/i,
      /"episode"\s*:\s*\{[^}]*?"_id"\s*:\s*"([a-f0-9]{24})"/i,
      /'episode'\s*:\s*\{[^}]*?'_id'\s*:\s*['"]([a-f0-9]{24})['"]/i,
      /"_id"\s*:\s*"([a-f0-9]{24})"/i,
    ];
    for (const re of candidates) {
      const m = normalized.match(re) || html.match(re);
      if (m) return m[1];
    }
    // Último fallback: cualquier 24hex con prefijo 6a (formato doramas)
    const fallback = normalized.match(/"([a-f0-9]{24})"/i) || html.match(/([a-f0-9]{24})/);
    // validar que sea plausible (24 hex)
    if (fallback && /^[a-f0-9]{24}$/i.test(fallback[1] || fallback[0])) {
      // prioriza ids que aparecen cerca de "episode"
      const episodeNear = normalized.match(/episode[^]{0,400}([a-f0-9]{24})/i);
      if (episodeNear) return episodeNear[1];
      return fallback[1] || fallback[0];
    }
    return null;
  }

  /**
   * Construye el header Next-Router-State-Tree para POST Server Action.
   * Formato capturado live para /capitulos/<slug>.
   */
  private buildNextRouterStateTree(targetUrl: string): string {
    try {
      const slug = new URL(targetUrl).pathname.split("/").filter(Boolean).pop() || "unknown";
      const fullTree = `["",{` +
        `"children":[["locale","es","d",null],{"children":["capitulos",{"children":[["slug","${slug}","d",null],{"children":["__PAGE__",{},null,null,0]}]}]}],"modal":["__DEFAULT__",{},null,null,0]},null,null,16]`;
      return encodeURIComponent(fullTree);
    } catch {
      return "";
    }
  }

  /**
   * Intenta descubrir el Next-Action vigente para getEpisodeLinks escaneando chunks.
   * Acotado y paralelo con cleanup garantizado. Si falla, devuelve el fallback conocido.
   */
  private async discoverNextActionId(html: string): Promise<string> {
    const chunkRegex = /\/_next\/static\/chunks\/[^"']+\.js/g;
    const chunks = [...new Set(html.match(chunkRegex) || [])].slice(0, 8);
    if (chunks.length === 0) return NEXT_ACTION_ID;

    const controllers: AbortController[] = [];
    const timers: NodeJS.Timeout[] = [];
    try {
      const results = await Promise.all(
        chunks.map(async (c) => {
          const controller = new AbortController();
          controllers.push(controller);
          const timer = setTimeout(() => controller.abort(), 3500);
          timers.push(timer);
          try {
            const full = new URL(c, BASE_URL).href;
            const res = await fetch(full, { signal: controller.signal, headers: COMMON_HEADERS });
            if (!res.ok) return null;
            const text = await res.text();
            const m = text.match(/createServerReference\("([a-f0-9]{40,64})"[^)]*"getEpisodeLinks"/);
            return m ? m[1] : null;
          } catch {
            return null;
          } finally {
            clearTimeout(timer);
          }
        })
      );
      const found = results.find((v): v is string => !!v);
      if (found) return found;
    } finally {
      for (const t of timers) clearTimeout(t);
      for (const c of controllers) try { c.abort(); } catch {}
    }
    const hexInHtml = html.match(/[a-f0-9]{40,42}/gi);
    if (hexInHtml?.includes(NEXT_ACTION_ID)) return NEXT_ACTION_ID;
    return NEXT_ACTION_ID;
  }

  /**
   * Parsea la respuesta de Next-Action sin asumir solo "1:".
   * Busca líneas que contengan JSON con links de embedshortener.
   */
  private parseActionServers(actionText: string): any[] | null {
    const lines = actionText.split("\n");
    // 1) Intentar líneas con prefijo "n:"
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const payload = line.slice(colon + 1);
      if (!payload.trim().startsWith("[") && !payload.trim().startsWith("{")) continue;
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed) && parsed.some((s: any) => s && s.link)) return parsed;
        if (parsed && typeof parsed === "object") {
          const str = JSON.stringify(parsed);
          if (str.includes("embedshortener") || str.includes("link")) {
            if (Array.isArray(parsed)) return parsed;
            for (const v of Object.values(parsed as any)) {
              if (Array.isArray(v) && (v as any[]).some((x: any) => x?.link)) return v as any[];
            }
          }
        }
      } catch {}
    }
    // 2) Fallback: buscar directamente array con embedshortener en todo el texto
    const fallback = actionText.match(/\[\{[^]*?embedshortener[^]*?\}\]/);
    if (fallback) {
      try {
        const parsed = JSON.parse(fallback[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    return null;
  }

  /**
   * Obtiene los enlaces del episodio desde la API GraphQL pública del sitio.
   * El Server Action de Next cambia con frecuencia y puede responder 504 a
   * clientes Node; GraphQL es el canal estable que usa el propio frontend.
   */
  private async fetchEpisodeLinks(episodeId: string, referer: string): Promise<any[] | null> {
    const query = `query EpisodeLinksOnline($episode_id: ID!) {
      getEpisodeLinks(id: $episode_id, app: "${GRAPHQL_APP}") {
        links_online {
          server
          lang
          link
          _id
          is_recommended
          subtitles { language_code type }
        }
      }
    }`;
    const payload = await this.fetchGraphql(query, { episode_id: episodeId }, referer) as any;
    const links = payload?.data?.getEpisodeLinks?.links_online;
    return Array.isArray(links) ? links : null;
  }

  /** Decodifica, resuelve y comprueba todos los servidores de un episodio. */
  private async resolveServerEntries(rawServers: any[], cleanUrl: string): Promise<string[]> {
    const embedUrls = [...new Set(rawServers
      .map((server) => typeof server?.link === "string" ? this.decodeEmbedShortenerLink(server.link) : null)
      .filter((url): url is string => Boolean(url)))];
    if (embedUrls.length === 0) return [];

    const resolvedStreams = (await Promise.all(embedUrls.map(async (embedUrl) => {
      try {
        const resolved = await EmbedResolvers.resolve(embedUrl);
        return resolved || embedUrl;
      } catch {
        return embedUrl;
      }
    }))).filter((candidate) => candidate.toLowerCase() !== cleanUrl.toLowerCase());
    if (resolvedStreams.length === 0) return [];

    const validStreams = await MediaValidator.validateUrls(resolvedStreams);
    const filteredValid = validStreams.filter((url) => url.toLowerCase() !== cleanUrl.toLowerCase());
    const filteredResolved = resolvedStreams.filter((url) =>
      url.toLowerCase() !== cleanUrl.toLowerCase() && !url.includes("embedshortener.co"));
    const candidates = filteredValid.length > 0
      ? filteredValid
      : filteredResolved.length > 0
        ? filteredResolved
        : resolvedStreams;
    const directCandidates = [...new Set(candidates.filter((url) => this.isDirectMediaUrl(url)))];
    if (directCandidates.length === 0) return [];

    const reachable = await Promise.all(directCandidates.map(async (url) =>
      (await this.isDirectReachable(url)) ? url : null));
    return reachable.filter((url): url is string => Boolean(url));
  }

  /**
   * Extrae y desencripta los servidores/embeds reales de un episodio mediante Next-Action + JWT decoding
   */

  /**
   * Extrae y desencripta los servidores/embeds reales de un episodio mediante Next-Action + JWT decoding
   */
  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const fetchTimerMap: NodeJS.Timeout[] = [];
    try {
      const html = await this.fetchHtml(cleanUrl, 8000);
      if (!html) {
        return { stream_url: "", all_available_streams: [] };
      }

      const $ = cheerio.load(html);
      const pageTitle = $("title").text().trim() || undefined;

      const episodeId = this.extractEpisodeId(html);
      if (!episodeId) {
        return { stream_url: "", all_available_streams: [], title: pageTitle };
      }

      // Descubrir acción vigente (resiliente a rotación)
      let actionId = NEXT_ACTION_ID;
      try {
        const discovered = await this.discoverNextActionId(html);
        if (discovered && /^[a-f0-9]{40,64}$/i.test(discovered)) actionId = discovered;
      } catch {}

      const tryActions = [actionId, NEXT_ACTION_FALLBACK].filter((v, i, a) => v && a.indexOf(v) === i);

      let finalReachable: string[] = [];
      // Reintentos por variación aleatoria de servidores devueltos
      for (let attempt = 0; attempt < 3 && finalReachable.length === 0; attempt++) {
        let actionText: string | null = null;
        for (const cand of tryActions) {
          let controller: AbortController | null = null;
          let timer: NodeJS.Timeout | null = null;
          try {
            controller = new AbortController();
            timer = setTimeout(() => controller!.abort(), 8000);
            if (timer) fetchTimerMap.push(timer);
            const tree = this.buildNextRouterStateTree(cleanUrl);
            const actionRes = await fetch(cleanUrl, {
              method: "POST",
              signal: controller.signal,
              headers: {
                ...COMMON_HEADERS,
                Referer: cleanUrl,
                "Next-Action": cand,
                "Next-Router-State-Tree": tree,
                "Content-Type": "text/plain;charset=UTF-8",
                Accept: "text/x-component",
              },
              body: JSON.stringify([{ episode_id: episodeId }]),
            });
            if (!actionRes.ok) continue;
            actionText = await actionRes.text();
            if (actionText.includes("Server action not found")) continue;
            if (actionText.includes("embedshortener") || actionText.includes("link")) break;
            break;
          } catch {
            continue;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }

        if (!actionText) continue;
        const rawServers = this.parseActionServers(actionText);
        if (!rawServers || !Array.isArray(rawServers) || rawServers.length === 0) continue;

        const reachable = await this.resolveServerEntries(rawServers, cleanUrl);
        if (reachable.length > 0) {
          finalReachable = reachable;
          break;
        }
        // si no hay reachable, reintentar con nueva lista aleatoria
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
      }

      // Fallback estable: la consulta GraphQL es la operación que usa el
      // frontend para obtener los enlaces y sobrevive cuando Next-Action rota,
      // se bloquea por WAF o devuelve 504 al cliente Node.
      if (finalReachable.length === 0) {
        try {
          const graphServers = await this.fetchEpisodeLinks(episodeId, cleanUrl);
          if (graphServers?.length) {
            finalReachable = await this.resolveServerEntries(graphServers, cleanUrl);
          }
        } catch {}
      }

      if (finalReachable.length === 0) {
        return { stream_url: "", all_available_streams: [], title: pageTitle };
      }

      return {
        stream_url: finalReachable[0],
        all_available_streams: finalReachable,
        title: pageTitle,
      };
    } catch {
      return {
        stream_url: "",
        all_available_streams: [],
      };
    } finally {
      // Limpiar timers pendientes
      for (const t of fetchTimerMap) clearTimeout(t);
    }
  }

  /**
   * Desencripta el enlace `https://embedshortener.co/e/<jwt>`
   * 1. Extrae el payload JWT (Base64URL)
   * 2. Parsea `{ "link": "<base64_embed_url>" }`
   * 3. Retorna la URL del reproductor desencriptada
   */
  private decodeEmbedShortenerLink(embedShortenerUrl: string): string | null {
    try {
      const jwt = embedShortenerUrl.split("/e/")[1];
      if (!jwt) return null;
      const parts = jwt.split(".");
      if (parts.length < 2) return null;

      let payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payloadB64.length % 4) payloadB64 += "=";

      const payloadJson = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf-8"));
      if (!payloadJson.link) return null;

      let linkB64 = payloadJson.link.replace(/-/g, "+").replace(/_/g, "/");
      while (linkB64.length % 4) linkB64 += "=";

      return Buffer.from(linkB64, "base64").toString("utf-8");
    } catch {
      return null;
    }
  }

  private isDirectMediaUrl(url: string): boolean {
    return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url) || url.includes("/m3u8/") || url.includes("hls-vod");
  }

  /**
   * Verifica que un stream directo responde 200/206 y no es HTML.
   * Solo se considera éxito si es medio directo y reachable.
   */
  private async isDirectReachable(url: string): Promise<boolean> {
    if (!this.isDirectMediaUrl(url)) return false;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    try {
      timer = setTimeout(() => controller.abort(), 3500);
      let res = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
        headers: { "User-Agent": COMMON_HEADERS["User-Agent"] },
      });
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: { "User-Agent": COMMON_HEADERS["User-Agent"], Range: "bytes=0-1" },
        });
      }
      if (res.status === 200 || res.status === 206) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("text/html")) return false;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  protected override resolveRelativeUrl(relative: string, base: string): string {
    try {
      return new URL(relative, base).href;
    } catch {
      return relative;
    }
  }

  private titleFromUrl(url: string): string {
    try {
      const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
      return slug.replace(/-/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()).trim() || "Doramasflix";
    } catch {
      return "Doramasflix";
    }
  }
}
