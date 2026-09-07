#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import cors from "cors";
import { resolveByTmdb, type GatewayKind } from "../server/providerGateway";

const app = express();
const port = Number(process.env.PROVIDER_API_PORT || 3099);
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true, service: "meristream-provider-gateway" }));

app.get("/api/v1/provider/:kind/:tmdbId", async (req, res) => {
  const kind = req.params.kind as GatewayKind;
  const tmdbId = Number(req.params.tmdbId);
  if (!(["movie", "series", "anime"] as string[]).includes(kind) || !Number.isInteger(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: "kind/tmdbId inválidos" });
  }
  try {
    const season = req.query.season ? Number(req.query.season) : undefined;
    const episode = req.query.episode ? Number(req.query.episode) : undefined;
    const persist = req.query.persist === "1" || req.query.persist === "true";
    const result = await resolveByTmdb({ tmdbId, kind, season, episode, persist });
    return res.json({ tmdbId, kind, season: season || 1, episode: episode || 1, ...result });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

app.listen(port, () => {
  console.log(`[provider-api] http://127.0.0.1:${port}`);
  console.log(`[provider-api] GET /api/v1/provider/movie/:tmdbId`);
  console.log(`[provider-api] GET /api/v1/provider/series/:tmdbId?season=1&episode=1`);
});
