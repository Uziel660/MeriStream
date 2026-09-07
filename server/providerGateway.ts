import { prisma } from "./db";
import { normalizeLanguageTag, renditionPreferenceScore } from "./providers/providerPolicy";

export type GatewayKind = "movie" | "series" | "anime";

export interface GatewayRequest {
  tmdbId: number;
  kind: GatewayKind;
  season?: number;
  episode?: number;
  preferredAudio?: string[];
  preferredSubtitles?: string[];
  persist?: boolean;
}

export interface GatewaySubtitle {
  language?: string | null;
  label?: string | null;
  url: string;
}

export interface GatewaySource {
  provider: string;
  providerGroup: "api" | "spanish-local" | "database";
  url: string;
  canonicalLocator?: string | null;
  type: "direct" | "embed" | "page";
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  subtitles?: GatewaySubtitle[];
  quality?: string | null;
  headers?: Record<string, string>;
  score: number;
  sourceStatus?: string | null;
}

interface NormalizedProviderResponse {
  sources?: Array<{
    url?: string;
    stream_url?: string;
    canonical_locator?: string;
    provider?: string;
    source_site?: string;
    type?: string;
    link_type?: string;
    language?: string;
    audio_language?: string;
    subtitle_language?: string;
    quality?: string;
    headers?: Record<string, string>;
    subtitles?: Array<{ language?: string; label?: string; url?: string; src?: string }>;
  }>;
  streams?: Array<any>;
  links?: Array<any>;
}

const SPANISH_LOCAL = new Set(["cinecalidad", "lamovie", "gnula", "doramasflix", "tioplus", "tubepelis"]);
const CACHE_TTL_MS = Math.max(5_000, Number(process.env.PROVIDER_GATEWAY_CACHE_MS || 120_000));
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.PROVIDER_GATEWAY_TIMEOUT_MS || 4_500));
const cache = new Map<string, { expires: number; value: GatewaySource[] }>();

function configuredApiBases(): string[] {
  const raw = [
    process.env.MERISTREAM_PROVIDER_API_URLS,
    process.env.MERISTREAM_MOVIE_API_URLS,
    process.env.MERISTREAM_ANIME_API_URLS,
  ].filter(Boolean).join(",");
  return Array.from(new Set(raw.split(",").map((v) => v.trim().replace(/\/$/, "")).filter(Boolean)));
}

function mediaPath(req: GatewayRequest): string {
  if (req.kind === "movie") return `/movie/${req.tmdbId}`;
  if (req.kind === "anime") return `/anime/${req.tmdbId}/${req.episode || 1}`;
  return `/tv/${req.tmdbId}/${req.season || 1}/${req.episode || 1}`;
}

