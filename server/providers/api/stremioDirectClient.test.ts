import { afterEach, describe, expect, it, vi } from "vitest";
import { StremioDirectClient } from "./stremioDirectClient";

describe("StremioDirectClient", () => {
  afterEach(() => {
    delete process.env.STREMIO_DIRECT_ADDONS;
    vi.unstubAllGlobals();
  });

  it("accepts only native streams from configured public addons", async () => {
    process.env.STREMIO_DIRECT_ADDONS = "demo|https://addon.example|tmdb";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://addon.example/stream/movie/tmdb%3A123.json");
      return new Response(JSON.stringify({
        streams: [
          { url: "https://cdn.example/video/master.m3u8", behaviorHints: { proxyHeaders: { request: { Referer: "https://addon.example/" } } } },
          { url: "https://provider.example/embed/123" },
          { externalUrl: "https://provider.example/watch/123" },
        ],
      }), { status: 200 });
    }));

    const sources = await new StremioDirectClient().resolve({ tmdbId: 123, kind: "movie" });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      provider: "stremio-direct:demo",
      providerGroup: "api",
      streamType: "hls",
      url: "https://cdn.example/video/master.m3u8",
      requiredHeaders: { Referer: "https://addon.example/" },
    });
  });

  it("returns no sources when no addon is configured", async () => {
    await expect(new StremioDirectClient().resolve({ tmdbId: 123, kind: "movie" })).resolves.toEqual([]);
  });
});
