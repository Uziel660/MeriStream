/** Construye la siguiente URL de catálogo para los patrones conocidos. */
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
    if (/(^|\.)animeflv\.net$/.test(host)) {
      return `${origin}${catalogPath || "/browse"}?page=${pageNumber}`;
    }

    url.searchParams.set("page", String(pageNumber));
    return url.toString();
  } catch {
    return baseUrl.includes("?") ? `${baseUrl}&page=${pageNumber}` : `${baseUrl}?page=${pageNumber}`;
  }
}
