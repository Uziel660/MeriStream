import * as cheerio from "cheerio";
import { BaseScraperAdapter } from "../BaseAdapter";
import { UniversalAnalysisResult, ContentKind, ExtractedEpisode, ExtractedCatalogItem } from "../../types";
import { EmbedResolvers } from "../../resolvers";
import { MediaValidator } from "../../validator";

const BASE_URL = "https://tioanime.com";

/**
 * Hosts de video muertos o irrecuperables verificados en vivo (2026-08-22):
 * - cfglobalcdn.com: cert Cloudflare Origin CA no confiable + token secip atado a otra IP;
 *   la conexión TLS se cierra abruptamente (curl exit 56/60).
 * - vidcache.net: StretchFS exige handshake propietario; además ya no aparece en las
 *   páginas actuales del sitio (solo sobrevive en ingestas viejas guardadas en BD).
 * - v.tioanime.com (Amus/Mepu): /embed.php responde 404.
 * - my.mail.ru (Maru): embeds responden 404.
 */
const DEAD_HOST_PATTERNS = [
  /cfglobalcdn\.com/i,
  /vidcache\.net/i,
  /v\.tioanime\.com\/embed\.php/i,
  /my\.mail\.ru\/video\/embed/i,
  /yourupload\.com/i,
  /streamtape\.com/i,
  /dsvplay\.com/i,
  /savefiles\.com/i,
  /d-s\.io/i,
  /a\d+\.mp4upload\.com/i,
];

/**
 * Adaptador para tioanime.com
 *
 * - Catálogo: selector `<article>` con href, title (h3/title/alt), image_url (data-src o src)
 * - Metadatos: og:title y <p class="sinopsis"> (fallback og:description, .sinopsis, p.description)
 * - Video: array global `var videos = [["Mega","https://..."],["Voe","..."]];` parseado vía regex JSON
 * - Episodios: a[href*="/ver/"] o a[href*="/anime/"] con episodio, o lista .episodes
 * - VOE: decodifica el blob JSON ofuscado del player moderno (rot13+pares+b64+shift+reverse)
 *   para obtener el .m3u8 directo y evitar el iframe con publicidad.
 * - cfglobalcdn/vidcache se descartan: hosts muertos documentados (cert Cloudflare Origin CA
 *   inválido + token secip de otra IP / handshake StretchFS propietario).
 */
export class TioAnimeAdapter extends BaseScraperAdapter {
  readonly id = "tioanime";
  readonly name = "TioAnime";
  readonly supportedDomains = ["tioanime.com", "www.tioanime.com"];

  canHandle(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes("tioanime.com");
  }

  /**
   * Búsqueda de animes en tioanime.com
   * Intenta /directorio?q= , /?s= y fallback a /directorio con filtrado local
   */
  public async search(query: string): Promise<ExtractedCatalogItem[]> {
    const q = query.trim();
    if (!q) return [];

    const candidates = [
      `${BASE_URL}/directorio?q=${encodeURIComponent(q)}`,
      `${BASE_URL}/?s=${encodeURIComponent(q)}`,
      `${BASE_URL}/directorio?search=${encodeURIComponent(q)}`,
    ];

    for (const url of candidates) {
      const html = await this.fetchHtml(url, 10000);
      if (!html) continue;
      const items = this.extractCatalogItems(html);
      if (items.length > 0) {
        const lowerQ = q.toLowerCase();
        const filtered = items.filter((i) => i.title.toLowerCase().includes(lowerQ));
        return filtered.length > 0 ? filtered : items;
      }
    }

    // Fallback: fetch directorio completo y filtrar localmente
    const html = await this.fetchHtml(`${BASE_URL}/directorio`, 10000);
    if (!html) return [];
    const all = this.extractCatalogItems(html);
    if (all.length === 0) return [];
    const lowerQ = q.toLowerCase();
    const filtered = all.filter((i) => i.title.toLowerCase().includes(lowerQ));
    return filtered.length > 0 ? filtered : all.slice(0, 20);
  }

