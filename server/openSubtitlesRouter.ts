import { Router, type Request, type Response } from "express";
import { openSubtitlesConfig, searchOpenSubtitles } from "./openSubtitles";

function positiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function openSubtitlesRouter(): Router {
  const router = Router();

  router.get("/api/v1/subtitles", async (req: Request, res: Response) => {
    const tmdbId = positiveInt(req.query.tmdb_id || req.query.tmdbId);
    const rawKind = String(req.query.kind || "movie").toLowerCase();
    const kind = rawKind === "series" || rawKind === "anime" ? rawKind : "movie";
    if (!tmdbId) return res.status(400).json({ error: "tmdb_id inválido", tracks: [] });

    const result = await searchOpenSubtitles({
      tmdbId,
      kind,
      season: positiveInt(req.query.season) || 1,
      episode: positiveInt(req.query.episode) || 1,
      languages: typeof req.query.languages === "string"
        ? req.query.languages.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 5)
        : ["es", "en"],
    });
    res.setHeader("Cache-Control", result.configured ? "private, max-age=300" : "private, max-age=60");
    return res.json({ ...result, config: openSubtitlesConfig() });
  });

  return router;
}
