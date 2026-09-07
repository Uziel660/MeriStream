import sanitizeHtml from 'sanitize-html';
import "dotenv/config";
import { ContentKind } from "./types";
import { normalizeTitleKey, parseRawTitle } from "./utils/titleNormalizer";

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
  anilist_id?: number | null;
  kitsu_id?: string | null;
  /** ID interno de TMDB cuando la metadata viene de allí. */
  tmdb_id?: number;
  /** Ruta relativa del póster TMDB (ej. "/abc.jpg"); sirve para armar URLs con otros tamaños. */
  poster_path?: string | null;
  /** Ruta relativa del backdrop TMDB. */
  backdrop_path?: string | null;
}

type TmdbIdentityMetadata = EnrichedMetadata & {
  /** Campos internos usados únicamente para escoger entre idiomas de búsqueda. */
  __tmdb_match_score?: number;
  __tmdb_year_exact?: boolean;
  __tmdb_language?: string;
  __tmdb_media_type?: string;
};

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
  // b) Etiquetas de audio al final del nombre (Japonés, redoblaje, etc.).
  // Quitarlas antes de detectar temporada/año evita búsquedas TMDB con ruido.
  title = title.replace(/\s+(?:japon[eé]s|japanese|redoblaje|doblaje|doblado|doblada)\s*$/i, " ");

  // c) Temporada (antes de cualquier otra limpieza): el primer patrón que
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

  // d) Año suelto (19xx/20xx únicamente; "Furiosos 9" o "1080p" nunca calzan)
  let year: number | null = null;
  const yearMatch = title.match(YEAR_PATTERN);
  if (yearMatch) {
    year = Number.parseInt(yearMatch[0], 10);
    title = title.replace(YEAR_PATTERN, " ");
  }

  // Limpieza de paréntesis/corchetes vaciados por las extracciones previas
  title = title.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ");

  // e) Limpieza clásica de query (prefijos, etiquetas, cortes de calidad/audio)
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

  // f) Normalización final + fallback si todo era ruido
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
  // TMDB TV agrupa estos géneros como una sola etiqueta; conservar la
  // etiqueta compuesta evita que el multiplexor los trate como categorías
  // distintas al fusionar obras entre proveedores.
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
    const parts = translated.split(',').map(p => p.trim());
    for (const p of parts) {
      if (!out.includes(p)) out.push(p);
    }
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

const ENGLISH_DESCRIPTION_WORDS = [
  "the", "and", "this", "with", "from", "their", "about", "when", "after",
  "story", "returns", "follows", "young", "must", "will", "into", "during",
  "through", "where", "which", "first", "life", "world", "series", "film", "movie",
];
const SPANISH_DESCRIPTION_WORDS = [
  "el", "la", "los", "las", "un", "una", "que", "de", "del", "en", "para", "con",
  "su", "sus", "historia", "cuando", "después", "despues", "sigue", "joven", "debe",
  "mundo", "vida", "película", "pelicula", "serie", "es", "por", "como", "una",
];

function wordHits(text: string, words: string[]): number {
  let hits = 0;
  for (const word of words) {
    if (new RegExp(`(?:^|[^\\p{L}])${word}(?:$|[^\\p{L}])`, "iu").test(text)) hits++;
  }
  return hits;
}