  /**
   * Extrae items de catálogo desde HTML.
   * Prioridad: <article>  (especificación estricta)
   */
  public extractCatalogItems(html: string): ExtractedCatalogItem[] {
    const $ = cheerio.load(html);
    const items: ExtractedCatalogItem[] = [];
    const seen = new Set<string>();

    $("article").each((_, el) => {
      const $article = $(el);

      // href: buscar primer anchor con href dentro del article
      let href = $article.find("a").first().attr("href") || $article.attr("href") || "";
      // Algunos themes ponen el link en el propio article o en h3 > a
      if (!href) {
        href = $article.find("a[href]").first().attr("href") || "";
      }
      if (!href || seen.has(href)) return;

      // Normalizar URL relativa
      const fullUrl = this.resolveRelativeUrl(href.trim(), BASE_URL);
      if (!fullUrl || seen.has(fullUrl)) return;
      seen.add(fullUrl);
      seen.add(href);

      const $img = $article.find("img").first();
      const rawImg = $img.attr("data-src") || $img.attr("src") || "";
      const imageUrl = rawImg ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL) : null;

      const h3Title = $article.find("h3").first().text().trim();
      const titleAttr = ($article.attr("title") || "").trim();
      const altTitle = ($img.attr("alt") || "").trim();
      const anchorText = $article.find("a").first().text().trim();
      const title =
        h3Title ||
        titleAttr ||
        altTitle ||
        anchorText ||
        this.titleFromSlug(fullUrl);

      if (!title || title.length < 2) return;
      const lower = title.toLowerCase();
      if (["inicio", "home", "directorio", "dMCA", "contacto", "login"].some((b) => lower.includes(b.toLowerCase()))) {
        // filtrar ruido de nav pero permitir si es realmente un anime cuyo título coincida
        if (title.length < 15) return;
      }

      items.push({
        title: title.replace(/\s+/g, " ").trim(),
        url: fullUrl,
        image_url: imageUrl,
        kind: "anime" as ContentKind,
      });
    });

    // Fallback genérico si no se encontraron <article> (robustez)
    if (items.length === 0) {
      const fallbackSelectors = [
        "a[href*='/anime/']",
        ".anime-card a",
        ".card a",
        ".item a",
        "ul.ListAnimes a",
        ".list-animes a",
      ];
      for (const sel of fallbackSelectors) {
        $(sel).each((_, el) => {
          const href = $(el).attr("href");
          if (!href || seen.has(href)) return;
          const fullUrl = this.resolveRelativeUrl(href.trim(), BASE_URL);
          if (seen.has(fullUrl)) return;
          seen.add(fullUrl);
          seen.add(href);
          const $link = $(el);
          const $img = $link.find("img").first();
          const rawImg = $img.attr("data-src") || $img.attr("src") || "";
          const imageUrl = rawImg ? this.resolveRelativeUrl(rawImg.trim(), BASE_URL) : null;
          const title =
            $link.find("h3").first().text().trim() ||
            ($img.attr("alt") || "").trim() ||
            $link.text().trim() ||
            $link.attr("title")?.trim() ||
            this.titleFromSlug(fullUrl);
          if (!title) return;
          items.push({
            title: title.replace(/\s+/g, " ").trim(),
            url: fullUrl,
            image_url: imageUrl,
            kind: "anime",
          });
        });
        if (items.length > 0) break;
      }
    }

