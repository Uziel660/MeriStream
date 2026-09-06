import { describe, it, expect, vi } from "vitest";
import { resolveMegaplay, isMegaplayUrl } from "./megaplayResolver";

describe("megaplayResolver", () => {
  it("identifica URLs de Megaplay", () => {
    expect(isMegaplayUrl("https://megaplay.buzz/stream/s-2/107257/sub")).toBe(true);
    expect(isMegaplayUrl("https://megaplay.top/embed/123")).toBe(true);
    expect(isMegaplayUrl("https://example.com/embed")).toBe(false);
  });

  it("resuelve HTML + data-id a .m3u8 nativo y subtítulos", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/stream/s-2/")) {
        return Promise.resolve(
          new Response(
            `<div id="megaplay-player" data-id="13461" data-realid="107257"></div>`,
            { status: 200 }
          )
        );
      }
      if (url.includes("getSources?id=13461")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sources: { file: "https://cdn.imgnex.top/anime/test/master.m3u8" },
              tracks: [
                { file: "https://cdn.imgnex.top/anime/test/spa.vtt", kind: "captions", label: "Spanish", default: true },
              ],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });

    try {
      const res = await resolveMegaplay("https://megaplay.buzz/stream/s-2/107257/sub");
      expect(res.url).toBe("https://cdn.imgnex.top/anime/test/master.m3u8");
      expect(res.requiredHeaders.Referer).toBe("https://anipulse.to/");
      expect(res.subtitles.length).toBe(1);
      expect(res.subtitles[0].src).toBe("https://cdn.imgnex.top/anime/test/spa.vtt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
