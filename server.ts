import dns from "dns/promises";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { createServer as createViteServer } from "vite";
import {
  analyzeUniversalUrl,
  extractStreamFromUrl,
  PRESET_SOURCES,
  getActivePresets,
  saveCustomPresetOverride,
  resetCustomPresetOverride,
} from "./server/universalScraper";
import { cleanQueryTitle } from "./server/metadataEngine";
import { taskWorker } from "./server/taskWorker";
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
import { prisma } from "./server/db";
import { EmbedResolvers, isValidProvider } from "./server/resolvers";
import { getStreamTier, sortStreamsByPriority, isBlacklistedHost, hostOfStreamUrl, familyKeyOfStreamUrl } from "./server/utils/streamSorter";
import { getServerPriorities, setServerOrder, moveServerPriority, hostOfUrl } from "./server/serverPriorities";
import { getSiteRating, getAllSiteRatings, upsertSiteRating } from "./server/siteRatingService";
import { siteFromDomain } from "./server/siteRatingService";
import { playwrightResolver } from "./server/playwrightResolver";
import { ImpitHttpClient, Browser } from "@crawlee/impit-client";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { buildProxyHeaders } from "./server/hostProfiles";
import { APP_CONFIG, localAllowedOrigins } from "./app.config";
import { backfillMissingMetadata, getBackfillStatus } from "./server/metadataBackfill";
import { reconcileSequelsByTmdb, mergeTwoShows } from "./server/reconcileCatalog";
import { startWriteBufferDrainer, drainWriteBuffer } from "./server/writeBuffer";
import { getVerificationStatus, updateVerificationConfig, runVerification } from "./server/verificationWorker";
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
import {
  getWatchdogStatus,
  getWatchdogConfig,
  updateWatchdogConfig,
  runWatchdogNow,
  getWatchdogReports,
  checkWatchdogAlert,
  clearWatchdogAlert,
} from "./server/watchdog";

// Stealth HTTP Client para evadir WAFs (JA3/JA4 Fingerprinting)
const stealthClient = new ImpitHttpClient({
  browser: Browser.Chrome,
  http3: false,
  ignoreTlsErrors: true
});

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
 * Cascada multi-fuente (F4): agrupa SourceLinks por sitio de origen, ordena los
 * sitios por SiteRating DESC y dentro de cada sitio por tier ASC. El frontend
 * recorre esta lista plana como cadena de fallback automÃ¡tica.
 */
async function buildMultiSourceCascade(sourceLinks: Array<{ url: string; source_site: string }>) {
  const siteByUrl = new Map<string, string>();
  for (const link of sourceLinks) siteByUrl.set(link.url, link.source_site);

  // Prioridades de servidor definidas por el usuario (probador por plataforma):
  // se combinan las de TODAS las plataformas involucradas en la cascada.
  const sites0 = Array.from(new Set(sourceLinks.map((s) => s.source_site).filter(Boolean) as string[]));
  const hostPriority: Record<string, number> = {};
  for (const s of sites0) Object.assign(hostPriority, getServerPriorities(s));

  const ranked = rankStreams(sourceLinks.map((s) => s.url), hostPriority);

  const sites = Array.from(new Set(ranked.map((r) => siteByUrl.get(r.url)).filter(Boolean) as string[]));
  const ratings = await Promise.all(sites.map(async (site) => ({ site, rating: await getSiteRating(siteFromDomain(site)) })));
  const ratingBySite = new Map(ratings.map((r) => [r.site, r.rating]));

  return ranked
    .map((entry) => {
      const site = siteFromDomain(siteByUrl.get(entry.url) || "");
      return { ...entry, source_site: site || "unknown", rating: ratingBySite.get(site) ?? 5 };
    })
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
}

