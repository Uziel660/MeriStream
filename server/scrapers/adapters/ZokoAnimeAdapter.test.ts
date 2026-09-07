import { afterEach, describe, expect, it, vi } from "vitest";
import { ZokoAnimeAdapter } from "./ZokoAnimeAdapter";

function token(payload: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(payload));
  const key = "otaku-embed-v1";
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= key.charCodeAt(i % key.length);
  return bytes.toString("base64");
}

describe("ZokoAnimeAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a native HLS source with subtitle metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `<script>window.__P="${token({ src: "https://cdn.example/zoko/master.m3u8", title: "Demo", subtitles: [{ src: "https://cdn.example/es.vtt", lang: "es" }] })}"</script>`,
      { status: 200 },
    )));

    const adapter = new ZokoAnimeAdapter();
    const result = await adapter.extractStream("https://zokoanime.video/stream/mal/1/1/sub");
    expect(result.stream_url).toContain("master.m3u8");
    expect(adapter.canHandle("https://zokoanime.video/stream/mal/1/1/sub")).toBe(true);
  });

  it("fails closed without returning the player page as a stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { status: 200 })));
    const result = await new ZokoAnimeAdapter().extractStream("https://zokoanime.video/stream/mal/1/1/sub");
    expect(result).toEqual({ stream_url: "", all_available_streams: [] });
  });
});
