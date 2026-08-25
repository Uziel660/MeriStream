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
  language: 'latino' | 'castellano' | 'subtitulado' | null;
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
  'ver', 'veronline', 'online', 'gratis', 'completa', 'completo', 'pelicula',
  'peliculas', 'serie', 'series', 'capitulo', 'episodio', 'temporada',
  'latino', 'latinos', 'castellano', 'espanol', 'español', 'spanish',
  'subtitulado', 'subtitulada', 'sub', 'subs', 'vod',
  'hd', 'hq', 'hdr', '4k', 'uhd', 'fhd', 'fullhd', 'bluray', 'brrip',
  'dvdrip', 'webrip', 'webdl', 'x264', 'x265', 'hevc', 'h264',
  '1080p', '720p', '480p', '2160p', '1080', '720', '480', '2160',
  'mega', 'cuevana', 'cinecalidad', 'animeflv', 'tioanime', 'jkanime',
  'latanime', 'zonaleros', 'danime', 'monoschinos', 'animeyabu',
  'descargar', 'descarga', 'download', 'estreno', 'estrenos', 'audio',
]);

/**
 * Tokens ESTRUCTURALES de ruido: al aparecer en cola, todo lo que viene después
 * se descarta (números de episodio tras "Capitulo", años de re-publicación tras
 * "Online", etc.). Los marcadores de idioma/calidad NO cortan: solo se saltan.
 */
const STRUCTURAL_CUT_TOKENS = new Set([
  'ver', 'online', 'gratis', 'completa', 'completo',
  'capitulo', 'episodio', 'temporada',
  'descargar', 'descarga', 'download',
]);

/** Prefijos de query que los scrapers anteponen ("Ver Dandelion...", "Serie Friends"). */
const PREFIX_NOISE_RE =
  /^(?:ver\s+online(?:\s+gratis)?|ver|watch|pelicula|película|serie|anime|ova|donghua|full\s+movie|episodios\s+de)\s+/i;

/** Formas multi-palabra que deben colapsar a un solo token de calidad. */
const MULTIWORD_QUALITY_RES: Array<[RegExp, string]> = [
  [/\bfull\s*hd\b/gi, ' fullhd '],
  [/\b(blue|blu)\s*ray\b/gi, ' bluray '],
  [/\bweb\s*(dl|rip)\b/gi, ' web$1 '],
];

// ── Detección de temporada ─────────────────────────────────────────
// Formatos reales de scrapers/animes: "Jujutsu Kaisen 2nd Season",
// "Second Season", "Season 2", "Temporada 2", "Part 2"/"Part II",
// "S2"/"S02" como token suelto, romanos finales ("Shingeki II") y el
// marcador sin número "Final Season". Orden: lo numerado primero (gana);
// "Final Season" al final porque no aporta número, solo se reconoce.

/** Palabras ordinales inglesas → número de temporada. */
const WORD_SEASON_NUMS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
};