async function startServer() {
  const app = express();
  const PORT = APP_CONFIG.port;

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
  app.use(express.json({ limit: "10mb" }));

  // ==========================================
  // API Routes
  // ==========================================

  // Health
  app.get(["/health", "/api/v1/health"], (req: Request, res: Response) => {
    res.json({ status: "ok", service: "VoidStream Core API (PostgreSQL Enabled)" });
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
      // Buscar otros episodios de la misma obra (por título) en diferentes plataformas
      const sameTitleEpisodes = await prisma.episode.findMany({
        where: {
          show: { title: primaryShow.title },
          id: { not: primaryEpisode.id },
          source_url: { not: "" },
        },
        include: { show: true },
        take: 30,
      });

      // Agrupar por dominio (plataforma), quedarse con el más cercano al episodio actual
      const epNum = primaryEpisode.number ?? 1;
      const platformMap = new Map<string, typeof sameTitleEpisodes[0]>();
      for (const ep of sameTitleEpisodes) {
        const domain = siteFromDomain(hostOfStreamUrl(ep.source_url || ""));
        if (!domain || domain === primarySite) continue;
        if (!platformMap.has(domain)) {
          platformMap.set(domain, ep);
        } else {
          const existing = platformMap.get(domain)!;
          const existingDist = Math.abs((existing.number ?? 1) - epNum);
          const newDist = Math.abs((ep.number ?? 1) - epNum);
          if (newDist < existingDist) platformMap.set(domain, ep);
        }
      }

      // Tomar solo las plataformas con mejor rating
      const entries = Array.from(platformMap.entries());
      const rated = await Promise.all(
        entries.map(async ([site, ep]) => ({
          site,
          ep,
          rating: await getSiteRating(site),
        }))
      );
      rated.sort((a, b) => b.rating - a.rating);
      const topPlatforms = rated.slice(0, maxExtraPlatforms);

      // Resolver en paralelo con timeout
      const resolutions = await Promise.allSettled(
        topPlatforms.map(async ({ site, ep }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const extracted = await extractStreamFromUrl(ep.source_url);
            clearTimeout(timer);
            const streams = Array.from(
              new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
            );
            const ranked = rankStreams(streams, getServerPriorities(site));
            return { site, ranked };
          } catch {
            clearTimeout(timer);
            return { site, ranked: [] as Array<{ url: string; type: "direct" | "embed"; tier: number; host: string | null }> };
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

  // GET /api/v1/play/:episode_id - Just-In-Time Live Stream Resolver
  app.get("/api/v1/play/:episode_id", async (req: Request, res: Response) => {
    const targetId = req.params.episode_id;
    const _playResolveStart = Date.now();

    try {
      let foundEpisode = await prisma.episode.findUnique({
        where: { id: targetId },
        include: { show: true },
      });

      let targetShow = foundEpisode?.show || null;

      // Si no es ID de episodio, buscar si es el ID de una pelÃ­cula u obra (Show)
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

      const sourceUrl = foundEpisode?.source_url || (targetShow as any)?.source_url || (targetShow as any)?.url || "";
      if (!sourceUrl && !foundEpisode) {
        return res.status(404).json({ detail: "Episodio u obra no encontrada en la base de datos." });
      }

      // Just-in-time extraction: if the source_url is a web page, resolve actual video servers in real time
      const extracted = await extractStreamFromUrl(sourceUrl);
      const allStreams = Array.from(
        new Set([extracted.stream_url, ...(extracted.all_available_streams || [])].filter(Boolean))
      );

      const title = foundEpisode?.title
        ? `${targetShow?.title || ""} - ${foundEpisode.title}`
        : targetShow?.title || extracted.title || "ReproducciÃ³n";

      const durationMs = Date.now() - _playResolveStart;

      if (allStreams.length === 0) {
        logPlayerEvent({
          eventType: "scraper_failed",
          serverUrl: sourceUrl,
          mediaTitle: title,
          episodeTitle: foundEpisode?.title || "",
          durationBeforeErrorMs: durationMs,
          details: `El scraper no encontrÃ³ ningÃºn stream o servidor reproducible para ${sourceUrl}`,
        });
      } else {
        logPlayerEvent({
          eventType: "scraper_resolution",
          serverUrl: sourceUrl,
          mediaTitle: title,
          episodeTitle: foundEpisode?.title || "",
          durationBeforeErrorMs: durationMs,
          details: `Scraper resolviÃ³ ${allStreams.length} servidores en ${durationMs}ms: [${allStreams.map(s => s.slice(0, 35)).join(', ')}]`,
        });
      }

      const platformSite = siteFromDomain(hostOfStreamUrl(sourceUrl));
      const primaryRanked = rankStreams(allStreams, getServerPriorities(platformSite)).map((r) => ({
        ...r,
        source_site: platformSite || undefined,
      }));

      // Resolver streams de OTRAS plataformas en paralelo (máx 3 extra, 8s timeout)
      const crossPlatform = await resolveCrossPlatformStreams(
        foundEpisode,
        targetShow,
        platformSite,
        3,
        8000
      );

      // Merge: plataforma primaria primero, luego las demás ordenadas por rating
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

      const ranked = [...primaryRanked, ...extraRanked];

      const allMergedStreams = Array.from(
        new Set([
          ...allStreams,
          ...extraRanked.map((r) => r.url),
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
  });

  // POST /api/v1/resolve-embed - ResoluciÃ³n hÃ­brida (Regex rÃ¡pido -> Playwright Fallback con cachÃ©)
  app.post(["/api/v1/resolve-embed", "/api/resolve-embed"], async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!rawUrl) {
      return res.status(400).json({ error: "URL requerida" });
    }

    try {
      // 1. Capa RÃ¡pida: EmbedResolvers (Regex & Desempaquetador JS)
      const meta = await EmbedResolvers.resolveWithMeta(rawUrl);
      if (meta.resolved) {
        return res.json({
          url: meta.url,
          original_url: rawUrl,
          resolved: true,
          type: "direct",
          provider: meta.provider,
          requiredHeaders: meta.requiredHeaders,
          strategy: "regex_fast",
        });
      }

      // 2. Capa Avanzada: Playwright Headless Sniffer (Solo para embeds difÃ­ciles como VOE, Filemoon, etc.)
      const playwrightUrl = await playwrightResolver.resolve(rawUrl);
      if (
        playwrightUrl &&
        EmbedResolvers.isDirectMediaUrl(playwrightUrl) &&
        !EmbedResolvers.isPlaceholderUrl(playwrightUrl)
      ) {
        return res.json({
          url: playwrightUrl,
          original_url: rawUrl,
          resolved: true,
          type: "direct",
          provider: meta.provider,
          strategy: "playwright_sniffer",
        });
      }

      // 3. Fallback: Mantener URL original en modo embed
      return res.json({
        url: meta.url || rawUrl,
        original_url: rawUrl,
        resolved: false,
        type: "embed",
        provider: meta.provider,
        requiredHeaders: meta.requiredHeaders,
        strategy: "unresolved_embed",
      });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Error al resolver embed" });
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
        lowerTargetUrl.includes('/m3u8/');  // Zilla Networks: /m3u8/{hash} format

      if (isHlsResource) {
        let upstreamStatus: number;
        let responseHeaders: any;
        let rawBody: any;

        // Goodstream / Ducvomes / Playmudos usan undici directamente.
        // Si usamos stealthClient y da Remote protocol error, hacemos fallback automÃ¡tico a undici.
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
            console.warn(`[proxy/stream] stealthClient fallÃ³ (${stealthErr.message}), intentando con undici...`);
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
      const isDirectMedia = (u: string) => /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u);

      const realStreams = all.filter((u) => (u !== url || isDirectMedia(u)) && !isSourcePage(u));
      res.json({
        url,
        stream_url: extracted.stream_url,
        all_available_streams: all,
        title: extracted.title,
        resolved: realStreams.length > 0,
        ranked_streams: rankStreams(realStreams, getServerPriorities(siteFromDomain(hostOfStreamUrl(url)))).map((r) => ({
          ...r,
          // Plataforma de origen (sitio cuya pÃ¡gina se pidiÃ³) para el selector premium.
          source_site: siteFromDomain(hostOfStreamUrl(url)) || undefined,
        })),
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
        select: { url: true, source_site: true },
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
      const result = await saveShowWithDeduplication(showData);

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
          japanese_title: analysis.japanese_title,
          english_title: analysis.english_title,
          description: analysis.description,
          poster_url: analysis.poster_url,
          banner_url: analysis.banner_url,
          content_type: analysis.content_type,
          rating: analysis.rating,
          year: analysis.year,
          status: analysis.status,
          genres: analysis.genres,
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
      const config = await updateVerificationConfig(req.body || {});
      res.json({ ok: true, config });
    } catch (e: any) {
      res.status(400).json({ ok: false, detail: String(e?.message || e) });
    }
  });

  // POST /api/v1/verification/run { platforms?, limit? } - lanza UNA pasada en background (no bloqueante)
  app.post("/api/v1/verification/run", async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      const result = await runVerification({
        platforms: Array.isArray(body.platforms) ? body.platforms : undefined,
        limit: Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Math.round(Number(body.limit)) : undefined,
      });
      res.json({ ok: true, ...result, status: getVerificationStatus() });
    } catch (e: any) {
      res.status(500).json({ ok: false, detail: String(e?.message || e) });
    }
  });

  // ──── Watchdog Auto-Reparador ────
  app.get("/api/v1/watchdog", (_req: Request, res: Response) => {
    res.json(getWatchdogStatus());
  });

  app.get("/api/v1/watchdog/config", (_req: Request, res: Response) => {
    res.json(getWatchdogConfig());
  });

  app.post("/api/v1/watchdog/config", async (req: Request, res: Response) => {
    try {
      const config = await updateWatchdogConfig(req.body || {});
      res.json({ ok: true, config });
    } catch (e: any) {
      res.status(400).json({ ok: false, detail: String(e?.message || e) });
    }
  });

  app.post("/api/v1/watchdog/run", async (_req: Request, res: Response) => {
    try {
      const result = await runWatchdogNow();
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, detail: String(e?.message || e) });
    }
  });

  app.get("/api/v1/watchdog/reports", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    res.json({ reports: getWatchdogReports(limit) });
  });

  // GET /api/v1/watchdog/alert - Alerta crítica (el asistente revisa esto)
  app.get("/api/v1/watchdog/alert", (_req: Request, res: Response) => {
    const alert = checkWatchdogAlert();
    if (alert) {
      res.json({ active: true, ...alert });
    } else {
      res.json({ active: false, message: "Sin alertas críticas activas." });
    }
  });

  // POST /api/v1/watchdog/alert/clear - Marca alerta como procesada
  app.post("/api/v1/watchdog/alert/clear", (_req: Request, res: Response) => {
    clearWatchdogAlert();
    res.json({ ok: true, message: "Alerta limpiada." });
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
        items_queue: job.items_queue,
        rate_limit_delay_ms: job.rate_limit_delay_ms,
        error_message: job.error_message,
        created_at: job.created_at,
        updated_at: job.updated_at,
        logs: job.logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`),
        detailed_logs: job.logs,
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
          seen.add(u);
          return true;
        })
        .slice(0, 12);

      const priorities = getServerPriorities(platform);
      const origin = `http://127.0.0.1:${APP_CONFIG.port}`;
      const tests = await Promise.all(
        streams.map(async (url: string) => {
          const host = hostOfUrl(url);
          const started = Date.now();
          let status = 0;
          try {
            const r = await fetch(`${origin}/api/v1/proxy/stream?url=${encodeURIComponent(url)}`, {
              headers: { Range: "bytes=0-100", "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(9000),
            });
            status = r.status;
            try { await r.body?.cancel(); } catch {}
          } catch {
            status = 0;
          }
          return {
            url,
            host,
            hostFamily: familyKeyOfStreamUrl(url),
            status,
            ok: status === 200 || status === 206,
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

  // POST /api/v1/admin/login - login minimalista del panel /admin
  app.post("/api/v1/admin/login", async (req: Request, res: Response) => {
    const user = typeof req.body?.user === "string" ? req.body.user : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const ADMIN_USER = process.env.ADMIN_USER || "uziel";
    const ADMIN_PASS = process.env.ADMIN_PASS || "uziel20082";
    if (user === ADMIN_USER && password === ADMIN_PASS) {
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false, detail: "Credenciales incorrectas" });
  });

  // ==========================================
  // Vite Middleware & Static Frontend Serving
  // ==========================================
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, host: "0.0.0.0", port: PORT },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor PostgreSQL ejecutÃ¡ndose en http://0.0.0.0:${PORT}`);
  });
}

startServer();
