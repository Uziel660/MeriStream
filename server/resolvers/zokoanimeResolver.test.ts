import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZokoAnime } from "./zokoanimeResolver";

function token(payload: Record<string, unknown>): string {
  const text = Buffer.from(JSON.stringify(payload));
  const key = "otaku-embed-v1";
  for (let i = 0; i < text.length; i += 1) text[i] ^= key.charCodeAt(i % key.length);
  return text.toString("base64");
}

describe("zokoanimeResolver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes the player payload and preserves the CDN referer", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Referer).toBe("https://zokoanime.video/");
      return new Response(`<script>window.__P = "${token({ src: "https://hls2.aniwatchtv.uk/v/test/master.m3u8", subtitles: [{ src: "https://subs.example/es.vtt", lang: "es" }] })}"</script>`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/32281/1/sub");
    expect(result.url).toContain("master.m3u8");
    expect(result.subtitles[0]?.lang).toBe("es");
    expect(result.requiredHeaders.Referer).toBe("https://zokoanime.video/");
  });

  it("fails closed when the provider payload is absent or unsafe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>challenge</html>", { status: 200 })));
    const result = await resolveZokoAnime("https://zokoanime.video/stream/mal/1/1/sub");
    expect(result.url).toBe("");

    const invalid = await resolveZokoAnime("https://example.com/player");
    expect(invalid.url).toBe("");
  });
});
