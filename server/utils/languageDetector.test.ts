import { describe, expect, it } from "vitest";
import { detectLanguageHints, normalizeLanguageCode } from "./languageDetector";

describe("languageDetector", () => {
  it("normalizes common BCP-47 and catalog aliases", () => {
    expect(normalizeLanguageCode("Español")).toBe("es");
    expect(normalizeLanguageCode("Latino")).toBe("es-419");
    expect(normalizeLanguageCode("ja-JP")).toBe("ja-JP");
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

  it("preserves explicit adapter metadata", () => {
    expect(detectLanguageHints({
      title: "Episode",
      link_type: "sub",
      language: "sub",
      audio_language: "ja",
      subtitle_language: "en",
    })).toEqual({ language: "sub", audio_language: "ja", subtitle_language: "en" });
  });

  it("prefers a Spanish subtitle track when a manifest declares several", () => {
    expect(detectLanguageHints({
      title: "Episode",
      url: "https://cdn.example/master.m3u8",
      subtitles: [
        { src: "https://subs.example/en.vtt", label: "English" },
        { src: "https://subs.example/es.vtt", label: "Español (Latino)" },
      ],
    })).toMatchObject({ subtitle_language: "es" });
  });
});
