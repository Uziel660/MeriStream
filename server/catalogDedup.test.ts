import { describe, expect, it } from "vitest";
import { catalogIdentityKey, dedupeCatalogShows } from "./catalogDedup";

const show = (overrides: Record<string, unknown>) => ({
  id: String(overrides.id || Math.random()),
  title: "Untitled",
  normalized_title: "untitled",
  base_normalized_title: "untitled",
  tmdb_id: null,
  category: "movie",
  year: 2024,
  description: "",
  poster_url: null,
  banner_url: null,
  genres: "Multimedia",
  _count: { episodes: 1 },
  ...overrides,
});

describe("public catalog canonical deduplication", () => {
  it("collapses the same TMDB movie even when provider titles differ", () => {
    const rows = [
      show({ id: "cine", title: "Pamela: Una historia de amor", normalized_title: "pamela una historia de amor", tmdb_id: 111, category: "movie", year: 2024 }),
      show({ id: "gnula", title: "Pamela Una Historia de Amor Latino", normalized_title: "pamela una historia de amor latino", tmdb_id: 111, category: "movie", year: 2024 }),
    ];
    expect(dedupeCatalogShows(rows)).toHaveLength(1);
  });

  it("uses normalized title + kind + year when TMDB is missing", () => {
    const rows = [
      show({ id: "a", title: "Petit mal", normalized_title: "petit mal", year: 2023 }),
      show({ id: "b", title: "PETIT MAL", normalized_title: "petit mal", year: 2023 }),
    ];
    expect(dedupeCatalogShows(rows)).toHaveLength(1);
  });

  it("keeps remakes with the same title but different years", () => {
    const rows = [
      show({ id: "old", title: "Suspiria", normalized_title: "suspiria", year: 1977 }),
      show({ id: "new", title: "Suspiria", normalized_title: "suspiria", year: 2018 }),
    ];
    expect(dedupeCatalogShows(rows)).toHaveLength(2);
  });

  it("keeps a movie and TV series with the same title", () => {
    const rows = [
      show({ id: "movie", title: "Fargo", normalized_title: "fargo", category: "movie", year: 2014 }),
      show({ id: "series", title: "Fargo", normalized_title: "fargo", category: "series", year: 2014 }),
    ];
    expect(dedupeCatalogShows(rows)).toHaveLength(2);
  });

  it("keeps TMDB movie and TV numeric namespaces separate", () => {
    const movie = show({ id: "movie", title: "Example", tmdb_id: 55, category: "movie" });
    const tv = show({ id: "tv", title: "Example", tmdb_id: 55, category: "series" });
    expect(catalogIdentityKey(movie)).not.toBe(catalogIdentityKey(tv));
    expect(dedupeCatalogShows([movie, tv])).toHaveLength(2);
  });

  it("treats anime and series as the same TMDB TV family only for strong identity", () => {
    const anime = show({ id: "anime", title: "Attack on Titan", tmdb_id: 1429, category: "anime", year: 2013 });
    const series = show({ id: "tv", title: "Attack on Titan", tmdb_id: 1429, category: "series", year: 2013 });
    expect(dedupeCatalogShows([anime, series])).toHaveLength(1);
  });

  it("selects the richer duplicate without changing its catalog slot", () => {
    const poor = show({ id: "poor", title: "Fugitivo Peligroso", normalized_title: "fugitivo peligroso", year: 2022, _count: { episodes: 1 } });
    const unrelated = show({ id: "other", title: "Another", normalized_title: "another", year: 2022 });
    const rich = show({
      id: "rich",
      title: "Fugitivo Peligroso",
      normalized_title: "fugitivo peligroso",
      year: 2022,
      poster_url: "https://image.example/poster.jpg",
      description: "Descripción completa y suficientemente larga para ser considerada metadata útil.",
      genres: "Crimen, Acción",
      _count: { episodes: 4 },
    });
    const result = dedupeCatalogShows([poor, unrelated, rich]);
    expect(result.map((row) => row.id)).toEqual(["rich", "other"]);
  });

  it("does not guess when neither TMDB nor a valid year exists", () => {
    const a = show({ id: "a", title: "Unknown", normalized_title: "unknown", year: 0, tmdb_id: null });
    const b = show({ id: "b", title: "Unknown", normalized_title: "unknown", year: 0, tmdb_id: null });
    expect(dedupeCatalogShows([a, b])).toHaveLength(2);
  });
});
