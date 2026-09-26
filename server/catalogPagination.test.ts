import { describe, expect, it } from "vitest";
import {
  buildCatalogPageUrl,
  EMPTY_CATALOG_PAGE_CONFIRMATIONS,
  REPEATED_CATALOG_PAGE_CONFIRMATIONS,
  shouldStopAfterEmptyCatalogPage,
  shouldStopAfterRepeatedCatalogPage,
} from "./catalogPagination";

describe("política de fin de catálogos paginados", () => {
  it("no corta ante una página vacía aislada", () => {
    expect(shouldStopAfterEmptyCatalogPage(12, 1)).toBe(false);
  });

  it("confirma el fin después de dos páginas vacías", () => {
    expect(EMPTY_CATALOG_PAGE_CONFIRMATIONS).toBe(2);
    expect(shouldStopAfterEmptyCatalogPage(13, 2)).toBe(true);
  });

  it("no considera vacía la primera página", () => {
    expect(shouldStopAfterEmptyCatalogPage(1, 2)).toBe(false);
  });

  it("confirma un solapamiento sólo tras dos páginas repetidas", () => {
    expect(REPEATED_CATALOG_PAGE_CONFIRMATIONS).toBe(2);
    expect(shouldStopAfterRepeatedCatalogPage(8, 1)).toBe(false);
    expect(shouldStopAfterRepeatedCatalogPage(9, 2)).toBe(true);
  });

  it("no detiene la primera página aunque el contador sea alto", () => {
    expect(shouldStopAfterRepeatedCatalogPage(1, 2)).toBe(false);
  });
});

describe("buildCatalogPageUrl", () => {
  it("mantiene los cursores declarados por una API", () => {
    expect(buildCatalogPageUrl("https://lamovie.org/list?page=1&postType=movies", 4)).toContain("page=4");
    expect(buildCatalogPageUrl("https://latanime.org/animes", 3)).toBe("https://latanime.org/animes?p=3");
    expect(buildCatalogPageUrl("https://veranimes.net/animes", 2)).toBe("https://veranimes.net/animes?pag=2");
  });

  it("aplica los patrones de segmentos y no rompe una URL inválida", () => {
    expect(buildCatalogPageUrl("https://tioplus.app/peliculas", 5)).toBe("https://tioplus.app/peliculas/5");
    expect(buildCatalogPageUrl("not-a-url", 2)).toBe("not-a-url?page=2");
  });

  it("reconoce el espejo animeflv.or.am", () => {
    expect(buildCatalogPageUrl("https://animeflv.or.am/anime", 3)).toBe("https://animeflv.or.am/anime/page/3/");
    expect(buildCatalogPageUrl("https://tudorama.com/genero/series/", 2)).toBe("https://tudorama.com/genero/series/page/2/");
  });
});
