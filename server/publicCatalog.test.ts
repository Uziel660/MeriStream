import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPublicCatalog,
  getPublicCatalogDetail,
  mapTmdbItem,
  parsePublicCatalogId,
  resetPublicCatalogCache,
} from "./publicCatalog";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicCatalogCache();
});

describe("TMDB public catalog", () => {
  it("uses a namespaced stable id and preserves anime category", () => {
    const show = mapTmdbItem({
      id: 21,
      name: "One Piece",
      original_name: "ワンピース",
      original_language: "ja",
      first_air_date: "1999-10-20",
      genre_ids: [16, 10759],
      vote_average: 8.7,
    }, "anime");

    expect(show.id).toBe("tmdb-anime-21");
    expect(show.tmdb_id).toBe(21);
    expect(show.category).toBe("anime");
    expect(show.year).toBe(1999);
    expect(show.genres).toContain("Animación");
    expect(parsePublicCatalogId(show.id)).toEqual({ kind: "anime", tmdbId: 21 });
  });

  it("builds a public result without touching the provider database", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/trending/movie/week")) {
        return new Response(JSON.stringify({ page: 1, total_results: 1, total_pages: 1, results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15", vote_average: 8.4 }] }), { status: 200 });
      }
      if (url.includes("/trending/tv/week")) {
        return new Response(JSON.stringify({ page: 1, total_results: 1, total_pages: 1, results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", vote_average: 9.5 }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ page: 1, total_results: 0, total_pages: 1, results: [] }), { status: 200 });
    }));

    const result = await getPublicCatalog({ kind: "all", limit: 10 });
    expect(result.source).toBe("tmdb");
    expect(result.shows.map((show) => show.id)).toEqual(["tmdb-movie-550", "tmdb-series-1396"]);
  });

  it("creates virtual episodes that point back to the canonical TMDB id", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tv/1396")) {
        return new Response(JSON.stringify({
          id: 1396,
          name: "Breaking Bad",
          first_air_date: "2008-01-20",
          seasons: [{ season_number: 1, episode_count: 2 }],
          external_ids: { imdb_id: "tt0903747", tvdb_id: 81189, wikidata_id: "Q1079" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { Media: null } }), { status: 200 });
    }));

    const detail = await getPublicCatalogDetail("series", 1396);
    expect(detail?.imdb_id).toBe("tt0903747");
    expect(detail?.episodes).toHaveLength(2);
    expect(detail?.episodes[0]?.id).toBe("tmdb-series-1396-s1-e1");
    expect(detail?.episodes[0]?.source_url).toBe("tmdb://series/1396/1/1");
  });

  it("falls back to Kitsu mappings when AniList is unavailable", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tv/94664")) {
        return new Response(JSON.stringify({ id: 94664, name: "Mushoku Tensei", first_air_date: "2021-01-11", seasons: [] }), { status: 200 });
      }
      if (url.includes("graphql.anilist.co")) return new Response("disabled", { status: 403 });
      if (url.includes("kitsu.io/api/edge/anime?") && url.includes("Mushoku")) {
        return new Response(JSON.stringify({ data: [{ id: "42323", attributes: { canonicalTitle: "Mushoku Tensei", titles: { en: "Mushoku Tensei: Jobless Reincarnation", en_jp: "Mushoku Tensei: Isekai Ittara Honki Dasu" } } }] }), { status: 200 });
      }
      if (url.includes("kitsu.io/api/edge/anime/42323/mappings")) {
        return new Response(JSON.stringify({ data: [
          { attributes: { externalSite: "myanimelist/anime", externalId: "39535" } },
          { attributes: { externalSite: "anilist/anime", externalId: "108465" } },
        ] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const detail = await getPublicCatalogDetail("anime", 94664);
    expect(detail?.mal_id).toBe(39535);
    expect(detail?.anilist_id).toBe("108465");
    expect(detail?.kitsu_id).toBe("42323");
  });
});
