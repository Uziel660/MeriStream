import * as cheerio from "cheerio";
import { COMMON_HEADERS } from "../BaseAdapter";
import { GenericAdapter } from "./GenericAdapter";
import { ContentKind, ExtractedCatalogItem, UniversalAnalysisResult } from "../../types";
import { cleanQueryTitle, enrichUniversalMetadata } from "../../metadataEngine";
import { normalizeTitleKey } from "../../utils/titleNormalizer";

type GnulaPlayerPayload = {
  title?: string;
  streams: string[];
};

function titlesCompatible(left: string, right: string): boolean {
  const a = normalizeTitleKey(left);
  const b = normalizeTitleKey(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const at = new Set(a.match(/[a-z0-9]+/g) || []);
  const bt = new Set(b.match(/[a-z0-9]+/g) || []);
  if (at.size === 0 || bt.size === 0) return false;
  let common = 0;
  for (const token of at) if (bt.has(token)) common += 1;
  return common / Math.max(at.size, bt.size) >= 0.6;
}

/**
 * En una ficha GNULA el menú reutiliza enlaces bajo `/ver/` que apuntan al
 * índice de películas/series/anime. Nunca son episodios ni reproductores.
 * El adaptador genérico los veía como el primer episodio cuando el endpoint
 * XOR del player fallaba o tardaba, dejando una URL de catálogo en la BD.
 */
function isGnulaCatalogUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (!/(^|\.)gnulahd\.nu$/i.test(parsed.hostname)) return false;
    return /^\/ver\/(?:peliculas|series|anime)\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isGnulaCatalogRoute(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (!/(^|\.)gnulahd\.nu$/i.test(parsed.hostname)) return false;
    return parsed.pathname === "/"
      || /^\/ver\/(?:peliculas|series|anime)(?:\/|$)/i.test(parsed.pathname)
      || /^\/ver\/page\/\d+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isGnulaDetailUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    if (!/(^|\.)gnulahd\.nu$/i.test(parsed.hostname) || isGnulaCatalogUrl(value)) return false;
    const pathname = parsed.pathname.replace(/\/+$/, "");
    // Fichas de serie/anime antiguas: /ver/<slug>/
    if (/^\/ver\/[^/]+$/i.test(pathname)) return true;
    // Episodios actuales: /<slug>-1x02/ (y fichas de película en raíz).
    return /^\/(?!nuevo(?:\/|$)|wp-json(?:\/|$))[^/]+$/i.test(pathname);
  } catch {
    return false;
  }
}

function isGnulaOverviewUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return /(^|\.)gnulahd\.nu$/i.test(parsed.hostname)
      && /^\/ver\/[^/]+\/?$/i.test(parsed.pathname)
      && !isGnulaCatalogUrl(value);
  } catch {
    return false;
  }
}

