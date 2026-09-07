import { describe, expect, it } from "vitest";
import { normalizeKitsuAnimeRecord } from "./animeIdentity";

describe("anime identity aliases", () => {
  it("normalizes canonical, English, Japanese and abbreviated Kitsu titles", () => {
    const identity = normalizeKitsuAnimeRecord({
      id: "47679",
      attributes: {
        canonicalTitle: "Jigokuraku 2nd Season",
        titles: {
          en: "Hell's Paradise Season 2",
          en_jp: "Jigokuraku 2nd Season",
          ja_jp: "地獄楽 第二期",
        },
        abbreviatedTitles: ["Hell's Paradise: Jigokuraku Season 2"],
      },
    });

    expect(identity?.kitsuId).toBe("47679");
    expect(identity?.aliases).toEqual(expect.arrayContaining(["Jigokuraku 2nd Season", "Hell's Paradise Season 2"]));
    expect(identity?.normalizedAliases).toContain("hellsparadise");
  });
});
