import { describe, expect, it } from "vitest";
import {
  getProviderPriority,
  getProviderPolicy,
  isLegacyProvider,
  isProviderAllowedInMainPath,
  normalizeLanguageTag,
  normalizeProviderId,
  renditionPreferenceScore,
} from "./providerPolicy";
import { getEnabledIngestionTargets } from "./ingestionRegistry";

describe("provider policy v2", () => {
  it("keeps legacy anime providers ordered behind the active sources", () => {
    expect(getProviderPriority("animeav1")).toBeLessThan(getProviderPriority("animeflv"));
    expect(getProviderPriority("animeflv")).toBeLessThan(getProviderPriority("tioanime"));
  });

  it("normalizes rotating subdomains to stable provider ids", () => {
    expect(normalizeProviderId("https://cdn.animeav1.com/covers/1.jpg")).toBe("animeav1");
    expect(normalizeProviderId("https://ww3.gnulahd.nu/ver/peliculas/")).toBe("gnula");
    expect(normalizeProviderId("https://video.example.com/watch/123?token=abc")).toBe("video.example.com");
  });

  it("normalizes language tags and scores anime renditions", () => {
    expect(normalizeLanguageTag("latino")).toBe("es-419");
    expect(normalizeLanguageTag("Español Latino")).toBe("es-419");
    const jaEs = renditionPreferenceScore({ contentKind: "anime", audio_language: "ja", subtitle_language: "es" });
    const dubEs = renditionPreferenceScore({ contentKind: "anime", audio_language: "es-419" });
    const jaEn = renditionPreferenceScore({ contentKind: "anime", audio_language: "ja", subtitle_language: "en" });
    expect(jaEs).toBeGreaterThan(dubEs);
    expect(dubEs).toBeGreaterThan(jaEn);
  });

  it("keeps English and Spanish movie renditions close in priority", () => {
    const enEs = renditionPreferenceScore({ contentKind: "movie", audio_language: "en", subtitle_language: "es" });
    const esEn = renditionPreferenceScore({ contentKind: "movie", audio_language: "es-419", subtitle_language: "en" });
    expect(Math.abs(enEs - esEn)).toBeLessThanOrEqual(5);
  });

  it("keeps the requested short active set and language roles", () => {
    expect(getProviderPolicy("cinecalidad")).toMatchObject({ role: "primary", lifecycle: "active" });
    expect(getProviderPolicy("gnulahd.nu")).toMatchObject({ role: "secondary", lifecycle: "active" });
    expect(getProviderPolicy("latanime.org")).toMatchObject({ role: "primary", lifecycle: "active" });
    expect(getProviderPolicy("zokoanime.video")).toMatchObject({ role: "primary", lifecycle: "active" });
    expect(getProviderPolicy("tioanime")).toMatchObject({ role: "fallback", lifecycle: "legacy" });
    expect(getProviderPriority("cinecalidad")).toBeLessThan(getProviderPriority("gnula"));
  });

  it("normalizes namespaced API providers and VidSrc mirrors", () => {
    expect(normalizeProviderId("flixquest:vidsrc")).toBe("vidsrc");
    expect(normalizeProviderId("https://www.vidsrc.sbs/".trim())).toBe("vidsrc");
    expect(normalizeProviderId("https://zokoanime.video/stream/mal/1/1/sub")).toBe("zokoanime");
  });

  it("admits only active sources, with TioAnime as the anime fallback exception", () => {
    expect(isProviderAllowedInMainPath("cinecalidad", "movie")).toBe(true);
    expect(isProviderAllowedInMainPath("gnula", "series")).toBe(true);
    expect(isProviderAllowedInMainPath("tioanime", "anime")).toBe(true);
    expect(isProviderAllowedInMainPath("tioanime", "movie")).toBe(false);
    expect(isProviderAllowedInMainPath("animeflv", "anime")).toBe(false);
    expect(isProviderAllowedInMainPath("nuvio", "movie")).toBe(false);
    expect(isLegacyProvider("animeflv")).toBe(true);
  });

  it("does not enqueue retired crawlers in the normal ingestion registry", () => {
    const ids = getEnabledIngestionTargets().map((target) => target.providerId);
    expect(ids).toEqual(["cinecalidad", "latanime", "gnula", "gnula", "archive-org"]);
    expect(ids).not.toContain("tioanime");
    expect(ids).not.toContain("lamovie");
  });
});
