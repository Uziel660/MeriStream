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
 * Registry used by the runtime to keep source policy out of individual adapters.
 * Lower priority numbers are preferred. `lifecycle` describes maintenance
 * confidence, not a guarantee that a third-party site is reachable at this instant.
 */
export const PROVIDER_POLICIES: Record<string, ProviderPolicy> = {
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
};

const SITE_ALIASES: Record<string, string> = {
  "animeav1.com": "animeav1",
  "cdn.animeav1.com": "animeav1",
  "animeflv.net": "animeflv",
  "animeflv.to": "animeflv",
  "jkanime.net": "animeflv",
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

export function normalizeProviderId(value: string | null | undefined): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "unknown";
  const withoutProtocol = raw.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = withoutProtocol.split("/")[0];
  if (SITE_ALIASES[host]) return SITE_ALIASES[host];
  const first = host.split(".")[0];
  if (PROVIDER_POLICIES[first]) return first;
  return raw;
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
  if (["lat", "latino", "es-la", "es-latam", "spanish-latam"].includes(raw)) return "es-419";
  if (["castellano", "spanish", "spa"].includes(raw)) return "es";
  if (["japonés", "japones", "japanese", "jp", "jpn"].includes(raw)) return "ja";
  if (["english", "eng"].includes(raw)) return "en";
  return raw;
}

export interface RenditionDescriptor {
  contentKind?: ContentKind | null;
  language?: string | null;
  audio_language?: string | null;
  subtitle_language?: string | null;
  subtitles?: Array<{ language?: string | null }> | null;
}

/**
 * Language preference requested for MeriStream:
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
  const hasEsSub = [...subtitleSet].some((lang) => lang === "es" || lang === "es-419" || lang.startsWith("es-"));
  const hasEnSub = [...subtitleSet].some((lang) => lang === "en" || lang.startsWith("en-"));

  if (kind === "anime") {
    if (audio === "ja" && hasEsSub) return 100;
    if ((audio === "es" || audio === "es-419") && hasEsSub) return 92;
    if (audio === "es" || audio === "es-419") return 88;
    if (audio === "ja" && hasEnSub) return 72;
    if (audio === "ja") return 65;
    return 40;
  }

  if (kind === "movie" || kind === "series") {
    let score = 40;
    if (audio === "en" || audio === "es" || audio === "es-419") score += 30;
    if (hasEsSub) score += 18;
    if (hasEnSub) score += 16;
    return score;
  }

  return 50;
}
