import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedResolvers } from "./resolvers";

function zokoToken(payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const key = "otaku-embed-v1";
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= key.charCodeAt(i % key.length);
  return bytes.toString("base64");
}

describe("HiAnimes playback resolution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves a canonical watch page through its episode API and Zoko HLS", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "https://animehot.cc/api/episode/demo-episode") {
        return new Response(JSON.stringify({
          episode: {
            slug: "demo-episode",
            episodeNumber: 1,
            title: "Demo Episode",
            link: { sub: ["https://zokoanime.video/stream/mal/1/1/sub"], dub: [] },
          },
        }), { status: 200 });
      }
      if (url === "https://zokoanime.video/stream/mal/1/1/sub") {
        return new Response(`<script>window.__P="${zokoToken({ src: "https://hls2.aniwatchtv.uk/v/demo/master.m3u8", subtitles: [{ src: "https://subs.example/demo.vtt", lang: "en", label: "English" }] })}"</script>`, { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await EmbedResolvers.resolveWithMeta("https://hianimes.se/watch/demo-episode");
    expect(result.resolved).toBe(true);
    expect(result.url).toContain("hls2.aniwatchtv.uk/v/demo/master.m3u8");
    expect(result.canonical_locator).toBe("https://hianimes.se/watch/demo-episode");
    expect(result.requiredHeaders?.Referer).toBe("https://zokoanime.video/");
    expect(result.subtitles?.[0]).toMatchObject({ language: "en", src: "https://subs.example/demo.vtt" });
  });
});
