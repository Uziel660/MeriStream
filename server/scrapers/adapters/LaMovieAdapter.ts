import * as cheerio from "cheerio";
import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { unpackGeneric, extractMediaUrlsFromCode } from "../utils/jsUnpacker";
import { EmbedResolvers } from "../../resolvers";
import { VimeosResolver } from "../vimeosResolver";
import { familyKeyOfStreamUrl } from "../../utils/streamSorter";

/**
 * Adaptador para lamovie.org - Extrae catálogo de sitemaps XML, detalles de páginas estáticas,
 * y streams de la API interna wp-api/v1/player
 */
export class LaMovieAdapter extends BaseScraperAdapter {
  readonly id = "lamovie";
  readonly name = "LaMovie (Películas, Series, Animes)";
  readonly supportedDomains = ["lamovie.org", "lamovie.to", "lamovie.ws"];

  /** Hosts de descarga directa (no exponen stream embebido): no intentar resolver */
  private static readonly DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"];

  private static readonly DEAD_OR_BLOCKED_HOST_PATTERNS = [
    /cfglobalcdn\.com/i,
    /yourupload\.com/i,
    /streamtape\./i,
    /dsvplay\.com/i,
    /savefiles\.com/i,
    /d-s\.io/i,
    /a\d+\.mp4upload\.com/i,
    /vidcache\.net/i,
    /my\.mail\.ru/i,
    /v\.tioanime\.com/i,
  ];

  private static isDeadOrBlocked(url: string): boolean {
    return LaMovieAdapter.DEAD_OR_BLOCKED_HOST_PATTERNS.some((p) => p.test(url));
  }

  /**
   * Defecto #5: solo aceptar fuentes reproducibles — media directa (.m3u8/.mp4/
   * .webm/.mkv) o embeds de hosts de streaming conocidos. Descarta basura tipo
   * "10CCCCCC.rar" de MediaFire, .zip, magnet y páginas HTML crudas.
   */
  static isPlayableSourceUrl(url: string): boolean {
    const lower = (url || "").toLowerCase();
    if (!lower.startsWith("http") && !lower.startsWith("magnet:")) return false;
    if (lower.startsWith("magnet:")) return false;

    // Media directa por extensión
    if (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(lower)) return true;

    // Hosts de embed de streaming conocidos (embed reproducible tal cual)
    const KNOWN_EMBED_HOSTS = [
      "goodstream.", "vidhide", "streamwish.", "hlswish.", "streamhide.",
      "filemoon.", "mp4upload.com", "mega.nz/embed", "voe.", "byselapuix.com",
      "mixdrop.", "dood.", "doodstream.", "streamtape.", "yourupload.com",
      "ok.ru", "uqload.", "luluvdo.", "vidmoly.", "upstream.", "streamlare.",
      "fastre.", "gamovideo.", "netu.", "waaw.", "streamdav.", "streamhub.",
      "fembed.", "embedsito.", "zilla-networks.com", "vimeo.com",
    ];
    if (KNOWN_EMBED_HOSTS.some((h) => lower.includes(h))) return true;

    // Extensiones claramente no-reproducibles: descartar siempre
    if (/\.(rar|zip|7z|exe|iso|pdf|jpg|jpeg|png|webp|gif|txt|srt|ass)(\?|#|$)/i.test(lower)) {
      return false;
    }

    // Resto (hosts desconocidos sin extensión): conservar solo si parece página
    // de player de un host de video genérico; en caso contrario descartar.
    return false;
  }

  /** Filtro de fuentes jugables para las listas finales. */
  private static filterPlayableSources(urls: string[]): string[] {
    return urls.filter((u) => LaMovieAdapter.isPlayableSourceUrl(u));
  }

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("lamovie.");
  }

