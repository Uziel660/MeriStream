import { describe, expect, it } from "vitest";
import {
  buildDisplayEpisodes,
  countDisplayPlatforms,
  filterMainPathLinks,
  mergeCanonicalEpisodes,
} from "./showEpisodePolicy";

describe("show episode main-path presentation", () => {
  it("prefers canonical episodes, orders seasons, and selects anime sub before dub", () => {
    const episodes = buildDisplayEpisodes(
      [{ id: "legacy-1", title: "Episodio 1", episode_number: 1, source_url: "https://animeflv.net/ver/one-1" }],
      [
        {
          id: "canonical-s2e1",
          season_number: 2,
          episode_number: 1,
          links: [
            { url: "https://zokoanime.video/stream/mal/21/1/dub", source_site: "zokoanime.video", link_type: "dub" },
            { url: "https://zokoanime.video/stream/mal/21/1/sub", source_site: "zokoanime.video", link_type: "sub" },
          ],
        },
        {
          id: "canonical-s1e2",
          season_number: 1,
          episode_number: 2,
          links: [{ url: "https://zokoanime.video/stream/mal/21/2/sub", source_site: "zokoanime.video", link_type: "sub" }],
        },
      ],
      "anime",
      "show-1",
    );

    expect(episodes.map((episode) => `${episode.season_number}:${episode.episode_number}`)).toEqual(["1:2", "2:1"]);
    expect(episodes[1].source_url).toContain("/sub");
    expect(episodes.every((episode) => episode.id.startsWith("canonical-"))).toBe(true);
  });

  it("deduplicates legacy rows and keeps TioAnime out without a Zoko fallback", () => {
    const episodes = buildDisplayEpisodes(
      [
        { id: "legacy-2", title: "T1E2", episode_number: 2, source_url: "https://tioanime.com/ver/show-2" },
        { id: "legacy-1b", title: "Episodio 1", episode_number: 1, source_url: "https://animeflv.net/ver/show-1" },
        { id: "legacy-1a", title: "Episodio 1", episode_number: 1, source_url: "https://cinecalidad.am/show-1" },
      ],
      [],
      "series",
      "show-1",
    );

    expect(episodes.map((episode) => episode.episode_number)).toEqual([1]);
    expect(episodes[0].source_url).toContain("cinecalidad");
    expect(filterMainPathLinks([{ url: "https://tioanime.com/ver/show-2", source_site: "tioanime" }], "anime")).toEqual([]);
  });

  it("ordena Cinecalidad antes de Gnula en el camino principal", () => {
    const links = filterMainPathLinks([
      { url: "https://ww3.gnulahd.nu/ver/demo/", source_site: "gnula", link_type: "page" },
      { url: "https://www.cinecalidad.am/ver-pelicula/demo/", source_site: "cinecalidad", link_type: "page" },
    ], "movie");

    expect(links.map((link) => link.source_site)).toEqual(["cinecalidad", "gnula"]);
  });

  it("counts only active canonical providers", () => {
    const canonical = [
      {
        id: "e1",
        season_number: 1,
        episode_number: 1,
        links: [
          { url: "https://zokoanime.video/stream/mal/21/1/sub", source_site: "zokoanime.video" },
          { url: "https://animeflv.net/ver/show-1", source_site: "animeflv" },
        ],
      },
    ];
    const display = buildDisplayEpisodes([], canonical, "anime", "show-1");
    expect(countDisplayPlatforms(canonical, display, "anime")).toEqual([{ domain: "zokoanime", episodes: 1 }]);
  });

  it("falls back to displayed legacy rows when the selected canonical twin has no main-path links", () => {
    const canonical = [
      {
        id: "metadata-only-twin",
        season_number: 1,
        episode_number: 1,
        // A retired provider can still be present on a canonical row from
        // an older import. It must not hide the displayed active legacy row.
        links: [{ url: "https://animeflv.net/ver/show-1", source_site: "animeflv" }],
      },
    ];
    const display = [
      {
        id: "legacy-1",
        title: "Episodio 1",
        episode_number: 1,
        season_number: 1,
        source_url: "https://ww3.gnulahd.nu/show-1x01/",
      },
    ];

    expect(countDisplayPlatforms(canonical, display, "series")).toEqual([{ domain: "gnula", episodes: 1 }]);
  });

  it("merges platform links from equivalent canonical rows without duplicating URLs", () => {
    const merged = mergeCanonicalEpisodes([
      [{
        id: "lat-episode-1",
        season_number: 1,
        episode_number: 1,
        links: [{ url: "https://latanime.org/ver/show-1", source_site: "latanime" }],
      }],
      [{
        id: "zoko-episode-1",
        season_number: 1,
        episode_number: 1,
        links: [
          { url: "https://zokoanime.video/stream/mal/21/1/sub", source_site: "zokoanime.video" },
          { url: "https://latanime.org/ver/show-1", source_site: "latanime" },
        ],
      }],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("lat-episode-1");
    expect(merged[0].links.map((link) => link.source_site)).toEqual(["latanime", "zokoanime.video"]);
  });
});
