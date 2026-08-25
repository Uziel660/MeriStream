import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSearchCandidates,
  cleanQueryTitle,
  enrichUniversalMetadata,
  isSubstantiveDescription,
  parseTitleQuery,
  translateGenresToEs,
  __resetEngineCaches,
} from "./metadataEngine";

describe("cleanQueryTitle", () => {
  it("should return the title unchanged if no tags are present", () => {
    expect(cleanQueryTitle("Naruto")).toBe("Naruto");
    expect(cleanQueryTitle("Breaking Bad")).toBe("Breaking Bad");
    expect(cleanQueryTitle("The Lord of the Rings")).toBe("The Lord of the Rings");
  });

  it("should strip prefixes", () => {
    expect(cleanQueryTitle("Ver Naruto")).toBe("Naruto");
    expect(cleanQueryTitle("Ver Online Breaking Bad")).toBe("Breaking Bad");
    expect(cleanQueryTitle("Pelicula Inception")).toBe("Inception");
    expect(cleanQueryTitle("Película The Matrix")).toBe("The Matrix");
    expect(cleanQueryTitle("Serie Friends")).toBe("Friends");
    expect(cleanQueryTitle("Anime One Piece")).toBe("One Piece");
    expect(cleanQueryTitle("Ova Hellsing")).toBe("Hellsing");
    expect(cleanQueryTitle("Donghua Soul Land")).toBe("Soul Land");
    expect(cleanQueryTitle("Watch Spider-Man")).toBe("Spider-Man");
    expect(cleanQueryTitle("Full Movie Avengers")).toBe("Avengers");
    // Case insensitivity
    expect(cleanQueryTitle("vEr onLine bleach")).toBe("bleach");
  });

  it("should strip suffixes and everything after them", () => {
    expect(cleanQueryTitle("Naruto Sub Español")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach Audio Latino")).toBe("Bleach");
    expect(cleanQueryTitle("Dragon Ball Latino")).toBe("Dragon Ball");
    expect(cleanQueryTitle("Simpsons Castellano")).toBe("Simpsons");
    expect(cleanQueryTitle("Inception Dual")).toBe("Inception");
    expect(cleanQueryTitle("Avatar 1080p Bluray")).toBe("Avatar");
    expect(cleanQueryTitle("Interstellar 720p RIP")).toBe("Interstellar");
    expect(cleanQueryTitle("Joker 4K UHD")).toBe("Joker");
    expect(cleanQueryTitle("Batman HD")).toBe("Batman");
    expect(cleanQueryTitle("Superman Full HD")).toBe("Superman");
    expect(cleanQueryTitle("Movie Online Free")).toBe("Movie");
    expect(cleanQueryTitle("Show Gratis")).toBe("Show");
    expect(cleanQueryTitle("Show Free Download")).toBe("Show");
    expect(cleanQueryTitle("Show Episodio 12")).toBe("Show");
    expect(cleanQueryTitle("Show Capitulo 10")).toBe("Show");
    expect(cleanQueryTitle("Show Cap 5")).toBe("Show");
    expect(cleanQueryTitle("Show S01E02")).toBe("Show");
    // Case insensitivity
    expect(cleanQueryTitle("Naruto sUB esPañol")).toBe("Naruto");
  });

  it("should strip (TV) anywhere", () => {
    expect(cleanQueryTitle("Title (TV)")).toBe("Title");
    // Con los formatos de temporada extendidos, "Part 2" es un marcador de
    // temporada: se extrae como season=2 y el título base queda sin él.
    expect(cleanQueryTitle("Title (TV) Part 2")).toBe("Title");
    const parsed = parseTitleQuery("Title (TV) Part 2");
    expect(parsed.baseTitle).toBe("Title");
    expect(parsed.season).toBe(2);
  });

  it("should strip text inside brackets, parentheses, and braces", () => {
    expect(cleanQueryTitle("Naruto (2002)")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach [HD]")).toBe("Bleach");
    expect(cleanQueryTitle("One Piece {Sub}")).toBe("One Piece");
    expect(cleanQueryTitle("Attack on Titan (Final Season) [1080p] {x264}")).toBe("Attack on Titan");
    expect(cleanQueryTitle("K-On! (Movie)")).toBe("K-On!");
  });

  it("should split at hyphens, em-dashes, and pipes, keeping the first part", () => {
    expect(cleanQueryTitle("Naruto - Episode 1")).toBe("Naruto");
    expect(cleanQueryTitle("Bleach | Season 2")).toBe("Bleach");
    expect(cleanQueryTitle("One Piece — Wano Arc")).toBe("One Piece");
    // Only with spaces around them
    expect(cleanQueryTitle("Spider-Man")).toBe("Spider-Man");
    expect(cleanQueryTitle("Spider-Man - No Way Home")).toBe("Spider-Man");
  });

  it("should handle a combination of tags, prefixes, and suffixes", () => {
    expect(cleanQueryTitle("Ver Online Attack on Titan (Final Season) - Episodio 12 1080p [Sub Español]")).toBe("Attack on Titan");
    expect(cleanQueryTitle("Anime My Hero Academia | Cap 5 (TV) Audio Latino")).toBe("My Hero Academia");
    expect(cleanQueryTitle("Película Spider-Man: Into the Spider-Verse — Full HD Dual")).toBe("Spider-Man: Into the Spider-Verse");
  });
});

describe("parseTitleQuery", () => {
  it("should extract season from 'TP' notation (kaguya style)", () => {
    expect(parseTitleQuery("Kaguya-sama TP2 en español latino")).toEqual({
      baseTitle: "Kaguya-sama",
      season: 2,
      year: null,
    });
  });

  it("should extract season from 'Temporada N'", () => {
    const parsed = parseTitleQuery("Shingeki no Kyojin Temporada 3");
    expect(parsed.season).toBe(3);
    expect(parsed.baseTitle).toBe("Shingeki no Kyojin");
    expect(parsed.year).toBeNull();
  });

  it("should extract year from trailing 4-digit year", () => {
    const parsed = parseTitleQuery("Coco 2017 en español latino");
    expect(parsed.year).toBe(2017);
    expect(parsed.season).toBeNull();
    expect(parsed.baseTitle).toBe("Coco");
  });

  it("should clean prefixes and quality noise while keeping digits in titles", () => {
    const parsed = parseTitleQuery("Ver Online Pelicula Rápidos y Furiosos 9 HD 1080p");
    expect(parsed.baseTitle).toBe("Rápidos y Furiosos 9");
    // El 9 de "Furiosos 9" NO es año: la regex solo acepta 19xx/20xx.
    expect(parsed.year).toBeNull();
    expect(parsed.season).toBeNull();
  });

  it("should not capture the initial T of a title as season", () => {
    const parsed = parseTitleQuery("Titanic");
    expect(parsed).toEqual({ baseTitle: "Titanic", season: null, year: null });
  });

  it("should extract year even when it is part of the commercial name (documented behavior)", () => {
    // Comportamiento documentado: un año explícito SIEMPRE se extrae,
    // aunque forme parte del nombre comercial.
    expect(parseTitleQuery("Blade Runner 2049")).toEqual({
      baseTitle: "Blade Runner",
      season: null,
      year: 2049,
    });
  });

  it("should prefer the first season marker found", () => {
    const parsed = parseTitleQuery("One Piece T2 Sub Español");
    expect(parsed.season).toBe(2);
    expect(parsed.baseTitle).toBe("One Piece");
  });

  it("should return nulls for plain titles", () => {
    expect(parseTitleQuery("Breaking Bad")).toEqual({
      baseTitle: "Breaking Bad",
      season: null,
      year: null,
    });
  });

  it("should fall back to basic input when everything is noise", () => {
    const parsed = parseTitleQuery("1080p");
    expect(parsed.baseTitle.length).toBeGreaterThan(0);
  });

  it("cleanQueryTitle should stay consistent with parseTitleQuery().baseTitle", () => {
    expect(cleanQueryTitle("Kaguya-sama TP2 en español latino")).toBe(parseTitleQuery("Kaguya-sama TP2 en español latino").baseTitle);
  });
});

describe("parseTitleQuery - formatos de temporada extendidos", () => {
  it("'2nd Season' → base + season 2 (caso Jujutsu Kaisen)", () => {
    expect(parseTitleQuery("Jujutsu Kaisen 2nd Season")).toEqual({
      baseTitle: "Jujutsu Kaisen",
      season: 2,
      year: null,
    });
  });

  it("'3rd Season' con ordinal", () => {
    const parsed = parseTitleQuery("Tokyo Revengers 3rd Season");
    expect(parsed.season).toBe(3);
    expect(parsed.baseTitle).toBe("Tokyo Revengers");
  });

  it("ordinal en palabra ('Second Season')", () => {
    const parsed = parseTitleQuery("Oshi no Ko Second Season");
    expect(parsed.season).toBe(2);
    expect(parsed.baseTitle).toBe("Oshi no Ko");
  });

  it("'Season N' en inglés", () => {
    const parsed = parseTitleQuery("The Boys Season 3");
    expect(parsed.season).toBe(3);
    expect(parsed.baseTitle).toBe("The Boys");
  });

  it("'S02' como token independiente", () => {
    const parsed = parseTitleQuery("Shingeki no Kyojin S02");
    expect(parsed.season).toBe(2);
    expect(parsed.baseTitle).toBe("Shingeki no Kyojin");
  });

  it("'Part 2' y 'Part II' mapean a temporada", () => {
    expect(parseTitleQuery("Legend of the Galactic Heroes Part 2")).toEqual({
      baseTitle: "Legend of the Galactic Heroes",
      season: 2,
      year: null,
    });
    expect(parseTitleQuery("JoJo's Bizarre Adventure Part II")).toEqual({
      baseTitle: "JoJo's Bizarre Adventure",
      season: 2,
      year: null,
    });
  });

  it("número romano final en mayúsculas", () => {
    const parsed = parseTitleQuery("Final Fantasy VII");
    expect(parsed.season).toBe(7);
    expect(parsed.baseTitle).toBe("Final Fantasy");
  });

  it("'Final Season' se elimina del base pero NO asigna número", () => {
    expect(parseTitleQuery("Attack on Titan Final Season")).toEqual({
      baseTitle: "Attack on Titan",
      season: null,
      year: null,
    });
  });

  it("sin falsos positivos: 'Boss 2' y 'Mister X' quedan intactos", () => {
    expect(parseTitleQuery("Boss 2")).toEqual({ baseTitle: "Boss 2", season: null, year: null });
    expect(parseTitleQuery("Mister X")).toEqual({ baseTitle: "Mister X", season: null, year: null });
  });
});

describe("translateGenresToEs", () => {
  it("should translate TMDB TV genre names left in English by es-MX", () => {
    expect(translateGenresToEs(["Action & Adventure"])).toEqual(["Acción y Aventura"]);
    expect(translateGenresToEs(["Sci-Fi & Fantasy"])).toEqual(["Ciencia Ficción y Fantasía"]);
    expect(translateGenresToEs(["War & Politics"])).toEqual(["Guerra y Política"]);
    expect(translateGenresToEs(["Kids"])).toEqual(["Infantil"]);
    expect(translateGenresToEs(["Soap"])).toEqual(["Telenovela"]);
  });

  it("should translate AniList/MAL English genres", () => {
    // Caso real ANTES: Dandelion devolvía [Action, Comedy, Supernatural]
    expect(translateGenresToEs(["Action", "Comedy", "Supernatural"])).toEqual([
      "Acción",
      "Comedia",
      "Sobrenatural",
    ]);
  });

  it("should translate TVMaze hyphenated genres case-insensitively", () => {
    expect(translateGenresToEs(["Science-Fiction", "drama"])).toEqual(["Ciencia Ficción", "Drama"]);
  });

  it("should preserve unknown genres and deduplicate", () => {
    expect(translateGenresToEs(["Isekai", "Action", "action"])).toEqual(["Isekai", "Acción"]);
    expect(translateGenresToEs([])).toEqual([]);
  });
});

describe("isSubstantiveDescription", () => {
  it("should reject empty, placeholder, and too-short descriptions", () => {
    expect(isSubstantiveDescription("")).toBe(false);
    expect(isSubstantiveDescription(null)).toBe(false);
    expect(isSubstantiveDescription(undefined)).toBe(false);
    expect(isSubstantiveDescription("Sin descripción disponible.")).toBe(false);
    expect(isSubstantiveDescription("Corta")).toBe(false);
  });

  it("should accept real descriptions", () => {
    expect(isSubstantiveDescription("Un grupo de turistas debe luchar por sus vidas contra un hipopótamo desbocado.")).toBe(true);
  });
});

describe("buildSearchCandidates (parseRawTitle antes de buscar)", () => {
  it("should strip Cinecalidad-style noise ('... Latino Español HD')", () => {
    expect(buildSearchCandidates("Toy Story 5 Latino Español HD")).toEqual(["Toy Story 5"]);
    expect(buildSearchCandidates("Ver Toy Story 5 Online Gratis Latino HD")).toEqual(["Toy Story 5"]);
  });

  it("should extract the year hint without polluting the canonical title", () => {
    expect(buildSearchCandidates("La Bestia 2026")).toEqual(["La Bestia"]);
  });

  it("should offer the legacy parser result as fallback candidate and trim stray connectors", () => {
    expect(buildSearchCandidates("Kaguya-sama TP2 en español latino")).toEqual([
      "Kaguya-sama TP2",
      "Kaguya-sama",
    ]);
  });

  it("should dedupe candidates case-insensitively", () => {
    expect(buildSearchCandidates("Naruto")).toEqual(["Naruto"]);
  });
});

// --- Integración con fetch simulado (sin red) ---

interface MockResponse {
  status?: number;
  json: unknown;
}

/** Instala un fetch global simulado que enruta por dominio/URL. */
function stubFetch(handler: (url: string) => MockResponse | undefined, calls: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, _init?: unknown) => {
      const url = String(typeof input === "string" ? input : (input as { url?: string })?.url ?? "");
      calls.push(url);
      const res = handler(url);
      if (!res) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: (res.status ?? 200) < 400, status: res.status ?? 200, json: async () => res.json };
    })
  );
}

