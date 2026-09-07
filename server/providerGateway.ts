import { prisma } from "./db";
import { normalizeLanguageTag, renditionPreferenceScore } from "./providers/providerPolicy";
import { getDirectStreamProviders } from "./providers/api";
import type {
  DirectMediaKind,
  PlayableSource,
  ProviderRequest,
  SubtitleTrack,
} from "./providers/api";
import { inferStreamType } from "./providers/api/types";

export type GatewayKind = DirectMediaKind;

export interface GatewayRequest {
  tmdbId: number;
  kind: GatewayKind;
  season?: number;
  episode?: number;
  preferredAudio?: string[];
  preferredSubtitles?: string[];
  persist?: boolean;
}

export type GatewaySubtitle = SubtitleTrack;
export type GatewaySource = PlayableSource & { score: number };

export interface GatewayFallbackCandidate {
  provider: string;
  providerGroup: "spanish-local" | "database";
  url: string;
  canonicalLocator?: string | null;
  type: "embed" | "page";
  audioLanguage?: string | null;
  subtitleLanguage?: string | null;
  subtitles?: GatewaySubtitle[];
  score: number;
  sourceStatus?: string | null;
}

const SPANISH_LOCAL = new Set([
  "cinecalidad", "lamovie", "gnula", "doramasflix", "tioplus", "tubepelis",
  "animeflv", "jkanime", "latanime", "tioanime", "veranimes",
]);
const CACHE_TTL_MS = Math.max(5_000, Number(process.env.PROVIDER_GATEWAY_CACHE_MS || 120_000));
const cache = new Map<string, {
  expires: number;
  sources: GatewaySource[];
  fallbackCandidates: GatewayFallbackCandidate[];
}>();

function normalizeSubtitleTracks(raw: unknown): GatewaySubtitle[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: any) => ({
    language: normalizeLanguageTag(entry?.language || entry?.lang),
    label: entry?.label || entry?.name || null,
    url: String(entry?.url || entry?.src || entry?.file || ""),
  })).filter((entry) => /^https?:\/\//i.test(entry.url));
}

function scoreSource(req: GatewayRequest, source: PlayableSource): number {
  const base = renditionPreferenceScore({
    contentKind: req.kind,
    audio_language: normalizeLanguageTag(source.audioLanguage),
    subtitle_language: normalizeLanguageTag(source.subtitleLanguage),
    subtitles: source.subtitles,
  });
  const preferredAudio = (req.preferredAudio || []).map(normalizeLanguageTag).filter(Boolean);
  const preferredSubs = (req.preferredSubtitles || []).map(normalizeLanguageTag).filter(Boolean);
  const audio = normalizeLanguageTag(source.audioLanguage);
  const subtitle = normalizeLanguageTag(source.subtitleLanguage);
  const audioBoost = audio && preferredAudio.includes(audio) ? 100 : 0;
  const subBoost = subtitle && preferredSubs.includes(subtitle) ? 40 : 0;
  return base + audioBoost + subBoost;
}

async function mediaContext(req: GatewayRequest): Promise<ProviderRequest> {
  const [canonical, legacy] = await Promise.all([
    prisma.mediaItem.findFirst({
      where: { tmdb_id: req.tmdbId, kind: req.kind },
      select: { title: true, year: true },
    }),
    req.kind === "anime"
      ? prisma.show.findFirst({
          where: { tmdb_id: req.tmdbId },
          select: { title: true, year: true, anilist_id: true, mal_id: true },
        })
      : Promise.resolve(null),
  ]);
  return {
    tmdbId: req.tmdbId,
    kind: req.kind,
    season: req.season || 1,
    episode: req.episode || 1,
    preferredAudio: req.preferredAudio,
    preferredSubtitles: req.preferredSubtitles,
    title: canonical?.title || legacy?.title || null,
    year: canonical?.year || legacy?.year || null,
    anilistId: legacy?.anilist_id || null,
    malId: legacy?.mal_id || null,
  };
}

async function resolvePrimaryApis(req: GatewayRequest): Promise<GatewaySource[]> {
  const context = await mediaContext(req);
  const providers = getDirectStreamProviders(context);
  const settled = await Promise.allSettled(providers.map((provider) => provider.resolve(context)));
  const direct = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);

  return direct.map((source) => ({
    ...source,
    audioLanguage: normalizeLanguageTag(source.audioLanguage),
    subtitleLanguage: normalizeLanguageTag(source.subtitleLanguage),
    subtitles: normalizeSubtitleTracks(source.subtitles),
    score: scoreSource(req, source),
  }));
}

