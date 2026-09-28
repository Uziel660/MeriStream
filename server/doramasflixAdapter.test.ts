import { afterEach, describe, expect, it, vi } from "vitest";
import { DoramasflixAdapter } from "./scrapers/adapters/DoramasflixAdapter";

function graphqlResponse(items: Array<Record<string, unknown>>) {
  return {
    ok: true,
    json: async () => ({ data: { paginationDorama: { items } } }),
    text: async () => "",
  };
}

describe("DoramasflixAdapter catalog pagination", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("usa GraphQL y conserva páginas distintas de doramas", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as { variables?: { page?: number } };
      const page = body.variables?.page;
      return graphqlResponse([{ name_es: `Dorama ${page}`, slug: `dorama-${page}`, poster_path: `/p-${page}.jpg` }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new DoramasflixAdapter();
    const first = await adapter.analyze("https://doramasflix.io/doramas?page=1", "catalog");
    const second = await adapter.analyze("https://doramasflix.io/doramas?page=2", "catalog");

    expect(first.source_domain).toBe("doramasflix.io");
    expect(first.catalog_items[0]).toMatchObject({ title: "Dorama 1", url: "https://doramasflix.io/doramas/dorama-1", kind: "series" });
    expect(second.catalog_items[0]).toMatchObject({ title: "Dorama 2", url: "https://doramasflix.io/doramas/dorama-2", kind: "series" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("consulta películas sin enviar un filtro incompatible", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body || "{}")) as { variables?: { filter?: unknown } };
      expect(request.variables?.filter).toEqual({});
      return {
        ok: true,
        json: async () => ({ data: { paginationMovie: { items: [{ name: "Movie", slug: "movie-1", release_date: "2024-01-01" }] } } }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DoramasflixAdapter().analyze("https://doramasflix.io/peliculas?page=3", "catalog");
    expect(result.catalog_items[0]).toMatchObject({
      title: "Movie",
      url: "https://doramasflix.io/peliculas/movie-1",
      kind: "movie",
      year: 2024,
    });
  });

  it("filtra variedades con isTVShow y genera su ruta canónica", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body || "{}")) as { variables?: { filter?: unknown } };
      expect(request.variables?.filter).toEqual({ isTVShow: true });
      return graphqlResponse([{ name: "Variety", slug: "variety-1", isTVShow: true }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DoramasflixAdapter().analyze("https://doramasflix.io/variedades?page=2", "catalog");
    expect(result.catalog_items[0]).toMatchObject({ title: "Variety", url: "https://doramasflix.io/variedades/variety-1", kind: "series" });
  });

  it("ignora elementos sin slug, elimina duplicados y conserva la portada alternativa", async () => {
    const items = [
      { slug: " beyond evil ", name: "Beyond Evil", backdrop_path: "/backdrop.jpg", first_air_date: "2021-01-01" },
      null,
      { slug: "   ", name: "No slug" },
      { slug: "beyond evil", name_es: "Duplicate" },
    ] as unknown as Array<Record<string, unknown>>;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body || "{}")) as { variables?: { page?: number; filter?: unknown } };
      expect(request.variables).toMatchObject({ page: 4, filter: { isTVShow: false } });
      return graphqlResponse(items);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DoramasflixAdapter().analyze("https://doramasflix.io/doramas?page=4", "catalog");

    expect(result.catalog_items).toEqual([
      expect.objectContaining({
        title: "Beyond Evil",
        url: "https://doramasflix.io/doramas/beyond%20evil",
        image_url: "https://doramasflix.io/backdrop.jpg",
        kind: "series",
        year: 2021,
      }),
    ]);
  });

  it("ordena episodios GraphQL, elimina slugs duplicados y completa sus valores faltantes", async () => {
    const episodes = [
      { slug: "episode-2", episode_number: 2, season_number: 1, name: "Capítulo dos" },
      { slug: "episode-1", episode_number: 1, season_number: 1, name: " " },
      { slug: "episode-2", episode_number: 2, season_number: 1, name: "Duplicado" },
      { slug: "special", name: "Especial" },
      { slug: "season-2-episode-1", episode_number: 1, season_number: 2, name: "Otra temporada" },
      { slug: "   ", episode_number: 9, season_number: 9, name: "Sin slug" },
      null,
    ] as unknown as Array<Record<string, unknown>>;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { paginationEpisode: { items: episodes } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new DoramasflixAdapter();
    vi.spyOn(adapter as any, "fetchHtml").mockResolvedValue(`
      <html><head><meta property="og:title" content="Serie de prueba"></head>
      <body><h1>Serie de prueba</h1><script>window.data = {"serie_id":"1234567890abcdef12345678"};</script></body></html>
    `);
    vi.spyOn(adapter as any, "enrichDetailMetadata").mockResolvedValue(null);

    const result = await adapter.analyze("https://doramasflix.io/doramas/serie-de-prueba", "detail");

    expect(result.episodes).toEqual([
      { number: 1, season: 1, title: "Capítulo 1", url: "https://doramasflix.io/capitulos/episode-1" },
      { number: 1, season: 1, title: "Especial", url: "https://doramasflix.io/capitulos/special" },
      { number: 2, season: 1, title: "Capítulo dos", url: "https://doramasflix.io/capitulos/episode-2" },
      { number: 1, season: 2, title: "Otra temporada", url: "https://doramasflix.io/capitulos/season-2-episode-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
