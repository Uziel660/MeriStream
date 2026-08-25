import { describe, expect, it } from "vitest";
import { extractYearFromText } from "../../server/scrapers/adapters/ArchiveOrgAdapter";
import { toGlobalEpisodeNumber } from "../../server/scrapers/adapters/TvMazeAdapter";
import { LaMovieAdapter } from "../../server/scrapers/adapters/LaMovieAdapter";

describe("ArchiveOrgAdapter.extractYearFromText (#24)", () => {
  it("extrae el primer año plausible de la descripción", () => {
    expect(
      extractYearFromText("Hilarious romantic comedy starring Cary Grant, released in 1940.")
    ).toBe(1940);
    expect(extractYearFromText("Estrenada en 2000, remake en 2021")).toBe(2000);
  });

  it("devuelve null cuando no hay año o es absurdo", () => {
    expect(extractYearFromText(null)).toBeNull();
    expect(extractYearFromText("sin fechas aquí")).toBeNull();
    expect(extractYearFromText("año 85 y 9999")).toBeNull();
  });

  it("soporta descripciones tipo array de Archive.org", () => {
    expect(extractYearFromText(["Parte 1 (1968)", "Parte 2"])).toBe(1968);
  });
});

describe("TvMazeAdapter.toGlobalEpisodeNumber (#18)", () => {
  it("numera globalmente season*100+n sin colisiones intra-temporada", () => {
    // T1E1..T5E1 ya no colisionan todos en 1
    expect(toGlobalEpisodeNumber(1, 1)).toBe(101);
    expect(toGlobalEpisodeNumber(2, 1)).toBe(201);
    expect(toGlobalEpisodeNumber(5, 1)).toBe(501);
    expect(toGlobalEpisodeNumber(2, 13)).toBe(213);
  });

  it("conserva el orden temporal al ordenar por número global", () => {
    const eps = [
      { season: 2, number: 3 },
      { season: 1, number: 10 },
      { season: 1, number: 1 },
      { season: 2, number: 1 },
    ].map((e) => toGlobalEpisodeNumber(e.season, e.number));
    expect([...eps].sort((a, b) => a - b)).toEqual([101, 110, 201, 203]);
  });
});

describe("LaMovieAdapter.isPlayableSourceUrl (#5)", () => {
  it("acepta media directa y embeds conocidos", () => {
    expect(LaMovieAdapter.isPlayableSourceUrl("https://enc12.goodstream.one/hls2/x/master.m3u8")).toBe(true);
    expect(LaMovieAdapter.isPlayableSourceUrl("https://cdn.example.com/video.mp4?token=abc")).toBe(true);
    expect(LaMovieAdapter.isPlayableSourceUrl("https://mega.nz/embed/!pTMFXTxT!k")).toBe(true);
    expect(LaMovieAdapter.isPlayableSourceUrl("https://voe.sx/e/6x0dhtkkvgpi")).toBe(true);
  });

  it("rechaza basura de descargas (.rar/.zip) y magnet links (#5)", () => {
    expect(LaMovieAdapter.isPlayableSourceUrl("https://www.mediafire.com/file/10CCCCCC.rar")).toBe(false);
    expect(LaMovieAdapter.isPlayableSourceUrl("https://mirror.example.com/pelicula.zip")).toBe(false);
    expect(LaMovieAdapter.isPlayableSourceUrl("magnet:?xt=urn:btih:abc")).toBe(false);
    expect(LaMovieAdapter.isPlayableSourceUrl("https://subtitulos.example.com/esp.srt")).toBe(false);
  });

  it("rechaza URLs vacías o no http", () => {
    expect(LaMovieAdapter.isPlayableSourceUrl("")).toBe(false);
    expect(LaMovieAdapter.isPlayableSourceUrl("javascript:void(0)")).toBe(false);
  });
});
