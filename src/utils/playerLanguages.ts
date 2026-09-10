export type PlayerLanguageCode =
  | 'es-419'
  | 'es-ES'
  | 'es'
  | 'en'
  | 'ja'
  | 'ko'
  | 'pt-BR'
  | 'pt'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'fr'
  | 'de'
  | 'it'
  | 'ru'
  | 'und'
  | string;

function folded(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalización de idioma exclusivamente para presentación/agrupación del player.
 * Mantiene el mismo vocabulario que el backend pero no modifica ningún payload,
 * URL ni contrato de reproducción.
 */
export function normalizePlayerLanguage(value: unknown): PlayerLanguageCode {
  const raw = folded(value);
  if (!raw) return 'und';

  if (
    /^(?:es-419|es-la|es-latam|lat|latam|latino|latin spanish|spanish-latam|spanish latin america)$/.test(raw) ||
    /(?:espanol|spanish).*lat(?:ino|am|in america)/.test(raw)
  ) return 'es-419';

  if (/^(?:castellano|es-es|spanish-spain|spanish spain|espanol-espana|espanol espana)$/.test(raw)) return 'es-ES';
  if (/^(?:es|spa|spanish|espanol)$/.test(raw)) return 'es';
  if (/^(?:en|eng|english|en-us|en-gb)$/.test(raw)) return 'en';
  if (/^(?:ja|jp|jpn|japanese|japones|ja-jp)$/.test(raw)) return 'ja';
  if (/^(?:ko|kor|korean|coreano|ko-kr)$/.test(raw)) return 'ko';

  if (/^(?:pt-br|por-br|pob|brazilian portuguese|portuguese brazil|portugues brasil)$/.test(raw)) return 'pt-BR';
  if (/^(?:pt|por|portuguese|portugues|pt-pt)$/.test(raw)) return 'pt';

  if (/^(?:zh-hans|zh-cn|chi-sim|chs|simplified chinese|chinese simplified|chino simplificado)$/.test(raw)) return 'zh-Hans';
  if (/^(?:zh-hant|zh-tw|zh-hk|chi-tra|cht|traditional chinese|chinese traditional|chino tradicional)$/.test(raw)) return 'zh-Hant';

  if (/^(?:hi|hin|hindi)$/.test(raw)) return 'hi';
  if (/^(?:ta|tam|tamil)$/.test(raw)) return 'ta';
  if (/^(?:te|tel|telugu)$/.test(raw)) return 'te';
  if (/^(?:ml|mal|malayalam)$/.test(raw)) return 'ml';
  if (/^(?:bn|ben|bengali|bangla)$/.test(raw)) return 'bn';
  if (/^(?:mr|mar|marathi)$/.test(raw)) return 'mr';
  if (/^(?:pa|pan|punjabi)$/.test(raw)) return 'pa';
  if (/^(?:kn|kan|kannada)$/.test(raw)) return 'kn';
  if (/^(?:gu|guj|gujarati)$/.test(raw)) return 'gu';
  if (/^(?:ur|urd|urdu)$/.test(raw)) return 'ur';

  if (/^(?:fr|fra|fre|french|frances)$/.test(raw)) return 'fr';
  if (/^(?:de|deu|ger|german|aleman)$/.test(raw)) return 'de';
  if (/^(?:it|ita|italian|italiano)$/.test(raw)) return 'it';
  if (/^(?:ru|rus|russian|ruso)$/.test(raw)) return 'ru';

  // "dub" / "sub" describen una modalidad, no un idioma. Mantenerlos fuera
  // de las agrupaciones evita crear falsos idiomas en los menús del player.
  if (/^(?:dub|dubbed|doblado|doblaje|sub|subbed|subtitulado)$/.test(raw)) return 'und';

  return raw;
}

const PLAYER_LANGUAGE_LABELS: Record<string, string> = {
  'es-419': 'Español latino',
  'es-ES': 'Castellano',
  es: 'Español',
  en: 'Inglés',
  ja: 'Japonés',
  ko: 'Coreano',
  'pt-BR': 'Portugués (Brasil)',
  pt: 'Portugués',
  'zh-Hans': 'Chino simplificado',
  'zh-Hant': 'Chino tradicional',
  hi: 'Hindi',
  ta: 'Tamil',
  te: 'Telugu',
  ml: 'Malayalam',
  bn: 'Bengalí',
  mr: 'Maratí',
  pa: 'Panyabí',
  kn: 'Canarés',
  gu: 'Guyaratí',
  ur: 'Urdu',
  fr: 'Francés',
  de: 'Alemán',
  it: 'Italiano',
  ru: 'Ruso',
  und: 'Idioma no identificado',
};

export function playerLanguageLabel(value: unknown): string {
  const key = normalizePlayerLanguage(value);
  return PLAYER_LANGUAGE_LABELS[key] || String(value || key || 'Idioma no identificado').trim();
}

export function sortPlayerLanguageKeys(keys: Iterable<string>, preferred: readonly string[] = []): string[] {
  const normalizedPreferred = preferred.map(normalizePlayerLanguage);
  const preferenceIndex = new Map(normalizedPreferred.map((key, index) => [key, index]));
  return [...new Set([...keys].map(normalizePlayerLanguage))].sort((a, b) => {
    const ai = preferenceIndex.get(a);
    const bi = preferenceIndex.get(b);
    if (ai !== undefined || bi !== undefined) {
      if (ai === undefined) return 1;
      if (bi === undefined) return -1;
      if (ai !== bi) return ai - bi;
    }
    if (a === 'und') return 1;
    if (b === 'und') return -1;
    return playerLanguageLabel(a).localeCompare(playerLanguageLabel(b), 'es');
  });
}

export function groupByPlayerLanguage<T>(
  items: readonly T[],
  languageOf: (item: T) => unknown,
  preferred: readonly string[] = [],
): Array<{ language: string; label: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const language = normalizePlayerLanguage(languageOf(item));
    const list = groups.get(language) || [];
    list.push(item);
    groups.set(language, list);
  }
  return sortPlayerLanguageKeys(groups.keys(), preferred).map((language) => ({
    language,
    label: playerLanguageLabel(language),
    items: groups.get(language) || [],
  }));
}

export interface PlayerSubtitleDescriptor {
  label?: string | null;
  language?: string | null;
  forced?: boolean | null;
  hearingImpaired?: boolean | null;
}

export function playerSubtitleLabel(track: PlayerSubtitleDescriptor): string {
  const language = playerLanguageLabel(track.language);
  const rawLabel = String(track.label || '').trim();
  const foldedLabel = folded(rawLabel);
  const forced = Boolean(track.forced) || /\b(?:forced|forzado|forzados)\b/.test(foldedLabel);
  const sdh = Boolean(track.hearingImpaired) || /\b(?:sdh|cc|closed captions?)\b/.test(foldedLabel);

  const suffixes: string[] = [];
  if (forced) suffixes.push('Forzados');
  if (sdh) suffixes.push('SDH/CC');

  const usefulProviderLabel = rawLabel && normalizePlayerLanguage(rawLabel) === 'und' && !/^(?:subtitulo|subtitle)s?$/i.test(rawLabel)
    ? rawLabel
    : '';
  return [language, ...suffixes, usefulProviderLabel].filter(Boolean).join(' · ');
}
