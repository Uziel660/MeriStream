import { prisma, normalizeTitle } from "./db";
import {
  getProviderPriority,
  isProviderAllowedInMainPath,
  normalizeLanguageTag,
  normalizeProviderId,
  renditionPreferenceScore,
} from "./providers/providerPolicy";
import { getHostHealth, isHostBlacklisted } from "./scrapers/hostHealth";
import { getDoramasflixHealth } from "./scrapers/adapters/DoramasflixAdapter";
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
import { subtitleGateway } from "./subtitles";
import type { SubtitleCandidate } from "./subtitles/types";

export type GatewayKind = DirectMediaKind;

export interface GatewayRequest {
  tmdbId: number;
  kind: GatewayKind;
  season?: number;
  episode?: number;
  /** TMDB original language used as a conservative identity signal. */
  originalLanguage?: string | null;
  preferredAudio?: string[];
  preferredSubtitles?: string[];
  persist?: boolean;
}

export type GatewaySubtitle = SubtitleTrack;
export type GatewaySource = PlayableSource & { score: number };

export interface GatewayFallbackCandidate {
  provider: string;
  providerGroup: "api" | "spanish-local" | "database";
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
  "cinecalidad", "gnula", "latanime", "tioanime", "doramasflix", "doramasia",
]);
const CACHE_TTL_MS = Math.max(5_000, Number(process.env.PROVIDER_GATEWAY_CACHE_MS || 120_000));
// Cuando ya existe una fuente local recuperable, un API externo lento no debe
// bloquear la primera interacción. Sin fallback local esperamos al API completo
// para no convertir la única posibilidad de reproducción en un falso vacío.
const PRIMARY_API_BUDGET_MS = 1_200;
const cache = new Map<string, {
  expires: number;
  sources: GatewaySource[];
  fallbackCandidates: GatewayFallbackCandidate[];
}>();

function subtitleProviderForUrl(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === "dl.opensubtitles.org" || host.endsWith(".opensubtitles.org")) return "opensubtitles-v3";
    if (host === "hls1.aniwatchtv.uk" || host === "hls2.aniwatchtv.uk" || host.endsWith(".aniwatchtv.uk")) return "zokoanime";
  } catch {
    return null;
  }
  return null;
}

