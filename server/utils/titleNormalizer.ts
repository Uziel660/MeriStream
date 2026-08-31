// server/utils/titleNormalizer.ts
// ══════════════════════════════════════════════════════════════════
// Normalización de títulos crudos de scrapers para (a) búsqueda TMDB/Jikan
// precisa y (b) deduplicación de obras en catálogo.
//
// Problema que resuelve: títulos tipo "Toy Story 5 Latino Español HD",
// "La Bestia 2026 Ver", "Ver Dandelion Online Gratis Sub Español" llegan
// con ruido que rompe la resolución de metadatos y genera obras duplicadas.
//
// CONTRATO compartido por: showService (dedup), metadataEngine (búsqueda).
// Ambas funciones son PURAS e idempotentes sobre títulos ya limpios.
// ══════════════════════════════════════════════════════════════════

export interface ParsedRawTitle {
  /** Título base sin ruido, listo para buscar en TMDB/Jikan y para mostrar. */
  canonical: string;
  /** Año detectado en el título crudo (si estaba presente y no colisionaba con el nombre). */
  year: number | null;
  /**
   * Temporada detectada en el título crudo ("2nd Season", "Temporada 2",
   * "Part II", "S02", romanos finales...). SOLO se detecta: el canonical la
   * conserva para que el título visible no pierda identidad; la separación
   * base/temporada la hace metadataEngine.parseTitleQuery.
   */
  season: number | null;
  /** Pista de idioma/audio detectada. */
  language: "latino" | "castellano" | "subtitulado" | null;
  /** Pista de calidad detectada (hd, 4k, 1080p...). */
  quality: string | null;
  /**
   * false si el canonical resultante es absurdo (fuga de UI tipo "Género: Pe...",
   * basura de ≤2 caracteres sin forma de título). El guardado decide si descarta;
   * ver isPlausibleTitle().
   */
  plausible: boolean;
}

/** Tokens de ruido (completos tras normalizar a minúsculas/sin acentos/símbolos). */
const NOISE_TOKENS = new Set([
  "ver", "veronline", "online", "gratis", "completa", "completo", "pelicula",
  "peliculas", "serie", "series", "capitulo", "episodio", "temporada",
  "latino", "latinos", "castellano", "espanol", "español", "spanish",
  "subtitulado", "subtitulada", "sub", "subs", "vod",
  "hd", "hq", "hdr", "4k", "uhd", "fhd", "fullhd", "bluray", "brrip",
  "dvdrip", "webrip", "webdl", "x264", "x265", "hevc", "h264",
  "1080p", "720p", "480p", "2160p", "1080", "720", "480", "2160",
  "mega", "cuevana", "cinecalidad", "animeflv", "tioanime", "jkanime",
  "latanime", "zonaleros", "danime", "monoschinos", "animeyabu",
  "descargar", "descarga", "download", "estreno", "estrenos", "audio",
]);

/**
 * Tokens ESTRUCTURALES de ruido: al aparecer en cola, todo lo que viene después
 * se descarta (números de episodio tras "Capitulo", años de re-publicación tras
 * "Online", etc.). Los marcadores de idioma/calidad NO cortan: solo se saltan.
 */
const STRUCTURAL_CUT_TOKENS = new Set([
  "ver", "online", "gratis", "completa", "completo",
  "capitulo", "episodio", "temporada",
  "descargar", "descarga", "download",
]);

/** Prefijos de query que los scrapers anteponen ("Ver Dandelion...", "Serie Friends"). */
const PREFIX_NOISE_RE =
  /^(?:ver\s+online(?:\s+gratis)?|ver|watch|pelicula|película|serie|anime|ova|donghua|full\s+movie|episodios\s+de)\s+/i;

/** Formas multi-palabra que deben colapsar a un solo token de calidad. */
const MULTIWORD_QUALITY_RES: Array<[RegExp, string]> = [
  [/\bfull\s*hd\b/gi, " fullhd "],
  [/\b(blue|blu)\s*ray\b/gi, " bluray "],
  [/\bweb\s*(dl|rip)\b/gi, " web$1 "],
];

// ── Detección de temporada ─────────────────────────────────────────

const WORD_SEASON_NUMS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

