import { describe, expect, it, vi } from "vitest";
import { LaMovieAdapter } from "./LaMovieAdapter";

describe("LaMovieAdapter · API moderna", () => {
  it("lee tarjetas, episodios y código JIT desde tmdb.allcalidad.re", async () => {
    const adapter: any = new LaMovieAdapter();
    vi.spyOn(adapter, "fetchHtml").mockImplementation(async (url: string) => {
      if (url.includes("/v1/items?kind=tvshow")) return JSON.stringify({ items: [{ tmdb_id: 287620, title: "Stuart", slug: "stuart", code: "showcode", year: 2026, poster_path: "/poster.jpg", genres: [] }] });
      if (url.endsWith("/v1/items/tvshow/287620")) return JSON.stringify({ item: { tmdb_id: 287620, title: "Stuart", slug: "stuart", code: "showcode", year: 2026, available_seasons: 1, genres: [], overview: "" } });
      if (url.endsWith("/v1/items/tvshow/287620/seasons/1")) return JSON.stringify({ season: { episodes: [{ episode: 1, title: "Piloto", playable: true, code: "epcode" }] } });
      return null;
    });

    const catalog = await adapter.analyze("https://lamovie.org/series", "catalog");
    expect(catalog.catalog_items[0]).toMatchObject({ title: "Stuart", kind: "series" });

    const detail = await adapter.analyze(catalog.catalog_items[0].url, "detail");
    expect(detail.tmdb_id).toBe(287620);
    expect(detail.episodes[0]).toMatchObject({ number: 1, season: 1 });
    expect(detail.episodes[0].sources[0].url).toBe("https://vimeos.net/embed-epcode.html");

    const stream = await adapter.extractStream(detail.episodes[0].url);
    expect(stream.all_available_streams).toEqual(["https://vimeos.net/embed-epcode.html"]);
  });
});