function normalizeSubtitleTracks(raw: unknown): GatewaySubtitle[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: any) => {
    const sourceUrl = String(entry?.url || entry?.src || entry?.file || "").trim();
    const language = normalizeLanguageTag(entry?.language || entry?.lang) || "und";
    const label = entry?.label || entry?.name || language;
    // Direct provider tracks are accepted only from hosts with an adapter in
    // SubtitleProxy. The browser receives our own VTT route in every case.
    const provider = subtitleProviderForUrl(sourceUrl);
    if (provider) {
      const candidate: SubtitleCandidate = {
        id: `direct:${provider}:${language}:${sourceUrl}`,
        provider,
        language,
        label: String(label),
        sourceUrl,
        format: "srt",
      };
      const proxied = subtitleGateway.proxy.register(candidate);
      if (!proxied) return [];
      return [{ language, label: String(label), url: proxied }];
    }
    // Already-proxied tracks are safe to preserve when a database/source link
    // has gone through the subtitle gateway earlier in the request lifecycle.
    if (/^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i.test(sourceUrl)) {
      return [{ language, label: String(label), url: sourceUrl }];
    }
    return [];
  });
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
  // A legacy row can have only one external id. Fetch the public TMDB
  // crosswalk whenever either MAL or AniList is missing so Zoko's MAL
  // locator is still advertised after the missing side is recovered.
  if (req.kind === "anime" && (!legacy?.mal_id || !legacy?.anilist_id)) {
    publicAnime = await getPublicCatalogDetail("anime", req.tmdbId).catch(() => null);
  }
  return {
    tmdbId: req.tmdbId,
    kind: req.kind,
    season: req.season || 1,
    episode: req.episode || 1,
    preferredAudio: req.preferredAudio,
    preferredSubtitles: req.preferredSubtitles,
    originalLanguage: req.originalLanguage || null,
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
  // TMDB is the canonical identity. A title match is only a recovery path for
  // legacy rows that were imported before IDs were available. Never combine an
  // exact-ID row with title/base-title rows: doing so can attach an old alias
  // (for example "Overflow latino") to the canonical work and make a resolver
  // play the wrong episode.
  let mediaItems = await prisma.mediaItem.findMany({
    where: { kind: req.kind, tmdb_id: req.tmdbId },
    select: { id: true },
  });
  if (mediaItems.length === 0 && normalized) {
    mediaItems = await prisma.mediaItem.findMany({
      where: { kind: req.kind, tmdb_id: null, normalized_title: normalized },
      select: { id: true },
    });
  }
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
  for (const episode of episodes) {
    const canonicalPageProviders = new Set(
      episode.links
        .filter((candidate) => String(candidate.link_type).toLowerCase() !== "embed")
        .map((candidate) => normalizeProviderId(candidate.source_site)),
    );

    for (const link of episode.links) {
    const provider = normalizeProviderId(link.source_site);
    // Database rows from retired crawlers remain useful for explicit recovery,
    // but they must not leak into the normal gateway response. TioAnime is the
    // only legacy exception and is handled below as ZokoAnime fallback.
    if (!isProviderAllowedInMainPath(provider, req.kind)) continue;
    // Some crawls persisted both the provider's canonical page and an older
    // embed from that same provider. The page is the refreshable identity and
    // can generate a fresh server; keeping the stale embed ahead of it causes
    // needless failures (especially after Vimeos/VOE rotations).
    if (String(link.link_type).toLowerCase() === "embed" && canonicalPageProviders.has(provider)) continue;
    const linkKey = `${provider}|${link.url}`;
    if (seen.has(linkKey)) continue;
    seen.add(linkKey);
    const providerGroup = SPANISH_LOCAL.has(provider) ? "spanish-local" as const : "database" as const;
    // `language=sub|dub` is a rendition marker, not an audio language. Older
    // rows may only have that marker; never expose the literal marker as an
    // audio track in the player metadata.
    const renditionMarker = /^(?:sub|dub)$/i.test(String(link.language || "")) ? null : link.language;
    const audioLanguage = normalizeLanguageTag(link.audio_language || renditionMarker) || (SPANISH_LOCAL.has(provider) ? "es" : null);
    const subtitleLanguage = normalizeLanguageTag(link.subtitle_language);
    const subtitles = normalizeSubtitleTracks(link.subtitles);
    const score = renditionPreferenceScore({
      contentKind: req.kind,
      audio_language: audioLanguage,
      subtitle_language: subtitleLanguage,
      subtitles,
    });
    const stableLocator = String(link.canonical_locator || "").trim();
    // Older hydration runs could persist VidSrc's signed CDN URL as a direct
    // source. Never return that stale URL ahead of its renewable embed page;
    // use the canonical locator when available and discard it otherwise.
    if (hasSignedQuery(link.url)) {
      if (stableLocator && /^https?:\/\//i.test(stableLocator)) {
        fallbackCandidates.push({
          provider,
          providerGroup,
          url: stableLocator,
          canonicalLocator: stableLocator,
          type: "page",
          audioLanguage,
          subtitleLanguage,
          subtitles,
          score: score + (providerGroup === "spanish-local" ? 50 : 0),
          sourceStatus: link.source_status,
        });
      }
      continue;
    }
    const streamType = inferStreamType(link.url, link.link_type);

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

function vidsrcIdentityLocator(req: GatewayRequest): GatewayFallbackCandidate {
  const url = req.kind === "movie"
    ? `https://vidsrc.me/embed/movie/${req.tmdbId}`
    : `https://vidsrc.me/embed/tv/${req.tmdbId}/${req.season || 1}/${req.episode || 1}`;
  return {
    provider: "vidsrc",
    providerGroup: "api",
    url,
    canonicalLocator: url,
    type: "embed",
    audioLanguage: null,
    subtitleLanguage: null,
    subtitles: [],
    score: 80,
    sourceStatus: "identity-locator",
  };
}

async function persistApiSources(
  req: GatewayRequest,
  sources: GatewaySource[],
  fallbackCandidates: GatewayFallbackCandidate[] = [],
): Promise<number> {
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
    if (signed && stableLocator) {
      // A previous hydration may have stored the temporary CDN URL before its
      // provider signature was recognized. Remove all signed direct siblings
      // for this provider so the next gateway request cannot select an expired
      // URL from another mirror ahead of the renewable page locator.
      await prisma.sourceLink.deleteMany({
        where: {
          media_episode_id: episode.id,
          source_site: source.provider,
          link_type: "direct",
        },
      });
    }
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

  // ZokoAnime is a stable identity locator rather than a direct API result.
  // Persisting its MAL-based /sub and /dub pages lets the catalog retain the
  // source discovered during hydration and refresh the HLS just-in-time later.
  if (req.kind === "anime") {
    const zokoCandidates = fallbackCandidates.filter((candidate) =>
      normalizeProviderId(candidate.provider) === "zokoanime"
      && /^https?:\/\/zokoanime\.video\/stream\/(?:mal|anilist)\//i.test(candidate.url),
    );
    for (const candidate of zokoCandidates) {
      const persistedUrl = candidate.canonicalLocator?.trim() || candidate.url.trim();
      if (!/^https?:\/\//i.test(persistedUrl)) continue;
      const isDub = /\/dub(?:[/?#]|$)/i.test(persistedUrl);
      const linkType = isDub ? "dub" : "sub";
      const audioLanguage = candidate.audioLanguage || (isDub ? "en" : "ja");
      const subtitleLanguage = candidate.subtitleLanguage || null;
      const existing = await prisma.sourceLink.findFirst({
        where: {
          url: persistedUrl,
          source_site: "zokoanime",
          media_episode: {
            media_item_id: media.id,
            season_number: req.season || 1,
            episode_number: req.episode || 1,
          },
        },
        select: { id: true, link_type: true, audio_language: true, subtitle_language: true, canonical_locator: true },
      });
      const data = {
        media_episode_id: episode.id,
        source_site: "zokoanime",
        url: persistedUrl,
        link_type: linkType,
        language: linkType,
        audio_language: audioLanguage,
        subtitle_language: subtitleLanguage,
        host: "zokoanime.video",
        priority_tier: 12,
        canonical_locator: persistedUrl,
        source_status: "discovered",
        extraction_method: "identity_locator",
        resolver_version: "gateway-v2-zoko",
        is_verified: false,
        last_checked: new Date(),
      };
      if (!existing) {
        await prisma.sourceLink.create({ data });
        saved += 1;
      } else {
        const updates: Record<string, unknown> = {};
        if (existing.link_type !== linkType) updates.link_type = linkType;
        if (!existing.audio_language) updates.audio_language = audioLanguage;
        if (!existing.subtitle_language && subtitleLanguage) updates.subtitle_language = subtitleLanguage;
        if (!existing.canonical_locator) updates.canonical_locator = persistedUrl;
        if (Object.keys(updates).length > 0) await prisma.sourceLink.update({ where: { id: existing.id }, data: updates });
      }
    }
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
  const key = `${req.kind}:${req.tmdbId}:${req.season || 1}:${req.episode || 1}:${normalizeLanguageTag(req.originalLanguage)}:${(req.preferredAudio || []).join(",")}:${(req.preferredSubtitles || []).join(",")}`;
  const doramasHealth = getDoramasflixHealth();
  const doramasRecentlyDegraded = doramasHealth.state === "degraded"
    && typeof doramasHealth.lastCheckedAt === "number"
    && Date.now() - doramasHealth.lastCheckedAt < 90_000;
  const isDoramasSource = (source: { provider?: string | null; source_site?: string | null }) =>
    normalizeProviderId(source.provider || source.source_site || "") === "doramasflix";
  const filterDegradedDoramas = <T extends { provider?: string | null; source_site?: string | null }>(items: T[]): T[] =>
    doramasRecentlyDegraded ? items.filter((source) => !isDoramasSource(source)) : items;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    const cachedSources = filterDegradedDoramas(cached.sources);
    const cachedFallbacks = filterDegradedDoramas(cached.fallbackCandidates);
    const persisted = req.persist
      ? await persistApiSources(req, cachedSources, cachedFallbacks).catch(() => 0)
      : 0;
    return {
      sources: cachedSources,
      fallbackCandidates: cachedFallbacks,
      persisted,
      elapsedMs: Date.now() - started,
    };
  }

  // Primary direct APIs and local DB are queried in parallel. Primary API results
  // win ties; local Spanish embeds/pages are returned separately for the legacy
  // resolver cascade and can never leak into the internal player as media URLs.
  const apiPromise = resolvePrimaryApis(req);
  const database = await sourcesFromDatabase(req);
  const hasLocalRecovery = database.direct.length > 0 || database.fallbackCandidates.length > 0;

  let apiSources: GatewaySource[] = [];
  let apiTimedOut = false;
  if (hasLocalRecovery && !req.persist) {
    const result = await Promise.race([
      apiPromise
        .then((sources) => ({ sources, timedOut: false as const }))
        .catch(() => ({ sources: [] as GatewaySource[], timedOut: false as const })),
      new Promise<{ sources: GatewaySource[]; timedOut: true }>((resolve) => {
        setTimeout(() => resolve({ sources: [], timedOut: true }), PRIMARY_API_BUDGET_MS);
      }),
    ]);
    apiSources = result.sources;
    apiTimedOut = result.timedOut;
  } else {
    // Sin DB no hay un camino local que pueda arrancar el reproductor. Esperar
    // el API evita convertir una obra sin fallback en un falso "sin fuentes".
    apiSources = await apiPromise.catch(() => []);
  }

  const compose = (sources: GatewaySource[]) => {
    const ranked = dedupeAndRank([...sources, ...database.direct], req);
    const hasZokoCandidate = [...ranked, ...database.fallbackCandidates]
      .some((source) => normalizeProviderId(source.provider) === "zokoanime");
    // Doramasflix publishes a canonical page even when its own link service is
    // down. Keeping that page as the first candidate makes the player wait on a
    // locator that cannot resolve and looks like an infinite loading spinner.
    // Once the adapter has observed an upstream failure, temporarily suppress
    // only that provider and let the next fallback (normally VidSrc) start.
    // The short TTL keeps recovery automatic when Doramasflix comes back.
    const databaseFallbacks = database.fallbackCandidates.filter((source) => {
      if (!doramasRecentlyDegraded) return true;
      return normalizeProviderId(source.provider) !== "doramasflix";
    });
    // Expose VidSrc's deterministic locator whenever the direct probe did not
    // produce a playable source. A mirror may take several seconds to answer
    // (or be rejected by the server-side health probe) even though the same
    // public embed resolves successfully from the player's JIT path. Keeping
    // this locator available prevents a completed-but-empty API response from
    // making VidSrc disappear from the server selector. Respect the explicit
    // provider disable flag used by administrators.
    const disabledDirectProviders = new Set(
      String(process.env.MERISTREAM_DISABLED_DIRECT_PROVIDERS || "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const hasVidSrc = ranked.some((source) => normalizeProviderId(source.provider) === "vidsrc")
      || databaseFallbacks.some((source) => normalizeProviderId(source.provider) === "vidsrc");
    if (!disabledDirectProviders.has("vidsrc") && !hasVidSrc) {
      databaseFallbacks.push(vidsrcIdentityLocator(req));
    }
    const fallbackCandidates = rankFallbacks(
      databaseFallbacks.filter((source) => {
        const provider = normalizeProviderId(source.provider);
        return provider !== "tioanime" || hasZokoCandidate;
      }),
    );
    return { ranked, fallbackCandidates };
  };

  const composed = compose(apiSources);

  if (!apiTimedOut) {
    cache.set(key, {
      expires: Date.now() + CACHE_TTL_MS,
      sources: composed.ranked,
      fallbackCandidates: composed.fallbackCandidates,
    });
  } else {
    // La respuesta rápida usa DB; el API lento sigue vivo y actualiza la cache
    // al terminar. Así las siguientes reproducciones reciben VidSrc sin hacer
    // pagar su latencia de resolución en la primera interacción.
    void apiPromise.then(async (lateSources) => {
      const late = compose(lateSources);
      cache.set(key, {
        expires: Date.now() + CACHE_TTL_MS,
        sources: late.ranked,
        fallbackCandidates: late.fallbackCandidates,
      });
      if (req.persist) await persistApiSources(req, lateSources, late.fallbackCandidates).catch(() => 0);
    }).catch(() => undefined);
  }

  const persisted = !apiTimedOut && req.persist
    ? await persistApiSources(req, apiSources, composed.fallbackCandidates)
    : 0;
  return {
    sources: composed.ranked,
    fallbackCandidates: composed.fallbackCandidates,
    persisted,
    elapsedMs: Date.now() - started,
  };
}

export function clearProviderGatewayCache(): void {
  cache.clear();
}