async function sourcesFromDatabase(req: GatewayRequest): Promise<{
  direct: GatewaySource[];
  fallbackCandidates: GatewayFallbackCandidate[];
}> {
  const media = await prisma.mediaItem.findFirst({
    where: { tmdb_id: req.tmdbId, kind: req.kind },
    select: { id: true },
  });
  if (!media) return { direct: [], fallbackCandidates: [] };

  const episode = await prisma.mediaEpisode.findFirst({
    where: {
      media_item_id: media.id,
      season_number: req.kind === "movie" ? 1 : (req.season || 1),
      episode_number: req.kind === "movie" ? 1 : (req.episode || 1),
    },
    include: { links: true },
  });
  if (!episode) return { direct: [], fallbackCandidates: [] };

  const direct: GatewaySource[] = [];
  const fallbackCandidates: GatewayFallbackCandidate[] = [];
  for (const link of episode.links) {
    const provider = String(link.source_site || "unknown").toLowerCase();
    const providerGroup = SPANISH_LOCAL.has(provider) ? "spanish-local" as const : "database" as const;
    const audioLanguage = normalizeLanguageTag(link.audio_language || link.language) || (SPANISH_LOCAL.has(provider) ? "es" : null);
    const subtitleLanguage = normalizeLanguageTag(link.subtitle_language);
    const subtitles = normalizeSubtitleTracks(link.subtitles);
    const streamType = inferStreamType(link.url, link.link_type);
    const score = renditionPreferenceScore({
      contentKind: req.kind,
      audio_language: audioLanguage,
      subtitle_language: subtitleLanguage,
      subtitles,
    });

    if (streamType) {
      direct.push({
        provider,
        providerGroup,
        url: link.url,
        streamType,
        audioLanguage,
        subtitleLanguage,
        subtitles,
        score: score + (providerGroup === "spanish-local" ? 25 : 0),
        sourceStatus: link.source_status,
        canonicalLocator: link.canonical_locator,
      });
      continue;
    }

    fallbackCandidates.push({
      provider,
      providerGroup,
      url: link.url,
      canonicalLocator: link.canonical_locator || link.url,
      type: String(link.link_type).toLowerCase() === "embed" ? "embed" : "page",
      audioLanguage,
      subtitleLanguage,
      subtitles,
      score: score + (providerGroup === "spanish-local" ? 50 : 0),
      sourceStatus: link.source_status,
    });
  }
  return { direct, fallbackCandidates };
}

function dedupeAndRank(sources: GatewaySource[]): GatewaySource[] {
  const byKey = new Map<string, GatewaySource>();
  for (const source of sources) {
    const key = `${source.provider}|${source.url}`;
    const current = byKey.get(key);
    if (!current || source.score > current.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const weight = (source: GatewaySource) => source.providerGroup === "api" ? 3 : source.providerGroup === "spanish-local" ? 2 : 1;
    return weight(b) - weight(a);
  });
}

function rankFallbacks(values: GatewayFallbackCandidate[]): GatewayFallbackCandidate[] {
  return [...values].sort((a, b) => b.score - a.score);
}

async function persistApiSources(req: GatewayRequest, sources: GatewaySource[]): Promise<number> {
  const media = await prisma.mediaItem.findFirst({
    where: { tmdb_id: req.tmdbId, kind: req.kind },
    select: { id: true },
  });
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
  for (const source of sources.filter((value) => value.providerGroup === "api")) {
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
        link_type: "direct",
        language: source.audioLanguage,
        audio_language: source.audioLanguage,
        subtitle_language: source.subtitleLanguage,
        subtitles: source.subtitles as any,
        canonical_locator: source.canonicalLocator || null,
        source_status: "discovered",
        extraction_method: "direct_api_jit",
        resolver_version: "gateway-v2-direct",
      },
      update: {
        audio_language: source.audioLanguage,
        subtitle_language: source.subtitleLanguage,
        subtitles: source.subtitles as any,
        canonical_locator: source.canonicalLocator || undefined,
        source_status: "discovered",
      },
    });
    saved += 1;
  }
  return saved;
}

export async function resolveByTmdb(req: GatewayRequest): Promise<{
  sources: GatewaySource[];
  fallbackCandidates: GatewayFallbackCandidate[];
  persisted: number;
  elapsedMs: number;
}> {
  const started = Date.now();
  const key = `${req.kind}:${req.tmdbId}:${req.season || 1}:${req.episode || 1}:${(req.preferredAudio || []).join(",")}:${(req.preferredSubtitles || []).join(",")}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return {
      sources: cached.sources,
      fallbackCandidates: cached.fallbackCandidates,
      persisted: 0,
      elapsedMs: Date.now() - started,
    };
  }

  // Primary direct APIs and local DB are queried in parallel. Primary API results
  // win ties; local Spanish embeds/pages are returned separately for the legacy
  // resolver cascade and can never leak into the internal player as media URLs.
  const [apiSources, database] = await Promise.all([
    resolvePrimaryApis(req),
    sourcesFromDatabase(req),
  ]);

  const ranked = dedupeAndRank([...apiSources, ...database.direct]);
  const fallbackCandidates = rankFallbacks(database.fallbackCandidates);
  cache.set(key, {
    expires: Date.now() + CACHE_TTL_MS,
    sources: ranked,
    fallbackCandidates,
  });

  const persisted = req.persist ? await persistApiSources(req, apiSources) : 0;
  return {
    sources: ranked,
    fallbackCandidates,
    persisted,
    elapsedMs: Date.now() - started,
  };
}

export function clearProviderGatewayCache(): void {
  cache.clear();
}
