import { describe, expect, it } from "vitest";
import {
  createResolutionTiming,
  parseStreamExpiry,
  providerSoftTtlMs,
  classifySourceKind,
  hasSignedQuery,
} from "./resolutionMetadata";

describe("stream resolution expiry", () => {
  it("accepts conventional seconds and milliseconds query expiries only", () => {
    expect(parseStreamExpiry("https://cdn.example/master.m3u8?expires=1900000000").expiresAt).toBe(1_900_000_000_000);
    expect(parseStreamExpiry("https://cdn.example/master.m3u8?exp=1900000000000").expiresAt).toBe(1_900_000_000_000);
    expect(parseStreamExpiry("https://cdn.example/master.m3u8?id=1900000000").expiresAt).toBeUndefined();
    expect(parseStreamExpiry("https://cdn.example/master.m3u8?expires=12").expiresAt).toBeUndefined();
  });

  it("reads exp from compact JWT query tokens", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url");
    expect(parseStreamExpiry(`https://cdn.example/a.m3u8?token=x.${payload}.y`)).toEqual({
      expiresAt: 1_900_000_000_000, source: "jwt",
    });
  });

  it("recognizes VidSrc auth_key/expire signatures and keeps their locator", () => {
    const url = "https://cdn.example/master.m3u8?auth_key=opaque&expire=1900000000000";
    expect(parseStreamExpiry(url)).toEqual({ expiresAt: 1_900_000_000_000, source: "query" });
    expect(hasSignedQuery(url)).toBe(true);
    expect(classifySourceKind(url)).toBe("ephemeral_direct");
  });

  it("computes Vimeos s=<epoch inicio>&e=<TTL segundos> as (s + e) * 1000", () => {
    expect(parseStreamExpiry("https://s1.vimeos.net/a.m3u8?s=1700000000&e=3600")).toEqual({
      expiresAt: (1_700_000_000 + 3600) * 1000, source: "query",
    });
    // e sin s no debe interpretarse como expiración absoluta (TTL pequeño se descarta).
    expect(parseStreamExpiry("https://s1.vimeos.net/a.m3u8?e=3600").expiresAt).toBeUndefined();
    expect(parseStreamExpiry("https://s1.vimeos.net/a.m3u8?e=1900000000").expiresAt).toBeUndefined();
    // s sin e tampoco produce expiración.
    expect(parseStreamExpiry("https://s1.vimeos.net/a.m3u8?s=1700000000").expiresAt).toBeUndefined();
  });

  it("uses a conservative Vimeos soft TTL and refreshes before expiry", () => {
    const now = 1_800_000_000_000;
    const timing = createResolutionTiming({ originalUrl: "https://vimeos.net/e/a", upstreamUrl: "https://s1.vimeos.net/a.m3u8", provider: "Vimeos", now });
    expect(providerSoftTtlMs("Vimeos", timing.original_url)).toBe(5 * 60 * 1000);
    expect(timing.expires_at).toBe(now + 5 * 60 * 1000);
    expect(timing.refresh_after).toBeLessThan(timing.expires_at);
  });
});

describe("classifySourceKind", () => {
  it("classifies signed media URLs as ephemeral_direct", () => {
    expect(classifySourceKind("https://s1.vimeos.net/master.m3u8?s=1700000000&e=3600")).toBe("ephemeral_direct");
    expect(classifySourceKind("https://cdn.example.com/video.mp4?expires=1900000000")).toBe("ephemeral_direct");
    expect(classifySourceKind("https://edge.acek-cdn.com/master.m3u8?t=opaque-token")).toBe("ephemeral_direct");
  });

  it("classifies clean media URLs as stable_direct", () => {
    expect(classifySourceKind("https://cdn.example.com/video.mp4")).toBe("stable_direct");
    expect(classifySourceKind("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")).toBe("stable_direct");
    expect(classifySourceKind("https://archive.org/download/his_girl_friday/his_girl_friday.mp4")).toBe("stable_direct");
  });

  it("classifies embed URLs as embed", () => {
    expect(classifySourceKind("https://vimeos.net/embed-123.html")).toBe("embed");
    expect(classifySourceKind("https://mega.nz/embed/!abc!xyz")).toBe("embed");
    expect(classifySourceKind("https://streamwish.to/e/123")).toBe("embed");
    expect(classifySourceKind("https://mp4upload.com/embed-456.html")).toBe("embed");
    expect(classifySourceKind("https://www.they.tube/nqd4tq7xml8j.html")).toBe("embed");
  });

  it("classifies website pages as page", () => {
    expect(classifySourceKind("https://www3.animeflv.net/ver/frieren-1")).toBe("page");
    expect(classifySourceKind("https://tioanime.com/ver/frieren-1")).toBe("page");
    expect(classifySourceKind("https://www.cinecalidad.am/pelicula/inception/")).toBe("page");
  });
});


