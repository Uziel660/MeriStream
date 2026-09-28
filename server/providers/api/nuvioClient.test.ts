import { afterEach, describe, expect, it, vi } from "vitest";
import { NuvioClient } from "./nuvioClient";

describe("NuvioClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tries configured API mirrors and keeps the TMDB locator stable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://dead.example")) return new Response("", { status: 503 });
      if (url.startsWith("https://mirror.example/stream/movie/")) {
        return new Response(JSON.stringify({ streams: [{ url: "https://cdn.example/movie.mp4", type: "mp4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new NuvioClient("https://dead.example;https://mirror.example");
    const sources = await client.resolve({ tmdbId: 550, kind: "movie" });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.canonicalLocator).toBe("tmdb:550:1:1");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("https://mirror.example/stream/movie/"))).toBe(true);
  });
});
