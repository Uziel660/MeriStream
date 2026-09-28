import { describe, expect, it } from "vitest";
import { tioPlusEpisodeLocatorMatches } from "./providers/tioPlusLocator";

describe("TioPlus episode locator identity", () => {
  it("keeps only the requested season and episode", () => {
    const request = { kind: "series" as const, tmdbId: 5371, season: 1, episode: 17 };
    expect(tioPlusEpisodeLocatorMatches("https://tioplus.app/serie/icarly/season/1/episode/17", request)).toBe(true);
    expect(tioPlusEpisodeLocatorMatches("https://tioplus.app/serie/icarly/season/2/episode/17", request)).toBe(false);
    expect(tioPlusEpisodeLocatorMatches("https://tioplus.app/serie/icarly/season/1/episode/18", request)).toBe(false);
  });

  it("does not reject non-page embeds before the canonical-page policy handles them", () => {
    const request = { kind: "series" as const, tmdbId: 5371, season: 1, episode: 17 };
    expect(tioPlusEpisodeLocatorMatches("https://vidhideplus.com/v/example", request)).toBe(true);
  });

  it("accepts movie locators without episode coordinates", () => {
    expect(tioPlusEpisodeLocatorMatches("https://tioplus.app/pelicula/the-game", {
      kind: "movie",
      tmdbId: 2649,
      season: 1,
      episode: 1,
    })).toBe(true);
  });
});

