import "dotenv/config";
import http from "node:http";
import dns from "dns/promises";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import {
  analyzeUniversalUrl,
  extractStreamFromUrl,
  PRESET_SOURCES,
  getActivePresets,
  saveCustomPresetOverride,
  resetCustomPresetOverride,
  scraperManager,
} from "./server/universalScraper";
import { cleanQueryTitle, parseTitleQuery } from "./server/metadataEngine";
import { taskWorker } from "./server/taskWorker";
import { sourceRecoveryWorker, isCanonicalLocator } from "./server/sourceRecoveryWorker";
import { selectCanonicalPlaybackCandidate } from "./server/legacyCanonicalBridge";
import {
  saveShowWithDeduplication,
  getShowsFromDb,
  getShowsFromDbLite,
  filterShowsToMainPath,
  getShowByIdFromDb,
  deleteShowFromDb,
  clearAllShowsFromDb,
  updateShowFields,
  refreshShowStreams,
} from "./server/showService";
import { prisma, normalizeTitle, normalizeBaseTitle } from "./server/db";
import { lookupAnimeIdentityByTitle } from "./server/animeIdentity";
import { EmbedResolvers, isValidProvider, providerResolverRegistry, type ResolvedStreamMeta } from "./server/resolvers";
import { getStreamTier, sortStreamsByPriority, isBlacklistedHost, hostOfStreamUrl, familyKeyOfStreamUrl } from "./server/utils/streamSorter";
import { getServerPriorities, setServerOrder, moveServerPriority, hostOfUrl } from "./server/serverPriorities";
import { getSiteRating, getAllSiteRatings, upsertSiteRating } from "./server/siteRatingService";
import { siteFromDomain } from "./server/siteRatingService";
import {
  isProviderAllowedInCrossPlatformRecovery,
  getProviderPriority,
  isProviderAllowedInMainPath,
  normalizeProviderId,
} from "./server/providers/providerPolicy";
import {
  buildDisplayEpisodes,
  compareMainPathLinks,
  countDisplayPlatforms,
  filterMainPathLinks,
  mergeCanonicalEpisodes,
  playbackKindForCategory,
} from "./server/showEpisodePolicy";
import { PlaybackSessionStore, createPlaybackSessionHandlers } from "./server/playbackSessions";
import { streamHealthService } from "./server/streamHealthService";
import { listHostHealth, probeStream, reportPlaybackSignal } from "./server/scrapers/hostHealth";
import { runtimeBudget } from "./server/runtimeBudget";
import { assertSafePublicHttpUrl, UnsafeUrlError } from "./server/urlSafety";
import {
  buildResolveDeliveryResponse,
  DeliveryPlanner,
  ResolutionCoordinator,
} from "./server/deliveryPlanner";
import { classifySourceKind, isDirectMedia as isDirectMediaUrl, parseStreamExpiry } from "./server/resolutionMetadata";
import { isInvalidCatalogSource, sanitizeCatalogLandingPages } from "./server/catalogIntegrity";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { request } from "undici";
import { buildProxyHeaders } from "./server/hostProfiles";
import { APP_CONFIG, localAllowedOrigins } from "./app.config";
import { castMediaCors, isCastMediaPath } from "./server/castMediaCors";
import { backfillMissingMetadata, getBackfillStatus, forceShowMetadata } from "./server/metadataBackfill";
import { reconcileSequelsByTmdb, mergeTwoShows } from "./server/reconcileCatalog";
import { startWriteBufferDrainer, drainWriteBuffer } from "./server/writeBuffer";
import {
  getVerificationStatus,
  updateVerificationConfig,
  runVerification,
  pauseVerification,
  resumeVerification,
  stopVerification,
} from "./server/verificationWorker";
import { handleMegaStream, probeMegaFile } from "./server/resolvers/megaStream";
import { getMp4SizeCacheEntry, setMp4SizeCacheEntry } from "./server/mp4SizeCache";
import {
  logProxyRequest,
  logPlayerEvent,
  getHostStats,
  getProviderHealthStats,
  getRecentLogs,
  getRecentPlayerEvents,
  clearLogs,
  getLogFilePaths,
  maskSignedTokens,
} from "./server/networkLogger";
import { authRouter, requireAuth, type AuthRequest } from "./server/auth";
import { progressRouter } from "./server/progress";
import { recommendationsRouter } from "./server/recommendations";
import { userListsRouter } from "./server/userLists";
import { roomsRouter, setupWatchPartyWebSocket } from "./server/watchParty";
import {
  authLimiter,
  searchLimiter,
  catalogPublicLimiter,
  playbackLimiter,
  reportsLimiter,
  roomsLimiter,
  generalLimiter,
} from "./server/rateLimiter";
import { providerGatewayRouter } from "./server/providerGatewayRouter";
import { resolveByTmdb } from "./server/providerGateway";
import { getDoramasflixHealth } from "./server/scrapers/adapters/DoramasflixAdapter";
import { subtitleGateway, subtitleRouter } from "./server/subtitles";
import { openSubtitlesRouter } from "./server/openSubtitlesRouter";
import { subtitleTextToWebVtt } from "./server/subtitleFormat";
import {
  getPublicCatalog,
  getPublicCatalogByIdentifier,
  getPublicCatalogDetail,
  getPublicCatalogRelated,
  parsePublicCatalogIdentifier,
  parseUniversalCatalogQuery,
  searchPublicCatalogExternal,
} from "./server/publicCatalog";
import {
  getAdminCatalogVisibility,
  getCatalogVisibility,
  isCatalogItemHidden,
  isGenreHidden,
  saveCatalogVisibility,
} from "./server/catalogVisibility";
import {
  adminLogin,
  adminLogout,
  adminSession,
  hasValidAdminSession,
  requireAdminForControlPlane,
} from "./server/adminAuth";
import { getUnifiedCatalogCounts } from "./server/catalogCounts";
import { getIdentityRepairStatus } from "./server/identityRepairStatus";
import {
  getAdminOperationDefinitions,
  getAdminOperation,
  getAdminOperationLog,
  listAdminOperations,
  startAdminOperation,
  cancelAdminOperation,
  deleteAdminOperation,
} from "./server/adminOperations";
import { previewAdminIdentity, type AdminIdentitySource } from "./server/adminIdentity";
import {
  getCatalogPolicy,
  getCatalogPolicyProviders,
  saveCatalogPolicy,
  isProviderAllowedForWork,
} from "./server/catalogPolicy";
import {
  createCatalogReport,
  getCatalogReportSummary,
  listCatalogReports,
  updateCatalogReport,
} from "./server/catalogReports";

const isDirectMedia = (url: string): boolean => EmbedResolvers.isDirectMediaUrl(url) || isDirectMediaUrl(url);

const deliveryPlanner = new DeliveryPlanner();

/**
 * Busca fichas que parecen representar el mismo título. La comprobación es
 * deliberadamente informativa: nunca fusiona por sí sola y deja la decisión
 * final al moderador del panel.
 */
