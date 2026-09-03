// server/utils/pageUrlBuilder.ts
import * as cheerio from "cheerio";

/**
 * Extrae la URL de la página siguiente directamente del HTML si el sitio
 * incluye enlaces semánticos de paginación (<link rel="next">, <a rel="next">, etc.).
 */
export function extractNextPageUrl(html: string | null | undefined, currentUrl: string): string | null {
  if (!html || typeof html !== "string") return null;

  try {
    const $ = cheerio.load(html);

    // 1. Link tag en cabecera
    const linkNext = $('link[rel="next"]').attr("href");
    if (linkNext) {
      const resolved = resolveUrl(linkNext, currentUrl);
      if (resolved && resolved !== currentUrl) return resolved;
    }

    // 2. Selectores de paginación comunes en la web
    const nextSelectors = [
      'a[rel="next"]',
      ".pagination a.next",
      ".pagination .next a",
      "a.page-numbers.next",
      ".page-numbers.next a",
      "a.next-page",
      ".next-page a",
      "li.next a",
      "a.nav-next",
      ".nav-previous + a",
      "a.btn-next",
      ".btn-next a",
      'a[title*="Siguiente" i]',
      'a[title*="Next" i]',
    ];

    for (const sel of nextSelectors) {
      const href = $(sel).first().attr("href");
      if (href) {
        const resolved = resolveUrl(href, currentUrl);
        if (resolved && resolved !== currentUrl) return resolved;
      }
    }

    // 3. Búsqueda por texto visible "Siguiente" o "Next" o "»"
    const textAnchors = $("a").filter((_, el) => {
      const text = $(el).text().trim().toLowerCase();
      return text === "siguiente" || text === "next" || text === "»" || text === ">" || text === "siguiente >" || text === "siguiente »";
    });

    if (textAnchors.length > 0) {
      const href = textAnchors.first().attr("href");
      if (href) {
        const resolved = resolveUrl(href, currentUrl);
        if (resolved && resolved !== currentUrl) return resolved;
      }
    }
  } catch {}

  return null;
}

function resolveUrl(href: string, base: string): string | null {
  if (!href || href.startsWith("javascript:") || href.startsWith("#")) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * Genera la URL para la página N de un catálogo según los patrones conocidos
 * y universales de sitios web, APIs REST y gestores de contenido (WordPress, Laravel, etc.).
 */
export function buildPageUrl(baseUrl: string, pageNumber: number): string {
  if (pageNumber <= 1) return baseUrl;

  try {
    const url = new URL(baseUrl);

    // 1. Si ya tiene parámetros de consulta conocidos para paginación
    const queryKeys = ["page", "p", "pag", "pagina", "paged", "pg", "pgnum", "start", "offset"];
    for (const key of queryKeys) {
      if (url.searchParams.has(key)) {
        if (key === "offset" || key === "start") {
          // Si es offset basado en postsPerPage (ej: 24)
          const limit = Number(url.searchParams.get("limit") || url.searchParams.get("postsPerPage") || 24);
          url.searchParams.set(key, String((pageNumber - 1) * limit));
        } else {
          url.searchParams.set(key, String(pageNumber));
        }
        return url.toString();
      }
    }

    // 2. Si el path ya contiene /page/N o /pagina/N o /p/N
    if (/\/page\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/page\/\d+/i, `/page/${pageNumber}`);
      return url.toString();
    }
    if (/\/pagina\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/pagina\/\d+/i, `/pagina/${pageNumber}`);
      return url.toString();
    }
    if (/\/p\/\d+\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/p\/\d+/i, `/p/${pageNumber}`);
      return url.toString();
    }

    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    const origin = url.origin;

    // 3. Patrones específicos de hosts conocidos
    if (/(^|\.)animeflv\.(or\.(?:at|am)|la|cc|pe|iu|se)$/.test(host)) {
      return `${origin}${path}/page/${pageNumber}/`;
    }
    if (/(^|\.)tioplus\.app$/.test(host)) {
      return `${origin}${path}/${pageNumber}`;
    }
    if (/(^|\.)latanime\.org$/.test(host)) {
      return `${origin}${path || "/animes"}?p=${pageNumber}`;
    }
    if (/(^|\.)tioanime\.com$/.test(host)) {
      return `${origin}${path || "/directorio"}?p=${pageNumber}`;
    }
    if (/(^|\.)veranimes\.(net|com)$/.test(host)) {
      return `${origin}${path || "/animes"}?pag=${pageNumber}`;
    }
    if (/(^|\.)cinecalidad\.[a-z.]+$/.test(host)) {
      return `${origin}${path}/page/${pageNumber}/`;
    }
    if (/(^|\.)doramasflix\.[a-z.]+$/.test(host)) {
      return `${origin}${path}/page/${pageNumber}`;
    }
    if (/(^|\.)tubepelis\.[a-z.]+$/.test(host)) {
      if (path.includes("peliculas")) {
        return `${origin}/peliculas_${pageNumber}.html`;
      }
      return `${origin}${path}/page/${pageNumber}`;
    }
    if (/(^|\.)lamovie\.org$/.test(host) && url.pathname.includes("/wp-api/")) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }
    if (/(^|\.)animeflv\.net$/.test(host)) {
      return `${origin}${path || "/browse"}?page=${pageNumber}`;
    }

    // 4. Heurística universal: si la URL tiene query params existentes, usa query `page=N`
    if (url.search) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }

    // 5. Heurística universal de paths: si termina en /browse o /directorio o /catalogo o /peliculas o /series o /animes
    if (/(?:\/browse|\/directorio|\/catalogo|\/catalogue|\/peliculas|\/movies|\/series|\/animes|\/doramas)$/i.test(path)) {
      // Soporta /path/page/N o query ?page=N según si el sitio responde mejor
      return `${origin}${path}?page=${pageNumber}`;
    }

    url.searchParams.set("page", String(pageNumber));
    return url.toString();
  } catch {
    if (baseUrl.includes("?")) {
      return `${baseUrl}&page=${pageNumber}`;
    }
    return `${baseUrl}?page=${pageNumber}`;
  }
}
