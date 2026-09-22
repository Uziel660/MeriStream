import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedResolvers } from "../../resolvers";
import { TioAnimeAdapter } from "./TioAnimeAdapter";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TioAnimeAdapter", () => {
  it("parses every nested entry in the current videos array", () => {
    const adapter = new TioAnimeAdapter();
    const html = String.raw`<script>
      var videos = [["Mega","https:\/\/mega.nz\/embed\/!id!key",0,0],["Voe","https:\/\/voe.sx\/e\/abc",0,0],["YourUpload","https:\/\/www.yourupload.com\/embed\/xyz",0,0]];
    </script>`;

    expect(adapter.extractVideosArray(html)).toEqual([
      "https://mega.nz/embed/!id!key",
      "https://voe.sx/e/abc",
      "https://www.yourupload.com/embed/xyz",
    ]);
  });

  it("follows the first episode when an old row points to an anime detail page", async () => {
    const adapter = new TioAnimeAdapter();
    const detailUrl = "https://tioanime.com/anime/demo";
    const episodeUrl = "https://tioanime.com/ver/demo-1";
    const detail = String.raw`<script>
      var anime_info = ["1","demo","Demo"];
      var episodes = [1];
    </script>`;
    const episode = String.raw`<script>
      var videos = [["Mega","https:\/\/mega.nz\/embed\/!id!key",0,0]];
    </script>`;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(url === detailUrl ? detail : episode, { status: 200 });
    }));
    vi.spyOn(EmbedResolvers, "resolve").mockResolvedValue("https://cdn.example/video.m3u8");
    vi.spyOn(EmbedResolvers, "isPlaceholderUrl").mockReturnValue(false);

    const result = await adapter.extractStream(detailUrl);

    expect(result.stream_url).toBe("https://cdn.example/video.m3u8");
    expect(result.all_available_streams).toContain("https://cdn.example/video.m3u8");
  });
});
