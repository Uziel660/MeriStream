import sanitizeHtml from 'sanitize-html';
import "dotenv/config";
import { ContentKind } from "./types";
import { parseRawTitle } from "./utils/titleNormalizer";

export interface EnrichedMetadata {
  title: string;
  original_title?: string | null;
  japanese_title?: string | null;
  english_title?: string | null;
  description: string;
  poster_url: string | null;
  banner_url: string | null;
  rating: number;
  year: number;
  status: string;
  genres: string[];
  content_type: ContentKind;
  suggested_episodes?: Array<{ number: number; title: string; url?: string }>;
  mal_id?: number | null;
  /** ID interno de TMDB cuando la metadata viene de allí. */
  tmdb_id?: number;
  /** Ruta relativa del póster TMDB (ej. "/abc.jpg"); sirve para armar URLs con otros tamaños. */
  poster_path?: string | null;
  /** Ruta relativa del backdrop TMDB. */
  backdrop_path?: string | null;
}

export interface ParsedTitleQuery {
  baseTitle: string;
  season: number | null;
  year: number | null;
}

// Orden de prioridad: lo más específico primero. El patrón suelto \bT\d va al final
// porque es el más propenso a falsos positivos con títulos que empiezan por T.
//
// Formatos de temporada reconocidos (FIX "temporadas no detectadas"):
//   "Temporada 2", "2nd Season", "Second Season", "Season 2", "TP2",
//   "S01E05", "S2"/"S02" como token suelto, "Part 2"/"Part II",
//   romanos finales en mayúsculas ("Rocky II") y el marcador sin número
//   "Final Season" (se elimina del base pero no asigna temporada).
const WORD_SEASON_NUMS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

const ROMAN_SEASON_NUMS: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12,
};

interface SeasonPatternEntry {
  re: RegExp;
  resolve: (m: RegExpMatchArray) => number | null;
}

