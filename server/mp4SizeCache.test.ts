// Tests unitarios de la cache anti-416 del proxy (bug #1, MP4Upload).
// El token de MP4Upload rota entre peticiones y el upstream devuelve un
// content-length distinto: la cache debe detectar el mismatch por host+path
// (ignorando la query) para que el proxy responda 416 limpia.

import { describe, it, expect, beforeEach } from "vitest";
import {
  mp4SizeCacheKey,
  getMp4SizeCacheEntry,
  setMp4SizeCacheEntry,
  pruneMp4SizeCache,
  clearMp4SizeCacheForTests,
} from "./mp4SizeCache";

const BASE = "https://www.mp4upload.com/embed-abc123.html";

describe("mp4SizeCacheKey", () => {
  it("normaliza host+path y descarta querystring (tokens rotativos)", () => {
    expect(mp4SizeCacheKey("https://www.mp4upload.com/getvid?token=aaa111")).toBe(
      "www.mp4upload.com/getvid"
    );
    expect(mp4SizeCacheKey("https://WWW.MP4UPLOAD.COM/GETVID?token=bbb222")).toBe(
      "www.mp4upload.com/GETVID"
    );
    expect(mp4SizeCacheKey("https://cdn.example.com/video.mp4/")).toBe(
      "cdn.example.com/video.mp4"
    );
    // Distinta query sobre el mismo path → MISMA clave (así se detecta el rotate).
    expect(mp4SizeCacheKey("https://x.com/v?t=1")).toBe(mp4SizeCacheKey("https://x.com/v?t=2"));
    // Paths distintos → claves distintas.
    expect(mp4SizeCacheKey("https://x.com/a")).not.toBe(mp4SizeCacheKey("https://x.com/b"));
  });

  it("devuelve la URL cruda si no parsea", () => {
    expect(mp4SizeCacheKey("no-es-url")).toBe("no-es-url");
  });
});

describe("get/set/prune de la cache", () => {
  beforeEach(() => {
    clearMp4SizeCacheForTests();
  });

  it("roundtrip: guarda y recupera tamaño + finalUrl por URL base", () => {
    setMp4SizeCacheEntry(BASE, { size: 575274912, finalUrl: "https://dn800306.us.archive.org/f.mp4" }, 1000);
    const entry = getMp4SizeCacheEntry(`${BASE}?token=rotado`);
    expect(entry?.size).toBe(575274912);
    expect(entry?.loadedAt).toBe(1000);
    expect(entry?.finalUrl).toBe("https://dn800306.us.archive.org/f.mp4");
  });

  it("mismatch de tamaños (token rotado): la entrada previa sigue legible para decidir 416", () => {
    setMp4SizeCacheEntry(BASE, { size: 100000, finalUrl: "https://old.example/f" }, 1000);
    // El HEAD nuevo anuncia otro tamaño; getMp4SizeCacheEntry devuelve el viejo
    // y el proxy compara sizes → 416.
    const entry = getMp4SizeCacheEntry(BASE);
    expect(entry?.size).toBe(100000);
    expect(entry?.size).not.toBe(200000);
  });

  it("prune elimina solo entradas vencidas (TTL) y reporta cuántas purgó", () => {
    setMp4SizeCacheEntry(BASE, { size: 1, finalUrl: "u1" }, 1000);
    setMp4SizeCacheEntry("https://other.example/v.mp4", { size: 2, finalUrl: "u2" }, 29 * 60 * 1000);
    // TTL = 30 min: a los 31 min la primera expiró, la segunda (a los ~2 min) no.
    expect(pruneMp4SizeCache(31 * 60 * 1000)).toBe(1);
    expect(getMp4SizeCacheEntry(BASE)).toBeUndefined();
    expect(getMp4SizeCacheEntry("https://other.example/v.mp4")?.size).toBe(2);
  });
});
