import { afterEach, describe, expect, it, vi } from "vitest";
import { FlixQuestClient } from "./flixquestClient";

function response(body: unknown, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("FlixQuestClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back from the retired v1 route to the documented v2 contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/showbox/watch-movie")) return response({}, 404);
      if (url.includes("/api/v2/stream-movie") && url.includes("provider=showbox")) {
        return response({
          success: true,
          provider: "showbox",
          links: [{ url: "https://cdn.example/movie.m3u8?token=short-lived", isM3U8: true, quality: "1080p" }],
        });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlixQuestClient("https://flixquest.example", ["showbox"]);
    const sources = await client.resolve({ tmdbId: 550, kind: "movie" });

    expect(sources).toHaveLength(1);
    expect(sources[0].streamType).toBe("hls");
    expect(sources[0].canonicalLocator).toBe("tmdb:550:1:1");
    expect(sources[0].url).toContain("short-lived");
  });

  it("tries a configured mirror when the first API origin is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://dead.example")) return response({}, 503);
      if (url.includes("/showbox/watch-movie")) return response({}, 404);
      if (url.startsWith("https://mirror.example/api/v2/stream-movie") && url.includes("provider=showbox")) {
        return response({ links: [{ url: "https://cdn.example/mirror.m3u8", isM3U8: true }] });
      }
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FlixQuestClient("https://dead.example,https://mirror.example", ["showbox"]);
    const sources = await client.resolve({ tmdbId: 550, kind: "movie" });

    expect(sources).toHaveLength(1);
    expect(sources[0].canonicalLocator).toBe("tmdb:550:1:1");
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("https://mirror.example/api/v2/stream-movie"))).toBe(true);
  });

  it("does not contact the retired public endpoint when no API is configured", async () => {
    vi.stubEnv("FLIXQUEST_API_URL", "");
    vi.stubEnv("FLIXQUEST_API_URLS", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const sources = await new FlixQuestClient().resolve({ tmdbId: 550, kind: "movie" });

    expect(sources).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