async function findSimilarShowCandidates(
  showId: string,
  title: string,
  category: string | null | undefined,
  tmdbId: number | null,
): Promise<any[]> {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (cleanTitle.length < 3) return [];
  const isMovie = String(category || "").toLowerCase() === "movie";
  const categorySql = isMovie ? "AND LOWER(category) = 'movie'" : "AND LOWER(category) IN ('anime', 'series')";
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT id, title, category, tmdb_id, poster_url, year,
        GREATEST(
          similarity(LOWER(COALESCE(title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(english_title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(original_title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(japanese_title, '')), LOWER($2))
        ) AS similarity
      FROM "Show"
      WHERE id <> $1
        AND ($3::int IS NULL OR tmdb_id IS DISTINCT FROM $3::int)
        ${categorySql}
        AND GREATEST(
          similarity(LOWER(COALESCE(title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(english_title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(original_title, '')), LOWER($2)),
          similarity(LOWER(COALESCE(japanese_title, '')), LOWER($2))
        ) >= 0.30
      ORDER BY similarity DESC, updated_at DESC
      LIMIT 6
    `, showId, cleanTitle, tmdbId);
    return (rows as any[]).map((row) => ({ ...row, similarity: Number(row.similarity || 0) }));
  } catch {
    // pg_trgm es opcional en instalaciones antiguas. El fallback mantiene una
    // señal útil con las claves normalizadas sin bloquear la edición de TMDB.
    const normalized = normalizeTitle(cleanTitle);
    const base = normalizeBaseTitle(cleanTitle) || normalized;
    if (!normalized && !base) return [];
    const rows = await prisma.show.findMany({
      where: {
        id: { not: showId },
        ...(tmdbId == null ? {} : { tmdb_id: { not: tmdbId } }),
        category: isMovie ? "movie" : { in: ["anime", "series"] },
        OR: [
          { normalized_title: { contains: normalized, mode: "insensitive" } },
          { base_normalized_title: { contains: base, mode: "insensitive" } },
          { title: { contains: cleanTitle.split(/\s+/)[0], mode: "insensitive" } },
        ],
      },
      select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true, year: true },
      orderBy: { updated_at: "desc" },
      take: 6,
    });
    return rows.map((row) => ({ ...row, similarity: 0.3 }));
  }
}

const resolutionCoordinator = new ResolutionCoordinator(
  (url) => {
    // VidSrc's signed HLS needs its provider-specific chain and headers. Keep
    // the existing lightweight resolver for every other locator so this fix
    // remains scoped to the isolated VidSrc validation.
    const resolver = providerResolverRegistry.findResolver(url);
    return resolver?.name === "VidSrc"
      ? resolver.resolve(url)
      : EmbedResolvers.resolveWithMeta(url);
  },
  { maxEntries: 128 },
);

// VidSrc signs a fresh CDN URL during every provider resolution. Do not reuse
// the generic locator lease for playback sessions: a token can be rejected by
// the CDN before the metadata lease expires, and renewal must obtain a new
// player/embed/hash chain.
const resolvePlaybackLocator = async (url: string) => {
  const resolver = providerResolverRegistry.findResolver(url);
  return resolver?.name === "VidSrc"
    ? resolver.resolve(url)
    : resolutionCoordinator.resolve(url);
};

async function visibleCatalogShows<T extends { shows?: any[] }>(result: T): Promise<T> {
  const visibility = await getCatalogVisibility();
  if (!Array.isArray(result.shows)) return result;
  return {
    ...result,
    shows: result.shows.filter((show) => !isCatalogItemHidden(show, visibility)),
  };
}

/**
 * Consulta una identidad externa desde el panel y devuelve también las
 * coincidencias locales. Mantener esta operación en el backend evita que el
 * frontend tenga que adivinar si un valor es TMDB o IMDb y permite abrir una
 * ficha editable aunque todavía no exista en PostgreSQL.
 */
async function lookupAdminCatalogIdentifier(
  identifier: string,
  options?: { kind?: string; year?: number }
): Promise<any | null> {
  const query = String(identifier || "").trim();
  if (!query) return null;

  const parsed = parseUniversalCatalogQuery(query, options?.year);
  const searchResult = await searchPublicCatalogExternal(parsed, {
    kind: options?.kind,
    year: options?.year,
    limit: 20,
  });

  const { exact_match, candidates, shows: externalShows } = searchResult;

  // 1. Gather IDs for exact local database lookup
  const candidateTmdbIds = candidates
    .map((c) => c.tmdb_id)
    .filter((id): id is number => typeof id === "number" && id > 0);
  const candidateImdbIds = candidates
    .map((c) => c.imdb_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const exactWhereConditions: any[] = [];
  if (parsed.tmdbId) exactWhereConditions.push({ tmdb_id: parsed.tmdbId });
  if (parsed.imdbId) exactWhereConditions.push({ imdb_id: parsed.imdbId });
  if (parsed.tvdbId) exactWhereConditions.push({ tvdb_id: parsed.tvdbId });

  // If top candidate IDs are known from search, check local database for them
  if (candidateTmdbIds.length > 0) {
    exactWhereConditions.push({ tmdb_id: { in: candidateTmdbIds.slice(0, 5) } });
  }
  if (candidateImdbIds.length > 0) {
    exactWhereConditions.push({ imdb_id: { in: candidateImdbIds.slice(0, 5) } });
  }

  const [localShows, localMedia] = exactWhereConditions.length > 0
    ? await Promise.all([
      prisma.show.findMany({
        where: { OR: exactWhereConditions },
        select: {
          id: true, title: true, category: true, tmdb_id: true, imdb_id: true,
          tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true,
          anidb_id: true, poster_url: true, year: true,
        },
        orderBy: { created_at: "desc" },
        take: 20,
      }),
      prisma.mediaItem.findMany({
        where: { OR: exactWhereConditions },
        select: {
          id: true, title: true, kind: true, tmdb_id: true, imdb_id: true,
          tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true,
          anidb_id: true, poster_url: true, year: true,
        },
        orderBy: { created_at: "desc" },
        take: 20,
      }),
    ])
    : [[], []];

  // 2. Query local title matches by normalized keys
  const titleSearchStrings = [
    query,
    parsed.title,
    ...candidates.flatMap((c) => [c.title, c.original_title]),
    ...externalShows.flatMap((s) => [s.title, s.original_title, s.english_title]),
  ].filter(Boolean);

  const titleKeys = [...new Set(
    titleSearchStrings
      .map((title) => normalizeTitle(String(title || "")))
      .filter((title) => title.length >= 3)
  )];

  const titleMatches = titleKeys.length > 0
    ? await prisma.show.findMany({
      where: {
        OR: titleKeys.flatMap((title) => [
          { normalized_title: title },
          { base_normalized_title: title },
        ]),
      },
      select: {
        id: true, title: true, category: true, tmdb_id: true, imdb_id: true,
        poster_url: true, year: true,
      },
      orderBy: { updated_at: "desc" },
      take: 20,
    })
    : [];

  return {
    ok: true,
    query,
    exact_match,
    candidates,
    // Legacy / AdminPanel compatibility fields
    identifier: query,
    tmdb_id: parsed.tmdbId ?? candidates[0]?.tmdb_id ?? null,
    imdb_id: parsed.imdbId ?? candidates[0]?.imdb_id ?? null,
    tmdb: externalShows,
    local: {
      shows: localShows,
      media_items: localMedia,
      title_matches: titleMatches,
    },
  };
}

function publicCatalogItem(kind: string, tmdbId: string, genres?: unknown) {
  return {
    id: `tmdb-${kind}-${tmdbId}`,
    tmdb_id: Number(tmdbId),
    kind,
    category: kind,
    genres,
  };
}

// Stable browser-facing HLS sessions. Renewal uses the lightweight, single-flight
// HTTP/static resolver only; Chromium is intentionally absent from production.
const playbackSessions = new PlaybackSessionStore({
  resolver: resolvePlaybackLocator,
  // A 2-hour VOD has ~800 ten-second segments per quality. The class default
  // (300) evicts the first segment ids while rewriting the level playlist,
  // producing browser-visible 404s. Keep enough opaque locators for one active
  // user while bounding abandoned sessions for the low-memory ASUS host.
  maxSessions: 8,
  // VidSrc VOD playlists can expose 4k+ short segments per rendition. Keep
  // every opaque locator for the active session so the first segment is not
  // evicted while a long child playlist is being rewritten. The entries only
  // contain short upstream URL metadata; media bytes are never buffered here.
  maxResourcesPerSession: 10_000,
});
const playbackSessionHandlers = createPlaybackSessionHandlers(
  playbackSessions,
  "/api/v1/playback",
  {
    // Existing relays are never rejected: the budget only uses these balanced
    // counters to stop admitting new sessions and speculative work under pressure.
    onRelayStart: () => { runtimeBudget.beginRelay(); },
    onRelayEnd: () => { runtimeBudget.endRelay(); },
  },
);

const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_NETWORK_RETRIES = 3;
/** Saltos mÃ¡ximos de redirect que sigue el proxy en la rama MP4 (#21). */
const MAX_PROXY_REDIRECTS = 5;

/**
 * Ordena streams por la jerarquÃ­a de tiers del backend (streamSorter) tras
 * filtrar la lista negra (voe/mixdrop/filemoon). Devuelve objetos con tier
 * explÃ­cito para que el frontend NO replique la tabla.
 */
function rankStreams(streams: string[], hostPriority?: Record<string, number>): Array<{ url: string; type: "direct" | "embed"; tier: number; host: string | null }> {
  const seen = new Set<string>();
  const entries = streams.filter((u) => {
    if (!u || seen.has(u)) return false;
    if (!isValidProvider(u) || isBlacklistedHost(u)) return false;
    seen.add(u);
    return true;
  });
  return sortStreamsByPriority(
    entries.map((url) => ({
      url,
      tier: getStreamTier(url),
      host: (() => {
        try {
          return new URL(url).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })(),
    })),
    hostPriority
  );
}

/**
 * Evita que una URL de navegación del catálogo termine como candidato de
// isInvalidCatalogSource se centraliza en server/catalogIntegrity.ts
export { isInvalidCatalogSource } from "./server/catalogIntegrity";

/**
 * Identidad estable de un candidato para no gastar la cuota de un proveedor
 * con el mismo HLS firmado varias veces. Los tokens cambian por captura, pero
 * el host-familia y la ruta del recurso permanecen; se conservan parámetros
 * funcionales (por ejemplo idioma) y solo se omiten credenciales efímeras.
 */
function streamCandidateIdentity(url: string): string {
  try {
    const parsed = new URL(url);
    const volatile = new Set([
      "t", "s", "e", "exp", "expires", "token", "sig", "signature",
      "auth", "p1", "p2", "srv", "i", "sp", "asn",
    ]);
    for (const key of [...parsed.searchParams.keys()]) {
      if (volatile.has(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${familyKeyOfStreamUrl(parsed.toString())}:${path}?${parsed.searchParams.toString()}`;
  } catch {
    return url.trim();
  }
}

/**
 * Cascada multi-fuente (F4): agrupa SourceLinks por sitio de origen, ordena los
 * sitios por SiteRating DESC y dentro de cada sitio por tier ASC. El frontend
 * recorre esta lista plana como cadena de fallback automática.
 */
export async function buildMultiSourceCascade(
  sourceLinks: Array<{
    url: string;
    source_site: string;
    priority_tier?: number | null;
    failure_reason?: string;
    link_type?: string | null;
    canonical_locator?: string | null;
    host?: string | null;
    source_status?: string | null;
    extraction_method?: string | null;
    resolver_version?: string | null;
    is_verified?: boolean;
    language?: string | null;
    audio_language?: string | null;
    subtitle_language?: string | null;
    subtitles?: unknown;
  }>,
  options: { maxPerSite?: number; maxTotal?: number } = { maxPerSite: 2, maxTotal: 8 }
) {
  const rawSiteByUrl = new Map<string, string>();
  const priorityTierByUrl = new Map<string, number>();
  const failureReasonByUrl = new Map<string, string>();
  const canonicalLocatorByUrl = new Map<string, string>();
  const sourceStatusByUrl = new Map<string, string>();
  const renditionByUrl = new Map<string, {
    link_type?: string;
    language?: string;
    audio_language?: string;
    subtitle_language?: string;
    subtitles?: unknown;
  }>();

  for (const link of sourceLinks) {
    if (link?.url) {
      const cleanUrl = link.url.trim();
      rawSiteByUrl.set(cleanUrl, link.source_site || "");
      if (link.priority_tier != null) {
        priorityTierByUrl.set(cleanUrl, link.priority_tier);
      }
      if (link.failure_reason != null) {
        failureReasonByUrl.set(cleanUrl, link.failure_reason);
      }
      const canonicalLocator = typeof link.canonical_locator === "string" ? link.canonical_locator.trim() : "";
      if (canonicalLocator) canonicalLocatorByUrl.set(cleanUrl, canonicalLocator);
      if (link.source_status) sourceStatusByUrl.set(cleanUrl, link.source_status);
      renditionByUrl.set(cleanUrl, {
        ...(renditionByUrl.get(cleanUrl) || {}),
        ...(link.link_type ? { link_type: link.link_type } : {}),
        ...(link.language ? { language: link.language } : {}),
        ...(link.audio_language ? { audio_language: link.audio_language } : {}),
        ...(link.subtitle_language ? { subtitle_language: link.subtitle_language } : {}),
        ...(link.subtitles !== undefined ? { subtitles: link.subtitles } : {}),
      });
    }
  }

  const normalizeSite = (rawSite: string | undefined): string => {
    if (!rawSite) return "unknown";
    const domainSite = siteFromDomain(rawSite);
    return domainSite || rawSite.toLowerCase().trim() || "unknown";
  };

  // Prioridades de servidor definidas por el usuario (probador por plataforma):
  // se combinan las de TODAS las plataformas involucradas en la cascada.
  const sites0 = Array.from(new Set(sourceLinks.map((s) => s.source_site).filter(Boolean) as string[]));
  const hostPriority: Record<string, number> = {};
  for (const s of sites0) Object.assign(hostPriority, getServerPriorities(s));

  const validUrls = Array.from(
    new Set(
      sourceLinks
        .map((s) => s?.url?.trim())
        .filter((url): url is string => Boolean(url) && !isInvalidCatalogSource(url))
    )
  );
  const ranked = rankStreams(validUrls, hostPriority);

  const sites = Array.from(new Set(ranked.map((r) => normalizeSite(rawSiteByUrl.get(r.url)))));
  const ratings = await Promise.all(sites.map(async (site) => ({ site, rating: await getSiteRating(site) })));
  const ratingBySite = new Map(ratings.map((r) => [r.site, r.rating]));

  const mapped = ranked
    .map((entry) => {
      const rawSite = rawSiteByUrl.get(entry.url) || "";
      const site = normalizeSite(rawSite);
      const sourceKind = classifySourceKind(entry.url);
      const parsedExpiry = parseStreamExpiry(entry.url).expiresAt;
      // Respeta el localizador canónico guardado por el importador/resolver.
      // Para enlaces históricos sin metadata, solo las páginas/directos estables
      // pueden autodescribirse como localizador; un .m3u8 firmado no se promueve.
      const persistedLocator = canonicalLocatorByUrl.get(entry.url);
      const canonicalLocator = persistedLocator || (sourceKind === "ephemeral_direct" ? undefined : entry.url);
      const expiresAt = sourceKind === "ephemeral_direct" ? parsedExpiry : undefined;
      const explicitlyExpired = (parsedExpiry !== undefined && parsedExpiry <= Date.now()) ||
                                (expiresAt !== undefined && expiresAt <= Date.now());

      // Regla 3: Excluye de la cascada URLs explícitamente vencidas sin canonical locator.
      if (explicitlyExpired && !canonicalLocator) {
        return null;
      }

      const explicitTier = priorityTierByUrl.get(entry.url);
      const tier = explicitTier ?? entry.tier;
      const renewable = Boolean(canonicalLocator);
      const failureReason = failureReasonByUrl.get(entry.url) ?? (explicitlyExpired && !canonicalLocator ? ("expired_without_locator" as const) : undefined);
      const proxyable = entry.type === "direct" && !explicitlyExpired;
      const rendition = renditionByUrl.get(entry.url) || {};
      const sourceStatus = sourceStatusByUrl.get(entry.url);

      return {
        ...entry,
        tier,
        original_url: entry.url,
        canonical_locator: canonicalLocator,
        is_proxyable: proxyable,
        is_refreshable: renewable,
        // Un directo vencido con localizador canónico sigue siendo un intento
        // nativo JIT (no un iframe): el frontend renovará el manifiesto antes
        // de conectarlo y solo entonces decidirá si necesita proxy.
        delivery_mode:
          entry.type === "direct" && (proxyable || Boolean(canonicalLocator))
            ? ("direct_trial" as const)
            : ("embed" as const),
        ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
        ...(failureReason !== undefined ? { failure_reason: failureReason } : {}),
        ...(sourceStatus ? { source_status: sourceStatus } : {}),
        source_site: site,
        rating: ratingBySite.get(site) ?? 5,
        ...rendition,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      // Dentro de la misma plataforma: primero los hosts con prioridad manual.
      const pa = hostPriority[familyKeyOfStreamUrl(a.url)];
      const pb = hostPriority[familyKeyOfStreamUrl(b.url)];
      if (pa !== undefined || pb !== undefined) {
        const na = pa ?? Number.MAX_SAFE_INTEGER;
        const nb = pb ?? Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
      }
      return a.tier - b.tier;
    });

  // Regla 2: Devuelve una cascada acotada, máximo 2 candidatos por source_site y máximo 8 en total.
  const maxPerSite = options?.maxPerSite ?? 2;
  const maxTotal = options?.maxTotal ?? 8;
  const perSiteCount = new Map<string, number>();
  const perSiteLandingCount = new Map<string, number>();
  const identitiesBySite = new Map<string, Set<string>>();
  const bounded: typeof mapped = [];

  for (const candidate of mapped) {
    const s = candidate.source_site;
    const langKey = candidate.audio_language || candidate.language || candidate.subtitle_language || "und";
    const isLanding = classifySourceKind(candidate.url) === "page" && isCanonicalLocator(candidate.url);
    if (isLanding) {
      const landingKey = `${s}|${langKey}`;
      const landingCount = perSiteLandingCount.get(landingKey) || 0;
      if (landingCount >= 1) continue;
      perSiteLandingCount.set(landingKey, landingCount + 1);
    }
    const siteLangKey = `${s}|${langKey}`;
    const count = perSiteCount.get(siteLangKey) || 0;
    if (count >= maxPerSite) {
      continue;
    }
    const identities = identitiesBySite.get(s) || new Set<string>();
    const identity = streamCandidateIdentity(candidate.canonical_locator || candidate.url);
    if (identities.has(identity)) continue;
    identities.add(identity);
    identitiesBySite.set(s, identities);
    perSiteCount.set(siteLangKey, count + 1);
    bounded.push(candidate);
    if (bounded.length >= maxTotal) {
      break;
    }
  }

  return bounded;
}

/**
 * If an episode has a canonical page/embed, prefer it over historical signed
 * manifests from any provider. The page is resolved just in time and can
 * create a renewable proxy session; the signed manifest remains at the end as
 * a rescue candidate in case the canonical provider is temporarily unavailable.
 */
function keepCanonicalCandidatesFirst(
  ranked: Awaited<ReturnType<typeof buildMultiSourceCascade>>,
  sourceLinks: Array<{ url: string; source_site: string; link_type?: string | null }>,
) {
  const canonicalSites = new Set(
    sourceLinks
      .filter((link) => {
        const kind = classifySourceKind(link.url);
        return (link.link_type === "page" || link.link_type === "embed" || kind === "page" || kind === "embed") && isCanonicalLocator(link.url);
      })
      .map((link) => siteFromDomain(link.source_site) || link.source_site.toLowerCase().trim())
      .filter(Boolean),
  );
  if (canonicalSites.size === 0) return ranked;
  const rank = (entry: (typeof ranked)[number]): number => {
    const kind = classifySourceKind(entry.url);
    if ((kind === "page" || kind === "embed") && isCanonicalLocator(entry.url)) return 0;
    if (kind === "stable_direct") return 1;
    if (kind === "ephemeral_direct") return 2;
    return 1;
  };
  return ranked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const kindDelta = rank(a.entry) - rank(b.entry);
      if (kindDelta !== 0) return kindDelta;
      // When two canonical locators are both awaiting JIT resolution, keep
      // the configured primary/secondary provider order deterministic. Site
      // ratings remain useful inside the generic cascade, but must not make
      // Gnula outrank Cinecalidad on the normal Spanish path.
      const providerDelta = getProviderPriority(a.entry.source_site) - getProviderPriority(b.entry.source_site);
      return providerDelta !== 0 ? providerDelta : a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/**
 * Busca episodios de la misma obra en OTRAS plataformas y resuelve sus streams en paralelo.
 * Devuelve un mapa de plataforma → streams[] para merge con la plataforma primaria.
 */
async function resolveCrossPlatformStreams(
  primaryEpisode: any,
  primaryShow: any,
  primarySite: string,
  maxExtraPlatforms = 3,
  timeoutMs = 8000
): Promise<Map<string, Array<{ url: string; type: "direct" | "embed"; tier: number; host: string | null }>>> {
  const result = new Map<string, Array<{ url: string; type: "direct" | "embed"; tier: number; host: string | null }>>();
  if (!primaryShow?.title) return result;

  try {
    const epNum = primaryEpisode.episode_number ?? primaryEpisode.number ?? 1;
    const season = parseTitleQuery(primaryShow.title).season ?? 1;
    const kind = primaryShow.category || "anime";
    const platformMap = new Map<string, string>();

    // La UI todavía reproduce con Episode.id legacy. Recuperar primero los
    // SourceLink del MediaItem espejo para no perder las demás plataformas.
    const mediaItems = await prisma.mediaItem.findMany({
      where: primaryShow.tmdb_id
        ? { tmdb_id: primaryShow.tmdb_id, kind }
        : {
            kind,
            OR: [
              { base_normalized_title: primaryShow.base_normalized_title || primaryShow.normalized_title },
              { normalized_title: primaryShow.normalized_title },
            ],
          },
      select: { id: true },
      orderBy: { created_at: "asc" },
    });
    if (mediaItems.length > 0) {
      const sourceLinks = await prisma.sourceLink.findMany({
        where: {
          media_episode: {
            media_item_id: { in: mediaItems.map((item) => item.id) },
            season_number: season,
            episode_number: epNum,
          },
        },
        select: { url: true, source_site: true, main_path_override: true },
        orderBy: [{ priority_tier: "asc" }, { last_checked: "desc" }],
      });
      const hasZoko = sourceLinks.some((link) =>
        normalizeProviderId(link.source_site || link.url) === "zokoanime"
      );
      for (const link of sourceLinks) {
        const provider = normalizeProviderId(link.source_site || link.url);
        // Cross-platform recovery must obey the same allow-list as the public
        // ficha and canonical playback path. Without this gate, a legacy
        // Episode id could reintroduce AnimeFLV/LaMovie/Doramasflix/TioPlus
        // after the primary resolver had correctly excluded them.
        if (!isProviderAllowedForWork(provider, kind as any, { showOverrides: primaryShow.main_path_overrides, linkOverride: link.main_path_override }) && !isProviderAllowedInCrossPlatformRecovery(provider, kind as any, hasZoko)) {
          continue;
        }
        const site = siteFromDomain(link.source_site) || siteFromDomain(hostOfStreamUrl(link.url));
        if (!site || site === primarySite) continue;
        const current = platformMap.get(site);
        const isOriginPage = siteFromDomain(hostOfStreamUrl(link.url)) === site;
        const currentIsOriginPage = current
          ? siteFromDomain(hostOfStreamUrl(current)) === site
          : false;
        if (!current || (isOriginPage && !currentIsOriginPage)) platformMap.set(site, link.url);
      }
    }

    // Compatibilidad para filas antiguas que todavía no tienen SourceLink.
    const sameTitleEpisodes = await prisma.episode.findMany({
      where: {
        show: primaryShow.tmdb_id ? { tmdb_id: primaryShow.tmdb_id } : { title: primaryShow.title },
        episode_number: epNum,
        id: { not: primaryEpisode.id },
        source_url: { not: "" },
      },
      take: 30,
    });
    for (const ep of sameTitleEpisodes) {
      const site = siteFromDomain(hostOfStreamUrl(ep.source_url || ""));
      const provider = normalizeProviderId(ep.source_url || site);
      // This compatibility branch has no canonical link inventory. TioAnime
      // is therefore never admitted here; the canonical SourceLink branch
      // above can allow it only when ZokoAnime is present.
      if (!isProviderAllowedForWork(provider, kind as any, { showOverrides: primaryShow.main_path_overrides }) && !isProviderAllowedInCrossPlatformRecovery(provider, kind as any, false)) continue;
      if (site && site !== primarySite && !platformMap.has(site)) {
        platformMap.set(site, ep.source_url);
      }
    }

    // Tomar solo las plataformas con mejor rating
    const entries = Array.from(platformMap.entries());
    const rated = await Promise.all(
      entries.map(async ([site, url]) => ({
        site,
        url,
        rating: await getSiteRating(site),
      }))
    );
    rated.sort((a, b) => b.rating - a.rating);
    const topPlatforms = rated.slice(0, maxExtraPlatforms);

    // Resolver en paralelo con timeout
    const resolutions = await Promise.allSettled(
      topPlatforms.map(async ({ site, url }) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const extracted = await Promise.race([
            extractStreamFromUrl(url),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            }),
          ]);
          const streams = Array.from(
            new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
          );
          const ranked = rankStreams(streams, getServerPriorities(site));
          return { site, ranked };
        } catch {
          return { site, ranked: [] as Array<{ url: string; type: "direct" | "embed"; tier: number; host: string | null }> };
        } finally {
          if (timer) clearTimeout(timer);
        }
      })
    );

    for (const r of resolutions) {
      if (r.status === "fulfilled" && r.value.ranked.length > 0) {
        result.set(r.value.site, r.value.ranked);
      }
    }
  } catch (e: any) {
    // Error silencioso — la plataforma primaria ya tiene streams
  }
  return result;
}

/**
 * Bridges legacy Show/Episode ids to the canonical MediaEpisode graph.
 *
 * Legacy rows often contain the last signed .m3u8 returned by a scraper. That
 * value is useful as a final compatibility fallback, but it must not be the
 * first playback candidate: it cannot be renewed and commonly rejects the
 * browser or proxy with 403. If the catalogue has a matching MediaEpisode,
 * return its page/embed SourceLinks so the normal JIT resolver can classify
 * the delivery mode and create a lightweight proxy session when required.
 */
async function findCanonicalMediaEpisodeForLegacy(
  foundEpisode: any,
  targetShow: any,
): Promise<{ mediaEpisode: any; ranked: Awaited<ReturnType<typeof buildMultiSourceCascade>> } | null> {
  if (!targetShow || (!targetShow.title && targetShow.tmdb_id == null)) return null;

  const title = String(targetShow.title || targetShow.normalized_title || "").trim();
  const normalized = normalizeTitle(title || String(targetShow.normalized_title || ""));
  const baseNormalized = normalizeBaseTitle(title || String(targetShow.base_normalized_title || ""));
  // TMDB comparte el espacio numérico entre películas y TV. El puente legacy
  // conserva el namespace para no devolver accidentalmente una obra de otro
  // tipo cuando ambos comparten el mismo entero.
  const category = String(targetShow.category || "").toLowerCase();
  const playbackKind = category === "movie" ? "movie" : category === "series" ? "series" : "anime";
  const kindFilter = category === "movie"
    ? { kind: "movie" }
    : category === "anime" || category === "series"
      ? { kind: { in: ["anime", "series"] } }
      : {};

  // Algunos catálogos guardan el mismo anime con su nombre japonés en una
  // fila (Jigokuraku) y el nombre inglés en otra (Hell's Paradise). Kitsu
  // aporta los aliases públicos para reunir esas filas cuando falta TMDB en
  // la importación original. Si la API no responde, el matching local sigue
  // funcionando como antes.
  const animeIdentity = playbackKind === "anime" && targetShow.tmdb_id == null
    ? await lookupAnimeIdentityByTitle(title)
    : null;
  const titleKeys = [...new Set([
    normalized,
    baseNormalized,
    ...(animeIdentity?.normalizedAliases || []),
  ].filter(Boolean))];
  const where: Array<Record<string, unknown>> = [];
  if (targetShow.tmdb_id != null) where.push({ tmdb_id: targetShow.tmdb_id });
  if (titleKeys.length > 0) {
    where.push({ normalized_title: { in: titleKeys } });
    where.push({ base_normalized_title: { in: titleKeys } });
  }
  if (where.length === 0) return null;

  const rawEpisodeNumber = Number(foundEpisode?.episode_number ?? 1);
  const episodeNumber = Number.isFinite(rawEpisodeNumber) ? rawEpisodeNumber : 1;
  const parsedSeason = parseTitleQuery(title).season;
  const requestedSeason = Number(targetShow.season_number ?? parsedSeason ?? 1);
  const seasonNumber = Number.isFinite(requestedSeason) && requestedSeason > 0 ? requestedSeason : 1;
  try {
    const mediaItems = await prisma.mediaItem.findMany({
      where: { OR: where, ...kindFilter } as any,
      include: {
        episodes: {
          where: { season_number: seasonNumber, episode_number: episodeNumber },
          include: { links: true },
        },
      },
      take: 50,
    });

    const candidates = mediaItems.flatMap((item) => item.episodes.map((episode) => ({
      id: episode.id,
      season_number: episode.season_number,
      episode_number: episode.episode_number,
      media_item: {
        title: item.title,
        normalized_title: item.normalized_title,
        base_normalized_title: item.base_normalized_title,
        tmdb_id: item.tmdb_id,
        year: item.year,
        // Category names in the legacy schema are not stable (anime/tv/series),
        // so the pure matcher intentionally does not use this field as a gate.
        kind: null,
      },
      links: (() => {
        return filterMainPathLinks(episode.links, playbackKind, targetShow.main_path_overrides)
          .map((link) => ({ url: link.url, link_type: link.link_type }));
      })(),
    })));

    const selected = selectCanonicalPlaybackCandidate(
      {
        title: targetShow.title,
        normalized_title: targetShow.normalized_title,
        base_normalized_title: targetShow.base_normalized_title,
        tmdb_id: targetShow.tmdb_id,
        year: targetShow.year,
        episode_number: episodeNumber,
      },
      foundEpisode ? { episode_number: episodeNumber } : undefined,
      candidates,
      normalizeTitle,
      normalizeBaseTitle,
      isCanonicalLocator,
    );
    if (!selected) return null;

    const selectedEpisode = mediaItems
      .flatMap((item) => item.episodes)
      .find((episode) => episode.id === selected.id);
    if (!selectedEpisode) return null;
    // Una obra puede tener una fila canónica por plataforma. El candidato
    // elegido conserva el id estable para compatibilidad, pero el playback
    // debe ver los enlaces de todas las filas equivalentes del mismo episodio.
    const mergedEpisode = mergeCanonicalEpisodes([
      [selectedEpisode],
      mediaItems.flatMap((item) => item.episodes).filter((episode) => episode.id !== selectedEpisode.id),
    ])[0] || selectedEpisode;
    // HiAnime/Zoko sometimes omits the first episode from its list even though
    // the public Zoko locator is live. Once an alias row proves that Zoko has
    // this season, fill only the requested episode with the two public
    // renditions; the normal JIT resolver validates the locator before use.
    const hasZokoForSeason = mediaItems.some((item) => item.episodes.some((episode) =>
      episode.season_number === seasonNumber && episode.links.some((link: any) => normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime"),
    ));
    if (playbackKind === "anime" && animeIdentity?.malId && hasZokoForSeason &&
      !mergedEpisode.links.some((link: any) => normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime")) {
      const malId = animeIdentity.malId;
      const locator = (rendition: "sub" | "dub") => `https://zokoanime.video/stream/mal/${malId}/${episodeNumber}/${rendition}?color=35d5bf`;
      mergedEpisode.links.push(
        {
          url: locator("sub"), source_site: "zokoanime.video", link_type: "sub",
          language: "sub", audio_language: "ja", subtitle_language: "en",
          canonical_locator: locator("sub"),
        },
        {
          url: locator("dub"), source_site: "zokoanime.video", link_type: "dub",
          language: "dub", audio_language: "en", canonical_locator: locator("dub"),
        },
      );
    }
    const playbackLinks = filterMainPathLinks(mergedEpisode.links, playbackKind, targetShow.main_path_overrides);
    const rankedRaw = await buildMultiSourceCascade(playbackLinks, { maxPerSite: 2, maxTotal: 8 });
    const ranked = keepCanonicalCandidatesFirst(rankedRaw, mergedEpisode.links);
    return ranked.length > 0 ? { mediaEpisode: mergedEpisode, ranked } : null;
  } catch (error: any) {
    // The legacy extractor remains available if the optional bridge cannot
    // query a partially migrated database.
    console.warn("[Playback] puente canónico legacy omitido:", error?.message || error);
    return null;
  }
}

/**
 * Compatibilidad con MediaEpisode creados durante la migración. Algunos de
 * esos registros tienen la obra/episodio, pero todavía no tienen SourceLink;
 * en ese caso el id canónico no debe responder "éxito" con una lista vacía.
 * Buscamos la fila legacy equivalente para que su localizador se resuelva JIT
 * y, cuando termina, el enlace pueda consolidarse en el grafo canónico.
 */
async function findLegacyEpisodeForMediaEpisode(
  mediaEpisode: any,
): Promise<{ episode: any; show: any } | null> {
  const item = mediaEpisode?.media_item;
  if (!item) return null;
  const title = String(item.title || "").trim();
  const normalized = normalizeTitle(title);
  const baseNormalized = normalizeBaseTitle(title);
  const where: Array<Record<string, unknown>> = [];
  if (item.tmdb_id != null) where.push({ tmdb_id: item.tmdb_id });
  if (normalized) where.push({ normalized_title: normalized });
  if (baseNormalized && baseNormalized !== normalized) where.push({ base_normalized_title: baseNormalized });
  if (where.length === 0) return null;

  try {
    const shows = await prisma.show.findMany({
      where: { OR: where } as any,
      include: { episodes: true },
      orderBy: { created_at: "asc" },
      take: 50,
    });
    const targetYear = Number(item.year);
    const ordered = [...shows].sort((a: any, b: any) => {
      const aExact = item.tmdb_id != null && a.tmdb_id === item.tmdb_id ? 1 : 0;
      const bExact = item.tmdb_id != null && b.tmdb_id === item.tmdb_id ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aYear = Number.isFinite(targetYear) && targetYear > 0 && a.year === targetYear ? 1 : 0;
      const bYear = Number.isFinite(targetYear) && targetYear > 0 && b.year === targetYear ? 1 : 0;
      return bYear - aYear;
    });
    const itemKind = String(item.kind || "").toLowerCase();
    const isCompatibleShow = (show: any): boolean => {
      const showCategory = String(show.category || "").toLowerCase();
      if (!showCategory || !itemKind) return true;
      if (itemKind === "movie") return showCategory === "movie";
      return showCategory === "anime" || showCategory === "series";
    };
    const season = Number(mediaEpisode.season_number) || 1;
    const episodeNumber = Number(mediaEpisode.episode_number);
    for (const show of ordered) {
      if (!isCompatibleShow(show)) continue;
      const episode = (show.episodes || []).find((candidate: any) =>
        (Number(candidate.episode_number) === episodeNumber) &&
        (!season || Number(candidate.season_number ?? 1) === season)
      );
      if (episode) return { episode, show };
    }
  } catch (error: any) {
    console.warn("[Playback] búsqueda legacy para MediaEpisode omitida:", error?.message || error);
  }
  return null;
}

function isExpiredSignedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const { expiresAt } = parseStreamExpiry(url);
    if (expiresAt && expiresAt <= Date.now()) {
      return true;
    }
  } catch {}
  return false;
}

const playStreamsCache = new Map<string, { streamUrl: string; allStreams: string[]; ranked: any[]; expiresAt: number }>();

/**
 * Enriches a canonical anime episode with equivalent title rows discovered
 * through Kitsu aliases. Some importers call the same season "Jigokuraku"
 * while others use "Hell's Paradise", leaving the canonical episode with
 * only LatAnime links even though the ZokoAnime row exists under the alias.
 */
async function enrichAnimeMediaEpisodeWithAliases(
  mediaEpisode: any,
): Promise<{ episode: any; changed: boolean }> {
  const item = mediaEpisode?.media_item;
  if (!item || String(item.kind || "").toLowerCase() === "movie") {
    return { episode: mediaEpisode, changed: false };
  }
  const title = String(item.title || "").trim();
  if (!title || item.tmdb_id != null) return { episode: mediaEpisode, changed: false };

  // An episode that already carries a Zoko locator is complete for the alias
  // bridge. Avoid a needless external metadata lookup on these rows (and keep
  // playback latency bounded when the public Kitsu API is slow).
  const alreadyHasZoko = (mediaEpisode.links || []).some((link: any) =>
    normalizeProviderId(link?.source_site || link?.host || link?.url) === "zokoanime",
  );
  if (alreadyHasZoko) return { episode: mediaEpisode, changed: false };

  const identity = await lookupAnimeIdentityByTitle(title);
  if (!identity) return { episode: mediaEpisode, changed: false };

  const titleKeys = [...new Set([
    normalizeTitle(title),
    normalizeBaseTitle(title),
    ...(identity.normalizedAliases || []),
  ].filter(Boolean))];
  if (titleKeys.length === 0) return { episode: mediaEpisode, changed: false };

  const seasonNumber = Number(mediaEpisode.season_number) > 0
    ? Number(mediaEpisode.season_number)
    : 1;
  const episodeNumber = Number(mediaEpisode.episode_number);
  if (!Number.isFinite(episodeNumber)) return { episode: mediaEpisode, changed: false };

  try {
    const mediaItems = await prisma.mediaItem.findMany({
      where: {
        kind: { in: ["anime", "series"] },
        OR: [
          { normalized_title: { in: titleKeys } },
          { base_normalized_title: { in: titleKeys } },
        ],
      } as any,
      include: {
        episodes: {
          where: { season_number: seasonNumber },
          include: { links: true },
        },
      },
      take: 50,
    });

    const equivalentEpisodes = mediaItems.flatMap((candidate: any) =>
      (candidate.episodes || []).map((episode: any) => ({ ...episode, media_item: candidate }))
    );
    const requested = equivalentEpisodes.filter((episode: any) =>
      Number(episode.episode_number) === episodeNumber,
    );
    const seasonEpisodes = [mediaEpisode, ...equivalentEpisodes];
    const links = [
      ...mediaEpisode.links,
      ...requested.flatMap((episode: any) => episode.links || []),
    ];
    const deduped = Array.from(new Map(
      links
        .filter((link: any) => String(link?.url || "").trim())
        .map((link: any) => [
          `${normalizeProviderId(link.source_site || link.host || link.url)}|${String(link.url).trim()}`,
          link,
        ]),
    ).values());

    const hasZokoForSeason = seasonEpisodes.some((episode: any) =>
      (episode.links || []).some((link: any) =>
        normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime",
      ),
    );
    if (identity.malId && hasZokoForSeason && !deduped.some((link: any) =>
      normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime",
    )) {
      const locator = (rendition: "sub" | "dub") =>
        `https://zokoanime.video/stream/mal/${identity.malId}/${episodeNumber}/${rendition}?color=35d5bf`;
      deduped.push(
        {
          url: locator("sub"), source_site: "zokoanime.video", link_type: "sub",
          language: "sub", audio_language: "ja", subtitle_language: "en",
          canonical_locator: locator("sub"),
        },
        {
          url: locator("dub"), source_site: "zokoanime.video", link_type: "dub",
          language: "dub", audio_language: "en", canonical_locator: locator("dub"),
        },
      );
    }

    const changed = deduped.length !== mediaEpisode.links.length;
    return { episode: changed ? { ...mediaEpisode, links: deduped } : mediaEpisode, changed };
  } catch (error: any) {
    console.warn("[Playback] enriquecimiento anime por alias omitido:", error?.message || error);
    return { episode: mediaEpisode, changed: false };
  }
}

export async function handlePlayEpisode(req: Request, res: Response) {
  const targetId = req.params.episode_id;
  const _playResolveStart = Date.now();
  let foundEpisode: any = null;
  let targetShow: any = null;

  try {
    // Public TMDB catalog episodes are virtual IDs (tmdb-anime-...-s1-e1),
    // therefore they do not have a legacy Episode row yet. Resolve them through
    // the same gateway used by the frontend so older clients calling /play do
    // not receive a misleading 404.
    const synthetic = String(targetId).match(/^tmdb-(movie|series|anime)-(\d+)-s(\d+)-e(\d+)$/i);
    if (synthetic) {
      const kind = synthetic[1].toLowerCase() as "movie" | "series" | "anime";
      const gateway = await resolveByTmdb({
        tmdbId: Number(synthetic[2]),
        kind,
        season: Number(synthetic[3]),
        episode: Number(synthetic[4]),
        preferredAudio: ["es", "en", "ja"],
        preferredSubtitles: ["es", "en"],
        persist: false,
      });
      const direct = gateway.sources.map((source: any, index: number) => ({
        url: source.url,
        type: "direct" as const,
        tier: index,
        provider: source.provider,
        source_site: source.provider,
        original_url: source.canonicalLocator || source.url,
        canonical_locator: source.canonicalLocator || source.url,
        audio_language: source.audioLanguage || undefined,
        subtitle_language: source.subtitleLanguage || undefined,
        subtitles: source.subtitles || [],
        requiredHeaders: source.requiredHeaders,
        delivery_mode: source.requiredHeaders ? "proxy_required" : "direct_trial",
        is_proxyable: true,
        is_refreshable: Boolean(source.canonicalLocator),
      }));
      const fallbacks = gateway.fallbackCandidates.map((source: any, index: number) => ({
        url: source.url,
        type: "embed" as const,
        tier: direct.length + index,
        provider: source.provider,
        source_site: source.provider,
        original_url: source.canonicalLocator || source.url,
        canonical_locator: source.canonicalLocator || source.url,
        audio_language: source.audioLanguage || undefined,
        subtitle_language: source.subtitleLanguage || undefined,
        subtitles: source.subtitles || [],
        delivery_mode: "embed",
        is_proxyable: false,
        is_refreshable: true,
      }));
      const ranked = proxyRankedSubtitles([...direct, ...fallbacks]);
      if (ranked.length > 0) {
        return res.json({
          episode_id: targetId,
          stream_url: ranked[0].url,
          title: `TMDB ${synthetic[2]} - S${synthetic[3]}E${synthetic[4]}`,
          all_available_streams: ranked.map((entry: any) => entry.url),
          ranked_streams: ranked,
        });
      }
      return res.status(404).json({ detail: "No hay una fuente reproducible para este episodio TMDB.", episode_id: targetId, ranked_streams: [], all_available_streams: [] });
    }

    // 1. Intentar resolver por esquema Multi-fuente v2 (MediaEpisode + SourceLink)
    const mediaEpisode = await prisma.mediaEpisode.findUnique({
      where: { id: targetId },
      include: { media_item: true, links: true },
    });

    if (mediaEpisode && mediaEpisode.links?.length > 0) {
      const title = `${mediaEpisode.media_item?.title || "Reproducción"} - Episodio ${mediaEpisode.episode_number}`;
      const playbackKind = mediaEpisode.media_item?.kind === "movie"
        ? "movie"
        : mediaEpisode.media_item?.kind === "series"
          ? "series"
          : "anime";
      const policyShow = await prisma.show.findFirst({
        where: mediaEpisode.media_item?.tmdb_id != null
          ? { tmdb_id: mediaEpisode.media_item.tmdb_id, category: playbackKind }
          : { normalized_title: mediaEpisode.media_item?.normalized_title || "", category: playbackKind },
        select: { main_path_overrides: true },
      }).catch(() => null);
      const showOverrides = policyShow?.main_path_overrides;
      const aliasMerge = playbackKind === "anime"
        ? await enrichAnimeMediaEpisodeWithAliases(mediaEpisode)
        : { episode: mediaEpisode, changed: false };
      const playbackEpisode = aliasMerge.episode;
      if (aliasMerge.changed) playStreamsCache.delete(mediaEpisode.id);
      const hasZoko = playbackEpisode.links.some((link: any) =>
        normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime"
      );
      const isAllowedLink = (link: any) => {
        const provider = normalizeProviderId(link.source_site || link.host || link.url);
        // TioAnime is retained only as the documented anime fallback, and is
        // suppressed whenever the preferred ZokoAnime locator exists.
        if (provider === "tioanime" && !showOverrides && link.main_path_override == null) return playbackKind === "anime" && hasZoko;
        return isProviderAllowedForWork(provider, playbackKind, { showOverrides, linkOverride: link.main_path_override });
      };

      const cached = playStreamsCache.get(mediaEpisode.id);
      if (!aliasMerge.changed && cached && cached.expiresAt > Date.now()) {
        const cachedRanked = proxyRankedSubtitles(cached.ranked)
          .filter((entry: any) => isAllowedLink(entry))
          .sort((a: any, b: any) => compareMainPathLinks(a, b, playbackKind));
        if (cachedRanked.length === 0) {
          playStreamsCache.delete(mediaEpisode.id);
        } else {
        return res.json({
          episode_id: mediaEpisode.id,
          stream_url: cachedRanked[0]?.url || "",
          title,
          all_available_streams: cachedRanked.map((entry: any) => entry.url),
          ranked_streams: cachedRanked,
        });
        }
      }

      // Filtrar links que pertenecen a otra temporada o episodio
      const validLinks = playbackEpisode.links.filter((l: any) => {
        const url = (l.url || "").trim();
        if (!url) return false;
        const sxp = url.match(/(?:[-_/]|^)(\d+)x(\d+)(?:[-_/.]|$)/i);
        if (sxp) {
          const s = parseInt(sxp[1], 10);
          const e = parseInt(sxp[2], 10);
          if (mediaEpisode.season_number != null && s !== mediaEpisode.season_number) return false;
          if (mediaEpisode.episode_number != null && e !== mediaEpisode.episode_number) return false;
        }
        const temp = url.match(/temporada-(\d+)-episodio-(\d+)/i);
        if (temp) {
          const s = parseInt(temp[1], 10);
          const e = parseInt(temp[2], 10);
          if (mediaEpisode.season_number != null && s !== mediaEpisode.season_number) return false;
          if (mediaEpisode.episode_number != null && e !== mediaEpisode.episode_number) return false;
        }
        return true;
      });

      const policyLinks = filterMainPathLinks(
        (validLinks.length > 0 ? validLinks : playbackEpisode.links).filter(isAllowedLink),
        playbackKind,
        showOverrides,
      );
      const linksToUse = policyLinks;
      if (linksToUse.length === 0) {
        return res.status(404).json({
          error: "Este episodio no tiene una fuente activa reproducible.",
          episode_id: mediaEpisode.id,
          ranked_streams: [],
          all_available_streams: [],
        });
      }
      const rankedRaw = await buildMultiSourceCascade(linksToUse, { maxPerSite: 2, maxTotal: 8 });
      const ranked = keepCanonicalCandidatesFirst(rankedRaw, linksToUse);

      if (ranked.length === 0) {
        return res.status(404).json({
          error: "No se pudieron obtener servidores de reproducción para este episodio.",
          episode_id: mediaEpisode.id,
          ranked_streams: [],
          all_available_streams: [],
        });
      }

      const safeRanked = proxyRankedSubtitles(ranked);
      const allMergedStreams = safeRanked.map((entry) => entry.url);
      const streamUrl = safeRanked[0]?.url || "";

      playStreamsCache.set(mediaEpisode.id, {
        streamUrl,
        allStreams: allMergedStreams,
        ranked: safeRanked,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      return res.json({
        episode_id: mediaEpisode.id,
        stream_url: streamUrl,
        title,
        all_available_streams: allMergedStreams,
        ranked_streams: safeRanked,
      });
    }

    // No devolver 200 con stream_url vacío: enlazar al esquema legacy cuando
    // el registro canónico aún no recibió SourceLinks por una importación
    // histórica. La extracción JIT se ejecuta únicamente como último recurso.
    if (mediaEpisode) {
      const legacy = await findLegacyEpisodeForMediaEpisode(mediaEpisode);
      if (legacy) {
        foundEpisode = legacy.episode;
        targetShow = legacy.show;
      } else {
        return res.status(404).json({
          detail: "La obra existe, pero todavía no tiene una fuente canónica recuperable.",
          episode_id: mediaEpisode.id,
          ranked_streams: [],
          all_available_streams: [],
        });
      }
    }

    // 2. Fallback Legacy: esquema antiguo (Show / Episode)
    if (!foundEpisode) {
      foundEpisode = await prisma.episode.findUnique({
        where: { id: targetId },
        include: { show: true },
      });
      targetShow = foundEpisode?.show || null;
    }

    if (!foundEpisode) {
      const foundShow = await prisma.show.findUnique({
        where: { id: targetId },
        include: { episodes: true },
      });

      if (foundShow) {
        targetShow = foundShow;
        if (foundShow.episodes && foundShow.episodes.length > 0) {
          foundEpisode = { ...foundShow.episodes[0], show: foundShow } as any;
        }
      }
    }

    // 2a. Migrated catalogue bridge: prefer the canonical MediaEpisode graph
    // before invoking the legacy extractor. This keeps old ids compatible
    // while preventing a historical signed .m3u8 from becoming the first
    // browser candidate.
    const canonicalBridge = await findCanonicalMediaEpisodeForLegacy(foundEpisode, targetShow);
    if (canonicalBridge) {
      const title = foundEpisode?.title
        ? `${targetShow?.title || canonicalBridge.mediaEpisode.media_item?.title || ""} - ${foundEpisode.title}`
        : targetShow?.title || canonicalBridge.mediaEpisode.media_item?.title || "Reproducción";
      const safeCanonicalRanked = proxyRankedSubtitles(canonicalBridge.ranked);
      const allCanonicalStreams = safeCanonicalRanked.map((entry) => entry.url);
      return res.json({
        episode_id: foundEpisode?.id || targetShow?.id || targetId,
        stream_url: safeCanonicalRanked[0]?.url || "",
        title,
        all_available_streams: allCanonicalStreams,
        ranked_streams: safeCanonicalRanked,
        media_episode_id: canonicalBridge.mediaEpisode.id,
      });
    }

    const sourceUrl = foundEpisode?.source_url || (targetShow as any)?.source_url || (targetShow as any)?.url || "";
    // A legacy episode can exist without a source locator while the canonical
    // bridge is unavailable. Never pass an empty string to URL-based resolvers.
    if (!sourceUrl) {
      return res.status(404).json({ detail: "Episodio u obra no encontrada en la base de datos." });
    }

    const legacyKind = String(targetShow?.category || "").toLowerCase() === "movie"
      ? "movie"
      : String(targetShow?.category || "").toLowerCase() === "series"
        ? "series"
        : "anime";
    const legacyProvider = normalizeProviderId(sourceUrl);
    if (!isProviderAllowedForWork(legacyProvider, legacyKind, { showOverrides: (targetShow as any)?.main_path_overrides })) {
      return res.status(404).json({
        error: "La fuente histórica está deshabilitada para el camino principal.",
        provider: legacyProvider,
        episode_id: foundEpisode?.id || targetId,
        ranked_streams: [],
        all_available_streams: [],
      });
    }

    const extracted = await extractStreamFromUrl(sourceUrl);
    const allStreams = Array.from(
      new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
    );

    const title = foundEpisode?.title
      ? `${targetShow?.title || ""} - ${foundEpisode.title}`
      : targetShow?.title || extracted.title || "Reproducción";

    const platformSite = siteFromDomain(hostOfStreamUrl(sourceUrl));
    const primaryRanked = rankStreams(allStreams, getServerPriorities(platformSite)).map((r) => ({
      ...r,
      source_site: platformSite || undefined,
    }));

    const crossPlatform = await resolveCrossPlatformStreams(
      foundEpisode,
      targetShow,
      platformSite,
      3,
      8000
    );

    const extraEntries = Array.from(crossPlatform.entries());
    const extraRanked: typeof primaryRanked = [];
    if (extraEntries.length > 0) {
      const extraRated = await Promise.all(
        extraEntries.map(async ([site, streams]) => ({
          site,
          streams: streams.map((r) => ({ ...r, source_site: site })),
          rating: await getSiteRating(site),
        }))
      );
      extraRated.sort((a, b) => b.rating - a.rating);
      for (const group of extraRated) {
        extraRanked.push(...group.streams);
      }
    }

    const combinedRanked = [...primaryRanked, ...extraRanked];
    const rankedSites = Array.from(
      new Set(combinedRanked.map((entry) => entry.source_site).filter(Boolean) as string[])
    );
    const rankedRatings = new Map(
      await Promise.all(
        rankedSites.map(async (site) => [site, await getSiteRating(site)] as const)
      )
    );
    const seenRankedUrls = new Set<string>();
    const ranked = combinedRanked
      .sort((a, b) => {
        const ratingDiff =
          (rankedRatings.get(b.source_site || "") ?? 5) -
          (rankedRatings.get(a.source_site || "") ?? 5);
        if (ratingDiff !== 0) return ratingDiff;
        if (a.tier !== b.tier) return a.tier - b.tier;
        if (a.type !== b.type) return a.type === "direct" ? -1 : 1;
        return 0;
      })
      .filter((entry) => {
        if (seenRankedUrls.has(entry.url)) return false;
        seenRankedUrls.add(entry.url);
        return true;
      });
    const safeRanked = proxyRankedSubtitles(ranked);
    const allMergedStreams = Array.from(
      new Set([
        ...safeRanked.map((r) => r.url),
      ].filter(Boolean))
    );

    const streamUrl =
      safeRanked.find((r) => r.url === extracted.stream_url)?.url ||
      safeRanked[0]?.url ||
      sourceUrl;

    res.json({
      episode_id: foundEpisode?.id || targetShow?.id || targetId,
      stream_url: streamUrl,
      title,
      all_available_streams: allMergedStreams.length > 0 ? allMergedStreams : [sourceUrl],
      ranked_streams: safeRanked,
    });
  } catch (e: any) {
    logPlayerEvent({
      eventType: "scraper_failed",
      serverUrl: targetId,
      durationBeforeErrorMs: Date.now() - _playResolveStart,
      details: `Error en extractor JIT: ${e.message}`,
    });
    res.status(500).json({ error: e.message });
  }
}

const INTERNAL_SUBTITLE_PATH = /^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i;

/**
 * Normalizes subtitle metadata returned by legacy embed resolvers before it
 * crosses an API boundary. Existing internal tokens remain usable; public
 * provider URLs are registered with SubtitleProxy and replaced by tokens.
 */
function proxyResolvedSubtitles<T extends { subtitles?: any[] }>(meta: T, providerHint?: string): T {
  if (!Array.isArray(meta.subtitles)) return meta;
  const provider = normalizeProviderId(providerHint || (meta as any).provider || "");
  const subtitles = meta.subtitles.flatMap((track: any, index: number) => {
    const sourceUrl = String(track?.src || track?.url || "").trim();
    if (INTERNAL_SUBTITLE_PATH.test(sourceUrl)) {
      return [{ ...track, src: sourceUrl, url: sourceUrl }];
    }
    if (!/^https:\/\//i.test(sourceUrl)) return [];
    const url = subtitleGateway.proxy.register({
      id: String(track?.id || `${provider || "subtitle"}-${index}`),
      provider,
      language: String(track?.language || track?.lang || "und"),
      label: String(track?.label || track?.language || track?.lang || "Subtítulo"),
      sourceUrl,
      format: /\.vtt(?:[?#]|$)/i.test(sourceUrl) ? "vtt" : "unknown",
      ...(provider === "zokoanime" ? { sourceHeaders: { Referer: "https://zokoanime.video/" } } : {}),
    });
    return url ? [{ ...track, src: url, url }] : [];
  });
  return { ...meta, subtitles };
}

function proxyRankedSubtitles<T extends { subtitles?: any[]; source_site?: string; provider?: string }>(entries: T[]): T[] {
  return entries.map((entry) => {
    if (!Array.isArray(entry.subtitles)) return entry;
    const provider = entry.source_site || entry.provider;
    return {
      ...entry,
      subtitles: proxyResolvedSubtitles({ subtitles: entry.subtitles }, provider).subtitles || [],
    };
  });
}

async function startServer() {
  const app = express();
  const configuredPort = Number(process.env.PORT || APP_CONFIG.port);
  const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : APP_CONFIG.port;
  let databaseReady = false;

  const configuredProxyHops = Number(process.env.TRUST_PROXY_HOPS || "");
  const proxyHops = Number.isInteger(configuredProxyHops) && configuredProxyHops > 0
    ? configuredProxyHops
    : 0;
  app.set("trust proxy", proxyHops > 0 ? proxyHops : false);

  app.use((req, res, next) => {
    if (process.env.NODE_ENV === "production" && process.env.ENFORCE_HTTPS === "true") {
      if (req.headers["x-forwarded-proto"] === "http") {
        return res.redirect(301, `https://${req.hostname}${req.url}`);
      }
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
      res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
    }
    next();
  });

  const configuredAllowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : [];
  const allowedOrigins = configuredAllowedOrigins.length > 0
    ? configuredAllowedOrigins
    : process.env.NODE_ENV === "production"
      ? []
      : localAllowedOrigins();

  const defaultCors = cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'X-Media-Title', 'X-Media-Provider', 'X-TMDB-Personal-Key', 'Accept', 'Origin', 'X-Requested-With'],
      exposedHeaders: [
        'Content-Range',
        'Accept-Ranges',
        'Content-Length',
        'Content-Type',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'RateLimit',
        'RateLimit-Policy',
        'Retry-After',
      ]
    });

  app.use((req, res, next) => {
    // The Google Cast receiver is a separate web origin. Playback manifests,
    // segments and text tracks are opaque public-session URLs and therefore
    // need wildcard CORS; all other API routes keep the regular allow-list.
    if (isCastMediaPath(req.path)) return castMediaCors(req, res, next);
    return defaultCors(req, res, next);
  });
  app.use(express.json({
    limit: "10mb",
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Rate limiting middleware for tiered endpoint protection
  app.use("/api/auth", authLimiter);
  app.use("/api/v1/catalog/search", searchLimiter);
  app.use("/api/v1/catalog/public", catalogPublicLimiter);
  app.use(["/api/v1/playback", "/api/v1/proxy", "/api/v1/play", "/api/v1/play-multi", "/api/v1/stream"], playbackLimiter);
  app.use("/api/v1/reports", reportsLimiter);
  app.use("/api/rooms", roomsLimiter);
  app.use("/api", generalLimiter);

  // Direct TMDB/AniList provider gateway: public JIT playback data, no iframe providers.
  app.use(providerGatewayRouter());
  app.use(subtitleRouter(subtitleGateway));

  // Search is a distinct TMDB-backed operation. Keeping it separate from
  // the browse endpoint prevents the initial trending page (60 cards) from
  // ever being mistaken for the complete searchable catalog.
  app.get("/api/v1/catalog/search", async (req: Request, res: Response) => {
    const query = String(req.query.q || req.query.query || "").trim();
    if (query.length < 2) return res.status(400).json({ error: "La búsqueda requiere al menos 2 caracteres" });
    try {
      const personalApiKey = String(req.get("x-tmdb-personal-key") || "").trim().slice(0, 128) || undefined;
      const identifierResult = await getPublicCatalogByIdentifier(query, personalApiKey);
      if (identifierResult) {
        const result = await visibleCatalogShows(identifierResult);
        res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=60");
        res.setHeader("X-Catalog-Source", result.source);
        res.setHeader("X-Catalog-Search", "tmdb");
        res.setHeader("X-Catalog-Identifier", "true");
        return res.json(result);
      }
      const result = await visibleCatalogShows(await getPublicCatalog({
        kind: "all",
        query,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 100,
        mode: "search",
        apiKey: personalApiKey,
      }));
      res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=60");
      res.setHeader("X-Catalog-Source", result.source);
      res.setHeader("X-Catalog-Search", "tmdb");
      return res.json(result);
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "TMDB search unavailable" });
    }
  });

  // Public catalog identity is TMDB-first and deliberately independent from
  // imported provider rows. A card can therefore be browsed immediately while
  // Cinecalidad/Gnula/LatAnime/Zoko availability is resolved later by ID.
  app.get("/api/v1/catalog/public", async (req: Request, res: Response) => {
    try {
      const personalApiKey = String(req.get("x-tmdb-personal-key") || "").trim().slice(0, 128) || undefined;
      const result = await visibleCatalogShows(await getPublicCatalog({
        kind: req.query.kind,
        query: req.query.query || req.query.search,
        page: req.query.page ? Number(req.query.page) : 1,
        limit: req.query.limit ? Number(req.query.limit) : 40,
        mode: typeof req.query.mode === "string" ? req.query.mode : "trending",
        genre: req.query.genre,
        apiKey: personalApiKey,
      }));
      res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=60");
      res.setHeader("X-Catalog-Source", result.source);
      return res.json(result);
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "TMDB catalog unavailable" });
    }
  });

  app.get("/api/v1/catalog/public/:kind/:tmdbId", async (req: Request, res: Response) => {
    try {
      const personalApiKey = String(req.get("x-tmdb-personal-key") || "").trim().slice(0, 128) || undefined;
      const detail = await getPublicCatalogDetail(req.params.kind, req.params.tmdbId, personalApiKey);
      if (!detail) return res.status(400).json({ error: "kind/tmdbId inválidos" });
      const visibility = await getCatalogVisibility();
      if (isCatalogItemHidden(publicCatalogItem(req.params.kind, req.params.tmdbId, detail.genres), visibility)) {
        return res.status(404).json({ error: "Título no disponible" });
      }
      res.setHeader("Cache-Control", "public, max-age=900, stale-while-revalidate=300");
      res.setHeader("X-Catalog-Source", "tmdb");
      return res.json(detail);
    } catch (error: any) {
      const status = String(error?.message || "").includes("TMDB HTTP 404") ? 404 : 502;
      return res.status(status).json({ error: error?.message || "TMDB title unavailable" });
    }
  });

  app.get("/api/v1/catalog/public/:kind/:tmdbId/related", async (req: Request, res: Response) => {
    try {
      const personalApiKey = String(req.get("x-tmdb-personal-key") || "").trim().slice(0, 128) || undefined;
      const related = await getPublicCatalogRelated(req.params.kind, req.params.tmdbId, personalApiKey);
      const visibility = await getCatalogVisibility();
      const visibleRelated = related.filter((show) => !isCatalogItemHidden(show, visibility));
      res.setHeader("Cache-Control", "public, max-age=900, stale-while-revalidate=300");
      res.setHeader("X-Catalog-Source", "tmdb");
      return res.json({ shows: visibleRelated });
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "TMDB related titles unavailable" });
    }
  });

  // Configuración pública de visibilidad. No expone datos de administración;
  // solo permite que el frontend aplique el mismo filtro en memoria mientras
  // las respuestas del catálogo llegan desde caché o desde TMDB.
  app.get("/api/v1/catalog/visibility", async (_req: Request, res: Response) => {
    try {
      const visibility = await getCatalogVisibility();
      res.setHeader("Cache-Control", "no-store");
      return res.json(visibility);
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudo leer la visibilidad del catálogo" });
    }
  });

  // Los reportes de calidad son públicos y deliberadamente ligeros: no abren
  // ningún flujo de reproducción ni obligan a iniciar sesión. El panel admin
  // es el único lugar donde se exponen y modifican después.
  app.post("/api/v1/reports", async (req: Request, res: Response) => {
    try {
      const report = await createCatalogReport({
        showId: req.body?.show_id,
        tmdbId: req.body?.tmdb_id,
        kind: req.body?.kind,
        title: req.body?.title,
        episodeId: req.body?.episode_id,
        episodeNumber: req.body?.episode_number,
        reportType: req.body?.report_type,
        details: req.body?.details,
        sourceProvider: req.body?.source_provider,
        sourceUrl: req.body?.source_url,
      });
      res.status(201).json({ ok: true, report_id: report.id });
    } catch (error: any) {
      const message = error?.message || "No se pudo registrar el reporte.";
      const status = /obligatorio|no válido/i.test(message) ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  // Estado mínimo público de proveedores upstream. No expone credenciales ni
  // URLs firmadas; permite que el reproductor y soporte distingan una caída
  // del proveedor de un fallo local de MeriStream.
  app.get("/api/v1/providers/health", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      generated_at: new Date().toISOString(),
      providers: { doramasflix: getDoramasflixHealth() },
    });
  });

  // Protege el plano de control sin interceptar reproducción, catálogo público
  // ni las resoluciones Just-In-Time que necesita el reproductor.
  app.use("/api/v1", requireAdminForControlPlane);

  app.get("/api/v1/admin/catalog/visibility", async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await getAdminCatalogVisibility());
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudo leer la configuración del catálogo" });
    }
  });

  app.get("/api/v1/admin/catalog/visibility/shows", async (req: Request, res: Response) => {
    try {
      const genre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";
      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
      const visibilityFilter = typeof req.query.visibility === "string" ? req.query.visibility.trim() : "all";
      const page = Math.max(1, parseInt(String(req.query.page || 1), 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || 36), 10) || 36));
      const skip = (page - 1) * limit;

      const where: any = {};
      if (genre) {
        where.genres = { contains: genre, mode: "insensitive" };
      }
      if (category && category !== "all") {
        where.category = { contains: category, mode: "insensitive" };
      }
      if (search) {
        where.OR = [
          { title: { contains: search, mode: "insensitive" } },
          { original_title: { contains: search, mode: "insensitive" } },
          { english_title: { contains: search, mode: "insensitive" } },
        ];
      }

      if (visibilityFilter === "hidden" || visibilityFilter === "visible") {
        const catalogVisibility = await getCatalogVisibility();
        const hiddenIds = catalogVisibility.hiddenShowIds;
        const directIds: string[] = [];
        const tmdbIds: number[] = [];
        for (const hid of hiddenIds) {
          const match = /^tmdb-(?:movie|series|anime)-(\d+)$/.exec(hid) || /^tmdb:(?:movie|series|anime):(\d+)$/.exec(hid);
          if (match) {
            const parsedTmdb = parseInt(match[1], 10);
            if (!isNaN(parsedTmdb)) tmdbIds.push(parsedTmdb);
          } else {
            directIds.push(hid);
          }
        }

        if (visibilityFilter === "hidden") {
          if (directIds.length === 0 && tmdbIds.length === 0) {
            return res.json({ shows: [], total: 0, page, limit, totalPages: 1 });
          }
          const hiddenOrClauses: any[] = [];
          if (directIds.length > 0) hiddenOrClauses.push({ id: { in: directIds } });
          if (tmdbIds.length > 0) hiddenOrClauses.push({ tmdb_id: { in: tmdbIds } });
          where.AND = [...(where.AND || []), { OR: hiddenOrClauses }];
        } else if (visibilityFilter === "visible") {
          const visibleAndClauses: any[] = [];
          if (directIds.length > 0) visibleAndClauses.push({ id: { notIn: directIds } });
          if (tmdbIds.length > 0) visibleAndClauses.push({ tmdb_id: { notIn: tmdbIds } });
          if (visibleAndClauses.length > 0) {
            where.AND = [...(where.AND || []), ...visibleAndClauses];
          }
        }
      }

      const [shows, total] = await Promise.all([
        prisma.show.findMany({
          where,
          select: {
            id: true,
            title: true,
            original_title: true,
            category: true,
            year: true,
            rating: true,
            poster_url: true,
            banner_url: true,
            poster_path: true,
            backdrop_path: true,
            genres: true,
            tmdb_id: true,
            status: true,
            created_at: true,
          },
          orderBy: [{ year: "desc" }, { title: "asc" }],
          skip,
          take: limit,
        }),
        prisma.show.count({ where }),
      ]);

      res.setHeader("Cache-Control", "no-store");
      return res.json({
        shows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudieron cargar las obras del género" });
    }
  });

  app.put("/api/v1/admin/catalog/visibility", async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const visibility = await saveCatalogVisibility({
        hiddenGenres: Array.isArray(body.hiddenGenres) ? body.hiddenGenres : [],
        hiddenShowIds: Array.isArray(body.hiddenShowIds) ? body.hiddenShowIds : [],
      });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, ...visibility });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudo guardar la configuración del catálogo" });
    }
  });

  app.get("/api/v1/admin/reports/summary", async (_req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
      res.json(await getCatalogReportSummary());
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "No se pudo cargar el resumen de reportes." });
    }
  });

  app.get("/api/v1/admin/reports", async (req: Request, res: Response) => {
    try {
      res.setHeader("Cache-Control", "private, no-store");
      res.json(await listCatalogReports({
        status: req.query.status,
        limit: req.query.limit,
        offset: req.query.offset,
      }));
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "No se pudieron cargar los reportes." });
    }
  });

  app.patch("/api/v1/admin/reports/:reportId", async (req: Request, res: Response) => {
    try {
      const report = await updateCatalogReport(req.params.reportId, {
        status: req.body?.status,
        adminNote: req.body?.admin_note,
        resolutionAction: req.body?.resolution_action,
      });
      res.json({ ok: true, report });
    } catch (error: any) {
      const message = error?.message || "No se pudo actualizar el reporte.";
      res.status(/no válido/i.test(message) ? 400 : 404).json({ error: message });
    }
  });

  // ==========================================
  // API Routes
  // ==========================================

  // Health
  app.get(["/health", "/api/v1/health"], (req: Request, res: Response) => {
    const status = databaseReady ? "ok" : "degraded";
    res.status(databaseReady ? 200 : 503).json({ status, service: "MeriStream API" });
  });

  // Genres cache (TTL 1 hour)
  let cachedGenres: any = null;
  let genresCacheExpiry = 0;
  const GENRES_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // Canonical list of Spanish TMDB + Anime genres
  const CANONICAL_GENRES: string[] = [
    "Acción",
    "Acción y aventura",
    "Animación",
    "Aventura",
    "Bélica",
    "Bélica y política",
    "Ciencia ficción",
    "Ciencia ficción y fantasía",
    "Comedia",
    "Crimen",
    "Documental",
    "Drama",
    "Familia",
    "Fantasía",
    "Historia",
    "Infantil",
    "Isekai",
    "Mecha",
    "Misterio",
    "Música",
    "Noticias",
    "Película de TV",
    "Reality",
    "Romance",
    "Seinen",
    "Shounen",
    "Slice of Life",
    "Sobrenatural",
    "Suspenso",
    "Terror",
    "Western"
  ];

  const TMDB_TV_GENRE_TRANSLATIONS: Record<string, string> = {
    "action & adventure": "Acción y aventura",
    "sci-fi & fantasy": "Ciencia ficción y fantasía",
    "war & politics": "Bélica y política",
    "kids": "Infantil",
    "soap": "Telenovela",
    "news": "Noticias",
    "talk": "Talk Show",
    "suspense": "Suspenso",
  };

  // GET /api/v1/genres - Fetch official TMDB & curated anime genres
  app.get("/api/v1/genres", async (req: Request, res: Response) => {
    try {
      // Return cached if valid
      if (cachedGenres && Date.now() < genresCacheExpiry) {
        const visibility = await getCatalogVisibility();
        const genres = cachedGenres.genres.filter((genre: string) => !isGenreHidden(genre, visibility));
        return res.json({ ...cachedGenres, total: genres.length, genres });
      }

      const allGenres = new Set<string>(CANONICAL_GENRES);

      const tmdbKey = process.env.TMDB_API_KEY;
      if (tmdbKey) {
        try {
          const timeout = 4000;
          const [movieRes, tvRes] = await Promise.all([
            fetch(`https://api.themoviedb.org/3/genre/movie/list?language=es-MX&api_key=${tmdbKey}`, {
              signal: AbortSignal.timeout(timeout),
            }).then((r) => r.ok ? r.json() : null).catch(() => null),
            fetch(`https://api.themoviedb.org/3/genre/tv/list?language=es-MX&api_key=${tmdbKey}`, {
              signal: AbortSignal.timeout(timeout),
            }).then((r) => r.ok ? r.json() : null).catch(() => null),
          ]);

          const rawList = [
            ...(Array.isArray(movieRes?.genres) ? movieRes.genres : []),
            ...(Array.isArray(tvRes?.genres) ? tvRes.genres : []),
          ];

          for (const item of rawList) {
            if (typeof item?.name === 'string') {
              const trimmed = item.name.trim();
              const lower = trimmed.toLowerCase();
              if (TMDB_TV_GENRE_TRANSLATIONS[lower]) {
                allGenres.add(TMDB_TV_GENRE_TRANSLATIONS[lower]);
              } else if (trimmed) {
                const clean = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
                allGenres.add(clean);
              }
            }
          }
        } catch {
          // Fallback to canonical set
        }
      }

      const visibility = await getCatalogVisibility();
      const sorted = Array.from(allGenres)
        .filter((genre) => !isGenreHidden(genre, visibility))
        .sort((a, b) => a.localeCompare(b, "es"));

      const result = {
        status: "ok",
        total: sorted.length,
        genres: sorted,
      };

      cachedGenres = result;
      genresCacheExpiry = Date.now() + GENRES_CACHE_TTL;

      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/shows - Fetch shows from PostgreSQL
  // ?lite=true → sin episodios, con paginación (para catálogo local del frontend)
  // ?search=&category= → filtro server-side
  // ?page=1&limit=500 → paginación
  app.get("/api/v1/shows", async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
      const category = typeof req.query.category === "string" ? req.query.category.trim() : undefined;
      const genre = typeof req.query.genre === "string" ? req.query.genre.trim() : undefined;
      const requestedYear = typeof req.query.year === "string" ? Number(req.query.year) : Number(req.query.year);
      const year = Number.isInteger(requestedYear) && requestedYear > 0 ? requestedYear : undefined;
      const requestedSort = typeof req.query.sort === "string" ? req.query.sort : undefined;
       const sort = requestedSort === "rating" || requestedSort === "anio" || requestedSort === "az" || requestedSort === "recientes"
         ? requestedSort
         : undefined;
       const missingTmdb = req.query.identity === "missing_tmdb" || req.query.missing_tmdb === "true";
      const identityValue = typeof req.query.identity === "string" ? req.query.identity : undefined;
      const identity = ["missing_tmdb", "missing_any", "missing_imdb", "missing_mal", "missing_anilist", "missing_kitsu", "missing_anidb", "missing_tvdb"].includes(identityValue || "")
        ? identityValue as any
        : undefined;
      const isLite = req.query.lite === "true";
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const isAdminRequest = hasValidAdminSession(req);

      if (isLite) {
        const includeLegacy = req.query.include_legacy === "true" && isAdminRequest;
        const result = await getShowsFromDbLite(search, category, page, limit, {
          onlyMainPath: !includeLegacy,
          dedupe: isAdminRequest,
          genre,
           year,
           sort,
           missingTmdb,
           identity,
         });
        const visibility = isAdminRequest ? null : await getCatalogVisibility();
        const shows = visibility
          ? (result.shows as any[]).filter((show) => !isCatalogItemHidden(show, visibility))
          : result.shows;
        // Cache for 5 minutes, allow stale while revalidating
        res.setHeader('Cache-Control', isAdminRequest ? 'private, no-store' : 'public, max-age=300, stale-while-revalidate=60');
        res.setHeader('X-Catalog-Count', String(result.total || 0));
        res.json({ ...result, shows });
      } else {
        const showsList = await getShowsFromDb(search, category);
        // The non-lite endpoint is kept for older clients, but it is still a
        // public catalog route.  Legacy Show/Episode rows must not bypass the
        // main-path policy simply because the caller omitted `lite=true`.
        if (req.query.include_legacy === "true" && isAdminRequest) {
          res.json(showsList);
          return;
        }
        const playableShows = await filterShowsToMainPath(showsList as any[]);
        const visibility = await getCatalogVisibility();
        const publicShows = playableShows.map((show: any) => {
          const playbackKind = playbackKindForCategory(show.category);
          const episodes = Array.isArray(show.episodes)
            ? show.episodes.filter((episode: any) =>
                filterMainPathLinks(
                  episode.source_url ? [{ url: episode.source_url }] : [],
                  playbackKind,
                  show.main_path_overrides,
                ).length > 0,
              )
            : [];
          return { ...show, episodes };
        });
        res.json(publicShows.filter((show: any) => !isCatalogItemHidden(show, visibility)));
      }
    } catch (e: any) {
      res.status(500).json({ error: `Error leyendo catÃ¡logo: ${e.message}` });
    }
  });

  // GET /api/v1/shows/:show_id
  app.get("/api/v1/shows/:show_id", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      if (!hasValidAdminSession(req) && isCatalogItemHidden(show, await getCatalogVisibility())) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      const playbackKind = playbackKindForCategory((show as any).category);
      // media_item_id espejo (relaciÃ³n por clave canÃ³nica, sin FK): lo consume el
      // editor del catÃ¡logo para play-multi / "plataformas disponibles".
      let media_item_id: string | null = null;
      const category = String((show as any).category || "").toLowerCase();
      const norm = (show as any).normalized_title;
      const base = (show as any).base_normalized_title || norm;
      const animeIdentity = playbackKind === "anime" && (show as any).tmdb_id == null
        ? await lookupAnimeIdentityByTitle(String((show as any).title || norm || ""))
        : null;
      const titleKeys = [...new Set([
        norm,
        base,
        ...(animeIdentity?.normalizedAliases || []),
      ].filter(Boolean))];
      let canonicalItem: any = null;
      let canonicalCandidates: any[] = [];
      if (norm || (show as any).tmdb_id != null) {
        const canonicalKinds = playbackKind === "movie" ? ["movie"] : [playbackKind, "series", "anime"];
        canonicalCandidates = await prisma.mediaItem.findMany({
          where: {
            AND: [
              { kind: { in: canonicalKinds } },
              {
                OR: [
                  ...(titleKeys.length ? [{ base_normalized_title: { in: titleKeys } }] : []),
                  ...(titleKeys.length ? [{ normalized_title: { in: titleKeys } }] : []),
                  ...((show as any).tmdb_id != null ? [{ tmdb_id: (show as any).tmdb_id }] : []),
                ],
              },
            ],
          },
          include: {
            episodes: {
              orderBy: [{ season_number: "asc" }, { episode_number: "asc" }],
              include: { links: true },
            },
          },
        });
        // Several historical imports can share a localized/base title. Pick
        // the TMDB match that actually has a main-path source before falling
        // back to the oldest metadata-only mirror; otherwise a legacy-only
        // twin can hide the active Gnula/Cinecalidad/Zoko links in the ficha.
        canonicalItem = [...canonicalCandidates]
          .map((item: any) => {
            const activeLinks = item.episodes.reduce(
              (count: number, episode: any) => count + filterMainPathLinks(episode.links || [], playbackKind, (show as any).main_path_overrides).length,
              0,
            );
            const tmdbMatch = (show as any).tmdb_id != null && item.tmdb_id === (show as any).tmdb_id ? 1 : 0;
            const exactTitle = item.normalized_title === norm ? 1 : 0;
            return { item, activeLinks, tmdbMatch, exactTitle };
          })
          .sort((a, b) =>
            b.tmdbMatch - a.tmdbMatch ||
            (b.activeLinks > 0 ? 1 : 0) - (a.activeLinks > 0 ? 1 : 0) ||
            b.activeLinks - a.activeLinks ||
            b.exactTitle - a.exactTitle ||
            new Date(a.item.created_at).getTime() - new Date(b.item.created_at).getTime()
          )[0]?.item || null;
        media_item_id = canonicalItem?.id ?? null;
      }
      const legacyEpisodes = (show as any).episodes || [];
      // Los crawlers pueden haber guardado LatAnime y ZokoAnime en MediaItems
      // distintos. Mostrar únicamente `canonicalItem.episodes` hacía que la
      // ficha ocultara una plataforma aunque existiera para la misma obra.
      // La fila elegida sigue siendo la primera para conservar ids estables;
      // sus episodios se combinan con todos los twins equivalentes.
      const canonicalEpisodes = mergeCanonicalEpisodes([
        canonicalItem?.episodes || [],
        ...((canonicalCandidates || [])
          .filter((item: any) => item.id !== canonicalItem?.id)
          .map((item: any) => item.episodes || [])),
      ]);
      const requestedSeason = Number.parseInt(String(parseTitleQuery(String((show as any).title || "")).season || 1), 10) || 1;
      const hasZokoForSeason = canonicalEpisodes.some((episode: any) =>
        episode.season_number === requestedSeason && (episode.links || []).some((link: any) => normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime"),
      );
      if (playbackKind === "anime" && animeIdentity?.malId && hasZokoForSeason) {
        const malId = animeIdentity.malId;
        for (const episode of canonicalEpisodes) {
          if (episode.season_number !== requestedSeason || (episode.links || []).some((link: any) => normalizeProviderId(link.source_site || link.host || link.url) === "zokoanime")) continue;
          const locator = (rendition: "sub" | "dub") => `https://zokoanime.video/stream/mal/${malId}/${episode.episode_number}/${rendition}?color=35d5bf`;
          episode.links.push(
            { url: locator("sub"), source_site: "zokoanime.video", link_type: "sub", language: "sub", audio_language: "ja", subtitle_language: "en", canonical_locator: locator("sub") },
            { url: locator("dub"), source_site: "zokoanime.video", link_type: "dub", language: "dub", audio_language: "en", canonical_locator: locator("dub") },
          );
        }
      }
      const episodes = buildDisplayEpisodes(
        legacyEpisodes,
        canonicalEpisodes,
        playbackKind,
        showId,
        (show as any).main_path_overrides,
      );
      const episode_platforms = countDisplayPlatforms(
        canonicalEpisodes,
        episodes,
        playbackKind,
        (show as any).main_path_overrides,
      );
      res.json({ ...(show as any), episodes, media_item_id, episode_platforms });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Identidad TMDB manual para moderación. Primero devuelve los conflictos y
  // solo fusiona cuando el panel envía explícitamente merge_show_id; así un ID
  // pegado por accidente nunca absorbe otra obra silenciosamente.
  app.get("/api/v1/admin/shows/:show_id/identity-check", async (req: Request, res: Response) => {
    try {
      const tmdbId = Number(req.query.tmdb_id);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: "tmdb_id inválido." });
      const show = await prisma.show.findUnique({ where: { id: req.params.show_id }, select: { id: true, category: true, title: true } });
      if (!show) return res.status(404).json({ error: "Obra no encontrada." });
      const isMovie = String(show.category || "").toLowerCase() === "movie";
      const categories = isMovie ? ["movie"] : ["anime", "series"];
      const [shows, mediaItems, similarCandidates] = await Promise.all([
        prisma.show.findMany({
          where: { tmdb_id: tmdbId, category: { in: categories }, id: { not: show.id } },
          select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true, year: true },
          orderBy: { updated_at: "desc" },
        }),
        prisma.mediaItem.findMany({
          where: { tmdb_id: tmdbId, kind: { in: isMovie ? ["movie"] : ["anime", "series"] } },
          select: { id: true, title: true, kind: true, tmdb_id: true, poster_url: true, year: true },
          orderBy: { updated_at: "desc" },
        }),
        findSimilarShowCandidates(show.id, show.title, show.category, tmdbId),
      ]);
      res.json({ ok: true, requested_tmdb_id: tmdbId, conflicts: { shows, media_items: mediaItems }, similar_candidates: similarCandidates });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "No se pudo comprobar la identidad." });
    }
  });

  // Busca una obra por cualquier identificador externo y devuelve una
  // propuesta revisable. Nunca escribe ni fusiona por sí sola.
  app.post("/api/v1/admin/shows/:show_id/identity-match", async (req: Request, res: Response) => {
    try {
      const show = await prisma.show.findUnique({
        where: { id: req.params.show_id },
        select: { id: true, category: true },
      });
      if (!show) return res.status(404).json({ error: "Obra no encontrada." });
      const source = String(req.body?.source || "").trim().toLowerCase() as AdminIdentitySource;
      const allowed: AdminIdentitySource[] = ["tmdb", "imdb", "mal", "anilist", "kitsu", "anidb", "tvdb"];
      if (!allowed.includes(source)) return res.status(400).json({ error: "Fuente de identidad no soportada." });
      const preview = await previewAdminIdentity({
        showId: show.id,
        category: show.category,
        source,
        value: req.body?.value,
      });
      return res.json({ ok: true, ...preview });
    } catch (error: any) {
      const message = error?.message || "No se pudo consultar el identificador.";
      return res.status(/formato válido|requerido/i.test(message) ? 400 : 502).json({ error: message });
    }
  });

  app.post("/api/v1/admin/shows/:show_id/identity", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      const show = await prisma.show.findUnique({ where: { id: showId } });
      if (!show) return res.status(404).json({ error: "Obra no encontrada." });
      const rawTmdbId = req.body?.tmdb_id;
      const tmdbId = rawTmdbId === null || rawTmdbId === "" ? null : Number(rawTmdbId);
      if (tmdbId !== null && (!Number.isInteger(tmdbId) || tmdbId <= 0)) return res.status(400).json({ error: "tmdb_id inválido." });

      const isMovie = String(show.category || "").toLowerCase() === "movie";
      const categories = isMovie ? ["movie"] : ["anime", "series"];
      const conflicts = tmdbId === null ? [] : await prisma.show.findMany({
        where: { tmdb_id: tmdbId, category: { in: categories }, id: { not: showId } },
        select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true, year: true },
        orderBy: { updated_at: "desc" },
      });
      const mediaConflicts = tmdbId === null || show.tmdb_id === tmdbId ? [] : await prisma.mediaItem.findMany({
        where: { tmdb_id: tmdbId, kind: { in: isMovie ? ["movie"] : ["anime", "series"] } },
        select: { id: true, title: true, kind: true, tmdb_id: true, poster_url: true, year: true },
        orderBy: { updated_at: "desc" },
      });
      const similarCandidates = tmdbId === null
        ? []
        : await findSimilarShowCandidates(show.id, show.title, show.category, tmdbId);
      const requestedMergeId = typeof req.body?.merge_show_id === "string" ? req.body.merge_show_id : undefined;
      if (conflicts.length > 0 && !requestedMergeId) {
        return res.status(409).json({
          code: "TMDB_CONFLICT",
          error: "Ya existe otra obra con ese TMDB ID.",
          conflicts,
          similar_candidates: similarCandidates,
          requires_confirmation: true,
        });
      }
      if (conflicts.length === 0 && mediaConflicts.length > 0 && !req.body?.allow_media_conflict) {
        return res.status(409).json({
          code: "TMDB_MEDIA_CONFLICT",
          error: "Ya existe un registro canónico con ese TMDB ID.",
          conflicts: [],
          media_conflicts: mediaConflicts,
          similar_candidates: similarCandidates,
          requires_confirmation: true,
        });
      }
      if (similarCandidates.length > 0 && !requestedMergeId && !req.body?.allow_similar) {
        return res.status(409).json({
          code: "TMDB_SIMILAR",
          error: "Hay fichas con un título muy parecido.",
          conflicts: [],
          media_conflicts: [],
          similar_candidates: similarCandidates,
          requires_confirmation: true,
        });
      }
      if (requestedMergeId && ![...conflicts, ...similarCandidates].some((item) => item.id === requestedMergeId)) {
        return res.status(400).json({ error: "La obra elegida para fusionar no coincide con el conflicto comprobado." });
      }
      if (requestedMergeId) {
        const merged = await mergeTwoShows(showId, requestedMergeId, { dryRun: false });
        if (!merged.ok) return res.status(400).json({ error: merged.detail });
      }

      const category = isMovie ? "movie" : String(show.category || "anime").toLowerCase() === "series" ? "series" : "anime";
      let metadata: any = null;
      if (req.body?.regenerate_metadata && tmdbId !== null) {
        metadata = await getPublicCatalogDetail(category, String(tmdbId));
        if (!metadata) return res.status(502).json({ error: "TMDB no devolvió metadatos para ese ID." });
      }

      const title = typeof metadata?.title === "string" && metadata.title.trim() ? metadata.title.trim() : show.title;
      const normalized = normalizeTitle(title);
      const baseNormalized = normalizeBaseTitle(title) || normalized;
      const manualOverrides: Record<string, unknown> = show.manual_overrides && typeof show.manual_overrides === "object" && !Array.isArray(show.manual_overrides)
        ? { ...(show.manual_overrides as Record<string, unknown>) }
        : {};
      const resolvedIdentity = {
        imdb_id: metadata?.imdb_id ?? metadata?.external_ids?.imdb_id ?? show.imdb_id ?? null,
        tvdb_id: metadata?.tvdb_id ?? metadata?.external_ids?.tvdb_id ?? show.tvdb_id ?? null,
        mal_id: metadata?.mal_id ?? show.mal_id ?? null,
        anilist_id: metadata?.anilist_id ?? show.anilist_id ?? null,
        kitsu_id: metadata?.kitsu_id ?? show.kitsu_id ?? null,
        anidb_id: metadata?.anidb_id ?? show.anidb_id ?? null,
      };
      const showData: any = {
        tmdb_id: tmdbId,
        ...resolvedIdentity,
        ...(metadata ? {
          title,
          normalized_title: normalized,
          base_normalized_title: baseNormalized,
          original_title: metadata.original_title ?? show.original_title,
          description: metadata.description ?? show.description,
          poster_url: metadata.poster_url ?? show.poster_url,
          banner_url: metadata.banner_url ?? metadata.backdrop_url ?? show.banner_url,
          genres: Array.isArray(metadata.genres) ? metadata.genres.join(", ") : metadata.genres ?? show.genres,
          year: Number.isFinite(Number(metadata.year)) ? Number(metadata.year) : show.year,
          rating: Number.isFinite(Number(metadata.rating)) ? Number(metadata.rating) : show.rating,
        } : {}),
      };
      for (const field of ["title", "description", "genres", "year", "rating", "status", "category", "poster_url", "banner_url", "japanese_title", "english_title"]) {
        if (Object.prototype.hasOwnProperty.call(manualOverrides, field)) showData[field] = manualOverrides[field];
      }
      if (typeof showData.title === "string" && showData.title.trim()) {
        showData.normalized_title = normalizeTitle(showData.title);
        showData.base_normalized_title = normalizeBaseTitle(showData.title) || showData.normalized_title;
      }
      manualOverrides.tmdb_id = tmdbId;
      showData.manual_overrides = manualOverrides;
      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.show.update({ where: { id: showId }, data: showData });
        const itemKind = isMovie ? "movie" : { in: ["anime", "series"] };
        const mediaItems = await tx.mediaItem.findMany({
          where: {
            kind: itemKind as any,
            OR: [
              ...(show.tmdb_id ? [{ tmdb_id: show.tmdb_id }] : []),
              { normalized_title: show.normalized_title },
              ...(show.base_normalized_title ? [{ base_normalized_title: show.base_normalized_title }] : []),
            ],
          },
          select: { id: true },
        });
        if (mediaItems.length > 0) {
          const mediaData: any = {
            tmdb_id: tmdbId,
            ...resolvedIdentity,
            ...(metadata ? {
              title,
              normalized_title: normalized,
              base_normalized_title: baseNormalized,
              original_title: metadata.original_title ?? undefined,
              description: metadata.description ?? undefined,
              poster_url: metadata.poster_url ?? undefined,
              backdrop_path: metadata.backdrop_path ?? undefined,
              year: Number.isFinite(Number(metadata.year)) ? Number(metadata.year) : undefined,
              rating: Number.isFinite(Number(metadata.rating)) ? Number(metadata.rating) : undefined,
            } : {}),
          };
          // El índice multi-fuente también debe conservar los valores que el
          // administrador fijó en la ficha; de lo contrario un refresco de
          // identidad mostraría títulos distintos según la pantalla.
          for (const field of ["title", "description", "poster_url", "year", "rating"]) {
            if (Object.prototype.hasOwnProperty.call(manualOverrides, field)) mediaData[field] = manualOverrides[field];
          }
          if (typeof mediaData.title === "string" && mediaData.title.trim()) {
            mediaData.normalized_title = normalizeTitle(mediaData.title);
            mediaData.base_normalized_title = normalizeBaseTitle(mediaData.title) || mediaData.normalized_title;
          }
          await tx.mediaItem.updateMany({
            where: { id: { in: mediaItems.map((item) => item.id) } },
            data: mediaData,
          });
        }
        return result;
      });
      res.json({ ok: true, show: updated, merged_show_id: requestedMergeId || null, metadata_regenerated: Boolean(metadata) });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "No se pudo actualizar la identidad TMDB." });
    }
  });

  app.get("/api/v1/admin/catalog/policy", async (_req: Request, res: Response) => {
    try {
      return res.json({ ok: true, ...getCatalogPolicy(), providers: getCatalogPolicyProviders() });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudo leer la política de fuentes." });
    }
  });

  app.put("/api/v1/admin/catalog/policy", async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const providerModes = body.providerModes && typeof body.providerModes === "object" && !Array.isArray(body.providerModes)
        ? body.providerModes
        : {};
      const policy = saveCatalogPolicy({ providerModes });
      return res.json({ ok: true, ...policy, providers: getCatalogPolicyProviders() });
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || "No se pudo guardar la política de fuentes." });
    }
  });

  // Comprueba bajo demanda si los proveedores JIT tienen una respuesta útil
  // para la obra. No persiste enlaces ni toca el catálogo: cada ejecución es
  // una sonda corta y explícita desde el servidor.
  app.post("/api/v1/admin/source-availability", async (req: Request, res: Response) => {
    const kind = String(req.body?.kind || "").toLowerCase();
    const tmdbId = Number(req.body?.tmdb_id ?? req.body?.tmdbId);
    if (!["movie", "series", "anime"].includes(kind) || !Number.isInteger(tmdbId) || tmdbId <= 0) {
      return res.status(400).json({ error: "kind y tmdb_id inválidos." });
    }
    const season = Math.max(1, Math.round(Number(req.body?.season) || 1));
    const episode = Math.max(1, Math.round(Number(req.body?.episode) || 1));
    const started = Date.now();
    try {
      const gateway = await resolveByTmdb({ kind: kind as any, tmdbId, season, episode, persist: false });
      const candidates = [
        ...gateway.sources.map((source: any) => ({
          provider: normalizeProviderId(source.provider),
          url: String(source.url || ""),
          type: source.streamType || "direct",
        })),
        ...gateway.fallbackCandidates.map((source: any) => ({
          provider: normalizeProviderId(source.provider),
          url: String(source.url || ""),
          type: source.type || "embed",
        })),
        // Aunque TMDB o la base local no tengan todavía una fila de fuente,
        // estos dos proveedores tienen un locator público determinista. Se
        // sondean aquí bajo demanda para que el panel pueda decir "sin
        // respuesta" en lugar de confundir "sin candidato persistido" con
        // "proveedor no disponible".
        {
          provider: "vidsrc",
          url: kind === "movie"
            ? `https://vidsrc.me/embed/movie/${tmdbId}`
            : `https://vidsrc.me/embed/tv/${tmdbId}/${season}/${episode}`,
          type: "embed",
        },
        {
          provider: "vidsrcto",
          url: kind === "movie"
            ? `https://vidsrcto.to/embed/movie/${tmdbId}`
            : `https://vidsrcto.to/embed/tv/${tmdbId}/${season}/${episode}`,
          type: "embed",
        },
      ].filter((candidate) => candidate.url && ["vidsrc", "vidsrcto", "zokoanime"].includes(candidate.provider));
      const unique = [...new Map(candidates.map((candidate) => [`${candidate.provider}|${candidate.url}`, candidate])).values()].slice(0, 8);

      const checks = await Promise.all(unique.map(async (candidate) => {
        const checkStarted = Date.now();
        try {
          let targetUrl = candidate.url;
          let resolved = candidate.type === "direct";
          let reason: string | undefined;
          if (!resolved) {
            const meta = await Promise.race([
              resolutionCoordinator.resolve(candidate.url),
              new Promise<ResolvedStreamMeta | null>((resolve) => setTimeout(() => resolve(null), 2_500)),
            ]);
            if (meta?.resolved && meta.url) {
              targetUrl = meta.url;
              resolved = true;
            } else {
              reason = meta?.failure_reason || "provider_no_media";
            }
          }
          if (!resolved) {
            return { provider: candidate.provider, url: candidate.url, type: candidate.type, ok: false, status: 0, reason, latency_ms: Date.now() - checkStarted };
          }
          const health = await probeStream(targetUrl, { timeoutMs: 2_000, playerReferer: candidate.url });
          return {
            provider: candidate.provider,
            url: candidate.url,
            type: candidate.type,
            ok: health.ok,
            status: health.status || 0,
            reason: health.reason,
            latency_ms: health.latencyMs ?? (Date.now() - checkStarted),
          };
        } catch (error: any) {
          return { provider: candidate.provider, url: candidate.url, type: candidate.type, ok: false, status: 0, reason: error?.message || "probe_error", latency_ms: Date.now() - checkStarted };
        }
      }));

      const providers = ["vidsrc", "vidsrcto", "zokoanime"].map((provider) => {
        const providerChecks = checks.filter((check) => check.provider === provider);
        return {
          provider,
          checked: providerChecks.length,
          available: providerChecks.some((check) => check.ok),
          checks: providerChecks,
        };
      });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ ok: true, kind, tmdb_id: tmdbId, season, episode, elapsed_ms: Date.now() - started, providers });
    } catch (error: any) {
      return res.status(502).json({ error: error?.message || "No se pudo consultar la disponibilidad." });
    }
  });

  // Inventario administrativo de fuentes: muestra el locator persistente y
  // toda la evidencia del resolver, sin exponerlo en el catálogo público.
  app.get("/api/v1/admin/shows/:show_id/legacy-episodes", async (req: Request, res: Response) => {
    try {
      const show = await prisma.show.findUnique({ where: { id: req.params.show_id }, select: { id: true } });
      if (!show) return res.status(404).json({ error: "Obra no encontrada." });
      const episodes = await prisma.episode.findMany({
        where: { show_id: show.id },
        orderBy: [{ episode_number: "asc" }, { created_at: "asc" }],
        select: { id: true, show_id: true, title: true, episode_number: true, source_url: true, updated_at: true },
      });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ episodes });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudieron cargar las fuentes legacy." });
    }
  });

  app.patch("/api/v1/admin/shows/:show_id/legacy-episodes/:episode_id", async (req: Request, res: Response) => {
    try {
      const current = await prisma.episode.findFirst({ where: { id: req.params.episode_id, show_id: req.params.show_id } });
      if (!current) return res.status(404).json({ error: "Episodio legacy no encontrado." });
      const data: Record<string, unknown> = {};
      if (req.body?.title !== undefined) {
        const title = String(req.body.title || "").trim().slice(0, 300);
        if (!title) return res.status(400).json({ error: "El título del episodio no puede quedar vacío." });
        data.title = title;
      }
      if (req.body?.episode_number !== undefined) {
        const episodeNumber = Number(req.body.episode_number);
        if (!Number.isFinite(episodeNumber) || episodeNumber < 0) return res.status(400).json({ error: "episode_number inválido." });
        data.episode_number = episodeNumber;
      }
      if (req.body?.source_url !== undefined) {
        data.source_url = String(req.body.source_url || "").trim().slice(0, 2000);
      }
      const episode = await prisma.episode.update({ where: { id: current.id }, data });
      return res.json({ ok: true, episode });
    } catch (error: any) {
      return res.status(error?.code === "P2025" ? 404 : 400).json({ error: error?.message || "No se pudo actualizar el episodio legacy." });
    }
  });

  app.delete("/api/v1/admin/shows/:show_id/legacy-episodes/:episode_id", async (req: Request, res: Response) => {
    try {
      const current = await prisma.episode.findFirst({ where: { id: req.params.episode_id, show_id: req.params.show_id }, select: { id: true } });
      if (!current) return res.status(404).json({ error: "Episodio legacy no encontrado." });
      await prisma.episode.delete({ where: { id: current.id } });
      return res.status(204).end();
    } catch (error: any) {
      return res.status(error?.code === "P2025" ? 404 : 400).json({ error: error?.message || "No se pudo eliminar el episodio legacy." });
    }
  });

  // Copia una página legacy al inventario canónico sin borrar la referencia
  // original. Es deliberadamente idempotente para que el administrador pueda
  // reintentar la promoción después de corregir proveedor o coordenadas.
  app.post("/api/v1/admin/shows/:show_id/promote-legacy", async (req: Request, res: Response) => {
    try {
      const show = await prisma.show.findUnique({
        where: { id: req.params.show_id },
        select: {
          id: true, title: true, original_title: true, description: true, category: true,
          tmdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true, anidb_id: true,
          imdb_id: true, tvdb_id: true, year: true, rating: true, genres: true,
          poster_url: true, poster_path: true, backdrop_path: true,
        },
      });
      if (!show) return res.status(404).json({ error: "Obra no encontrada." });

      const episodeId = typeof req.body?.episode_id === "string" ? req.body.episode_id.trim() : "";
      const legacyEpisode = episodeId
        ? await prisma.episode.findFirst({ where: { id: episodeId, show_id: show.id } })
        : await prisma.episode.findFirst({ where: { show_id: show.id }, orderBy: { episode_number: "asc" } });
      if (!legacyEpisode) return res.status(404).json({ error: "No se encontró el episodio legacy." });

      const url = String(req.body?.url ?? legacyEpisode.source_url ?? "").trim().slice(0, 2000);
      if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "La página de la fuente debe ser una URL http(s)." });
      const requestedSite = typeof req.body?.source_site === "string" ? req.body.source_site.trim().slice(0, 120) : "";
      const sourceSite = requestedSite || normalizeProviderId(url);
      if (!sourceSite || sourceSite === "unknown") return res.status(400).json({ error: "No pude detectar el proveedor; escribe uno manualmente." });

      const kind = show.category === "anime" ? "anime" : show.category === "movie" ? "movie" : "series";
      const normalized = normalizeTitle(show.title);
      const baseNormalized = normalizeBaseTitle(show.title) || normalized;
      let mediaItem = show.tmdb_id
        ? await prisma.mediaItem.findFirst({ where: { tmdb_id: show.tmdb_id, kind }, orderBy: { created_at: "asc" } })
        : null;
      if (!mediaItem) {
        mediaItem = await prisma.mediaItem.findFirst({
          where: { OR: [{ normalized_title: normalized, kind }, { base_normalized_title: baseNormalized, kind }] },
          orderBy: { created_at: "asc" },
        });
      }
      if (!mediaItem) {
        mediaItem = await prisma.mediaItem.create({
          data: {
            normalized_title: normalized,
            base_normalized_title: baseNormalized,
            title: show.title,
            original_title: show.original_title,
            description: show.description,
            rating: show.rating,
            genres: show.genres,
            tmdb_id: show.tmdb_id,
            mal_id: show.mal_id,
            anilist_id: show.anilist_id,
            kitsu_id: show.kitsu_id,
            anidb_id: show.anidb_id,
            imdb_id: show.imdb_id,
            tvdb_id: show.tvdb_id,
            kind,
            year: show.year,
            poster_url: show.poster_url,
            poster_path: show.poster_path,
            backdrop_path: show.backdrop_path,
          },
        });
      }

      const season = Math.max(1, Math.round(Number(req.body?.season_number) || 1));
      const episodeNumber = Number(req.body?.episode_number ?? legacyEpisode.episode_number);
      if (!Number.isFinite(episodeNumber) || episodeNumber < 0) return res.status(400).json({ error: "episode_number inválido." });
      const mediaEpisode = await prisma.mediaEpisode.upsert({
        where: { media_item_id_season_number_episode_number: { media_item_id: mediaItem.id, season_number: season, episode_number: episodeNumber } },
        create: { media_item_id: mediaItem.id, season_number: season, episode_number: episodeNumber },
        update: {},
      });
      const existingLink = await prisma.sourceLink.findFirst({ where: { media_episode_id: mediaEpisode.id, source_site: sourceSite, url } });
      const link = existingLink
        ? await prisma.sourceLink.update({ where: { id: existingLink.id }, data: { canonical_locator: url, main_path_override: req.body?.main_path_override === false ? false : true } })
        : await prisma.sourceLink.create({
          data: {
            media_episode_id: mediaEpisode.id,
            source_site: sourceSite,
            url,
            canonical_locator: url,
            link_type: typeof req.body?.link_type === "string" ? req.body.link_type.trim().slice(0, 40) || "direct" : "direct",
            source_status: "discovered",
            main_path_override: req.body?.main_path_override === false ? false : true,
            is_verified: Boolean(req.body?.is_verified),
          },
        });
      return res.status(existingLink ? 200 : 201).json({ ok: true, promoted: !existingLink, media_item_id: mediaItem.id, media_episode_id: mediaEpisode.id, link });
    } catch (error: any) {
      return res.status(error?.code === "P2002" ? 409 : 400).json({ error: error?.message || "No se pudo promover la fuente a canónica." });
    }
  });

  app.get("/api/v1/admin/media-items/:media_item_id/streams", async (req: Request, res: Response) => {
    try {
      const item = await prisma.mediaItem.findUnique({
        where: { id: req.params.media_item_id },
        select: {
          id: true, title: true, kind: true, tmdb_id: true,
          episodes: {
            orderBy: [{ season_number: "asc" }, { episode_number: "asc" }],
            include: { links: { orderBy: [{ source_site: "asc" }, { priority_tier: "asc" }] } },
          },
        },
      });
      if (!item) return res.status(404).json({ error: "MediaItem no encontrado." });
      res.json(item);
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "No se pudieron cargar las fuentes." });
    }
  });

  app.post("/api/v1/admin/media-items/:media_item_id/streams", async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const season = Math.max(1, Math.round(Number(body.season_number) || 1));
      const episode = Number(body.episode_number);
      const url = typeof body.url === "string" ? body.url.trim().slice(0, 2000) : "";
      const sourceSite = typeof body.source_site === "string" ? body.source_site.trim().slice(0, 120) : "";
      if (!Number.isFinite(episode) || episode < 0 || !url || !sourceSite) return res.status(400).json({ error: "episode_number, source_site y url son obligatorios." });
      const item = await prisma.mediaItem.findUnique({ where: { id: req.params.media_item_id }, select: { id: true } });
      if (!item) return res.status(404).json({ error: "MediaItem no encontrado." });
      const rawPriority = body.priority_tier === undefined || body.priority_tier === "" || body.priority_tier === null ? null : Number(body.priority_tier);
      if (rawPriority !== null && !Number.isFinite(rawPriority)) return res.status(400).json({ error: "priority_tier inválido." });
      const mediaEpisode = await prisma.mediaEpisode.upsert({
        where: { media_item_id_season_number_episode_number: { media_item_id: item.id, season_number: season, episode_number: episode } },
        create: { media_item_id: item.id, season_number: season, episode_number: episode },
        update: {},
      });
      const link = await prisma.sourceLink.create({
        data: {
          media_episode_id: mediaEpisode.id,
          source_site: sourceSite,
          url,
          link_type: typeof body.link_type === "string" ? body.link_type.trim().slice(0, 40) || "direct" : "direct",
          language: typeof body.language === "string" ? body.language.trim().slice(0, 40) || null : null,
          audio_language: typeof body.audio_language === "string" ? body.audio_language.trim().slice(0, 40) || null : null,
          subtitle_language: typeof body.subtitle_language === "string" ? body.subtitle_language.trim().slice(0, 40) || null : null,
          canonical_locator: typeof body.canonical_locator === "string" ? body.canonical_locator.trim().slice(0, 2000) || null : null,
          source_status: typeof body.source_status === "string" ? body.source_status.trim().slice(0, 40) || "discovered" : "discovered",
          // Una fuente añadida desde administración es una instrucción
          // explícita: intenta resolverla aunque el proveedor global esté en
          // legacy. El selector permite devolverla a global o legacy.
          main_path_override: body.main_path_override === undefined
            ? true
            : body.main_path_override === true ? true : body.main_path_override === false ? false : null,
          priority_tier: rawPriority === null ? null : Math.max(0, Math.min(99, Math.round(rawPriority))),
        },
      });
      res.status(201).json({ ok: true, link });
    } catch (error: any) {
      res.status(error?.code === "P2002" ? 409 : 400).json({ error: error?.message || "No se pudo crear la fuente." });
    }
  });

  app.patch("/api/v1/admin/source-links/:link_id", async (req: Request, res: Response) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const data: any = {};
      for (const key of ["source_site", "url", "link_type", "language", "audio_language", "subtitle_language", "host", "canonical_locator", "external_id", "extraction_method", "resolver_version", "failure_reason", "source_status"]) {
        if (body[key] !== undefined) data[key] = body[key] === null ? null : String(body[key]).trim().slice(0, 2000);
      }
      for (const key of ["priority_tier"]) {
        if (body[key] !== undefined) {
          if (body[key] === null || body[key] === "") data[key] = null;
          else {
            const parsedPriority = Number(body[key]);
            if (!Number.isFinite(parsedPriority)) return res.status(400).json({ error: "priority_tier inválido." });
            data[key] = Math.max(0, Math.min(99, Math.round(parsedPriority)));
          }
        }
      }
      if (body.is_verified !== undefined) data.is_verified = Boolean(body.is_verified);
      if (body.main_path_override !== undefined) {
        data.main_path_override = body.main_path_override === true ? true : body.main_path_override === false ? false : null;
      }
      if (data.url !== undefined && !data.url) return res.status(400).json({ error: "La URL de la fuente no puede quedar vacía." });
      const hasSeason = body.season_number !== undefined;
      const hasEpisode = body.episode_number !== undefined;
      let requestedSeason: number | undefined;
      let requestedEpisode: number | undefined;
      if (hasSeason) {
        const parsed = Number(body.season_number);
        if (!Number.isInteger(parsed) || parsed < 1) return res.status(400).json({ error: "season_number debe ser un entero mayor o igual a 1." });
        requestedSeason = parsed;
      }
      if (hasEpisode) {
        const parsed = Number(body.episode_number);
        if (!Number.isFinite(parsed) || parsed < 0) return res.status(400).json({ error: "episode_number debe ser un número mayor o igual a 0." });
        requestedEpisode = parsed;
      }
      const currentLink = (hasSeason || hasEpisode)
        ? await prisma.sourceLink.findUnique({ where: { id: req.params.link_id }, include: { media_episode: true } })
        : null;
      if ((hasSeason || hasEpisode) && !currentLink) return res.status(404).json({ error: "Fuente no encontrada." });
      let updated;
      const coordinatesChanged = Boolean(currentLink && ((requestedSeason !== undefined && requestedSeason !== currentLink.media_episode.season_number) || (requestedEpisode !== undefined && requestedEpisode !== currentLink.media_episode.episode_number)));
      if (currentLink && coordinatesChanged) {
        const targetSeason = requestedSeason ?? currentLink.media_episode.season_number;
        const targetEpisode = requestedEpisode ?? currentLink.media_episode.episode_number;
        updated = await prisma.$transaction(async (tx) => {
          const target = await tx.mediaEpisode.upsert({
            where: { media_item_id_season_number_episode_number: { media_item_id: currentLink.media_episode.media_item_id, season_number: targetSeason, episode_number: targetEpisode } },
            create: { media_item_id: currentLink.media_episode.media_item_id, season_number: targetSeason, episode_number: targetEpisode },
            update: {},
          });
          const moved = await tx.sourceLink.update({ where: { id: currentLink.id }, data: { ...data, media_episode_id: target.id } });
          if (target.id !== currentLink.media_episode_id) {
            const remaining = await tx.sourceLink.count({ where: { media_episode_id: currentLink.media_episode_id } });
            if (remaining === 0) await tx.mediaEpisode.delete({ where: { id: currentLink.media_episode_id } });
          }
          return moved;
        });
      } else {
        updated = await prisma.sourceLink.update({ where: { id: req.params.link_id }, data });
      }
      res.json({ ok: true, link: updated });
    } catch (error: any) {
      res.status(error?.code === "P2025" ? 404 : 400).json({ error: error?.message || "No se pudo actualizar la fuente." });
    }
  });

  app.delete("/api/v1/admin/source-links/:link_id", async (req: Request, res: Response) => {
    try {
      await prisma.sourceLink.delete({ where: { id: req.params.link_id } });
      res.status(204).end();
    } catch (error: any) {
      res.status(error?.code === "P2025" ? 404 : 400).json({ error: error?.message || "No se pudo eliminar la fuente." });
    }
  });

  // DELETE /api/v1/shows/:show_id
  app.delete("/api/v1/shows/:show_id", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      await deleteShowFromDb(showId);
      res.json({ status: "ok", message: `Serie '${show.title}' eliminada exitosamente.` });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/v1/shows/:show_id - Editor de catÃ¡logo: actualiza SOLO los campos
  // presentes en el body; si cambia el tÃ­tulo recalcula las claves canÃ³nicas de dedup.
  app.put("/api/v1/shows/:show_id", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ detail: "Body JSON requerido." });
      }
      const updated = await updateShowFields(showId, req.body);
      if (!updated) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: `Error actualizando la obra: ${e.message}` });
    }
  });

  // POST /api/v1/shows/:show_id/refresh-streams - Re-resuelve en JIT los servidores
  // de cada episodio y sincroniza hacia el MediaItem espejo. Puede tardar: se acusa
  // recibo (202) y el trabajo corre en background.
  app.post("/api/v1/shows/:show_id/refresh-streams", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      const show = await getShowByIdFromDb(showId);
      if (!show) {
        return res.status(404).json({ detail: "Serie no encontrada" });
      }
      res.status(202).json({
        ok: true,
        message: `Refresco de servidores para '${show.title}' iniciado en segundo plano.`,
        show_id: showId,
      });
      void refreshShowStreams(showId)
        .then((summary) =>
          console.log(`[RefreshStreams] '${show.title}' (${showId}): ${JSON.stringify(summary)}`)
        )
        .catch((e: any) => console.error(`[RefreshStreams] FallÃ³ refresco para ${showId}:`, e));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/shows/:show_id/force-metadata - Fuerza metadatos de TMDB por ID (TMDB/IMDb) o título
  app.post("/api/v1/shows/:show_id/force-metadata", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id || (req.params as any).id;
      if (!showId) {
        return res.status(400).json({ error: "Se requiere un ID de obra válido" });
      }

      const { query, tmdb_id, imdb_id, kind, apply_mode } = req.body || {};

      const parsedTmdbId = tmdb_id !== undefined && tmdb_id !== null && tmdb_id !== ""
        ? Number(tmdb_id)
        : undefined;
      if (parsedTmdbId !== undefined && (!Number.isFinite(parsedTmdbId) || parsedTmdbId <= 0)) {
        return res.status(400).json({ error: "tmdb_id debe ser un entero positivo" });
      }

      const parsedImdbId = typeof imdb_id === "string" ? imdb_id.trim() : undefined;
      if (parsedImdbId && !/^tt\d{5,12}$/i.test(parsedImdbId)) {
        return res.status(400).json({ error: "imdb_id debe tener formato válido (ej. tt1234567)" });
      }

      const parsedQuery = typeof query === "string" ? query.trim() : undefined;
      if (!parsedTmdbId && !parsedImdbId && !parsedQuery) {
        return res.status(400).json({
          error: "Se requiere al menos 'tmdb_id', 'imdb_id' o 'query' para forzar metadatos",
        });
      }

      const applyMode = apply_mode === "identity_only" ? "identity_only" : "full";

      const result = await forceShowMetadata(showId, {
        query: parsedQuery,
        tmdb_id: parsedTmdbId,
        imdb_id: parsedImdbId,
        kind: typeof kind === "string" ? kind.trim() : undefined,
        apply_mode: applyMode,
      });

      return res.json({
        ok: true,
        show: result.show,
        updated_show: result.show,
        media_item_synced: result.media_item_synced,
      });
    } catch (e: any) {
      if (e?.message?.includes("Serie no encontrada") || e?.message?.includes("no encontrada")) {
        return res.status(404).json({ error: e.message });
      }
      return res.status(500).json({ error: e.message || "Error al forzar metadatos" });
    }
  });

  // GET /api/v1/media (Legacy compatibility)
  app.get("/api/v1/media", async (req: Request, res: Response) => {
    try {
      const showsList = await getShowsFromDb();
      const mapped = showsList.map((s) => ({
        id: s.id,
        title: s.title,
        original_title: s.japanese_title || s.title,
        synopsis: s.description || "",
        poster_url: s.poster_url || "",
        backdrop_url: s.banner_url || s.poster_url || "",
        category: s.category || "anime",
        rating: s.rating || 8.0,
        year: s.year || 2024,
        sources: {
          master_m3u8: `/api/v1/media/${s.id}/stream`,
          fallback_mp4: null,
          qualities: [],
          subtitles: [],
        },
      }));
      res.json(mapped);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/proxy/image - Lightweight image proxy to bypass CORS
  app.get("/api/v1/proxy/image", async (req: Request, res: Response) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl || !targetUrl.startsWith("http")) {
      return res.status(400).send("Invalid URL");
    }
    try {
      const fetchRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": new URL(targetUrl).origin,
        },
      });
      if (!fetchRes.ok) {
        return res.status(fetchRes.status).send("Failed to fetch image");
      }
      res.setHeader("Content-Type", fetchRes.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400"); // Cache 1 day

      const arrayBuffer = await fetchRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.end(buffer);
    } catch (e) {
      res.status(500).send("Error proxying image");
    }
  });

  // VidSrc's subtitle catalog points to OpenSubtitles SRT downloads. Browsers
  // require WebVTT for <track>; keep this relay host-scoped and same-origin so
  // the internal player does not depend on subtitle CORS or download MIME.
  app.get("/api/v1/proxy/subtitle", async (req: Request, res: Response) => {
    const rawUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
    let targetUrl: URL;
    try {
      targetUrl = await assertSafePublicHttpUrl(rawUrl);
    } catch (error) {
      const detail = error instanceof UnsafeUrlError ? error.code : "unsafe_url";
      return res.status(400).json({ error: "URL de subtítulo no permitida", detail });
    }
    const host = targetUrl.hostname.toLowerCase();
    const allowedHost = host === "opensubtitles.org" || host.endsWith(".opensubtitles.org")
      || host === "opensubtitles.com" || host.endsWith(".opensubtitles.com");
    if (!allowedHost) return res.status(400).json({ error: "Host de subtítulo no permitido" });

    try {
      const upstream = await fetch(targetUrl, {
        signal: AbortSignal.timeout(8_000),
        headers: {
          Accept: "text/vtt,text/plain,application/x-subrip,*/*;q=0.5",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
          Referer: `${targetUrl.origin}/`,
        },
      });
      if (!upstream.ok) return res.status(upstream.status).send("Subtitle upstream unavailable");
      const vtt = subtitleTextToWebVtt(await upstream.text());
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(vtt);
    } catch (error: any) {
      return res.status(502).json({ error: "No se pudo obtener el subtítulo", detail: error?.message || "upstream_error" });
    }
  });

  // GET /api/v1/play/:episode_id - Just-In-Time Live Stream Resolver (Multi-source v2)
  app.get("/api/v1/play/:episode_id", handlePlayEpisode);

  // La sesión proxy nace solo cuando el navegador demuestra que la entrega
  // directa no sirve o el perfil exige headers protegidos.
  app.post("/api/v1/playback/sessions", async (req: Request, res: Response) => {
    const originalInput = typeof req.body?.original_url === "string" ? req.body.original_url.trim() : "";
    const resolutionId = typeof req.body?.resolution_id === "string"
      ? req.body.resolution_id.trim().slice(0, 200)
      : "";
    if (!originalInput) return res.status(400).json({ error: "original_url requerida" });
    let originalUrl: string;
    try {
      originalUrl = (await assertSafePublicHttpUrl(originalInput)).toString();
    } catch (error) {
      const detail = error instanceof UnsafeUrlError ? error.code : "unsafe_url";
      return res.status(400).json({ error: "URL no permitida", detail });
    }

    const resolutionLease = runtimeBudget.tryBeginResolution({ interactive: true });
    if (!resolutionLease) {
      return res.status(503).json({ error: "backend_busy", fallback: "next_candidate" });
    }
    try {
      const cached = resolutionId
        ? resolutionCoordinator.getByResolutionId(resolutionId, originalUrl)
        : undefined;
      // Reuse the just-validated HLS URL when its signed lease is still fresh.
      // Resolving VidSrc a second time here used to race its mirror/CDN rotation
      // and could turn a source that had just passed validation into a 422. The
      // playback session refreshes renewable streams after an upstream 401/403.
      const cachedIsFresh = Boolean(
        cached?.resolved && cached.url && cached.is_proxyable !== false
        && (!Number.isFinite(cached.expires_at) || cached.expires_at! > Date.now() + 5_000)
      );
      const meta = cachedIsFresh && cached
        ? cached
        : await resolvePlaybackLocator(originalUrl);
      // Proxyable and renewable are different properties. A current signed URL
      // may be relayed until its own deadline even when no stable locator exists
      // to renew it later.
      if (!meta.resolved || !meta.url || meta.is_proxyable === false) {
        return res.status(422).json({
          error: "stream_not_proxyable",
          fallback: "next_candidate",
          failure_reason: meta.failure_reason || "unresolved",
        });
      }
      const session = playbackSessions.createFromResolved(originalUrl, meta);
      const playbackManifest = /\.mpd(?:[?#]|$)/i.test(session.current.url) ? "master.mpd" : "master.m3u8";
      return res.status(201).json({
        session_id: session.id,
        playback_url: `/api/v1/playback/${encodeURIComponent(session.id)}/${playbackManifest}`,
        expires_at: session.current.expires_at,
        refresh_after: session.current.refresh_after,
        generation: session.current.generation,
        is_proxyable: session.current.is_proxyable ?? true,
        is_refreshable: session.current.is_refreshable ?? Boolean(session.current.canonical_locator),
      });
    } catch (error) {
      console.warn("[PlaybackSession] No se pudo crear sesión ligera:", error instanceof Error ? error.message : error);
      return res.status(502).json({ error: "session_resolution_failed", fallback: "next_candidate" });
    } finally {
      resolutionLease.release();
    }
  });

  app.get("/api/v1/playback/:sessionId/master.m3u8", playbackSessionHandlers.masterManifest);
  // DASH sessions share the same opaque resource store. The wildcard keeps
  // `media`/`initialization` templates usable after dash.js expands them.
  app.get("/api/v1/playback/:sessionId/master.mpd", playbackSessionHandlers.masterManifest);
  app.get("/api/v1/playback/:sessionId/resource/:resourceId", playbackSessionHandlers.resource);
  app.get(/^\/api\/v1\/playback\/([^/]+)\/resource\/([^/]+)\/(.*)$/, playbackSessionHandlers.resource);
  app.delete("/api/v1/playback/sessions/:sessionId", playbackSessionHandlers.closeSession);

  // Snapshot inmediato: nunca espera las sondas. Los datos se actualizan en
  // segundo plano con stale-while-revalidate para no sumar latencia al play.
  app.post("/api/v1/streams/health", async (req: Request, res: Response) => {
    const candidates = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const urls = [...new Set(candidates
      .filter((value: unknown): value is string => typeof value === "string" && /^https?:\/\//i.test(value))
      .map((value: string) => value.trim()))]
      .slice(0, 4);
    return res.json(await streamHealthService.getSnapshot(urls));
  });

  // POST /api/v1/resolve-embed - Resolución HTTP/estática ligera. Las sesiones
  // proxy se crean aparte y solo bajo demanda del reproductor.
  app.post(["/api/v1/resolve-embed", "/api/resolve-embed"], async (req: Request, res: Response) => {
    const rawInput = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!rawInput) {
      return res.status(400).json({ error: "URL requerida" });
    }
    let rawUrl: string;
    try {
      rawUrl = (await assertSafePublicHttpUrl(rawInput)).toString();
    } catch (error) {
      const detail = error instanceof UnsafeUrlError ? error.code : "unsafe_url";
      return res.status(400).json({ error: "URL no permitida", detail });
    }
    const resolutionLease = runtimeBudget.tryBeginResolution({ interactive: true });
    if (!resolutionLease) {
      return res.status(503).json({ error: "backend_busy", fallback: "next_candidate" });
    }

    try {
      const isNativeExternalUrl = (value: unknown): value is string =>
        typeof value === "string" && /^https?:\/\//i.test(value)
        && (
          /\.(?:m3u8|mpd|mp4|webm|mkv)(?:[?#]|$)/i.test(value) ||
          /\/get_video(?:\?|$)/i.test(value) ||
          /tapecontent\.net/i.test(value) ||
          /pixeldrain\.com\/api\/file\//i.test(value) ||
          /\/m3u8\//i.test(value) ||
          /hls-vod/i.test(value)
        );
      const isPlayableDirect = async (meta: ResolvedStreamMeta): Promise<boolean> => {
        if (!meta.resolved || meta.type !== "direct" || !meta.url) return false;
        if (/^\/api\/v1\/stream\/mega(?:\?|$)/i.test(meta.url)) {
          try {
            const target = new URL(meta.url, `${req.protocol}://${req.get("host") || "127.0.0.1:3010"}`);
            const megaUrl = target.searchParams.get("url") || "";
            return await Promise.race([
              probeMegaFile(megaUrl),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
            ]);
          } catch {
            return false;
          }
        }
        if (/^\/api\/v1\//i.test(meta.url)) return true;
        if (!isNativeExternalUrl(meta.url)) return false;
        const health = await probeStream(meta.url, { playerReferer: rawUrl });
        return health.ok;
      };
      const respondWithValidated = async (meta: ResolvedStreamMeta, strategy: string) => {
        if (!(await isPlayableDirect(meta))) return false;
        res.json(proxyResolvedSubtitles(
          buildResolveDeliveryResponse(meta, strategy, deliveryPlanner),
          meta.provider,
        ));
        return true;
      };

      // Zoko's stable locator carries the subtitle list in the player payload.
      // Resolve that locator itself before the generic page extractor turns it
      // into a CDN URL (the CDN URL no longer has subtitle metadata).
      if (/zokoanime\.video\/stream\//i.test(rawUrl)) {
        const zokoMeta = await EmbedResolvers.resolveWithMeta(rawUrl);
        if (zokoMeta.resolved && zokoMeta.url && await respondWithValidated(zokoMeta, "zokoanime")) return;
      }
      // Si la URL es una página web de episodio (animeflv, jkanime, etc.), extraer streams reales primero
      if (classifySourceKind(rawUrl) === "page" || isCanonicalLocator(rawUrl)) {
        // Signed Vimeos/SprintCDN URLs can rotate between page fetches. If the
        // first page response only contains expired tokens, fetch the canonical
        // page again before declaring the provider unavailable. This keeps the
        // fallback chain from being triggered by a transient token miss.
        for (let pageAttempt = 0; pageAttempt < 3; pageAttempt += 1) {
          try {
            const extracted = await extractStreamFromUrl(rawUrl);
            const candidates = Array.from(
              new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
            );
            for (const cand of candidates) {
              const resolvedMeta = await resolutionCoordinator.resolve(cand);
              if (resolvedMeta.resolved && resolvedMeta.type === "direct") {
                // The page is the renewable locator the player owns. Keep the
                // lease under that page instead of authorizing the transient
                // Vimeos/SprintCDN URL returned by the extractor. Without this
                // alias, the player sends the resolution_id with the page and
                // the session endpoint must resolve the page a second time;
                // a rotating token can then produce a false 422/fallback even
                // though the first probe was valid.
                const pageBoundMeta = resolutionCoordinator.rememberResolved({
                  ...resolvedMeta,
                  original_url: rawUrl,
                  canonical_locator: rawUrl,
                  is_refreshable: true,
                }, rawUrl);
                if (await respondWithValidated(pageBoundMeta, "regex_fast")) return;
              }
            }
          } catch {}
          if (pageAttempt < 2) await new Promise((resolve) => setTimeout(resolve, 220));
        }
      }

      // Capa ligera: fetch HTTP + extractores específicos, sin navegador headless.
      const meta = await resolutionCoordinator.resolve(rawUrl);
      if (meta.resolved && await respondWithValidated(meta, "regex_fast")) return;

      // Fallback barato: el navegador abre el embed o avanza al siguiente host.
      return res.json(proxyResolvedSubtitles(
        buildResolveDeliveryResponse(
          // Do not leak the last unvalidated native URL as a false success. A
          // stale signed token must be represented as an unresolved locator so
          // the player can advance to the next provider candidate.
          {
            ...meta,
            url: rawUrl,
            resolved: false,
            type: "embed",
            is_proxyable: false,
            failure_reason: "unresolved",
          },
          "unresolved_embed",
          deliveryPlanner,
        ),
        meta.provider,
      ));
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Error al resolver embed" });
    } finally {
      resolutionLease.release();
    }
  });

  // GET /api/v1/media/:media_id/stream
  app.get("/api/v1/media/:media_id/stream", async (req: Request, res: Response) => {
    const mediaId = req.params.media_id;
    try {
      const show = await getShowByIdFromDb(mediaId);
      if (!show || !show.episodes.length) {
        return res.status(404).json({ detail: "Contenido no encontrado." });
      }

      const firstEp = show.episodes[0];
      const extracted = await extractStreamFromUrl(firstEp.source_url).catch(() => ({ stream_url: firstEp.source_url }));
      const primaryUrl = extracted.stream_url || firstEp.source_url;

      res.json({
        master_m3u8: primaryUrl,
        fallback_mp4: primaryUrl.endsWith(".mp4") ? primaryUrl : null,
        qualities: [
          { label: "1080p Full HD", resolution: "1080p", bitrate: "Auto", url: primaryUrl },
          { label: "720p HD", resolution: "720p", bitrate: "Auto", url: primaryUrl },
        ],
        subtitles: [
          { id: "sub-es", label: "EspaÃ±ol", language: "es", src: "", is_default: true },
          { id: "sub-en", label: "English", language: "en", src: "", is_default: false },
        ],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET|HEAD /api/v1/stream/mega - Streaming nativo de archivos pÃºblicos de MEGA
  // (descifrado AES-128-CTR on-the-fly vÃ­a megajs, con soporte Range/206 para Plyr).
  // La URL del archivo viaja como query param (?url=...), no como segmento de path.
  app.get("/api/v1/stream/mega", handleMegaStream);
  app.head("/api/v1/stream/mega", handleMegaStream);

  // GET /api/v1/proxy/stream - Anti-CORS Proxy
  app.get("/api/v1/proxy/stream", async (req: Request, res: Response) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.net/";
    
    // ExtracciÃ³n de tÃ­tulo y proveedor: Primero intentar headers personalizados (HLS.js), luego query params.
    const headerTitle = req.headers['x-media-title'] ? decodeURIComponent(req.headers['x-media-title'] as string) : "";
    const headerProvider = req.headers['x-media-provider'] ? decodeURIComponent(req.headers['x-media-provider'] as string) : "";
    
    const mediaTitle = headerTitle || (typeof req.query.title === "string" ? req.query.title : "");
    const explicitProvider = headerProvider || (typeof req.query.provider === "string" ? req.query.provider : "");
    
    const _proxyStartMs = Date.now();

    if (!targetUrl) {
      return res.status(400).json({ detail: "URL requerida" });
    }

    try {
      const parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return res.status(400).json({ detail: "Protocolo no permitido" });
      }

      let hostnameToResolve = parsedUrl.hostname;
      if (hostnameToResolve.startsWith("[") && hostnameToResolve.endsWith("]")) {
        hostnameToResolve = hostnameToResolve.slice(1, -1);
      }

      let resolvedIp = hostnameToResolve;
      try {
        const lookup = await dns.lookup(hostnameToResolve);
        resolvedIp = lookup.address;
      } catch {
        return res.status(400).json({ detail: "Host no resoluble" });
      }

      let isPrivate = false;
      if (
        resolvedIp === "localhost" ||
        resolvedIp === "::1" ||
        resolvedIp === "::" ||
        resolvedIp.startsWith("::ffff:") ||
        resolvedIp.startsWith("fc00:") ||
        resolvedIp.startsWith("fd") ||
        resolvedIp.startsWith("fe80:") ||
        resolvedIp.startsWith("127.") ||
        resolvedIp.startsWith("10.") ||
        resolvedIp.startsWith("192.168.") ||
        resolvedIp.startsWith("169.254.") ||
        resolvedIp.startsWith("0.")
      ) {
        isPrivate = true;
      } else if (resolvedIp.startsWith("172.")) {
        const p = parseInt(resolvedIp.split(".")[1], 10);
        if (p >= 16 && p <= 31) {
          isPrivate = true;
        }
      }

      if (isPrivate) {
        return res.status(400).json({ detail: "Host no permitido" });
      }

      // We use the original targetUrl to maintain TLS/SNI integrity.
      // Los perfiles por host (Goodstream, MP4Upload, ...) viven en server/hostProfiles.ts:
      // cada CDN/WAF exige un set distinto de UA/Referer/Sec-Fetch y cliente HTTP.
      const { headers: reqHeaders, profile: activeProfile } = buildProxyHeaders(
        targetUrl,
        typeof referer === "string" ? referer : undefined,
        typeof req.headers.range === "string" ? req.headers.range : undefined
      );
      // Timeout de conexiÃ³n (TCP+TLS) opcional del perfil (p.ej. MP4Upload ~35s de
      // handshake). En undici el timer de headersTimeout arranca antes de completar
      // el connect, asÃ­ que debe elevarse junto al connectTimeout o corta igual.
      const profileConnect = activeProfile.connectTimeoutMs;
      const profileConnectOpts =
        profileConnect !== undefined
          ? {
              connectTimeout: profileConnect,
              headersTimeout: profileConnect + 5000,
            }
          : {};

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      const lowerTargetUrl = targetUrl.toLowerCase();
      const isHlsResource =
        lowerTargetUrl.includes('.m3u8') ||
        lowerTargetUrl.includes('.mpd') ||
        lowerTargetUrl.includes('.ts') ||
        lowerTargetUrl.includes('.m4s') ||
        lowerTargetUrl.includes('/segs/') ||
        lowerTargetUrl.includes('/seg-') ||
        lowerTargetUrl.includes('xoticsky.top') ||
        lowerTargetUrl.includes('/m3u8/');  // Zilla Networks: /m3u8/{hash} format

      if (isHlsResource) {
        let upstreamStatus: number;
        let responseHeaders: any;
        let rawBody: any;
        let lastHlsError: any;
        for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
          try {
            const upstream = await request(targetUrl, {
              method: 'GET',
              headers: reqHeaders,
              headersTimeout: 15000,
              bodyTimeout: 30000,
              ...profileConnectOpts,
            });
            upstreamStatus = upstream.statusCode;
            responseHeaders = upstream.headers;
            const chunks: Buffer[] = [];
            for await (const ch of upstream.body) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
            rawBody = Buffer.concat(chunks);
            lastHlsError = null;
            break;
          } catch (hlsErr: any) {
            lastHlsError = hlsErr;
            if (attempt < MAX_NETWORK_RETRIES) {
              await new Promise((r) => setTimeout(r, 150 * attempt));
            }
          }
        }
        if (lastHlsError) throw lastHlsError;

        // Normalize SimpleHeaders â†’ string. They can be string | string[] | undefined.
        const getHeader = (name: string): string => {
          const v = responseHeaders[name];
          return v === undefined ? '' : Array.isArray(v) ? v[0] : String(v);
        };

        const contentType = getHeader('content-type').toLowerCase();
        const bodyBuffer = Buffer.isBuffer(rawBody)
          ? rawBody
          : rawBody instanceof ArrayBuffer
            ? Buffer.from(rawBody)
            : ArrayBuffer.isView(rawBody)
              ? Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
              : Buffer.from(rawBody ?? '');
        const isManifest =
          lowerTargetUrl.includes('.m3u8') ||
          lowerTargetUrl.includes('.mpd') ||
          contentType.includes('mpegurl') ||
          contentType.includes('dash+xml');

        // â”€â”€ UPSTREAM ERROR PROPAGATION â”€â”€
        if (upstreamStatus < 200 || upstreamStatus >= 400) {
          console.warn(`[proxy/stream] upstream ${upstreamStatus} for ${maskSignedTokens(targetUrl).slice(0, 120)}`);
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, error: `HTTP ${upstreamStatus}`, referer, client: "undici" });
          res.status(upstreamStatus);
          if (getHeader('content-type')) res.setHeader('Content-Type', getHeader('content-type'));
          if (bodyBuffer.length > 0) res.setHeader('Content-Length', bodyBuffer.length);
          return res.end(bodyBuffer);
        }

        res.status(upstreamStatus);
        res.setHeader(
          'Content-Type',
          contentType || (isManifest
            ? (lowerTargetUrl.includes('.mpd') ? 'application/dash+xml' : 'application/vnd.apple.mpegurl')
            : 'application/octet-stream')
        );

        if (!isManifest) {
          const cr = getHeader('content-range');
          const ar = getHeader('accept-ranges');
          if (cr) res.setHeader('Content-Range', cr);
          if (ar) res.setHeader('Accept-Ranges', ar);
          const looksBinary = bodyBuffer.length > 8 &&
            (bodyBuffer.subarray(4, 8).toString('latin1') === 'ftyp' ||
             (bodyBuffer[0] === 0x47 && bodyBuffer[188] === 0x47));
          if (contentType.includes('text/html') && looksBinary) {
            res.setHeader('Content-Type', 'video/mp4');
          }
          res.setHeader('Content-Length', bodyBuffer.length);
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: "undici" });
          return res.end(bodyBuffer);
        }

        // â”€â”€ MANIFEST REWRITE (HLS y DASH) â”€â”€
        const text = bodyBuffer.toString('utf8');
        const baseUrl = new URL(targetUrl);
        const proxyUri = (uri: string, preserveDashTemplate = false) => {
          const absoluteUri = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).toString();
          const titleParam = mediaTitle ? `&title=${encodeURIComponent(mediaTitle)}` : '';
          const provParam = explicitProvider ? `&provider=${encodeURIComponent(explicitProvider)}` : '';
          const encodedTarget = encodeURIComponent(absoluteUri).replace(
            preserveDashTemplate ? /%24/g : /^$/g,
            preserveDashTemplate ? '$' : '%24',
          );
          return `/api/v1/proxy/stream?referer=${encodeURIComponent(referer)}&url=${encodedTarget}${titleParam}${provParam}`;
        };
        const rewritten = lowerTargetUrl.includes('.mpd') || contentType.includes('dash+xml')
          ? (() => {
              // Most MPDs expose a single BaseURL. Resolve segment attributes
              // against it while keeping the BaseURL itself upstream; every
              // concrete segment then travels through the internal proxy.
              const match = text.match(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL>/i);
              const dashBase = match?.[1]?.trim()
                ? new URL(match[1].trim(), baseUrl).toString()
                : baseUrl.toString();
              return text.replace(/\b(media|initialization|sourceURL)=("|')([^"']+)("|')/gi, (_match, attr, quote, uri) => {
                const absolute = /^https?:\/\//i.test(uri) ? uri : new URL(uri, dashBase).toString();
                return `${attr}=${quote}${proxyUri(absolute, true)}${quote}`;
              });
            })()
          : text.split(/\r?\n/).map((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) return proxyUri(trimmed);
            return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUri(uri)}"`);
          }).join('\n');

        const rewrittenBuffer = Buffer.from(rewritten, 'utf8');
        res.setHeader('Content-Length', rewrittenBuffer.length);
        logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: "undici" });
        return res.end(rewrittenBuffer);
      } else {
        // MP4/manual range proxy. Each internal chunk must contain exactly the requested
        // range; accepting a 200 here would append the whole file repeatedly and corrupt it.
        const clientRangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';

        // undici `request() NO sigue redirects: hosts como archive.org/download/*
        // responden 302 hacia su datanode (dn*.us.archive.org). Antes se copiaba el
        // status 302 sin la cabecera Location â†’ el <video> recibÃ­a un redirect vacÃ­o
        // y morÃ­a con MEDIA_ELEMENT_ERROR. Ahora seguimos la cadena manualmente
        // (mÃ¡x MAX_PROXY_REDIRECTS saltos) hasta llegar a una respuesta no-3xx.
        const followWithRedirects = async (
          method: 'GET' | 'HEAD',
          extraHeaders?: Record<string, string>
        ) => {
          let currentUrl = targetUrl;
          for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop++) {
            const response = await request(currentUrl, {
              method,
              redirect: 'manual',
              headers: hop === 0 && extraHeaders ? { ...reqHeaders, ...extraHeaders } : reqHeaders,
              ...profileConnectOpts,
            });
            const status = response.statusCode;
            if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308)) {
              const locationValue = response.headers['location'];
              const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
              // Consumir/destruir el body para liberar el socket antes de reintentar.
              response.body.on('error', () => {});
              response.body.destroy();
              if (!location) throw new Error(`El origen emitiÃ³ ${status} sin cabecera Location`);
              const nextUrlObj = new URL(location, currentUrl);
              if (nextUrlObj.protocol !== 'http:' && nextUrlObj.protocol !== 'https:') {
                throw new Error(`RedirecciÃ³n a protocolo no permitido: ${nextUrlObj.toString()}`);
              }
              currentUrl = nextUrlObj.toString();
              continue;
            }
            return { response, finalUrl: currentUrl };
          }
          throw new Error(`Demasiadas redirecciones (> ${MAX_PROXY_REDIRECTS}) desde ${maskSignedTokens(targetUrl).slice(0, 120)}`);
        };

        // El HEAD de metadatos puede acabar en otra URL final (datanode); ese es el
        // host contra el que luego sirven los chunks por rango.
        const { response: metadataResponse, finalUrl } = await followWithRedirects('HEAD');
        const contentLengthHeader = metadataResponse.headers['content-length'];

        if (!contentLengthHeader) {
          // Sin Content-Length no hay base para calcular rangos: passthrough puro.
          const upstream = await request(finalUrl, {
            method: 'GET',
            headers: clientRangeHeader ? { ...reqHeaders, Range: clientRangeHeader } : reqHeaders,
            bodyTimeout: 0,
            ...profileConnectOpts,
          });
          res.status(upstream.statusCode);
          for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges'] as const) {
            const value = upstream.headers[header];
            if (value !== undefined) res.setHeader(header, String(value));
          }
          await pipeline(upstream.body, res);
          logProxyRequest({ targetUrl, upstreamStatus: upstream.statusCode, durationMs: Date.now() - _proxyStartMs, bytesReceived: Number(upstream.headers['content-length'] || 0), mediaTitle, provider: explicitProvider, referer, client: "undici" });
          return;
        }

        const totalFileSize = Number(contentLengthHeader);
        if (!Number.isSafeInteger(totalFileSize) || totalFileSize <= 0) {
          logProxyRequest({
            targetUrl,
            upstreamStatus: 502,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: "Content-Length invÃ¡lido del origen",
            referer,
            client: "undici",
          });
          return res.status(502).json({ error: 'El origen devolviÃ³ un Content-Length invÃ¡lido' });
        }

        // Cache anti-416 (MP4Upload): el token del host rota entre requests y con Ã©l
        // cambia el content-length del archivo. Si el tamaÃ±o cacheado difiere del que
        // anuncia este HEAD, el rango pedido por el player apunta a un archivo viejo â†’
        // responder 416 limpia con el tamaÃ±o REAL actual en vez de dejar pasar un
        // stream que el upstream cortarÃ¡ a mitad.
        const cachedEntry = getMp4SizeCacheEntry(targetUrl);
        if (cachedEntry && cachedEntry.size !== totalFileSize) {
          console.warn(
            `[proxy/stream] size mismatch para ${maskSignedTokens(targetUrl).slice(0, 120)}: cache=${cachedEntry.size} upstream=${totalFileSize} â†’ 416`
          );
          logProxyRequest({
            targetUrl,
            upstreamStatus: 416,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: `Size mismatch: cache=${cachedEntry.size} vs upstream=${totalFileSize} (Token MP4 rotado)`,
            referer,
            client: "undici",
          });
          res.setHeader('Content-Range', `bytes */${totalFileSize}`);
          res.setHeader('Accept-Ranges', 'bytes');
          return res.status(416).end();
        }
        setMp4SizeCacheEntry(targetUrl, { size: totalFileSize, finalUrl });

        let startOffset = 0;
        let finalEndOffset = totalFileSize - 1;
        if (clientRangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/i.exec(clientRangeHeader.trim());
          if (!match || (!match[1] && !match[2])) {
            logProxyRequest({
              targetUrl,
              upstreamStatus: 416,
              durationMs: Date.now() - _proxyStartMs,
              bytesReceived: 0,
              mediaTitle,
              provider: explicitProvider,
              error: "Header Range invÃ¡lido",
              referer,
              client: "undici",
            });
            res.setHeader('Content-Range', `bytes */${totalFileSize}`);
            return res.status(416).end();
          }
          if (!match[1]) {
            const suffixLength = Number(match[2]);
            startOffset = Math.max(0, totalFileSize - suffixLength);
          } else {
            startOffset = Number(match[1]);
            if (match[2]) finalEndOffset = Math.min(Number(match[2]), totalFileSize - 1);
          }
        }

        if (startOffset >= totalFileSize || finalEndOffset < startOffset) {
          logProxyRequest({
            targetUrl,
            upstreamStatus: 416,
            durationMs: Date.now() - _proxyStartMs,
            bytesReceived: 0,
            mediaTitle,
            provider: explicitProvider,
            error: `Range fuera de rango (${startOffset}-${finalEndOffset} de ${totalFileSize})`,
            referer,
            client: "undici",
          });
          res.setHeader('Content-Range', `bytes */${totalFileSize}`);
          return res.status(416).end();
        }

        const computedContentLength = finalEndOffset - startOffset + 1;
        res.status(clientRangeHeader ? 206 : 200);
        if (clientRangeHeader) res.setHeader('Content-Range', `bytes ${startOffset}-${finalEndOffset}/${totalFileSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', computedContentLength);
        res.setHeader('Content-Type', String(metadataResponse.headers['content-type'] || 'video/mp4'));

        let cursor = startOffset;
        while (cursor <= finalEndOffset && !res.destroyed) {
          const chunkBoundary = Math.min(cursor + CHUNK_SIZE_BYTES - 1, finalEndOffset);
          let lastError: Error | null = null;

          for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
            try {
              const upstream = await request(finalUrl, {
                method: 'GET',
                headers: { ...reqHeaders, Range: `bytes=${cursor}-${chunkBoundary}` },
                headersTimeout: 15000,
                bodyTimeout: 30000,
                ...profileConnectOpts,
              });
              if (upstream.statusCode !== 206) {
                upstream.body.on('error', () => {});
                upstream.body.destroy();
                throw new Error(`El origen ignorÃ³ Range (status ${upstream.statusCode})`);
              }

              upstream.body.on('error', () => {});
              let received = 0;
              for await (const piece of upstream.body) {
                const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
                received += buffer.length;
                if (!res.write(buffer)) await new Promise<void>((resolve) => res.once('drain', resolve));
              }
              const expected = chunkBoundary - cursor + 1;
              if (received !== expected) throw new Error(`Chunk incompleto: ${received}/${expected} bytes`);
              lastError = null;
              break;
            } catch (error: any) {
              lastError = error;
              if (attempt < MAX_NETWORK_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
              }
            }
          }

          if (lastError) throw lastError;
          cursor = chunkBoundary + 1;
        }
        logProxyRequest({ targetUrl, upstreamStatus: 206, durationMs: Date.now() - _proxyStartMs, bytesReceived: computedContentLength, mediaTitle, provider: explicitProvider, referer, client: "undici" });
        if (!res.destroyed) res.end();
      }
    } catch (e: any) {
      console.error(`[proxy/stream] Error para ${targetUrl ? maskSignedTokens(targetUrl).slice(0, 100) : 'unknown'}:`, e.message);
      logProxyRequest({ targetUrl: targetUrl || "unknown", upstreamStatus: 0, durationMs: Date.now() - _proxyStartMs, bytesReceived: 0, mediaTitle, provider: explicitProvider, error: e.message, referer, client: "undici" });
      if (!res.headersSent) {
        res.status(500).json({ error: `Error en proxy: ${e.message}` });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // GET /api/v1/proxy/image - Lightweight image proxy (no DNS lookup, no stealth client)
  // Used by SmartImage for CORS-failing images from CDNs (anilist, tmdb, etc.)
  app.get("/api/v1/proxy/image", async (req: Request, res: Response) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    if (!targetUrl) return res.status(400).json({ error: "url required" });

    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "invalid protocol" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const abort = () => controller.abort();
      req.once("aborted", abort);
      res.once("close", () => { if (!res.writableEnded) controller.abort(); });

      try {
        const upstream = await fetch(targetUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          },
        });

        if (!upstream.ok) {
          return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
        }

        const contentType = upstream.headers.get("content-type") || "image/jpeg";
        const contentLength = upstream.headers.get("content-length");
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        if (contentLength) res.setHeader("Content-Length", contentLength);
        if (!upstream.body) return res.end();
        await pipeline(Readable.fromWeb(upstream.body as never), res);
      } finally {
        clearTimeout(timeout);
        req.removeListener("aborted", abort);
      }
    } catch (e: any) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
    }
  });

  // Scraper Presets Endpoints (Persistencia Global en Servidor)
  app.get("/api/v1/scraper/presets", (req: Request, res: Response) => {
    res.json(getActivePresets());
  });

  app.post(["/api/v1/scraper/presets/:id", "/api/v1/scraper/presets/:id/update"], (req: Request, res: Response) => {
    const presetId = req.params.id;
    const exampleUrl = typeof req.body?.example_url === "string" ? req.body.example_url.trim() : "";
    if (!exampleUrl) {
      return res.status(400).json({ detail: "El campo 'example_url' es requerido." });
    }
    saveCustomPresetOverride(presetId, exampleUrl);
    res.json({
      status: "ok",
      message: "Enlace del preset guardado exitosamente en el servidor para todos los usuarios.",
      presets: getActivePresets(),
    });
  });

  app.post("/api/v1/scraper/presets/:id/reset", (req: Request, res: Response) => {
    const presetId = req.params.id;
    resetCustomPresetOverride(presetId);
    res.json({
      status: "ok",
      message: "Enlace del preset restablecido a su valor por defecto.",
      presets: getActivePresets(),
    });
  });

  // POST /api/v1/catalog/analyze - Universal Scraper & Metadata Enricher
  app.post("/api/v1/catalog/analyze", async (req: Request, res: Response) => {
    const url = req.body?.url;
    if (!url) {
      return res.status(400).json({ detail: "La URL o tÃ©rmino de bÃºsqueda es requerido." });
    }

    try {
      const analysis = await analyzeUniversalUrl(url);
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ detail: `Error analizando: ${e.message}` });
    }
  });

  // POST /api/v1/catalog/episode-servers - ResoluciÃ³n Just-In-Time de los servidores
  // reales de video de una PÃGINA de episodio (ej. animeflv /ver/{slug}-{n}, que solo
  // expone embeds vÃ­a JS o espejo jkanime). Devuelve streams reproducibles sin tocar DB.
  app.post("/api/v1/catalog/episode-servers", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      return res.status(400).json({ detail: "URL del episodio requerida." });
    }

    try {
      const extracted = await extractStreamFromUrl(url);
      const all = Array.from(
        new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
      );

      // El adaptador devuelve la propia pÃ¡gina como pseudo-stream cuando no encuentra nada:
      // eso NO cuenta como resoluciÃ³n (el player nativo morirÃ­a con MEDIA_ERR_SRC_NOT_SUPPORTED).
      const isSourcePage = (u: string) => {
        try {
          const pathname = new URL(u).pathname.toLowerCase();
          return (
            /\/(ver|watch|episode|ep|capitulo)\//.test(pathname) &&
            !/\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/i.test(u)
          );
        } catch {
          return false;
        }
      };

      // Una fuente directa con extensiÃ³n de media es resoluble aunque coincida con la URL
      // pedida (caso archive.org/details â†’ .mp4 directo): el player nativo sÃ­ la reproduce.

      const realStreams = all.filter((u) => (u !== url || isDirectMedia(u)) && !isSourcePage(u));

      // Filtro de hosts muertos o imposibles de embeber/reproducir (Cloudflare/bot-check)
      const isDeadHost = (u: string) => {
        const lower = u.toLowerCase();
        return (
          lower.includes("voe.sx") ||
          lower.includes("voe-unblock") ||
          lower.includes("mixdrop.") ||
          lower.includes("mxdrop.") ||
          lower.includes("filemoon.")
        );
      };
      const usableStreams = realStreams.filter((u) => !isDeadHost(u));
      const candidatesToRank = usableStreams.length > 0 ? usableStreams : realStreams;

      // HiAnimes/Zoko/Megaplay entrega un manifiesto temporal que exige el Referer del
      // CDN. Recuperar su metadata aquí evita que el JIT lo adjunte sin
      // cabeceras y termine en un 403 aunque la URL sea correcta.
      let hianimesMeta: Awaited<ReturnType<typeof EmbedResolvers.resolveWithMeta>> | null = null;
      if (/hianimes\.se\/watch\/|megaplay\.buzz\/stream\/|zokoanime\.video\/stream\//i.test(url)) {
        try {
          const meta = await EmbedResolvers.resolveWithMeta(url);
          if (meta.resolved && meta.url) hianimesMeta = meta;
        } catch {}
      }

      const rankedBase = rankStreams(candidatesToRank, getServerPriorities(siteFromDomain(hostOfStreamUrl(url))));

      // LatAnime's adapter already validates direct HLS candidates against the
      // manifest and first segment. Do not spend another 3s per fallback embed
      // enriching pages that are not needed to start playback: the player can
      // resolve those locators JIT if the first direct stream later fails.
      // Hosts whose direct URL needs extra metadata (Vimeos/Zoko headers) stay
      // on the full path below so their delivery contract is preserved.
      const fastDirect = extracted.stream_url && isDirectMedia(extracted.stream_url)
        && !isSourcePage(extracted.stream_url)
        && !/vimeos\.[a-z]+|p\d+\.vimeos\.zip|zokoanime\.video\/stream\//i.test(extracted.stream_url)
        ? extracted.stream_url
        : "";
      if (fastDirect) {
        const sourceSite = siteFromDomain(hostOfStreamUrl(url)) || undefined;
        const fastRankedStreams = rankedBase
          .map((stream) => ({
            ...stream,
            provider: sourceSite,
            source_site: sourceSite,
            original_url: url,
            canonical_locator: url,
            ...(stream.type === "direct" || stream.url === fastDirect
              ? {
                  type: "direct" as const,
                  delivery_mode: "direct_trial" as const,
                  is_proxyable: true,
                  is_refreshable: true,
                }
              : {
                  type: "embed" as const,
                  delivery_mode: "embed" as const,
                  is_proxyable: false,
                  is_refreshable: true,
                }),
          }))
          .sort((a, b) => {
            const aDirect = a.type === "direct" || isDirectMedia(a.url);
            const bDirect = b.type === "direct" || isDirectMedia(b.url);
            if (aDirect && !bDirect) return -1;
            if (!aDirect && bDirect) return 1;
            return a.tier - b.tier;
          });
        const safeFastRanked = fastRankedStreams.map((stream) => {
          const provider = stream.source_site || sourceSite || stream.provider;
          return Array.isArray(stream.subtitles)
            ? { ...stream, subtitles: proxyResolvedSubtitles({ subtitles: stream.subtitles }, provider).subtitles || [] }
            : stream;
        });
        return res.json({
          url,
          stream_url: fastDirect,
          all_available_streams: all,
          title: extracted.title,
          resolved: true,
          ranked_streams: safeFastRanked,
        });
      }

      // Intentar desofuscar de inmediato los mejores embeds a stream nativo directo (.m3u8/.mp4)
      const upgradedMap = new Map<string, {
        url: string;
        requiredHeaders?: Record<string, string>;
        subtitles?: any[];
        subtitle_mode?: "external" | "burned_in" | "unknown";
        resolution_id?: string;
        generation?: string;
        delivery_mode?: ResolvedStreamMeta["delivery_mode"];
        is_proxyable?: boolean;
        is_refreshable?: boolean;
        refresh_after?: number;
        expires_at?: number;
        resolved_at?: number;
      }>();
      // LatAnime, TioAnime, Gnula y Cinecalidad pueden publicar varios
      // servidores. Antes se resolvían en serie (hasta 5 × 3 s), por lo que
      // un embed caído retrasaba todos los demás y hacía saltar el fallback
      // antes de que existiera una fuente usable. Resolverlos en paralelo
      // conserva el ranking para elegir el mejor, pero limita la espera al
      // candidato más lento. Zoko mantiene su contrato especial: solo relee
      // la metadata del locator estable para no perder Referer/subtítulos.
      const upgradeCandidates = rankedBase.slice(0, 5);
      await Promise.all(upgradeCandidates.map(async (cand) => {
        const needsDirectHostMetadata = /vimeos\.[a-z]+|p\d+\.vimeos\.zip/i.test(cand.url) ||
          /zokoanime\.video\/stream\//i.test(url);
        if (isDirectMedia(cand.url) && !needsDirectHostMetadata) return;

        try {
          // Zoko's subtitles live on the stable `/stream/...` locator, not
          // on the extracted CDN URL. Other hosts can be inspected from
          // the candidate itself.
          const metadataLocator = /zokoanime\.video\/stream\//i.test(url) ? url : cand.url;
          const subMeta = await Promise.race([
            EmbedResolvers.resolveWithMeta(metadataLocator),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout (3s)")), 3000)),
          ]);
          if (subMeta.resolved && subMeta.url && (subMeta.type === "direct" || isDirectMedia(subMeta.url))) {
            let directUrl = subMeta.url;
            // CDNs con validación de IP de origen o bloqueo de CORS en navegador (ej. okcdn.ru):
            // deben servirse a través del proxy para reescribir segmentos y evitar CORS/400.
            if (directUrl.includes("okcdn.ru") || cand.url.includes("ok.ru")) {
              directUrl = `/api/v1/proxy/stream?referer=https%3A%2F%2Fok.ru%2F&url=${encodeURIComponent(subMeta.url)}`;
            }
            const remembered = resolutionCoordinator.rememberResolved({
              ...subMeta,
              url: subMeta.url,
              original_url: url,
              canonical_locator: url,
              is_proxyable: true,
              is_refreshable: true,
            }, url);
            upgradedMap.set(cand.url, {
              url: directUrl,
              requiredHeaders: remembered.requiredHeaders,
              subtitles: remembered.subtitles,
              subtitle_mode: remembered.subtitle_mode,
              resolution_id: remembered.resolution_id,
              generation: remembered.generation,
              delivery_mode: deliveryPlanner.classify(remembered),
              is_proxyable: remembered.is_proxyable,
              is_refreshable: remembered.is_refreshable,
              refresh_after: remembered.refresh_after,
              expires_at: remembered.expires_at,
              resolved_at: remembered.resolved_at,
            });
          }
        } catch {}
      }));

      const rankedStreams = rankedBase.map((r) => {
        const upgraded = upgradedMap.get(r.url);
        return {
          ...r,
          ...(upgraded
            ? {
                url: upgraded.url,
                type: "direct" as const,
                original_url: url,
                canonical_locator: url,
                tier: 1,
                requiredHeaders: upgraded.requiredHeaders,
                subtitles: upgraded.subtitles,
                subtitle_mode: upgraded.subtitle_mode,
                resolution_id: upgraded.resolution_id,
                generation: upgraded.generation,
                delivery_mode: upgraded.delivery_mode,
                is_proxyable: upgraded.is_proxyable,
                is_refreshable: upgraded.is_refreshable,
                refresh_after: upgraded.refresh_after,
                expires_at: upgraded.expires_at,
                resolved_at: upgraded.resolved_at,
              }
            : {}),
          // Plataforma de origen (sitio cuya página se pidió) para el selector premium.
          source_site: siteFromDomain(hostOfStreamUrl(url)) || undefined,
          ...(hianimesMeta && hianimesMeta.url === r.url && hianimesMeta.requiredHeaders
            ? { requiredHeaders: hianimesMeta.requiredHeaders }
            : {}),
          ...(hianimesMeta && hianimesMeta.url === r.url && hianimesMeta.subtitles
            ? { subtitles: hianimesMeta.subtitles }
            : {}),
          ...(hianimesMeta && hianimesMeta.url === r.url && hianimesMeta.subtitle_mode
            ? { subtitle_mode: hianimesMeta.subtitle_mode }
            : {}),
        };
      });

      // Ordenar: streams directos primero, luego por tier
      rankedStreams.sort((a, b) => {
        const aDirect = a.type === "direct" || isDirectMedia(a.url);
        const bDirect = b.type === "direct" || isDirectMedia(b.url);
        if (aDirect && !bDirect) return -1;
        if (!aDirect && bDirect) return 1;
        return a.tier - b.tier;
      });

      const safeRankedStreams = rankedStreams.map((stream) => {
        const provider = stream.source_site || siteFromDomain(hostOfStreamUrl(url)) || stream.provider;
        if (!Array.isArray(stream.subtitles)) return stream;
        return {
          ...stream,
          subtitles: proxyResolvedSubtitles({ subtitles: stream.subtitles }, provider).subtitles || [],
        };
      });

      const primaryCandidate = rankedStreams.find((r) => r.type === "direct" || isDirectMedia(r.url)) || rankedStreams[0];
      const finalStreamUrl = primaryCandidate?.url || extracted.stream_url;
      // A list of unresolved embeds is still useful as diagnostics/failover
      // candidates, but it is not a playable resolution. Reporting it as
      // resolved made the player enter a false-success state and retry the
      // same dead page before moving on.
      const isResolved = rankedStreams.some((stream) =>
        (stream.type === "direct" || isDirectMedia(stream.url)) && !isSourcePage(stream.url)
      );

      res.json({
        url,
        stream_url: finalStreamUrl,
        all_available_streams: all,
        title: extracted.title,
        resolved: isResolved,
        requiredHeaders: primaryCandidate?.requiredHeaders || hianimesMeta?.requiredHeaders,
        ranked_streams: safeRankedStreams,
      });
    } catch (e: any) {
      res.status(500).json({ detail: `Error resolviendo servidores del episodio: ${e.message}` });
    }
  });

  // GET /api/v1/play-multi/:media_item_id - Cascada multi-fuente (F4): todos los
  // SourceLinks de la obra (temporada 1 por defecto), agrupados por sitio, sitios
  // ordenados por SiteRating DESC y dentro de cada sitio por tier ASC.
  app.get("/api/v1/play-multi/:media_item_id", async (req: Request, res: Response) => {
    const mediaItemId = req.params.media_item_id;
    const season = Number.parseInt(String(req.query.season ?? "1"), 10) || 1;

    try {
      const selectedItem = await prisma.mediaItem.findUnique({
        where: { id: mediaItemId },
        select: {
          id: true,
          kind: true,
          tmdb_id: true,
          title: true,
          normalized_title: true,
          base_normalized_title: true,
        },
      });
      if (!selectedItem) {
        return res.status(404).json({ detail: "Obra canónica no encontrada." });
      }

      // TMDB identity is authoritative. Title/base-title twins are only safe
      // for legacy rows without an ID; mixing them with an exact-ID row can
      // attach a different imported episode (for example an old localized
      // alias) to the selected work.
      let equivalentItems = selectedItem.tmdb_id != null
        ? await prisma.mediaItem.findMany({
            where: { kind: selectedItem.kind, tmdb_id: selectedItem.tmdb_id },
            select: { id: true },
          })
        : [];
      if (equivalentItems.length === 0) {
        const title = selectedItem.title || selectedItem.normalized_title;
        const normalized = selectedItem.normalized_title || normalizeTitle(title);
        equivalentItems = normalized
          ? await prisma.mediaItem.findMany({
              where: { kind: selectedItem.kind, tmdb_id: null, normalized_title: normalized },
              select: { id: true },
            })
          : [];
      }
      const mediaItemIds = Array.from(new Set([mediaItemId, ...equivalentItems.map((item) => item.id)]));
      const links = await prisma.sourceLink.findMany({
        where: { media_episode: { media_item_id: { in: mediaItemIds }, season_number: season } },
        select: {
          url: true,
          source_site: true,
          link_type: true,
          canonical_locator: true,
          priority_tier: true,
          failure_reason: true,
          source_status: true,
          language: true,
          audio_language: true,
          subtitle_language: true,
          subtitles: true,
          host: true,
        },
      });
      if (links.length === 0) {
        return res.status(404).json({ detail: "Sin fuentes registradas para esta obra/temporada." });
      }

      const cascade = await buildMultiSourceCascade(links);
      res.json({
        media_item_id: mediaItemId,
        media_item_ids: mediaItemIds,
        season,
        stream_url: cascade[0]?.url ?? null,
        cascade,
      });
    } catch (e: any) {
      res.status(500).json({ detail: `Error construyendo cascada multi-fuente: ${e.message}` });
    }
  });

  // â”€â”€â”€ SiteRating admin API (pestaÃ±a Fuentes del AdminPanel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get("/api/v1/sites/ratings", async (_req: Request, res: Response) => {
    try {
      res.json({ ratings: await getAllSiteRatings() });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  app.post("/api/v1/sites/ratings", async (req: Request, res: Response) => {
    const site = typeof req.body?.site === "string" ? req.body.site.trim() : "";
    if (!site) return res.status(400).json({ detail: "site requerido" });
    try {
      const saved = await upsertSiteRating(
        site,
        typeof req.body?.rating === "number" ? req.body.rating : undefined,
        typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
        req.body?.notes === undefined ? undefined : String(req.body.notes)
      );
      res.json(saved);
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // POST /api/v1/sites/ratings/swap - Swap ratings between two sites atomically
  app.post("/api/v1/sites/ratings/swap", async (req: Request, res: Response) => {
    try {
      const { siteA, ratingA, siteB, ratingB } = req.body ?? {};
      if (!siteA || !siteB || typeof ratingA !== "number" || typeof ratingB !== "number") {
        return res.status(400).json({ detail: "siteA, siteB, ratingA, ratingB requeridos." });
      }
      await Promise.all([
        upsertSiteRating(String(siteA), ratingA),
        upsertSiteRating(String(siteB), ratingB),
      ]);
      const ratings = await getAllSiteRatings();
      res.json({ ok: true, ratings });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // POST /api/v1/catalog/import-show - Save media item into PostgreSQL with Deduplication
  app.post("/api/v1/catalog/import-show", async (req: Request, res: Response) => {
    const showData = req.body?.show_data;
    if (!showData || !showData.title) {
      return res.status(400).json({ detail: "show_data con title es requerido" });
    }

    try {
      const result = await saveShowWithDeduplication({
        ...showData,
        source_site: showData.source_site || showData.source_domain,
      });

      if (result.isDuplicate) {
        res.json({
          status: "ok",
          message: `'${result.show.title}' ya existÃ­a en PostgreSQL. Se fusionaron ${result.episodesAdded} episodio(s) nuevos sin duplicar la serie.`,
          show_id: result.show.id,
          show: result.show,
          is_duplicate: true,
        });
      } else {
        res.json({
          status: "ok",
          message: `'${result.show.title}' guardado exitosamente en PostgreSQL con ${result.episodesAdded} episodio(s)/fuentes.`,
          show_id: result.show.id,
          show: result.show,
          is_duplicate: false,
        });
      }
    } catch (e: any) {
      res.status(500).json({ detail: `Error al guardar en PostgreSQL: ${e.message}` });
    }
  });

  // POST /api/v1/catalog/batch-import - Multi-URL Batch Ingestion with Deduplication
  app.post("/api/v1/catalog/batch-import", async (req: Request, res: Response) => {
    const urls: string[] = req.body?.urls || [];
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ detail: "Se requiere un array de URLs o tÃ­tulos ('urls')" });
    }

    const results: any[] = [];
    for (const itemUrl of urls.slice(0, 15)) {
      try {
        const cleanUrl = itemUrl.trim();
        if (!cleanUrl) continue;

        const analysis = await analyzeUniversalUrl(cleanUrl);
        const result = await saveShowWithDeduplication({
          title: analysis.title,
          original_title: analysis.original_title,
          japanese_title: analysis.japanese_title,
          english_title: analysis.english_title,
          tmdb_id: analysis.tmdb_id,
          description: analysis.description,
          poster_url: analysis.poster_url,
          banner_url: analysis.banner_url,
          content_type: analysis.content_type,
          rating: analysis.rating,
          year: analysis.year,
          status: analysis.status,
          genres: analysis.genres,
          source_site: analysis.source_domain || siteFromDomain(hostOfStreamUrl(cleanUrl)),
          episodes: analysis.episodes,
          detected_streams: analysis.detected_streams,
        });

        results.push({
          url: cleanUrl,
          status: "success",
          title: result.show.title,
          show_id: result.show.id,
          is_duplicate: result.isDuplicate,
        });
      } catch (e: any) {
        results.push({ url: itemUrl, status: "failed", error: e.message });
      }
    }

    res.json({
      status: "ok",
      imported_count: results.filter((r) => r.status === "success").length,
      results,
    });
  });

  // POST /api/v1/catalog/crawl & /api/v1/discover - Deep Crawler Engine with Persistent Task Worker
  app.post(["/api/v1/catalog/crawl", "/api/v1/discover"], async (req: Request, res: Response) => {
    const targetUrl = req.body?.url || "https://animeflv.net";
    const maxPages = Number(req.body?.max_pages) || 1;
    const delayMs = Number(req.body?.delay_ms) || 1500;
    const scope = req.body?.scope || (maxPages >= 10 ? "full_catalog" : "catalog_pages");

    try {
      const job = await taskWorker.createJob({
        target_url: targetUrl,
        scope: scope,
        max_pages: maxPages,
        delay_ms: delayMs,
        name: typeof req.body?.name === "string" ? req.body.name : undefined,
        resolver_hint: typeof req.body?.resolver_hint === "string" ? req.body.resolver_hint : null,
        content_kind: typeof req.body?.content_kind === "string" ? req.body.content_kind : null,
        pagination_mode: req.body?.pagination_mode === "template" || req.body?.pagination_mode === "examples" ? req.body.pagination_mode : "auto",
        pagination_template: typeof req.body?.pagination_template === "string" ? req.body.pagination_template : null,
        pagination_examples: req.body?.pagination_examples || [],
      });

      res.json({
        task_id: job.id,
        job: job,
        status: "pending",
        message: `Tarea creada y persistida en PostgreSQL con rate limit de ${delayMs}ms.`,
      });
    } catch (e: any) {
      res.status(500).json({ detail: `Error creando tarea de rastreo: ${e.message}` });
    }
  });

  // GET /api/v1/worker/jobs - List all background crawler jobs from PostgreSQL
  // El frontend consulta ~1 req/s durante toda la sesiÃ³n; se marcan las respuestas
  // como cacheables 2s + stale-while-revalidate para que el navegador no re-golpee
  // la API (y Postgres) con peticiones idÃ©nticas en ventanas tan cortas.
  app.get("/api/v1/worker/jobs", async (req: Request, res: Response) => {
    const jobs = await taskWorker.getAllJobs();
    res.setHeader("Cache-Control", "public, max-age=2, stale-while-revalidate=8");
    res.json(jobs);
  });

  // POST /api/v1/worker/jobs - creación explícita desde la cola del panel.
  // Mantiene las opciones de importación junto al checkpoint para que una
  // reanudación futura use exactamente las mismas decisiones del administrador.
  app.post("/api/v1/worker/jobs", async (req: Request, res: Response) => {
    const body = req.body || {};
    const targetUrl = String(body.target_url || body.url || "").trim();
    if (!targetUrl) return res.status(400).json({ detail: "target_url es obligatorio" });
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ detail: "target_url debe ser una URL http(s)" });
    const allowedScopes = new Set(["single", "catalog_pages", "full_catalog"]);
    const scope = allowedScopes.has(String(body.scope)) ? String(body.scope) as "single" | "catalog_pages" | "full_catalog" : "catalog_pages";
    const maxPages = scope === "full_catalog" ? 0 : Math.max(1, Math.min(10_000, Number(body.max_pages) || 1));
    const delay = body.delay_ms === undefined || body.delay_ms === "" ? undefined : Math.max(300, Math.min(10_000, Number(body.delay_ms) || 1500));
    if (body.pagination_mode === "template" && (typeof body.pagination_template !== "string" || !body.pagination_template.includes("{page}"))) {
      return res.status(400).json({ detail: "pagination_template debe incluir {page}" });
    }
    const examples = Array.isArray(body.pagination_examples)
      ? body.pagination_examples.filter((item: unknown) => typeof item === "string")
      : typeof body.pagination_examples === "string" ? body.pagination_examples : [];
    try {
      const job = await taskWorker.createJob({
        target_url: targetUrl,
        scope,
        max_pages: maxPages,
        delay_ms: delay,
        name: typeof body.name === "string" ? body.name : undefined,
        resolver_hint: typeof body.resolver_hint === "string" ? body.resolver_hint : null,
        content_kind: typeof body.content_kind === "string" ? body.content_kind : null,
        pagination_mode: body.pagination_mode === "template" || body.pagination_mode === "examples" ? body.pagination_mode : "auto",
        pagination_template: typeof body.pagination_template === "string" ? body.pagination_template : null,
        pagination_examples: examples,
      });
      return res.status(201).json({ status: "pending", job });
    } catch (e: any) {
      return res.status(500).json({ detail: `Error creando tarea de worker: ${e?.message || e}` });
    }
  });

  // Los adaptadores reales se muestran en el formulario de Nueva tarea para
  // poder fijar uno cuando la detección automática no sea suficiente.
  app.get("/api/v1/scraper/adapters", (_req: Request, res: Response) => {
    res.json(scraperManager.getAvailableAdapters());
  });

  // GET /api/v1/worker/settings - Get rate limit and anti-blocking configs
  // Devuelve settings + estado vivo (jobs activos, registro anti-bot) y una
  // recomendaciÃ³n fija para que la UI sugiera valores "a fondo".
  app.get("/api/v1/worker/settings", async (req: Request, res: Response) => {
    res.json({
      ...taskWorker.getSettings(),
      active_jobs: taskWorker.activeJobCount,
      antibot: taskWorker.getAntiBotReport(),
      recommended: {
        max_concurrent_jobs: 3,
        delay_ms: 300,
        page_concurrency: 8,
        item_concurrency: 16,
      },
    });
  });

  // POST /api/v1/worker/settings - Update worker settings
  app.post("/api/v1/worker/settings", async (req: Request, res: Response) => {
    const newSettings = req.body || {};
    await taskWorker.updateSettings(newSettings);
    res.json({
      status: "ok",
      settings: {
        ...taskWorker.getSettings(),
        active_jobs: taskWorker.activeJobCount,
        antibot: taskWorker.getAntiBotReport(),
      recommended: {
        max_concurrent_jobs: 3,
        delay_ms: 800,
        page_concurrency: 4,
        item_concurrency: 5,
      },
      },
    });
  });

  // POST /api/v1/worker/jobs/:job_id/pause
  app.post("/api/v1/worker/jobs/:job_id/pause", async (req: Request, res: Response) => {
    const success = await taskWorker.pauseJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo pausar la tarea" });
    res.json({ status: "ok", message: "Tarea pausada" });
  });

  // POST /api/v1/worker/jobs/:job_id/resume
  app.post("/api/v1/worker/jobs/:job_id/resume", async (req: Request, res: Response) => {
    const success = await taskWorker.resumeJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo reanudar la tarea" });
    res.json({ status: "ok", message: "Tarea reanudada" });
  });

  // POST /api/v1/worker/jobs/:job_id/cancel
  app.post("/api/v1/worker/jobs/:job_id/cancel", async (req: Request, res: Response) => {
    const success = await taskWorker.cancelJob(req.params.job_id);
    if (!success) return res.status(400).json({ detail: "No se pudo cancelar la tarea" });
    res.json({ status: "ok", message: "Tarea cancelada" });
  });

  // POST /api/v1/worker/jobs/:job_id/start
  // Inicia YA un job pendiente, saltÃ¡ndose la cola de prioridad. Con la
  // ejecuciÃ³n paralela puede correr JUNTO a otros jobs (hasta max_concurrent_jobs).
  app.post("/api/v1/worker/jobs/:job_id/start", async (req: Request, res: Response) => {
    void taskWorker
      .runJobNow(req.params.job_id)
      .then((ok) => {
        if (!ok) console.log(`[Worker] No se pudo iniciar el job ${req.params.job_id} (no estaba pendiente)`);
      })
      .catch((e) => {
        // SIN este catch, un P1008 (BD saturada) mata el proceso entero.
        console.error(`[Worker] runJobNow ${req.params.job_id} fallÃ³:`, e?.message || e);
      });
    res.json({ status: "ok", message: "Tarea enviada para inicio inmediato" });
  });

  // DELETE /api/v1/worker/jobs/:job_id
  app.delete("/api/v1/worker/jobs/:job_id", async (req: Request, res: Response) => {
    const success = await taskWorker.deleteJob(req.params.job_id);
    if (!success) return res.status(404).json({ detail: "Tarea no encontrada" });
    res.json({ status: "ok", message: "Tarea eliminada" });
  });

  // ── Recuperación canónica de fuentes ────────────────────────────────────
  // Reconstruye páginas/embed estables para que la resolución JIT obtenga un
  // stream firmado fresco. Es independiente del crawler normal.
  app.post("/api/v1/source-recovery/start", async (req: Request, res: Response) => {
    const rawBody = req.body;
    if (rawBody !== undefined && (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody))) {
      return res.status(400).json({ ok: false, detail: "El cuerpo debe ser un objeto JSON" });
    }

    const body = (rawBody || {}) as Record<string, unknown>;
    let providers: string[] | undefined;
    if (body.providers !== undefined) {
      if (
        !Array.isArray(body.providers) ||
        body.providers.length > 16 ||
        !body.providers.every((provider) => typeof provider === "string" && provider.trim().length > 0 && provider.trim().length <= 80)
      ) {
        return res.status(400).json({ ok: false, detail: "providers debe ser un array de hasta 16 nombres válidos" });
      }
      providers = body.providers.map((provider) => (provider as string).trim());
    }

    let limit: number | undefined;
    if (body.limit !== undefined) {
      const value = typeof body.limit === "number" ? body.limit : typeof body.limit === "string" ? Number(body.limit.trim()) : NaN;
      if (!Number.isInteger(value) || value < 1 || value > 50_000) {
        return res.status(400).json({ ok: false, detail: "limit debe ser un entero entre 1 y 50000" });
      }
      limit = value;
    }

    let delayMs: number | undefined;
    if (body.delay_ms !== undefined) {
      const value = typeof body.delay_ms === "number" ? body.delay_ms : typeof body.delay_ms === "string" ? Number(body.delay_ms.trim()) : NaN;
      if (!Number.isInteger(value) || value < 300 || value > 10_000) {
        return res.status(400).json({ ok: false, detail: "delay_ms debe ser un entero entre 300 y 10000" });
      }
      delayMs = value;
    }

    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.trim().length > 120) {
        return res.status(400).json({ ok: false, detail: "name debe ser texto no vacío de máximo 120 caracteres" });
      }
      name = body.name.trim();
    }

    let mode: "expired" | "all" = "expired";
    if (body.mode !== undefined) {
      if (body.mode !== "expired" && body.mode !== "all") {
        return res.status(400).json({ ok: false, detail: "mode debe ser 'expired' o 'all'" });
      }
      mode = body.mode;
    }

    try {
      const job = await sourceRecoveryWorker.createJob({ providers, limit, delay_ms: delayMs, name, mode });
      return res.status(202).json({ ok: true, job });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error creando recuperación de fuentes: ${detail}` });
    }
  });

  // GET /api/v1/source-recovery/jobs - estado de recuperaciones persistidas
  app.get("/api/v1/source-recovery/jobs", async (req: Request, res: Response) => {
    const rawLimit = req.query.limit;
    let limit = 20;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit)) {
        return res.status(400).json({ ok: false, detail: "limit debe ser un entero" });
      }
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return res.status(400).json({ ok: false, detail: "limit debe estar entre 1 y 100" });
      }
    }
    try {
      const jobs = await sourceRecoveryWorker.getJobs(limit);
      res.setHeader("Cache-Control", "private, max-age=1, stale-while-revalidate=4");
      return res.json({ ok: true, jobs });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error consultando recuperaciones: ${detail}` });
    }
  });

  // GET /api/v1/source-recovery/jobs/:job_id - detalle y cola actual
  app.get("/api/v1/source-recovery/jobs/:job_id", async (req: Request, res: Response) => {
    try {
      const job = await sourceRecoveryWorker.getJob(req.params.job_id);
      if (!job) return res.status(404).json({ ok: false, detail: "Recuperación no encontrada" });
      return res.json({ ok: true, job });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error consultando recuperación: ${detail}` });
    }
  });

  // POST /api/v1/source-recovery/jobs/:job_id/pause|resume
  app.post("/api/v1/source-recovery/jobs/:job_id/pause", async (req: Request, res: Response) => {
    try {
      const success = await sourceRecoveryWorker.pauseJob(req.params.job_id);
      if (!success) return res.status(400).json({ ok: false, detail: "No se pudo pausar la recuperación" });
      return res.json({ ok: true, status: "recovery_paused" });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error pausando recuperación: ${detail}` });
    }
  });

  app.post("/api/v1/source-recovery/jobs/:job_id/resume", async (req: Request, res: Response) => {
    try {
      const success = await sourceRecoveryWorker.resumeJob(req.params.job_id);
      if (!success) return res.status(400).json({ ok: false, detail: "No se pudo reanudar la recuperación" });
      return res.json({ ok: true, status: "recovery_pending" });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ ok: false, detail: `Error reanudando recuperación: ${detail}` });
    }
  });

  // â”€â”€ Enriquecimiento diferido (metadatos faltantes en background) â”€â”€
  // POST /api/v1/metadata/backfill { limit? } - encola obras con metadatos incompletos
  app.post("/api/v1/metadata/backfill", async (req: Request, res: Response) => {
    try {
      const limit = typeof req.body?.limit === "number" ? req.body.limit : parseInt(req.body?.limit, 10) || 100;
      const result = await backfillMissingMetadata(limit);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ detail: `Error encolando backfill: ${e.message}` });
    }
  });

  // GET /api/v1/metadata/backfill - estado del worker de backfill
  app.get("/api/v1/metadata/backfill", async (_req: Request, res: Response) => {
    res.json(getBackfillStatus());
  });

  // â”€â”€ Apartado de VerificaciÃ³n (worker periÃ³dico: metadatos + novedades) â”€â”€

  // GET /api/v1/verification - estado en vivo + config incluida
  app.get("/api/v1/verification", (_req: Request, res: Response) => {
    res.json(getVerificationStatus());
  });

  // POST /api/v1/verification/config - actualiza y persiste la config (reprograma el timer)
  app.post("/api/v1/verification/config", async (req: Request, res: Response) => {
    try {
      if (req.body?.platforms !== undefined) {
        if (!Array.isArray(req.body.platforms) || !req.body.platforms.every((p: any) => typeof p === "string")) {
          return res.status(400).json({ ok: false, detail: "platforms must be an array of strings" });
        }
      }
      const config = await updateVerificationConfig(req.body || {});
      res.json({ ok: true, config, status: getVerificationStatus() });
    } catch (e: any) {
      res.status(400).json({ ok: false, detail: String(e?.message || e) });
    }
  });

  // POST /api/v1/verification/run { mode?, platforms?, limit? }
  // 202 = comenzó; 409 = ya en ejecución; 400 = input inválido.
  app.post("/api/v1/verification/run", async (req: Request, res: Response) => {
    const body = req.body || {};
    // Validación de input
    if (body.mode !== undefined && body.mode !== "metadata" && body.mode !== "full" && body.mode !== "identity") {
      return res.status(400).json({ ok: false, detail: "mode must be 'metadata', 'identity' or 'full'" });
    }
    if (
      body.platforms !== undefined &&
      (!Array.isArray(body.platforms) || !body.platforms.every((p: any) => typeof p === "string"))
    ) {
      return res.status(400).json({ ok: false, detail: "platforms must be an array of strings" });
    }
    if (body.limit !== undefined && (!Number.isFinite(Number(body.limit)) || Number(body.limit) <= 0)) {
      return res.status(400).json({ ok: false, detail: "limit must be a positive number" });
    }
    if (body.pages_per_platform !== undefined && (!Number.isFinite(Number(body.pages_per_platform)) || Number(body.pages_per_platform) <= 0)) {
      return res.status(400).json({ ok: false, detail: "pages_per_platform must be a positive number" });
    }
    const result = runVerification({
      mode: body.mode,
      platforms: Array.isArray(body.platforms) ? body.platforms : undefined,
      limit: body.limit ? Math.round(Number(body.limit)) : undefined,
      pages_per_platform: body.pages_per_platform ? Math.round(Number(body.pages_per_platform)) : undefined,
    });
    if (!result.started) {
      return res.status(409).json({ ok: false, started: false, reason: result.reason, status: getVerificationStatus() });
    }
    res.status(202).json({ ok: true, started: true, status: getVerificationStatus() });
  });

  // POST /api/v1/verification/pause
  app.post("/api/v1/verification/pause", (_req: Request, res: Response) => {
    const result = pauseVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  // POST /api/v1/verification/resume
  app.post("/api/v1/verification/resume", (_req: Request, res: Response) => {
    const result = resumeVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  // POST /api/v1/verification/stop
  app.post("/api/v1/verification/stop", (_req: Request, res: Response) => {
    const result = stopVerification();
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  // POST /api/v1/verification/repair-links
  app.post("/api/v1/verification/repair-links", async (_req: Request, res: Response) => {
    try {
      const result = await sanitizeCatalogLandingPages();
      res.json({
        ok: true,
        message: `Auditoría y saneamiento completado. Enlaces de catálogo erróneos purgados: ${result.totalCleaned}`,
        details: {
          ...result.details,
          total: result.totalCleaned,
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // POST /api/v1/worker/clear-finished
  app.post("/api/v1/worker/clear-finished", async (req: Request, res: Response) => {
    await taskWorker.clearFinishedJobs();
    res.json({ status: "ok", message: "Tareas completadas limpiadas" });
  });

  // GET /api/v1/tasks/:task_id - Live Task & Log Monitor
  app.get("/api/v1/tasks/:task_id", async (req: Request, res: Response) => {
    const taskId = req.params.task_id;
    const job = await taskWorker.getJob(taskId);
    if (job) {
      return res.json({
        task_id: job.id,
        name: job.name,
        status: job.status,
        pages_crawled: job.current_page,
        shows_imported: job.shows_imported,
        episodes_imported: job.episodes_imported,
        total_discovered: job.total_discovered,
        current_item_title: job.current_item_title,
        items_queue: (job.items_queue || []).slice(-50),
        rate_limit_delay_ms: job.rate_limit_delay_ms,
        error_message: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
        logs: (job.logs || []).slice(-100).map((l) => `[${l.level.toUpperCase()}] ${l.message}`),
        detailed_logs: (job.logs || []).slice(-100),
      });
    }
    return res.status(404).json({ detail: "Tarea no encontrada" });
  });

  // POST /api/v1/extract - Universal Stream & Video Extractor
  app.post("/api/v1/extract", async (req: Request, res: Response) => {
    const url = req.body?.url || "";
    if (!url) {
      return res.status(400).json({ detail: "URL requerida para extracciÃ³n" });
    }

    try {
      const extracted = await extractStreamFromUrl(url);
      const analysis = await analyzeUniversalUrl(url).catch(() => null);

      const streams = Array.from(
        new Set(
          [
            extracted.stream_url,
            ...(extracted.all_available_streams || []),
            ...(analysis?.detected_streams || []),
            ...(analysis?.episodes || []).map((e) => e.url),
            url,
          ].filter(Boolean)
        )
      );

      res.json({
        title: extracted.title || analysis?.title || "Stream ExtraÃ­do",
        description: `Estrategia: Universal Live Extractor (${(analysis?.content_type || "video").toUpperCase()})`,
        detected_type: analysis?.content_type || "video",
        stream_url: streams[0] || url,
        all_streams: streams,
        poster_url: analysis?.poster_url || "",
        subtitles: [],
      });
    } catch (e: any) {
      res.status(500).json({ detail: `Error extrayendo stream: ${e.message}` });
    }
  });

  // POST /api/v1/catalog/reset-sample - Clear all database entries
  app.post("/api/v1/catalog/reset-sample", async (req: Request, res: Response) => {
    try {
      await clearAllShowsFromDb();
      res.json({ status: "ok", message: "Base de datos PostgreSQL vaciada completamente." });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ==========================================
  // Network & Playback Health Monitor API
  // ==========================================

  // GET /api/v1/network/stats - EstadÃ­sticas agregadas de red y salud del reproductor
  app.get("/api/v1/network/stats", (_req: Request, res: Response) => {
    res.json({
      logFiles: getLogFilePaths(),
      hosts: getHostStats(),
      hostHealth: listHostHealth(),
      playerHealth: getProviderHealthStats(),
      upstreamProviders: {
        doramasflix: getDoramasflixHealth(),
      },
    });
  });

  // POST /api/v1/network/player-event - Registro de eventos del reproductor (telemetrÃ­a de pantalla negra / fallos)
  app.post("/api/v1/network/player-event", (req: Request, res: Response) => {
    const { eventType, provider, serverUrl, mediaTitle, episodeTitle, durationBeforeErrorMs, details } = req.body || {};
    if (!eventType || !serverUrl) {
      return res.status(400).json({ error: "eventType y serverUrl son requeridos" });
    }
    const entry = logPlayerEvent({
      eventType,
      provider,
      serverUrl,
      mediaTitle,
      episodeTitle,
      durationBeforeErrorMs,
      details,
    });
    if (eventType === "playback_started") {
      reportPlaybackSignal(serverUrl, { ok: true, latencyMs: durationBeforeErrorMs });
    } else if (eventType === "playback_error" || eventType === "black_screen_stalled") {
      reportPlaybackSignal(serverUrl, {
        ok: false,
        reason: eventType === "black_screen_stalled" ? "playback_timeout" : "playback_error",
        latencyMs: durationBeforeErrorMs,
      });
    }
    res.json({ status: "ok", entry });
  });

  // GET /api/v1/network/logs - Ãšltimas N entradas de red y reproductor
  app.get("/api/v1/network/logs", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 100, 5000);
    res.json({
      network: getRecentLogs(limit),
      playerEvents: getRecentPlayerEvents(limit),
    });
  });

  // DELETE /api/v1/network/logs - Limpiar todos los logs
  app.delete("/api/v1/network/logs", (_req: Request, res: Response) => {
    clearLogs();
    res.json({ status: "ok", message: "Logs de red y reproductor limpiados." });
  });

  // POST /api/v1/catalog/merge-works { keep_id, merge_id, dry_run? }
  // FUSIÃ“N MANUAL de dos obras concretas (p.ej. pares de idioma distinto que
  // la auto-reconciliaciÃ³n descarta). keep queda; merge se absorbe.
  app.post("/api/v1/catalog/merge-works", async (req: Request, res: Response) => {
    try {
      const { keep_id, merge_id, dry_run } = req.body ?? {};
      if (!keep_id || !merge_id) return res.status(400).json({ detail: "keep_id y merge_id son requeridos." });
      const result = await mergeTwoShows(String(keep_id), String(merge_id), { dryRun: dry_run !== false });
      if (!result.ok) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ detail: `Error en fusiÃ³n manual: ${e.message}` });
    }
  });

  // POST /api/v1/catalog/reconcile-sequels { dry_run?: boolean }
  // Fusiona secuelas YA EXISTENTES guardadas como cartels separados (mismo
  // tmdb_id): episodios con numeraciÃ³n continua + fuentes bajo su temporada.
  // dry_run=true (default) SOLO reporta; dry_run=false ejecuta de verdad.
  app.post("/api/v1/catalog/reconcile-sequels", async (req: Request, res: Response) => {
    try {
      const dryRun = req.body?.dry_run !== false;
      const summary = await reconcileSequelsByTmdb({ dryRun });
      res.json({ ok: true, ...summary });
    } catch (e: any) {
      res.status(500).json({ detail: `Error en reconciliaciÃ³n: ${e.message}` });
    }
  });

  // GET /api/v1/write-buffer - estado del outbox de escrituras diferidas
  app.get("/api/v1/write-buffer", async (_req: Request, res: Response) => {
    const status = await drainWriteBuffer();
    res.json({ ok: true, ...status });
  });

  // â”€â”€ PROBADOR DE SERVIDORES POR PLATAFORMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // GET obras de una plataforma (episodios cuyo source_url pertenece al dominio).
  app.get("/api/v1/platforms/:platform/works", async (req: Request, res: Response) => {
    try {
      const platform = String(req.params.platform || "").toLowerCase();
      const eps = await prisma.episode.findMany({
        where: { source_url: { contains: platform } },
        include: { show: { select: { id: true, title: true, category: true, poster_url: true } } },
        take: 400,
        orderBy: { updated_at: "desc" },
      });
      const seen = new Set<string>();
      const works: any[] = [];
      for (const e of eps) {
        if (e.show && !seen.has(e.show.id)) {
          seen.add(e.show.id);
          works.push(e.show);
        }
        if (works.length >= 60) break;
      }
      res.json({ ok: true, works });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // POST probar TODOS los servidores de una obra (sin blacklist):
  // resuelve JIT el primer episodio disponible y mide status+latencia de cada
  // stream vÃ­a el proxy. Devuelve la lista completa con la prioridad actual.
  app.post("/api/v1/platforms/:platform/test-servers", async (req: Request, res: Response) => {
    try {
      const platform = String(req.params.platform || "").toLowerCase();
      const showId = String(req.body?.show_id || "");
      const show = await prisma.show.findUnique({ where: { id: showId }, include: { episodes: true } });
      if (!show) return res.status(404).json({ detail: "Obra no encontrada." });

      const candidates = show.episodes.filter((e: any) => e.source_url);
      const episode = candidates.find((e: any) => e.source_url.toLowerCase().includes(platform)) || candidates[0];
      if (!episode) return res.status(404).json({ detail: "La obra no tiene episodios con fuente." });

      const extracted = await extractStreamFromUrl(episode.source_url);
      const seen = new Set<string>();
      const streams = [extracted.stream_url, ...(extracted.all_available_streams || [])]
        .filter(Boolean)
        .filter((u: string) => {
          if (seen.has(u) || isBlacklistedHost(u)) return false;
          const host = hostOfUrl(u);
          if (host.includes(platform) || isInvalidCatalogSource(u) || isCanonicalLocator(u)) return false;
          seen.add(u);
          return true;
        })
        .slice(0, 12);

      const priorities = getServerPriorities(platform);
      const port = process.env.PORT || 3010;
      const origin = `http://127.0.0.1:${port}`;

      if (streams.length === 0) {
        return res.json({
          ok: true,
          platform,
          episode_url: episode.source_url,
          results: [],
          priorities,
          message: "No se encontraron servidores de video activos para esta obra.",
        });
      }

      const tests = await Promise.all(
        streams.map(async (url: string) => {
          const host = hostOfUrl(url);
          const started = Date.now();
          let status = 0;
          let isMedia = false;
          try {
            const r = await fetch(`${origin}/api/v1/proxy/stream?url=${encodeURIComponent(url)}`, {
              headers: { Range: "bytes=0-100", "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(9000),
            });
            status = r.status;
            const contentType = r.headers.get("content-type") || "";
            isMedia = (status === 200 || status === 206) && !contentType.includes("text/html");
            try { await r.body?.cancel(); } catch {}
          } catch {
            status = 0;
          }
          return {
            url,
            host,
            hostFamily: familyKeyOfStreamUrl(url),
            status,
            ok: isMedia,
            latency_ms: Date.now() - started,
            priority: priorities[familyKeyOfStreamUrl(url)] ?? undefined,
          };
        })
      );

      // Priorizados primero, luego por latencia.
      tests.sort((a, b) => {
        const na = a.priority ?? Number.MAX_SAFE_INTEGER;
        const nb = b.priority ?? Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
        return a.latency_ms - b.latency_ms;
      });

      res.json({
        ok: true,
        platform,
        episode_url: episode.source_url,
        results: tests,
        priorities,
      });
    } catch (e: any) {
      res.status(500).json({ detail: `Error probando servidores: ${e.message}` });
    }
  });

  // GET prioridades de servidores de una plataforma
  app.get("/api/v1/platforms/:platform/server-priorities", async (req: Request, res: Response) => {
    res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
  });

  // POST guardar orden completo { order: ["host1", "host2", ...] }
  app.post("/api/v1/platforms/:platform/server-priorities", async (req: Request, res: Response) => {
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order.map((h: any) => String(h)) : [];
      if (order.length === 0) return res.status(400).json({ detail: "order requerido (lista de hosts)." });
      setServerOrder(req.params.platform, order);
      res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // POST mover un host { host, dir: -1 | 1 }
  app.post("/api/v1/platforms/:platform/server-priorities/move", async (req: Request, res: Response) => {
    try {
      const { host, dir } = req.body ?? {};
      if (!host || (dir !== -1 && dir !== 1)) return res.status(400).json({ detail: "host y dir (-1|1) requeridos." });
      moveServerPriority(req.params.platform, String(host), dir === -1 ? -1 : 1);
      res.json({ ok: true, priorities: getServerPriorities(req.params.platform) });
    } catch (e: any) {
      res.status(500).json({ detail: e.message });
    }
  });

  // Sesión administrativa independiente de la autenticación de usuarios.
  app.post("/api/v1/admin/login", adminLogin);
  app.get("/api/v1/admin/session", adminSession);
  app.post("/api/v1/admin/logout", adminLogout);
  // Un usuario marcado como administrador desde el panel puede abrir la
  // consola sin compartir la contraseña del control-plane. La sesión sigue
  // siendo una cookie HttpOnly exactamente igual que la del login principal.
  app.post("/api/v1/admin/user-session", requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { is_admin: true } });
      if (!user?.is_admin) return res.status(403).json({ error: "Este usuario no tiene permisos de administración." });
      // Reutilizar la emisión de cookie requiere credenciales del control-plane;
      // el endpoint dedicado devuelve una sesión firmada con la misma utilidad.
      const { issueAdminSession, ADMIN_SESSION_COOKIE } = await import("./server/adminAuth");
      res.cookie(ADMIN_SESSION_COOKIE, issueAdminSession(), { httpOnly: true, sameSite: "strict", secure: Boolean(req.secure || req.headers["x-forwarded-proto"] === "https"), path: "/" });
      return res.json({ ok: true });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "No se pudo abrir la sesión administrativa." });
    }
  });

  app.get("/api/v1/admin/users", async (_req: Request, res: Response) => {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, avatar: true, is_admin: true, created_at: true },
      orderBy: [{ is_admin: "desc" }, { username: "asc" }],
    });
    res.json({ users });
  });
  app.patch("/api/v1/admin/users/:user_id/role", async (req: Request, res: Response) => {
    const isAdmin = req.body?.is_admin;
    if (typeof isAdmin !== "boolean") return res.status(400).json({ error: "is_admin debe ser booleano." });
    try {
      const user = await prisma.user.update({
        where: { id: req.params.user_id },
        data: { is_admin: isAdmin },
        select: { id: true, username: true, avatar: true, is_admin: true, created_at: true },
      });
      res.json({ user });
    } catch {
      res.status(404).json({ error: "Usuario no encontrado." });
    }
  });
  app.get("/api/v1/admin/catalog/lookup", async (req: Request, res: Response) => {
    const identifier = String(req.query.identifier || req.query.q || req.query.query || "").trim();
    if (!identifier) {
      return res.status(400).json({ ok: false, error: "Identificador o título requerido." });
    }
    const kind = req.query.kind ? String(req.query.kind).trim() : undefined;
    const year = req.query.year ? Number.parseInt(String(req.query.year), 10) : undefined;
    try {
      const lookup = await lookupAdminCatalogIdentifier(identifier, { kind, year });
      if (!lookup || !Array.isArray(lookup.candidates) || lookup.candidates.length === 0) {
        return res.status(404).json({
          ok: false,
          query: identifier,
          exact_match: false,
          candidates: [],
          tmdb: [],
          local: lookup?.local || { shows: [], media_items: [], title_matches: [] },
          error: "TMDB no devolvió una película ni una serie con ese identificador o título.",
        });
      }
      res.setHeader("Cache-Control", "private, no-store");
      return res.json(lookup);
    } catch (error: any) {
      return res.status(502).json({
        ok: false,
        query: identifier,
        error: error?.message || "No se pudo consultar el catálogo externo.",
      });
    }
  });
  app.get("/api/v1/admin/tmdb/lookup/:tmdb_id", async (req: Request, res: Response) => {
    const tmdbId = Number(req.params.tmdb_id);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: "TMDB ID inválido." });
    const [movie, series] = await Promise.all([
      getPublicCatalogDetail("movie", tmdbId).catch(() => null),
      getPublicCatalogDetail("series", tmdbId).catch(() => null),
    ]);
    const localShows = await prisma.show.findMany({
      where: { tmdb_id: tmdbId },
      select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true, year: true },
      orderBy: { created_at: "desc" },
    });
    const localMedia = await prisma.mediaItem.findMany({
      where: { tmdb_id: tmdbId },
      select: { id: true, title: true, kind: true, tmdb_id: true, poster_url: true, year: true },
      orderBy: { created_at: "desc" },
    });
    const tmdb = [movie, series].filter(Boolean);
    const titleKeys = [...new Set(tmdb.flatMap((item: any) => [item?.title, item?.original_title, item?.english_title])
      .map((title) => normalizeTitle(String(title || "")))
      .filter((title) => title.length >= 3))];
    const titleMatches = titleKeys.length > 0
      ? await prisma.show.findMany({
        where: {
          OR: titleKeys.flatMap((title) => [
            { normalized_title: title },
            { base_normalized_title: title },
          ]),
        },
        select: { id: true, title: true, category: true, tmdb_id: true, poster_url: true, year: true },
        orderBy: { updated_at: "desc" },
        take: 20,
      })
      : [];
    if (tmdb.length === 0) return res.status(404).json({ error: "TMDB no devolvió una película ni una serie con ese ID.", tmdb_id: tmdbId, local: { shows: localShows, media_items: localMedia } });
    res.json({ tmdb_id: tmdbId, tmdb, local: { shows: localShows, media_items: localMedia, title_matches: titleMatches } });
  });

  // Estado de la reparación externa de identidades. Es solo lectura: el
  // proceso se ejecuta fuera del worker interno y no se controla desde aquí.
  app.get("/api/v1/admin/identity-repair/status", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "private, max-age=3, stale-while-revalidate=5");
    res.json(await getIdentityRepairStatus());
  });

  // Operaciones que antes solo podían lanzarse desde la consola. Se conserva
  // una lista blanca de scripts para que el panel sea el centro de control sin
  // convertir el endpoint en un ejecutor arbitrario de comandos.
  app.get("/api/v1/admin/operations", async (_req: Request, res: Response) => {
    res.json({ definitions: getAdminOperationDefinitions(), operations: await listAdminOperations() });
  });
  app.get("/api/v1/admin/operations/:operation_id", async (req: Request, res: Response) => {
    const operation = await getAdminOperation(req.params.operation_id);
    if (!operation) return res.status(404).json({ error: "Operación no encontrada." });
    res.json(operation);
  });
  app.get("/api/v1/admin/operations/:operation_id/log", async (req: Request, res: Response) => {
    const log = await getAdminOperationLog(req.params.operation_id);
    if (log === null) return res.status(404).json({ error: "Log no disponible." });
    res.json({ id: req.params.operation_id, log });
  });
  app.post("/api/v1/admin/operations/:operation_id/cancel", async (req: Request, res: Response) => {
    const ok = await cancelAdminOperation(req.params.operation_id);
    res.json({ ok, operation_id: req.params.operation_id });
  });
  app.delete("/api/v1/admin/operations/:operation_id", async (req: Request, res: Response) => {
    const ok = await deleteAdminOperation(req.params.operation_id);
    res.json({ ok, operation_id: req.params.operation_id });
  });
  app.post("/api/v1/admin/operations", async (req: Request, res: Response) => {
    try {
      const operation = String(req.body?.operation || "").trim();
      const status = await startAdminOperation(operation, {
        apply: req.body?.apply === true,
        onlyEmpty: req.body?.onlyEmpty !== false,
      });
      res.status(202).json(status);
    } catch (error: any) {
      const message = String(error?.message || error);
      res.status(/ya está en curso/i.test(message) ? 409 : 400).json({ error: message });
    }
  });

  // Resumen operativo del panel: una sola consulta protegida para no hacer
  // que la interfaz dispare una batería de peticiones al abrirse.
  app.get("/api/v1/admin/overview", async (_req: Request, res: Response) => {
    try {
      const [
        catalogCounts,
        episodeCount,
        mediaEpisodeCount,
        sourceLinkCount,
        missingShowTmdb,
        missingMediaTmdb,
        missingShowArtwork,
        missingMediaArtwork,
        failingLinks,
        users,
        duplicateTmdbGroups,
        ratings,
        jobs,
        recentWorks,
        reportSummary,
      ] = await Promise.all([
        getUnifiedCatalogCounts(),
        prisma.episode.count(),
        prisma.mediaEpisode.count(),
        prisma.sourceLink.count(),
        prisma.show.count({ where: { tmdb_id: null } }),
        prisma.mediaItem.count({ where: { tmdb_id: null } }),
        prisma.show.count({ where: { OR: [{ poster_url: null }, { poster_url: "" }, { banner_url: null }, { banner_url: "" }] } }),
        prisma.mediaItem.count({ where: { OR: [{ poster_url: null }, { poster_url: "" }, { backdrop_path: null }, { backdrop_path: "" }] } }),
        prisma.sourceLink.count({ where: { source_status: { in: ["failed", "error", "dead"] } } }),
        prisma.user.count(),
        prisma.show.groupBy({
          by: ["tmdb_id"],
          where: { tmdb_id: { not: null } },
          _count: { tmdb_id: true },
          having: { tmdb_id: { _count: { gt: 1 } } },
        }),
        getAllSiteRatings(),
        taskWorker.getAllJobs(),
        prisma.show.findMany({
          orderBy: { created_at: "desc" },
          take: 6,
          select: { id: true, title: true, category: true, poster_url: true, created_at: true },
        }),
        getCatalogReportSummary(),
      ]);

      const verification = getVerificationStatus();
      const providerHealth = getProviderHealthStats()
        .map((provider) => ({
          provider: provider.provider,
          attempts: provider.totalAttempts,
          success_rate: provider.totalAttempts > 0 ? Math.round((provider.successfulPlays / provider.totalAttempts) * 100) : 0,
        }))
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, 8);
      const activeJobs = jobs.filter((job: any) => job.status === "running").length;
      const pendingJobs = jobs.filter((job: any) => job.status === "pending" || job.status === "paused").length;
      const failedJobs = jobs.filter((job: any) => job.status === "failed").length;

      res.setHeader("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
      res.json({
        generated_at: new Date().toISOString(),
        catalog: {
          shows: catalogCounts.shows,
          media_items: catalogCounts.media_items,
          unique_works: catalogCounts.unique_works,
          duplicate_records: catalogCounts.duplicate_records,
          episodes: episodeCount + mediaEpisodeCount,
          source_links: sourceLinkCount,
          missing_tmdb: missingShowTmdb + missingMediaTmdb,
          missing_artwork: missingShowArtwork + missingMediaArtwork,
          duplicate_tmdb_ids: duplicateTmdbGroups.length,
        },
        operations: {
          active_jobs: activeJobs,
          pending_jobs: pendingJobs,
          failed_jobs: failedJobs,
          verification_running: Boolean(verification.running || verification.is_running),
          verification_phase: verification.phase,
          last_verification_at: verification.last_run_at,
        },
        sources: {
          enabled_sites: ratings.filter((rating) => rating.enabled).length,
          total_sites: ratings.length,
          failing_links: failingLinks,
          provider_health: providerHealth,
        },
        reports: reportSummary,
        users,
        recent_works: recentWorks,
      });
    } catch (error: any) {
      res.status(500).json({ detail: `No se pudo construir el resumen administrativo: ${error?.message || String(error)}` });
    }
  });

  // =========================================================================
  // DEBUG SIMULATOR: Click-to-Play Frontend Simulation with Network Probe
  // Simulates frontend user clicking 'Play', calling /api/v1/play/:episode_id,
  // resolving candidate direct servers, following redirects, and verifying 200/206
  // =========================================================================
  async function probeStreamNetwork(url: string, customHeaders: Record<string, string> = {}, portNum = 3010) {
    const start = Date.now();
    try {
      const targetUrl = url.startsWith("/") ? `http://127.0.0.1:${portNum}${url}` : url;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);
      const reqHeaders: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Range": "bytes=0-2048",
        ...buildProxyHeaders(targetUrl),
        ...customHeaders,
      };
      const resp = await fetch(targetUrl, {
        method: "GET",
        headers: reqHeaders,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const latency_ms = Date.now() - start;
      const contentType = resp.headers.get("content-type") || "";
      const textSample = await resp.text().catch(() => "");
      const is_m3u8 = textSample.includes("#EXTM3U") || contentType.includes("mpegurl");
      const is_mpd = textSample.includes("<MPD") || contentType.includes("dash+xml") || /\.mpd(?:[?#]|$)/i.test(resp.url || url);
      const is_mp4 = contentType.includes("video/mp4") || url.includes(".mp4");
      const is_html = contentType.includes("text/html") || textSample.includes("<!DOCTYPE") || textSample.includes("<html");

      return {
        status: resp.status,
        ok: resp.ok || resp.status === 206,
        latency_ms,
        content_type: contentType,
        redirected: resp.redirected,
        final_url: resp.url,
        is_m3u8,
        is_mpd,
        is_mp4,
        is_html,
        sample_snippet: textSample.slice(0, 100).replace(/\r?\n/g, " "),
      };
    } catch (err: any) {
      return {
        status: 0,
        ok: false,
        latency_ms: Date.now() - start,
        error: err?.name === "AbortError" ? "Timeout (7s)" : (err?.message || String(err)),
        content_type: "",
        redirected: false,
        final_url: url,
        is_m3u8: false,
        is_mpd: false,
        is_mp4: false,
        is_html: false,
        sample_snippet: "",
      };
    }
  }

  async function executeFrontendPlaySimulation(episode: any, portNum: number) {
    const playApiStart = Date.now();
    let playData: any = null;
    let playStatus = 0;
    try {
      const playRes = await fetch(`http://127.0.0.1:${portNum}/api/v1/play/${episode.id}`, {
        headers: { Accept: "application/json" },
      });
      playStatus = playRes.status;
      playData = await playRes.json();
    } catch (e: any) {
      return {
        success: false,
        error: `Fallo al invocar /api/v1/play/${episode.id}: ${e.message}`,
        episode_id: episode.id,
      };
    }
    const playApiDurationMs = Date.now() - playApiStart;

    const primaryUrl = playData?.stream_url || "";
    const rankedStreams = playData?.ranked_streams || [];

    const primaryProbe = primaryUrl ? await probeStreamNetwork(primaryUrl, rankedStreams[0]?.requiredHeaders, portNum) : null;
    const isDirect = Boolean(EmbedResolvers.isDirectMediaUrl(primaryUrl) || primaryProbe?.is_m3u8 || primaryProbe?.is_mpd || primaryProbe?.is_mp4);
    const isIframe = !isDirect && (playData?.delivery_mode === "embed" || Boolean(primaryProbe?.is_html));
    const playerEngine = isDirect
      ? (primaryUrl.includes(".mpd") || primaryProbe?.is_mpd
        ? "dash.js (Reproductor Nativo DASH)"
        : (primaryUrl.includes(".m3u8") || primaryProbe?.is_m3u8 ? "hls.js (Reproductor Nativo HLS)" : "HTML5 Video (<video src=mp4>)"))
      : (isIframe ? "IFRAME_BLOQUEADO" : "Desconocido");

    const fallbackProbes = [];
    for (const stream of rankedStreams.slice(1, 4)) {
      const probe = await probeStreamNetwork(stream.url, stream.requiredHeaders, portNum);
      fallbackProbes.push({
        server_provider: stream.provider || stream.source_site || "Desconocido",
        url: stream.url,
        type: stream.type,
        probe,
      });
    }

    const liveFallback = fallbackProbes.find((f) => f.probe?.ok && !f.probe?.is_html);
    const liveStream = (primaryProbe?.ok && !primaryProbe?.is_html)
      ? { ...primaryProbe, provider: rankedStreams[0]?.provider || "Servidor Primario" }
      : (liveFallback ? { ...liveFallback.probe, provider: liveFallback.server_provider } : null);

    const isSuccess = Boolean(isDirect && liveStream);

    return {
      success: isSuccess,
      simulation_verdict: isSuccess ? "100% STREAMING DIRECTO NATIVO (SIN IFRAMES NI PUBLICIDAD)" : "FALLO_STREAMING",
      timestamp: new Date().toISOString(),
      media: {
        episode_id: episode.id,
        show_title: episode.media_item?.title || "Sin título",
        episode_number: episode.episode_number,
        primary_source_site: episode.links?.[0]?.source_site || "Desconocido",
        source_page_url: episode.links?.[0]?.url || "",
        total_links: episode.links?.length || 0,
      },
      frontend_click_simulation: {
        step_1_api_play_call: {
          endpoint: `/api/v1/play/${episode.id}`,
          response_code: playStatus,
          response_time_ms: playApiDurationMs,
          resolved_stream_url: primaryUrl,
          total_ranked_streams: rankedStreams.length,
        },
        step_2_frontend_decision: {
          player_engine: playerEngine,
          is_direct_native_stream: isDirect,
          is_iframe_blocked: !isIframe,
          active_server_selected: liveStream?.provider || rankedStreams[0]?.provider || "Servidor 1",
          failover_occurred: Boolean(!primaryProbe?.ok && liveFallback),
        },
        step_3_network_playback_probe: {
          primary_stream: primaryProbe,
          fallback_servers_probed: fallbackProbes,
        },
      },
      guarantees: {
        no_iframes: !isIframe,
        no_ad_popups: isDirect,
        direct_media_verified: isSuccess,
      },
    };
  }

  app.all(
    ["/api/v1/debug/simulate-frontend-playback", "/api/v1/debug/simulate-frontend-playback/:episode_id"],
    async (req: Request, res: Response) => {
      try {
        const episodeId = (req.params.episode_id as string) || (req.query.episode_id as string);
        const providerFilter = (req.query.provider as string)?.toLowerCase();
        const testAll = req.query.test_all === "true" || req.query.all === "true";
        const portNum = Number(process.env.PORT || 3010);

        if (testAll) {
          const candidateSites = [
            "animeflv",
            "jkanime",
            "latanime",
            "cinecalidad",
            "doramasflix",
            "tubepelis",
            "gnula",
            "lamovie",
            "tioplus",
            "veranimes",
          ];

          const chosenShows = new Set<string>();
          const batchResults: any[] = [];
          for (const site of candidateSites) {
            const candidateEps = await prisma.mediaEpisode.findMany({
              where: {
                links: {
                  some: {
                    OR: [
                      { source_site: { contains: site, mode: "insensitive" } },
                      { url: { contains: site, mode: "insensitive" } },
                    ],
                  },
                },
              },
              include: { media_item: true, links: true },
              take: 200,
              orderBy: { updated_at: "desc" },
            });

            const ep = candidateEps.find(
              (candidate) => candidate.media_item && !chosenShows.has(candidate.media_item.id)
            ) || candidateEps[0];

            if (ep) {
              if (ep.media_item) chosenShows.add(ep.media_item.id);
              const sim = await executeFrontendPlaySimulation(ep, portNum);
              batchResults.push({
                provider: site,
                ...sim,
              });
            } else {
              batchResults.push({
                provider: site,
                success: false,
                note: "No hay episodios importados en base de datos para este proveedor",
              });
            }
          }

          const passedCount = batchResults.filter((r) => r.success).length;
          return res.json({
            summary: {
              total_providers_tested: batchResults.length,
              passed: passedCount,
              failed: batchResults.length - passedCount,
              status: passedCount > 0 ? "OK" : "NO_STREAMS",
            },
            results: batchResults,
          });
        }

        let targetEpisode: any = null;
        if (episodeId) {
          targetEpisode = await prisma.mediaEpisode.findUnique({
            where: { id: episodeId },
            include: { media_item: true, links: true },
          });
        } else if (providerFilter) {
          targetEpisode = await prisma.mediaEpisode.findFirst({
            where: {
              links: {
                some: {
                  source_site: { contains: providerFilter, mode: "insensitive" },
                },
              },
            },
            include: { media_item: true, links: true },
          });
        } else {
          targetEpisode = await prisma.mediaEpisode.findFirst({
            where: {
              links: { some: {} },
            },
            include: { media_item: true, links: true },
          });
        }

        if (!targetEpisode) {
          return res.status(404).json({
            error: "No matching media episode found to simulate play",
          });
        }

        const simulation = await executeFrontendPlaySimulation(targetEpisode, portNum);
        return res.json({
          provider_filter: providerFilter || null,
          ...simulation,
        });
      } catch (err: any) {
        return res.status(500).json({ error: err?.message || String(err) });
      }
    }
  );

  async function executeFrontendPlaySimulation(episode: any, portNum: number) {
    const playApiStart = Date.now();
    let playData: any = null;
    let playStatus = 0;
    try {
      const playRes = await fetch(`http://127.0.0.1:${portNum}/api/v1/play/${episode.id}`, {
        headers: { Accept: "application/json" },
      });
      playStatus = playRes.status;
      playData = await playRes.json();
    } catch (e: any) {
      return {
        success: false,
        error: `Fallo al invocar /api/v1/play/${episode.id}: ${e.message}`,
        episode_id: episode.id,
      };
    }
    const playApiDurationMs = Date.now() - playApiStart;

    const primaryUrl = playData?.stream_url || "";
    const rankedStreams = playData?.ranked_streams || [];

    const primaryProbe = primaryUrl ? await probeStreamNetwork(primaryUrl, rankedStreams[0]?.requiredHeaders, portNum) : null;
    const isDirect = Boolean(EmbedResolvers.isDirectMediaUrl(primaryUrl) || primaryProbe?.is_m3u8 || primaryProbe?.is_mpd || primaryProbe?.is_mp4);
    const isIframe = !isDirect && (playData?.delivery_mode === "embed" || Boolean(primaryProbe?.is_html));
    const playerEngine = isDirect
      ? (primaryUrl.includes(".mpd") || primaryProbe?.is_mpd
        ? "dash.js (Reproductor Nativo DASH)"
        : (primaryUrl.includes(".m3u8") || primaryProbe?.is_m3u8 ? "hls.js (Reproductor Nativo HLS)" : "HTML5 Video (<video src=mp4>)"))
      : (isIframe ? "IFRAME_BLOQUEADO" : "Desconocido");

    const fallbackProbes = [];
    for (const stream of rankedStreams.slice(1, 4)) {
      const probe = await probeStreamNetwork(stream.url, stream.requiredHeaders, portNum);
      fallbackProbes.push({
        server_provider: stream.provider || stream.source_site || "Desconocido",
        url: stream.url,
        type: stream.type,
        probe,
      });
    }

    const liveFallback = fallbackProbes.find((f) => f.probe?.ok && !f.probe?.is_html);
    const liveStream = (primaryProbe?.ok && !primaryProbe?.is_html)
      ? { ...primaryProbe, provider: rankedStreams[0]?.provider || "Servidor Primario" }
      : (liveFallback ? { ...liveFallback.probe, provider: liveFallback.server_provider } : null);

    const isSuccess = Boolean(isDirect && liveStream);

    return {
      success: isSuccess,
      simulation_verdict: isSuccess ? "100% STREAMING DIRECTO NATIVO (SIN IFRAMES NI PUBLICIDAD)" : "FALLO_STREAMING",
      timestamp: new Date().toISOString(),
      media: {
        episode_id: episode.id,
        show_title: episode.media_item?.title || "Sin título",
        episode_number: episode.episode_number,
        primary_source_site: episode.links?.[0]?.source_site || "Desconocido",
        source_page_url: episode.links?.[0]?.url || "",
        total_links: episode.links?.length || 0,
      },
      frontend_click_simulation: {
        step_1_api_play_call: {
          endpoint: `/api/v1/play/${episode.id}`,
          response_code: playStatus,
          response_time_ms: playApiDurationMs,
          resolved_stream_url: primaryUrl,
          total_ranked_streams: rankedStreams.length,
        },
        step_2_frontend_decision: {
          player_engine: playerEngine,
          is_direct_native_stream: isDirect,
          is_iframe_blocked: !isIframe,
          active_server_selected: liveStream?.provider || rankedStreams[0]?.provider || "Servidor 1",
          failover_occurred: Boolean(!primaryProbe?.ok && liveFallback),
        },
        step_3_network_playback_probe: {
          primary_stream: primaryProbe,
          fallback_servers_probed: fallbackProbes,
        },
      },
      guarantees: {
        no_iframes: !isIframe,
        no_ad_popups: isDirect,
        direct_media_verified: isSuccess,
      },
    };
  }

  app.all(
    ["/api/v1/debug/simulate-frontend-playback", "/api/v1/debug/simulate-frontend-playback/:episode_id"],
    async (req: Request, res: Response) => {
      try {
        const episodeId = (req.params.episode_id as string) || (req.query.episode_id as string);
        const providerFilter = (req.query.provider as string)?.toLowerCase();
        const testAll = req.query.test_all === "true" || req.query.all === "true";
        const portNum = Number(process.env.PORT || 3010);

        if (testAll) {
          const candidateSites = [
            "animeflv",
            "jkanime",
            "latanime",
            "cinecalidad",
            "doramasflix",
            "tubepelis",
            "gnula",
            "lamovie",
            "tioplus",
            "veranimes",
          ];

          const chosenShows = new Set<string>();
          const batchResults: any[] = [];
          for (const site of candidateSites) {
            const candidateEps = await prisma.mediaEpisode.findMany({
              where: {
                links: {
                  some: {
                    OR: [
                      { source_site: { contains: site, mode: "insensitive" } },
                      { url: { contains: site, mode: "insensitive" } },
                    ],
                  },
                },
              },
              include: { media_item: true, links: true },
              take: 200,
              orderBy: { updated_at: "desc" },
            });

            const ep = candidateEps.find(
              (candidate) => candidate.media_item && !chosenShows.has(candidate.media_item.id)
            ) || candidateEps[0];

            if (ep) {
              if (ep.media_item) chosenShows.add(ep.media_item.id);
              const sim = await executeFrontendPlaySimulation(ep, portNum);
              batchResults.push({
                provider: site,
                ...sim,
              });
            } else {
              batchResults.push({
                provider: site,
                success: false,
                note: "No hay episodios importados en base de datos para este proveedor",
              });
            }
          }

          const passedCount = batchResults.filter((r) => r.success).length;
          return res.json({
            summary: {
              total_providers_tested: batchResults.length,
              passed: passedCount,
              failed: batchResults.length - passedCount,
              status: passedCount > 0 ? "OK" : "NO_STREAMS",
            },
            results: batchResults,
          });
        }

        let targetEpisode: any = null;
        if (episodeId) {
          targetEpisode = await prisma.mediaEpisode.findUnique({
            where: { id: episodeId },
            include: { media_item: true, links: true },
          });
        } else if (providerFilter) {
          targetEpisode = await prisma.mediaEpisode.findFirst({
            where: {
              links: {
                some: {
                  source_site: { contains: providerFilter, mode: "insensitive" },
                },
              },
            },
            include: { media_item: true, links: true },
          });
        } else {
          targetEpisode = await prisma.mediaEpisode.findFirst({
            where: {
              links: { some: {} },
            },
            include: { media_item: true, links: true },
          });
        }

        if (!targetEpisode) {
          return res.status(404).json({
            error: "No se encontró ningún episodio para simular la reproducción.",
            provider: providerFilter || "cualquiera",
          });
        }

        const simResult = await executeFrontendPlaySimulation(targetEpisode, portNum);
        return res.json(simResult);
      } catch (err: any) {
        return res.status(500).json({ error: err?.message || String(err) });
      }
    }
  );

  // ==========================================
  // Auth, Progress, Recommendations & Lists Routers
  // ==========================================
  app.use("/api/auth", authRouter);
  app.use("/api/progress", progressRouter);
  app.use("/api/recommendations", recommendationsRouter);
  app.use("/api/lists", userListsRouter);
  app.use("/api/rooms", requireAuth, roomsRouter);

  // ==========================================
  // Vite Middleware & Static Frontend Serving
  // ==========================================
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => {
        // El índice debe consultarse en cada navegación para que un cliente
        // no conserve referencias a chunks de una versión anterior.
        if (path.basename(filePath) === "index.html") {
          res.setHeader("Cache-Control", "no-store, max-age=0");
          return;
        }

        // Los assets con hash son inmutables dentro de una build y pueden
        // cachearse. La siguiente navegación siempre obtiene el índice nuevo.
        if (filePath.split(path.sep).includes("assets")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }));
    app.use((req: Request, res: Response) => {
      // Nunca responder HTML para un módulo JavaScript inexistente: Vite/SPA
      // fallback produciría el mismo error críptico de import dinámico.
      if (req.path === "/assets" || req.path.startsWith("/assets/")) {
        return res.status(404).type("text/plain").send("Asset not found");
      }

      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Red de seguridad: un rechazo no capturado NO debe tumbar el servidor
  // (Node 24 los trata como fatales). Se registran y se sigue vivo.
  process.on("unhandledRejection", (reason) => {
    console.error("[Proceso] Promesa rechazada sin catch (servidor se mantiene vivo):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[Proceso] ExcepciÃ³n no capturada (servidor se mantiene vivo):", err);
  });

  // PostgreSQL: no PRAGMAs needed (those were SQLite-specific).
  // PostgreSQL handles concurrency natively with MVCC.
  let databaseProbeRunning = false;
  const refreshDatabaseReady = async () => {
    if (databaseProbeRunning) return;
    databaseProbeRunning = true;
    try {
      await prisma.$queryRawUnsafe("SELECT 1 as alive");
      if (!databaseReady) console.log("[DB] PostgreSQL connection OK");
      databaseReady = true;
    } catch (e) {
      if (databaseReady) console.warn("[DB] PostgreSQL connection failed:", e?.message || e);
      databaseReady = false;
    } finally {
      databaseProbeRunning = false;
    }
  };
  await refreshDatabaseReady();
  setInterval(() => { void refreshDatabaseReady(); }, 10_000).unref();

  // Drenador del outbox de escrituras diferidas (aplica ops del archivo cuando la BD responde).
  startWriteBufferDrainer();
  // Cargar settings persistidos y activar inmediatamente la cola pendiente.
  // El singleton del worker crea el poller al importar el módulo, pero esta
  // inicialización explícita evita que un arranque con Prisma lento deje los
  // trabajos recién encolados esperando indefinidamente.
  taskWorker.init();

  const httpServer = http.createServer(app);
  setupWatchPartyWebSocket(httpServer);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor PostgreSQL y Watch Party WebSocket ejecutándose en http://0.0.0.0:${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  startServer();
}

