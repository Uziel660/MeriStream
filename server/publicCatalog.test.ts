import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPublicCatalog,
  getPublicCatalogDetail,
  mapTmdbItem,
  parsePublicCatalogId,
  dedupePoorPublicDuplicates,
  resetPublicCatalogCache,
} from "./publicCatalog";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPublicCatalogCache();
});

describe("TMDB public catalog", () => {
  it("drops an empty TMDB stub when a richer same-title/year result exists", () => {
    const rich = mapTmdbItem({
      id: 483906,
      title: "Polar",
      release_date: "2019-01-01",
      overview: "Duncan Vizla, el asesino más letal del mundo.",
      poster_path: "/polar.jpg",
      backdrop_path: "/polar-backdrop.jpg",
      vote_average: 6.4,
    }, "movie");
    const stub = mapTmdbItem({
      id: 889356,
      title: "Polar",
      release_date: "2019-01-01",
      poster_path: "/stub-poster.jpg",
      backdrop_path: "/stub-backdrop.jpg",
    }, "movie");

    expect(dedupePoorPublicDuplicates([stub, rich]).map((show) => show.tmdb_id)).toEqual([483906]);
  });

  it("keeps two meaningful films that share title and year", () => {
    const first = mapTmdbItem({
      id: 101,
      title: "The Stranger",
      release_date: "2020-01-01",
      overview: "First film synopsis.",
      poster_path: "/first.jpg",
      vote_average: 6.2,
    }, "movie");
    const second = mapTmdbItem({
      id: 202,
      title: "The Stranger",
      release_date: "2020-01-01",
      overview: "Second film synopsis.",
      poster_path: "/second.jpg",
      vote_average: 7.1,
    }, "movie");

    expect(dedupePoorPublicDuplicates([first, second]).map((show) => show.tmdb_id)).toEqual([101, 202]);
  });

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

  it("fills a requested rail across TMDB pages instead of stopping at 20 rows", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/discover/tv")) return new Response("not found", { status: 404 });
      const page = Number(url.searchParams.get("page") || 1);
      const results = Array.from({ length: 20 }, (_unused, index) => ({
        id: page * 1000 + index,
        name: `Anime ${page}-${index}`,
        original_language: "ja",
        first_air_date: "2024-01-01",
        genre_ids: [16],
      }));
      return new Response(JSON.stringify({ page, total_results: 40, total_pages: 2, results }), { status: 200 });
    }));

    const result = await getPublicCatalog({ kind: "anime", limit: 40, mode: "discover" });
    expect(result.shows).toHaveLength(40);
    expect(result.shows[0]?.tmdb_id).toBe(1000);
    expect(result.shows[39]?.tmdb_id).toBe(2019);
  });

  it("searches TMDB globally for a query instead of reusing the trending batch", async () => {
    process.env.TMDB_API_KEY = "test-key";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith("/search/movie")) {
        return new Response(JSON.stringify({
          page: 1,
          total_results: 1,
          total_pages: 1,
          results: [{ id: 670292, title: "The Creator", original_language: "en", release_date: "2023-10-05" }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/search/tv")) {
        return new Response(JSON.stringify({ page: 1, total_results: 0, total_pages: 1, results: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await getPublicCatalog({ kind: "all", query: "The Creator", limit: 10 });
    expect(result.source).toBe("tmdb");
    expect(result.shows[0]?.title).toBe("The Creator");
    expect(result.total).toBe(1);
    expect(calls.some((url) => url.includes("/search/movie") && url.includes("query=The+Creator") && url.includes("language=es-419"))).toBe(true);
    expect(calls.some((url) => url.includes("/trending/movie/week") || url.includes("/trending/tv/week"))).toBe(false);
  });

  it("keeps a live-action TV search out of the anime namespace", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/search/movie")) {
        return new Response(JSON.stringify({ page: 1, total_results: 0, total_pages: 1, results: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/search/tv")) {
        return new Response(JSON.stringify({
          page: 1,
          total_results: 1,
          total_pages: 1,
          results: [{ id: 216405, name: "Hola Venus", original_language: "ko", first_air_date: "2022-01-01", genre_ids: [18] }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await getPublicCatalog({ kind: "all", query: "Hola Venus", limit: 10 });
    expect(result.shows).toHaveLength(1);
    expect(result.shows[0]).toMatchObject({ tmdb_id: 216405, kind: "series", title: "Hola Venus" });
  });

  it("uses a per-request TMDB key when a profile supplies one", async () => {
    delete process.env.TMDB_API_KEY;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname.endsWith("/search/movie")) {
        return new Response(JSON.stringify({ page: 1, total_results: 1, total_pages: 1, results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15" }] }), { status: 200 });
      }
      if (url.pathname.endsWith("/search/tv")) {
        return new Response(JSON.stringify({ page: 1, total_results: 0, total_pages: 1, results: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await getPublicCatalog({ kind: "all", query: "Fight Club", limit: 1, apiKey: "personal-test-key" });
    expect(result.shows[0]?.tmdb_id).toBe(550);
    expect(urls[0]).toContain("api_key=personal-test-key");
  });

  it("interleaves movies, series and anime in the unified public catalog", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page") || 1);
      if (url.pathname.endsWith("/trending/movie/week")) {
        return new Response(JSON.stringify({ page, total_results: 2, total_pages: 1, results: [
          { id: 1, title: "Movie One", release_date: "2024-01-01" },
          { id: 2, title: "Movie Two", release_date: "2024-01-02" },
        ] }), { status: 200 });
      }
      if (url.pathname.endsWith("/trending/tv/week")) {
        return new Response(JSON.stringify({ page, total_results: 2, total_pages: 1, results: [
          { id: 11, name: "Series One", first_air_date: "2024-01-01", original_language: "en" },
          { id: 12, name: "Series Two", first_air_date: "2024-01-02", original_language: "en" },
        ] }), { status: 200 });
      }
      if (url.pathname.endsWith("/discover/tv")) {
        return new Response(JSON.stringify({ page, total_results: 2, total_pages: 1, results: [
          { id: 21, name: "Anime One", first_air_date: "2024-01-01", original_language: "ja", genre_ids: [16] },
          { id: 22, name: "Anime Two", first_air_date: "2024-01-02", original_language: "ja", genre_ids: [16] },
        ] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await getPublicCatalog({ kind: "all", limit: 6 });
    expect(result.shows.map((show) => show.kind)).toEqual([
      "movie", "series", "anime", "movie", "series", "anime",
    ]);
    expect(result.shows.map((show) => show.tmdb_id)).toEqual([1, 11, 21, 2, 12, 22]);
  });

  it("replaces a TMDB title-art PNG with the canonical detail poster", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/trending/tv/week")) {
        return new Response(JSON.stringify({
          page: 1,
          total_results: 1,
          total_pages: 1,
          results: [{ id: 300529, name: "Te irás al infierno", poster_path: "/title-art.png", first_air_date: "2026-01-01" }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/tv/300529")) {
        return new Response(JSON.stringify({
          id: 300529,
          name: "Te irás al infierno",
          poster_path: "/canonical-poster.jpg",
          backdrop_path: "/backdrop.jpg",
          first_air_date: "2026-01-01",
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const result = await getPublicCatalog({ kind: "series", limit: 1 });
    expect(result.shows[0]?.poster_path).toBe("/canonical-poster.jpg");
    expect(result.shows[0]?.poster_url).toContain("/w500/canonical-poster.jpg");
  });

  it("uses a Spanish TMDB translation when the localized detail title is unavailable", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/movie/982620")) {
        return new Response(JSON.stringify({
          id: 982620,
          title: "Maneater",
          original_title: "Maneater",
          release_date: "2022-08-26",
          overview: "An English overview",
          translations: {
            translations: [
              { iso_639_1: "en", iso_3166_1: "US", data: { title: "Maneater" } },
              { iso_639_1: "es", iso_3166_1: "MX", data: { title: "Terror en el océano", overview: "Una descripción en español." } },
            ],
          },
          external_ids: {},
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const detail = await getPublicCatalogDetail("movie", 982620);
    expect(detail?.title).toBe("Terror en el océano");
    expect(detail?.description).toBe("Una descripción en español.");
    expect(detail?.episodes[0]?.title).toBe("Terror en el océano");
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
          images: {
            logos: [
              { file_path: "/breaking-bad-en.png", iso_639_1: "en", width: 900 },
              { file_path: "/breaking-bad-es.png", iso_639_1: "es", width: 700 },
            ],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { Media: null } }), { status: 200 });
    }));

    const detail = await getPublicCatalogDetail("series", 1396);
    expect(detail?.imdb_id).toBe("tt0903747");
    expect(detail?.episodes).toHaveLength(2);
    expect(detail?.episodes[0]?.id).toBe("tmdb-series-1396-s1-e1");
    expect(detail?.episodes[0]?.source_url).toBe("tmdb://series/1396/1/1");
    expect(detail?.logo_url).toContain("/w500/breaking-bad-es.png");
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

  it("uses the exact TMDB cross-reference instead of a synopsis-only Kitsu hit", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tv/95897")) {
        return new Response(JSON.stringify({ id: 95897, name: "Overflow", original_name: "おーばーふろぉ", first_air_date: "2020-01-06", seasons: [] }), { status: 200 });
      }
      if (url.includes("query.wikidata.org")) {
        return new Response(JSON.stringify({ results: { bindings: [{ mal: { value: "40746" }, anilist: { value: "113417" } }] } }), { status: 200 });
      }
      if (url.includes("kitsu.io")) {
        return new Response(JSON.stringify({ data: [{ id: "5497", attributes: { titles: { en: "Panty & Stocking with Garterbelt" } } }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const detail = await getPublicCatalogDetail("anime", 95897);
    expect(detail?.mal_id).toBe(40746);
    expect(detail?.anilist_id).toBe("113417");
    expect(detail?.kitsu_id).toBeNull();
  });

  it("completes a partial Wikidata anime identity through AniList", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tv/12345")) {
        return new Response(JSON.stringify({ id: 12345, name: "Example Anime", original_name: "Example Anime", first_air_date: "2024-01-01", seasons: [] }), { status: 200 });
      }
      if (url.includes("query.wikidata.org")) {
        return new Response(JSON.stringify({ results: { bindings: [{ anilist: { value: "113417" } }] } }), { status: 200 });
      }
      if (url.includes("graphql.anilist.co")) {
        return new Response(JSON.stringify({ data: { Media: {
          id: 113417,
          idMal: 40746,
          title: { romaji: "Example Anime", english: "Example Anime", native: "例" },
          synonyms: [],
        } } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));

    const detail = await getPublicCatalogDetail("anime", 12345);
    expect(detail?.mal_id).toBe(40746);
    expect(detail?.anilist_id).toBe("113417");
  });

  it("resolves an anime film through TMDB movie details and keeps a virtual episode", async () => {
    process.env.TMDB_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/tv/685274")) return new Response("missing", { status: 404 });
      if (url.includes("/movie/685274")) {
        return new Response(JSON.stringify({
          id: 685274,
          title: "Mobile Suit Gundam Hathaway",
          original_title: "機動戦士ガンダム 閃光のハサウェイ",
          release_date: "2021-06-11",
          overview: "Una película de anime.",
          genres: [{ id: 16, name: "Animación" }],
          external_ids: { imdb_id: "tt12783454" },
        }), { status: 200 });
      }
      if (url.includes("graphql.anilist.co")) return new Response("disabled", { status: 403 });
      return new Response("not found", { status: 404 });
    }));

    const detail = await getPublicCatalogDetail("anime", 685274);
    expect(detail?.title).toBe("Mobile Suit Gundam Hathaway");
    expect(detail?.episodes).toHaveLength(1);
    expect(detail?.episodes[0]?.source_url).toBe("tmdb://anime/685274/1/1");
  });
});
