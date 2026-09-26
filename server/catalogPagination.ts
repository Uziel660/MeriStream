/** Construye la siguiente URL de catálogo para los patrones conocidos. */
/**
 * Number of consecutive empty pages required before declaring a paginated
 * catalog exhausted. Providers occasionally return a transient empty page
 * (or a gap while rotating their catalog), so one empty response must not
 * truncate a full-catalog crawl.
 */
export const EMPTY_CATALOG_PAGE_CONFIRMATIONS = 2;
export const REPEATED_CATALOG_PAGE_CONFIRMATIONS = 2;

export function shouldStopAfterEmptyCatalogPage(
  pageNumber: number,
  consecutiveEmptyPages: number,
): boolean {
  return pageNumber > 1 && consecutiveEmptyPages >= EMPTY_CATALOG_PAGE_CONFIRMATIONS;
}

/**
 * A duplicated page is not conclusive by itself: a provider can temporarily
 * repeat a page while its catalog is being reindexed. Require confirmation
 * before stopping a full sweep on the "no new URLs" signal.
 */
export function shouldStopAfterRepeatedCatalogPage(
  pageNumber: number,
  consecutiveRepeatedPages: number,
): boolean {
  return pageNumber > 1 && consecutiveRepeatedPages >= REPEATED_CATALOG_PAGE_CONFIRMATIONS;
}

export function buildCatalogPageUrl(baseUrl: string, pageNumber: number): string {
  try {
    const url = new URL(baseUrl);
    if (url.searchParams.has("page")) {
      url.searchParams.set("page", String(pageNumber));
      return url.toString();
    }
    if (url.searchParams.has("p")) {
      url.searchParams.set("p", String(pageNumber));
      return url.toString();
    }
    if (url.searchParams.has("pag")) {
      url.searchParams.set("pag", String(pageNumber));
      return url.toString();
    }
    if (/\/page\/\d+\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/page\/\d+/, `/page/${pageNumber}`);
      return url.toString();
    }

    const host = url.hostname.toLowerCase();
    const catalogPath = url.pathname.replace(/\/+$/, "");
    const origin = url.origin;
    if (/(^|\.)gnulahd\.nu$/.test(host)) {
      // El catálogo visible usa paginación por query (confirmado en navegador):
      // /ver/peliculas/?page=2&__epix=1, no /page/2/.
      url.searchParams.set("page", String(pageNumber));
      url.searchParams.set("__epix", "1");
      return url.toString();
    }
    if (/(^|\.)jkanime\.net$/.test(host)) {
      return `${origin}${catalogPath || "/directorio"}?p=${pageNumber}`;
    }
    if (/(^|\.)animeflv\.(or\.(?:at|am)|la|cc|pe|iu|se)$/.test(host)) {
      return `${origin}${catalogPath}/page/${pageNumber}/`;
    }
    if (/(^|\.)tioplus\.app$/.test(host)) {
      return `${origin}${catalogPath}/${pageNumber}`;
    }
    if (/(^|\.)latanime\.org$/.test(host)) {
      return `${origin}${catalogPath || "/animes"}?p=${pageNumber}`;
    }
    if (/(^|\.)tioanime\.com$/.test(host)) {
      return `${origin}${catalogPath || "/directorio"}?p=${pageNumber}`;
    }
    if (/(^|\.)veranimes\.(net|com)$/.test(host)) {
      return `${origin}${catalogPath || "/animes"}?pag=${pageNumber}`;
    }
    if (/(^|\.)cinecalidad\.[a-z.]+$/.test(host)) {
      return `${origin}${catalogPath}/page/${pageNumber}/`;
    }
    if (/(^|\.)tudorama\.com$/.test(host)) {
      return `${origin}${catalogPath}/page/${pageNumber}/`;
    }
    if (/(^|\.)animeflv\.net$/.test(host)) {
      return `${origin}${catalogPath || "/browse"}?page=${pageNumber}`;
    }

    url.searchParams.set("page", String(pageNumber));
    return url.toString();
  } catch {
    return baseUrl.includes("?") ? `${baseUrl}&page=${pageNumber}` : `${baseUrl}?page=${pageNumber}`;
  }
}
