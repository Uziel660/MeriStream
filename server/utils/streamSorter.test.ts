// Tests unitarios del enrutador de calidad de streams (telemetría QA).
// Jerarquía usuario 2026-08-23: TIER 1 ugc-cdn-caching/goodstream/acek-cdn/uqload
// (+ vimeos.net heredado), TIER 2 genéricos AnimeFLV + doodstream,
// TIER 3 vidhide, TIER 4 mega.nz/mp4upload. Blacklist: voe/mixdrop/filemoon.

import { describe, it, expect } from "vitest";
import {
  sortStreamsByPriority,
  getStreamTier,
  isBlacklistedHost,
  BLACKLISTED_HOST_TOKENS,
} from "./streamSorter";

const stream = (host: string) => ({
  url: host.includes("mega.nz") ? `https://mega.nz/file/AbC123#KEY` : `https://${host}/video.m3u8`,
  type: "direct",
});

describe("getStreamTier", () => {
  it("asigna TIER 1 a todos sus hosts (incluido vimeos.net heredado)", () => {
    for (const h of ["ugc-cdn-caching", "vimeos.net", "goodstream", "acek-cdn", "uqload"]) {
      expect(getStreamTier(stream(h).url)).toBe(1);
    }
  });

  it("asigna TIER 2 a doodstream y genéricos AnimeFLV", () => {
    expect(getStreamTier("https://doodstream.com/e/xyz")).toBe(2);
    expect(getStreamTier("https://ducvomes.com/hls/abc.m3u8")).toBe(2);
    expect(getStreamTier("https://playmudos.com/hls/abc.m3u8")).toBe(2);
  });

  it("asigna TIER 3 a vidhide", () => {
    expect(getStreamTier("https://vidhide.com/embed-abc.html")).toBe(3);
    expect(getStreamTier("https://vidhidepro.com/v/abc")).toBe(3);
  });

  it("asigna TIER 4 a mega.nz y mp4upload", () => {
    expect(getStreamTier("https://mega.nz/file/AbC#KEY")).toBe(4);
    expect(getStreamTier("https://mega.nz/embed/AbC")).toBe(4);
    expect(getStreamTier("https://mega.io/file/XyZ#K")).toBe(4);
    expect(getStreamTier("https://www.mp4upload.com/embed-abc.html")).toBe(4);
  });

  it("hosts desconocidos caen entre TIER 3 y TIER 4", () => {
    const t = getStreamTier("https://desconocido-cdn.org/v.m3u8");
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(4);
    expect(getStreamTier("")).toBeGreaterThan(3);
    expect(getStreamTier(undefined as any)).toBeGreaterThan(3);
  });

  it("es case-insensitive sobre el string de la URL", () => {
    expect(getStreamTier("HTTPS://WWW.MP4UPLOAD.COM/EMBED-ABC.HTML")).toBe(4);
    expect(getStreamTier("https://MEGA.NZ/FILE/AB#key")).toBe(4);
  });
});

describe("isBlacklistedHost", () => {
  it("marca voe/mixdrop/filemoon en todas sus variantes", () => {
    for (const u of [
      "https://voe.sx/e/abc",
      "https://byselapuix.com/voe-embed",
      "https://mixdrop.co/e/abc",
      "https://filemoon.sx/e/abc",
    ]) {
      expect(isBlacklistedHost(u)).toBe(true);
    }
  });

  it("no marca hosts válidos ni strings vacíos", () => {
    expect(isBlacklistedHost("https://goodstream.to/v.m3u8")).toBe(false);
    expect(isBlacklistedHost("")).toBe(false);
    expect(isBlacklistedHost(undefined as any)).toBe(false);
  });

  it("exporta exactamente los cuatro tokens acordados (mxdrop = variante mixdrop)", () => {
    expect([...BLACKLISTED_HOST_TOKENS]).toEqual(["voe", "mixdrop", "mxdrop", "filemoon"]);
  });
});

describe("sortStreamsByPriority", () => {
  it("ordena según la jerarquía estricta de tiers", () => {
    const input = [
      stream("mega.nz"),
      stream("mp4upload.com"),
      stream("goodstream.to"),
      stream("doodstream.com"),
      stream("vimeos.net"),
    ];
    const out = sortStreamsByPriority(input);
    expect(out.map((s) => getStreamTier(s.url))).toEqual([1, 1, 2, 4, 4]);
  });

  it("filtra hosts en lista negra antes de ordenar", () => {
    const input = [
      stream("voe.sx"),
      stream("goodstream.to"),
      stream("mixdrop.co"),
      stream("filemoon.sx"),
      stream("mega.nz"),
    ];
    const out = sortStreamsByPriority(input);
    expect(out.map((s) => s.url)).toEqual([stream("goodstream.to").url, stream("mega.nz").url]);
  });

  it("devuelve array vacío si toda la entrada está en lista negra", () => {
    expect(sortStreamsByPriority([stream("voe.sx"), stream("mixdrop.co")])).toEqual([]);
  });

  it("no muta el array de entrada (función pura)", () => {
    const input = [stream("mega.nz"), stream("uqload.co")];
    const copy = [...input];
    const out = sortStreamsByPriority(input);
    expect(input).toEqual(copy);
    expect(out).not.toBe(input);
    expect(out[0].url).toContain("uqload");
  });

  it("coloca hosts desconocidos antes que tier 4 pero después de auditados", () => {
    const input = [
      stream("mega.nz"),
      stream("host-raro.net"),
      stream("acek-cdn.com"),
      stream("mp4upload.com"),
    ];
    const urls = sortStreamsByPriority(input).map((s) => s.url);
    expect(urls.indexOf(urls.find((u) => u.includes("acek-cdn"))!)).toBeLessThan(
      urls.indexOf(urls.find((u) => u.includes("host-raro"))!)
    );
    expect(urls.indexOf(urls.find((u) => u.includes("host-raro"))!)).toBeLessThan(
      urls.indexOf(urls.find((u) => u.includes("mega.nz"))!)
    );
  });

  it("conserva orden relativo dentro del mismo tier (sort estable)", () => {
    const input = [
      { url: "https://a.vimeos.net/1.m3u8", type: "direct" },
      { url: "https://b.goodstream.to/2.m3u8", type: "direct" },
      { url: "https://c.vimeos.net/3.m3u8", type: "direct" },
    ];
    expect(sortStreamsByPriority(input).map((s) => s.url)).toEqual([
      "https://a.vimeos.net/1.m3u8",
      "https://b.goodstream.to/2.m3u8",
      "https://c.vimeos.net/3.m3u8",
    ]);
  });

  it("devuelve array vacío sin error para entrada vacía", () => {
    expect(sortStreamsByPriority([])).toEqual([]);
  });
});
