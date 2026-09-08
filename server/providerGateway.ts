import { prisma, normalizeTitle, normalizeBaseTitle } from "./db";
import {
  getProviderPriority,
  isProviderAllowedInMainPath,
  normalizeLanguageTag,
  normalizeProviderId,
  renditionPreferenceScore,
} from "./providers/providerPolicy";
import { getHostHealth, isHostBlacklisted } from "./scrapers/hostHealth";
import { isBlacklistedHost } from "./utils/streamSorter";
import { getDirectStreamProviders } from "./providers/api";
import type {
  DirectMediaKind,
  PlayableSource,
  ProviderRequest,
  SubtitleTrack,
} from "./providers/api";
import { inferStreamType } from "./providers/api/types";
import { hasSignedQuery } from "./resolutionMetadata";
import { getPublicCatalogDetail } from "./publicCatalog";

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
  "cinecalidad", "gnula", "latanime",
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
  })).filter((entry) =>
    // SubtitleGateway owns the only public subtitle delivery path. Direct
    // provider/CDN URLs are removed here before the response reaches the
    // browser; proxied tracks use the same token shape as the subtitle API.
    /^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i.test(entry.url)
  );
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
          select: { title: true, year: true, anilist_id: true, mal_id: true, kitsu_id: true },
        })
      : Promise.resolve(null),
  ]);
  let publicAnime: Awaited<ReturnType<typeof getPublicCatalogDetail>> = null;
  if (req.kind === "anime" && !legacy?.mal_id && !legacy?.anilist_id) {
    publicAnime = await getPublicCatalogDetail("anime", req.tmdbId).catch(() => null);
  }
  return {
    tmdbId: req.tmdbId,
    kind: req.kind,
    season: req.season || 1,
    episode: req.episode || 1,
    preferredAudio: req.preferredAudio,
    preferredSubtitles: req.preferredSubtitles,
    title: canonical?.title || legacy?.title || publicAnime?.title || null,
    year: canonical?.year || legacy?.year || publicAnime?.year || null,
    anilistId: legacy?.anilist_id || publicAnime?.anilist_id || null,
    malId: legacy?.mal_id || publicAnime?.mal_id || null,
    kitsuId: legacy?.kitsu_id || null,
  };
}