const ROMAN_SEASON_NUMS: Record<string, number> = {
  ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12,
};

interface SeasonMarker {
  re: RegExp;
  resolve: (m: RegExpMatchArray) => number | null;
}

const SEASON_MARKERS: SeasonMarker[] = [
  { re: /\btemporada\s*(?:n[uú]mero\s*)?-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  { re: /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i, resolve: (m) => Number(m[1]) },
  {
    re: new RegExp(`\\b(${Object.keys(WORD_SEASON_NUMS).join("|")})\\s+season\\b`, "i"),
    resolve: (m) => WORD_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bseason\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  { re: /\bs(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  { re: /\bpart\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  {
    re: /\bpart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/i,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  {
    re: /(?:^|\s)(II|III|IV|VI|VII|VIII|IX|XI|XII)$/,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bfinal\s+season\b/i, resolve: () => null },
];

function detectSeasonMarker(text: string): number | null {
  for (const marker of SEASON_MARKERS) {
    const m = text.match(marker.re);
    if (m) return marker.resolve(m);
  }
  return null;
}

// ── Guard anti-basura ──────────────────────────────────────────────

const KNOWN_SHORT_TITLES = new Set(["up", "it", "x", "us", "we", "ox", "yo"]);
const JUNK_STANDALONE_WORDS = new Set(["un", "una", "de", "del", "y", "o"]);
const SCRAPER_PLACEHOLDER_TITLES = new Set([
  "contenido cinecalidad",
  "contenido lamovie",
  "pelicula tubepelis",
  "anime tioanime",
  "anime latanime",
  "anime veranimes",
  "contenido no disponible veranimes",
]);

export function isPlausibleTitle(title: string | null | undefined): boolean {
  const t = String(title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/^g[eé]nero\b/i.test(t)) return false;
  if (/g[eé]nero\s*:/i.test(t)) return false;
  if (JUNK_STANDALONE_WORDS.has(t.toLowerCase())) return false;
  const normalizedWords = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (SCRAPER_PLACEHOLDER_TITLES.has(normalizedWords)) return false;

  const compact = t.replace(/[^a-zA-Z0-9]/g, "");
  if (!compact) return false;
  const isShort = compact.length <= 2;
  const isNumeric = /^\d+$/.test(compact);
  const knownShort =
    /^[A-ZÁÉÍÓÚÑ]/.test(t) && KNOWN_SHORT_TITLES.has(t.toLowerCase());
  if (isShort && !isNumeric && !knownShort) {
    const hasVowel = /[aeiouáéíóúü]/i.test(compact);
    if (!hasVowel || /^[a-zá-ú]/.test(t)) return false;
  }
  return true;
}

const YEAR_TOKEN_RE = /\b(?:19|20)\d{2}\b/g;

function withoutLastYear(text: string): string | null {
  const re = new RegExp(YEAR_TOKEN_RE.source, "g");
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  return (text.slice(0, last.index) + " " + text.slice(last.index + last[0].length))
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Parsea un título crudo de cualquier scraper y separa el nombre base del ruido.
 */
export function parseRawTitle(raw: string): ParsedRawTitle {
  const original = String(raw ?? "").replace(/\s+/g, " ").trim();

  let text = original;
  for (const [re, replacement] of MULTIWORD_QUALITY_RES) {
    text = text.replace(re, replacement);
  }
  text = text
    .replace(/[_]+/g, " ")
    .replace(/\((19|20)\d{2}\)/g, (m) => m.replace(/[()]/g, ""))
    .trim();

  let previous: string;
  do {
    previous = text;
    text = text.replace(PREFIX_NOISE_RE, "").trim();
  } while (text !== previous);

  text = text.replace(/[:\-–—|]\s*$/g, "").trim();

  const season = detectSeasonMarker(text);

  let year: number | null = null;
  for (let guard = 0; guard < 5; guard++) {
    const matches = text.match(YEAR_TOKEN_RE);
    if (!matches || matches.length === 0) break;
    const candidate = Number(matches[matches.length - 1]);
    const remainder = withoutLastYear(text);
    if (remainder === null || !slugify(remainder)) break;
    year = candidate;
    text = remainder;
  }

  const kept: string[] = [];
  let sawLatino = false;
  let sawCastellano = false;
  let sawSubs = false;
  let quality: string | null = null;
  let cut = false;

  const tokens = text.split(" ");
  for (const token of tokens) {
    const norm = slugify(token);
    if (!norm) continue;
    if (NOISE_TOKENS.has(norm)) {
      if (norm === "latino" || norm === "latinos") sawLatino = true;
      else if (norm === "castellano" || norm === "espanol" || norm === "español") sawCastellano = true;
      else if (norm === "subtitulado" || norm === "subtitulada" || norm === "sub" || norm === "subs") sawSubs = true;
      else if (/^(hd|hdr|4k|uhd|fhd|fullhd|1080p|720p|480p|2160p)$/.test(norm)) quality = norm;
      if (STRUCTURAL_CUT_TOKENS.has(norm)) cut = true;
      continue;
    }
    if (!cut) kept.push(token);
  }

  const language: ParsedRawTitle["language"] = sawSubs
    ? "subtitulado"
    : sawLatino
      ? "latino"
      : sawCastellano
        ? "castellano"
        : null;

  let canonical = kept.join(" ")
    .replace(/\s*[,\-–—:|]+\s*$/g, "")
    .replace(/^["'“”]+|["'”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!canonical) {
    canonical = original.trim();
  }

  return { canonical, year, season, language, quality, plausible: isPlausibleTitle(canonical) };
}

/**
 * Clave canónica de deduplicación: minúsculas, sin acentos ni puntuación,
 * sin tokens de ruido ni años. Dos scrapers que nombran la misma obra de
 * forma distinta deben producir LA MISMA clave:
 *   "Toy Story 5 Latino Español HD" y "Toy Story 5" → "toystory5".
 */
export function normalizeTitleKey(raw: string): string {
  const { canonical } = parseRawTitle(raw);
  return slugify(canonical);
}

/**
 * Detecta si un título es un slug de URL o texto con palabras pegadas sin formato.
 * Ejemplos: "sixjoursceprintempsla", "six-jours-ce-printemps-la", "ver-pelicula-completa-2024".
 */
export function isSlugLikeTitle(title?: string | null): boolean {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 3) return false;
  // Slug con guiones o guiones bajos
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(t)) return true;
  // Prefijos de URL de streaming
  if (/^(?:ver|pelicula|serie|anime|watch)[-_]/i.test(t)) return true;
  // Cadena pegada sin espacios, minúsculas puras de longitud >= 10 (ej: "sixjoursceprintempsla")
  if (/^[a-z0-9]{10,}$/.test(t) && !/[A-ZÁÉÍÓÚÑ\s]/.test(t)) return true;
  return false;
}

const SEGMENTATION_DICT = new Set([
  // Spanish articles, prepositions, pronouns
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "en", "para", "por", "con",
  "sin", "sobre", "a", "y", "o", "u", "e", "que", "se", "su", "sus", "mi", "mis", "tu", "tus", "lo", "le",
  "les", "me", "te", "nos", "os", "no", "si", "mas", "más", "pero", "como", "cuando", "donde", "quien",
  "quienes", "cual", "cuales", "este", "esta", "estos", "estas", "ese", "esa", "esos", "esas", "aquel", "aquella",
  // Common nouns & verbs in titles
  "temporada", "matar", "muerte", "muerto", "muerta", "vida", "amor", "corazon", "corazón", "alma", "almas",
  "testigo", "testigos", "ultimo", "último", "ultima", "última", "temple", "acero", "testamento", "testamentos",
  "hija", "hijas", "hijo", "hijos", "padre", "padres", "madre", "madres", "hermano", "hermanos", "hermana", "hermanas",
  "gilead", "primavera", "verano", "otono", "otoño", "invierno", "noche", "noches", "dia", "días", "dias",
  "mundo", "mundos", "tiempo", "tiempos", "hora", "horas", "hombre", "hombres", "mujer", "mujeres", "nino", "niño", "nina", "niña",
  "casa", "casas", "camino", "caminos", "calle", "calles", "ciudad", "ciudades", "pueblo", "pueblos", "bosque",
  "guerra", "guerras", "paz", "batalla", "batallas", "soldado", "soldados", "ejercito", "ejército", "rey", "reyes", "reina", "reinas",
  "viaje", "viajes", "secreto", "secretos", "historia", "historias", "sombra", "sombras", "oscuridad", "luz", "luces", "fuego",
  "sangre", "destino", "destinos", "ojo", "ojos", "fuerza", "poder", "poderes", "final", "principio", "silencio",
  "viento", "mar", "mares", "tierra", "tierras", "cielo", "cielos", "estrella", "estrellas", "sol", "luna",
  "amigo", "amigos", "amiga", "amigas", "enemigo", "enemigos", "isla", "islas", "castillo", "palacio", "rio", "río",
  "sueno", "sueño", "suenos", "sueños", "pesadilla", "pesadillas", "misterio", "misterios", "crimen", "crimenes", "crímenes",
  "asesino", "asesinos", "asesina", "policia", "policía", "detective", "detectives", "agente", "agentes",
  "doctor", "doctores", "profesor", "profesores", "maestro", "maestros", "escuela", "colegio", "hospital",
  "prision", "prisión", "carcel", "cárcel", "oro", "plata", "diamante", "diamantes", "tesoro", "tesoros",
  "perro", "perros", "gato", "gatos", "lobo", "lobos", "dragon", "dragón", "dragones", "monstruo", "monstruos",
  "demonio", "demonios", "fantasma", "fantasmas", "zombie", "zombies", "vampiro", "vampiros", "robot", "robots",
  "nave", "naves", "espacio", "planeta", "planetas", "galaxia", "universo", "primero", "primera", "segundo", "segunda",
  "tercero", "tercera", "cuarto", "cuarta", "quinto", "quinta", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez",
  "cien", "mil", "gran", "grande", "pequeno", "pequeño", "bueno", "malo", "nuevo", "nueva", "viejo", "vieja",
  "alto", "bajo", "negro", "negra", "blanco", "blanca", "rojo", "roja", "azul", "verde", "amarillo",
  "perdido", "perdida", "olvidado", "olvidada", "maldito", "maldita", "oculto", "oculta", "oscuro", "oscura",
  "eterno", "eterna", "infierno", "paraiso", "paraíso", "cazador", "cazadores", "venganza", "justicia", "ley",
  "escapar", "escape", "huida", "rescate", "salvar", "perder", "ganar", "vivir", "morir", "amar", "odiar",
  "buscar", "encontrar", "volver", "regreso", "caida", "caída", "ascenso", "origen", "nacimiento", "imperio",
  "reino", "trono", "corona", "espada", "magia", "mago", "bruja", "hechizo", "pacto", "promesa", "traicion", "traición",
  "culpa", "pecado", "miedo", "terror", "panico", "pánico", "peligro", "amenaza", "invasion", "invasión",
  "rebelion", "rebelión", "resistencia", "alianza", "legado", "cronicas", "crónicas", "memorias", "diario",
  // French words
  "six", "jours", "ce", "cette", "ces", "printemps", "ete", "été", "automne", "hiver", "nuit", "jour",
  "homme", "femme", "enfant", "fille", "garcon", "garçon", "fils", "pere", "père", "mere", "mère",
  "amour", "mort", "vie", "coeur", "cœur", "monde", "temps", "maison", "ville", "rue", "chemin",
  "deux", "trois", "quatre", "cinq", "sept", "huit", "neuf", "dix", "cent", "mille",
  "grand", "grande", "petit", "petite", "beau", "belle", "bon", "bonne", "mauvais", "noir", "blanc", "rouge",
  "bleu", "vert", "nouveau", "nouvelle", "vieux", "vieille", "premier", "premiere", "derniers", "dernier", "derniere",
  "plus", "moins", "sans", "avec", "pour", "dans", "sur", "sous", "par", "entre", "vers", "chez",
  "tout", "tous", "toute", "toutes", "rien", "autre", "autres", "meme", "même", "aussi", "bien", "mal",
  "diable", "dieu", "ange", "forts", "fort", "forte",
  // English words
  "the", "of", "and", "in", "to", "is", "that", "for", "it", "as", "was", "with", "on", "at", "by",
  "this", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my", "one", "all", "would",
  "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "when",
  "make", "can", "like", "time", "no", "just", "him", "know", "take", "people", "into", "year", "your",
  "good", "some", "could", "them", "see", "other", "than", "then", "now", "look", "only", "come", "its",
  "over", "think", "also", "back", "after", "use", "two", "how", "our", "work", "first", "well", "way",
  "even", "new", "want", "because", "any", "these", "give", "day", "most", "us", "night", "man", "woman",
  "child", "children", "love", "dead", "death", "die", "life", "live", "living", "black", "white", "red",
  "blue", "green", "dark", "light", "shadow", "blood", "fire", "ice", "water", "earth", "wind", "sky",
  "star", "stars", "moon", "sun", "space", "world", "lost", "last", "king", "queen", "lord", "god",
  "devil", "angel", "monster", "beast", "dragon", "house", "room", "city", "town", "street", "road",
  "hunt", "hunter", "fall", "rise", "game", "war", "battle", "fight", "killer", "secret", "secrets",
  "silent", "silence", "fear", "ghost", "horror", "nightmare", "dream", "dreams", "boy", "girl", "friend",
  "friends", "enemy", "enemies", "dog", "dogs", "cat", "cats", "wolf", "wolves", "forever", "never",
  "beyond", "under", "inside", "outside", "behind", "before", "truth", "lie", "lies", "mind", "heart",
  "soul", "souls", "hero", "heroes", "iron", "steel", "gold", "silver", "crown", "sword", "gun", "guns",
  // Expanded dictionary for DB squashed titles
  "huracanes", "maze", "runner", "prueba", "hombres", "entre", "abuela", "exterminio", "huesos", "ninera",
  "balas", "tintin", "sol", "testimonio", "anne", "lee", "temporal", "state", "siege", "temple", "attack",
  "indiana", "jones", "maldito", "rescate", "metro", "juventud", "siniestra", "bodas", "pokemon", "ranger",
  "crimen", "sr", "carrito", "caballeros", "templarios", "perdicion", "brujas", "actitud", "anos", "despues",
  "doce", "asterix", "shinmai", "maou", "no", "testament", "specials", "anime", "hibike", "euphonium",
  "ensemble", "contest", "hen", "baka", "shoukanjuu", "matsuri", "departures", "story", "moses",
  "protegido", "ova", "fastest", "finger", "notorious", "talker", "runs", "worlds", "greatest", "clan",
  "fate", "grand", "order", "singularidad", "gran", "salomon", "shoukanju", "unico"
]);

/**
 * Segmenta una cadena de palabras pegadas sin espacios (ej: "temporadaparamatar" -> "temporada para matar").
 */
export function splitConcatenatedWords(str: string): string {
  const s = str.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = s.length;
  if (n < 6) return str;

  const dp: number[] = new Array(n + 1).fill(Infinity);
  const prev: number[] = new Array(n + 1).fill(-1);
  dp[0] = 0;

  for (let i = 0; i < n; i++) {
    if (dp[i] === Infinity) continue;
    for (let j = i + 1; j <= n; j++) {
      const word = s.substring(i, j);
      if (SEGMENTATION_DICT.has(word)) {
        const cost = dp[i] + 1;
        if (cost < dp[j]) {
          dp[j] = cost;
          prev[j] = i;
        }
      }
    }
  }

  if (dp[n] !== Infinity) {
    const words: string[] = [];
    let curr = n;
    while (curr > 0) {
      const p = prev[curr];
      words.unshift(s.substring(p, curr));
      curr = p;
    }
    return words.join(" ");
  }

  return str;
}

/**
 * Convierte un slug tipo "six-jours-ce-printemps-la" o "temporadaparamatar" en palabras "Temporada Para Matar".
 */
export function cleanSlugToWords(slug: string): string {
  if (!slug) return "";
  let text = slug.replace(/[-_]+/g, " ").trim();
  if (!text.includes(" ") && text.length >= 8 && text.toLowerCase() === text) {
    const segmented = splitConcatenatedWords(text);
    if (segmented !== text) {
      text = segmented;
    }
  }
  return text
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .trim();
}
