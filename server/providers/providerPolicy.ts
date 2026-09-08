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
  /** Runtime registry metadata shared by discovery, resolver and health layers. */
  discovery?: "catalog" | "page" | "direct_api" | "metadata";
  resolver?: string;
  hosts?: string[];
  fallbackProvider?: string;
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
    discovery: "direct_api",
    resolver: "direct",
  },
  "stremio-direct": {
    id: "stremio-direct",
    role: "primary",
    lifecycle: "active",
    priority: 5,
    defaultRating: 9,
    contentKinds: ["movie", "series"],
    audioLanguages: ["en", "es", "ja"],
    subtitleLanguages: ["es", "en"],
    discovery: "direct_api",
    resolver: "stremio-direct",
    hosts: ["configured-addon"],
    notes: "Puente de addons públicos que entregan streams HLS/DASH/MP4 directamente.",
  },
  flixquest: {
    id: "flixquest",
    role: "fallback",
    lifecycle: "legacy",
    priority: 88,
    defaultRating: 4,
    contentKinds: ["movie", "series"],
    audioLanguages: ["en", "es"],
    subtitleLanguages: ["es", "en"],
    discovery: "direct_api",
    resolver: "flixquest",
    hosts: ["flixquest-api.vercel.app"],
    notes: "La API pública verificada devuelve 404; se conserva para activación explícita, fuera del camino principal.",
  },
  nuvio: {
    id: "nuvio",
    role: "fallback",
    lifecycle: "legacy",
    priority: 16,
    defaultRating: 7.8,
    contentKinds: ["movie", "series"],
    audioLanguages: ["en", "es"],
    subtitleLanguages: ["es", "en"],
    discovery: "direct_api",
    resolver: "nuvio",
    hosts: ["nuviostreams.hayd.uk"],
    notes: "Instancia pública verificada como retirada; no participa en el camino principal.",
  },
  "anime-sdk": {
    id: "anime-sdk",
    role: "primary",
    lifecycle: "active",
    priority: 12,
    defaultRating: 8,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "en"],
    subtitleLanguages: ["es", "en"],
    discovery: "direct_api",
    resolver: "anime-sdk",
  },
  vidsrc: {
    id: "vidsrc",
    role: "primary",
    lifecycle: "active",
    priority: 18,
    defaultRating: 7.5,
    contentKinds: ["movie", "series", "anime"],
    audioLanguages: ["en"],
    subtitleLanguages: ["en", "es"],
    discovery: "direct_api",
    resolver: "vidsrc",
    hosts: ["vidsrc.sbs", "vidsrc.to", "vidsrc.me"],
    notes: "Solo se aceptan respuestas de API que contengan HLS/DASH/MP4.",
  },
  vidsrcto: {
    id: "vidsrcto",
    role: "secondary",
    lifecycle: "active",
    priority: 20,
    defaultRating: 7.2,
    contentKinds: ["movie", "series", "anime"],
    audioLanguages: ["en"],
    subtitleLanguages: ["en", "es"],
    discovery: "direct_api",
    resolver: "vidsrcto",
    hosts: ["vidsrcto.to"],
  },
  animeav1: {
    id: "animeav1",
    role: "fallback",
    lifecycle: "legacy",
    priority: 80,
    defaultRating: 5.8,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
    notes: "Spanish-first anime source; prefer Japanese audio with Spanish subtitles.",
  },
  animeflv: {
    id: "animeflv",
    role: "fallback",
    lifecycle: "legacy",
    priority: 82,
    defaultRating: 5.8,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
  },
  jkanime: {
    id: "jkanime",
    role: "fallback",
    lifecycle: "legacy",
    priority: 84,
    defaultRating: 5.6,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es", "es-419"],
    notes: "Handled by AnimeFlvAdapter today, but kept as a distinct health/rating source.",
  },
  cinecalidad: {
    id: "cinecalidad",
    role: "primary",
    lifecycle: "active",
    priority: 10,
    defaultRating: 8.5,
    contentKinds: ["movie", "series"],
    audioLanguages: ["es", "en"],
    subtitleLanguages: ["es", "en"],
    discovery: "page",
    resolver: "cinecalidad",
    hosts: ["cinecalidad.am", "vimeos.zip", "goodstream.one"],
    fallbackProvider: "gnula",
    notes: "Sonda pública 2026-09-07: Vimeos HLS directo confirmado; Goodstream apareció como alternativa, con 403 intermitente.",
  },
  lamovie: {
    id: "lamovie",
    role: "fallback",
    lifecycle: "legacy",
    priority: 86,
    defaultRating: 5.5,
    contentKinds: ["movie", "series", "anime"],
    audioLanguages: ["es", "en", "ja"],
    subtitleLanguages: ["es", "en"],
  },
  gnula: {
    id: "gnula",
    role: "secondary",
    lifecycle: "active",
    priority: 20,
    defaultRating: 7.8,
    contentKinds: ["movie", "series"],
    audioLanguages: ["es", "en"],
    subtitleLanguages: ["es", "en"],
    discovery: "page",
    resolver: "gnula",
    hosts: ["gnulahd.nu"],
    notes: "Sonda E2E pública 2026-09-07: la ficha entrega Byse/otros locators; Byse resolvió a HLS SprintCDN con manifest 200 y segmento 206. No se observó VidSrc.",
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
    role: "fallback",
    lifecycle: "legacy",
    priority: 88,
    defaultRating: 5.5,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "en"],
    subtitleLanguages: ["en"],
  },
  latanime: {
    id: "latanime",
    role: "primary",
    lifecycle: "active",
    priority: 10,
    defaultRating: 8.2,
    contentKinds: ["anime"],
    audioLanguages: ["ja", "es"],
    subtitleLanguages: ["es"],
    discovery: "page",
    resolver: "latanime",
    hosts: ["latanime.org", "sprintcdn"],
    notes: "Sonda pública 2026-09-07: HLS directo confirmado en sprintcdn; Hexload quedó como respaldo de página.",
  },
  tioanime: {
    id: "tioanime",
    role: "fallback",
    lifecycle: "legacy",
    priority: 90,
    defaultRating: 6.0,
    contentKinds: ["anime"],
    audioLanguages: ["ja"],
    subtitleLanguages: ["es"],
    discovery: "page",
    resolver: "tioanime",
    hosts: ["tioanime.com"],
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
    role: "secondary",
    lifecycle: "maintained",
    priority: 72,
    defaultRating: 5.8,
    contentKinds: ["movie", "series"],
    audioLanguages: ["ko", "es"],
    subtitleLanguages: ["es"],
    discovery: "page",
    resolver: "doramasflix",
    hosts: ["doramasflix.io", "doramasflix.co", "doramasflix.net", "doramasflix.in", "doramasflix.com"],
    fallbackProvider: "vidsrc",
    notes: "Adaptador mantenido: GraphQL público + resolutores nativos HLS/MP4. Primeload/anti-bot solo se descarta; nunca se anuncia iframe.",
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
    discovery: "metadata",
    resolver: "tvmaze",
  },
  zokoanime: {
    id: "zokoanime",
    role: "primary",
    lifecycle: "active",
    priority: 10,
    defaultRating: 8.2,
    contentKinds: ["anime"],
    audioLanguages: ["ja"],
    subtitleLanguages: ["es", "en"],
    discovery: "page",
    resolver: "zokoanime",
    hosts: ["zokoanime.video", "aniwatchtv.uk"],
    fallbackProvider: "tioanime",
    notes: "Sonda pública 2026-09-07: HLS en aniwatchtv.uk; el CDN exige Referer https://zokoanime.video/. Solo se admite media expuesta por el player.",
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
  "doramasflix.io": "doramasflix",
  "doramasflix.co": "doramasflix",
  "doramasflix.net": "doramasflix",
  "doramasflix.in": "doramasflix",
  "doramasflix.com": "doramasflix",
  "tioplus.app": "tioplus",
  "tubepelis.com": "tubepelis",
  "archive.org": "archive-org",
  "tvmaze.com": "tvmaze",
  "zokoanime.video": "zokoanime",
  "vidsrc.sbs": "vidsrc",
  "vidsrc.to": "vidsrc",
  "vidsrc.me": "vidsrc",
  "vidsrcto.to": "vidsrcto",
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

  // API adapters commonly prefix a site id (for example `flixquest:vidsrc`)
  // so telemetry can retain the adapter and the final source. Resolve the
  // right-most policy id before falling back to host normalization.
  const namespaced = raw.split(":").filter(Boolean).reverse().find((part) => Boolean(PROVIDER_POLICIES[part]));
  if (namespaced) return namespaced;

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

/**
 * Providers admitted to the normal playback path. Legacy sources remain
 * available to explicit recovery jobs, but cannot silently re-enter ranking.
 * TioAnime is the single intentional legacy exception for ZokoAnime fallback.
 */
export function isProviderAllowedInMainPath(
  value: string | null | undefined,
  contentKind?: ContentKind | null,
): boolean {
  const id = normalizeProviderId(value);
  const policy = PROVIDER_POLICIES[id];
  if (!policy || policy.role === "metadata") return false;
  if (contentKind && !policy.contentKinds.includes(contentKind)) return false;
  if (policy.lifecycle === "active" || policy.lifecycle === "maintained") return true;
  return id === "tioanime" && contentKind === "anime";
}

/**
 * Allow-list for a cross-platform recovery pass. The main-path predicate
 * keeps TioAnime as an anime exception for compatibility, but a recovery pass
 * must additionally prove that the preferred ZokoAnime locator exists before
 * admitting that legacy fallback.
 */
export function isProviderAllowedInCrossPlatformRecovery(
  value: string | null | undefined,
  contentKind: ContentKind,
  hasZokoAnime = false,
): boolean {
  const id = normalizeProviderId(value);
  if (id === "tioanime") return contentKind === "anime" && hasZokoAnime;
  return isProviderAllowedInMainPath(id, contentKind);
}

export function isLegacyProvider(value: string | null | undefined): boolean {
  return getProviderPolicy(value)?.lifecycle === "legacy";
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

  if ([
    "es-es", "castellano", "español españa", "espanol espana",
    "spanish-spain", "spanish spain", "spanish (spain)",
  ].includes(raw)) return "es-ES";

  if (["es", "español", "espanol", "spanish", "spa"].includes(raw)) return "es";
  if (["ja", "japonés", "japones", "japanese", "jp", "jpn"].includes(raw)) return "ja";
  if (["en", "english", "eng"].includes(raw)) return "en";
  if (["ko", "korean", "kor", "coreano"].includes(raw)) return "ko";

  // Preserve common BCP-47 casing for known regional/script variants instead
  // of leaking the lower-cased internal key to UI/ranking comparisons.
  if (raw === "pt-br") return "pt-BR";
  if (raw === "pt-pt") return "pt-PT";
  if (raw === "zh-hans") return "zh-Hans";
  if (raw === "zh-hant") return "zh-Hant";
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
  return lang === "es" || lang === "es-419" || lang === "es-ES" || lang.toLowerCase().startsWith("es-");
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
