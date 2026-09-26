/**
 * Detección ligera de idioma/rendición basada únicamente en metadata de la
 * fuente (título, URL, etiquetas y pistas ya declaradas). Nunca inspecciona
 * bytes de vídeo ni bloquea la reproducción.
 */

export interface LanguageDetectionInput {
  title?: unknown;
  url?: unknown;
  link_type?: unknown;
  language?: unknown;
  audio_language?: unknown;
  subtitle_language?: unknown;
  subtitles?: unknown;
}

export interface LanguageHints {
  language?: string;
  audio_language?: string;
  subtitle_language?: string;
}

/**
 * DoramasYT usa la etiqueta `sub-espanol` incluso en sus fichas dobladas.
 * La señal fiable está en el slug del episodio: `-latino-episodio-N` y
 * `-castellano-episodio-N` son pistas de audio dobladas, mientras que el
 * resto de episodios publicados con `sub-espanol` conservan el audio
 * original y llevan subtítulos en español.
 */
export function detectDoramasytLanguageHints(url: unknown): LanguageHints | undefined {
  const raw = clean(url);
  if (!raw) return undefined;
  let pathname = raw;
  let isDoramasyt = false;
  try {
    const parsed = new URL(raw);
    pathname = parsed.pathname;
    isDoramasyt = /(?:^|\.)doramasyt\.com$/i.test(parsed.hostname);
  } catch {
    // Mantener el valor original permite clasificar slugs parciales en tests
    // y en manifests antiguos.
    isDoramasyt = /^\/ver\//i.test(raw) || /^ver\//i.test(raw);
  }
  const path = pathname.toLowerCase();
  if (!isDoramasyt) return undefined;
  if (/-latino-episodio-\d+(?:[/?#]|$)/i.test(path)) {
    return { language: "dub", audio_language: "es-419" };
  }
  if (/-castellano-episodio-\d+(?:[/?#]|$)/i.test(path)) {
    return { language: "dub", audio_language: "es-ES" };
  }
  if (/\/ver\/[^/?#]+-episodio-\d+/i.test(path)) {
    return { language: "sub", subtitle_language: "es" };
  }
  return undefined;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  es: "es",
  spa: "es",
  esp: "es",
  spanish: "es",
  espanol: "es",
  castellano: "es-ES",
  "es-es": "es-ES",
  "spanish-spain": "es-ES",
  "spanish-es": "es-ES",
  espana: "es-ES",
  latino: "es-419",
  latina: "es-419",
  lat: "es-419",
  latam: "es-419",
  "latin-america": "es-419",
  "latin-american": "es-419",
  "es-la": "es-419",
  "es-latam": "es-419",
  "es-419": "es-419",
  ea: "es-419",
  "spanish-latam": "es-419",
  "spanish-latin-america": "es-419",

  ca: "ca",
  cat: "ca",
  catalan: "ca",
  catala: "ca",
  "catalan-valencian": "ca",

  en: "en",
  eng: "en",
  english: "en",
  ingles: "en",

  ja: "ja",
  jpn: "ja",
  japanese: "ja",
  japones: "ja",
  jp: "ja",

  ko: "ko",
  kor: "ko",
  korean: "ko",
  coreano: "ko",

  zh: "zh",
  zho: "zh",
  chi: "zh",
  chinese: "zh",
  chino: "zh",
  "zh-cn": "zh-Hans",
  "zh-sg": "zh-Hans",
  "zh-hans": "zh-Hans",
  "chinese-simplified": "zh-Hans",
  "simplified-chinese": "zh-Hans",
  "zh-tw": "zh-Hant",
  "zh-hk": "zh-Hant",
  "zh-hant": "zh-Hant",
  "chinese-traditional": "zh-Hant",
  "traditional-chinese": "zh-Hant",

  pt: "pt",
  por: "pt",
  portuguese: "pt",
  portugues: "pt",
  "pt-br": "pt-BR",
  "por-br": "pt-BR",
  pb: "pt-BR",
  "brazilian-portuguese": "pt-BR",
  "portuguese-brazil": "pt-BR",
  "portugues-brasil": "pt-BR",
  "pt-pt": "pt-PT",
  "portuguese-portugal": "pt-PT",

  fr: "fr",
  fra: "fr",
  fre: "fr",
  french: "fr",
  frances: "fr",

  de: "de",
  deu: "de",
  ger: "de",
  german: "de",
  aleman: "de",

  it: "it",
  ita: "it",
  italian: "it",
  italiano: "it",

  ru: "ru",
  rus: "ru",
  russian: "ru",
  ruso: "ru",

  ar: "ar",
  ara: "ar",
  arabic: "ar",
  arabe: "ar",

  hi: "hi",
  hin: "hi",
  hindi: "hi",

  ta: "ta",
  tam: "ta",
  tamil: "ta",

  te: "te",
  tel: "te",
  telugu: "te",

  ml: "ml",
  mal: "ml",
  malayalam: "ml",

  bn: "bn",
  ben: "bn",
  bengali: "bn",
  bangla: "bn",

  mr: "mr",
  mar: "mr",
  marathi: "mr",

  pa: "pa",
  pan: "pa",
  punjabi: "pa",

  kn: "kn",
  kan: "kn",
  kannada: "kn",

  gu: "gu",
  guj: "gu",
  gujarati: "gu",

  ur: "ur",
  urd: "ur",
  urdu: "ur",

  th: "th",
  tha: "th",
  thai: "th",
  tailandes: "th",

  vi: "vi",
  vie: "vi",
  vietnamese: "vi",
  vietnamita: "vi",

  id: "id",
  ind: "id",
  indonesian: "id",
  indonesio: "id",

  ms: "ms",
  msa: "ms",
  malay: "ms",
  malayo: "ms",

  tl: "tl",
  tgl: "tl",
  tagalog: "tl",
  filipino: "tl",

  pl: "pl",
  pol: "pl",
  polish: "pl",
  polaco: "pl",

  nl: "nl",
  nld: "nl",
  dutch: "nl",
  holandés: "nl",
  holandes: "nl",

  sv: "sv",
  swe: "sv",
  swedish: "sv",
  sueco: "sv",

  no: "no",
  nor: "no",
  norwegian: "no",
  noruego: "no",

  da: "da",
  dan: "da",
  danish: "da",
  danes: "da",

  fi: "fi",
  fin: "fi",
  finnish: "fi",
  finlandes: "fi",

  cs: "cs",
  ces: "cs",
  czech: "cs",
  checo: "cs",

  ro: "ro",
  ron: "ro",
  romanian: "ro",
  rumano: "ro",

  hu: "hu",
  hun: "hu",
  hungarian: "hu",
  hungaro: "hu",

  el: "el",
  ell: "el",
  greek: "el",
  griego: "el",

  he: "he",
  heb: "he",
  hebrew: "he",
  hebreo: "he",

  uk: "uk",
  ukr: "uk",
  ukrainian: "uk",
  ucraniano: "uk",

  bg: "bg",
  bul: "bg",
  bulgarian: "bg",
  bulgaro: "bg",

  hr: "hr",
  hrv: "hr",
  croatian: "hr",
  croata: "hr",

  sr: "sr",
  srp: "sr",
  serbian: "sr",
  serbio: "sr",

  sk: "sk",
  slk: "sk",
  slovak: "sk",
  eslovaco: "sk",

  sl: "sl",
  slv: "sl",
  slovenian: "sl",
  esloveno: "sl",

  et: "et",
  est: "et",
  estonian: "et",
  estonio: "et",

  lv: "lv",
  lav: "lv",
  latvian: "lv",
  letón: "lv",
  leton: "lv",

  lt: "lt",
  lit: "lt",
  lithuanian: "lt",
  lituano: "lt",

  tr: "tr",
  tur: "tr",
  turkish: "tr",
  turco: "tr",
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeLooseText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[._/\\]+/g, " ")
    .replace(/[_\s]+/g, " ")
    .trim();
}

function key(value: string): string {
  return normalizeLooseText(value).replace(/\s+/g, "-");
}

function formatBcp47(raw: string): string | undefined {
  const match = raw.trim().replace(/_/g, "-").match(/^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i);
  if (!match) return undefined;
  const language = match[1].toLowerCase();
  const script = match[2] ? `${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}` : "";
  const region = match[3] ? match[3].toUpperCase() : "";
  return [language, script, region].filter(Boolean).join("-");
}

/**
 * Convierte códigos y etiquetas humanas conocidas a una etiqueta estable.
 * Acepta nombres que suelen traer manifests y APIs (por ejemplo
 * "Spanish (Latin America)", "Português Brasil" o "Chinese Traditional").
 */
export function normalizeLanguageCode(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const normalizedKey = key(raw);
  const exact = LANGUAGE_ALIASES[normalizedKey];
  if (exact) return exact;

  const text = normalizeLooseText(raw);
  const words = ` ${text} `;

  // Primero las variantes regionales: si comprobáramos "spanish" antes de
  // "latin america", perderíamos la información que el player usa para
  // priorizar doblaje latino.
  if (/(?:\blatino(?:america)?\b|\blatam\b|\blatin america\b|\blatin american\b|\bes[ -]?419\b|\bes[ -]?(?:la|latam)\b)/.test(text) && /(?:spanish|espanol|latino|latam|\bes\b)/.test(text)) return "es-419";
  if (/(?:\bcastellano\b|\bspanish spain\b|\bespanol espana\b|\bes[ -]?es\b)/.test(text)) return "es-ES";
  if (/(?:\bcatalan\b|\bcatala\b|\bvalencia(?:no)?\b|\bca[ -]?es\b)/.test(text)) return "ca";
  if (/(?:\bbrazil(?:ian)?\b|\bbrasil(?:eiro)?\b|\bpt[ -]?br\b)/.test(text) && /(?:portugu|\bpt\b)/.test(text)) return "pt-BR";
  if (/(?:\bportugal\b|\bpt[ -]?pt\b)/.test(text) && /(?:portugu|\bpt\b)/.test(text)) return "pt-PT";
  if (/(?:\bsimplified\b|\bsimplificado\b|\bzh[ -]?(?:cn|sg|hans)\b)/.test(text) && /(?:chinese|chino|\bzh\b)/.test(text)) return "zh-Hans";
  if (/(?:\btraditional\b|\btradicional\b|\bzh[ -]?(?:tw|hk|hant)\b)/.test(text) && /(?:chinese|chino|\bzh\b)/.test(text)) return "zh-Hant";

  const directWords: Array<[RegExp, string]> = [
    [/\b(?:catalan|catala|valenciano|cat)\b/, "ca"],
    [/\b(?:spanish|espanol|spa)\b/, "es"],
    [/\b(?:english|ingles|eng)\b/, "en"],
    [/\b(?:japanese|japones|jpn)\b/, "ja"],
    [/\b(?:korean|coreano|kor)\b/, "ko"],
    [/\b(?:chinese|chino|zho|chi)\b/, "zh"],
    [/\b(?:portuguese|portugues|por)\b/, "pt"],
    [/\b(?:french|frances|fra|fre)\b/, "fr"],
    [/\b(?:german|aleman|deu|ger)\b/, "de"],
    [/\b(?:italian|italiano|ita)\b/, "it"],
    [/\b(?:russian|ruso|rus)\b/, "ru"],
    [/\b(?:arabic|arabe|ara)\b/, "ar"],
    [/\b(?:hindi|hin)\b/, "hi"],
    [/\b(?:turkish|turco|tur)\b/, "tr"],
  ];
  for (const [pattern, language] of directWords) {
    if (pattern.test(words)) return language;
  }

  const bcp47 = formatBcp47(raw);
  if (bcp47) {
    const alias = LANGUAGE_ALIASES[bcp47.toLowerCase()];
    return alias || bcp47;
  }
  return undefined;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function inferLanguageFromText(value: string): string | undefined {
  return normalizeLanguageCode(value);
}

function subtitleLanguageFromTracks(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates: string[] = [];
  for (const track of value) {
    if (!track || typeof track !== "object") continue;
    const rawValues = [(track as any).language, (track as any).lang, (track as any).label]
      .filter((candidate) => typeof candidate === "string" && candidate.trim());
    for (const raw of rawValues) {
      const candidate = normalizeLanguageCode(raw) || inferLanguageFromText(raw);
      if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
  }
  // Priorizar latino sobre español genérico cuando ambas pistas existen. El
  // player todavía conserva todas las pistas; esta pista solo ayuda a escoger
  // una representación inicial coherente.
  return candidates.find((candidate) => candidate === "es-419")
    || candidates.find((candidate) => /^(?:es)(?:-|$)/i.test(candidate))
    || candidates[0];
}

/** Devuelve solo pistas faltantes; las declaradas por un adaptador tienen prioridad. */
export function detectLanguageHints(input: LanguageDetectionInput): LanguageHints {
  const title = clean(input.title);
  const url = clean(input.url);
  const explicitRendition = clean(input.language).toLowerCase();
  const explicitLinkType = clean(input.link_type).toLowerCase();
  const explicitAudio = normalizeLanguageCode(input.audio_language);
  const explicitSubtitle = normalizeLanguageCode(input.subtitle_language) || subtitleLanguageFromTracks(input.subtitles);
  const haystack = `${title} ${url} ${explicitRendition} ${explicitLinkType}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const isLatAnime = /latanime\.org/i.test(url);

  const subMarker = hasAny(haystack, [
    /(?:^|[\s._/?=&-])sub(?:$|[\s._/?=&-])/i,
    /subtit(?:ulado|ulada|ulos?|led)/i,
    /\bsubs?[-_ ]?(?:es|spa|spanish|espanol)\b/i,
  ]);
  const dubMarker = hasAny(haystack, [
    /(?:^|[\s._/?=&-])dub(?:$|[\s._/?=&-])/i,
    /dobl(?:aje|ado|ada)/i,
  ]);
  const catalanAudio = hasAny(haystack, [
    /\b(?:catalan|catala|ca)\b/i,
    /-catalan\b/i,
    /-catala\b/i,
  ]);
  const spanishAudio = hasAny(haystack, [
    /\b(?:latino|latam|es-?419)\b/i,
    /\b(?:castellano|espa(?:n|ñ)a|es-?es)\b/i,
    /\b(?:espanol|español|spanish)\b/i,
  ]);
  const inferredAudio = catalanAudio
    ? "ca"
    : spanishAudio
      ? hasAny(haystack, [/\b(?:latino|latam|es-?419)\b/i])
        ? "es-419"
        : hasAny(haystack, [/\b(?:castellano|espa(?:n|ñ)a|es-?es)\b/i])
          ? "es-ES"
          : "es"
      : undefined;

  // “Sub Español/Latino” describe la pista de subtítulos, no el audio. Los
  // marcadores genéricos de español sólo implican doblaje cuando no hay una
  // señal explícita de subtítulos. Un `language/link_type=dub` explícito sí
  // conserva prioridad aunque el título contenga otra etiqueta.
  const explicitSub = explicitRendition === "sub" || explicitLinkType === "sub";
  const explicitDub = explicitRendition === "dub" || explicitLinkType === "dub";
  const isSub = explicitSub || subMarker || (isLatAnime && !spanishAudio && !catalanAudio && !dubMarker);
  const isDub = explicitDub || dubMarker || catalanAudio || (!isSub && spanishAudio);

  const language = explicitRendition === "sub" || explicitRendition === "dub"
    ? explicitRendition
    : explicitLinkType === "sub" || explicitLinkType === "dub"
      ? explicitLinkType
      : isSub
        ? "sub"
        : isDub
          ? "dub"
          : undefined;

  // En LatAnime, los contenidos estándar no doblados son audio japonés con subtítulos en español.
  const defaultLatAnimeAudio = isLatAnime && !isDub ? "ja" : undefined;
  const defaultLatAnimeSubtitle = isLatAnime && !isDub ? "es" : undefined;

  return {
    ...(language ? { language } : {}),
    ...(explicitAudio || (isDub && (spanishAudio || catalanAudio)) || defaultLatAnimeAudio
      ? { audio_language: explicitAudio || inferredAudio || defaultLatAnimeAudio }
      : {}),
    ...(explicitSubtitle || (isSub && spanishAudio) || defaultLatAnimeSubtitle
      ? { subtitle_language: explicitSubtitle || (isSub && spanishAudio ? inferredAudio || "es" : defaultLatAnimeSubtitle) }
      : {}),
  };
}
