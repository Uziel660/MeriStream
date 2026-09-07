import { describe, expect, it } from "vitest";
import { SubtitleGateway } from "./SubtitleGateway";
import type { SubtitleProvider } from "./types";

function provider(id: string, result: any[], delay = 0): SubtitleProvider {
  return { id, kinds: ["movie"], search: async () => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return result;
  }};
}

describe("SubtitleGateway", () => {
  it("keeps working when one provider times out", async () => {
    const gateway = new SubtitleGateway([
      provider("tvsubtitles", [], 50),
      provider("yify", [{ id: "fast", provider: "yify", language: "en", label: "English", sourceUrl: "https://www.yifysubtitles.ch/fast.srt" }]),
    ], { idResolver: { resolve: async () => "tt1234567", clear: () => {} } as any, providerTimeoutMs: 10 });
    const result = await gateway.search({ tmdbId: 1, kind: "movie", preferredLanguages: ["en"] });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].url).toMatch(/^\/api\/v1\/subtitles\/file\//);
  });

  it("queries eligible providers in parallel and returns health data", async () => {
    const gateway = new SubtitleGateway([
      provider("a", [{ id: "a", provider: "a", language: "es", label: "Español", sourceUrl: "https://subs5.strem.io/a.srt" }]),
      provider("b", [{ id: "b", provider: "b", language: "en", label: "English", sourceUrl: "https://subs5.strem.io/b.srt" }]),
    ], { idResolver: { resolve: async () => "tt1234567", clear: () => {} } as any });
    const result = await gateway.search({ tmdbId: 1, kind: "movie", preferredLanguages: ["es", "en"] });
    expect(result.providers.queried).toEqual(["a", "b"]);
    expect(Object.keys(gateway.healthSnapshot())).toEqual(["a", "b"]);
  });
});