    return items;
  }

  /**
   * Metadatos de página de detalle usando OpenGraph y sinopsis
   */
  public extractMetadata(
    html: string,
    url: string
  ): {
    title: string;
    description: string;
    poster_url?: string;
    banner_url?: string;
    genres: string[];
    year: number;
    content_type: ContentKind;
  } {
    const $ = cheerio.load(html);

    const ogTitle = $('meta[property="og:title"]').attr("content") || "";
    const h1Title = $("h1").first().text().trim();
    const title =
      ogTitle.replace(/\s*[-–—]\s*TioAnime\s*$/i, "").trim() ||
      h1Title ||
      $("title").text().trim() ||
      this.titleFromSlug(url);

    let ogImage = $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content") || "";
    // Fallback a thumb / portada si no hay og:image (caso TioAnime)
    if (!ogImage) {
      const thumbImg =
        $(".thumb img").first().attr("src") ||
        $("figure img").first().attr("src") ||
        $("img").first().attr("src") ||
        "";
      if (thumbImg) ogImage = thumbImg;
    }
    const poster_url = ogImage ? this.resolveRelativeUrl(ogImage.trim(), url) : undefined;

    const ogDesc = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "";

    const sinopsis =
      $("p.sinopsis").first().text().trim() ||
      $(".sinopsis").first().text().trim() ||
      $("p.description").first().text().trim() ||
      $(".description").first().text().trim() ||
      "";

    const description = sinopsis || ogDesc || "";

    const genres: string[] = [];
    $("a[href*='/genero/'], .genres a, .meta-genres a, p.genres a").each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });

    // Extracción robusta de año (evita capturar solo "20" de regex con grupo)
    let year: number | null = null;
    const yearCandidates: (RegExpMatchArray | null)[] = [
      html.match(/Año[\s:]*(\d{4})/i),
      html.match(/<span class="year">(\d{4})<\/span>/i),
      description.match(/\b(19|20)\d{2}\b/),
      html.match(/"year"\s*:\s*"?(\d{4})"?/i),
      html.match(/\b(19|20)\d{2}\b/),
    ];
    for (const m of yearCandidates) {
      if (m) {
        const candidate = m[0].match(/\b(19|20)\d{2}\b/)?.[0] || m[1];
        if (candidate) {
          const parsed = parseInt(candidate, 10);
          if (!isNaN(parsed) && parsed > 1900 && parsed < 2100) {
            year = parsed;
            break;
          }
        }
      }
    }
    if (year === null) year = new Date().getFullYear();

    return {
      title,
      description,
      poster_url,
      banner_url: poster_url,
      genres,
      year: isNaN(year) ? new Date().getFullYear() : year,
      content_type: "anime",
    };
  }

  /**
   * Lista de episodios: soporta JS `var anime_info` + `var episodes` (TioAnime) y fallback DOM
   * TioAnime inyecta: var anime_info = ["id","slug","Title"]; var episodes = [220,...,1];
   * URLs se generan como /ver/${slug}-${num}  (ej. /ver/naruto-1)
   */
  public extractEpisodes(html: string, baseUrl: string): ExtractedEpisode[] {
    // 1. Intentar parsear variables JS de TioAnime (más fiable que DOM vacío)
    const animeInfoMatch = html.match(/var\s+anime_info\s*=\s*(\[.*?\]);/s);
    const episodesMatch = html.match(/var\s+episodes\s*=\s*(\[.*?\]);/s);
    if (animeInfoMatch && episodesMatch) {
      try {
        const animeInfo: unknown = JSON.parse(animeInfoMatch[1].replace(/'/g, '"'));
        const episodesArr: unknown = JSON.parse(episodesMatch[1]);
        if (Array.isArray(animeInfo) && Array.isArray(episodesArr)) {
          const slug = typeof animeInfo[1] === "string" ? animeInfo[1] : "";
          const titleBase = typeof animeInfo[2] === "string" ? animeInfo[2] : "Episodio";
          if (slug && episodesArr.length > 0) {
            const episodes: ExtractedEpisode[] = [];
            const seenNums = new Set<number>();
            for (const raw of episodesArr) {
              const num = Number(raw);
              if (isNaN(num) || seenNums.has(num)) continue;
              seenNums.add(num);
              const url = this.resolveRelativeUrl(`/ver/${slug}-${num}`, baseUrl);
              episodes.push({
                number: num,
                title: `${titleBase} Episodio ${num}`,
                url,
                server_name: "TioAnime",
              });
            }
            if (episodes.length > 0) return episodes.sort((a, b) => a.number - b.number);
          }
        }
      } catch {}
      // Fallback manual si JSON.parse falla: extraer números con regex
      try {
        const numsStr = episodesMatch[1];
        const nums = [...numsStr.matchAll(/\d+/g)].map((m) => parseInt(m[0], 10));
        const slugMatch = animeInfoMatch[1].match(/"([^"]+)"/g);
        const slug = slugMatch && slugMatch[1] ? slugMatch[1].replace(/"/g, "") : "";
        if (nums.length > 0 && slug) {
          const episodes: ExtractedEpisode[] = nums.map((n) => ({
            number: n,
            title: `Episodio ${n}`,
            url: this.resolveRelativeUrl(`/ver/${slug}-${n}`, baseUrl),
            server_name: "TioAnime",
          }));
          if (episodes.length > 0) return episodes.sort((a, b) => a.number - b.number);
        }
      } catch {}
    }

    // 2. Fallback DOM: a[href*="/ver/"] o a[href*="/anime/"] con episodio, o lista .episodes
    const $ = cheerio.load(html);
    const episodes: ExtractedEpisode[] = [];
    const seen = new Set<string>();

    const selectors = [
      "a[href*='/ver/']",
      ".episodes a",
      ".episodes-list a",
      ".episode-list a",
      "ul.episodes li a",
      "li.episode a",
      ".capitulos-list a",
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        const href = $(el).attr("href");
        if (!href || seen.has(href)) return;
        const fullUrl = this.resolveRelativeUrl(href.trim(), baseUrl);
        if (seen.has(fullUrl)) return;
        seen.add(href);
        seen.add(fullUrl);

        const linkText = $(el).text().replace(/\s+/g, " ").trim();
        const titleAttr = $(el).attr("title")?.trim() || "";

        let number: number | null = null;
        // TioAnime usa /ver/slug-123  -> capturar tras último guion
        const urlNumMatch =
          fullUrl.match(/-episodio-(\d+)/i) ||
          fullUrl.match(/-(\d+)(?:\/|$)/) ||
          fullUrl.match(/\/(\d+)(?:\/|$)/);
        if (urlNumMatch) number = parseInt(urlNumMatch[1], 10);

        if (number === null) {
          const textNumMatch = (linkText || titleAttr).match(/(?:episodio|capitulo|cap\.?|ep\.?)\s*(\d+)/i);
          if (textNumMatch) number = parseInt(textNumMatch[1], 10);
        }

        if (number === null || isNaN(number)) {
          number = episodes.length + 1;
        }

        const textTitle = linkText || titleAttr || `Episodio ${number}`;
        const isAnimeLink = href.includes("/anime/");
        if (isAnimeLink && !/episodio|capitulo|\/ver\//i.test(href) && !/episodio|capitulo/i.test(linkText)) {
          return;
        }

        episodes.push({
          number,
          title: textTitle,
          url: fullUrl,
          server_name: "TioAnime",
        });
      });
    }

    if (episodes.length === 0) {
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") || "";
        if (!href || seen.has(href)) return;
        if (!/episodio|capitulo|\/ver\//i.test(href) && !/episodio|capitulo/i.test($(el).text())) return;
        const fullUrl = this.resolveRelativeUrl(href.trim(), baseUrl);
        if (seen.has(fullUrl)) return;
        seen.add(href);
        seen.add(fullUrl);
        const linkText = $(el).text().replace(/\s+/g, " ").trim();
        const numMatch = linkText.match(/(\d+)/) || href.match(/-(\d+)(?:\/|$)/) || href.match(/(\d+)/);
        const number = numMatch ? parseInt(numMatch[1], 10) : episodes.length + 1;
        episodes.push({
          number,
          title: linkText || `Episodio ${number}`,
          url: fullUrl,
          server_name: "TioAnime",
        });
      });
    }

    return episodes.sort((a, b) => a.number - b.number);
  }

  /**
   * Extrae el array global `var videos = [["Server","https://..."], ...]`
   * Maneja escaped slashes `\/` y comillas
   */
  public extractVideosArray(html: string): string[] {
    const streams: string[] = [];

    // Regex robusto para var videos = [[ ... ]];
    const regex = /var\s+videos\s*=\s*(\[[\s\S]*?\])\s*;/;
    const match = html.match(regex);

    if (match && match[1]) {
      let rawJson = match[1].trim();

      // Manejar escaped slashes: https:\/\/mega.nz -> https://mega.nz
      // JSON.parse ya maneja \/ pero por si viene doble escapado
      rawJson = rawJson.replace(/\\\//g, "/");

      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (Array.isArray(entry) && entry.length >= 2) {
              const url = entry[1];
              if (typeof url === "string" && url.trim().startsWith("http")) {
                const clean = url.replace(/\\/g, "").trim();
                if (!streams.includes(clean)) streams.push(clean);
              }
            } else if (typeof entry === "string" && entry.startsWith("http")) {
              const clean = entry.replace(/\\/g, "").trim();
              if (!streams.includes(clean)) streams.push(clean);
            }
          }
        }
        if (streams.length > 0) return streams;
      } catch {
        // fallback manual si JSON.parse falla (ej. comillas simples)
      }

      // Fallback: extraer URLs directamente con regex sobre el array crudo
      const urlRegex = /https?:\/\/[^"'\s<>]+/g;
      const urlMatches = rawJson.match(urlRegex);
      if (urlMatches) {
        for (const m of urlMatches) {
          const clean = m.replace(/\\/g, "").replace(/["']+$/, "").trim();
          if (clean.startsWith("http") && !streams.includes(clean)) {
            streams.push(clean);
          }
        }
        if (streams.length > 0) return streams;
      }

      // Intento con comillas simples -> dobles
      try {
        const singleToDouble = rawJson.replace(/'/g, '"');
        const parsed2: unknown = JSON.parse(singleToDouble);
        if (Array.isArray(parsed2)) {
          for (const entry of parsed2) {
            if (Array.isArray(entry) && entry.length >= 2 && typeof entry[1] === "string") {
              const clean = entry[1].replace(/\\/g, "").trim();
              if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
            }
          }
        }
      } catch {}
    }

    // Segundo intento: sin var, solo `videos = [...]`
    if (streams.length === 0) {
      const altRegex = /videos\s*=\s*(\[[\s\S]*?\])\s*;/;
      const altMatch = html.match(altRegex);
      if (altMatch && altMatch[1]) {
        const urlRegex = /https?:\/\/[^"'\s<>]+/g;
        const urlMatches = altMatch[1].match(urlRegex);
        if (urlMatches) {
          for (const m of urlMatches) {
            const clean = m.replace(/\\/g, "").trim();
            if (clean.startsWith("http") && !streams.includes(clean)) streams.push(clean);
          }
        }
      }
    }

    return streams;
  }

  public async analyze(
    input: string,
    explicitType?: "auto" | "catalog" | "detail" | "stream"
  ): Promise<UniversalAnalysisResult> {
    const cleanUrl = input.trim();

    // Validar que sea URL
    let path = "";
    try {
      const urlObj = new URL(cleanUrl);
      path = urlObj.pathname.toLowerCase();
    } catch {
      // Si no es URL válida, tratar como búsqueda -> devolver catálogo via search
      if (explicitType === "catalog" || cleanUrl.length < 100) {
        const catalogItems = await this.search(cleanUrl);
        return {
          page_type: "catalog",
          content_type: "anime",
          title: `Resultados para "${cleanUrl}" - TioAnime`,
          description: `Búsqueda de ${catalogItems.length} animes en TioAnime para "${cleanUrl}"`,
          poster_url: catalogItems[0]?.image_url || null,
          banner_url: catalogItems[0]?.image_url || null,
          rating: 0,
          year: new Date().getFullYear(),
          status: "Publicado",
          genres: [],
          source_domain: "tioanime.com",
          episodes: [],
          catalog_items: catalogItems,
        };
      }
      // fallback detail vacío
      return {
        page_type: "detail",
        content_type: "anime",
        title: "Anime TioAnime",
        description: "URL inválida",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Desconocido",
        genres: [],
        source_domain: "tioanime.com",
        episodes: [],
        catalog_items: [],
      };
    }

    // 1. Modo catálogo: Home, /directorio, rutas raíz o petición explícita
    if (
      explicitType === "catalog" ||
      path === "/" ||
      path === "/directorio" ||
      path === "/directorio/" ||
      /^\/(directorio|browse|letra|emision)?\/?$/.test(path)
    ) {
      // Intentar directorio primero, fallback a BASE_URL
      let html = await this.fetchHtml(`${BASE_URL}/directorio`, 10000);
      if (!html) html = await this.fetchHtml(BASE_URL, 10000);
      const catalogItems = html ? this.extractCatalogItems(html) : [];

      return {
        page_type: "catalog",
        content_type: "anime",
        title: "Catálogo de Animes - TioAnime",
        description: `Catálogo completo de animes en TioAnime (${catalogItems.length} títulos)`,
        poster_url: catalogItems[0]?.image_url || null,
        banner_url: catalogItems[0]?.image_url || null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Publicado",
        genres: [],
        source_domain: "tioanime.com",
        episodes: [],
        catalog_items: catalogItems,
      };
    }

    // 2. Modo detalle
    const html = await this.fetchHtml(cleanUrl, 10000);
    if (!html) {
      return {
        page_type: "detail",
        content_type: "anime",
        title: "Anime TioAnime",
        description: "No se pudo cargar la página",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "Desconocido",
        genres: [],
        source_domain: "tioanime.com",
        episodes: [],
        catalog_items: [],
      };
    }

    if (this.isErrorPage(html)) {
      // Página de error (slug inexistente): estado limpio en vez de contenido basura
      return {
        page_type: "detail",
        content_type: "anime",
        title: "Anime TioAnime",
        description: "Contenido no encontrado en TioAnime",
        poster_url: null,
        banner_url: null,
        rating: 0,
        year: new Date().getFullYear(),
        status: "No encontrado",
        genres: [],
        source_domain: "tioanime.com",
        episodes: [],
        catalog_items: [],
        detected_streams: undefined,
      };
    }

    const metadata = this.extractMetadata(html, cleanUrl);
    const episodes = this.extractEpisodes(html, cleanUrl);

    let detectedStreams: string[] | undefined;
    if (!explicitType || explicitType === "stream" || explicitType === "auto") {
      try {
        // Los players viven SOLO en páginas /ver/...; extraer del primer episodio
        // evita que extractVideosArray devuelva la propia URL de detalle.
        const first = episodes[0];
        const target = first ? first.url : cleanUrl;
        const streamResult = await this.extractStream(target);
        detectedStreams = streamResult.all_available_streams;
      } catch {}
    }

    return {
      page_type: "detail",
      content_type: metadata.content_type,
      title: metadata.title,
      description: metadata.description,
      poster_url: metadata.poster_url || null,
      banner_url: metadata.banner_url || null,
      rating: 7.0,
      year: metadata.year,
      status: "Publicado",
      genres: metadata.genres,
      source_domain: "tioanime.com",
      detected_streams: detectedStreams,
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

  /**
   * Detecta la página de error de TioAnime. fetchHtml (BaseAdapter) devuelve el
   * body de respuestas 404 cuando parecen HTML completo (comportamiento necesario
   * para LaMovie/WordPress), así que aquí se filtra por los marcadores del template
   * de error: <title>Error 404 - TioAnime</title> y <h1 class="title">Ups... Prueba de nuevo</h1>.
   * El "404" solo se comprueba dentro del <title> para no dar falsos positivos
   * con episodios cuyo número sea 404.
   */
  private isErrorPage(html: string): boolean {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = (titleMatch ? titleMatch[1] : "").toLowerCase();
    if (/error\s*404|no encontrado|ups\.?\.\.?\s*prueba de nuevo/.test(pageTitle)) return true;

    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const h1Text = (h1Match ? h1Match[1].replace(/<[^>]+>/g, " ") : "").toLowerCase();
    if (/ups/.test(h1Text) && /prueba de nuevo/.test(h1Text)) return true;

    return false;
  }

  /**
   * Extrae streams de video de una página de episodio:
   * 1. Busca `var videos = [[...]]` y parsea JSON
   * 2. Resuelve cada URL con EmbedResolvers
   * 3. Valida con MediaValidator y retorna directo + fallback embed
   */
  public async extractStream(
    targetUrl: string
  ): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const cleanUrl = targetUrl.trim();
    const html = await this.fetchHtml(cleanUrl, 12000);

    if (!html) {
      return { stream_url: cleanUrl, all_available_streams: [cleanUrl] };
    }

    if (this.isErrorPage(html)) {
      // Página de error (slug inexistente): no tratarla como contenido válido
      return { stream_url: "", all_available_streams: [] };
    }

    const $ = cheerio.load(html);
    const title =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.replace(/\s*[-–—]\s*TioAnime\s*$/i, "").trim() ||
      $("title").text().trim() ||
      undefined;

    const videos = this.extractVideosArray(html);

    if (videos.length === 0) {
      // Fallback: extracción genérica de embeds del HTML ya cargado (sin segundo fetch)
      const rawStreams = this.extractEmbedsAndStreamsFromHtml($, html, cleanUrl);

      if (rawStreams.length === 0) {
        return { stream_url: cleanUrl, all_available_streams: [cleanUrl], title };
      }

      const { resolved, originals } = await this.sanitizeAndResolve(rawStreams);

      const combined = [...resolved, ...originals];
      const validStreams = await MediaValidator.validateUrls(combined);
      const finalStreams =
        validStreams.length > 0 ? validStreams : combined.length > 0 ? combined : [cleanUrl];

      return {
        stream_url: finalStreams[0] || cleanUrl,
        all_available_streams: finalStreams,
        title,
      };
    }

    // Array var videos: filtrar hosts muertos + resolver VOE a HLS directo
    const { resolved, originals } = await this.sanitizeAndResolve(videos);

    const allAvailable: string[] = [];
    for (const url of resolved) {
      if (!allAvailable.includes(url)) allAvailable.push(url);
    }
    for (const url of originals) {
      if (!allAvailable.includes(url)) allAvailable.push(url);
    }

    // Resolver el resto con EmbedResolvers (mega file->embed, ok.ru->hls, etc.)
    const withEmbedResolution = await Promise.all(
      allAvailable.map(async (url) => {
        try {
          const r = await EmbedResolvers.resolve(url);
          return r || url;
        } catch {
          return url;
        }
      })
    );

    const merged: string[] = [];
    for (const url of withEmbedResolution) {
      if (!merged.includes(url)) merged.push(url);
    }
    // Re-agregar originales como fallback si su resolución difiere
    for (const url of allAvailable) {
      if (!merged.includes(url)) merged.push(url);
    }

    // Los streams "directos" heredados del sitio (cfglobalcdn/vidcache) ya se descartaron
    // arriba; lo que queda son embeds reproducibles y HLS resueltos (VOE/ok.ru).
    const validated = await MediaValidator.validateUrls(merged);
    const ordered = validated.length > 0 ? validated : merged;

    return {
      stream_url: ordered[0] || cleanUrl,
      all_available_streams: ordered.length > 0 ? ordered : [cleanUrl],
      title,
    };
  }

  private titleFromSlug(url: string): string {
    try {
      const pathname = new URL(url).pathname;
      const parts = pathname.split("/").filter(Boolean);
      const slug = parts[parts.length - 1] || "anime";
      return slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();
    } catch {
      const match = url.match(/\/([^/]+)\/?$/);
      if (!match) return "Anime TioAnime";
      return match[1]
        .replace(/-/g, " ")
        .replace(/\b\w/g, (l) => l.toUpperCase())
        .trim();
    }
  }

  /**
   * Decodificador del player VOE moderno. La página /e/{code} hace redirect JS a un
   * dominio rotativo cuyo HTML trae un <script type="application/json"> con el setup
   * del player ofuscado. Pipeline real extraído de su loader:
   *   rot13 -> reemplazar pares ['@$','^^','~@','%?','*~','!!','#&'] por '_'
   *         -> quitar '_' y concatenar -> base64 decode -> shift -3 por char
   *         -> reverse -> base64 decode -> JSON { source: "<master.m3u8 firmado>", ... }
   * El m3u8 resultante se reproduce nativo (sin iframe, sin publicidad del host).
   */
  private async resolveVoeDirect(iframeUrl: string): Promise<string | null> {
    try {
      let html = await this.fetchHtml(iframeUrl, 8000);
      if (!html) return null;

      // Dominio rotativo: window.location.href = 'https://<rotador>/e/<code>'
      if (!html.includes('type="application/json"')) {
        const redirectMatch = html.match(
          /window\.location\.href\s*=\s*['"](https?:\/\/[^'"]+)['"]/i
        );
        if (redirectMatch && redirectMatch[1] !== iframeUrl) {
          html = await this.fetchHtml(redirectMatch[1], 8000);
          if (!html) return null;
        }
      }

      const blobMatch = html.match(/type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
      if (!blobMatch) return null;
      const blob = blobMatch[1].trim();

      // Paso 1: rot13
      const rot13 = blob.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      });

      // Paso 2+3: pares ofuscados -> '_' -> quitarlos
      const PAIRS = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
      let step2 = rot13;
      for (const pair of PAIRS) {
        step2 = step2.split(pair).join("_");
      }
      step2 = step2.split("_").join("");

      // Paso 4: base64 decode
      const b64decoded = Buffer.from(step2, "base64");

      // Paso 5: shift -3 por charCode
      let shifted = "";
      for (let i = 0; i < b64decoded.length; i++) {
        shifted += String.fromCharCode(b64decoded[i] - 3);
      }

      // Paso 6: reverse + base64 decode -> JSON
      const reversed = shifted.split("").reverse().join("");
      const jsonStr = Buffer.from(reversed, "base64").toString("utf-8");
      const data = JSON.parse(jsonStr) as {
        source?: string;
        direct_access_url?: string;
      };

      if (typeof data.source === "string" && /\.m3u8(\?|$)/.test(data.source)) {
        return data.source;
      }
      if (
        typeof data.direct_access_url === "string" &&
        /\.(m3u8|mp4)(\?|$)/.test(data.direct_access_url)
      ) {
        return data.direct_access_url;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Filtra hosts muertos documentados y resuelve VOE a stream directo.
   * Devuelve [streamsFiltradosYResueltos, embedsOriginalesConservados].
   */
  private async sanitizeAndResolve(streams: string[]): Promise<{
    resolved: string[];
    originals: string[];
  }> {
    const alive = streams.filter((s) => !DEAD_HOST_PATTERNS.some((p) => p.test(s)));
    const deadRemoved = streams.length - alive.length;
    if (deadRemoved > 0) {
      console.log(`[TioAnime] ${deadRemoved} stream(s) descartado(s): host muerto documentado`);
    }

    const resolved: string[] = [];
    const originals: string[] = [];

    await Promise.all(
      alive.map(async (url) => {
        // VOE: intentar decodificación directa antes del resolver genérico
        let finalUrl = url;
        if (/voe\./i.test(url)) {
          const voeDirect = await this.resolveVoeDirect(url);
          if (voeDirect) {
            console.log(`[TioAnime] VOE resuelto a HLS directo: ${voeDirect.slice(0, 80)}...`);
            finalUrl = voeDirect;
          }
        }

        if (!resolved.includes(finalUrl)) resolved.push(finalUrl);

        // Conservar el embed original como fallback cuando difiere del directo
        if (finalUrl !== url && !originals.includes(url)) {
          originals.push(url);
        }
      })
    );

    return { resolved, originals };
  }
}
