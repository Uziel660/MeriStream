import { describe, expect, it } from "vitest";
import {
  applyEnrichmentGapFill,
  hasSubstantiveText,
  isPlausibleYear,
  isUsableImage,
  type MergeableMetadataTarget,
} from "../server/metadataMerge";

const VOIDSTREAM_DESC =
  "Contenido indexado en VoidStream con reproductor Just-In-Time.";
const UNSPLASH_POSTER =
  "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&q=80";
const CURRENT_YEAR = new Date().getFullYear();

function makeTarget(overrides: Partial<MergeableMetadataTarget> = {}): MergeableMetadataTarget {
  return {
    malId: null,
    anilistId: null,
    title: "Frieren: Más allá del final del viaje Latino",
    japaneseTitle: null,
    englishTitle: null,
    description: "",
    posterUrl: null,
    bannerUrl: null,
    rating: 0,
    year: 0,
    status: "",
    genresStr: "",
    ...overrides,
  };
}

describe("metadataMerge (scraper-first, defectos #10/#13/#16)", () => {
  it("hasSubstantiveText rechaza placeholders del pipeline", () => {
    expect(hasSubstantiveText(VOIDSTREAM_DESC)).toBe(false);
    expect(hasSubstantiveText("Sin descripción disponible.")).toBe(false);
    expect(hasSubstantiveText("Obra multimedia indexada.")).toBe(false);
    expect(hasSubstantiveText("")).toBe(false);
    expect(hasSubstantiveText("corto")).toBe(false);
    expect(hasSubstantiveText("Segunda temporada de la serie Nige Jouzu")).toBe(true);
  });

  it("isUsableImage rechaza el poster genérico de Unsplash", () => {
    expect(isUsableImage(UNSPLASH_POSTER)).toBe(false);
    expect(isUsableImage("https://tioanime.com/uploads/portadas/4491.jpg")).toBe(true);
    expect(isUsableImage(null)).toBe(false);
  });

  it("isPlausibleYear descarta el año corriente por defecto y valores absurdos", () => {
    expect(isPlausibleYear(2000)).toBe(true);
    expect(isPlausibleYear(1940)).toBe(true);
    expect(isPlausibleYear(CURRENT_YEAR)).toBe(true);
    expect(isPlausibleYear(1899)).toBe(false);
    expect(isPlausibleYear(0)).toBe(false);
    expect(isPlausibleYear(undefined)).toBe(false);
  });

  it("el título correcto del scraper NO es pisado por el match difuso equivocado (caso Frieren→Gundam X)", () => {
    const target = makeTarget();
    applyEnrichmentGapFill(
      { title: target.title, description: "Aventura, Drama, Fantasia" },
      target,
      { title: "Kidou Shinseiki Gundam X", year: 1996, rating: 7.1 }
    );
    expect(target.title).toBe("Frieren: Más allá del final del viaje Latino");
    // Pero los IDs/huecos sí se completan
    expect(target.year).toBe(1996); // el scraper no trajo año
  });

  it("la sinopsis real del scraper gana sobre la del enriquecedor (patrón real: target espeja al input)", () => {
    const scraperDesc = "Segunda temporada de la historia del samurái.";
    const target = makeTarget({ description: scraperDesc });
    applyEnrichmentGapFill(
      { title: "Nige Jouzu no Wakagimi", description: scraperDesc },
      target,
      { description: "Sinopsis de otra obra distinta del matcher." }
    );
    expect(target.description).toBe(scraperDesc);
  });

  it("el enriquecedor reemplaza una sinopsis placeholder que vino DEL PROPIO scraper (fallback GenericAdapter)", () => {
    const target = makeTarget({ description: VOIDSTREAM_DESC });
    applyEnrichmentGapFill(
      { title: "10 cosas que odio de ti", description: VOIDSTREAM_DESC },
      target,
      { description: "Comedia adolescente de 1999 dirigida por Gil Junger." }
    );
    expect(target.description).toBe("Comedia adolescente de 1999 dirigida por Gil Junger.");
  });

  it("el enriquecedor completa la sinopsis cuando el scraper no trajo una sustantiva", () => {
    const target = makeTarget();
    applyEnrichmentGapFill(
      { title: "10 cosas que odio de ti", description: "" },
      target,
      { description: "Comedia adolescente de 1999 dirigida por Gil Junger." }
    );
    expect(target.description).toBe("Comedia adolescente de 1999 dirigida por Gil Junger.");
  });

  it("el poster placeholder de Unsplash nunca pisa el poster real del scraper", () => {
    const realPoster = "https://tioanime.com/uploads/portadas/4491.jpg";
    const target = makeTarget({ posterUrl: realPoster });
    applyEnrichmentGapFill(
      { title: "X", poster_url: realPoster },
      target,
      { poster_url: UNSPLASH_POSTER, banner_url: UNSPLASH_POSTER }
    );
    expect(target.posterUrl).toBe(realPoster);
    expect(target.bannerUrl).not.toBe(UNSPLASH_POSTER);
  });

  it("el poster del scraper vacío se llena desde el enriquecedor", () => {
    const target = makeTarget();
    applyEnrichmentGapFill(
      { title: "His Girl Friday" },
      target,
      { poster_url: "https://archive.org/services/img/his_girl_friday" }
    );
    expect(target.posterUrl).toBe("https://archive.org/services/img/his_girl_friday");
  });

  it("year hardcodeado del adaptador no sobrevive si el enriquecedor trae el real (#16/#24)", () => {
    const target = makeTarget();
    applyEnrichmentGapFill({ title: "Los ríos de color púrpura" }, target, { year: 2000 });
    expect(target.year).toBe(2000);
  });

  it("el año real de la ficha manda aunque el enriquecedor traiga otro", () => {
    const target = makeTarget({ year: 1940 });
    applyEnrichmentGapFill({ title: "X", year: 1940 }, target, { year: 1968 });
    expect(target.year).toBe(1940);
  });

  it("rating y géneros del scraper ganan; los del enriquecedor llenan huecos", () => {
    // En producción showData ya espeja input.genres antes del merge
    const target = makeTarget({ rating: 9.2, genresStr: "Drama, Crime" });
    applyEnrichmentGapFill(
      { title: "Breaking Bad", rating: 9.2, genres: ["Drama", "Crime"] },
      target,
      { rating: 5.5, genres: ["Anime"], status: "Finalizado" }
    );
    expect(target.rating).toBe(9.2);
    expect(target.genresStr).toBe("Drama, Crime");

    const empty = makeTarget();
    applyEnrichmentGapFill({ title: "Y" }, empty, {
      rating: 8.4,
      genres: ["Acción"],
      status: "En emisión",
    });
    expect(empty.rating).toBe(8.4);
    expect(empty.genresStr).toBe("Acción");
    expect(empty.status).toBe("En emisión");
  });

  it("enriched nulo o vacío no rompe ni muta nada", () => {
    const target = makeTarget({ title: "Original" });
    applyEnrichmentGapFill({ title: "Original" }, target, null);
    applyEnrichmentGapFill({ title: "Original" }, target, {});
    expect(target.title).toBe("Original");
  });
});
