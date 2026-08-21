import dns from "dns/promises";
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { createServer as createViteServer } from "vite";
import { analyzeUniversalUrl, extractStreamFromUrl, PRESET_SOURCES } from "./server/universalScraper";
import { cleanQueryTitle } from "./server/metadataEngine";
import { taskWorker } from "./server/taskWorker";
import {
  saveShowWithDeduplication,
  getShowsFromDb,
  getShowByIdFromDb,
  deleteShowFromDb,
  clearAllShowsFromDb,
} from "./server/showService";
import { prisma } from "./server/db";
import { EmbedResolvers } from "./server/resolvers";
import { playwrightResolver } from "./server/playwrightResolver";

async function startServer() {
  const app = express();
  const PORT = 3000;

  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"];

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

  // GET /api/v1/genres - Fetch all distinct genres across anime, movies, and series APIs
  app.get("/api/v1/genres", async (req: Request, res: Response) => {
    try {
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
        "Acción",
        "Animación",
        "Aventura",
        "Ciencia Ficción",
        "Comedia",
        "Crimen",
        "Drama",
        "Fantasía",
        "Histórico",
        "Misterio",
        "Psicológico",
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
                else if (name.toLowerCase() === "action") allGenres.add("Acción");
                else if (name.toLowerCase() === "adventure") allGenres.add("Aventura");
                else if (name.toLowerCase() === "fantasy") allGenres.add("Fantasía");
                else if (name.toLowerCase() === "sci-fi") allGenres.add("Ciencia Ficción");
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
      res.json({
        status: "ok",
        total: sorted.length,
        genres: sorted,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/shows - Fetch shows from PostgreSQL
  app.get("/api/v1/shows", async (req: Request, res: Response) => {
    try {
      const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
      const category = typeof req.query.category === "string" ? req.query.category.trim() : undefined;

      const showsList = await getShowsFromDb(search, category);
      res.json(showsList);
    } catch (e: any) {
      res.status(500).json({ error: `Error leyendo catálogo: ${e.message}` });
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
      res.json(show);
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

  // GET /api/v1/play/:episode_id - Just-In-Time Live Stream Resolver
  app.get("/api/v1/play/:episode_id", async (req: Request, res: Response) => {
    const targetId = req.params.episode_id;

    try {
      let foundEpisode = await prisma.episode.findUnique({
        where: { id: targetId },
        include: { show: true },
      });

      let targetShow = foundEpisode?.show || null;

      // Si no es ID de episodio, buscar si es el ID de una película u obra (Show)
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
        : targetShow?.title || extracted.title || "Reproducción";

      res.json({
        episode_id: foundEpisode?.id || targetShow?.id || targetId,
        stream_url: extracted.stream_url || allStreams[0] || sourceUrl,
        title,
        all_available_streams: allStreams.length > 0 ? allStreams : [sourceUrl],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v1/resolve-embed - Resolución híbrida (Regex rápido -> Playwright Fallback con caché)
  app.post(["/api/v1/resolve-embed", "/api/resolve-embed"], async (req: Request, res: Response) => {
    const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!rawUrl) {
      return res.status(400).json({ error: "URL requerida" });
    }

    try {
      // 1. Capa Rápida: EmbedResolvers (Regex & Desempaquetador JS)
      const meta = await EmbedResolvers.resolveWithMeta(rawUrl);
      if (meta.resolved) {
        return res.json({
          url: meta.url,
          original_url: rawUrl,
          resolved: true,
          type: "direct",
          provider: meta.provider,
          strategy: "regex_fast",
        });
      }

      // 2. Capa Avanzada: Playwright Headless Sniffer (Solo para embeds difíciles como VOE, Filemoon, etc.)
      const playwrightUrl = await playwrightResolver.resolve(rawUrl);
      if (playwrightUrl && EmbedResolvers.isDirectMediaUrl(playwrightUrl)) {
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
          { id: "sub-es", label: "Español", language: "es", src: "", is_default: true },
          { id: "sub-en", label: "English", language: "en", src: "", is_default: false },
        ],
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v1/proxy/stream - Anti-CORS Proxy
  app.get("/api/v1/proxy/stream", async (req: Request, res: Response) => {
    const targetUrl = typeof req.query.url === "string" ? req.query.url : "";
    const referer = typeof req.query.referer === "string" ? req.query.referer : "https://animeflv.net/";

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
      // While this technically allows a narrow TOCTOU (DNS Rebinding) window,
      // preventing DNS rebinding in Node fetch without breaking TLS requires custom Agents
      // which is out of scope for a basic < 20 loc fix.
      const response = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Referer: referer,
        },
      });

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      const contentType = response.headers.get("content-type") || "application/vnd.apple.mpegurl";
      res.setHeader("Content-Type", contentType);

      if (!response.body) {
        return res.end();
      }

      // @ts-ignore
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      };
      await pump();
    } catch (e: any) {
      res.status(500).json({ error: `Error en proxy: ${e.message}` });
    }
  });

  // Scraper Presets Endpoint
  app.get("/api/v1/scraper/presets", (req: Request, res: Response) => {
    res.json(PRESET_SOURCES);
  });

  // POST /api/v1/catalog/analyze - Universal Scraper & Metadata Enricher
  app.post("/api/v1/catalog/analyze", async (req: Request, res: Response) => {
    const url = req.body?.url;
    if (!url) {
      return res.status(400).json({ detail: "La URL o término de búsqueda es requerido." });
    }

    try {
      const analysis = await analyzeUniversalUrl(url);
      res.json(analysis);
    } catch (e: any) {
      res.status(500).json({ detail: `Error analizando: ${e.message}` });
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
          message: `'${result.show.title}' ya existía en PostgreSQL. Se fusionaron ${result.episodesAdded} episodio(s) nuevos sin duplicar la serie.`,
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
      return res.status(400).json({ detail: "Se requiere un array de URLs o títulos ('urls')" });
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
  app.get("/api/v1/worker/jobs", async (req: Request, res: Response) => {
    const jobs = await taskWorker.getAllJobs();
    res.json(jobs);
  });

  // GET /api/v1/worker/settings - Get rate limit and anti-blocking configs
  app.get("/api/v1/worker/settings", (req: Request, res: Response) => {
    res.json(taskWorker.getSettings());
  });

  // POST /api/v1/worker/settings - Update worker settings
  app.post("/api/v1/worker/settings", async (req: Request, res: Response) => {
    const newSettings = req.body || {};
    await taskWorker.updateSettings(newSettings);
    res.json({ status: "ok", settings: taskWorker.getSettings() });
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

  // DELETE /api/v1/worker/jobs/:job_id
  app.delete("/api/v1/worker/jobs/:job_id", async (req: Request, res: Response) => {
    const success = await taskWorker.deleteJob(req.params.job_id);
    if (!success) return res.status(404).json({ detail: "Tarea no encontrada" });
    res.json({ status: "ok", message: "Tarea eliminada" });
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
      return res.status(400).json({ detail: "URL requerida para extracción" });
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
        title: extracted.title || analysis?.title || "Stream Extraído",
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VoidStream] Servidor PostgreSQL ejecutándose en http://0.0.0.0:${PORT}`);
  });
}

startServer();
