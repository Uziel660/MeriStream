// server/utils/genreNormalizer.ts
// ══════════════════════════════════════════════════════════════════
// Normalización y formateo canónico de géneros multimedia.
// Convierte strings tipo "accion aventura" o ["accion", "aventura"]
// en "Acción, Aventura" con acentos correctos y separación estándar.
// ══════════════════════════════════════════════════════════════════

const KNOWN_GENRES_MAP: Record<string, string> = {
  accion: "Acción",
  acción: "Acción",
  action: "Acción",
  aventura: "Aventura",
  adventure: "Aventura",
  animacion: "Animación",
  animación: "Animación",
  animation: "Animación",
  anime: "Anime",
  comedia: "Comedia",
  comedy: "Comedia",
  crimen: "Crimen",
  crime: "Crimen",
  documental: "Documental",
  documentary: "Documental",
  drama: "Drama",
  familia: "Familia",
  familiar: "Familia",
  family: "Familia",
  fantasia: "Fantasía",
  fantasía: "Fantasía",
  fantasy: "Fantasía",
  historia: "Historia",
  historico: "Historia",
  histórico: "Historia",
  history: "Historia",
  terror: "Terror",
  horror: "Terror",
  miedo: "Terror",
  musica: "Música",
  música: "Música",
  musical: "Música",
  music: "Música",
  misterio: "Misterio",
  mystery: "Misterio",
  romance: "Romance",
  romantico: "Romance",
  romántico: "Romance",
  "ciencia ficcion": "Ciencia Ficción",
  "ciencia ficción": "Ciencia Ficción",
  "sci fi": "Ciencia Ficción",
  "sci-fi": "Ciencia Ficción",
  scifi: "Ciencia Ficción",
  "science fiction": "Ciencia Ficción",
  suspenso: "Suspenso",
  suspense: "Suspenso",
  thriller: "Suspenso",
  belica: "Bélica",
  bélica: "Bélica",
  guerra: "Bélica",
  war: "Bélica",
  western: "Western",
  vaqueros: "Western",
  shonen: "Shonen",
  seinen: "Seinen",
  shojo: "Shojo",
  shoujo: "Shojo",
  isekai: "Isekai",
  ecchi: "Ecchi",
  mecha: "Mecha",
  sobrenatural: "Sobrenatural",
  supernatural: "Sobrenatural",
  psicologico: "Psicológico",
  psicológico: "Psicológico",
  psychological: "Psicológico",
  "recuentos de la vida": "Recuentos de la vida",
  "slice of life": "Recuentos de la vida",
  deportes: "Deportes",
  sports: "Deportes",
  "artes marciales": "Artes Marciales",
  "martial arts": "Artes Marciales",
  superheroes: "Superhéroes",
  superhéroes: "Superhéroes",
  superheroe: "Superhéroes",
  infantil: "Infantil",
  kids: "Infantil",
};

const JUNK_GENRE_TOKENS = new Set([
  "multimedia",
  "directorio",
  "pelicula",
  "peliculas",
  "serie",
  "series",
  "ver",
  "online",
  "gratis",
  "hd",
  "latino",
  "castellano",
  "subtitulado",
  "completa",
  "estrenos",
  "estreno",
]);

function cleanGenreToken(token: string): string {
  const norm = token
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (KNOWN_GENRES_MAP[norm]) {
    return KNOWN_GENRES_MAP[norm];
  }
  if (KNOWN_GENRES_MAP[token.trim().toLowerCase()]) {
    return KNOWN_GENRES_MAP[token.trim().toLowerCase()];
  }

  // Capitalización de primera letra si no está en el diccionario
  const t = token.trim();
  if (t.length <= 1) return "";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Normaliza y da formato estándar a una lista o cadena de géneros.
 * Ejemplos:
 *   "accion aventura"                → "Acción, Aventura"
 *   "Accion, Aventura, Fantasia"      → "Acción, Aventura, Fantasía"
 *   ["ciencia ficcion", "terror"]     → "Ciencia Ficción, Terror"
 *   "Multimedia" con enriched TMDB   → "Acción, Aventura, Drama"
 */
export function formatAndNormalizeGenres(
  rawGenres?: string | string[] | null,
  enrichedGenres?: string[] | null
): string {
  // Si el enriquecedor TMDB/AniList trajo géneros reales de alta calidad:
  if (Array.isArray(enrichedGenres) && enrichedGenres.length > 0) {
    const validEnriched = enrichedGenres
      .map((g) => cleanGenreToken(String(g)))
      .filter((g) => g && !JUNK_GENRE_TOKENS.has(g.toLowerCase()));
    if (validEnriched.length > 0) {
      const rawStr = Array.isArray(rawGenres) ? rawGenres.join(",") : String(rawGenres || "").trim();
      const rawIsUnformatted =
        !rawStr ||
        rawStr === "Multimedia" ||
        !rawStr.includes(",") ||
        rawStr.toLowerCase() === rawStr;
      if (rawIsUnformatted) {
        return Array.from(new Set(validEnriched)).join(", ");
      }
    }
  }

  if (!rawGenres) return "Multimedia";

  let tokens: string[] = [];

  if (Array.isArray(rawGenres)) {
    tokens = rawGenres.map((g) => String(g || "").trim()).filter(Boolean);
  } else if (typeof rawGenres === "string") {
    const str = rawGenres.trim();
    if (!str || str === "Multimedia") return "Multimedia";

    if (str.includes(",") || str.includes("/") || str.includes("|") || str.includes(";")) {
      tokens = str.split(/[,/|;]+/).map((s) => s.trim()).filter(Boolean);
    } else {
      // Cadena sin separadores como "accion aventura" o "drama romance fantasia"
      const lower = str.toLowerCase();
      // 1. Probar compuestos multi-palabra primero
      let remaining = lower;
      const foundCompounds: string[] = [];
      const compoundKeys = Object.keys(KNOWN_GENRES_MAP).filter((k) => k.includes(" "));
      for (const comp of compoundKeys) {
        if (remaining.includes(comp)) {
          foundCompounds.push(KNOWN_GENRES_MAP[comp]);
          remaining = remaining.replace(comp, " ");
        }
      }

      // 2. Extraer palabras individuales restantes
      const words = remaining.split(/\s+/).map((w) => w.trim()).filter(Boolean);
      tokens = [...foundCompounds, ...words];
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const cleaned = cleanGenreToken(token);
    const lowerNorm = cleaned.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!cleaned || JUNK_GENRE_TOKENS.has(lowerNorm) || seen.has(lowerNorm)) {
      continue;
    }
    seen.add(lowerNorm);
    result.push(cleaned);
  }

  return result.length > 0 ? result.join(", ") : "Multimedia";
}