function isGnulaPlaceholderStream(value: string | undefined | null): boolean {
  return Boolean(value && /\/wp-content\/uploads\/epix\/aviso\.mp4(?:\?|#|$)/i.test(value));
}

/** Catálogo GNULA: sus fichas viven exclusivamente en enlaces `.gnrd-card`. */
export class GnulaAdapter extends GenericAdapter {
  readonly id = "gnula";
  readonly name = "GNULA (Películas, Series y Anime)";
  readonly supportedDomains = ["gnulahd.nu", "ww3.gnulahd.nu"];

  canHandle(url: string): boolean {
    return /(^|\.)gnulahd\.nu/i.test(new URL(url).hostname);
  }

  /**
   * GNULA no imprime los iframes reales en la ficha. La plantilla deja un
   * aviso.mp4 y, después de una interacción, consulta un endpoint WordPress
   * con un payload XOR/base64. Si no lo resolvemos aquí la app termina
   * guardando/reproduciendo la propia página `/ver/...` como si fuera video.
   */
  private async playerPayload(pageUrl: string): Promise<GnulaPlayerPayload> {
    const empty: GnulaPlayerPayload = { streams: [] };
    const html = await this.fetchHtml(pageUrl, 12000);
    if (!html) return empty;

    const pid = html.match(/_gnrdPid\s*=\s*([0-9]+)/i)?.[1];
    const token = html.match(/_gnrdTok\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!pid || !token) return empty;

    try {
      const page = new URL(pageUrl);
      const endpoint = new URL("/wp-json/gnrd/v1/player", page.origin);
      endpoint.searchParams.set("id", pid);
      endpoint.searchParams.set("t", token);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          signal: controller.signal,
          headers: {
            ...COMMON_HEADERS,
            Accept: "application/json,text/plain,*/*",
            Referer: pageUrl,
          },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) return empty;

      const raw = (await response.json().catch(() => null)) as { p?: unknown } | null;
      if (!raw || typeof raw.p !== "string" || raw.p.length === 0) return empty;

      const packed = Buffer.from(raw.p, "base64");
      const key = [103, 78, 55, 100];
      for (let i = 0; i < packed.length; i += 1) packed[i] ^= key[i % key.length];
      const decoded = JSON.parse(packed.toString("utf8")) as {
        t?: unknown;
        langs?:
          | Array<{ servers?: Array<{ src?: unknown }> }>
          | Record<string, { servers?: Array<{ src?: unknown }> }>;
        dl?:
          | Array<{ src?: unknown; url?: unknown; link?: unknown }>
          | Record<string, Array<{ src?: unknown; url?: unknown; link?: unknown }>>;
      };
      // GNULA ha servido dos formas del mismo payload: una lista de idiomas
      // en versiones antiguas y un objeto indexado por `lat`, `sub`, etc. en
      // la versión actual. Aceptar ambas evita perder todos los servidores de
      // una ficha válida y caer de vuelta en la URL HTML de GNULA.
      const languages = Array.isArray(decoded.langs)
        ? decoded.langs
        : Object.values(decoded.langs || {});
      const streams = languages
        .flatMap((language) => language?.servers || [])
        .map((server) => (typeof server?.src === "string" ? server.src.trim() : ""))
        .filter((src) => /^https?:\/\//i.test(src) && !isGnulaPlaceholderStream(src));

      const rawDl = Array.isArray(decoded.dl)
        ? decoded.dl
        : Object.values(decoded.dl || {}).flat();
      const dlStreams = rawDl
        .map((item) => {
          const u = item?.src || item?.url || item?.link;
          return typeof u === "string" ? u.trim() : "";
        })
        .filter((src) => /^https?:\/\//i.test(src) && !isGnulaPlaceholderStream(src));

      const combined = Array.from(new Set([...streams, ...dlStreams]));

      // Si existen servidores reales junto al reproductor nuevo/player.php, relegar player.php al final
      const hasRealStream = combined.some((u) => !/nuevo\/player\.php/i.test(u));
      const finalStreams = hasRealStream
        ? combined.filter((u) => !/nuevo\/player\.php/i.test(u)).concat(combined.filter((u) => /nuevo\/player\.php/i.test(u)))
        : combined;

      return {
        title: typeof decoded.t === "string" ? decoded.t.trim() : undefined,
        streams: finalStreams,
      };
    } catch {
      return empty;
    }
  }

  /** Lista real de episodios que GNULA renderiza en fichas de series/anime. */
  private detailEpisodes($: cheerio.CheerioAPI, pageUrl: string): Array<{ number: number; season?: number; title: string; url: string }> {
    const episodes: Array<{ number: number; season?: number; title: string; url: string }> = [];
    const seen = new Set<string>();

    let elements = $("a.gnrd-epc[href]");
    if (elements.length === 0) {
      elements = $("a[href*='-1x'], a[href*='-2x'], a[href*='-3x'], a[href*='-4x'], a[href*='-5x'], .gnrd-episodes a[href], .episodes a[href]");
    }

    elements.each((idx, element) => {
      const href = ($(element).attr("href") || "").trim();
      if (!href) return;
      let url = href;
      try { url = new URL(href, pageUrl).toString(); } catch { return; }
      // Una ficha de serie enlaza a episodios raíz (/serie-1x02/). Solo se
      // descartan índices y fichas overview; los episodios sí deben entrar.
      if (isGnulaCatalogUrl(url) || isGnulaOverviewUrl(url)) return;
      if (seen.has(url)) return;

      const seasonAttr = Number($(element).attr("data-s"));
      const episodeAttr = Number($(element).attr("data-e"));
      const marker = $(element).find(".gnrd-epc-n").first().text().trim();
      const markerMatch = marker.match(/(\d+)\s*x\s*(\d+)/i);
      const slugMatch = url.match(/[-_](\d+)x(\d+)(?:\/|$)/i) || url.match(/[-_]temporada[-_](\d+)[-_]capitulo[-_](\d+)/i);

      const parsedSeason = Number.isFinite(seasonAttr) && seasonAttr > 0
        ? seasonAttr
        : markerMatch ? Number(markerMatch[1])
        : slugMatch ? Number(slugMatch[1])
        : 1;

      const parsedNumber = Number.isFinite(episodeAttr) && episodeAttr > 0
        ? episodeAttr
        : markerMatch ? Number(markerMatch[2])
        : slugMatch ? Number(slugMatch[2])
        : idx + 1;

      const title = $(element).find(".gnrd-epc-title").first().text().trim() || `Episodio ${parsedNumber}`;
      seen.add(url);
      episodes.push({
        number: parsedNumber,
        season: parsedSeason,
        title,
        url,
      });
    });

    // Ordenar ascendentemente por temporada y número de episodio (1x01, 1x02... en lugar de orden inverso)
    return episodes.sort((a, b) => (a.season || 1) - (b.season || 1) || a.number - b.number);
  }

  async analyze(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream"): Promise<UniversalAnalysisResult> {
    const url = new URL(input);
    if (explicitType !== "detail" && explicitType !== "stream") {
      const html = await this.fetchHtml(input, 12000);
      if (!html) {
        if (explicitType === "catalog") throw new Error(`FETCH_FAILED: ${input}`);
        return super.analyze(input, explicitType);
      }
      const $ = cheerio.load(html);
      const items: ExtractedCatalogItem[] = [];
      const seen = new Set<string>();
      // Los catálogos GNULA no imprimen un badge de tipo en cada tarjeta;
      // la sección `/ver/series/` o `/ver/anime/` es la señal canónica.
      const sectionKind: ContentKind = /\/ver\/series(?:\/|$)/i.test(url.pathname)
        ? "series"
        : /\/ver\/anime(?:\/|$)/i.test(url.pathname)
          ? "anime"
          : "movie";
      $("a.gnrd-card[href*='/ver/']").each((_, card) => {
        const href = $(card).attr("href") || "";
        const rawTitle = $(card).find(".gnrd-card-title").first().text().trim() || $(card).attr("title") || "";
        if (!href || !rawTitle) return;
        const itemUrl = new URL(href, url.origin).toString();
        // Algunas tarjetas antiguas apuntan por error al índice general en
        // lugar de a una ficha. No encolarlas: ese URL no identifica una obra
        // ni puede producir un episodio reproducible.
        if (isGnulaCatalogUrl(itemUrl)) return;
        if (seen.has(itemUrl)) return;
        seen.add(itemUrl);
        const type = $(card).find(".gnrd-type-badge").first().text().trim().toLowerCase();
        const kind: ContentKind = type.includes("serie") ? "series" : type.includes("anime") ? "anime" : sectionKind;
        const image = $(card).find("img").first().attr("src") || null;
        const meta = $(card).find(".gnrd-card-metaline").text();
        const year = Number(meta.match(/\b(19|20)\d{2}\b/)?.[0]) || null;
        const genres = $(card).find(".gnrd-card-genres").text().split("·").map((v) => v.trim()).filter(Boolean);
        items.push({ title: cleanQueryTitle(rawTitle), url: itemUrl, image_url: image, kind, year, genres });
      });
      // Las fichas también incluyen tarjetas relacionadas `.gnrd-card`; no
      // son un catálogo. Solo las rutas índice /ver/peliculas|series|anime
      // (o una solicitud explícita de catálogo) pueden entrar aquí.
      if ((isGnulaCatalogRoute(input) && items.length > 0) || explicitType === "catalog") {
        const title = $("meta[property='og:title']").attr("content") || "Catálogo GNULA";
        const description = $("meta[name='description']").attr("content") || `Catálogo GNULA: ${items.length} fichas.`;
        return { page_type: "catalog", content_type: "movie", title, description, poster_url: items[0]?.image_url || null, banner_url: null, rating: 0, year: 0, status: "Catálogo", genres: ["Películas", "Series", "Anime"], source_domain: url.hostname, episodes: [], catalog_items: items };
      }
    }


    // Para fichas GNULA, la metadata de la propia página es la fuente de
    // verdad. El enriquecimiento externo solo aporta TMDB/póster cuando el
    // título coincide; nunca puede sustituir el título ni la categoría de la
    // ficha. Esto evita falsos matches (p.ej. "Trying" → otro programa).
    let detailHtml = "";
    try { detailHtml = (await this.fetchHtml(input, 12000)) || ""; } catch {}
    const detail$ = detailHtml ? cheerio.load(detailHtml) : null;
    const listedEpisodes = detail$ ? this.detailEpisodes(detail$, input) : [];
    const twitterDescription = detail$?.("meta[name='twitter:description']").attr("content") || "";
    const sourceTitle = detail$?.(".gnrd-fi-title .gnrd-sr").first().text().trim()
      || detail$?.("h1.gnrd-fi-title").first().text().trim()
      || detail$?.("meta[property='og:title']").attr("content")?.replace(/\s*\|\s*Gnula.*$/i, "").trim()
      || cleanQueryTitle(url.pathname.split("/").filter(Boolean).pop() || "Contenido");
    const detailKind: ContentKind = /^\s*anime\s*:/i.test(twitterDescription)
      || /\banime\b/i.test(twitterDescription)
      ? "anime"
      : /^\s*serie(?:s)?\s*:/i.test(twitterDescription) || listedEpisodes.length > 0
        ? "series"
        : "movie";
    const directDescription = detail$?.("[itemprop='description'], .gnrd-fi-syn").first().text().trim()
      || detail$?.("meta[property='og:description']").attr("content")
      || detail$?.("meta[name='description']").attr("content")
      || "Contenido indexado en GNULA.";
    const directPoster = detail$?.(".gnrd-fi-logo").first().attr("src")
      || detail$?.("meta[property='og:image']").attr("content")
      || null;
    const backgroundStyle = detail$?.(".gnrd-fi-bg").first().attr("style") || "";
    const directBanner = backgroundStyle.match(/url\(['\"]?([^)'\"]+)/i)?.[1]
      || detail$?.("meta[property='og:image']").attr("content")
      || directPoster;
    const metaText = detail$?.(".gnrd-fi-meta").first().text().replace(/\s+/g, " ").trim() || twitterDescription;
    const year = Number(metaText.match(/\b(19|20)\d{2}\b/)?.[0]) || 0;
    const rating = Number(detail$?.("meta[itemprop='ratingValue']").attr("content")
      || metaText.match(/(?:Puntuaci[oó]n|Rating)\s*:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]
      || detail$?.(".gnrd-m-rating").first().text().match(/[0-9]+(?:\.[0-9]+)?/)?.[0]
      || 0);
    const status = /en emisi[oó]n|airing|ongoing/i.test(metaText) ? "En emisión" : "Finalizado";
    const genres = detail$?.(".gnrd-fi-genres a, .gnrd-genre").toArray()
      .map((element) => detail$!(element).text().trim()).filter(Boolean) || [];
    const directAnimeHint = /\banime\b/i.test(twitterDescription)
      || (genres.some((genre) => /animaci[oó]n|animation/i.test(genre))
        && /jap[oó]n|japan|china|corea|korea/i.test(metaText));
    const directKind: ContentKind = detailKind === "movie" || detailKind === "anime" || directAnimeHint
      ? (directAnimeHint && detailKind === "series" ? "anime" : detailKind)
      : detailKind;
    let enriched: Awaited<ReturnType<typeof enrichUniversalMetadata>> | null = null;
    // El modo detail lo usa el re-escaneo de obras conocidas: ya tiene la
    // identidad guardada y solo necesita episodios/fuentes. Omitir APIs
    // externas aquí evita miles de llamadas innecesarias; el modo automático
    // de obras nuevas sí obtiene TMDB completo.
    if (explicitType !== "detail") {
      try { enriched = await enrichUniversalMetadata(sourceTitle, directKind); } catch {}
    }
    const trustedEnriched = enriched && titlesCompatible(sourceTitle, enriched.title) ? enriched : null;
    // GNULA ocasionalmente publica anime dentro de /ver/series/ y omite la
    // etiqueta "Anime" en Twitter. Si la ficha marca Animación y el match
    // TMDB validado es un anime, corregir el namespace sin tocar las series
    // live-action que solo comparten el mismo catálogo.
    const resolvedKind: ContentKind = directKind === "series"
      && genres.some((genre) => /animaci[oó]n|animation/i.test(genre))
      && trustedEnriched?.content_type === "anime"
      ? "anime"
      : directKind;
    const safeStreams: string[] = [];
    const safeEpisodes = listedEpisodes.length > 0
      ? listedEpisodes
      // Una ficha GNULA sin payload no es un stream. No guardar la propia
      // página `/ver/<slug>/` como episodio: eso fue la causa del catálogo
      // roto que estamos corrigiendo.
      : (isGnulaDetailUrl(input) || isGnulaCatalogUrl(input))
        ? []
        : [{ number: 1, title: "Película Completa", url: input }];
    const safeBase: UniversalAnalysisResult = {
      page_type: "detail",
      content_type: resolvedKind,
      title: sourceTitle,
      original_title: trustedEnriched?.original_title || sourceTitle,
      ...(trustedEnriched?.tmdb_id ? { tmdb_id: trustedEnriched.tmdb_id } : {}),
      japanese_title: trustedEnriched?.japanese_title || null,
      english_title: trustedEnriched?.english_title || null,
      description: directDescription || trustedEnriched?.description || "Contenido indexado en GNULA.",
      poster_url: directPoster || trustedEnriched?.poster_url || null,
      banner_url: directBanner || trustedEnriched?.banner_url || directPoster || null,
      rating: rating > 0 ? rating : trustedEnriched?.rating || 0,
      year: year || trustedEnriched?.year || 0,
      status,
      genres: genres.length > 0 ? genres : trustedEnriched?.genres || [],
      source_domain: url.hostname,
      detected_streams: safeStreams,
      episodes: safeEpisodes,
      catalog_items: [],
      raw_metadata: {
        og: {
          title: detail$?.("meta[property='og:title']").attr("content") || sourceTitle,
          description: detail$?.("meta[property='og:description']").attr("content") || directDescription,
          image: detail$?.("meta[property='og:image']").attr("content") || directPoster || "",
        },
        embeds: safeStreams,
      },
    };
    const payload = await this.playerPayload(input);
    if (payload.streams.length === 0) return safeBase;

    const primary = payload.streams[0];
    // En una ficha de serie/anime el payload pertenece al reproductor de la
    // página actual, no reemplaza la lista completa `.gnrd-epc`.
    if (listedEpisodes.length > 0) {
      return { ...safeBase, detected_streams: payload.streams, raw_metadata: { ...(safeBase.raw_metadata || {}), embeds: payload.streams } };
    }
    return {
      ...safeBase,
      detected_streams: payload.streams,
      episodes: [{ number: 1, title: "Película Completa", url: primary }],
      raw_metadata: {
        ...(safeBase.raw_metadata || {}),
        embeds: payload.streams,
      },
    };
  }

  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const payload = await this.playerPayload(targetUrl);
    if (payload.streams.length === 0) {
      return { stream_url: "", all_available_streams: [], ...(payload.title ? { title: payload.title } : {}) };
    }
    return {
      stream_url: payload.streams[0],
      all_available_streams: payload.streams,
      ...(payload.title ? { title: payload.title } : {}),
    };
  }
}
