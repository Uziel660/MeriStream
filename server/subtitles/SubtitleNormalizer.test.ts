import { describe, expect, it } from "vitest";
import { dedupeSubtitleCandidates, normalizeSubtitleLanguage } from "./SubtitleNormalizer";
import { rankSubtitleCandidates } from "./SubtitleRanker";

describe("SubtitleNormalizer", () => {
  it("normalizes the supported Spanish and English variants", () => {
    expect(normalizeSubtitleLanguage("spa")).toBe("es");
    expect(normalizeSubtitleLanguage("español latino")).toBe("es-419");
    expect(normalizeSubtitleLanguage("eng")).toBe("en");
  });

  it("deduplicates repeated candidates but preserves separate releases", () => {
    const base = { provider: "opensubtitles-v3", language: "es", label: "Español · WEB-DL", sourceUrl: "https://subs5.strem.io/a.srt" };
    const result = dedupeSubtitleCandidates([
      { ...base, id: "1" },
      { ...base, id: "2" },
      { ...base, id: "3", release: "BluRay", sourceUrl: "https://subs5.strem.io/b.srt" },
    ]);
    expect(result).toHaveLength(2);
  });

  it("ranks es-419 above es and en while keeping provider diversity", () => {
    const result = rankSubtitleCandidates([
      { id: "en", provider: "yify", language: "en", label: "English", sourceUrl: "https://yts-subs.com/a.zip" },
      { id: "es", provider: "opensubtitles-v3", language: "es", label: "Español", sourceUrl: "https://subs5.strem.io/b.srt" },
      { id: "lat", provider: "tvsubtitles", language: "es-419", label: "Español Latino", sourceUrl: "https://tvsubtitles.net/c.zip" },
    ], ["es-419", "es", "en"]);
    expect(result.map((item) => item.language)).toEqual(["es-419", "es", "en"]);
  });

  it("honors an explicit English preference", () => {
    const result = rankSubtitleCandidates([
      { id: "es", provider: "a", language: "es", label: "Español", sourceUrl: "https://subs5.strem.io/a.srt" },
      { id: "en", provider: "b", language: "en", label: "English", sourceUrl: "https://subs5.strem.io/b.srt" },
    ], ["en"]);
    expect(result).toHaveLength(1);
    expect(result[0].language).toBe("en");
  });
});
