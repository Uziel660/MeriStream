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

const AUDIO_ALIASES: Record<string, string> = {
  es: "es",
  spa: "es",
  spanish: "es",
  español: "es",
  espanol: "es",
  castellano: "es-ES",
  "es-es": "es-ES",
  espana: "es-ES",
  españa: "es-ES",
  latino: "es-419",
  latam: "es-419",
  "es-419": "es-419",
  en: "en",
  eng: "en",
  english: "en",
  inglés: "en",
  ingles: "en",
  ja: "ja",
  jpn: "ja",
  japanese: "ja",
  japonés: "ja",
  japones: "ja",
  jp: "ja",
  ko: "ko",
  kor: "ko",
  korean: "ko",
  zh: "zh",
  zho: "zh",
  chinese: "zh",
  fr: "fr",
  fra: "fr",
  french: "fr",
  de: "de",
  deu: "de",
  german: "de",
  it: "it",
  ita: "it",
  italian: "it",
  pt: "pt",
  por: "pt",
  portuguese: "pt",
  ru: "ru",
  rus: "ru",
  russian: "ru",
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function key(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s]+/g, "-")
    .trim();
}

/** Convierte códigos/etiquetas conocidas a un código estable de idioma. */
export function normalizeLanguageCode(value: unknown): string | undefined {
  const raw = clean(value);
  if (!raw) return undefined;
  const normalizedKey = key(raw);
  const exact = AUDIO_ALIASES[normalizedKey];
  if (exact) return exact;
  const bcp47 = raw.match(/^([a-z]{2,3})(?:[-_]([A-Za-z]{2,4}))?$/i);
  if (!bcp47) return undefined;
  if (bcp47[2]) return `${bcp47[1].toLowerCase()}-${bcp47[2].toUpperCase()}`;
  const normalized = AUDIO_ALIASES[normalizedKey.split("-")[0]];
  if (normalized) return normalized;
  return bcp47[1].toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
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
  // Cuando el manifiesto trae varias pistas, preferir español aunque la pista
  // por defecto esté en inglés/japonés; así la UI puede elegirla sin leer
  // bytes del vídeo. Si no hay español, conservar la primera pista declarada.
  return candidates.find((candidate) => /^(?:es)(?:-|$)/i.test(candidate)) || candidates[0];
}

function inferLanguageFromText(value: string): string | undefined {
  const text = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/\b(?:es|spa|spanish|espanol|castellano)\b/.test(text)) return "es";
  if (/\b(?:en|eng|english)\b/.test(text)) return "en";
  if (/\b(?:ja|jpn|japanese|japones)\b/.test(text)) return "ja";
  if (/\b(?:pt|por|portuguese|portugues)\b/.test(text)) return "pt";
  return undefined;
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

  const subMarker = hasAny(haystack, [
    /(?:^|[\s._/?=&-])sub(?:$|[\s._/?=&-])/i,
    /subtit(?:ulado|ulada|ulos?|led)/i,
    /\bsubs?[-_ ]?(?:es|spa|spanish|espanol)\b/i,
  ]);
  const dubMarker = hasAny(haystack, [
    /(?:^|[\s._/?=&-])dub(?:$|[\s._/?=&-])/i,
    /dobl(?:aje|ado|ada)/i,
  ]);
  const spanishAudio = hasAny(haystack, [
    /\b(?:latino|latam|es-?419)\b/i,
    /\b(?:castellano|espa(?:n|ñ)a|es-?es)\b/i,
    /\b(?:espanol|español|spanish)\b/i,
  ]);
  const inferredAudio = spanishAudio
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
  const isSub = explicitSub || subMarker;
  const isDub = explicitDub || dubMarker || (!isSub && spanishAudio);

  const language = explicitRendition === "sub" || explicitRendition === "dub"
    ? explicitRendition
    : explicitLinkType === "sub" || explicitLinkType === "dub"
      ? explicitLinkType
      : isSub
        ? "sub"
        : isDub
          ? "dub"
          : undefined;

  return {
    ...(language ? { language } : {}),
    ...(explicitAudio || (isDub && spanishAudio) ? { audio_language: explicitAudio || inferredAudio } : {}),
    ...(explicitSubtitle || (isSub && spanishAudio) ? { subtitle_language: explicitSubtitle || inferredAudio || "es" } : {}),
  };
}
