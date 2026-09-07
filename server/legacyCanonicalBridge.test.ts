import { describe, expect, it } from "vitest";
import { selectCanonicalPlaybackCandidate, type CanonicalPlaybackCandidate } from "./legacyCanonicalBridge";

const normalize = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
const canonical = (url: string) => /^https:\/\//.test(url) && !/\.m3u8(?:\?|$)/i.test(url);

function candidate(overrides: Partial<CanonicalPlaybackCandidate> = {}): CanonicalPlaybackCandidate {
  return {
    id: "media-1",
    season_number: 1,
    episode_number: 1,
    media_item: { title: "18 rosas", normalized_title: "18rosas", base_normalized_title: "18rosas", tmdb_id: 1631917, year: 2026, kind: "movie" },
    links: [{ url: "https://www.cinecalidad.am/ver-pelicula/18-rosas/", link_type: "page" }],
    ...overrides,
  };
}

describe("legacy canonical playback bridge", () => {
  it("selects the canonical MediaEpisode instead of a legacy signed stream", () => {
    const result = selectCanonicalPlaybackCandidate(
      { title: "18 rosas", tmdb_id: 1631917, year: 2026, category: "movie" },
      { episode_number: 1 },
      [candidate()],
      normalize,
      normalize,
      canonical,
    );
    expect(result?.id).toBe("media-1");
    expect(result?.links[0].url).toContain("cinecalidad");
  });

  it("does not choose an unrelated title or an expired direct-only row", () => {
    const result = selectCanonicalPlaybackCandidate(
      { title: "18 rosas", tmdb_id: 1631917, year: 2026, category: "movie" },
      { episode_number: 1 },
      [
        candidate({ id: "wrong", media_item: { ...candidate().media_item, title: "Otra película", normalized_title: "otrapelicula", base_normalized_title: "otrapelicula", tmdb_id: 999 } }),
        candidate({ id: "direct-only", links: [{ url: "https://cdn.example/master.m3u8?t=expired", link_type: "direct" }] }),
      ],
      normalize,
      normalize,
      canonical,
    );
    expect(result).toBeNull();
  });

  it("matches a legacy title when TMDB is absent but the normalized title is exact", () => {
    const result = selectCanonicalPlaybackCandidate(
      { title: "Mi Película", year: 2025, category: "movie" },
      { episode_number: 1 },
      [candidate({
        media_item: { title: "Mi Película", normalized_title: "mipelicula", base_normalized_title: "mipelicula", tmdb_id: null, year: 2025, kind: "movie" },
      })],
      normalize,
      normalize,
      canonical,
    );
    expect(result?.id).toBe("media-1");
  });

  it("trusts an exact TMDB match even when the legacy year is stale", () => {
    const result = selectCanonicalPlaybackCandidate(
      { title: "One Piece", tmdb_id: 37854, year: 2024, category: "anime" },
      { episode_number: 1 },
      [candidate({
        media_item: {
          title: "One Piece",
          normalized_title: "onepiece",
          base_normalized_title: "onepiece",
          tmdb_id: 37854,
          year: 1999,
          kind: "anime",
        },
      })],
      normalize,
      normalize,
      canonical,
    );
    expect(result?.id).toBe("media-1");
  });
});
