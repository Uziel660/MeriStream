import { describe, it, expect } from "vitest";
import { formatAndNormalizeGenres } from "./utils/genreNormalizer";
import { isSlugLikeTitle, cleanSlugToWords, parseRawTitle, normalizeTitleKey } from "./utils/titleNormalizer";
import { applyEnrichmentGapFill } from "./metadataMerge";
import { showNeedsBackfill } from "./metadataBackfill";

describe("Genre Normalization (genreNormalizer)", () => {
  it("normalizes single-space-separated lowercase genres into comma-separated properly accented genres", () => {
    expect(formatAndNormalizeGenres("accion aventura", null)).toBe("Acción, Aventura");
    expect(formatAndNormalizeGenres("drama romance fantasia", null)).toBe("Drama, Romance, Fantasía");
    expect(formatAndNormalizeGenres("terror misterio", null)).toBe("Terror, Misterio");
    expect(formatAndNormalizeGenres("ciencia ficcion", null)).toBe("Ciencia Ficción");
    expect(formatAndNormalizeGenres("comedia familiar", null)).toBe("Comedia, Familia");
    expect(formatAndNormalizeGenres("suspenso belica", null)).toBe("Suspenso, Bélica");
  });

  it("normalizes already comma-separated strings with proper accents and capitalization", () => {
    expect(formatAndNormalizeGenres("Accion, Aventura, Fantasia", null)).toBe("Acción, Aventura, Fantasía");
    expect(formatAndNormalizeGenres("drama / romance / animacion", null)).toBe("Drama, Romance, Animación");
  });

  it("normalizes array of genre strings cleanly", () => {
    expect(formatAndNormalizeGenres(["ciencia ficcion", "terror", "accion"], null)).toBe("Ciencia Ficción, Terror, Acción");
  });

  it("uses enriched TMDB genres when raw genre is missing, Multimedia, or unformatted", () => {
    expect(formatAndNormalizeGenres("Multimedia", ["Acción", "Aventura", "Drama"])).toBe("Acción, Aventura, Drama");
    expect(formatAndNormalizeGenres("", ["Ciencia Ficción", "Suspense"])).toBe("Ciencia Ficción, Suspenso");
    expect(formatAndNormalizeGenres("accion aventura", ["Acción", "Aventura", "Drama"])).toBe("Acción, Aventura, Drama");
  });

  it("filters out junk genre tokens", () => {
    expect(formatAndNormalizeGenres("pelicula hd latino accion", null)).toBe("Acción");
  });
});

describe("Title Slug Detection & Normalization (titleNormalizer)", () => {
  it("detects joined lowercase slug-like titles without spaces", () => {
    expect(isSlugLikeTitle("sixjoursceprintempsla")).toBe(true);
    expect(isSlugLikeTitle("thegodfatherpartii")).toBe(true);
  });

  it("detects hyphenated or underscored slugs", () => {
    expect(isSlugLikeTitle("six-jours-ce-printemps-la")).toBe(true);
    expect(isSlugLikeTitle("movie_title_2024")).toBe(true);
    expect(isSlugLikeTitle("ver-pelicula-completa-2024")).toBe(true);
  });

  it("does not flag clean formatted human titles", () => {
    expect(isSlugLikeTitle("Six jours ce printemps-là")).toBe(false);
    expect(isSlugLikeTitle("Toy Story 5")).toBe(false);
    expect(isSlugLikeTitle("El Padrino")).toBe(false);
    expect(isSlugLikeTitle("Up")).toBe(false);
  });

  it("converts hyphenated slugs to capitalized words", () => {
    expect(cleanSlugToWords("six-jours-ce-printemps-la")).toBe("Six Jours Ce Printemps La");
    expect(cleanSlugToWords("el_padrino_parte_dos")).toBe("El Padrino Parte Dos");
  });

  it("segments joined lowercase slugs into spaced capitalized words", () => {
    expect(cleanSlugToWords("temporadaparamatar")).toBe("Temporada Para Matar");
    expect(cleanSlugToWords("lostestamentosdelashijasdegilead")).toBe("Los Testamentos De Las Hijas De Gilead");
    expect(cleanSlugToWords("sixjoursceprintempsla")).toBe("Six Jours Ce Printemps La");
    expect(cleanSlugToWords("elultimotestigo")).toBe("El Ultimo Testigo");
    expect(cleanSlugToWords("templedeacero")).toBe("Temple De Acero");
    expect(cleanSlugToWords("eltestigo")).toBe("El Testigo");
  });

  it("decodes HTML entities emitted by legacy anime scrapers before matching", () => {
    expect(normalizeTitleKey("Knight&#039;s &amp; Magic")).toBe("knightsmagic");
    expect(normalizeTitleKey("Ch&amp;auml;oS;Child")).toBe("chaoschild");
    expect(normalizeTitleKey("Pokemon Pel&amp;iacute;cula 19")).toBe("pokemon19");
    expect(normalizeTitleKey("xxxHOLiC&amp;middot;Rou")).toBe("xxxholicrou");
    expect(normalizeTitleKey("Wei&amp;szlig; Survive")).toBe("weißsurvive");
  });
});

describe("Metadata Gap Fill (metadataMerge)", () => {
  it("replaces slug-like target.title with clean enriched title from TMDB", () => {
    const input = { title: "sixjoursceprintempsla", genres: "accion aventura" };
    const target = {
      malId: null,
      anilistId: null,
      title: "sixjoursceprintempsla",
      japaneseTitle: null,
      englishTitle: null,
      description: "",
      posterUrl: null,
      bannerUrl: null,
      rating: 0,
      year: 0,
      status: "Finalizado",
      genresStr: "accion aventura",
    };
    const enriched = {
      title: "Six jours ce printemps-là",
      description: "Sinopsis oficial de TMDB.",
      poster_url: "https://image.tmdb.org/t/p/w780/poster.jpg",
      year: 2024,
      genres: ["Drama", "Romance"],
    };

    applyEnrichmentGapFill(input, target, enriched);

    expect(target.title).toBe("Six jours ce printemps-là");
    expect(target.genresStr).toBe("Drama, Romance");
    expect(target.description).toBe("Sinopsis oficial de TMDB.");
  });
});

describe("Backfill Qualification (showNeedsBackfill)", () => {
  it("flags shows with slug-like titles for repair", () => {
    expect(
      showNeedsBackfill({
        title: "sixjoursceprintempsla",
        description: "Una descripción completa y detallada.",
        poster_url: "https://image.tmdb.org/t/p/w780/poster.jpg",
        banner_url: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
        genres: "Acción, Aventura",
        year: 2024,
      })
    ).toBe(true);
  });

  it("flags shows with unformatted or uncomma-separated genres for repair", () => {
    expect(
      showNeedsBackfill({
        title: "Six Jours Ce Printemps La",
        description: "Una descripción completa y detallada.",
        poster_url: "https://image.tmdb.org/t/p/w780/poster.jpg",
        banner_url: "https://image.tmdb.org/t/p/w1280/backdrop.jpg",
        genres: "accion aventura",
        year: 2024,
      })
    ).toBe(true);
  });
});