  /**
   * Extrae el catálogo desde los sitemaps XML oficiales
   * Ejemplo: https://lamovie.org/wp-sitemap-posts-movies-1.xml
   */
  private async extractCatalogFromSitemap(contentType: ContentKind, page: number = 1): Promise<ExtractedCatalogItem[]> {
    const sitemapMap: Record<ContentKind, string> = {
      movie: "movies",
      series: "tvshows",
      anime: "animes",
      documentary: "movies",
      open_archive: "movies",
    };

    const sitemapType = sitemapMap[contentType] || "movies";
    const sitemapUrl = `https://lamovie.org/wp-sitemap-posts-${sitemapType}-${page}.xml`;

    const xml = await this.fetchHtml(sitemapUrl, 10000);
    if (!xml) return [];

    const $ = cheerio.load(xml, { xmlMode: true });
    const items: ExtractedCatalogItem[] = [];

    $("loc").each((_, el) => {
      const url = $(el).text().trim();
      if (!url || (!url.includes("/peliculas/") && !url.includes("/series/") && !url.includes("/animes/"))) {
        return;
      }

      // Extraer slug de la URL
      const slugMatch = url.match(/\/(?:peliculas|series|animes)\/([^/]+)\/?$/);
      if (!slugMatch) return;

      const slug = slugMatch[1];
      if (["peliculas", "series", "animes"].includes(slug)) return;

      // Limpiar título: quitar guiones y año final
      const cleanTitle = slug
        .replace(/-\d{4}$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();

      items.push({
        title: cleanTitle,
        url,
        kind: contentType,
      });
    });

    return items;
  }

  /**
   * Catálogo vía el API interno de listado (verificado con curl, 2026-08-24):
   *   /wp-api/v1/listing/movies?page=N&postType={movies|tvshows|animes}&postsPerPage=24
   * Respuesta: { error, message, data: { posts:[...], pagination:{ total, last_page } } }
   * Cada post trae overview/genres/imdb_rating/images → items PRE-ENRIQUECIDOS.
   * NO usar postType=series/tv/anime: devuelven ~69k episodios sueltos mezclados.
   */
  private async extractCatalogFromListingApi(contentType: ContentKind, page: number = 1): Promise<ExtractedCatalogItem[]> {
    const postType = contentType === "series" ? "tvshows" : contentType === "anime" ? "animes" : "movies";
    const fichaPrefix = postType === "movies" ? "peliculas" : postType === "tvshows" ? "series" : "animes";
    const apiUrl = `https://lamovie.org/wp-api/v1/listing/movies?page=${page}&postType=${postType}&postsPerPage=24`;
    const raw = await this.fetchHtml(apiUrl, 10000);
    if (!raw) return [];
    try {
      const json = JSON.parse(raw);
      const posts: any[] = json?.data?.posts || [];
      const items: ExtractedCatalogItem[] = [];
      for (const p of posts) {
        if (!p?.slug || !p?.title) continue;
        const yearRaw = typeof p.release_date === "string" ? parseInt(p.release_date.slice(0, 4), 10) : NaN;
        const ratingRaw = Number(p.imdb_rating ?? p.rating ?? NaN);
        let image: string | null = null;
        if (typeof p.images === "string") image = p.images;
        else if (p.images && typeof p.images === "object") {
          image = p.images.poster || p.images.cover || p.images.thumbnail || p.images.original || null;
        }
        items.push({
          title: String(p.title).trim(),
          url: `https://lamovie.org/${fichaPrefix}/${p.slug}/`,
          image_url: image,
          kind: contentType,
          year: Number.isFinite(yearRaw) ? yearRaw : null,
          rating: Number.isFinite(ratingRaw) ? ratingRaw : null,
          // genres del API son IDs numéricos sin endpoint de taxonomía pública:
          // se omiten para no contaminar el catálogo; TMDB los llena en español al guardar.
          genres: undefined,
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  /**
   * Extrae el Post ID de WordPress desde el HTML
   * Busca en: <link rel="shortlink" href="https://lamovie.org/?p=ID" />
   */
  private extractPostId(html: string): string | null {
    const shortlinkMatch = html.match(/shortlink[^>]*\?p=(\d+)/i);
    if (shortlinkMatch) return shortlinkMatch[1];

    // Fallback: buscar en JSON-LD
    const jsonLdMatch = html.match(/"@id"\s*:\s*"[^"]*\/(\d+)"/);
    if (jsonLdMatch) return jsonLdMatch[1];

    // Fallback: buscar en data attributes
    const dataIdMatch = html.match(/data-id[="'](\d+)["']/i);
    if (dataIdMatch) return dataIdMatch[1];

    return null;
  }

  /**
   * Extrae episodios de una serie desde el HTML
   * Busca enlaces a /episodio/ o /temporada/
   */
  private extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];

    // Buscar enlaces de episodios
    const episodeLinks = $("a[href*='/episodio/'], a[href*='/temporada/']");
    episodeLinks.each((i, el) => {
      const href = $(el).attr("href");
      const title = $(el).text().trim();
      if (!href) return;

      const fullUrl = this.resolveRelativeUrl(href, baseUrl);
      const numberMatch = title.match(/(\d+)/) || href.match(/episodio-(\d+)/);
      const number = numberMatch ? parseInt(numberMatch[1], 10) : i + 1;

      episodes.push({
        number,
        title: title || `Episodio ${number}`,
        url: fullUrl,
        server_name: "LaMovie",
      });
    });

    return episodes;
  }

  /**
   * Deriva slug y postType de una URL de detalle (/peliculas|/series|/animes/{slug})
   * o de un episodio (/episodio/{slug}).
   */
  private getSlugAndPostType(url: string): { slug: string; postType: string } | null {
    const episodeMatch = url.match(/\/episodio\/([^/]+)\/?$/i);
    if (episodeMatch) return { slug: episodeMatch[1], postType: "episodes" };

    const pathMatch = url.match(/\/(?:peliculas|series|animes)\/([^/]+)\/?$/i);
    if (!pathMatch) return null;

    const lower = url.toLowerCase();
    const postType = lower.includes("/series/") ? "tvshows" : lower.includes("/animes/") ? "animes" : "movies";
    return { slug: pathMatch[1], postType };
  }

  /**
   * Conteos de episodios por temporada desde TMDB (fuente confiable: la API
   * pública de lamovie NO expone listados de episodios filtrados por show).
   * Costo: 1 search + 1 details por serie. TMDB tolera 40-50 req/s.
   */
  private async fetchTmdbSeasonEpisodeCounts(title: string, year?: number): Promise<Array<{ season: number; count: number }>> {
    try {
      const key = process.env.TMDB_API_KEY;
      if (!key) return [];
      const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${key}&query=${encodeURIComponent(title)}${year ? `&first_air_date_year=${year}` : ""}&language=es-MX`;
      const searchRaw = await this.fetchHtml(searchUrl, 8000);
      if (!searchRaw) return [];
      const search = JSON.parse(searchRaw);
      const id = search?.results?.[0]?.id;
      if (!id) return [];
      const detailsRaw = await this.fetchHtml(`https://api.themoviedb.org/3/tv/${id}?api_key=${key}&language=es-MX`, 8000);
      if (!detailsRaw) return [];
      const details = JSON.parse(detailsRaw);
      return (details?.seasons || [])
        .filter((s: any) => Number.isFinite(s?.season_number) && s.season_number >= 1 && Number.isFinite(s?.episode_count))
        .map((s: any) => ({ season: s.season_number, count: s.episode_count }));
    } catch {
      return [];
    }
  }

  /**
   * Episodios de serie/anime: HTML de la ficha primero; si la ficha no los lista
   * (el sitio es SPA y los carga con bearer), genera los slugs PREDECIBLES del
   * sitio usando los conteos REALES de TMDB:
   *   /episodio/<show-slug-sin-año>-temporada-S-episodio-E/
   * (patrón verificado: "avatar-la-leyenda-de-aang-2005" → episodio
   *  "avatar-la-leyenda-de-aang-temporada-3-episodio-21").
   * Cada episodio resuelve sus streams JIT: /episodio/ expone shortlink postId
   * y wp-api/v1/player?postId=X devuelve los embeds.
   */
  private async buildEpisodeList(html: string, cleanUrl: string, metadata: { title: string; year?: number }): Promise<ExtractedEpisode[]> {
    const fromHtml = this.extractEpisodes(html, cleanUrl);
    if (fromHtml.length > 0) return fromHtml;

    const info = this.getSlugAndPostType(cleanUrl);
    if (!info) return [];
    const baseSlug = info.slug.replace(/-\d{4}$/, "");
    const seasons = await this.fetchTmdbSeasonEpisodeCounts(metadata.title, metadata.year);
    if (seasons.length === 0) return [];

    const episodes: ExtractedEpisode[] = [];
    let n = 0;
    for (const s of seasons) {
      for (let e = 1; e <= s.count; e++) {
        n++;
        episodes.push({
          number: n,
          title: `T${s.season}:E${e}`,
          url: `https://lamovie.org/episodio/${baseSlug}-temporada-${s.season}-episodio-${e}/`,
        });
      }
    }
    return episodes;
  }

  /**
   * Obtiene el Post ID vía la API interna single (campo `_id`) cuando el HTML no lo expone.
   * Endpoint real descubierto en producción: /wp-api/v1/single/{postType}?slug={slug}&postType={postType}
   */
  private async fetchPostIdFromInternalApi(url: string): Promise<string | null> {
    try {
      const info = this.getSlugAndPostType(url);
      if (!info) return null;

      const apiUrl = `https://lamovie.org/wp-api/v1/single/${info.postType}?slug=${encodeURIComponent(info.slug)}&postType=${info.postType}`;
      const raw = await this.fetchHtml(apiUrl, 8000);
      if (!raw) return [];

      const json = JSON.parse(raw);
      const id = json?.data?._id;
      return id !== undefined && id !== null ? String(id) : null;
    } catch {
      return null;
    }
  }

  /**
   * Consulta la API interna de la SPA para obtener metadatos completos del detalle.
   * Endpoint real descubierto en producción: /wp-api/v1/single/{postType}?slug={slug}&postType={postType}
   */
  private async fetchInternalMetadata(url: string): Promise<{
    title?: string;
    original_title?: string;
    description?: string;
    poster_url?: string;
    banner_url?: string;
    rating?: number;
    year?: number;
    duration?: string;
  } | null> {
    try {
      const info = this.getSlugAndPostType(url);
      if (!info) return null;

      const { slug, postType } = info;
      const apiUrl = `https://lamovie.org/wp-api/v1/single/${postType}?slug=${encodeURIComponent(slug)}&postType=${postType}`;
      const raw = await this.fetchHtml(apiUrl, 8000);
      if (!raw) return [];

      const json = JSON.parse(raw);
      const data = json?.data;
      if (!data) return null;

      const uploadsBase = "https://lamovie.org/wp-content/uploads";
      const absImage = (p?: string) =>
        p ? (p.startsWith("http") ? p : `${uploadsBase}${p.startsWith("/") ? "" : "/"}${p}`) : undefined;

      // Título limpio sin el año entre paréntesis
      const rawTitle: string = (data.title || "").trim();
      const cleanTitle = rawTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim();

      let year: number | undefined;
      if (data.release_date) {
        const y = parseInt(String(data.release_date).slice(0, 4), 10);
        if (!Number.isNaN(y)) year = y;
      }

      let duration: string | undefined;
      if (data.runtime) {
        const mins = Math.round(parseFloat(data.runtime));
        if (!Number.isNaN(mins) && mins > 0) duration = `${mins} min`;
      }

      return {
        title: cleanTitle || rawTitle || undefined,
        original_title: data.original_title || undefined,
        description: data.overview || undefined,
        poster_url: absImage(data.images?.poster),
        banner_url: absImage(data.images?.backdrop),
        rating: data.rating !== undefined && data.rating !== null ? parseFloat(data.rating) : undefined,
        year,
        duration,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extrae metadatos de una página de detalle.
   * Fuente primaria: API interna de la SPA (sitio renderizado en React).
   * Fallbacks: meta tags OpenGraph, JSON-LD (breadcrumb con año) y regex sobre el HTML.
   */
  private async extractMetadata(html: string, url: string): Promise<{
    title: string;
    original_title?: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    rating: number;
    year: number;
    genres: string[];
    duration?: string;
    content_type: ContentKind;
  }> {
    const $ = cheerio.load(html);

    // --- Fuente primaria: API interna ---
    const api = await this.fetchInternalMetadata(url);

    // Título (fallbacks: API > og:title > h1)
    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1").first().text().trim();

    // Año: API > patrón "(YYYY)" en og:title/breadcrumb JSON-LD > regex legacy
    let year = api?.year ?? 0;
    if (!year) {
      const breadcrumbName = html.match(/"ListItem","position":2,"name":"[^"]*?\((\d{4})\)"/i)?.[1];
      const parenYear = ogTitle.match(/\((\d{4})\)/)?.[1] || breadcrumbName;
      const yearMatch =
        parenYear ||
        html.match(/Año[\s:]*(\d{4})/i)?.[1] ||
        html.match(/release_date[\s:]*["'](\d{4})/i)?.[1];
      year = yearMatch ? parseInt(yearMatch, 10) : 0;
    }

    // Título original: API > patrón legacy del og:title
    const originalTitleFromOg = ogTitle.match(/Pelicula\s+(.+?)\s*\(\d{4}\)/i)?.[1];
    const original_title = api?.original_title || originalTitleFromOg || undefined;

    const title = api?.title || (ogTitle.replace(/\s*\(\d{4}\)\s*/, " ").replace(/\s*\|\s*LaMovie\s*$/i, "").trim()) || h1Title || "Contenido LaMovie";

    // Descripción
    const ogDesc = api?.description ||
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      $(".overview, .sinopsis, .description").first().text().trim() ||
      "";

    // Poster/Banner
    const ogImage = $('meta[property="og:image"]').attr("content");
    const posterUrl = api?.poster_url || (ogImage ? this.resolveRelativeUrl(ogImage, url) : undefined);
    const bannerUrl = api?.banner_url || posterUrl;

    // Rating (API > IMDb)
    const ratingMatch = html.match(/IMDb[\s:]*([\d.]+)/i) || html.match(/rating[\s:]*([\d.]+)/i);
    const rating = api?.rating ?? (ratingMatch ? parseFloat(ratingMatch[1]) : 7.0);

    // Géneros (el HTML crudo es una SPA vacía; quedará [] si la API no los expone por nombre)
    const genres: string[] = [];
    $("a[href*='/genero/'], .genres a, .meta-genres a").each((_, el) => {
      const genre = $(el).text().trim();
      if (genre && !genres.includes(genre)) {
        genres.push(genre);
      }
    });

    // Duración
    const durationMatch = html.match(/Duración[\s:]*([\d]+\s*min)/i);
    const duration = api?.duration || (durationMatch ? durationMatch[1] : undefined);

    // Tipo de contenido
    const content_type = url.includes("/series/") ? "series" :
      url.includes("/animes/") ? "anime" : "movie";

    return {
      title,
      original_title,
      description: ogDesc,
      poster_url: posterUrl,
      banner_url: bannerUrl,
      rating,
      year,
      genres,
      duration,
      content_type,
    };
  }

  /**
   * Resuelve un iframe de reproductor desofuscando el JS interno
   */
  public async resolveIframeStream(iframeUrl: string, referer: string = "https://lamovie.org/"): Promise<string[]> {
    try {
      const html = await this.fetchHtml(iframeUrl, 7500, {
        Referer: referer,
        "User-Agent": COMMON_HEADERS["User-Agent"],
      });

      if (!html) return [];

      // Desofuscar todo el HTML
      const unpacked = unpackGeneric(html);
      const urls = extractMediaUrlsFromCode(unpacked);

      // Filtrar URLs válidas
      return urls.filter(url =>
        url.includes(".m3u8") || url.includes(".mp4") || url.includes(".webm")
      );
    } catch {
      return [];
    }
  }

  /**
   * Extrae streams de video usando la API interna de LaMovie.
   * Cadena resiliente: Post ID del HTML (shortlink) > API interna single (`_id`) >
   * extracción genérica de embeds del HTML. Nunca lanza excepción.
   */
  public async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();

    try {
      const html = await this.fetchHtml(cleanUrl, 10000);

      // Extraer Post ID: shortlink en HTML > campo `_id` de la API interna
      let postId = html ? this.extractPostId(html) : null;
      if (!postId) {
        postId = await this.fetchPostIdFromInternalApi(cleanUrl);
      }

      let embedUrls: string[] = [];
      const downloadUrls: string[] = [];

      if (postId && html) {
        // Consultar API de reproductor
        const playerApiUrl = `https://lamovie.org/wp-api/v1/player?postId=${postId}&demo=0`;
        const playerRes = await this.fetchHtml(playerApiUrl, 7500, {
          Referer: cleanUrl,
          "User-Agent": COMMON_HEADERS["User-Agent"],
        });

        if (playerRes) {
          try {
            const playerData = JSON.parse(playerRes);
            const embeds = playerData?.data?.embeds || playerData?.embeds || [];
            embeds.forEach((e: any) => {
              if (e.url && typeof e.url === "string") {
                embedUrls.push(e.url.trim());
              }
            });
            const downloads = playerData?.data?.downloads || playerData?.downloads || [];
            downloads.forEach((d: any) => {
              if (d.url && typeof d.url === "string") {
                let u = d.url.trim();
                if (u.includes("mega.nz")) {
                  u = u.replace("mega.nz/file/", "mega.nz/embed/").replace("mega.nz/#!", "mega.nz/embed/#!");
                }
                if (/^https?:\/\//i.test(u)) {
                  downloadUrls.push(u);
                }
              }
            });
          } catch {}
        }
      }

      // Fallback: extraer embeds directamente del HTML (SPA shell o player API caída)
      if (embedUrls.length === 0 && html) {
        try {
          const $ = cheerio.load(html);
          const rawEmbeds = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl);
          for (const raw of rawEmbeds) {
            if (raw.includes(".m3u8") || raw.includes(".mp4")) {
              if (!embedUrls.includes(raw)) embedUrls.push(raw);
            } else if (!downloadUrls.some((d) => d === raw)) {
              if (!embedUrls.includes(raw)) embedUrls.push(raw);
            }
          }
        } catch {}
      }

      if (html) {
        // Completar con descargas HTTP directas si faltan alternativas
        for (const dl of downloadUrls) {
          if (!embedUrls.includes(dl)) embedUrls.push(dl);
        }
      }

      const isDownloadHost = (u: string) =>
        LaMovieAdapter.DOWNLOAD_HOSTS.some((h) => u.toLowerCase().includes(h));

      // Resolver iframes en paralelo preservando el orden original (los hosts
      // muertos queman su timeout sin bloquear a los vivos). Los hosts de
      // descarga (páginas HTML, no video) se excluyen del resultado.
      const resolved = await Promise.all(
        embedUrls.map(async (embedUrl) => {
          const isDownload = isDownloadHost(embedUrl);
          const isEmbedPage =
            !embedUrl.includes(".m3u8") &&
            !embedUrl.includes(".mp4") &&
            !embedUrl.startsWith("magnet:") &&
            !isDownload;

          let direct: string | null = null;
          if (isEmbedPage) {
            if (VimeosResolver.isVimeosUrl(embedUrl)) {
              const urls = await VimeosResolver.resolveVimeos(embedUrl);
              if (urls.length > 0) direct = urls[0];
            } else {
              const meta = await EmbedResolvers.resolveWithMeta(embedUrl);
              if (meta.resolved && meta.url && !EmbedResolvers.isPlaceholderUrl(meta.url)) {
                direct = meta.url;
              }
            }
          }

          return { embedUrl, isDownload, direct };
        })
      );

      const directStreams: string[] = [];
      const embedStreams: string[] = [];
      for (const { embedUrl, isDownload, direct } of resolved) {
        if (isDownload) continue;

        if (direct && !LaMovieAdapter.isDeadOrBlocked(direct) && !directStreams.includes(direct)) {
          directStreams.push(direct);
        }

        if (!LaMovieAdapter.isDeadOrBlocked(embedUrl) && !embedStreams.includes(embedUrl)) {
          embedStreams.push(embedUrl);
        }
      }

      // Extraer título
      let title: string | undefined;
      if (html) {
        const $ = cheerio.load(html);
        title =
          $("h1").first().text().trim() ||
          $('meta[property="og:title"]').attr("content") ||
          $("title").text().trim() ||
          undefined;
      }

      // Defecto #5: filtrar fuentes no reproducibles (.rar/.zip de MediaFire,
      // páginas crudas) antes de exponerlas al player o a la BD.
      const playableDirects = LaMovieAdapter.filterPlayableSources(directStreams);
      const directFamilies = new Set(playableDirects.map((u) => familyKeyOfStreamUrl(u)));

      // Omitir embeds redundantes cuando ya existe un stream directo del mismo proveedor (ej. Goodstream, Vimeos)
      const playableEmbeds = LaMovieAdapter.filterPlayableSources(embedStreams)
        .filter((u) => !directFamilies.has(familyKeyOfStreamUrl(u)));

      const rawFinal =
        playableDirects.length > 0
          ? [...playableDirects, ...playableEmbeds]
          : playableEmbeds;

      // Normalizar y deduplicar Mega por File ID
      const seenMegaIds = new Set<string>();
      const finalStreams: string[] = [];
      for (const u of rawFinal) {
        if (u.includes("mega.nz/")) {
          const m = u.match(/mega\.nz\/(?:embed\/|file\/|#!)?([A-Za-z0-9_-]{8,})/i);
          const fileId = m ? m[1] : u;
          if (seenMegaIds.has(fileId)) continue;
          seenMegaIds.add(fileId);
          if (u.includes("mega.nz/file/")) {
            finalStreams.push(u.replace("mega.nz/file/", "mega.nz/embed/"));
          } else {
            finalStreams.push(u);
          }
        } else {
          finalStreams.push(u);
        }
      }

      // Enfoque infalible: máximo 2 servidores de máxima calidad por proveedor
      const directMedia = finalStreams.filter((u) => /\.(m3u8|mp4|webm)(\?|#|$)/i.test(u));
      const backupEmbeds = finalStreams.filter((u) => !directMedia.includes(u));
      
      const topStreams: string[] = [];
      if (directMedia.length > 0) {
        topStreams.push(directMedia[0]);
        if (directMedia.length > 1) {
          topStreams.push(directMedia[1]);
        } else if (backupEmbeds.length > 0) {
          topStreams.push(backupEmbeds[0]);
        }
      } else {
        topStreams.push(...backupEmbeds.slice(0, 2));
      }

      const resultStreams = topStreams.length > 0 ? topStreams : finalStreams.slice(0, 2);

      return {
        stream_url: resultStreams[0] || "",
        all_available_streams: resultStreams,
        title: title || undefined,
      };
    } catch {
      return {
        stream_url: "",
        all_available_streams: [],
      };
    }
  }

  /**
   * Analiza una URL de LaMovie (catálogo, detalle o stream)
   */
  public async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();
    const urlObj = new URL(cleanUrl);
    const path = urlObj.pathname.toLowerCase().replace(/\/$/, "");

    // Determinar tipo de contenido. En URLs del API de listado (wp-api/v1/listing/...)
    // el bucket lo selecciona el query ?postType= (verificado con curl, 2026-08-24):
    // tvshows→series, animes→anime, movies→movie. El path decide solo en fichas.
    const postTypeParam = (urlObj.searchParams.get("postType") || "").toLowerCase();
    let contentType: ContentKind;
    if (postTypeParam === "tvshows") {
      contentType = "series";
    } else if (postTypeParam === "animes") {
      contentType = "anime";
    } else {
      const isSeries = path.includes("/series") || path.includes("/tvshows");
      const isAnime = path.includes("/animes") || path.includes("/anime");
      contentType = isSeries ? "series" : isAnime ? "anime" : "movie";
    }

    // Extraer número de página si existe (ej. ?page=2 o /page/2)
    const pageParam = urlObj.searchParams.get("page") || cleanUrl.match(/\/page\/(\d+)/)?.[1] || "1";
    const pageNum = Math.max(1, parseInt(pageParam, 10) || 1);

    // 1. Si es una URL de catálogo (ej: /peliculas, /series, /animes, /, ?page=...) o explicitType === "catalog"
    const isCatalog =
      explicitType === "catalog" ||
      path === "" ||
      path === "/" ||
      path === "/peliculas" ||
      path === "/series" ||
      path === "/animes" ||
      path.match(/^\/(?:peliculas|series|animes)\/page\/\d+/i) !== null ||
      urlObj.searchParams.has("page");

    if (isCatalog) {
      // API de listado primero: trae overview/genres/imdb_rating por item
      // (imports pre-enriquecidos). Sitemap como respaldo si el API falla.
      const fromApi = await this.extractCatalogFromListingApi(contentType, pageNum);
      let catalogItems = fromApi || [];
      if (catalogItems.length === 0) {
        catalogItems = (await this.extractCatalogFromSitemap(contentType, pageNum)) || [];
      }
      // Solo es fallo de fetch (no fin de catálogo) si AMBOS endpoints fallaron.
      if (catalogItems.length === 0 && fromApi === null && explicitType === "catalog") {
        throw new Error(`FETCH_FAILED: ${cleanUrl}`);
      }
      const titleType = contentType === "movie" ? "Películas" : contentType === "series" ? "Series" : "Animes";
      return {
        page_type: "catalog",
        content_type: contentType,
        title: `Catálogo de ${titleType} - LaMovie (Pág ${pageNum})`,
        description: `Catálogo de ${titleType} en LaMovie (${catalogItems.length} títulos disponibles)`,
        poster_url: null,
        banner_url: null,
        rating: 8.0,
        year: 0,
        status: "Publicado",
        genres: [titleType, "Directorio"],
        source_domain: "lamovie.org",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Si es una URL de detalle (página individual)
    const html = await this.fetchHtml(cleanUrl, 10000);
      if (!html) {
        return {
        page_type: "detail",
        content_type: contentType as ContentKind,
        title: "Contenido LaMovie",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: 0,
        status: "Desconocido",
        genres: [],
        source_domain: "lamovie.org",
        episodes: [],
        catalog_items: [],
      };
    }

    // Extraer metadatos
    const metadata = await this.extractMetadata(html, cleanUrl);

    // Extraer episodios (si es serie/anime, extraer la lista; si es película, generar episodio 1 con la URL de la película)
    const episodes =
      contentType === "series" || contentType === "anime"
        ? await this.buildEpisodeList(html, cleanUrl, { title: metadata.title, year: metadata.year })
        : [{ number: 1, title: metadata.title || "Película Completa", url: cleanUrl }];

    // Extraer streams (siempre en analyze para que el frontend tenga las URLs disponibles)
    let detectedStreams: string[] = [];
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        const streamResult = await this.extractStream(cleanUrl);
        detectedStreams = streamResult.all_available_streams;
      } catch {}
    }

    return {
      page_type: "detail",
      content_type: metadata.content_type,
      title: metadata.title,
      original_title: metadata.original_title,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: metadata.rating,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      duration: metadata.duration || null,
      source_domain: "lamovie.org",
      detected_streams: detectedStreams.length > 0 ? detectedStreams : undefined,
      episodes,
      catalog_items: [],
      raw_metadata: {
        og: {
          title: metadata.title,
          description: metadata.description,
          image: metadata.poster_url || "",
        },
      },
    };
  }
}
