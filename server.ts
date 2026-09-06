import "dotenv/config";
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
} from "./server/universalScraper";
import { cleanQueryTitle, parseTitleQuery } from "./server/metadataEngine";
import { taskWorker } from "./server/taskWorker";
import { sourceRecoveryWorker, isCanonicalLocator } from "./server/sourceRecoveryWorker";
import { selectCanonicalPlaybackCandidate } from "./server/legacyCanonicalBridge";
import {
  saveShowWithDeduplication,
  getShowsFromDb,
  getShowsFromDbLite,
  getShowByIdFromDb,
  deleteShowFromDb,
  clearAllShowsFromDb,
  updateShowFields,
  refreshShowStreams,
} from "./server/showService";
import { prisma, normalizeTitle, normalizeBaseTitle } from "./server/db";
import { EmbedResolvers, isValidProvider } from "./server/resolvers";
import { getStreamTier, sortStreamsByPriority, isBlacklistedHost, hostOfStreamUrl, familyKeyOfStreamUrl } from "./server/utils/streamSorter";
import { getServerPriorities, setServerOrder, moveServerPriority, hostOfUrl } from "./server/serverPriorities";
import { getSiteRating, getAllSiteRatings, upsertSiteRating } from "./server/siteRatingService";
import { siteFromDomain } from "./server/siteRatingService";
import { PlaybackSessionStore, createPlaybackSessionHandlers } from "./server/playbackSessions";
import { streamHealthService } from "./server/streamHealthService";
import { reportPlaybackSignal } from "./server/scrapers/hostHealth";
import { runtimeBudget } from "./server/runtimeBudget";
import { assertSafePublicHttpUrl, UnsafeUrlError } from "./server/urlSafety";
import {
  buildResolveDeliveryResponse,
  DeliveryPlanner,
  ResolutionCoordinator,
} from "./server/deliveryPlanner";
import { classifySourceKind, parseStreamExpiry } from "./server/resolutionMetadata";
import { isInvalidCatalogSource, sanitizeCatalogLandingPages } from "./server/catalogIntegrity";
import { ImpitHttpClient, Browser } from "@crawlee/impit-client";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { buildProxyHeaders } from "./server/hostProfiles";
import { APP_CONFIG, localAllowedOrigins } from "./app.config";
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
import { handleMegaStream } from "./server/resolvers/megaStream";
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
} from "./server/networkLogger";
import { authRouter } from "./server/auth";
import { progressRouter } from "./server/progress";
import { recommendationsRouter } from "./server/recommendations";
import {
  adminLogin,
  adminLogout,
  adminSession,
  requireAdminForControlPlane,
} from "./server/adminAuth";

// Stealth HTTP Client para evadir WAFs (JA3/JA4 Fingerprinting)
const stealthClient = new ImpitHttpClient({
  browser: Browser.Chrome,
  http3: false,
  ignoreTlsErrors: true
});

const deliveryPlanner = new DeliveryPlanner();
const resolutionCoordinator = new ResolutionCoordinator(
  (url) => EmbedResolvers.resolveWithMeta(url),
  { maxEntries: 128 },
);

