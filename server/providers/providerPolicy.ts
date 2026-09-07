import type { ContentKind } from "../types";

export type ProviderLifecycle = "active" | "maintained" | "legacy" | "experimental";
export type ProviderRole = "primary" | "secondary" | "fallback" | "metadata";

export interface ProviderPolicy {
  id: string;
  role: ProviderRole;
  lifecycle: ProviderLifecycle;
  priority: number;
  defaultRating: number;
  contentKinds: ContentKind[];
  audioLanguages: string[];
  subtitleLanguages: string[];
  notes?: string;
}

/**
 * Runtime source policy. Lower priority numbers are preferred.
 * `lifecycle` is a maintenance-confidence hint, never a guarantee that a
 * third-party provider is reachable at a particular instant.
 */
export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
  direct: {
    id: "direct",
    role: "primary",
    lifecycle: "active",
    priority: 1,
    defaultRating: 10,
    contentKinds: ["movie", "series", "anime", "documentary", "open_archive"],
    audioLanguages: [],
    subtitleLanguages: [],
  },
  animeav1: {
    id: "animeav1",
    role: "primary",
    lifecycle: "active",
    priority: 10,
    defaultRating: 8.8,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
    notes: "Spanish-first anime source; prefer Japanese audio with Spanish subtitles.",
  },
  animeflv: {
    id: "animeflv",
    role: "primary",
    lifecycle: "active",
    priority: 20,
    defaultRating: 8.4,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
  },
  jkanime: {
    id: "jkanime",
    role: "primary",
    lifecycle: "active",
    priority: 22,
    defaultRating: 8.0,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
    notes: "Handled by AnimeFlvAdapter today, but kept as a distinct health/rating source.",
  },
  cinecalidad: {
    id: "cinecalidad",
    role: "primary",
    lifecycle: "maintained",
    priority: 25,
    defaultRating: 8.1,
    contentKinds: ["movie", "series"],
    audioLanguages: ["es", "en"],
    subtitleLanguages: ["es", "en"],
  },
  lamovie: {
    id: "lamovie",
    role: "secondary",
    lifecycle: "maintained",
    priority: 30,
    defaultRating: 7.8,
    contentKinds: ["movie", "series", "anime"],
    audioLanguages: ["es", "en", "ja"],
    subtitleLanguages: ["es", "en"],
  },
  gnula: {
    id: "gnula",
    role: "secondary",
    lifecycle: "maintained",
    priority: 35,
    defaultRating: 7.5,
    contentKinds: ["movie", "series", "anime"],
    audioLanguages: ["es", "en", "ja"],
    subtitleLanguages: ["es", "en"],
  },
  "archive-org": {
    id: "archive-org",
    role: "secondary",
    lifecycle: "active",
    priority: 40,
    defaultRating: 8,
    contentKinds: ["movie", "documentary", "open_archive"],
    audioLanguages: ["en"],
    subtitleLanguages: ["en", "es"],
  },
  hianimes: {
    id: "hianimes",
    role: "secondary",
    lifecycle: "maintained",
    priority: 45,
    defaultRating: 6.8,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "en"],
    subtitleLanguages: ["en"],
  },
  latanime: {
    id: "latanime",
    role: "fallback",
    lifecycle: "legacy",
    priority: 60,
    defaultRating: 6.2,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es"],
  },
  tioanime: {
    id: "tioanime",
    role: "fallback",
    lifecycle: "legacy",
    priority: 65,
    defaultRating: 6.0,
    contentKinds: ["anime"],
    audioLanguages: ["ja"],
    subtitleLanguages: ["es"],
  },
  veranimes: {
    id: "veranimes",
    role: "fallback",
    lifecycle: "legacy",
    priority: 70,
    defaultRating: 5.8,
    contentKinds: ["anime"],
    audioLanguages: ["ja"],
    subtitleLanguages: ["es"],
  },
  doramasflix: {
    id: "doramasflix",
    role: "fallback",
    lifecycle: "legacy",
    priority: 75,
    defaultRating: 5.8,
    contentKinds: ["movie", "series"],
    audioLanguages: ["ko", "es"],
    subtitleLanguages: ["es"],
  },
  tioplus: {
    id: "tioplus",
    role: "fallback",
    lifecycle: "legacy",
    priority: 80,
    defaultRating: 5.5,
    contentKinds: ["movie", "series"],
    audioLanguages: ["es", "en"],
    subtitleLanguages: ["es"],
  },
  tubepelis: {
    id: "tubepelis",
    role: "fallback",
    lifecycle: "legacy",
    priority: 85,
    defaultRating: 5.5,
    contentKinds: ["movie"],
    audioLanguages: ["es"],
    subtitleLanguages: [],
  },
  tvmaze: {
    id: "tvmaze",
    role: "metadata",
    lifecycle: "active",
    priority: 90,
    defaultRating: 3,
    contentKinds: ["series"],
    audioLanguages: [],
    subtitleLanguages: [],
  },
};

