import { describe, expect, it, vi, afterEach } from "vitest";
import {
  canonicalCinecalidadUrl,
  canonicalCinecalidadEpisodeUrl,
  clearCinecalidadApiCache,
  lookupCinecalidadItem,
  lookupCinecalidadEpisode,
  parseCinecalidadLocator,
  slugifyCinecalidadTitle,
} from "./cinecalidadApi";

describe("Cinecalidad current API identity", () => {
  afterEach(() => {
    clearCinecalidadApiCache();
    vi.restoreAllMocks();
  });

  it("matches the SPA slug algorithm, including accents and punctuation", () => {
    expect(slugifyCinecalidadTitle("Capitán América: El Primer Vengador")).toBe("capitan-america-el-primer-vengador");
    expect(slugifyCinecalidadTitle("Spider-Man 3 — El Desafío")).toBe("spider-man-3-el-desafio");
  });

  it("accepts only id-bearing current routes", () => {
    expect(parseCinecalidadLocator("https://www.cinecalidad.am/pelicula/1771/capitan-america-el-primer-vengador")).toEqual({
      kind: "movie",
      tmdbId: 1771,
      slug: "capitan-america-el-primer-vengador",
    });
    expect(parseCinecalidadLocator("https://www.cinecalidad.am/serie/1399/temporada/1/episodio/2")).toEqual({
      kind: "series",
      tmdbId: 1399,
      season: 1,
      episode: 2,
    });
    expect(parseCinecalidadLocator("https://www.cinecalidad.am/ver-pelicula/elvis-online-gratis-en-cinecalidad/")).toBeNull();
    expect(parseCinecalidadLocator("https://evil-cinecalidad.am/pelicula/1771/test")).toBeNull();
  });

  it("builds the canonical route from the API item, never from a local alias", () => {
    expect(canonicalCinecalidadUrl({
      tmdb_id: 1771,
      kind: "movie",
      title: "Capitán América: El Primer Vengador",
    })).toBe("https://www.cinecalidad.am/pelicula/1771/capitan-america-el-primer-vengador");
    expect(canonicalCinecalidadUrl({
      tmdb_id: 123,
      kind: "tvshow",
      title: "Mi Serie",
    })).toBe("https://www.cinecalidad.am/serie/123/mi-serie");
    expect(canonicalCinecalidadEpisodeUrl({ tmdb_id: 1399, kind: "tvshow", title: "Game of Thrones" }, 1, 2))
      .toBe("https://www.cinecalidad.am/serie/1399/temporada/1/episodio/2");
  });

  it("distinguishes an API 404 from a transient failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    await expect(lookupCinecalidadItem("movie", 614934)).resolves.toEqual({ item: null, failed: false });

    clearCinecalidadApiCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    await expect(lookupCinecalidadItem("movie", 614934)).resolves.toEqual({ item: null, failed: true });
  });

  it("reads episode codes from the current episode endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ episode: { title: "El Camino Real", code: "uvlzuhdzlu31" } }),
    }));
    await expect(lookupCinecalidadEpisode("series", 1399, 1, 2)).resolves.toEqual({
      failed: false,
      item: expect.objectContaining({ title: "El Camino Real", code: "uvlzuhdzlu31", tmdb_id: 1399 }),
    });
  });
});

