import { describe, expect, it, vi } from "vitest";
import { decodeVidSrcTrackPayload, parseVidSrcHlsAudioTracks, resolveVidSrcEmbed, VidSrcClient } from "./vidsrcClient";

function mockResponse(body: string, status = 200, contentType = "text/html") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("VidSrc native resolver", () => {
  it("parses multiaudio declarations from a master HLS manifest", () => {
    const tracks = parseVidSrcHlsAudioTracks(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,AUTOSELECT=NO,URI="audio/hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio0"
video/720p.m3u8`, "https://cdn.example/master.m3u8");

    expect(tracks).toEqual([
      expect.objectContaining({ id: "audio0:hi", label: "Hindi", language: "hi", url: "https://cdn.example/audio/hi.m3u8", isDefault: false }),
      expect.objectContaining({ id: "audio0:en", label: "English", language: "en", url: "https://cdn.example/audio/en.m3u8", isDefault: true }),
    ]);
  });

  it("decodes the encrypted subtitle catalog used by the multilang player", () => {
    const payload = decodeVidSrcTrackPayload("U2FsdGVkX18xMjM0NTY3OJy3tOUvu4m1oDeVObaBMeaAwYe06qS0FV8VCTR6H3FKQXDxgSwQ471mLwBZY-NIjtJrEwNKy1wpH2IeZleanwO5cS_xbZD1P6U5oR3P1dUbNTSdgGmlbcDZrPJYalY8WUJIOMxDDE6PlODj8rEE5Vpb8Z1RJtI-ZNMYFA1LYLNW7-oFhD64dPhpkT_8jpw9s2Q1ILWP8sA9aZ4SUkOthSk");

    expect(payload?.subtitles).toEqual([
      expect.objectContaining({ title: "Español", language: "es", uri: "https://subs.example/fight.srt" }),
    ]);
    expect(payload?._req_ts).toBeUndefined();
  });

  it("attaches audio and subtitle tracks to a direct VidSrc result", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/embed/movie/550")) {
        return mockResponse('<iframe src="https://player.example/movie/550"></iframe>');
      }
      if (url === "https://player.example/movie/550") {
        return mockResponse('<script>var source = { file: "https://cdn.example/master.m3u8" };</script>');
      }
      if (url === "https://cdn.example/master.m3u8") {
        return mockResponse(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,URI="hi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="audio0"
video.m3u8`, 200, "application/vnd.apple.mpegurl");
      }
      if (url === "https://cdn.example/hi.m3u8" || url === "https://cdn.example/en.m3u8" || url === "https://cdn.example/video.m3u8") {
        return mockResponse(`#EXTM3U
#EXTINF:6,
segment.ts`, 200, "application/vnd.apple.mpegurl");
      }
      if (url === "https://cdn.example/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), { status: 200, headers: { "Content-Type": "video/mp2t" } });
      }
      if (url.startsWith("https://web.nxsha.app/api/subtitles?q=")) {
        return mockResponse(JSON.stringify({ _hash: "U2FsdGVkX18xMjM0NTY3OJy3tOUvu4m1oDeVObaBMeaAwYe06qS0FV8VCTR6H3FKQXDxgSwQ471mLwBZY-NIjtJrEwNKy1wpH2IeZleanwO5cS_xbZD1P6U5oR3P1dUbNTSdgGmlbcDZrPJYalY8WUJIOMxDDE6PlODj8rEE5Vpb8Z1RJtI-ZNMYFA1LYLNW7-oFhD64dPhpkT_8jpw9s2Q1ILWP8sA9aZ4SUkOthSk" }), 200, "application/json");
      }
      return mockResponse("not found", 404);
    });

    const result = await resolveVidSrcEmbed(
      "https://vidsrc.me/embed/movie/550",
      fetcher as unknown as typeof fetch,
    );

    expect(result.status).toBe("direct");
    expect(result.audioTracks?.map((track) => track.language)).toEqual(["hi", "en"]);
    expect(result.subtitles).toEqual([
      { label: "Español", language: "es", url: "https://subs.example/fight.srt" },
    ]);
  });

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

  it("does not publish an HLS URL whose CDN returns an error page", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/embed/movie/216405")) {
        return mockResponse('<iframe src="https://cloudnestra.com/player/dead"></iframe>');
      }
      if (url === "https://cloudnestra.com/player/dead") {
        return mockResponse('<script>var source = { file: "https://proxy.itsnitrox.tech/master.m3u8" };</script>');
      }
      if (url === "https://proxy.itsnitrox.tech/master.m3u8") {
        return mockResponse("<html><title>Attention Required!</title></html>", 403, "text/html");
      }
      return mockResponse("not found", 404);
    });

    const client = new VidSrcClient(
      ["https://vidsrc.ir"],
      fetcher as unknown as typeof fetch,
    );
    const sources = await client.resolve({ tmdbId: 216405, kind: "movie" });

    expect(sources).toEqual([]);
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
      if (url === "https://cdn.example/show/master.m3u8") {
        return mockResponse(`#EXTM3U
#EXTINF:6,
/segment.ts`, 200, "application/vnd.apple.mpegurl");
      }
      if (url === "https://cdn.example/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), { status: 200, headers: { "Content-Type": "video/mp2t" } });
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

  it("treats a TMDB anime work as a TV route", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/embed/tv/21/1/1")) {
        return mockResponse('<iframe src="https://cloudnestra.com/player/anime"></iframe>');
      }
      if (url === "https://cloudnestra.com/player/anime") {
        return mockResponse("<script>var source = { file: 'https://cdn.example/anime/master.m3u8' };</script>");
      }
      if (url === "https://cdn.example/anime/master.m3u8") {
        return mockResponse(`#EXTM3U
#EXTINF:6,
/segment.ts`, 200, "application/vnd.apple.mpegurl");
      }
      if (url === "https://cdn.example/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), { status: 200, headers: { "Content-Type": "video/mp2t" } });
      }
      return mockResponse("not found", 404);
    });

    const client = new VidSrcClient(["https://vidsrc.ir"], fetcher as unknown as typeof fetch);
    const sources = await client.resolve({ tmdbId: 21, kind: "anime", season: 1, episode: 1 });

    expect(seen.some((url) => url.includes("/embed/tv/21/1/1"))).toBe(true);
    expect(sources[0]?.url).toBe("https://cdn.example/anime/master.m3u8");
  });

  it("resolves the modern data-api -> player -> stream API chain", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://vidsrcme.ru/embed/movie/550") {
        return mockResponse('<iframe id="player_iframe" data-api="/vs_src.php?type=movie&amp;id=550"></iframe>');
      }
      if (url === "https://vidsrcme.ru/vs_src.php?type=movie&id=550") {
        return mockResponse(JSON.stringify({ src: "https://cloudorchestranova.com/embed/movie/550?vs=token" }), 200, "application/json");
      }
      if (url === "https://cloudorchestranova.com/embed/movie/550?vs=token") {
        return mockResponse('<script>window.CONFIG = {"api":"https://data.vidsrcme.ru/api.php?type=movie&amp;tmdb=550&amp;stream_urls"};</script>');
      }
      if (url === "https://data.vidsrcme.ru/api.php?type=movie&tmdb=550&stream_urls") {
        return mockResponse(JSON.stringify({ data: { stream_urls: ["https://cdn.example/fight-club/master.m3u8"] } }), 200, "application/json");
      }
      if (url === "https://cdn.example/fight-club/master.m3u8") {
        return mockResponse(`#EXTM3U
#EXTINF:6,
/segment.ts`, 200, "application/vnd.apple.mpegurl");
      }
      if (url === "https://cdn.example/segment.ts") {
        return new Response(new Uint8Array([0x47, 0x40, 0x00, 0x10]), { status: 200, headers: { "Content-Type": "video/mp2t" } });
      }
      return mockResponse("not found", 404);
    });

    const result = await resolveVidSrcEmbed(
      "https://vidsrcme.ru/embed/movie/550",
      fetcher as unknown as typeof fetch,
    );

    expect(result.status).toBe("direct");
    expect(result.playerOrigin).toBe("https://cloudorchestranova.com");
    expect(result.hlsUrl).toBe("https://cdn.example/fight-club/master.m3u8");
  });
});
