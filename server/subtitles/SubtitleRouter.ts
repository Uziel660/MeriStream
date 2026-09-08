import { Router, type Request, type Response } from "express";
import { SubtitleGateway } from "./SubtitleGateway";
import type { SubtitleKind, SubtitleSearchRequest } from "./types";
import { getPublicCatalogDetail } from "../publicCatalog";

function positiveInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseLanguages(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 5) : ["es-419", "es", "en"];
}

function searchRequest(kind: SubtitleKind, tmdbId: number, req: Request): SubtitleSearchRequest {
  return {
    tmdbId,
    kind,
    season: positiveInt(req.query.season),
    episode: positiveInt(req.query.episode),
    imdbId: typeof req.query.imdb_id === "string" ? req.query.imdb_id : undefined,
    preferredLanguages: parseLanguages(req.query.languages),
    title: typeof req.query.title === "string" ? req.query.title : undefined,
    year: positiveInt(req.query.year),
  };
}

export function subtitleRouter(gateway: SubtitleGateway): Router {
  const router = Router();

  const handleSearch = async (req: Request, res: Response, kind: SubtitleKind, tmdbId: number) => {
    if (!tmdbId) return res.status(400).json({ error: "tmdb_id inválido", subtitles: [], tracks: [] });
    try {
      const request = searchRequest(kind, tmdbId, req);
      // Scraper subtitle sites often index the original/English title even
      // when TMDB displays the Spanish localization. Supply all canonical
      // aliases so the fallback provider can match the same work safely.
      if (!request.title || !request.titleAliases?.length) {
        const detail = await getPublicCatalogDetail(kind, tmdbId).catch(() => null);
        if (detail) {
          request.title = request.title || detail.title;
          request.titleAliases = [...new Set([
            ...(request.titleAliases || []),
            detail.original_title,
            detail.english_title,
            detail.japanese_title,
          ].filter((value): value is string => Boolean(value)))];
          request.year = request.year || detail.year || undefined;
        }
      }
      const result = await gateway.search(request);
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.json(result);
    } catch (error: any) {
      return res.status(200).json({ subtitles: [], tracks: [], providers: { queried: [], failed: [{ provider: "gateway", reason: error?.message || "search_failed" }] }, elapsedMs: 0, cached: false });
    }
  };

  router.get("/api/v1/subtitles", async (req: Request, res: Response) => {
    const tmdbId = positiveInt(req.query.tmdb_id || req.query.tmdbId) || 0;
    const rawKind = String(req.query.kind || "movie").toLowerCase();
    const kind: SubtitleKind = rawKind === "series" || rawKind === "anime" ? rawKind : "movie";
    return handleSearch(req, res, kind, tmdbId);
  });

  for (const kind of ["movie", "series", "anime"] as const) {
    router.get(`/api/v1/subtitles/${kind}/:tmdbId`, async (req: Request, res: Response) => {
      return handleSearch(req, res, kind, positiveInt(req.params.tmdbId) || 0);
    });
  }

  router.get("/api/v1/subtitles/file/:token.vtt", async (req: Request, res: Response) => {
    const token = String(req.params.token || "").trim();
    if (!/^[a-f0-9]{32}$/i.test(token)) return res.status(400).send("Invalid subtitle token");
    const result = await gateway.proxy.serve(token);
    if (!result) return res.status(404).send("Subtitle unavailable");
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Subtitle-Provider", result.provider);
    res.setHeader("X-Subtitle-Format", result.format);
    return res.status(200).send(result.body);
  });

  router.get("/api/v1/subtitles/health", (_req: Request, res: Response) => res.json({ providers: gateway.healthSnapshot() }));
  return router;
}