function sourceType(url: string, declared?: string): GatewaySource["type"] {
  const value = String(declared || "").toLowerCase();
  if (value === "page" || value === "embed" || value === "direct") return value;
  if (/\.(m3u8|mp4|webm)(\?|#|$)/i.test(url)) return "direct";
  if (/embed|player|watch/i.test(url)) return "embed";
  return "page";
}

function normalizeExternalSource(raw: any, base: string, req: GatewayRequest): GatewaySource | null {
  const url = String(raw?.url || raw?.stream_url || raw?.src || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const provider = String(raw?.provider || raw?.source_site || new URL(base).hostname).toLowerCase();
  const audioLanguage = normalizeLanguageTag(raw?.audio_language || raw?.audioLanguage || raw?.language);
  const subtitleLanguage = normalizeLanguageTag(raw?.subtitle_language || raw?.subtitleLanguage);
  const subtitles: GatewaySubtitle[] = Array.isArray(raw?.subtitles)
    ? raw.subtitles.map((s: any) => ({
        language: normalizeLanguageTag(s?.language),
        label: s?.label || null,
        url: String(s?.url || s?.src || ""),
      })).filter((s: GatewaySubtitle) => /^https?:\/\//i.test(s.url))
    : [];
  const score = renditionPreferenceScore({
    contentKind: req.kind,
    audio_language: audioLanguage,
    subtitle_language: subtitleLanguage,
    subtitles,
  });
  return {
    provider,
    providerGroup: "api",
    url,
    canonicalLocator: raw?.canonical_locator || raw?.canonicalLocator || null,
    type: sourceType(url, raw?.type || raw?.link_type),
    audioLanguage,
    subtitleLanguage,
    subtitles,
    quality: raw?.quality || null,
    headers: raw?.headers || raw?.requiredHeaders || undefined,
    score,
    sourceStatus: "discovered",
  };
}

async function fetchApi(base: string, req: GatewayRequest): Promise<GatewaySource[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${mediaPath(req)}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return [];
    const body = await response.json() as NormalizedProviderResponse | any[];
    const values = Array.isArray(body)
      ? body
      : [...(body.sources || []), ...(body.streams || []), ...(body.links || [])];
    return values.map((value) => normalizeExternalSource(value, base, req)).filter((v): v is GatewaySource => Boolean(v));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function sourcesFromDatabase(req: GatewayRequest): Promise<GatewaySource[]> {
  const media = await prisma.mediaItem.findFirst({
    where: { tmdb_id: req.tmdbId, kind: req.kind },
    select: { id: true },
  });
  if (!media) return [];

  const episode = await prisma.mediaEpisode.findFirst({
    where: {
      media_item_id: media.id,
      season_number: req.kind === "movie" ? 1 : (req.season || 1),
      episode_number: req.kind === "movie" ? 1 : (req.episode || 1),
    },
    include: { links: true },
  });
  if (!episode) return [];

  return episode.links.map((link) => {
    const provider = String(link.source_site || "unknown").toLowerCase();
    const audioLanguage = normalizeLanguageTag(link.audio_language || link.language);
    const subtitleLanguage = normalizeLanguageTag(link.subtitle_language);
    const subtitles = Array.isArray(link.subtitles) ? link.subtitles as any[] : [];
    return {
      provider,
      providerGroup: SPANISH_LOCAL.has(provider) ? "spanish-local" : "database",
      url: link.url,
      canonicalLocator: link.canonical_locator,
      type: sourceType(link.url, link.link_type),
      audioLanguage: audioLanguage || (SPANISH_LOCAL.has(provider) ? "es" : null),
      subtitleLanguage,
      subtitles: subtitles.map((s: any) => ({ language: normalizeLanguageTag(s?.language), label: s?.label || null, url: String(s?.url || s?.src || "") })).filter((s: GatewaySubtitle) => Boolean(s.url)),
      score: renditionPreferenceScore({
        contentKind: req.kind,
        audio_language: audioLanguage || (SPANISH_LOCAL.has(provider) ? "es" : null),
        subtitle_language: subtitleLanguage,
        subtitles,
      }),
      sourceStatus: link.source_status,
    } satisfies GatewaySource;
  });
}

function dedupeAndRank(sources: GatewaySource[]): GatewaySource[] {
  const byKey = new Map<string, GatewaySource>();
  for (const source of sources) {
    const key = `${source.provider}|${source.canonicalLocator || source.url}`;
    const current = byKey.get(key);
    if (!current || source.score > current.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const groupWeight = (v: GatewaySource) => v.providerGroup === "spanish-local" ? 3 : v.providerGroup === "api" ? 2 : 1;
    return groupWeight(b) - groupWeight(a);
  });
}

async function persistSources(req: GatewayRequest, sources: GatewaySource[]): Promise<number> {
  const media = await prisma.mediaItem.findFirst({ where: { tmdb_id: req.tmdbId, kind: req.kind }, select: { id: true } });
  if (!media) return 0;
  const episode = await prisma.mediaEpisode.upsert({
    where: {
      media_item_id_season_number_episode_number: {
        media_item_id: media.id,
        season_number: req.kind === "movie" ? 1 : (req.season || 1),
        episode_number: req.kind === "movie" ? 1 : (req.episode || 1),
      },
    },
    create: {
      media_item_id: media.id,
      season_number: req.kind === "movie" ? 1 : (req.season || 1),
      episode_number: req.kind === "movie" ? 1 : (req.episode || 1),
    },
    update: {},
  });

  let saved = 0;
  for (const source of sources) {
    await prisma.sourceLink.upsert({
      where: {
        media_episode_id_source_site_url: {
          media_episode_id: episode.id,
          source_site: source.provider,
          url: source.url,
        },
      },
      create: {
        media_episode_id: episode.id,
        source_site: source.provider,
        url: source.url,
        link_type: source.type,
        language: source.audioLanguage,
        audio_language: source.audioLanguage,
        subtitle_language: source.subtitleLanguage,
        subtitles: source.subtitles as any,
        canonical_locator: source.canonicalLocator || (source.type === "direct" ? null : source.url),
        source_status: "discovered",
        extraction_method: source.providerGroup === "api" ? "provider_gateway" : "catalog_import",
        resolver_version: "gateway-v1",
      },
      update: {
        audio_language: source.audioLanguage,
        subtitle_language: source.subtitleLanguage,
        subtitles: source.subtitles as any,
        canonical_locator: source.canonicalLocator || undefined,
      },
    });
    saved += 1;
  }
  return saved;
}

export async function resolveByTmdb(req: GatewayRequest): Promise<{ sources: GatewaySource[]; persisted: number; elapsedMs: number }> {
  const started = Date.now();
  const key = `${req.kind}:${req.tmdbId}:${req.season || 1}:${req.episode || 1}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return { sources: cached.value, persisted: 0, elapsedMs: Date.now() - started };
  }

  const bases = configuredApiBases();
  const [dbSources, ...apiResults] = await Promise.all([
    sourcesFromDatabase(req),
    ...bases.map((base) => fetchApi(base, req)),
  ]);
  const ranked = dedupeAndRank([...dbSources, ...apiResults.flat()]);
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value: ranked });
  const persisted = req.persist ? await persistSources(req, ranked.filter((s) => s.providerGroup === "api")) : 0;
  return { sources: ranked, persisted, elapsedMs: Date.now() - started };
}

export function clearProviderGatewayCache(): void {
  cache.clear();
}
