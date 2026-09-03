import { describe, expect, it } from "vitest";
import { buildCatalogPageUrl } from "./catalogPagination";

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
  });
});
