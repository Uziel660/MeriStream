import { describe, expect, it } from "vitest";
import {
  isCanonicalLocator,
  isCatalogNavigationUrl,
  isExcludedRecoverySite,
  isExpiredDirectUrl,
  siteFromUrl,
} from "./sourceRecoveryWorker";

const NOW = 1_800_000_000_000;

describe("source recovery URL classification", () => {
  it("detects expired direct URLs with explicit expiry", () => {
    expect(isExpiredDirectUrl("https://cdn.example/video.m3u8?expires=1700000000", NOW)).toBe(true);
    expect(isExpiredDirectUrl("https://cdn.example/video.m3u8?expires=1900000000", NOW)).toBe(false);
    expect(isExpiredDirectUrl("https://cdn.example/video.m3u8", NOW)).toBe(false);
  });

  it("treats opaque CDN signatures as ephemeral, including the historical ?t= manifests", () => {
    expect(isExpiredDirectUrl("https://edge.acek-cdn.com/hls/master.m3u8?t=opaque-token", NOW)).toBe(true);
    expect(isExpiredDirectUrl("https://edge.example/hls/master.m3u8?hash=opaque-hash", NOW)).toBe(true);
    expect(isExpiredDirectUrl("https://edge.example/hls/master.m3u8?policy=opaque-policy", NOW)).toBe(true);
  });

  it("recognizes Vimeos s+e expiry and does not mistake an e-only TTL for an epoch", () => {
    expect(isExpiredDirectUrl("https://s1.vimeos.net/master.m3u8?s=1700000000&e=3600", NOW)).toBe(true);
    expect(isExpiredDirectUrl("https://s1.vimeos.net/master.m3u8?s=1900000000&e=3600", NOW)).toBe(false);
    expect(isExpiredDirectUrl("https://s1.vimeos.net/master.m3u8?e=3600", NOW)).toBe(true);
  });
});

describe("source recovery canonical locators", () => {
  it("rejects catalogue navigation and direct media URLs", () => {
    expect(isCatalogNavigationUrl("https://cinecalidad.am/page/1/")).toBe(true);
    expect(isCatalogNavigationUrl("https://tioplus.app/peliculas?page=2")).toBe(true);
    expect(isCanonicalLocator("https://cdn.example/master.m3u8?t=expired")).toBe(false);
    expect(isCanonicalLocator("https://lamovie.org/")).toBe(false);
  });

  it("accepts provider detail pages and real embeds", () => {
    expect(isCanonicalLocator("https://www.cinecalidad.am/ver-pelicula/la-captura/")).toBe(true);
    expect(isCanonicalLocator("https://lamovie.org/peliculas/dientes-de-leche-2024/")).toBe(true);
    expect(isCanonicalLocator("https://s1.vimeos.net/embed-123.html")).toBe(true);
    expect(isCanonicalLocator("https://mega.nz/embed/!abc!xyz")).toBe(true);
  });

  it("excludes only TubePelis while retaining TioPlus", () => {
    expect(isExcludedRecoverySite("TubePelis")).toBe(true);
    expect(isExcludedRecoverySite("https://www.tubepelis.com/peliculas/foo")).toBe(true);
    expect(isExcludedRecoverySite("tioplus.app")).toBe(false);
    expect(isExcludedRecoverySite("https://tioplus.app/peliculas/foo")).toBe(false);
  });

  it("normalizes provider hostnames for matching", () => {
    expect(siteFromUrl("https://WWW.TioPlus.app/peliculas/foo")).toBe("tioplus.app");
    expect(siteFromUrl("not a URL")).toBe("unknown");
  });
});
