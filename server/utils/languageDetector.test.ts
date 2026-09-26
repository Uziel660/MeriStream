import { describe, expect, it } from "vitest";
import { detectDoramasytLanguageHints, detectLanguageHints, normalizeLanguageCode } from "./languageDetector";

describe("languageDetector", () => {
  it("normalizes common BCP-47 and catalog aliases", () => {
    expect(normalizeLanguageCode("Español")).toBe("es");
    expect(normalizeLanguageCode("Latino")).toBe("es-419");
    expect(normalizeLanguageCode("ja-JP")).toBe("ja-JP");
  });

  it("preserves meaningful regional variants from human labels", () => {
    expect(normalizeLanguageCode("Spanish (Latin America)")).toBe("es-419");
    expect(normalizeLanguageCode("Español Latinoamérica")).toBe("es-419");
    expect(normalizeLanguageCode("Castellano España")).toBe("es-ES");
    expect(normalizeLanguageCode("Português Brasil")).toBe("pt-BR");
    expect(normalizeLanguageCode("Portuguese (Portugal)")).toBe("pt-PT");
    expect(normalizeLanguageCode("Chinese Simplified")).toBe("zh-Hans");
    expect(normalizeLanguageCode("Chinese Traditional")).toBe("zh-Hant");
  });

  it("normalizes common three-letter and localized language names", () => {
    expect(normalizeLanguageCode("KOR")).toBe("ko");
    expect(normalizeLanguageCode("Coreano")).toBe("ko");
    expect(normalizeLanguageCode("FRA")).toBe("fr");
    expect(normalizeLanguageCode("Alemán")).toBe("de");
    expect(normalizeLanguageCode("Italiano")).toBe("it");
  });

  it("normalizes VidSrc and subtitle languages commonly used by Indian providers", () => {
    expect(normalizeLanguageCode("Hindi")).toBe("hi");
    expect(normalizeLanguageCode("Tamil")).toBe("ta");
    expect(normalizeLanguageCode("Telugu")).toBe("te");
    expect(normalizeLanguageCode("Malayalam")).toBe("ml");
    expect(normalizeLanguageCode("Bengali")).toBe("bn");
    expect(normalizeLanguageCode("ea")).toBe("es-419");
    expect(normalizeLanguageCode("pb")).toBe("pt-BR");
  });

  it("detects Spanish dub/sub metadata without touching video bytes", () => {
    expect(detectLanguageHints({ title: "One Piece Latino", url: "https://cdn.example/ep.mp4" })).toMatchObject({
      language: "dub",
      audio_language: "es-419",
    });
    const sub = detectLanguageHints({ title: "Bleach Sub Español", url: "https://cdn.example/ep" });
    expect(sub).toMatchObject({ language: "sub", subtitle_language: "es" });
    expect(sub).not.toHaveProperty("audio_language");
  });

  it("distinguishes DoramasYT Latino/Castellano fichas from original audio", () => {
    expect(detectDoramasytLanguageHints("https://www.doramasyt.com/ver/whats-wrong-with-secretary-kim-latino-episodio-1"))
      .toEqual({ language: "dub", audio_language: "es-419" });
    expect(detectDoramasytLanguageHints("https://www.doramasyt.com/ver/demo-castellano-episodio-1"))
      .toEqual({ language: "dub", audio_language: "es-ES" });
    expect(detectDoramasytLanguageHints("https://www.doramasyt.com/ver/whats-wrong-with-secretary-kim-episodio-1"))
      .toEqual({ language: "sub", subtitle_language: "es" });
    expect(detectDoramasytLanguageHints("https://other.example/ver/demo-latino-episodio-1")).toBeUndefined();
  });

  it("preserves explicit adapter metadata", () => {
    expect(detectLanguageHints({
      title: "Episode",
      link_type: "sub",
      language: "sub",
      audio_language: "ja",
      subtitle_language: "en",
    })).toEqual({ language: "sub", audio_language: "ja", subtitle_language: "en" });
  });

  it("prefers Latin American Spanish when a manifest declares several Spanish tracks", () => {
    expect(detectLanguageHints({
      title: "Episode",
      url: "https://cdn.example/master.m3u8",
      subtitles: [
        { src: "https://subs.example/en.vtt", label: "English" },
        { src: "https://subs.example/es.vtt", label: "Español" },
        { src: "https://subs.example/lat.vtt", label: "Spanish (Latin America)" },
      ],
    })).toMatchObject({ subtitle_language: "es-419" });
  });
});
