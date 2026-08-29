import { describe, it, expect } from "vitest";
import { EmbedResolvers } from "./resolvers";
import { parseMegaUrl, isMegaUrl } from "./resolvers/megaResolver";

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

describe("MegaResolver - formato TioAnime /embed/!ID!KEY", () => {
  it("parsea https://mega.nz/embed/!ID!KEY (formato TioAnime legacy con ! en path)", () => {
    const url = "https://mega.nz/embed/!BTU1DKKR!RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk";
    const parsed = parseMegaUrl(url);
    expect(parsed).not.toBeNull();
    expect(parsed?.fileId).toBe("BTU1DKKR");
    expect(parsed?.fileKey).toBe("RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk");
    expect(parsed?.canonicalUrl).toBe("https://mega.nz/file/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk");
    expect(parsed?.embedUrl).toBe("https://mega.nz/embed/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk");
    expect(isMegaUrl(url)).toBe(true);
  });

  it("mantiene compatibilidad con formato nuevo /file/ID#KEY", () => {
    const url = "https://mega.nz/file/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk";
    const parsed = parseMegaUrl(url);
    expect(parsed?.fileId).toBe("BTU1DKKR");
    expect(parsed?.fileKey).toBe("RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk");
  });

  it("normaliza cualquier variante a canonical y embed", () => {
    const variants = [
      "https://mega.nz/embed/!BTU1DKKR!RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk",
      "https://mega.nz/file/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk",
      "https://mega.nz/#!BTU1DKKR!RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk",
      "https://mega.nz/embed/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk",
    ];
    for (const v of variants) {
      const p = parseMegaUrl(v);
      expect(p, `falló para ${v}`).not.toBeNull();
      expect(p?.canonicalUrl).toBe("https://mega.nz/file/BTU1DKKR#RLPNcC8ohIh769HwlEZUPfJLH5n3Xsd2CiIZeEU0cBk");
    }
  });
});