function googleEcho(q: string): unknown {
  return [[[q, "", "", ""], [], "", "", "", []]];
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEngineCaches();
});

describe("enrichUniversalMetadata (integración con mocks)", () => {
  it("resuelve título sucio de Cinecalidad y devuelve géneros TMDB en español para anime", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      if (url.includes("api.themoviedb.org")) {
        const u = new URL(url);
        if (u.pathname.endsWith("/search/multi") && u.searchParams.get("language") === "es-MX") {
          return {
            json: {
              results: [
                {
                  id: 245842,
                  media_type: "tv",
                  name: "Wistoria: Wand and Sword",
                  original_name: "Wistoria: Wand and Sword",
                  original_language: "ja",
                  origin_country: ["JP"],
                  genre_ids: [16, 10759],
                  overview: "Will Serfort asiste a la Academia de Magia Regarden aunque no puede usar magia, pero sueña con convertirse en el mejor mago espadachín.",
                  first_air_date: "2024-06-30",
                  vote_average: 8.1,
                },
              ],
            },
          };
        }
        if (u.pathname.endsWith("/search/multi") && u.searchParams.get("language") === "en-US") {
          return {
            json: {
              results: [
                {
                  id: 245842,
                  media_type: "tv",
                  name: "Wistoria: Wand and Sword",
                  original_language: "ja",
                  overview: "Will Serfort attends Regarden Magic Academy...",
                },
              ],
            },
          };
        }
        if (u.pathname.includes("/genre/tv/list")) {
          return {
            json: {
              genres: [
                { id: 16, name: "Animación" },
                { id: 10759, name: "Action & Adventure" }, // es-MX lo deja en inglés
              ],
            },
          };
        }
      }
      if (url.includes("translate.googleapis.com")) {
        const q = new URL(url).searchParams.get("q") || "";
        return { json: googleEcho(q) };
      }
      return undefined;
    }, calls);

    const meta = await enrichUniversalMetadata("Ver Wistoria Online Latino Español HD", "anime");

    // Título sucio → búsqueda limpia vía parseRawTitle ANTES de TMDB
    const searchCalls = calls.filter((u) => u.includes("/search/multi") && u.includes("language=es-MX"));
    expect(searchCalls).toHaveLength(1);
    expect(new URL(searchCalls[0]).searchParams.get("query")).toBe("Wistoria");
    expect(new URL(searchCalls[0]).searchParams.get("language")).toBe("es-MX");

    expect(meta.tmdb_id).toBe(245842);
    expect(meta.content_type).toBe("anime"); // JP origin
    // Género en español aunque el catálogo es-MX traiga "Action & Adventure"
    expect(meta.genres).toEqual(["Animación", "Acción y Aventura"]);
    expect(isSubstantiveDescription(meta.description)).toBe(true);
  });

  it("rellena el overview desde en-US cuando la entrada no tiene sinopsis en es-MX", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      if (url.includes("api.themoviedb.org")) {
        const u = new URL(url);
        if (u.pathname.endsWith("/search/multi") && u.searchParams.get("language") === "es-MX") {
          return {
            json: {
              results: [
                {
                  id: 421892,
                  media_type: "movie",
                  title: "Shrek 5",
                  original_title: "Shrek 5",
                  original_language: "en",
                  genre_ids: [16, 10751],
                  overview: "", // caso real: esMX_ov=0
                  release_date: "2027-06-30",
                  vote_average: 0,
                },
              ],
            },
          };
        }
        if (u.pathname.endsWith("/search/multi") && u.searchParams.get("language") === "en-US") {
          return {
            json: {
              results: [
                {
                  id: 421892,
                  media_type: "movie",
                  title: "Shrek 5",
                  original_language: "en",
                  overview: "Shrek and Fiona return to Far Far Away with their ogre triplets.",
                },
              ],
            },
          };
        }
        if (u.pathname.includes("/genre/movie/list")) {
          return {
            json: {
              genres: [
                { id: 16, name: "Animación" },
                { id: 10751, name: "Familia" },
              ],
            },
          };
        }
      }
      if (url.includes("translate.googleapis.com")) {
        const q = new URL(url).searchParams.get("q") || "";
        return { json: [[[`[ES] ${q}`, "", "", ""], [], "", "", "", []]] };
      }
      return undefined;
    }, calls);

    const meta = await enrichUniversalMetadata("Ver Shrek 5 Online Latino HD", "movie");

    expect(meta.title).toBe("Shrek 5");
    // El overview vacío en es-MX se completó con en-US + traductor
    expect(meta.description.startsWith("[ES] Shrek and Fiona")).toBe(true);
    expect(meta.genres).toEqual(["Animación", "Familia"]);
  });

  it("anime conocido sin match TMDB: traduce sinopsis (aun si Google falla) y géneros de AniList", async () => {
    const calls: string[] = [];
    let googleAttempts = 0;
    stubFetch((url) => {
      if (url.includes("api.themoviedb.org")) {
        const u = new URL(url);
        if (u.pathname.endsWith("/search/multi")) {
          return { json: { results: [] } }; // TMDB no matchea
        }
        return undefined;
      }
      if (url.includes("graphql.anilist.co")) {
        return {
          json: {
            data: {
              Media: {
                id: 208352,
                title: { romaji: "Dandelion", english: "Dandelion", native: "タンポポ" },
                description: "<p>Tetsuo Tanba guides restless spirits to the afterlife in this supernatural comedy tale.</p>",
                coverImage: { extraLarge: "https://s4.anilist.co/l.jpg", large: null },
                bannerImage: null,
                averageScore: 75,
                startDate: { year: 2026 },
                status: "RELEASING",
                genres: ["Action", "Comedy", "Supernatural"],
                episodes: 12,
              },
            },
          },
        };
      }
      if (url.includes("translate.googleapis.com")) {
        googleAttempts += 1;
        return { status: 429, json: {} }; // caso real: rate-limit del traductor primario
      }
      if (url.includes("api.mymemory.translated.net")) {
        return {
          json: {
            responseData: { translatedText: "Tetsuo Tanba gu&#237;a a los esp&#237;ritus inquietos hacia la otra vida." },
          },
        };
      }
      return undefined;
    }, calls);

    const meta = await enrichUniversalMetadata("Ver Dandelion Online Gratis Sub Español", "anime");

    // Géneros de AniList traducidos al español (ANTES: [Action, Comedy, Supernatural])
    expect(meta.genres).toEqual(["Acción", "Comedia", "Sobrenatural"]);
    // Sinopsis traducida pese al 429 de Google gracias al proveedor de respaldo
    expect(googleAttempts).toBeGreaterThanOrEqual(2);
    expect(meta.description).toBe("Tetsuo Tanba guía a los espíritus inquietos hacia la otra vida.");
    expect(meta.content_type).toBe("anime");
  });
});
