import { describe, it, expect } from "vitest";
import { EmbedResolvers } from "./resolvers";

describe("EmbedResolvers with Status & Meta", () => {
  it("correctly identifies direct media URLs", () => {
    expect(EmbedResolvers.isDirectMediaUrl("https://example.com/playlist.m3u8")).toBe(true);
    expect(EmbedResolvers.isDirectMediaUrl("https://example.com/video.mp4?token=123")).toBe(true);
    expect(EmbedResolvers.isDirectMediaUrl("https://example.com/embed/123")).toBe(false);
  });

  it("extracts friendly provider names", () => {
    expect(EmbedResolvers.getProviderName("https://mega.nz/embed/!abc")).toBe("Mega");
    expect(EmbedResolvers.getProviderName("https://mp4upload.com/embed-123.html")).toBe("MP4Upload");
    expect(EmbedResolvers.getProviderName("https://voe.sx/e/xyz")).toBe("VOE");
    expect(EmbedResolvers.getProviderName("https://yourupload.com/embed/123")).toBe("YourUpload");
  });

  it("resolves mega file URL to embed", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://mega.nz/file/!abc");
    expect(meta.url).toBe("https://mega.nz/embed/!abc");
    expect(meta.type).toBe("embed");
    expect(meta.provider).toBe("Mega");
  });

  it("resolves direct mp4 correctly with meta", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://cdn.example.com/movie.mp4");
    expect(meta.resolved).toBe(true);
    expect(meta.type).toBe("direct");
  });
});
