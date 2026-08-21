import { describe, it, expect } from "vitest";
import { scraperManager } from "../universalScraper";
import { EmbedResolvers } from "../resolvers";
import { MediaValidator } from "../validator";

describe("Video Stream Extraction & Resolvers", () => {
  it("validates all known embed hosts without dropping them", async () => {
    const embeds = [
      "https://mega.nz/embed/sample1",
      "https://streamwish.to/e/12345",
      "https://filemoon.sx/e/67890",
      "https://voe.sx/e/abcdef",
      "https://www.yourupload.com/embed/sample2",
      "https://vidmoly.to/embed-xyz.html",
      "https://streamtape.com/e/12345",
      "https://cdn.example.com/playlist.m3u8",
    ];

    const validated = await MediaValidator.validateUrls(embeds);
    expect(validated).toHaveLength(8);
    expect(validated).toContain("https://streamwish.to/e/12345");
    expect(validated).toContain("https://filemoon.sx/e/67890");
    expect(validated).toContain("https://www.yourupload.com/embed/sample2");
    expect(validated).toContain("https://cdn.example.com/playlist.m3u8");
  });

  it("extracts direct video and hls streams via DirectStreamAdapter", async () => {
    const stream = await scraperManager.extractStream("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
    expect(stream.stream_url).toBe("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
    expect(stream.all_available_streams).toContain("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8");
  });

  it("resolves direct mp4/m3u8 from embed resolvers", async () => {
    const resolvedMega = await EmbedResolvers.resolve("https://mega.nz/embed/sample123");
    expect(resolvedMega).toBe("https://mega.nz/embed/sample123");

    const resolvedZilla = await EmbedResolvers.resolve("https://player.zilla-networks.com/m3u8/sample.m3u8");
    expect(resolvedZilla).toBe("https://player.zilla-networks.com/m3u8/sample.m3u8");
  });
});
