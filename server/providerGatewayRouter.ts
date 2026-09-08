import { Router, type Request, type Response } from "express";
import { resolveByTmdb, type GatewayKind } from "./providerGateway";
import { resolveTmdbIdentityCandidate } from "./identity/tmdbIdentityResolver";
import { normalizePreferredLanguages } from "./subtitles/ExternalIdResolver";

function parseKind(raw: unknown): GatewayKind | null {
  const value = String(raw || "").toLowerCase();
  return value === "movie" || value === "series" || value === "anime" ? value : null;
}

function intValue(raw: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalYear(raw: unknown): number | null {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100 ? parsed : null;
}

function cleanAliases(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const value of raw) {
    const alias = String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
    const key = alias.toLowerCase();
    if (alias.length < 2 || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
    if (aliases.length >= 8) break;
  }
  return aliases;
}

function preferenceList(raw: unknown): string[] | undefined {
  const values = Array.isArray(raw)
    ? raw.map((value) => String(value || "").trim()).filter(Boolean)
    : typeof raw === "string"
      ? raw.split(",").map((value) => value.trim()).filter(Boolean)
      : [];
  return values.length > 0 ? normalizePreferredLanguages(values) : undefined;
}

export function providerGatewayRouter(): Router {
  const router = Router();

  // Recovery path for legacy/local rows without a TMDB id. It never writes to
  // the database and never promotes medium/low matches into playback. A high-
  // confidence identity can immediately unlock the same provider gateway used
  // by canonical TMDB cards while preserving every existing gateway contract.
  router.post("/api/v1/providers/resolve-title", async (req: Request, res: Response) => {
    try {
      const kind = parseKind(req.body?.kind);
      const title = String(req.body?.title || "").replace(/\s+/g, " ").trim().slice(0, 180);
      if (!kind || title.length < 2) {
        return res.status(400).json({ error: "kind/title inválidos" });
      }

      const identity = await resolveTmdbIdentityCandidate({
        kind,
        title,
        aliases: cleanAliases(req.body?.aliases),
        year: optionalYear(req.body?.year),
        imdbId: typeof req.body?.imdbId === "string" ? req.body.imdbId.trim().slice(0, 32) : null,
        originalLanguage: typeof req.body?.originalLanguage === "string" ? req.body.originalLanguage.trim().slice(0, 16) : null,
        originCountry: Array.isArray(req.body?.originCountry)
          ? req.body.originCountry.map((value: unknown) => String(value || "").trim().toUpperCase()).filter(Boolean).slice(0, 4)
          : undefined,
      });

      if (!identity || identity.confidence !== "high") {
        res.setHeader("Cache-Control", "private, max-age=60");
        return res.json({
          resolved: false,
          reason: identity ? "identity_not_high_confidence" : "identity_not_found",
          confidence: identity?.confidence || null,
        });
      }

      const gateway = await resolveByTmdb({
        kind,
        tmdbId: identity.tmdbId,
        season: intValue(req.body?.season, 1),
        episode: intValue(req.body?.episode, 1),
        preferredAudio: preferenceList(req.body?.preferredAudio),
        preferredSubtitles: preferenceList(req.body?.preferredSubtitles),
        // Identity recovery is deliberately read-only. Persisting source links
        // remains an explicit caller choice on canonical TMDB requests.
        persist: false,
      });

      res.setHeader("Cache-Control", "private, max-age=30");
      return res.json({
        resolved: true,
        identity: {
          tmdbId: identity.tmdbId,
          mediaType: identity.mediaType,
          title: identity.title,
          originalTitle: identity.originalTitle,
          year: identity.year,
          confidence: identity.confidence,
          source: identity.source,
        },
        gateway,
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "identity recovery failed" });
    }
  });

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
        preferredAudio: preferenceList(req.query.audio),
        preferredSubtitles: preferenceList(req.query.subtitles),
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
        preferredAudio: preferenceList(req.body?.preferredAudio),
        preferredSubtitles: preferenceList(req.body?.preferredSubtitles),
        persist: Boolean(req.body?.persist),
      }));
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "provider gateway failed" });
    }
  });

  return router;
}
