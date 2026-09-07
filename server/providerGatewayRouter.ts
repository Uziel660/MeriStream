import { Router, type Request, type Response } from "express";
import { resolveByTmdb, type GatewayKind } from "./providerGateway";

function parseKind(raw: unknown): GatewayKind | null {
  const value = String(raw || "").toLowerCase();
  return value === "movie" || value === "series" || value === "anime" ? value : null;
}

function intValue(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function providerGatewayRouter(): Router {
  const router = Router();

  // Main JIT contract. Primary APIs are resolved in parallel and `sources`
  // contains ONLY HLS/DASH/MP4 playable by MeriStream's internal player.
  router.get("/api/v1/providers/:kind/:tmdbId", async (req: Request, res: Response) => {
    try {
      const kind = parseKind(req.params.kind);
      const tmdbId = intValue(req.params.tmdbId, 0);
      if (!kind || tmdbId <= 0) {
        return res.status(400).json({ error: "kind/tmdbId inválidos" });
      }
      const result = await resolveByTmdb({
        kind,
        tmdbId,
        season: intValue(req.query.season, 1),
        episode: intValue(req.query.episode, 1),
        preferredAudio: typeof req.query.audio === "string" ? req.query.audio.split(",").filter(Boolean) : undefined,
        preferredSubtitles: typeof req.query.subtitles === "string" ? req.query.subtitles.split(",").filter(Boolean) : undefined,
        persist: req.query.persist === "1" || req.query.persist === "true",
      });
      res.setHeader("Cache-Control", "private, max-age=15");
      return res.json(result);
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "provider gateway failed" });
    }
  });

  router.post("/api/v1/providers/resolve", async (req: Request, res: Response) => {
    try {
      const kind = parseKind(req.body?.kind);
      const tmdbId = intValue(req.body?.tmdbId, 0);
      if (!kind || tmdbId <= 0) {
        return res.status(400).json({ error: "kind/tmdbId inválidos" });
      }
      return res.json(await resolveByTmdb({
        kind,
        tmdbId,
        season: intValue(req.body?.season, 1),
        episode: intValue(req.body?.episode, 1),
        preferredAudio: Array.isArray(req.body?.preferredAudio) ? req.body.preferredAudio : undefined,
        preferredSubtitles: Array.isArray(req.body?.preferredSubtitles) ? req.body.preferredSubtitles : undefined,
        persist: Boolean(req.body?.persist),
      }));
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "provider gateway failed" });
    }
  });

  return router;
}