// Stable browser-facing HLS sessions. Renewal uses the lightweight, single-flight
// HTTP/static resolver only; Chromium is intentionally absent from production.
const playbackSessions = new PlaybackSessionStore({
  resolver: (url) => resolutionCoordinator.resolve(url),
  // A 2-hour VOD has ~800 ten-second segments per quality. The class default
  // (300) evicts the first segment ids while rewriting the level playlist,
  // producing browser-visible 404s. Keep enough opaque locators for one active
  // user while bounding abandoned sessions for the low-memory ASUS host.
  maxSessions: 8,
  maxResourcesPerSession: 2_000,
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
      type: (/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(url) ? "direct" : "embed") as "direct" | "embed",
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
    const isLanding = isCanonicalLocator(candidate.url) || classifySourceKind(candidate.url) === "canonical_page";
    if (isLanding) {
      const landingCount = perSiteLandingCount.get(s) || 0;
      if (landingCount >= 1) continue;
      perSiteLandingCount.set(s, landingCount + 1);
    }
    const count = perSiteCount.get(s) || 0;
    if (count >= maxPerSite) {
      continue;
    }
    const identities = identitiesBySite.get(s) || new Set<string>();
    const identity = streamCandidateIdentity(candidate.canonical_locator || candidate.url);
    if (identities.has(identity)) continue;
    identities.add(identity);
    identitiesBySite.set(s, identities);
    perSiteCount.set(s, count + 1);
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
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
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
        select: { url: true, source_site: true },
        orderBy: [{ priority_tier: "asc" }, { last_checked: "desc" }],
      });
      for (const link of sourceLinks) {
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
  const where: Array<Record<string, unknown>> = [];
  if (targetShow.tmdb_id != null) where.push({ tmdb_id: targetShow.tmdb_id });
  if (normalized) where.push({ normalized_title: normalized });
  if (baseNormalized) where.push({ base_normalized_title: baseNormalized });
  if (where.length === 0) return null;
  // TMDB comparte el espacio numérico entre películas y TV. El puente legacy
  // conserva el namespace para no devolver accidentalmente una obra de otro
  // tipo cuando ambos comparten el mismo entero.
  const category = String(targetShow.category || "").toLowerCase();
  const kindFilter = category === "movie"
    ? { kind: "movie" }
    : category === "anime" || category === "series"
      ? { kind: { in: ["anime", "series"] } }
      : {};

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
      links: episode.links.map((link) => ({ url: link.url, link_type: link.link_type })),
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
    const rankedRaw = await buildMultiSourceCascade(selectedEpisode.links, { maxPerSite: 2, maxTotal: 8 });
    const ranked = keepCanonicalCandidatesFirst(rankedRaw, selectedEpisode.links);
    return ranked.length > 0 ? { mediaEpisode: selectedEpisode, ranked } : null;
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

export async function handlePlayEpisode(req: Request, res: Response) {
  const targetId = req.params.episode_id;
  const _playResolveStart = Date.now();
  let foundEpisode: any = null;
  let targetShow: any = null;

  try {
    // 1. Intentar resolver por esquema Multi-fuente v2 (MediaEpisode + SourceLink)
    const mediaEpisode = await prisma.mediaEpisode.findUnique({
      where: { id: targetId },
      include: { media_item: true, links: true },
    });

    if (mediaEpisode && mediaEpisode.links?.length > 0) {
      const title = `${mediaEpisode.media_item?.title || "Reproducción"} - Episodio ${mediaEpisode.episode_number}`;

      const cached = playStreamsCache.get(mediaEpisode.id);
      if (cached && cached.expiresAt > Date.now()) {
        return res.json({
          episode_id: mediaEpisode.id,
          stream_url: cached.streamUrl,
          title,
          all_available_streams: cached.allStreams,
          ranked_streams: cached.ranked,
        });
      }

      // Filtrar links que pertenecen a otra temporada o episodio
      const validLinks = mediaEpisode.links.filter((l: any) => {
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

      const linksToUse = validLinks.length > 0 ? validLinks : mediaEpisode.links;
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

      const allMergedStreams = ranked.map((entry) => entry.url);
      const streamUrl = ranked[0]?.url || "";

      playStreamsCache.set(mediaEpisode.id, {
        streamUrl,
        allStreams: allMergedStreams,
        ranked,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      return res.json({
        episode_id: mediaEpisode.id,
        stream_url: streamUrl,
        title,
        all_available_streams: allMergedStreams,
        ranked_streams: ranked,
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
      const allCanonicalStreams = canonicalBridge.ranked.map((entry) => entry.url);
      return res.json({
        episode_id: foundEpisode?.id || targetShow?.id || targetId,
        stream_url: canonicalBridge.ranked[0]?.url || "",
        title,
        all_available_streams: allCanonicalStreams,
        ranked_streams: canonicalBridge.ranked,
        media_episode_id: canonicalBridge.mediaEpisode.id,
      });
    }

    const sourceUrl = foundEpisode?.source_url || (targetShow as any)?.source_url || (targetShow as any)?.url || "";
    if (!sourceUrl && !foundEpisode) {
      return res.status(404).json({ detail: "Episodio u obra no encontrada en la base de datos." });
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
    const allMergedStreams = Array.from(
      new Set([
        ...ranked.map((r) => r.url),
      ].filter(Boolean))
    );

    const streamUrl =
      ranked.find((r) => r.url === extracted.stream_url)?.url ||
      ranked[0]?.url ||
      sourceUrl;

    res.json({
      episode_id: foundEpisode?.id || targetShow?.id || targetId,
      stream_url: streamUrl,
      title,
      all_available_streams: allMergedStreams.length > 0 ? allMergedStreams : [sourceUrl],
      ranked_streams: ranked,
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

async function startServer() {
  const app = express();
  const PORT = APP_CONFIG.port;

  app.set("trust proxy", true);

  app.use((req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      if (req.headers["x-forwarded-proto"] === "http") {
        return res.redirect(301, `https://${req.headers.host}${req.url}`);
      }
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
      res.setHeader("Content-Security-Policy", "upgrade-insecure-requests");
    }
    next();
  });

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : localAllowedOrigins();

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
          callback(null, true);
        } else {
          callback(null, false);
        }
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'X-Media-Title', 'X-Media-Provider', 'Accept', 'Origin', 'X-Requested-With'],
      exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
    })
  );
  app.use(express.json({
    limit: "10mb",
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Protege el plano de control sin interceptar reproducción, catálogo público
  // ni las resoluciones Just-In-Time que necesita el reproductor.
  app.use("/api/v1", requireAdminForControlPlane);

  // ==========================================
  // API Routes
  // ==========================================

  // Health
  app.get(["/health", "/api/v1/health"], (req: Request, res: Response) => {
    res.json({ status: "ok", service: "VoidStream Core API (PostgreSQL Enabled)" });
  });

  const handleDeployWebhook = async (req: Request, res: Response) => {
    const rawSecret = (req.headers["x-webhook-secret"] || req.query.secret || "") as string;
    const hubSignature = (req.headers["x-hub-signature-256"] || "") as string;
    const configuredSecret = process.env.DEPLOY_WEBHOOK_SECRET || "uziel20082";

    let isValid = false;

    // 1. Coincidencia directa de token
    if (rawSecret && rawSecret === configuredSecret) {
      isValid = true;
    }

    // 2. Verificación de firma HMAC SHA-256 de GitHub
    if (hubSignature && hubSignature.startsWith("sha256=")) {
      try {
        const crypto = await import("crypto");
        const rawBuf = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}));
        const expected = "sha256=" + crypto.createHmac("sha256", configuredSecret).update(rawBuf).digest("hex");
        if (crypto.timingSafeEqual(Buffer.from(hubSignature), Buffer.from(expected))) {
          isValid = true;
        }
      } catch (err) {
        console.warn("[DeployWebhook] Error verificando firma HMAC:", err);
      }
    }

    if (!isValid) {
      return res.status(403).json({ error: "Unauthorized webhook signature or secret" });
    }

    const ref = req.body?.ref;
    if (ref && ref !== "refs/heads/main") {
      return res.json({ skipped: true, message: `Ignored push to branch ${ref}` });
    }

    res.status(200).json({ ok: true, message: "Despliegue automático iniciado en el servidor." });

    import("child_process").then(({ exec }) => {
      exec("/bin/sh /opt/meristream/update_server.sh", { timeout: 900000 }, (err, stdout, stderr) => {
        if (err) console.error("[DeployWebhook] Error al actualizar:", err, stderr);
        else console.log("[DeployWebhook] Despliegue completado:", stdout);
      });
    });
  };

  app.post("/api/v1/webhook/github", handleDeployWebhook);
  app.post("/api/v1/webhook/deploy", handleDeployWebhook);

  // Consultar logs del último despliegue
  app.get("/api/v1/webhook/deploy/status", async (req: Request, res: Response) => {
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile("/var/log/meristream_deploy.log", "utf-8").catch(() => "Sin logs de despliegue aún.");
      const lines = content.split("\n").slice(-60).join("\n");
      res.type("text/plain").send(lines);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Genres cache (TTL 5 minutes)
  let cachedGenres: any = null;
  let genresCacheExpiry = 0;
  const GENRES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // GET /api/v1/genres - Fetch all distinct genres across anime, movies, and series APIs
  app.get("/api/v1/genres", async (req: Request, res: Response) => {
    try {
      // Return cached if valid
      if (cachedGenres && Date.now() < genresCacheExpiry) {
        return res.json(cachedGenres);
      }

      const allGenres = new Set<string>();

      // 1. Gather all local genres from PostgreSQL catalog
      const localShows = await prisma.show.findMany({ select: { genres: true } });
      for (const show of localShows) {
        if (show.genres) {
          show.genres.split(",").forEach((g) => {
            const trimmed = g.trim();
            if (trimmed) allGenres.add(trimmed);
          });
        }
      }

      // 2. Comprehensive base genre catalog
      const baseGenres = [
        "AcciÃ³n",
        "AnimaciÃ³n",
        "Aventura",
        "Ciencia FicciÃ³n",
        "Comedia",
        "Crimen",
        "Drama",
        "FantasÃ­a",
        "HistÃ³rico",
        "Misterio",
        "PsicolÃ³gico",
        "Romance",
        "Seinen",
        "Shounen",
        "Sobrenatural",
        "Suspenso",
        "Terror",
        "Thriller",
        "Isekai",
        "Cyberpunk",
        "Mecha",
        "Slice of Life"
      ];
      baseGenres.forEach((g) => allGenres.add(g));

      // 3. Dynamic genre fetch from Jikan Anime API
      try {
        const jikanController = new AbortController();
        const jTimer = setTimeout(() => jikanController.abort(), 2500);
        const jikanRes = await fetch("https://api.jikan.moe/v4/genres/anime", {
          signal: jikanController.signal,
          headers: { "User-Agent": "VoidStream-Universal-Scraper/2.5" }
        });
        clearTimeout(jTimer);
        if (jikanRes.ok) {
          const jData: any = await jikanRes.json();
          if (Array.isArray(jData?.data)) {
            jData.data.slice(0, 40).forEach((item: any) => {
              if (item?.name) {
                const name = item.name.trim();
                if (name.toLowerCase() === "horror") allGenres.add("Terror");
                else if (name.toLowerCase() === "action") allGenres.add("AcciÃ³n");
                else if (name.toLowerCase() === "adventure") allGenres.add("Aventura");
                else if (name.toLowerCase() === "fantasy") allGenres.add("FantasÃ­a");
                else if (name.toLowerCase() === "sci-fi") allGenres.add("Ciencia FicciÃ³n");
                else if (name.toLowerCase() === "mystery") allGenres.add("Misterio");
                else if (name.toLowerCase() === "suspense") allGenres.add("Suspenso");
                else if (name.toLowerCase() === "supernatural") allGenres.add("Sobrenatural");
                else allGenres.add(name);
              }
            });
          }
        }
      } catch {}

      const sorted = Array.from(allGenres).sort((a, b) => a.localeCompare(b, "es"));
      const result = {
        status: "ok",
        total: sorted.length,
        genres: sorted,
      };

      // Cache the result
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
      const isLite = req.query.lite === "true";
      const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      if (isLite) {
        const result = await getShowsFromDbLite(search, category, page, limit);
        // Cache for 5 minutes, allow stale while revalidating
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
        res.setHeader('X-Catalog-Count', String(result.total || 0));
        res.json(result);
      } else {
        const showsList = await getShowsFromDb(search, category);
        res.json(showsList);
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
      // media_item_id espejo (relaciÃ³n por clave canÃ³nica, sin FK): lo consume el
      // editor del catÃ¡logo para play-multi / "plataformas disponibles".
      let media_item_id: string | null = null;
      const kind = (show as any).category || "anime";
      const norm = (show as any).normalized_title;
      const base = (show as any).base_normalized_title || norm;
      if (norm) {
        const item = await prisma.mediaItem.findFirst({
          where: {
            OR: [
              { base_normalized_title: base, kind },
              ...(base !== norm ? [{ normalized_title: norm, kind }] : []),
            ],
          },
          orderBy: { created_at: "asc" },
        });
        media_item_id = item?.id ?? null;
      }
      // Plataformas REALES donde vive la obra: dominio de los source_url de
      // cada episodio (lamovie.org → lamovie). Cubre obras sin MediaItem.
      const eps = await prisma.episode.findMany({
        where: { show_id: showId },
        select: { source_url: true },
      });
      const platCounts = new Map<string, number>();
      // CDN/known-platform hostname normalization map
      const CDN_PATTERNS = [
        [/acek-cdn\.com$/i, null],
        [/dramiyos-cdn\.com$/i, null],
        [/turboviplay\.com$/i, null],
      ];
      const KNOWN_PLATFORM_HOSTS: Record<string, string> = {
        animeflv: "animeflv", jkanime: "animeflv",
        tioanime: "tioanime", "v.tioanime": "tioanime",
        lamovie: "lamovie",
        cinecalidad: "cinecalidad",
        latanime: "latanime",
        tioplus: "tioplus",
        veranimes: "veranimes",
        tubepelis: "tubepelis",
      };
      for (const e of eps) {
        try {
          const rawHost = new URL(e.source_url).hostname.replace(/^www\./, "");
          const firstLabel = rawHost.split(".")[0].toLowerCase();
          // Detect CDN hosts: map to null (skip) or known platform
          const isCdn = CDN_PATTERNS.some(([pat]) => pat.test(rawHost));
          let platform: string;
          if (isCdn) {
            // CDN links don't represent a real platform — skip from display
            continue;
          } else if (KNOWN_PLATFORM_HOSTS[firstLabel]) {
            platform = KNOWN_PLATFORM_HOSTS[firstLabel];
          } else {
            platform = firstLabel;
          }
          if (!platform) continue;
          platCounts.set(platform, (platCounts.get(platform) || 0) + 1);
        } catch {
          /* source_url vacío o inválido */
        }
      }
      const episode_platforms = Array.from(platCounts.entries())
        .map(([domain, episodes]) => ({ domain, episodes }))
        .sort((a, b) => b.episodes - a.episodes);
      res.json({ ...(show as any), media_item_id, episode_platforms });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
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

  // POST /api/v1/shows/:show_id/force-metadata - Fuerza metadatos de TMDB con un título específico
  app.post("/api/v1/shows/:show_id/force-metadata", async (req: Request, res: Response) => {
    try {
      const showId = req.params.show_id;
      const { query } = req.body;
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Se requiere un 'query' de tipo string" });
      }

      const updated = await forceShowMetadata(showId, query);
      res.json({ ok: true, updated_show: updated });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "Error al forzar metadatos" });
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
      return res.status(503).json({ error: "backend_busy", fallback: "embed" });
    }
    try {
      const cached = resolutionId
        ? resolutionCoordinator.getByResolutionId(resolutionId, originalUrl)
        : undefined;
      const meta = cached ?? await resolutionCoordinator.resolve(originalUrl);
      // Proxyable and renewable are different properties. A current signed URL
      // may be relayed until its own deadline even when no stable locator exists
      // to renew it later.
      if (!meta.resolved || !meta.url || meta.is_proxyable === false) {
        return res.status(422).json({
          error: "stream_not_proxyable",
          fallback: "embed",
          failure_reason: meta.failure_reason || "unresolved",
        });
      }
      const session = playbackSessions.createFromResolved(originalUrl, meta);
      return res.status(201).json({
        session_id: session.id,
        playback_url: `/api/v1/playback/${encodeURIComponent(session.id)}/master.m3u8`,
        expires_at: session.current.expires_at,
        refresh_after: session.current.refresh_after,
        generation: session.current.generation,
        is_proxyable: session.current.is_proxyable ?? true,
        is_refreshable: session.current.is_refreshable ?? Boolean(session.current.canonical_locator),
      });
    } catch (error) {
      console.warn("[PlaybackSession] No se pudo crear sesión ligera:", error instanceof Error ? error.message : error);
      return res.status(502).json({ error: "session_resolution_failed", fallback: "embed" });
    } finally {
      resolutionLease.release();
    }
  });

  app.get("/api/v1/playback/:sessionId/master.m3u8", playbackSessionHandlers.masterManifest);
  app.get("/api/v1/playback/:sessionId/resource/:resourceId", playbackSessionHandlers.resource);

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
      return res.status(503).json({ error: "backend_busy", fallback: "embed" });
    }

    try {
      // Si la URL es una página web de episodio (animeflv, jkanime, etc.), extraer streams reales primero
      if (classifySourceKind(rawUrl) === "page" || isCanonicalLocator(rawUrl)) {
        try {
          const extracted = await extractStreamFromUrl(rawUrl);
          const candidates = Array.from(
            new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
          );
          for (const cand of candidates) {
            const resolvedMeta = await resolutionCoordinator.resolve(cand);
            if (resolvedMeta.resolved && resolvedMeta.type === "direct") {
              return res.json(buildResolveDeliveryResponse(resolvedMeta, "regex_fast", deliveryPlanner));
            }
          }
        } catch {}
      }

      // Capa ligera: fetch HTTP + extractores específicos, sin navegador headless.
      const meta = await resolutionCoordinator.resolve(rawUrl);
      if (meta.resolved) {
        return res.json(buildResolveDeliveryResponse(meta, "regex_fast", deliveryPlanner));
      }

      // Fallback barato: el navegador abre el embed o avanza al siguiente host.
      return res.json(buildResolveDeliveryResponse(
        { ...meta, url: meta.url || rawUrl },
        "unresolved_embed",
        deliveryPlanner,
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
      const isGoodstream = activeProfile.client === "undici";
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
            if (isGoodstream) {
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
            } else {
              try {
                const response = await stealthClient.sendRequest({
                  url: targetUrl,
                  method: 'GET',
                  headers: reqHeaders,
                  responseType: 'buffer'
                } as any);
                upstreamStatus = response.statusCode ?? 0;
                responseHeaders = response.headers || {};
                rawBody = response.body;
              } catch (stealthErr: any) {
                // Fallback resiliente a undici si impit falla con Remote protocol error
                console.warn(`[proxy/stream] stealthClient falló (${stealthErr.message}), intentando con undici...`);
                const fallbackUpstream = await request(targetUrl, {
                  method: 'GET',
                  headers: reqHeaders,
                  headersTimeout: 15000,
                  bodyTimeout: 30000,
                  ...profileConnectOpts,
                });
                upstreamStatus = fallbackUpstream.statusCode;
                responseHeaders = fallbackUpstream.headers;
                const chunks: Buffer[] = [];
                for await (const ch of fallbackUpstream.body) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
                rawBody = Buffer.concat(chunks);
              }
            }
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
        const isManifest = lowerTargetUrl.includes('.m3u8') || contentType.includes('mpegurl');

        // â”€â”€ UPSTREAM ERROR PROPAGATION â”€â”€
        if (upstreamStatus < 200 || upstreamStatus >= 400) {
          console.warn(`[proxy/stream] upstream ${upstreamStatus} for ${targetUrl.slice(0, 120)}`);
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, error: `HTTP ${upstreamStatus}`, referer, client: isGoodstream ? "undici" : "stealth" });
          res.status(upstreamStatus);
          if (getHeader('content-type')) res.setHeader('Content-Type', getHeader('content-type'));
          if (bodyBuffer.length > 0) res.setHeader('Content-Length', bodyBuffer.length);
          return res.end(bodyBuffer);
        }

        res.status(upstreamStatus);
        res.setHeader('Content-Type', contentType || (isManifest ? 'application/vnd.apple.mpegurl' : 'application/octet-stream'));

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
          logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: isGoodstream ? "undici" : "stealth" });
          return res.end(bodyBuffer);
        }

        // â”€â”€ M3U8 MANIFEST REWRITE â”€â”€
        const text = bodyBuffer.toString('utf8');
        const baseUrl = new URL(targetUrl);
        const proxyUri = (uri: string) => {
          const absoluteUri = /^https?:\/\//i.test(uri) ? uri : new URL(uri, baseUrl).toString();
          const titleParam = mediaTitle ? `&title=${encodeURIComponent(mediaTitle)}` : '';
          const provParam = explicitProvider ? `&provider=${encodeURIComponent(explicitProvider)}` : '';
          return `/api/v1/proxy/stream?referer=${encodeURIComponent(referer)}&url=${encodeURIComponent(absoluteUri)}${titleParam}${provParam}`;
        };
        const rewritten = text.split(/\r?\n/).map((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) return proxyUri(trimmed);
          return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyUri(uri)}"`);
        }).join('\n');

        const rewrittenBuffer = Buffer.from(rewritten, 'utf8');
        res.setHeader('Content-Length', rewrittenBuffer.length);
        logProxyRequest({ targetUrl, upstreamStatus, durationMs: Date.now() - _proxyStartMs, bytesReceived: bodyBuffer.length, mediaTitle, provider: explicitProvider, referer, client: isGoodstream ? "undici" : "stealth" });
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
          throw new Error(`Demasiadas redirecciones (> ${MAX_PROXY_REDIRECTS}) desde ${targetUrl.slice(0, 120)}`);
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
            `[proxy/stream] size mismatch para ${targetUrl.slice(0, 120)}: cache=${cachedEntry.size} upstream=${totalFileSize} â†’ 416`
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
      console.error(`[proxy/stream] Error para ${targetUrl?.slice(0, 100)}:`, e.message);
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

      const upstream = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      });
      clearTimeout(timeout);

      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `upstream ${upstream.status}` });
      }

      const contentType = upstream.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");

      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Length", buffer.length);
      res.end(buffer);
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
            !/\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u)
          );
        } catch {
          return false;
        }
      };

      // Una fuente directa con extensiÃ³n de media es resoluble aunque coincida con la URL
      // pedida (caso archive.org/details â†’ .mp4 directo): el player nativo sÃ­ la reproduce.
      const isDirectMedia = (u: string) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u) || u.includes(".m3u8") || u.includes("/m3u8/");

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
      if (/hianimes\.se\/watch\/|megaplay\.buzz\/stream\//i.test(url)) {
        try {
          const meta = await EmbedResolvers.resolveWithMeta(url);
          if (meta.resolved && meta.url) hianimesMeta = meta;
        } catch {}
      }

      const rankedBase = rankStreams(candidatesToRank, getServerPriorities(siteFromDomain(hostOfStreamUrl(url))));

      // Intentar desofuscar de inmediato los mejores embeds a stream nativo directo (.m3u8/.mp4)
      const upgradedMap = new Map<string, { url: string; requiredHeaders?: Record<string, string>; subtitles?: any[] }>();
      for (const cand of rankedBase.slice(0, 3)) {
        if (!isDirectMedia(cand.url)) {
          try {
            const subMeta = await Promise.race([
              EmbedResolvers.resolveWithMeta(cand.url),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout (3s)")), 3000)),
            ]);
            if (subMeta.resolved && subMeta.url && (subMeta.type === "direct" || isDirectMedia(subMeta.url))) {
              let directUrl = subMeta.url;
              // CDNs con validación de IP de origen o bloqueo de CORS en navegador (ej. okcdn.ru):
              // deben servirse a través del proxy para reescribir segmentos y evitar CORS/400.
              if (directUrl.includes("okcdn.ru") || cand.url.includes("ok.ru")) {
                directUrl = `/api/v1/proxy/stream?referer=https%3A%2F%2Fok.ru%2F&url=${encodeURIComponent(subMeta.url)}`;
              }
              upgradedMap.set(cand.url, {
                url: directUrl,
                requiredHeaders: subMeta.requiredHeaders,
                subtitles: subMeta.subtitles,
              });
            }
          } catch {}
        }
      }

      const rankedStreams = rankedBase.map((r) => {
        const upgraded = upgradedMap.get(r.url);
        return {
          ...r,
          ...(upgraded
            ? {
                url: upgraded.url,
                type: "direct" as const,
                original_url: r.url,
                canonical_locator: r.url,
                tier: 1,
                requiredHeaders: upgraded.requiredHeaders,
                subtitles: upgraded.subtitles,
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

      const primaryCandidate = rankedStreams.find((r) => r.type === "direct" || isDirectMedia(r.url)) || rankedStreams[0];
      const finalStreamUrl = primaryCandidate?.url || extracted.stream_url;
      const isResolved = rankedStreams.length > 0 && !isSourcePage(finalStreamUrl);

      res.json({
        url,
        stream_url: finalStreamUrl,
        all_available_streams: all,
        title: extracted.title,
        resolved: isResolved,
        requiredHeaders: primaryCandidate?.requiredHeaders || hianimesMeta?.requiredHeaders,
        ranked_streams: rankedStreams,
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
      const links = await prisma.sourceLink.findMany({
        where: { media_episode: { media_item_id: mediaItemId, season_number: season } },
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
    if (body.mode !== undefined && body.mode !== "metadata" && body.mode !== "full") {
      return res.status(400).json({ ok: false, detail: "mode must be 'metadata' or 'full'" });
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
      playerHealth: getProviderHealthStats(),
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
    const isDirect = Boolean(EmbedResolvers.isDirectMediaUrl(primaryUrl) || primaryProbe?.is_m3u8 || primaryProbe?.is_mp4);
    const isIframe = !isDirect && (playData?.delivery_mode === "embed" || Boolean(primaryProbe?.is_html));
    const playerEngine = isDirect
      ? (primaryUrl.includes(".m3u8") || primaryProbe?.is_m3u8 ? "hls.js (Reproductor Nativo HLS)" : "HTML5 Video (<video src=mp4>)")
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
  // Auth, Progress & Recommendations Routers
  // ==========================================
  app.use("/api/auth", authRouter);
  app.use("/api/progress", progressRouter);
  app.use("/api/recommendations", recommendationsRouter);

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
    app.use(express.static(distPath));
    app.use((req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
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
  try {
    await prisma.$queryRawUnsafe("SELECT 1 as alive");
    console.log("[DB] PostgreSQL connection OK");
  } catch (e) {
    console.warn("[DB] PostgreSQL connection failed:", e?.message || e);
  }

  // Drenador del outbox de escrituras diferidas (aplica ops del archivo cuando la BD responde).
  startWriteBufferDrainer();
  // Cargar settings persistidos y activar inmediatamente la cola pendiente.
  // El singleton del worker crea el poller al importar el módulo, pero esta
  // inicialización explícita evita que un arranque con Prisma lento deje los
  // trabajos recién encolados esperando indefinidamente.
  taskWorker.init();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor PostgreSQL ejecutÃ¡ndose en http://0.0.0.0:${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  startServer();
}