const SITE_ALIASES: Record<string, string> = {
  "animeav1.com": "animeav1",
  "animeflv.net": "animeflv",
  "animeflv.to": "animeflv",
  "animeflv.or.at": "animeflv",
  "animeflv.or.am": "animeflv",
  "jkanime.net": "jkanime",
  "cinecalidad.am": "cinecalidad",
  "lamovie.org": "lamovie",
  "gnulahd.nu": "gnula",
  "hianimes.se": "hianimes",
  "latanime.org": "latanime",
  "tioanime.com": "tioanime",
  "veranimes.net": "veranimes",
  "tioplus.app": "tioplus",
  "tubepelis.com": "tubepelis",
  "archive.org": "archive-org",
  "tvmaze.com": "tvmaze",
};

function hostFromProviderValue(raw: string): string {
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].split(":")[0];
  }
}

export function normalizeProviderId(value: string | null | undefined): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (PROVIDER_POLICIES[raw]) return raw;

  const host = hostFromProviderValue(raw);
  for (const [domain, id] of Object.entries(SITE_ALIASES)) {
    if (host === domain || host.endsWith(`.${domain}`)) return id;
  }

  const first = host.split(".")[0];
  if (PROVIDER_POLICIES[first]) return first;

  // Unknown providers must still collapse to a stable host identity. Returning
  // the original URL here used to create different SiteRating keys per path.
  return host || raw;
}

export function getProviderPolicy(value: string | null | undefined): ProviderPolicy | undefined {
  return PROVIDER_POLICIES[normalizeProviderId(value)];
}

export function getProviderPriority(value: string | null | undefined): number {
  return getProviderPolicy(value)?.priority ?? 100;
}

export function getProviderDefaultRating(value: string | null | undefined): number | undefined {
  return getProviderPolicy(value)?.defaultRating;
}

export function compareProviderIds(a: string, b: string): number {
  return getProviderPriority(a) - getProviderPriority(b);
}

export function normalizeLanguageTag(value: string | null | undefined): string | null {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return null;

  if ([
    "lat", "latam", "latino", "latinoamérica", "latinoamerica",
    "es-la", "es-latam", "es-419", "spanish-latam", "español latino", "espanol latino",
  ].includes(raw)) return "es-419";

  if (["es", "español", "espanol", "castellano", "spanish", "spa"].includes(raw)) return "es";
  if (["ja", "japonés", "japones", "japanese", "jp", "jpn"].includes(raw)) return "ja";
  if (["en", "english", "eng"].includes(raw)) return "en";
  if (["ko", "korean", "kor", "coreano"].includes(raw)) return "ko";

  return raw;
}

export interface RenditionDescriptor {
  contentKind?: ContentKind | null;
  language?: string | null;
  audio_language?: string | null;
  subtitle_language?: string | null;
  subtitles?: Array<{ language?: string | null }> | null;
}

function isSpanish(lang: string): boolean {
  return lang === "es" || lang === "es-419" || lang.startsWith("es-");
}

function isEnglish(lang: string): boolean {
  return lang === "en" || lang.startsWith("en-");
}

/**
 * Rendition preference requested for MeriStream:
 * - anime: JA + ES subtitles first, then Spanish audio, then JA + EN subtitles.
 * - movie/series: English and Spanish are near peers; ES/EN subtitles are a bonus.
 */
export function renditionPreferenceScore(input: RenditionDescriptor): number {
  const kind = input.contentKind;
  const audio = normalizeLanguageTag(input.audio_language || input.language);
  const subtitle = normalizeLanguageTag(input.subtitle_language);
  const subtitleSet = new Set<string>();
  if (subtitle) subtitleSet.add(subtitle);
  for (const track of input.subtitles || []) {
    const lang = normalizeLanguageTag(track?.language);
    if (lang) subtitleSet.add(lang);
  }

  const hasEsSub = [...subtitleSet].some(isSpanish);
  const hasEnSub = [...subtitleSet].some(isEnglish);

  if (kind === "anime") {
    if (audio === "ja" && hasEsSub) return 100;
    if (audio && isSpanish(audio) && hasEsSub) return 92;
    if (audio && isSpanish(audio)) return 88;
    if (audio === "ja" && hasEnSub) return 72;
    if (audio === "ja") return 65;
    return 40;
  }

  if (kind === "movie" || kind === "series") {
    let score = 40;
    if (audio === "en" || (audio && isSpanish(audio))) score += 30;
    if (hasEsSub) score += 18;
    if (hasEnSub) score += 16;
    return score;
  }

  return 50;
}