async function resolvePrimaryApis(req: GatewayRequest): Promise<GatewaySource[]> {
  const context = await mediaContext(req);
  const providers = getDirectStreamProviders(context);
  const settled = await Promise.allSettled(providers.map((provider) => provider.resolve(context)));
  const direct = settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);

  return direct.filter((source) => !isHostBlacklisted(source.url)).map((source) => ({
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
  const context = await mediaContext(req);
  const normalized = context.title ? normalizeTitle(context.title) : "";
  const baseNormalized = context.title ? normalizeBaseTitle(context.title) : "";
  const identityOr: Array<Record<string, unknown>> = [{ tmdb_id: req.tmdbId }];
  if (normalized) identityOr.push({ normalized_title: normalized });
  if (baseNormalized && baseNormalized !== normalized) identityOr.push({ base_normalized_title: baseNormalized });

  const mediaItems = await prisma.mediaItem.findMany({
    where: { kind: req.kind, OR: identityOr } as any,
    select: { id: true },
  });
  const mediaItemIds = Array.from(new Set(mediaItems.map((media) => media.id)));
  const fallbackCandidates: GatewayFallbackCandidate[] = [];

  // Zoko has no dependable catalog API. Once the public TMDB detail has been
  // crosswalked to MAL, its canonical public locator is enough to resolve the
  // stream on demand without importing a duplicate anime card into the DB.
  if (req.kind === "anime" && context.malId) {
    const episode = req.episode || 1;
    const subLocator = `https://zokoanime.video/stream/mal/${context.malId}/${episode}/sub`;
    const dubLocator = `https://zokoanime.video/stream/mal/${context.malId}/${episode}/dub`;
    fallbackCandidates.push(
      {
        provider: "zokoanime",
        providerGroup: "spanish-local",
        url: subLocator,
        canonicalLocator: subLocator,
        type: "embed",
        audioLanguage: "ja",
        subtitleLanguage: null,
        subtitles: [],
        score: 120,
        sourceStatus: "identity-locator",
      },
      {
        provider: "zokoanime",
        providerGroup: "spanish-local",
        url: dubLocator,
        canonicalLocator: dubLocator,
        type: "embed",
        audioLanguage: "en",
        subtitleLanguage: null,
        subtitles: [],
        score: 105,
        sourceStatus: "identity-locator",
      },
    );
  }
  if (mediaItemIds.length === 0) return { direct: [], fallbackCandidates };

  const episodes = await prisma.mediaEpisode.findMany({
    where: {
      media_item_id: { in: mediaItemIds },
      season_number: req.kind === "movie" ? 1 : (req.season || 1),
      episode_number: req.kind === "movie" ? 1 : (req.episode || 1),
    },
    include: { links: true },
  });
  if (episodes.length === 0) return { direct: [], fallbackCandidates };

  const direct: GatewaySource[] = [];
  const seen = new Set<string>();
  for (const episode of episodes) for (const link of episode.links) {
    const provider = normalizeProviderId(link.source_site);
    // Database rows from retired crawlers remain useful for explicit recovery,
    // but they must not leak into the normal gateway response. TioAnime is the
    // only legacy exception and is handled below as ZokoAnime fallback.
    if (!isProviderAllowedInMainPath(provider, req.kind)) continue;
    const linkKey = `${provider}|${link.url}`;
    if (seen.has(linkKey)) continue;
    seen.add(linkKey);
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

    if (streamType && provider !== "tioanime") {
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

function dedupeAndRank(sources: GatewaySource[], req: GatewayRequest): GatewaySource[] {
  const byKey = new Map<string, GatewaySource>();
  for (const source of sources) {
    const key = `${source.provider}|${source.url}`;
    const current = byKey.get(key);
    if (!current || source.score > current.score) byKey.set(key, source);
  }
  return [...byKey.values()].sort((a, b) => {
    // An explicit language request is authoritative. Without one, policy
    // priority expresses the curated primary/secondary order (Cinecalidad and
    // LatAnime before the generic API pool), while health can still open a
    // failover when a primary host is degraded or offline.
    const hasLanguagePreference = (req.preferredAudio || []).length > 0 || (req.preferredSubtitles || []).length > 0;
    if (hasLanguagePreference && b.score !== a.score) return b.score - a.score;
    const health = (source: GatewaySource) => {
      const state = getHostHealth(source.url).state;
      return state === "online" ? 3 : state === "unknown" ? 2 : state === "degraded" ? 1 : 0;
    };
    const healthDelta = health(b) - health(a);
    if (healthDelta !== 0) return healthDelta;
    const priorityDelta = getProviderPriority(a.provider) - getProviderPriority(b.provider);
    if (priorityDelta !== 0) return priorityDelta;
    const group = (source: GatewaySource) => source.providerGroup === "api" ? 2 : source.providerGroup === "spanish-local" ? 1 : 0;
    const groupDelta = group(b) - group(a);
    if (groupDelta !== 0) return groupDelta;
    return b.score - a.score;
  });
}

function rankFallbacks(values: GatewayFallbackCandidate[]): GatewayFallbackCandidate[] {
  const seen = new Set<string>();
  return [...values]
    .filter((value) => {
      // Never expose hosts that are deliberately disabled by the playback
      // policy (VOE/Mixdrop/Filemoon/etc.). The canonical provider page is
      // retained when available so its own resolver can discover a healthy
      // replacement such as Vimeos.
      if (isBlacklistedHost(value.url)) return false;
      const key = `${normalizeProviderId(value.provider)}|${value.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
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
    // Las respuestas JIT pueden traer una URL CDN firmada y efímera. Nunca la
    // usamos como identidad persistente: si hay un locator HTTP estable,
    // guardamos ese locator como página para resolverlo de nuevo bajo demanda;
    // de lo contrario la fuente vive únicamente en la respuesta actual.
    const signed = hasSignedQuery(source.url);
    const stableLocator = source.canonicalLocator?.trim();
    if (signed && (!stableLocator || !/^https?:\/\//i.test(stableLocator) || hasSignedQuery(stableLocator))) {
      continue;
    }
    const persistedUrl = signed ? stableLocator! : source.url;
    const persistedType = signed ? "page" : "direct";
    await prisma.sourceLink.upsert({
      where: {
        media_episode_id_source_site_url: {
          media_episode_id: episode.id,
          source_site: source.provider,
          url: persistedUrl,
        },
      },
      create: {
        media_episode_id: episode.id,
        source_site: source.provider,
        url: persistedUrl,
        link_type: persistedType,
        language: source.audioLanguage,
        audio_language: source.audioLanguage,
        subtitle_language: source.subtitleLanguage,
        subtitles: source.subtitles as any,
        canonical_locator: source.canonicalLocator || null,
        source_status: "discovered",
        extraction_method: signed ? "canonical_locator_jit" : "direct_api_jit",
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

  const ranked = dedupeAndRank([...apiSources, ...database.direct], req);
  const hasZokoCandidate = [...ranked, ...database.fallbackCandidates]
    .some((source) => normalizeProviderId(source.provider) === "zokoanime");
  const fallbackCandidates = rankFallbacks(
    database.fallbackCandidates.filter((source) => {
      const provider = normalizeProviderId(source.provider);
      return provider !== "tioanime" || hasZokoCandidate;
    }),
  );
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
