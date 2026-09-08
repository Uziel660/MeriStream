import { describe, expect, it } from "vitest";
import { dedupeSubtitleCandidates, normalizeSubtitleCandidate, normalizeSubtitleLanguage } from "./SubtitleNormalizer";
import { rankSubtitleCandidates } from "./SubtitleRanker";

describe("SubtitleNormalizer", () => {
  it("normalizes regional and common language variants", () => {
    expect(normalizeSubtitleLanguage("spa")).toBe("es");
    expect(normalizeSubtitleLanguage("español latino")).toBe("es-419");
    expect(normalizeSubtitleLanguage("Spanish (Latin America)")).toBe("es-419");
    expect(normalizeSubtitleLanguage("castellano")).toBe("es-ES");
    expect(normalizeSubtitleLanguage("KOR")).toBe("ko");
    expect(normalizeSubtitleLanguage("Português Brasil")).toBe("pt-BR");
    expect(normalizeSubtitleLanguage("eng")).toBe("en");
  });

  it("infers forced and SDH flags without overwriting explicit provider metadata", () => {
    const forced = normalizeSubtitleCandidate({
      id: "forced",
      provider: "opensubtitles-v3",
      language: "Spanish (Latin America)",
      label: "Español Latino",
      fileName: "Movie.2026.WEB-DL.es-LATAM.forced.srt",
      sourceUrl: "https://subs.example/forced.srt",
    });
    expect(forced).toMatchObject({ language: "es-419", forced: true, hearingImpaired: false });
    expect(forced?.label).toContain("Forzado");

    const sdh = normalizeSubtitleCandidate({
      id: "sdh",
      provider: "opensubtitles-v3",
      language: "English",
      label: "English",
      fileName: "Movie.2026.WEB-DL.SDH.srt",
      sourceUrl: "https://subs.example/sdh.srt",
    });
    expect(sdh).toMatchObject({ language: "en", hearingImpaired: true });
    expect(sdh?.label).toContain("SDH");

    const explicit = normalizeSubtitleCandidate({
      id: "explicit",
      provider: "provider",
      language: "en",
      label: "English CC",
      hearingImpaired: false,
      sourceUrl: "https://subs.example/cc.srt",
    });
    expect(explicit?.hearingImpaired).toBe(false);
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

  it("keeps forced and full subtitles distinct", () => {
    const result = dedupeSubtitleCandidates([
      { id: "full", provider: "a", language: "es", label: "Español", sourceUrl: "https://subs.example/a.srt" },
      { id: "forced", provider: "a", language: "es", label: "Español", forced: true, sourceUrl: "https://subs.example/a.srt" },
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