const SEASON_PATTERNS: SeasonPatternEntry[] = [
  { re: /\btemporada\s*(?:n[uú]mero\s*)?-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  {
    re: new RegExp(`\\b(${Object.keys(WORD_SEASON_NUMS).join("|")})\\s+season\\b`, "i"),
    resolve: (m) => WORD_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bseason\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  { re: /\bTP\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  { re: /\bS(\d{1,2})\s*E\d+\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  // "S2"/"S02" SOLO token independiente (\b evita "Boss 2"/"PS2").
  { re: /\bs(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  { re: /\bpart\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  {
    re: /\bpart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/i,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bT(\d{1,2})\b/i, resolve: (m) => Number.parseInt(m[1], 10) },
  {
    re: /(?:^|\s)(II|III|IV|VI|VII|VIII|IX|XI|XII)$/,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bfinal\s+season\b/i, resolve: () => null },
];

const YEAR_PATTERN = /\b(19|20)\d{2}\b/;

const QUERY_PREFIX_RE = /^(?:Ver\s+Online|Ver|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\s+Movie|Episodios\s+de)\s+/i;

/**
 * Separa un título crudo de scraper/query en título base + temporada + año.
 * Nota documentada: un año explícito SIEMPRE se extrae aunque forme parte del
 * nombre comercial (ej. "Blade Runner 2049" → baseTitle "Blade Runner", year 2049).
 */
export function parseTitleQuery(raw: string): ParsedTitleQuery {
  const fallbackBase = raw.replace(/\s+/g, " ").trim();
  let title = fallbackBase;

  // a) Frases completas de idioma
  title = title.replace(/\s*(?:en\s+español\s+latino|español\s+latino|spanish\s+latino)/gi, " ");

  // b) Temporada (antes de cualquier otra limpieza): el primer patrón que
  // calza gana y se elimina del título base.
  let season: number | null = null;
  for (const pattern of SEASON_PATTERNS) {
    const m = title.match(pattern.re);
    if (m) {
      season = pattern.resolve(m);
      title = title.replace(pattern.re, " ");
      break;
    }
  }

  // c) Año suelto (19xx/20xx únicamente; "Furiosos 9" o "1080p" nunca calzan)
  let year: number | null = null;
  const yearMatch = title.match(YEAR_PATTERN);
  if (yearMatch) {
    year = Number.parseInt(yearMatch[0], 10);
    title = title.replace(YEAR_PATTERN, " ");
  }

  // Limpieza de paréntesis/corchetes vaciados por las extracciones previas
  title = title.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ");

  // d) Limpieza clásica de query (prefijos, etiquetas, cortes de calidad/audio)
  title = title.trim();
  let previous: string;
  do {
    previous = title;
    title = title.replace(QUERY_PREFIX_RE, "");
  } while (title !== previous);

  title = title.replace(/\s*\(TV\)/i, "");
  title = title.replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "");
  title = title.replace(/\s*(?:Sub\s*Español|Audio\s*Latino|Latino|Castellano|Dual|1080p|720p|4K|HD|Full\s*HD|Online|Gratis|Free|Episodio\s*\d+|Capitulo\s*\d+|Cap\s*\d+|S\d+E\d+).*$/i, "");
  title = title.replace(/\s+[-|—]\s*$/, "");
  title = title.split(/\s+[-|—]\s+/)[0].trim();

  // Custom cleanup for common patterns not caught
  title = title.replace(/\s+\([^)]*\)$/g, ""); // Remove trailing parentheses again just in case
  title = title.replace(/^Ver\s+/i, "");

  // e) Normalización final + fallback si todo era ruido
  title = title.replace(/\s+/g, " ").trim();

  return {
    baseTitle: title || fallbackBase,
    season,
    year,
  };
}

export function cleanQueryTitle(raw: string): string {
  return parseTitleQuery(raw).baseTitle;
}

const GENERIC_TITLES = new Set([
  "anime", "anime online", "ver anime", "ver anime online", "contenido", "catalogo", "catálogo",
  "directorio", "pagina", "página", "movies", "series", "inicio", "home",
  "lista", "list", "animes", "pelicula", "películas", "movie", "tv", "show", "watch", "online",
]);

function isGenericQuery(lower: string): boolean {
  return (
    GENERIC_TITLES.has(lower) ||
    lower.length < 3 ||
    /^page\s*\d+$/i.test(lower) ||
    lower.startsWith("page ") ||
    lower.includes("pagina ")
  );
}

// --- Traducción de géneros a español ---
// TMDB deja varios géneros de TV en inglés incluso en es-MX/es-ES
// ("Action & Adventure", "Sci-Fi & Fantasy", ...), y AniList/Jikan/TVMaze
// devuelven sus catálogos en inglés. Este mapa unifica todo a español.
const GENRE_ES_ALIASES: Record<string, string> = {
  "action": "Acción",
  "action adventure": "Acción y Aventura",
  "action y aventura": "Acción y Aventura",
  "adventure": "Aventura",
  "animation": "Animación",
  "anime": "Anime",
  "comedy": "Comedia",
  "drama": "Drama",
  "crime": "Crimen",
  "documentary": "Documental",
  "family": "Familia",
  "kids": "Infantil",
  "children": "Infantil",
  "mystery": "Misterio",
  "news": "Noticias",
  "reality": "Reality",
  "sci fi fantasy": "Ciencia Ficción y Fantasía",
  "science fiction": "Ciencia Ficción",
  "science fiction fantasy": "Ciencia Ficción y Fantasía",
  "soap": "Telenovela",
  "soap opera": "Telenovela",
  "talk": "Talk Show",
  "talk show": "Talk Show",
  "war politics": "Guerra y Política",
  "war": "Bélico",
  "western": "Western",
  "fantasy": "Fantasía",
  "horror": "Terror",
  "thriller": "Suspenso",
  "suspense": "Suspenso",
  "romance": "Romance",
  "slice of life": "Vida Cotidiana",
  "supernatural": "Sobrenatural",
  "psychological": "Psicológico",
  "sports": "Deportes",
  "sport": "Deportes",
  "music": "Música",
  "musical": "Musical",
  "mecha": "Mecha",
  "ecchi": "Ecchi",
  "mahou shoujo": "Mahou Shoujo",
  "award winning": "Galardonado",
  "hentai": "Hentai",
  "erotica": "Erótica",
  "boys love": "Boys Love",
  "girls love": "Girls Love",
  "gourmet": "Gourmet",
  "avant garde": "Vanguardia",
  "history": "Historia",
  "espionage": "Espionaje",
  "travel": "Viajes",
  "legal": "Legal",
  "medical": "Médico",
  "food": "Cocina",
  "cooking": "Cocina",
  "short": "Cortometraje",
  "teens": "Adolescentes",
};

/** Normaliza un nombre de género para lookup ("Sci-Fi & Fantasy" → "sci fi fantasy"). */
function normalizeGenreKey(genre: string): string {
  return String(genre ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Traduce una lista de géneros (cualquier fuente) a español; desconocidos se conservan. */
export function translateGenresToEs(genres: string[]): string[] {
  const out: string[] = [];
  for (const g of Array.isArray(genres) ? genres : []) {
    if (typeof g !== "string" || !g.trim()) continue;
    const translated = GENRE_ES_ALIASES[normalizeGenreKey(g)] || g.trim();
    if (!out.includes(translated)) out.push(translated);
  }
  return out;
}

/**
 * Una descripción sirve si existe, no es el placeholder y tiene contenido real.
 * Los placeholders genéricos o textos de menos de 60 caracteres se consideran débiles.
 */
export function isSubstantiveDescription(description: string | null | undefined): boolean {
  const t = String(description ?? "").trim();
  if (!t || t === "Sin descripción disponible.") return false;
  return t.length >= 60;
}

/**
 * Candidatos de búsqueda ordenados a partir del título crudo: usa el contrato
 * parseRawTitle (titleNormalizer) primero y el parser legacy como respaldo.
 * Ej. "Toy Story 5 Latino Español HD" → ["Toy Story 5"].
 */
export function buildSearchCandidates(rawQuery: string): string[] {
  const rawParsed = parseRawTitle(rawQuery);
  const legacy = parseTitleQuery(rawQuery);
  const tidy = (t: string) =>
    t
      .replace(/\s+/g, " ")
      // recorta conectores sueltos que quedaron tras quitar ruido ("Kaguya-sama TP2 en")
      .replace(/\s+(?:en|de|del|un|una|y|o)$/i, "")
      .replace(/\s*[,\-–—:|]+\s*$/, "")
      .trim();
  const out: string[] = [];
  for (const c of [tidy(rawParsed.canonical), tidy(legacy.baseTitle)]) {
    if (c && c.length >= 2 && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  const rawFallback = String(rawQuery ?? "").replace(/\s+/g, " ").trim();
  if (out.length === 0 && rawFallback) out.push(rawFallback);
  return out;
}

function buildDefaultMetadata(cleaned: string, rawQuery: string, hintKind?: ContentKind, genres: string[] = ["Multimedia"]): EnrichedMetadata {
  return {
    title: cleaned || rawQuery || "Contenido Multimedia",
    description: "Contenido indexado en VoidStream con reproductor Just-In-Time.",
    poster_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=800&q=80",
    banner_url: "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=1600&q=80",
    rating: 8.0,
    year: 0,
    status: "Finalizado",
    genres,
    content_type: hintKind || "anime",
  };
}

/**
 * Enriches metadata across multiple engines (TVMaze, Jikan MAL, Kitsu, Internet Archive, Wikipedia)
 */

  const createAnimeResponse = async (title: string, poster: string, cover: string, status: string, attr: any) => {
    return {
      title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || title,
      original_title: attr.titles?.ja_jp || undefined,
      description: await cleanAndTranslateDescription(attr.synopsis || ""),
      poster_url: poster,
      banner_url: cover,
      rating: attr.averageRating ? Math.round((Number.parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
      year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 0,
      status: status === "current" ? "En emisión" : "Finalizado",
      genres: ["Anime"],
      content_type: "anime" as ContentKind,
    };
  };


// --- TMDB API (Movies, TV Series, Anime fallback) ---

const TMDB_GENRE_TTL_MS = 24 * 60 * 60 * 1000;
const tmdbGenreCache = new Map<"movie" | "tv", { names: Map<number, string>; fetchedAt: number }>();

/** Limpia caches internas del engine (uso exclusivo de tests). */
export function __resetEngineCaches(): void {
  tmdbGenreCache.clear();
}

/** Géneros TMDB en es-MX, cacheados 24h. Devuelve mapa vacío si la llamada falla. */
async function fetchTMDBGenreMap(mediaType: "movie" | "tv"): Promise<Map<number, string>> {
  const cached = tmdbGenreCache.get(mediaType);
  if (cached && Date.now() - cached.fetchedAt < TMDB_GENRE_TTL_MS) {
    return cached.names;
  }
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return new Map();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.themoviedb.org/3/genre/${mediaType}/list?language=es-MX&api_key=${apiKey}`, { // NOSONAR
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json(); // NOSONAR
      const names = new Map<number, string>();
      for (const g of data?.genres || []) {
        // TMDB deja géneros de TV en inglés incluso en es-MX/es-ES
        // ("Action & Adventure", "Sci-Fi & Fantasy"...): traducir al guardar.
        if (typeof g?.id === "number" && typeof g?.name === "string") {
          names.set(g.id, translateGenresToEs([g.name])[0] || g.name);
        }
      }
      tmdbGenreCache.set(mediaType, { names, fetchedAt: Date.now() });
      return names;
    }
  } catch {
    // ignore: sin cachear el fallo para reintentar en la próxima llamada
  }
  return cached?.names || new Map();
}

/** Segunda búsqueda ligera con language=en para obtener título/overview originales por id. */
async function fetchTMDBEnUSResult(query: string, tmdbId: number): Promise<{ title: string; overview: string } | null> {
  try {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=en-US&api_key=${apiKey}`, { // NOSONAR
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json(); // NOSONAR
      const match = (data?.results || []).find((r: any) => r?.id === tmdbId && r.media_type !== "person");
      if (!match) return null;
      return {
        title: match?.title || match?.name || "",
        overview: typeof match?.overview === "string" ? match.overview : "",
      };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchTMDBMetadata(
  query: string,
  kind?: ContentKind,
  seasonHint?: number | null,
  yearHint?: number | null
): Promise<EnrichedMetadata | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    // Use multi search to get movies or tv shows
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=es-MX&api_key=${apiKey}`, { // NOSONAR
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json(); // NOSONAR
      if (data && data.results && data.results.length > 0) {
        // Filter out people, prefer what matches the kind if provided
        let candidates = data.results.filter((r: any) => r.media_type !== "person");
        if (kind === "movie") {
          candidates = candidates.filter((r: any) => r.media_type === "movie");
        } else if (kind === "series" || kind === "anime") {
          candidates = candidates.filter((r: any) => r.media_type === "tv");
        }
        let bestResult = candidates[0];
        // Desambiguación por año del título parseado (ej. "Coco 2017")
        if (yearHint != null && Array.isArray(candidates)) {
          const yearMatch = candidates.find((r: any) => {
            const y = Number.parseInt(String(r.release_date || r.first_air_date || "").substring(0, 4), 10);
            return y === yearHint;
          });
          if (yearMatch) bestResult = yearMatch;
        }
        if (!bestResult) bestResult = data.results.find((r: any) => r.media_type !== "person");

        // Rescate de overview: TMDB a menudo devuelve entradas sin sinopsis
        // (peliculas por estrenarse, podcasts "Countdown to...", "special looks").
        // Preferir un candidato del mismo media_type CON overview antes que uno vacío.
        if (bestResult && !(bestResult.overview || "").trim()) {
          const withOverview = candidates.filter(
            (r: any) => (r.overview || "").trim().length > 0 && r.media_type === bestResult.media_type
          );
          if (withOverview.length > 0) {
            const sameYear = yearHint != null
              ? withOverview.find((r: any) => Number.parseInt(String(r.release_date || r.first_air_date || "").substring(0, 4), 10) === yearHint)
              : undefined;
            bestResult = sameYear || withOverview[0];
          }
        }

        if (bestResult) {
            const isTV = bestResult.media_type === 'tv';
            const title = bestResult.title || bestResult.name || query;
            const originalTitle = bestResult.original_title || bestResult.original_name || title;

            // Título inglés: si la obra ya es en inglés usamos el original (evita segunda llamada);
            // si no, búsqueda ligera adicional con language=en. Esa misma llamada aporta el
            // overview en-US de respaldo para entradas sin sinopsis traducida.
            let englishTitle: string | null = null;
            let enOverview = "";
            if (bestResult.original_language === "en" && (bestResult.overview || "").trim()) {
              englishTitle = bestResult.original_title || bestResult.original_name || title;
            } else {
              const enRes = await fetchTMDBEnUSResult(query, bestResult.id);
              englishTitle = enRes?.title || bestResult.original_title || bestResult.original_name || null;
              enOverview = enRes?.overview || "";
            }

            // Fallback es-MX → en-US: muchas entradas nuevas no tienen sinopsis
            // traducida; se toma la inglesa y el traductor la pasa a español.
            let overviewRaw: string = bestResult.overview || "";
            if (!overviewRaw.trim() && enOverview.trim()) overviewRaw = enOverview;
            const overview = await cleanAndTranslateDescription(overviewRaw);

            const posterPath: string | null = bestResult.poster_path || null;
            const backdropPath: string | null = bestResult.backdrop_path || null;
            const poster = posterPath ? `https://image.tmdb.org/t/p/w780${posterPath}` : null;
            const banner = backdropPath ? `https://image.tmdb.org/t/p/w1280${backdropPath}` : poster;

            const yearStr = bestResult.release_date || bestResult.first_air_date || "";
            const year = yearStr ? parseInt(yearStr.substring(0, 4), 10) : 0;

            const rating = bestResult.vote_average ? Math.round(bestResult.vote_average * 10) / 10 : 8.0;

            // Géneros reales en español desde el catálogo de géneros TMDB (cacheado)
            let genres: string[] = [];
            const genreMap = await fetchTMDBGenreMap(isTV ? "tv" : "movie");
            if (genreMap.size > 0 && Array.isArray(bestResult.genre_ids)) {
              genres = bestResult.genre_ids.map((gid: number) => genreMap.get(gid)).filter((g): g is string => Boolean(g));
            }
            if (genres.length === 0) {
              genres = [isTV ? "Serie de TV" : "Película"];
            }

            let contentType: ContentKind = kind || (isTV ? "series" : "movie");
            // If it's TV and originating from Japan (usually anime)
            if (isTV && bestResult.origin_country && bestResult.origin_country.includes('JP')) {
                contentType = "anime";
            }
            void seasonHint; // reservado para desambiguación fina de series cuando TMDB exponga season en search

            return {
                title,
                original_title: originalTitle,
                english_title: englishTitle || undefined,
                description: overview,
                poster_url: poster,
                banner_url: banner,
                rating,
                year,
                status: "Finalizado", // TMDB search doesn't give status directly without another fetch
                genres,
                content_type: contentType,
                tmdb_id: typeof bestResult.id === "number" ? bestResult.id : undefined,
                poster_path: posterPath,
                backdrop_path: backdropPath,
            };
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Validación cruzada TMDB↔anime-DBs: un match de TMDB para un anime es
 * sospechoso si no tiene el género Animación o data de antes de los 90
 * (falso positivo clásico: "Dandelion Dead" movie británica de 1994 vs el
 * anime Joukamachi no Dandelion). En ese caso AniList decide.
 */
function isSuspiciousAnimeMatch(meta: EnrichedMetadata): boolean {
  if (!meta.tmdb_id) return false;
  const hasAnimationGenre =
    Array.isArray(meta.genres) &&
    meta.genres.some((g) => /anim/i.test(g));
  const tooOldForAnime = meta.year < 1995;
  return !hasAnimationGenre || tooOldForAnime;
}

/**
 * Rellena la descripción de un resultado TMDB débil (overview vacío) usando
 * fuentes secundarias, sin perder la identidad TMDB (título/póster/año/ids).
 */
async function fillWeakDescription(meta: EnrichedMetadata, kindHint: string, query: string): Promise<EnrichedMetadata> {
  if (isSubstantiveDescription(meta.description)) return meta;
  const sources: Array<{ desc?: string; genres?: string[] }> = [];
  if (kindHint === "anime" || kindHint === "series" || !kindHint) {
    sources.push(await fetchAnimeMetadata(query).then((m) => (m ? { desc: m.description, genres: m.genres } : {})));
  }
  if (kindHint === "series" || kindHint === "movie" || !kindHint) {
    sources.push(await fetchTVMazeMetadata(query).then((m) => (m ? { desc: m.description, genres: m.genres } : {})));
  }
  sources.push(await fetchWikipediaMetadata(query).then((m) => (m ? { desc: m.description } : {})));

  for (const s of sources) {
    if (s.desc && isSubstantiveDescription(s.desc)) {
      meta.description = s.desc;
      // Si los géneros eran solo el fallback genérico, aprovechar los reales.
      const generic = new Set(["Película", "Serie de TV", "Multimedia", "Anime"]);
      if (meta.genres.length <= 1 && generic.has(meta.genres[0]) && s.genres && s.genres.length > 1) {
        meta.genres = translateGenresToEs(s.genres);
      }
      break;
    }
  }
  return meta;
}

export async function enrichUniversalMetadata(
  rawQuery: string,
  hintKind?: ContentKind
): Promise<EnrichedMetadata> {
  const parsed = parseTitleQuery(rawQuery);
  const cleaned = parsed.baseTitle;
  const lower = cleaned.toLowerCase();

  // Candidatos de búsqueda: parseRawTitle (contrato) primero, parser legacy como respaldo.
  const candidates = buildSearchCandidates(rawQuery);
  const yearHint = parsed.year ?? null;

  // 1. TMDB (Primary source, enforcing es-MX) con reintentos sobre candidatos alternativos:
  // se acepta el primer match con descripción sustantiva; un match débil (sin overview)
  // se recuerda y se rellena después desde fuentes secundarias.
  let tmdbData: EnrichedMetadata | null = null;
  for (const cand of candidates) {
    const res = await fetchTMDBMetadata(cand, hintKind, parsed.season, yearHint);
    if (!res) continue;
    if (!tmdbData) tmdbData = res;
    if (isSubstantiveDescription(res.description)) {
      tmdbData = res;
      break;
    }
  }

  // Para animes: si TMDB trajo algo sospechoso, cruzar con las bases de anime
  // antes de aceptarlo; si la base de anime matchea, gana.
  if (tmdbData && (hintKind === "anime" || hintKind === "series") && isSuspiciousAnimeMatch(tmdbData)) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta) return animeMeta;
    // Sin mejor candidato en bases de anime: conservar TMDB pero sin inventar.
    return fillWeakDescription(tmdbData, hintKind, cleaned);
  }

  if (tmdbData) return fillWeakDescription(tmdbData, hintKind, cleaned);


  // If query is a generic placeholder or page number, do NOT query external APIs to prevent false matches (e.g. Little Witch Academia)
  if (isGenericQuery(lower)) {
    return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Multimedia"]);
  }

  // If hint is archive or query mentions archive/classic/dominio publico
  if (hintKind === "open_archive" || lower.includes("archive.org") || lower.includes("dominio publico")) {
    const archiveMeta = await fetchArchiveOrgMetadata(cleaned);
    if (archiveMeta) return archiveMeta;
  }

  // 1. If hint is anime or general query, try Anime engines first (Jikan MAL / Kitsu)
  if (hintKind === "anime" || !hintKind) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta && (animeMeta.rating > 0 || hintKind === "anime")) {
      return animeMeta;
    }
  }

  // 2. Try TVMaze API (Series, Dramas, Cartoons, TV shows)
  if (hintKind === "series" || hintKind === "movie" || !hintKind) {
    const tvMeta = await fetchTVMazeMetadata(cleaned);
    if (tvMeta) {
      if (hintKind) tvMeta.content_type = hintKind;
      return tvMeta;
    }
  }

  // 3. Try Internet Archive open database
  const archiveMeta = await fetchArchiveOrgMetadata(cleaned);
  if (archiveMeta) return archiveMeta;

  // 4. Try Wikipedia summary API
  const wikiMeta = await fetchWikipediaMetadata(cleaned);
  if (wikiMeta) return wikiMeta;

  // Fallback defaults
  return buildDefaultMetadata(cleaned, rawQuery, hintKind, ["Acción", "Aventura"]);
}

// --- AniList, Kitsu & Jikan MAL Anime Enricher ---
async function fetchAnimeMetadata(query: string): Promise<EnrichedMetadata | null> {
  // Strip season suffixes (e.g., "3rd Season", "Season 2", "Part 2", "II") for better search accuracy
  const simplifiedQuery = query
    .replace(/\s*(?:\d+(?:st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|\b[IVXLCDM]+\b)/gi, "")
    .replace(/\s*\([^)]*\)|\s*\[[^\]]*\]|\s*\{[^}]*\}/g, "")
    .replace(/[-_]/g, " ")
    .trim();

  const searchQuery = simplifiedQuery.length >= 3 ? simplifiedQuery : query;

  // 1. AniList GraphQL API (Primary & Fast <200ms)
  try {
    const graphqlQuery = `
      query ($search: String) {
        Media(search: $search, type: ANIME) {
          id
          title {
            romaji
            english
            native
          }
          description(asHtml: false)
          coverImage {
            extraLarge
            large
          }
          bannerImage
          averageScore
          startDate {
            year
          }
          status
          genres
          episodes
        }
      }
    `;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("https://graphql.anilist.co", { // NOSONAR
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: graphqlQuery, variables: { search: searchQuery } }),
    });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json(); // NOSONAR
      const media = data?.data?.Media;
      if (media) {
        const poster = media.coverImage?.extraLarge || media.coverImage?.large || null;
        const banner = media.bannerImage || poster;
        const cleanDesc = await cleanAndTranslateDescription(media.description || "");

        return {
          title: media.title?.romaji || media.title?.english || query,
          original_title: media.title?.native || media.title?.romaji,
          japanese_title: media.title?.native || undefined,
          english_title: media.title?.english || undefined,
          description: cleanDesc || "Sin descripción disponible.",
          poster_url: poster,
          banner_url: banner,
          rating: media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : 8.2,
          year: media.startDate?.year || 0,
          status: media.status === "RELEASING" ? "En emisión" : "Finalizado",
          // AniList devuelve géneros en inglés (Action, Comedy...): traducir.
          genres: translateGenresToEs(Array.isArray(media.genres) ? media.genres : []).length > 0
            ? translateGenresToEs(media.genres)
            : ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {
    // ignore, try fallbacks
  }

  // 2. Kitsu API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(searchQuery)}&page[limit]=1`, { // NOSONAR
      signal: controller.signal,
      headers: {
        "User-Agent": "VoidStream-Universal-Scraper/2.5",
        Accept: "application/vnd.api+json",
      },
    });
    clearTimeout(timer);

    if (res.ok) {
      const json: unknown = await res.json();
      if (json?.data && json.data.length > 0) {
        const attr = json.data[0].attributes || {};
        const poster = attr.posterImage?.large || attr.posterImage?.original || attr.posterImage?.medium;
        const cover = attr.coverImage?.large || attr.coverImage?.original || poster;

        return {
          title: attr.canonicalTitle || query,
          original_title: attr.titles?.ja_jp,
          japanese_title: attr.titles?.ja_jp || undefined,
          english_title: attr.titles?.en || undefined,
          description: await cleanAndTranslateDescription(attr.synopsis || ""),
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((Number.parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 0,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
        };
      }
    }
  } catch {
    // ignore
  }

  // 3. Jikan MAL API fallback
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(searchQuery)}&limit=1`, { // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const json: any = await res.json(); // NOSONAR
      if (json?.data && json.data.length > 0) {
        const item = json.data[0];
        const poster = item.images?.webp?.large_image_url || item.images?.jpg?.large_image_url || item.images?.jpg?.image_url;
        // Jikan/MAL devuelve géneros en inglés: traducir al español.
        const rawGenres = Array.isArray(item.genres) ? item.genres.map((g: any) => g.name).filter(Boolean) : [];
        const genres = translateGenresToEs(rawGenres).length > 0 ? translateGenresToEs(rawGenres) : ["Anime"];

        return {
          title: item.title || query,
          original_title: item.title_japanese || item.title,
          japanese_title: item.title_japanese || undefined,
          english_title: item.title_english || undefined,
          description: await cleanAndTranslateDescription(item.synopsis || ""),
          poster_url: poster,
          banner_url: poster,
          rating: item.score || 8.2,
          year: item.year || item.aired?.prop?.from?.year || 0,
          status: item.status === "Currently Airing" ? "En emisión" : "Finalizado",
          genres,
          content_type: "anime",
          mal_id: item.mal_id,
        };
      }
    }
  } catch {
    // ignore
  }

  return null;
}

// --- TVMaze API (Movies, TV Series, Shows with full episode trees) ---
async function fetchTVMazeMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(query)}&embed=episodes`, { // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const show: any = await res.json(); // NOSONAR
      if (show && show.name) {
        const poster = show.image?.original || show.image?.medium || null;
        const cleanSummary = await cleanAndTranslateDescription(show.summary || "");
        const year = show.premiered ? Number.parseInt(show.premiered.slice(0, 4), 10) : 0;
        const isAnime = (show.type || "").toLowerCase() === "animation" && (show.genres || []).includes("Anime");

        const suggested_episodes = (show._embedded?.episodes || []).map((ep: any) => {
          const season = ep.season || 1;
          const number = ep.number || 1;
          // Defecto #18: número global único (season*100+n) — TVMaze numera
          // intra-temporada y colisionaría (T1E1..TN1 todos number=1).
          return {
            number: season * 100 + number,
            title: `T${season}E${number}: ${ep.name || "Episodio"}`,
            url: ep.url || undefined,
          };
        });

        return {
          title: show.name,
          original_title: show.name,
          description: cleanSummary || "Serie de televisión indexada con éxito.",
          poster_url: poster,
          banner_url: poster,
          rating: show.rating?.average || 8.2,
          year,
          status: show.status === "Running" ? "En emisión" : "Finalizado",
          // TVMaze devuelve géneros en inglés (Drama, Science-Fiction...): traducir.
          genres: translateGenresToEs(show.genres || []).length > 0 ? translateGenresToEs(show.genres) : ["Serie de TV", "Drama"],
          content_type: isAnime ? "anime" : (show.type === "Scripted" || show.type === "Reality" ? "series" : "movie"),
          suggested_episodes: suggested_episodes.length > 0 ? suggested_episodes.slice(0, 30) : undefined,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- Internet Archive (Archive.org) Open Domain & Classic Cinema API ---
async function fetchArchiveOrgMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const searchUrl = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:(movies)&fl[]=identifier,title,description,year,publicdate&sort[]=&rows=1&page=1&output=json`; // NOSONAR
    const res = await fetch(searchUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data: any = await res.json(); // NOSONAR
      const doc = data?.response?.docs?.[0];
      if (doc && doc.identifier) {
        const id = doc.identifier;
        const poster = `https://archive.org/services/img/${id}`;
        const streamMp4 = `https://archive.org/download/${id}/${id}.mp4`;

        return {
          title: doc.title || query,
          original_title: doc.title,
          description: await cleanAndTranslateDescription(doc.description || "Película u obra audiovisual de libre acceso en Internet Archive."),
          poster_url: poster,
          banner_url: poster,
          rating: 8.5,
          year: doc.year ? Number.parseInt(doc.year, 10) : 1970,
          status: "Dominio Público",
          genres: ["Clásico", "Dominio Público", "Cine de Culto"],
          content_type: "open_archive",
          suggested_episodes: [
            {
              number: 1,
              title: `${doc.title || "Película Completa"} [Archive.org HD]`,
              url: streamMp4,
            },
          ],
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// --- Wikipedia Metadata API ---
async function fetchWikipediaMetadata(query: string): Promise<EnrichedMetadata | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, { // NOSONAR
      signal: controller.signal,
      headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" },
    });
    clearTimeout(timer);

    if (res.ok) {
      const page: any = await res.json(); // NOSONAR
      if (page && page.title && page.extract) {
        return {
          title: page.title,
          description: await cleanAndTranslateDescription(typeof page.extract === "string" ? page.extract : (page.extract ? String(page.extract) : "")),
          poster_url: page.thumbnail?.source || page.originalimage?.source || null,
          banner_url: page.originalimage?.source || page.thumbnail?.source || null,
          rating: 8.0,
          year: 0,
          status: "Finalizado",
          genres: ["Película / Obra"],
          content_type: "movie",
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // entidades numéricas (p.ej. &#237; → í) que MyMemory devuelve a menudo
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Traduce vía Google Translate (endpoint gtx). null si falla. */
async function tryGoogleTranslate(text: string): Promise<string | null> {
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=es&dt=t&q=${encodeURIComponent(text)}`); // NOSONAR
    if (!res.ok) return null;
    const json: unknown = await res.json();
    if (Array.isArray(json) && Array.isArray(json[0])) {
      const translated = json[0].map((x: unknown) => Array.isArray(x) ? String(x[0]) : "").join("");
      return translated || null;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Proveedor de respaldo (MyMemory): evita que un 429/rate-limit del traductor
 * primario deje descripciones enteras en inglés.
 */
async function tryMyMemoryTranslate(text: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.substring(0, 500))}&langpair=en|es`); // NOSONAR
    if (!res.ok) return null;
    const json: any = await res.json(); // NOSONAR
    const translated = json?.responseData?.translatedText;
    if (typeof translated === "string" && translated.trim()) return decodeHtmlEntities(translated);
  } catch {
    // ignore
  }
  return null;
}

async function cleanAndTranslateDescription(text: string): Promise<string> {
  if (!text || text.trim() === "") return "Sin descripción disponible.";

  let cleaned = text
    .replace(/<[^>]*>?/gm, "")
    .replace(/\n\s*\n/g, "\n")
    .replace(/\(Source:[^)]+\)/gi, "")
    .replace(/\[Written by[^\]]+\]/gi, "")
    .replace(/Source:[^\n]+/gi, "")
    .trim();

  if (cleaned.length === 0) return "Sin descripción disponible.";

  const source = cleaned.substring(0, 1500);
  // Intento 1: Google; intento 2: Google tras breve espera (429 rate-limit);
  // intento 3: MyMemory. Si todo falla se devuelve el texto limpio original.
  const google1 = await tryGoogleTranslate(source);
  if (google1) return google1;
  await new Promise((r) => setTimeout(r, 400));
  const google2 = await tryGoogleTranslate(source);
  if (google2) return google2;
  const fallback = await tryMyMemoryTranslate(source);
  if (fallback) return fallback;
  return cleaned;
}
