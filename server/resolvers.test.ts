import { afterEach, describe, it, expect, vi } from "vitest";
import { EmbedResolvers, providerResolverRegistry } from "./resolvers";
import { parseMegaUrl, isMegaUrl } from "./resolvers/megaResolver";

describe("EmbedResolvers with Status & Meta", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it("does not promote an opaque signed direct URL as a renewable locator", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://edge.acek-cdn.com/master.m3u8?t=opaque-token");
    expect(meta.resolved).toBe(true);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.canonical_locator).toBeUndefined();
  });

  it("does not advertise an explicitly expired direct URL as renewable/playable", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://cdn.example.com/movie.m3u8?expires=1700000000");
    expect(meta.resolved).toBe(false);
    expect(meta.is_proxyable).toBe(false);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.canonical_locator).toBeUndefined();
    expect(meta.failure_reason).toBe("expired_without_locator");
  });

  it("rejects an expired Vimeos s+e URL with an explicit failure reason", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://s1.vimeos.net/a.m3u8?s=1700000000&e=3600");
    expect(meta).toMatchObject({
      resolved: false,
      is_proxyable: false,
      is_refreshable: false,
      failure_reason: "expired_without_locator",
    });
  });

  it("keeps a signed direct URL with future expiry playable but NOT renewable", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://cdn.example.com/movie.m3u8?expires=1900000000");
    expect(meta.resolved).toBe(true);
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(false);
    // Una URL firmada nunca se promueve como canonical_locator: solo un embed o
    // localizador estable es renovable.
    expect(meta.canonical_locator).toBeUndefined();
  });

  it("treats a stable unsigned direct URL as renewable with itself as locator", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://cdn.example.com/movie.mp4");
    expect(meta.resolved).toBe(true);
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(true);
    expect(meta.canonical_locator).toBe("https://cdn.example.com/movie.mp4");
  });

  it("does not promote a signed Vimeos s+e URL as a renewable locator", async () => {
    const meta = await EmbedResolvers.resolveWithMeta("https://s1.vimeos.net/a.m3u8?s=1999999999&e=3600");
    expect(meta.resolved).toBe(true);
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.canonical_locator).toBeUndefined();
  });

  it("keeps the embed as canonical locator when it resolves to direct media", async () => {
    const locator = "https://vimeos.net/embed-renewable.html";
    vi.spyOn(EmbedResolvers, "resolve").mockResolvedValueOnce("https://s1.vimeos.net/master.m3u8?s=1999999999&e=3600");
    const meta = await EmbedResolvers.resolveWithMeta(locator);
    expect(meta).toMatchObject({
      resolved: true,
      is_proxyable: true,
      is_refreshable: true,
      canonical_locator: locator,
    });
  });

  it("does not advertise an embed resolution whose signed media is already expired", async () => {
    const locator = "https://vimeos.net/embed-expired.html";
    vi.spyOn(EmbedResolvers, "resolve").mockResolvedValueOnce("https://s1.vimeos.net/master.m3u8?s=1700000000&e=60");
    const meta = await EmbedResolvers.resolveWithMeta(locator);
    expect(meta).toMatchObject({
      url: locator,
      resolved: false,
      type: "embed",
      is_proxyable: false,
      is_refreshable: true,
      canonical_locator: locator,
      failure_reason: "unresolved",
    });
  });
});

describe("MegaResolver - formato TioAnime /embed/!ID!KEY", () => {
  it("parsea el embed que transporta el identificador después de #!", () => {
    const url = "https://mega.nz/embed/#!wKMyST7C!rq6hIkheG1LXvqHYScjPvnRagvIamZukhVvcRLbl_P4";
    const parsed = parseMegaUrl(url);
    expect(parsed?.fileId).toBe("wKMyST7C");
    expect(parsed?.fileKey).toBe("rq6hIkheG1LXvqHYScjPvnRagvIamZukhVvcRLbl_P4");
  });

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

describe("ProviderResolverRegistry & Capabilities", () => {
  it("matches providers and returns appropriate capabilities", () => {
    const vimeos = providerResolverRegistry.findResolver("https://vimeos.net/embed-123.html");
    expect(vimeos).toBeDefined();
    expect(vimeos?.name).toBe("Vimeos");
    expect(vimeos?.capabilities.supportsProxy).toBe(true);
    expect(vimeos?.capabilities.requiresHeaders).toBe(true);

    const mega = providerResolverRegistry.findResolver("https://mega.nz/embed/!abc!key");
    expect(mega).toBeDefined();
    expect(mega?.name).toBe("Mega");
    expect(mega?.capabilities.supportsEmbed).toBe(true);

    const direct = providerResolverRegistry.findResolver("https://cdn.example.com/stream.m3u8");
    expect(direct).toBeDefined();
    expect(direct?.name).toBe("DirectMedia");
    expect(direct?.capabilities.supportsDirect).toBe(true);

    const zoko = providerResolverRegistry.findResolver("https://zokoanime.video/stream/mal/32281/1/sub");
    expect(zoko).toBeDefined();
    expect(zoko?.name).toBe("ZokoAnime");
    expect(zoko?.capabilities.supportsEmbed).toBe(false);
  });

  it("handles empty and unrecognized locators safely", async () => {
    const empty = await providerResolverRegistry.resolve("");
    expect(empty.resolved).toBe(false);
    expect(empty.failure_reason).toBe("empty_locator");
  });
});
