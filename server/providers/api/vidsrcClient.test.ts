import { describe, expect, it, vi } from "vitest";
import { resolveVidSrcEmbed, VidSrcClient } from "./vidsrcClient";

function mockResponse(body: string, status = 200, contentType = "text/html") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("VidSrc native resolver", () => {
  it("resolves embed -> player -> rcp -> prorcp -> HLS", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/embed/movie/550")) {
        return mockResponse('<iframe src="https://cloudnestra.com/player/abc"></iframe>');
      }
      if (url === "https://cloudnestra.com/player/abc") {
        return mockResponse('<div class="serversList"><div class="server" data-hash="hash1">Server 1</div></div>');
      }
      if (url === "https://cloudnestra.com/rcp/hash1") {
        return mockResponse("<script>var player = { src: '/prorcp/token1' };</script>");
      }
      if (url === "https://cloudnestra.com/prorcp/token1") {
        return mockResponse("<script>var player = { file: 'https://cdn.example/master.m3u8' };</script>");
      }
      return mockResponse("not found", 404);
    });

    const result = await resolveVidSrcEmbed(
      "https://vidsrc.ir/embed/movie/550",
      fetcher as unknown as typeof fetch,
    );

    expect(result.status).toBe("direct");
    expect(result.hlsUrl).toBe("https://cdn.example/master.m3u8");
    expect(result.playerOrigin).toBe("https://cloudnestra.com");
    expect(result.requiredHeaders?.Referer).toBe("https://cloudnestra.com/");
  });

  it("classifies access-control responses instead of exposing embeds", async () => {
    const fetcher = vi.fn(async () => mockResponse("blocked", 403));
    const result = await resolveVidSrcEmbed(
      "https://vidsrc.ir/embed/movie/550",
      fetcher as unknown as typeof fetch,
    );

    expect(result.status).toBe("blocked");
    expect(result.hlsUrl).toBeUndefined();
  });

  it("uses the series TMDB/S/E embed route and returns only playable media", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/embed/tv/1396/1/1")) {
        return mockResponse('<iframe src="https://cloudnestra.com/player/show"></iframe>');
      }
      if (url === "https://cloudnestra.com/player/show") {
        return mockResponse("<script>var source = { file: 'https://cdn.example/show/master.m3u8' };</script>");
      }
      return mockResponse("not found", 404);
    });

    const client = new VidSrcClient(
      ["https://vidsrc.ir"],
      fetcher as unknown as typeof fetch,
    );
    const sources = await client.resolve({
      tmdbId: 1396,
      kind: "series",
      season: 1,
      episode: 1,
    });

    expect(seen.some((url) => url.includes("/embed/tv/1396/1/1"))).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.streamType).toBe("hls");
    expect(sources[0]?.url).toBe("https://cdn.example/show/master.m3u8");
    expect(sources[0]?.provider).toBe("vidsrc");
    expect(sources[0]?.url).not.toMatch(/\/embed\//);
  });
});