/** Romanos multi-carácter → número. Los de 1 carácter se excluyen para no
 *  tragarse títulos legítimos ("Mister X", "V"). */
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
    re: new RegExp(`\\b(${Object.keys(WORD_SEASON_NUMS).join('|')})\\s+season\\b`, 'i'),
    resolve: (m) => WORD_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  { re: /\bseason\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  // "S2"/"S02" SOLO como token independiente: \b a ambos lados evita "Boss 2",
  // "PS2" o "ms2" (sin frontera interna palabra/dígito).
  { re: /\bs(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  { re: /\bpart\s*-?\s*(\d{1,2})\b/i, resolve: (m) => Number(m[1]) },
  {
    re: /\bpart\s+(ii|iii|iv|vi|vii|viii|ix|xi|xii)\b/i,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  // Romano final en MAYÚSCULAS tras espacio y con frontera propia: "Rocky II",
  // "Final Fantasy VII" sí; "SIX"/"MIX" no (la \b falla dentro de la palabra).
  {
    re: /(?:^|\s)(II|III|IV|VI|VII|VIII|IX|XI|XII)$/,
    resolve: (m) => ROMAN_SEASON_NUMS[m[1].toLowerCase()] ?? null,
  },
  // Marcador sin número: se reconoce pero no asigna temporada.
  { re: /\bfinal\s+season\b/i, resolve: () => null },
];

/** Primer marcador de temporada presente en el texto (sin modificarlo). */
function detectSeasonMarker(text: string): number | null {
  for (const marker of SEASON_MARKERS) {
    const m = text.match(marker.re);
    if (m) return marker.resolve(m);
  }
  return null;
}

// ── Guard anti-basura (FIX "obra con título pe") ────────────────────
// Títulos cortos reales que NO deben marcarse como absurdos pese a ≤2 caracteres.
const KNOWN_SHORT_TITLES = new Set(['up', 'it', 'x', 'us', 'we', 'ox', 'yo']);

/**
 * true si `title` tiene forma de título real; false si es basura detectada:
 * - URLs pegadas como título (fuga de debug/test);
 * - fuga de UI: empieza por "Género"/"Genero" o contiene "Género:";
 * - artículo/preposición suelta ("Un", "Una", "Del"): resto truncado de un título;
 * - ≤2 letras efectivas que o no tienen vocal ("tk") o empiezan en minúscula
 *   suelta ("pe"), salvo títulos conocidos ("Up", "It", "X"...).
 * Los títulos puramente numéricos cortos ("9", "21") son legítimos.
 */
const JUNK_STANDALONE_WORDS = new Set(['un', 'una', 'de', 'del', 'y', 'o']);

export function isPlausibleTitle(title: string | null | undefined): boolean {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (/^g[eé]nero\b/i.test(t)) return false;
  if (/g[eé]nero\s*:/i.test(t)) return false;
  if (JUNK_STANDALONE_WORDS.has(t.toLowerCase())) return false;

  const compact = t.replace(/[^a-zA-Z0-9]/g, '');
  if (!compact) return false;
  const isShort = compact.length <= 2;
  const isNumeric = /^\d+$/.test(compact);
  // El whitelist solo vale con mayúscula inicial ("X" sí, "x" es basura).
  const knownShort =
    /^[A-ZÁÉÍÓÚÑ]/.test(t) && KNOWN_SHORT_TITLES.has(t.toLowerCase());
  if (isShort && !isNumeric && !knownShort) {
    const hasVowel = /[aeiouáéíóúü]/i.test(compact);
    // "pe": minúscula suelta; "Tk": sin vocal. Ambos son basura.
    if (!hasVowel || /^[a-zá-ú]/.test(t)) return false;
  }
  return true;
}

/** Año suelto de 4 dígitos razonable (1900–2099). */
const YEAR_TOKEN_RE = /\b(?:19|20)\d{2}\b/g;

/** Elimina SOLO la última aparición de un año suelto y limpia espacios sobrantes. */
function withoutLastYear(text: string): string | null {
  const re = new RegExp(YEAR_TOKEN_RE.source, 'g');
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  return (text.slice(0, last.index) + ' ' + text.slice(last.index + last[0].length))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minúsculas + sin acentos + solo [a-z0-9]. Núcleo de comparación de tokens/claves. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Parsea un título crudo de cualquier scraper y separa el nombre base del ruido.
 * Conservador: si el recorte dejara el título vacío, devuelve el original limpio.
 *
 * Ejemplos:
 *   "Toy Story 5 Latino Español HD"   → { canonical: "Toy Story 5", language: "latino", quality: "hd" }
 *   "La Bestia 2026 Ver"              → { canonical: "La Bestia", year: 2026 }
 *   "Ver Dandelion Online Gratis Sub Español" → { canonical: "Dandelion", language: "subtitulado" }
 *   "Jujutsu Kaisen 2nd Season"       → intacto (ninguno de sus tokens es ruido)
 *   "Up"                              → intacto (títulos cortos nunca se vacían)
 */
export function parseRawTitle(raw: string): ParsedRawTitle {
  const original = String(raw ?? '').replace(/\s+/g, ' ').trim();

  let text = original;
  for (const [re, replacement] of MULTIWORD_QUALITY_RES) {
    text = text.replace(re, replacement);
  }
  text = text
    .replace(/[_]+/g, ' ')                       // slugs "Toy_Story_5_Latino"
    .replace(/\((19|20)\d{2}\)/g, (m) => m.replace(/[()]/g, '')) // conserva año entre paréntesis como token
    .trim();

  // Prefijos repetidos: "Ver Online Coco" → "Coco".
  let previous: string;
  do {
    previous = text;
    text = text.replace(PREFIX_NOISE_RE, '').trim();
  } while (text !== previous);

  text = text.replace(/[:\-–—|]\s*$/g, '').trim();

  // ── Temporada ───────────────────────────────────────────────────
  // SOLO se detecta (no se recorta): el canonical conserva el sufijo para que
  // el título visible y las claves completas no pierdan identidad; la separación
  // base/temporada es trabajo de metadataEngine.parseTitleQuery.
  const season = detectSeasonMarker(text);

  // ── Año ─────────────────────────────────────────────────────────
  // Se extraen años sueltos DE COLA hacia adelante (el de paréntesis suele ser
  // el estreno real: "1917 (2019)" → year 2019, canonical "1917"). Si extraer
  // un año dejara el título vacío (película "2012", "1917"), ese año se
  // conserva en el nombre y el bucle termina.
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

  // ── Clasificación token a token ─────────────────────────────────
  const kept: string[] = [];
  let sawLatino = false;
  let sawCastellano = false;
  let sawSubs = false;
  let quality: string | null = null;
  let cut = false;

  const tokens = text.split(' ');
  for (const token of tokens) {
    const norm = slugify(token);
    if (!norm) continue;
    if (NOISE_TOKENS.has(norm)) {
      // Los marcadores de idioma/calidad se registran aunque vengan tras el corte.
      if (norm === 'latino' || norm === 'latinos') sawLatino = true;
      else if (norm === 'castellano' || norm === 'espanol' || norm === 'español') sawCastellano = true;
      else if (norm === 'subtitulado' || norm === 'subtitulada' || norm === 'sub' || norm === 'subs') sawSubs = true;
      else if (/^(hd|hdr|4k|uhd|fhd|fullhd|1080p|720p|480p|2160p)$/.test(norm)) quality = norm;
      if (STRUCTURAL_CUT_TOKENS.has(norm)) cut = true;
      continue;
    }
    if (!cut) kept.push(token);
  }

  // Precedencia de idioma: subtítulos > latino > castellano. "Sub Español" es
  // subtitulado (no castellano) y "Latino Español" es latino.
  const language: ParsedRawTitle['language'] = sawSubs
    ? 'subtitulado'
    : sawLatino
      ? 'latino'
      : sawCastellano
        ? 'castellano'
        : null;

  let canonical = kept.join(' ')
    .replace(/\s*[,\-–—:|]+\s*$/g, '')
    .replace(/^["'“”]+|["'”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Caso degenerado: si el recorte dejó algo vacío, devolver el original limpio básico
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
