import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { buildMultiSourceCascade, handlePlayEpisode } from "../server";
import { prisma } from "./db";
import * as universalScraper from "./universalScraper";
import * as siteRatingService from "./siteRatingService";

function mockReqRes(episodeId: string) {
  const req = {
    params: { episode_id: episodeId },
    query: {},
    headers: {},
  } as unknown as Request;

  let statusCode = 200;
  let jsonBody: any = null;

  const res = {
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((data: any) => {
      jsonBody = data;
      return res;
    }),
  } as unknown as Response;

  return { req, res, getStatus: () => statusCode, getBody: () => jsonBody };
}

describe("Cascada multi-fuente y GET /api/v1/play/:episode_id", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Dos links válidos del mismo source_site sobreviven, respetando el límite (máximo 2 por sitio).
  it("dos links válidos del mismo source_site sobreviven, respetando el límite", async () => {
    const mockEpisode = {
      id: "ep-multi-1",
      episode_number: 1,
      media_item: { id: "item-1", title: "Frieren" },
      links: [
        { url: "https://vimeos.net/embed-alt1.html", source_site: "animeflv", priority_tier: 1 },
        { url: "https://vimeos.net/embed-alt2.html", source_site: "animeflv", priority_tier: 2 },
        { url: "https://vimeos.net/embed-alt3.html", source_site: "animeflv", priority_tier: 3 },
      ],
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-multi-1");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body).toBeDefined();
    expect(body.episode_id).toBe("ep-multi-1");

    // Exactamente 2 candidatos de animeflv sobreviven (el 3ro se descarta por el límite de 2 por sitio)
    expect(body.ranked_streams).toHaveLength(2);
    expect(body.ranked_streams.every((s: any) => s.source_site === "animeflv")).toBe(true);
    expect(body.ranked_streams[0].url).toBe("https://vimeos.net/embed-alt1.html");
    expect(body.ranked_streams[1].url).toBe("https://vimeos.net/embed-alt2.html");
    expect(body.stream_url).toBe("https://vimeos.net/embed-alt1.html");
  });

  it("no gasta los dos slots de un sitio con el mismo HLS firmado", async () => {
    const base = "https://a1.acek-cdn.com/hls2/01/00001/video/master.m3u8";
    const start = Math.floor(Date.now() / 1000) + 7_200;
    const signedOne = `${base}?t=old&s=${start}&e=3600&lang=es`;
    const signedTwo = `${base}?t=new&s=${start + 100}&e=3600&lang=es`;
    const other = "https://cdn3.turboviplay.com/data/video/video.m3u8";

    const cascade = await buildMultiSourceCascade([
      { url: signedOne, source_site: "tioplus.app", priority_tier: 1 },
      { url: signedTwo, source_site: "tioplus.app", priority_tier: 2 },
      { url: other, source_site: "tioplus.app", priority_tier: 3 },
    ]);

    expect(cascade).toHaveLength(2);
    expect(cascade.map((entry) => entry.url)).toEqual([signedOne, other]);
  });

  // 2. Un directo firmado vencido queda fuera.
  it("un directo firmado vencido queda fuera de la cascada y no se entrega como stream principal", async () => {
    // URL firmada de Vimeos con timestamp de inicio en 2020 y TTL 120s (claramente expirada)
    const expiredDirect = "https://s1.vimeos.net/master.m3u8?s=1600000000&e=120";
    const validEmbed = "https://vimeos.net/embed-valid.html";

    const mockEpisode = {
      id: "ep-expired-1",
      episode_number: 2,
      media_item: { id: "item-2", title: "Dungeon Meshi" },
      links: [
        { url: expiredDirect, source_site: "animeflv", priority_tier: 1 },
        { url: validEmbed, source_site: "animeflv", priority_tier: 2 },
      ],
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-expired-1");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body).toBeDefined();

    // El enlace firmado vencido queda completamente fuera
    expect(body.ranked_streams).toHaveLength(1);
    expect(body.ranked_streams[0].url).toBe(validEmbed);
    expect(body.stream_url).toBe(validEmbed);
    expect(body.all_available_streams).toEqual([validEmbed]);
    expect(body.all_available_streams).not.toContain(expiredDirect);
  });

  it("descarta índices de catálogo y conserva páginas de detalle para JIT", async () => {
    const catalog = "https://www.cinecalidad.am/page/1/";
    const detail = "https://www.cinecalidad.am/ver-pelicula/intriga-internacional/";
    const cascade = await buildMultiSourceCascade([
      { url: catalog, source_site: "cinecalidad.am", priority_tier: 1 },
      { url: detail, source_site: "cinecalidad.am", priority_tier: 2 },
    ]);

    expect(cascade.map((entry) => entry.url)).toEqual([detail]);
    expect(cascade[0].canonical_locator).toBe(detail);
    expect(cascade[0].delivery_mode).toBe("embed");
  });

  // 3. Una página canónica queda dentro.
  it("una página canónica queda dentro de la cascada con su canonical locator", async () => {
    const canonicalPage = "https://www3.animeflv.net/ver/frieren-1";

    const mockEpisode = {
      id: "ep-canonical-1",
      episode_number: 1,
      media_item: { id: "item-3", title: "Frieren Canónica" },
      links: [
        { url: canonicalPage, source_site: "animeflv", priority_tier: 3 },
      ],
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-canonical-1");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body).toBeDefined();
    expect(body.ranked_streams).toHaveLength(1);

    const stream = body.ranked_streams[0];
    expect(stream.url).toBe(canonicalPage);
    expect(stream.canonical_locator).toBe(canonicalPage);
    expect(stream.is_refreshable).toBe(true);
    expect(stream.is_proxyable).toBe(false);
    expect(stream.delivery_mode).toBe("embed");
    expect(stream.source_site).toBe("animeflv");
    expect(body.stream_url).toBe(canonicalPage);
  });

  // 4. El límite global de ocho funciona.
  it("el límite global de ocho funciona cuando hay más de 8 candidatos entre varios sitios", async () => {
    // 6 sitios con 2 links válidos cada uno (12 links en total)
    const sites = ["site1", "site2", "site3", "site4", "site5", "site6"];
    const links = sites.flatMap((site, siteIndex) => [
      { url: `https://vimeos.net/embed-${site}-1.html`, source_site: site, priority_tier: 1 },
      { url: `https://vimeos.net/embed-${site}-2.html`, source_site: site, priority_tier: 2 },
    ]);

    const mockEpisode = {
      id: "ep-global-limit",
      episode_number: 1,
      media_item: { id: "item-4", title: "Obra Multisitio" },
      links,
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-global-limit");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body).toBeDefined();

    // El límite global de 8 se cumple estrictamente
    expect(body.ranked_streams).toHaveLength(8);
    expect(body.all_available_streams).toHaveLength(8);

    // Ningún sitio excede 2 candidatos
    const countBySite: Record<string, number> = {};
    for (const item of body.ranked_streams) {
      countBySite[item.source_site] = (countBySite[item.source_site] || 0) + 1;
      expect(countBySite[item.source_site]).toBeLessThanOrEqual(2);
    }
  });

  // 5. GET /play no llama scrapers (DB-only).
  it("GET /play no llama scrapers ni resoluciones externas", async () => {
    const extractSpy = vi.spyOn(universalScraper, "extractStreamFromUrl");

    const mockEpisode = {
      id: "ep-db-only",
      episode_number: 1,
      media_item: { id: "item-5", title: "DB Only Show" },
      links: [
        { url: "https://vimeos.net/embed-fast.html", source_site: "animeflv" },
      ],
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-db-only");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body).toBeDefined();
    expect(body.ranked_streams).toHaveLength(1);

    // No se ejecutan scrapers externos
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it("no responde con stream vacío si MediaEpisode migrado aún no tiene links", async () => {
    const legacyUrl = "https://legacy.example/ver/obra-1";
    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue({
      id: "media-without-links", season_number: 1, episode_number: 1,
      media_item: { title: "Obra migrada", normalized_title: "obra migrada", base_normalized_title: "obra migrada", year: 2024, tmdb_id: null },
      links: [],
    } as any);
    vi.spyOn(prisma.show, "findMany").mockResolvedValue([{
      id: "legacy-show", title: "Obra migrada", normalized_title: "obra migrada", base_normalized_title: "obra migrada",
      year: 2024, category: "series", tmdb_id: null,
      episodes: [{ id: "legacy-ep", episode_number: 1, source_url: legacyUrl, title: "Episodio 1", show_id: "legacy-show" }],
    }] as any);
    vi.spyOn(prisma.mediaItem, "findMany").mockResolvedValue([] as any);
    vi.spyOn(prisma.episode, "findMany").mockResolvedValue([] as any);
    vi.spyOn(universalScraper, "extractStreamFromUrl").mockResolvedValue({
      stream_url: "https://cdn.example/obra-1.m3u8", all_available_streams: ["https://cdn.example/obra-1.m3u8"],
    });
    const { req, res, getBody, getStatus } = mockReqRes("media-without-links");
    await handlePlayEpisode(req, res);
    expect(getStatus()).toBe(200);
    expect(getBody().stream_url).toBe("https://cdn.example/obra-1.m3u8");
    expect(universalScraper.extractStreamFromUrl).toHaveBeenCalledWith(legacyUrl);
  });

  // 6. Preserva íntegramente la metadata requerida de cada entrada
  it("preserva íntegramente toda la metadata requerida de cada entrada", async () => {
    // Un enlace directo vigente con expiración futura
    const futureEpoch = Math.floor(Date.now() / 1000) + 7200;
    const futureDirect = `https://s1.vimeos.net/master.m3u8?s=${futureEpoch}&e=3600`;
    const embedUrl = "https://vimeos.net/embed-meta.html";

    const cascade = await buildMultiSourceCascade([
      { url: futureDirect, source_site: "animeflv", priority_tier: 1 },
      { url: embedUrl, source_site: "animeflv", priority_tier: 2 },
    ]);

    expect(cascade).toHaveLength(2);

    const directEntry = cascade.find((c) => c.url === futureDirect)!;
    expect(directEntry).toBeDefined();
    expect(directEntry).toHaveProperty("original_url", futureDirect);
    expect(directEntry.canonical_locator).toBeUndefined();
    expect(directEntry).toHaveProperty("delivery_mode", "direct_trial");
    expect(directEntry).toHaveProperty("is_proxyable", true);
    expect(directEntry).toHaveProperty("is_refreshable", false);
    expect(directEntry).toHaveProperty("expires_at");
    expect(typeof directEntry.expires_at).toBe("number");
    expect(directEntry).toHaveProperty("source_site", "animeflv");
    expect(directEntry).toHaveProperty("tier", 1);

    const embedEntry = cascade.find((c) => c.url === embedUrl)!;
    expect(embedEntry).toBeDefined();
    expect(embedEntry).toHaveProperty("original_url", embedUrl);
    expect(embedEntry).toHaveProperty("canonical_locator", embedUrl);
    expect(embedEntry).toHaveProperty("delivery_mode", "embed");
    expect(embedEntry).toHaveProperty("is_proxyable", false);
    expect(embedEntry).toHaveProperty("is_refreshable", true);
    expect(embedEntry).toHaveProperty("source_site", "animeflv");
    expect(embedEntry).toHaveProperty("tier", 2);
  });

  it("conserva el canonical_locator persistido de un directo firmado renovable", async () => {
    const expiredEpoch = Math.floor(Date.now() / 1000) - 120;
    const signed = `https://cdn.example/master.m3u8?s=${expiredEpoch}&e=60`;
    const locator = "https://provider.example/episode/renewable-1";
    const [entry] = await buildMultiSourceCascade([
      {
        url: signed,
        source_site: "provider.example",
        link_type: "direct",
        canonical_locator: locator,
        priority_tier: 1,
      },
    ]);

    expect(entry).toBeDefined();
    expect(entry.canonical_locator).toBe(locator);
    expect(entry.delivery_mode).toBe("direct_trial");
    expect(entry.is_refreshable).toBe(true);
    expect(entry.failure_reason).toBeUndefined();
  });

  // 7. Conserva orden por rating de sitio y tier sin descartar alternativas válidas del mismo sitio
  it("conserva orden por rating de sitio DESC y tier ASC, manteniendo alternativas del mismo sitio", async () => {
    vi.spyOn(siteRatingService, "getSiteRating").mockImplementation(async (site: string) => {
      if (site === "top-site") return 9.5;
      if (site === "low-site") return 4.0;
      return 5.0;
    });

    const links = [
      { url: "https://mega.nz/embed/!low2", source_site: "low-site" }, // mega = tier 4
      { url: "https://vimeos.net/embed-low1.html", source_site: "low-site" }, // vimeos = tier 1
      { url: "https://mega.nz/embed/!top2", source_site: "top-site" }, // mega = tier 4
      { url: "https://vimeos.net/embed-top1.html", source_site: "top-site" }, // vimeos = tier 1
    ];

    const cascade = await buildMultiSourceCascade(links);

    expect(cascade).toHaveLength(4);
    // Primero los del sitio con mayor rating (top-site) ordenados por tier (tier 1 antes de tier 4)
    expect(cascade[0].source_site).toBe("top-site");
    expect(cascade[0].url).toBe("https://vimeos.net/embed-top1.html");
    expect(cascade[1].source_site).toBe("top-site");
    expect(cascade[1].url).toBe("https://mega.nz/embed/!top2");

    // Luego los del sitio con menor rating (low-site) ordenados por tier
    expect(cascade[2].source_site).toBe("low-site");
    expect(cascade[2].url).toBe("https://vimeos.net/embed-low1.html");
    expect(cascade[3].source_site).toBe("low-site");
    expect(cascade[3].url).toBe("https://mega.nz/embed/!low2");
  });

  it("prioriza una página canónica recuperada sobre un HLS firmado de otro proveedor", async () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 7200;
    const signedDirect = `https://cdn.tioplus.example/master.m3u8?s=${futureEpoch}&e=3600`;
    const canonicalPage = "https://www.cinecalidad.am/ver-pelicula/carrera-de-bestias/";
    const mockEpisode = {
      id: "ep-cross-provider-canonical",
      episode_number: 1,
      media_item: { id: "item-cross-provider", title: "Carrera de bestias" },
      links: [
        { url: signedDirect, source_site: "tioplus.app", priority_tier: 1 },
        { url: canonicalPage, source_site: "cinecalidad.am", link_type: "page", priority_tier: 2 },
      ],
    };

    vi.spyOn(prisma.mediaEpisode, "findUnique").mockResolvedValue(mockEpisode as any);
    const { req, res, getBody } = mockReqRes("ep-cross-provider-canonical");

    await handlePlayEpisode(req, res);

    const body = getBody();
    expect(body.ranked_streams[0].url).toBe(canonicalPage);
    expect(body.ranked_streams.some((entry: any) => entry.url === signedDirect)).toBe(true);
  });
});