/** Detecta sinopsis que siguen principalmente en inglés u otro fallback no localizado. */
export function isLikelyNonSpanishDescription(description: string | null | undefined): boolean {
  const text = String(description ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // CJK, cirílico, árabe y otros alfabetos no latinos no son una sinopsis
  // española, aunque sean cortos y no contengan marcadores ingleses.
  if (/[^ -ɏḀ-ỿ -⁯\s\p{N}\p{P}]/u.test(text)) return true;
  if (text.length < 20) return false;
  const englishHits = wordHits(text, ENGLISH_DESCRIPTION_WORDS);
  const spanishHits = wordHits(text, SPANISH_DESCRIPTION_WORDS);
  // Exigir dos marcadores ingleses y ventaja clara en sinopsis largas evita
  // marcar nombres propios o títulos que contengan una sola palabra inglesa;
  // en sinopsis cortas basta una ventaja simple para no dejarlas sin reparar.
  return englishHits >= 2 && englishHits > spanishHits + (text.length >= 60 ? 1 : 0);
}

/**
 * Detecta texto que no puede considerarse una sinopsis española.  Es
 * deliberadamente conservador: nombres propios y títulos en inglés pueden
 * convivir con una descripción española, pero un bloque en japonés/chino,
 * cirílico o coreano nunca debe llegar a la ficha como si fuera castellano.
 */
function isForeignDescription(text: string): boolean {
  if (/[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f\s\p{N}\p{P}]/u.test(text)) return true;
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const englishHits = wordHits(normalized, ENGLISH_DESCRIPTION_WORDS);
  const spanishHits = wordHits(normalized, SPANISH_DESCRIPTION_WORDS);
  // La variante corta cubre sinopsis de 20–59 caracteres, que no alcanza el
  // umbral de isLikelyNonSpanishDescription pero sigue siendo claramente
  // inglesa (p.ej. "A young detective returns home").
  return isLikelyNonSpanishDescription(normalized)
    || (normalized.length >= 20 && englishHits >= 2 && englishHits > spanishHits);
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
  const add = (value: string) => {
    const c = tidy(value);
    if (c && c.length >= 2 && !out.some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  };
  for (const c of [rawParsed.canonical, legacy.baseTitle]) {
    add(c);
    // Los especiales/OVAs suelen compartir identidad con la serie base en
    // TMDB y con frecuencia no tienen ficha propia. Mantener también la
    // variante completa permite elegir la ficha específica cuando existe.
    add(c.replace(/\s+(?:especial(?:es)?|specials?|ovas?)\s*$/i, ""));
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
// La reparación y la fusión suelen consultar la misma identidad desde varias
// fuentes (especialmente cuando una obra aparece en más de un proveedor).
// Guardar solo las resoluciones positivas reduce llamadas repetidas a TMDB sin
// fijar fallos transitorios: un no-match o un 429 siempre puede reintentarse.
const tmdbIdentityCache = new Map<string, TmdbIdentityMetadata>();

// TMDB no publica un límite fijo garantizado: su documentación sitúa el tope
// habitual alrededor de 40 req/s y puede responder 429 antes o después según
// la carga. Mantener una ventana deslizante por proceso evita ráfagas, incluso
// cuando backfill/verification ejecutan muchos workers al mismo tiempo.
const TMDB_DEFAULT_MAX_RPS = 35;
const TMDB_HARD_MAX_RPS = 40;
const tmdbRequestTimes: number[] = [];

function titleWordSet(value: unknown): Set<string> {
  const text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return new Set(text.match(/[a-z0-9\u3040-\u30ff\u3400-\u9fff]+/gu) || []);
}

function getTmdbMaxRps(): number {
  const configured = Number(process.env.TMDB_MAX_RPS);
  if (!Number.isFinite(configured)) return TMDB_DEFAULT_MAX_RPS;
  return Math.min(TMDB_HARD_MAX_RPS, Math.max(1, Math.floor(configured)));
}

async function acquireTmdbRequestSlot(): Promise<void> {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const maxRps = getTmdbMaxRps();
  while (true) {
    const now = Date.now();
    while (tmdbRequestTimes.length > 0 && now - tmdbRequestTimes[0] >= 1000) {
      tmdbRequestTimes.shift();
    }
    if (tmdbRequestTimes.length < maxRps) {
      tmdbRequestTimes.push(now);
      return;
    }
    await wait(Math.max(5, tmdbRequestTimes[0] + 1000 - now));
  }
}

/** Limpia caches internas del engine (uso exclusivo de tests). */
export function __resetEngineCaches(): void {
  tmdbGenreCache.clear();
  tmdbIdentityCache.clear();
  tmdbRequestTimes.length = 0;
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

    await acquireTmdbRequestSlot();
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

    await acquireTmdbRequestSlot();
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
  yearHint?: number | null,
  identityOnly = false,
  language = "es-MX",
): Promise<EnrichedMetadata | null> {
  const identityCacheKey = identityOnly
    ? [String(query).trim().toLowerCase(), kind || "", seasonHint ?? "", yearHint ?? "", language].join("\u0000")
    : null;
  if (identityCacheKey) {
    const cachedIdentity = tmdbIdentityCache.get(identityCacheKey);
    if (cachedIdentity) return cachedIdentity;
  }
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    await acquireTmdbRequestSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    // Use multi search to get movies or tv shows
    const res = await fetch(`https://api.themoviedb.org/3/search/multi?query=${encodeURIComponent(query)}&language=${language}&api_key=${apiKey}`, { // NOSONAR
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
        } else if (kind === "series") {
          candidates = candidates.filter((r: any) => r.media_type === "tv");
        } else if (kind === "anime") {
          // Anime también incluye películas, OVAs y especiales. Filtrar a TV
          // dejaba sin ID obras válidas como Your Name o Maison Ikkoku.
          candidates = candidates.filter((r: any) => r.media_type === "tv" || r.media_type === "movie");
        }
        // TMDB devuelve resultados globales ordenados por popularidad. Tomar
        // siempre el primero asigna IDs equivocados cuando el catálogo trae
        // títulos de temporada, traducciones o nombres muy parecidos. Se
        // puntúa el título (incluyendo original/name) y el año antes de elegir.
        const queryKey = normalizeTitleKey(query);
        // normalizeTitleKey es una clave compacta (sin espacios), por lo que
        // usarla para tokenizar convertía cada título en una sola palabra y
        // anulaba coincidencias parciales como "Bucky Larson". Las claves
        // siguen sirviendo para exact/substr; el solapamiento usa palabras.
        const queryTokens = titleWordSet(query);
        const isAnimeCandidate = (candidate: any): boolean => {
          if (kind !== "anime") return false;
          return Boolean(
            (Array.isArray(candidate?.genre_ids) && candidate.genre_ids.includes(16)) ||
            candidate?.original_language === "ja" ||
            (Array.isArray(candidate?.origin_country) && candidate.origin_country.includes("JP")),
          );
        };
        const candidateScore = (candidate: any): number => {
          const names = [candidate?.title, candidate?.name, candidate?.original_title, candidate?.original_name]
            .filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
          let score = 0;
          for (const rawName of names) {
            const name = normalizeTitleKey(rawName);
            if (!name || !queryKey) continue;
            if (name === queryKey) score = Math.max(score, 1);
            else if (name.includes(queryKey) || queryKey.includes(name)) score = Math.max(score, 0.82);
            else {
              const nameTokens = titleWordSet(rawName);
              let overlap = 0;
              for (const token of queryTokens) if (nameTokens.has(token)) overlap++;
              const union = new Set([...queryTokens, ...nameTokens]).size;
              score = Math.max(score, union > 0 ? overlap / union : 0);
            }
          }
          const textualScore = score;
          const resultYear = Number.parseInt(String(candidate?.release_date || candidate?.first_air_date || "").slice(0, 4), 10);
          // El año solo desambigua candidatos con una coincidencia textual
          // mínima; nunca convierte una obra ajena del mismo año en un match.
          if (textualScore >= 0.15 && yearHint && resultYear === yearHint) score += 0.25;
          else if (textualScore >= 0.15 && yearHint && Number.isFinite(resultYear) && Math.abs(resultYear - yearHint) > 1) {
            // Un resultado parecido pero de otro año suele ser una secuela,
            // especial o película distinta. Penalizarlo con la distancia
            // real evita que gane sólo por popularidad.
            score -= Math.min(0.65, 0.2 + (Math.abs(resultYear - yearHint) - 1) * 0.08);
          }
          // Un título traducido puede no compartir ninguna palabra con TMDB
          // (p.ej. "Kimi no Na wa" → "Your Name."). En anime exigimos año
          // exacto y una pista estructural de anime para aceptar ese caso.
          if (textualScore < 0.15 && kind === "anime" && yearHint && resultYear === yearHint && isAnimeCandidate(candidate)) {
            score = Math.max(score, 0.18);
          }
          if (
            kind === "anime" && seasonHint != null && candidate?.media_type === "movie" &&
            !/\b(?:movie|pel[ií]cula|film)\b/i.test(query)
          ) {
            // Una etiqueta de temporada/especial normalmente apunta a la serie
            // base; no dejar que una película popular de la franquicia gane
            // sólo por compartir el nombre.
            score -= 0.3;
          }
          // Popularity desempata únicamente candidatos igualmente relevantes.
          score += Math.min(0.03, Number(candidate?.popularity || 0) / 10000);
          return score;
        };
        const rankedCandidates = candidates
          .map((candidate: any, index: number) => ({ candidate, index, score: candidateScore(candidate) }))
          .sort((a: any, b: any) => b.score - a.score || a.index - b.index);
        let bestResult = rankedCandidates[0]?.candidate;
        // Un resultado sin ninguna coincidencia textual es peor que no asignar
        // identidad: el pipeline podrá continuar con AniList/Jikan/TVMaze.
        if (rankedCandidates[0] && rankedCandidates[0].score < 0.15) bestResult = undefined;
        // Desambiguación por año del título parseado (ej. "Coco 2017")
        if (yearHint != null && Array.isArray(candidates)) {
          const yearMatch = rankedCandidates.find(({ candidate, score }: { candidate: any; score: number }) => {
            if (score < 0.15) return false;
            const r = candidate;
            const y = Number.parseInt(String(r.release_date || r.first_air_date || "").substring(0, 4), 10);
            return y === yearHint;
          })?.candidate;
          if (yearMatch) bestResult = yearMatch;
        }

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
            // La reparación masiva de identidad solo necesita el ID. Evitar aquí
            // la segunda búsqueda en inglés, traducciones y consulta de géneros
            // reduce cada resolución a una sola búsqueda TMDB sin cambiar el
            // algoritmo de selección textual/año.
            if (identityOnly) {
              const identityYearRaw = bestResult.release_date || bestResult.first_air_date || "";
              const identityYear = identityYearRaw ? Number.parseInt(identityYearRaw.substring(0, 4), 10) : 0;
              const identityResult = {
                title: bestResult.title || bestResult.name || query,
                original_title: bestResult.original_title || bestResult.original_name || null,
                description: "",
                poster_url: null,
                banner_url: null,
                rating: 0,
                year: Number.isFinite(identityYear) ? identityYear : 0,
                status: "",
                genres: [],
                content_type: kind || (bestResult.media_type === "tv" ? "series" : "movie"),
                tmdb_id: Number(bestResult.id),
                __tmdb_match_score: rankedCandidates.find((entry: { candidate: any; score: number }) => entry.candidate === bestResult)?.score || 0,
                __tmdb_year_exact: Boolean(yearHint && Number.parseInt(String(bestResult.release_date || bestResult.first_air_date || "").slice(0, 4), 10) === yearHint),
                __tmdb_language: language,
                __tmdb_media_type: bestResult.media_type,
              } as TmdbIdentityMetadata;
              if (identityCacheKey) tmdbIdentityCache.set(identityCacheKey, identityResult);
              return identityResult;
            }
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
              genres = bestResult.genre_ids.map((gid: number) => genreMap.get(gid)).filter((g: string | undefined): g is string => Boolean(g));
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
 * Resolución ligera de identidad para migraciones masivas.
 *
 * Devuelve únicamente el ID TMDB y evita traducciones, géneros y búsquedas
 * secundarias. El matching textual/año es exactamente el mismo que usa el
 * enriquecimiento completo; la metadata visible se completa después en el
 * backfill dedicado.
 */
export async function resolveTmdbIdentity(
  rawQuery: string,
  hintKind?: ContentKind,
): Promise<number | null> {
  const parsed = parseTitleQuery(rawQuery);
  const candidates = buildSearchCandidates(rawQuery);
  let best: { id: number; score: number; yearExact: boolean; language: string; mediaType: string } | null = null;
  for (const candidate of candidates) {
    // Buscar en español para conservar el comportamiento visible y en inglés
    // para descubrir títulos alternos que TMDB no localiza en es-MX. Elegimos
    // el mejor score entre ambos, no el primer resultado popular.
    for (const language of ["es-MX", "en-US"]) {
      const result = await fetchTMDBMetadata(candidate, hintKind, parsed.season, parsed.year, true, language) as TmdbIdentityMetadata | null;
      const id = Number(result?.tmdb_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const score = Number(result?.__tmdb_match_score || 0);
      const yearExact = Boolean(result?.__tmdb_year_exact);
      const mediaType = String(result?.__tmdb_media_type || "");
      if (
        !best ||
        (parsed.year && yearExact !== best.yearExact ? yearExact : false) ||
        (!parsed.year || yearExact === best.yearExact) && (
          score > best.score ||
          (score === best.score && language === "en-US" && best.language !== "en-US")
        )
      ) {
        best = { id, score, yearExact, language, mediaType };
      }
      // Un match textual exacto y con año correcto no necesita una segunda
      // consulta de idioma para esa misma variante.
      if (score >= 1 && (!parsed.year || yearExact)) break;
    }
    // El año de un catálogo puede ser el de una temporada, redoblaje o
    // re-publicación y no el de TMDB. Si la búsqueda fechada no dio una
    // coincidencia sólida, repetir sin año permite rescatar el título base;
    // el desempate por idioma/alias sigue evitando aceptar un resultado ajeno.
    if (parsed.year && (!best || best.score < 0.25)) {
      for (const language of ["es-MX", "en-US"]) {
        const result = await fetchTMDBMetadata(candidate, hintKind, parsed.season, null, true, language) as TmdbIdentityMetadata | null;
        const id = Number(result?.tmdb_id);
        if (!Number.isInteger(id) || id <= 0) continue;
        const score = Number(result?.__tmdb_match_score || 0);
        const yearExact = Boolean(result?.__tmdb_year_exact);
        const mediaType = String(result?.__tmdb_media_type || "");
        if (
          !best ||
          (parsed.year && yearExact !== best.yearExact ? yearExact : false) ||
          (!parsed.year || yearExact === best.yearExact) && score > best.score
        ) {
          best = { id, score, yearExact, language, mediaType };
        }
        if (score >= 1) break;
      }
    }
  }
  // Si TMDB no reconoce el alias del scraper, AniList aporta títulos romaji,
  // ingleses y nativos que sí sirven para una segunda búsqueda TMDB. Sólo se
  // usa como puente de identidad: el año, cuando existe, debe ser cercano.
  const hasAnimeSpecialMarker = /(?:ova|especial|special|pel[ií]cula|movie|film)/i.test(parsed.baseTitle);
  if (hintKind === "anime" && (!best || best.score < 0.25 || (best.mediaType === "movie" && !hasAnimeSpecialMarker))) {
    try {
      const animeMeta = await fetchAnimeMetadata(parsed.baseTitle, true);
      const animeYear = Number(animeMeta?.year || 0);
      if (animeMeta) {
        // Los scrapers a menudo guardan el año de importación o el año de una
        // temporada en vez del estreno de la obra. Si AniList devuelve un
        // alias sólido, no descartarlo por esa pista temporal; sólo dejamos
        // de usar el año como desempate cuando difiere demasiado.
        const fallbackYear = parsed.year && animeYear && Math.abs(animeYear - parsed.year) <= 1
          ? parsed.year
          : null;
        const aliases = [animeMeta.title, animeMeta.english_title, animeMeta.original_title, animeMeta.japanese_title]
          .map((value) => String(value || "").trim())
          .filter((value, index, values) => value && values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index);
        for (const alias of aliases) {
          for (const language of ["en-US", "es-MX"]) {
            const result = await fetchTMDBMetadata(alias, hintKind, parsed.season, fallbackYear, true, language) as TmdbIdentityMetadata | null;
            const id = Number(result?.tmdb_id);
            if (!Number.isInteger(id) || id <= 0) continue;
            const score = Number(result?.__tmdb_match_score || 0);
            const yearExact = Boolean(result?.__tmdb_year_exact);
            const mediaType = String(result?.__tmdb_media_type || "");
            if (
              !best ||
              (parsed.year && yearExact !== best.yearExact ? yearExact : false) ||
              (!parsed.year || yearExact === best.yearExact) && score > best.score
            ) {
              best = { id, score, yearExact, language, mediaType };
            }
            if (score >= 1 && (!parsed.year || yearExact)) break;
          }
          if (best?.score && best.score >= 1 && (!parsed.year || best.yearExact)) break;
        }
      }
    } catch {
      // AniList es una ruta de rescate; un fallo no invalida el resultado TMDB.
    }
  }
  return best?.id ?? null;
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
async function fillWeakDescription(meta: EnrichedMetadata, kindHint: string | undefined, query: string): Promise<EnrichedMetadata> {
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
  // Solo una pista explícita de anime debe activar la validación cruzada con
  // AniList/Jikan. Una serie de TV normal sin género "Animación" no es un
  // match sospechoso: antes este chequeo convertía series como "Trying" en
  // cualquier anime que devolviera el buscador secundario.
  if (tmdbData && hintKind === "anime" && isSuspiciousAnimeMatch(tmdbData)) {
    const animeMeta = await fetchAnimeMetadata(cleaned);
    if (animeMeta) {
      // AniList/Jikan mejora la metadata anime, pero no debe borrar una
      // identidad TMDB ya confirmada (especialmente en clásicos anteriores a
      // 1995, que el filtro de seguridad marca como sospechosos).
      return {
        ...tmdbData,
        ...animeMeta,
        tmdb_id: tmdbData.tmdb_id || animeMeta.tmdb_id,
        poster_path: tmdbData.poster_path || animeMeta.poster_path,
        backdrop_path: tmdbData.backdrop_path || animeMeta.backdrop_path,
      };
    }
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
async function fetchAnimeMetadata(query: string, identityOnly = false): Promise<EnrichedMetadata | null> {
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
          idMal
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
        const cleanDesc = identityOnly ? "" : await cleanAndTranslateDescription(media.description || "");

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
          anilist_id: media.id != null ? Number(media.id) : null,
          mal_id: media.idMal ?? null,
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
      const json = await res.json() as { data?: Array<{ id?: string | number; attributes?: Record<string, any> }> };
      if (Array.isArray(json.data) && json.data.length > 0) {
        const resource = json.data[0];
        const attr = resource?.attributes || {};
        const poster = attr.posterImage?.large || attr.posterImage?.original || attr.posterImage?.medium;
        const cover = attr.coverImage?.large || attr.coverImage?.original || poster;

        return {
          title: attr.canonicalTitle || query,
          original_title: attr.titles?.ja_jp,
          japanese_title: attr.titles?.ja_jp || undefined,
          english_title: attr.titles?.en || undefined,
          description: identityOnly ? "" : await cleanAndTranslateDescription(attr.synopsis || ""),
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((Number.parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? Number.parseInt(attr.startDate.slice(0, 4), 10) : 0,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
          kitsu_id: resource?.id != null ? String(resource.id) : null,
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
          description: identityOnly ? "" : await cleanAndTranslateDescription(item.synopsis || ""),
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

  // TMDB y los scrapers ya entregan la mayoría de sinopsis en es-MX. Evitar
  // llamar a dos traductores por cada ficha reduce mucho el coste en un
  // servidor pequeño y, sobre todo, evita que una traducción automática
  // degrade un texto español correcto.
  const sourceLooksForeign = isForeignDescription(cleaned);
  if (!sourceLooksForeign) return cleaned;

  const source = cleaned.substring(0, 1500);
  const usableTranslation = (candidate: string | null): string | null => {
    const value = (candidate || "").replace(/\s+/g, " ").trim();
    if (!value) return null;
    // Los tests y algunos proxies anteponen una marca explícita `[ES]`; no
    // confundir esa marca con una sinopsis inglesa. El resto de candidatos sí
    // pasa el filtro para impedir que un traductor devuelva silenciosamente el
    // texto original en inglés por un rate-limit.
    const explicitSpanishMarker = /^\[(?:es|es-mx|es-es)\]\s/i.test(value);
    if (!explicitSpanishMarker && isForeignDescription(value)) return null;
    return value;
  };

  // Intento 1: Google; intento 2: Google tras breve espera (429 rate-limit);
  // intento 3: MyMemory. Nunca devolvemos un bloque extranjero si todos los
  // proveedores están temporalmente limitados: la ficha queda en español y
  // podrá rellenarse en la próxima pasada de metadatos.
  const google1 = await tryGoogleTranslate(source);
  const translated1 = usableTranslation(google1);
  if (translated1) return translated1;
  await new Promise((r) => setTimeout(r, 400));
  const google2 = await tryGoogleTranslate(source);
  const translated2 = usableTranslation(google2);
  if (translated2) return translated2;
  const fallback = await tryMyMemoryTranslate(source);
  const translatedFallback = usableTranslation(fallback);
  if (translatedFallback) return translatedFallback;
  return "Descripción en español no disponible temporalmente.";
}
