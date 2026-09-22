import { describe, expect, it } from "vitest";
import { mergeSearchCatalogRows, searchShowMatchesQuery } from "../App";

const localBareMovie = {
  id: "legacy-larry",
  title: "Larry Crowne, nunca es tarde",
  category: "movie",
  tmdb_id: null,
  mal_id: null,
  anilist_id: null,
  description: "",
  poster_url: null,
  backdrop_url: null,
  year: 0,
  episode_count: 1,
} as any;

const publicMovie = (id: number) => ({
  id: `tmdb-movie-${id}`,
  title: "Larry Crowne, nunca es tarde",
  category: "movie",
  kind: "movie",
  tmdb_id: id,
  description: "Ficha pública con sinopsis.",
  poster_url: "https://image.tmdb.org/t/p/w500/larry.jpg",
  backdrop_url: "https://image.tmdb.org/t/p/w780/larry-backdrop.jpg",
  year: 2011,
  rating: 6,
  popularity: 6.4,
}) as any;

describe("search catalog identity bridge", () => {
  it("matches stored aliases and titles from another locale", () => {
    expect(searchShowMatchesQuery({
      ...localBareMovie,
      title: "La isla olvidada",
      title_aliases: ["Forgotten Island", "섬"],
    }, "forgotten island")).toBe(true);
    expect(searchShowMatchesQuery({ ...localBareMovie, title: "La isla olvidada" }, "fight club")).toBe(false);
  });

  it("joins a bare legacy card to its unique public TMDB result", () => {
    const result = mergeSearchCatalogRows([localBareMovie], [publicMovie(59861)]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "legacy-larry",
      tmdb_id: 59861,
      poster_url: "https://image.tmdb.org/t/p/w500/larry.jpg",
      episode_count: 1,
    });
  });

  it("does not guess when the same title has multiple TMDB candidates", () => {
    const result = mergeSearchCatalogRows([localBareMovie], [publicMovie(59861), publicMovie(70000)]);

    expect(result).toHaveLength(3);
    expect(result.some((row) => row.id === "legacy-larry" && row.tmdb_id == null)).toBe(true);
  });
});
