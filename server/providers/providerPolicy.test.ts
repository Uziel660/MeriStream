import { describe, expect, it } from "vitest";
import {
  getProviderPriority,
  normalizeLanguageTag,
  normalizeProviderId,
  renditionPreferenceScore,
} from "./providerPolicy";

describe("providerPolicy", () => {
  it("prioritizes AnimeAV1 and AnimeFLV over legacy anime fallbacks", () => {
    expect(getProviderPriority("animeav1")).toBeLessThan(getProviderPriority("animeflv"));
    expect(getProviderPriority("animeflv")).toBeLessThan(getProviderPriority("tioanime"));
  });

  it("normalizes provider aliases and rotating subdomains", () => {
    expect(normalizeProviderId("https://www.animeav1.com/media/test")).toBe("animeav1");
    expect(normalizeProviderId("jkanime.net")).toBe("jkanime");
    expect(normalizeProviderId("www.cinecalidad.am")).toBe("cinecalidad");
    expect(normalizeProviderId("https://ww3.gnulahd.nu/ver/peliculas/")).toBe("gnula");
    expect(normalizeProviderId("https://cdn.animeav1.com/covers/1.jpg")).toBe("animeav1");
  });

  it("uses a stable host key for unknown providers instead of the full URL", () => {
    expect(normalizeProviderId("https://video.example.com/watch/123?token=abc")).toBe("video.example.com");
  });

  it("normalizes language tags used by scraped sources", () => {
    expect(normalizeLanguageTag("latino")).toBe("es-419");
    expect(normalizeLanguageTag("Español Latino")).toBe("es-419");
    expect(normalizeLanguageTag("es_419")).toBe("es-419");
    expect(normalizeLanguageTag("Japonés")).toBe("ja");
    expect(normalizeLanguageTag("eng")).toBe("en");
  });

  it("prefers Japanese audio with Spanish subtitles for anime", () => {
    const jaEs = renditionPreferenceScore({
      contentKind: "anime",
      audio_language: "ja",
      subtitle_language: "es",
    });
    const dubEs = renditionPreferenceScore({
      contentKind: "anime",
      audio_language: "es-419",
    });
    const jaEn = renditionPreferenceScore({
      contentKind: "anime",
      audio_language: "ja",
      subtitle_language: "en",
    });
    expect(jaEs).toBeGreaterThan(dubEs);
    expect(dubEs).toBeGreaterThan(jaEn);
  });

  it("keeps English and Spanish movie/series renditions close in priority", () => {
    const enEs = renditionPreferenceScore({
      contentKind: "movie",
      audio_language: "en",
      subtitle_language: "es",
    });
    const esEn = renditionPreferenceScore({
      contentKind: "movie",
      audio_language: "es-419",
      subtitle_language: "en",
    });
    expect(Math.abs(enEs - esEn)).toBeLessThanOrEqual(5);
  });
});
