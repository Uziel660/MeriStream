import { afterEach, describe, expect, it, vi } from "vitest";
import { openSubtitlesConfig, searchOpenSubtitles } from "./openSubtitles";

const originalKey = process.env.OPENSUBTITLES_API_KEY;
const originalToken = process.env.OPENSUBTITLES_TOKEN;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.OPENSUBTITLES_API_KEY;
  else process.env.OPENSUBTITLES_API_KEY = originalKey;
  if (originalToken === undefined) delete process.env.OPENSUBTITLES_TOKEN;
  else process.env.OPENSUBTITLES_TOKEN = originalToken;
});

describe("open subtitles integration", () => {
  it("fails closed when the operator has not configured an API key", async () => {
    delete process.env.OPENSUBTITLES_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchOpenSubtitles({ tmdbId: 27205, kind: "movie" })).resolves.toEqual({
      configured: false,
      tracks: [],
      reason: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openSubtitlesConfig()).toEqual({ configured: false, tokenConfigured: Boolean(originalToken) });
  });

  it("downloads only file ids returned by the authenticated public API", async () => {
    process.env.OPENSUBTITLES_API_KEY = "test-api-key";
    process.env.OPENSUBTITLES_TOKEN = "test-token";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers["Api-Key"]).toBe("test-api-key");
      expect(headers.Authorization).toBe("Bearer test-token");
      if (url.includes("/subtitles?")) {
        expect(url).toContain("tmdb_id=27205");
        expect(url).toContain("season_number=1");
        expect(url).toContain("episode_number=2");
        return new Response(JSON.stringify({ data: [
          { id: "sub-1", attributes: { language: "es", files: [{ file_id: 11, file_name: "demo.srt" }] } },
          { id: "sub-2", attributes: { language: "en", files: [{ file_id: 12, file_name: "demo-en.srt" }] } },
        ] }), { status: 200 });
      }
      expect(url).toBe("https://api.opensubtitles.com/api/v1/download");
      const payload = JSON.parse(String(init?.body));
      expect(payload.sub_format).toBe("vtt");
      return new Response(JSON.stringify({ link: `https://api.opensubtitles.com/download/${payload.file_id}.vtt` }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchOpenSubtitles({
      tmdbId: 27205,
      kind: "series",
      season: 1,
      episode: 2,
      languages: ["es", "en"],
    });

    expect(result.configured).toBe(true);
    expect(result.tracks).toHaveLength(2);
    expect(result.tracks[0]).toMatchObject({
      language: "es",
      url: "https://api.opensubtitles.com/download/11.vtt",
      is_default: true,
      provider: "opensubtitles",
    });
  });
});
