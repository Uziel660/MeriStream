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
});
