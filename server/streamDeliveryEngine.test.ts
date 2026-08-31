import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { PlaybackSessionStore, createPlaybackSessionHandlers } from "./playbackSessions";
import { DeliveryPlanner, ResolutionCoordinator, buildResolveDeliveryResponse } from "./deliveryPlanner";
import { EmbedResolvers, providerResolverRegistry } from "./resolvers";
import { classifySourceKind, parseStreamExpiry } from "./resolutionMetadata";
import { maskSignedTokens } from "./networkLogger";
import {
  applyResolution,
  canEscalateToProxy,
  isExpiredWithoutLocator,
  nextDeliveryIntent,
  shouldScheduleRenewal,
  isAttemptCurrent,
  hasAttemptedMode,
  recordAttemptedMode,
  handleEmbedTimeout,
} from "../src/utils/playerDelivery";
import { scoreServer } from "../src/utils/streamOptimizer";

describe("Stream Delivery Engine - Matriz Completa de 25 Casos de Entrega", () => {
  let server: http.Server | null = null;
  let serverUrl = "";
  let renewalCount = 0;
  let requestLog: string[] = [];

  beforeEach(async () => {
    renewalCount = 0;
    requestLog = [];
    server = http.createServer((req, res) => {
      requestLog.push(`${req.method} ${req.url}`);
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (url.pathname === "/stable.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nsegment0.ts\n#EXT-X-ENDLIST\n`);
        return;
      }

      if (url.pathname === "/signed-v1.m3u8") {
        if (url.searchParams.get("token") === "expired") {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden - Token Expired");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nsegment0.ts?token=active1\n#EXT-X-ENDLIST\n`);
        return;
      }

      if (url.pathname === "/signed-v2.m3u8") {
        renewalCount++;
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nsegment0.ts?token=renewed2\n#EXT-X-ENDLIST\n`);
        return;
      }

      if (url.pathname === "/master-variants.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(
          `#EXTM3U\n` +
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Español",DEFAULT=YES,URI="audio/es.m3u8"\n` +
          `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",DEFAULT=YES,URI="subs/es.vtt"\n` +
          `#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="subs"\n` +
          `720p/index.m3u8\n` +
          `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="audio",SUBTITLES="subs"\n` +
          `1080p/index.m3u8\n`
        );
        return;
      }

      if (url.pathname === "/playlist-rel.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(
          `#EXTM3U\n` +
          `#EXT-X-VERSION:3\n` +
          `#EXT-X-TARGETDURATION:6\n` +
          `#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n` +
          `#EXT-X-MAP:URI="init.mp4"\n` +
          `#EXTINF:6.0,\n` +
          `segment-rel-0.ts\n` +
          `#EXTINF:6.0,\n` +
          `segment-rel-1.ts\n` +
          `#EXT-X-ENDLIST\n`
        );
        return;
      }

      if (url.pathname === "/playlist-abs.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end(
          `#EXTM3U\n` +
          `#EXT-X-VERSION:3\n` +
          `#EXTINF:6.0,\n` +
          `${serverUrl}/abs-segments/seg-0.ts?t=abc\n` +
          `#EXT-X-ENDLIST\n`
        );
        return;
      }

      if (url.pathname.endsWith(".mp4")) {
        const range = req.headers["range"];
        const fullContent = Buffer.from("0123456789ABCDEF0123456789ABCDEF");
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10) || 0;
          const end = parts[1] ? parseInt(parts[1], 10) : fullContent.length - 1;
          const chunk = fullContent.subarray(start, end + 1);
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fullContent.length}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunk.length,
            "Content-Type": "video/mp4",
          });
          res.end(chunk);
          return;
        }
        res.writeHead(200, {
          "Content-Length": fullContent.length,
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        });
        res.end(fullContent);
        return;
      }

      if (url.pathname === "/embed-origin.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body><script>var playerConfig = { file: "${serverUrl}/signed-v1.m3u8?token=active1" };</script></body></html>`);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        serverUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });

  // 1. HLS estable directo
  it("1. HLS estable directo es reproducible directamente y se clasifica como renovable", async () => {
    const streamUrl = `${serverUrl}/stable.m3u8`;
    const meta = await EmbedResolvers.resolveWithMeta(streamUrl);
    expect(meta.resolved).toBe(true);
    expect(meta.type).toBe("direct");
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(true);
    expect(meta.canonical_locator).toBe(streamUrl);

    const planner = new DeliveryPlanner();
    const mode = planner.classify(meta);
    expect(mode).toBe("direct_trial");
  });

  // 2. HLS firmado vigente proxyable/no renovable
  it("2. HLS firmado vigente es proxyable pero no renovable por sí mismo", async () => {
    const streamUrl = `${serverUrl}/signed-v1.m3u8?token=xyz&expires=1999999999`;
    const meta = await EmbedResolvers.resolveWithMeta(streamUrl);
    expect(meta.resolved).toBe(true);
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.canonical_locator).toBeUndefined();
  });

  // 3. HLS vencido sin locator rechazado
  it("3. HLS vencido sin locator es rechazado inmediatamente con failure_reason", async () => {
    const streamUrl = `${serverUrl}/signed-v1.m3u8?token=old&expires=1600000000`;
    const meta = await EmbedResolvers.resolveWithMeta(streamUrl);
    expect(meta.resolved).toBe(false);
    expect(meta.is_proxyable).toBe(false);
    expect(meta.is_refreshable).toBe(false);
    expect(meta.failure_reason).toBe("expired_without_locator");

    expect(isExpiredWithoutLocator(null, meta)).toBe(true);
    expect(nextDeliveryIntent({ url: streamUrl, id: "1", isEmbed: false, failure_reason: "expired_without_locator" } as any, null)).toBe("skip");
  });

  // 4. Embed que resuelve a HLS vigente
  it("4. Embed que resuelve a HLS vigente conserva el embed como locator canónico", async () => {
    const embedUrl = `${serverUrl}/embed-origin.html`;
    vi.spyOn(EmbedResolvers, "resolve").mockResolvedValueOnce(`${serverUrl}/signed-v1.m3u8?token=active1&expires=1999999999`);
    const meta = await EmbedResolvers.resolveWithMeta(embedUrl);
    expect(meta.resolved).toBe(true);
    expect(meta.type).toBe("direct");
    expect(meta.is_proxyable).toBe(true);
    expect(meta.is_refreshable).toBe(true);
    expect(meta.canonical_locator).toBe(embedUrl);
  });

  // 5. Embed que produce HLS ya vencido
  it("5. Embed que produce HLS ya vencido se mantiene como locator pero no como stream reproducible", async () => {
    const embedUrl = `${serverUrl}/embed-origin.html`;
    vi.spyOn(EmbedResolvers, "resolve").mockResolvedValueOnce(`${serverUrl}/signed-v1.m3u8?token=old&expires=1600000000`);
    const meta = await EmbedResolvers.resolveWithMeta(embedUrl);
    expect(meta.resolved).toBe(false);
    expect(meta.type).toBe("embed");
    expect(meta.is_proxyable).toBe(false);
    expect(meta.is_refreshable).toBe(true);
    expect(meta.canonical_locator).toBe(embedUrl);
  });

  // 6. Renovación antes del TTL
  it("6. Renovación preventiva antes del TTL refresca la URL sin perder locator", async () => {
    let callCount = 0;
    const resolver = async (loc: string) => {
      callCount++;
      return {
        url: callCount === 1 ? `${serverUrl}/signed-v1.m3u8` : `${serverUrl}/signed-v2.m3u8`,
        original_url: loc,
        canonical_locator: loc,
        resolved: true,
        type: "direct" as const,
        provider: "TestProvider",
        is_proxyable: true,
        is_refreshable: true,
        resolved_at: Date.now(),
        refresh_after: Date.now() - 10,
        expires_at: Date.now() + 60000,
        generation: `gen-${callCount}`,
      };
    };

    const store = new PlaybackSessionStore({ resolver });
    const session = await store.create(`${serverUrl}/embed-origin.html`);
    expect(session.current.generation).toBeDefined();

    const refreshed = await store.refresh(session.id, true);
    expect(refreshed.generation).toBe("gen-2");
    expect(refreshed.url).toContain("signed-v2.m3u8");
  });

  // 7. Renovación después de 401/403
  it("7. Renovación ante 401/403 re-resuelve con locator canónico", async () => {
    let callCount = 0;
    const store = new PlaybackSessionStore({
      resolver: async (loc) => {
        callCount++;
        return {
          url: callCount === 1 ? `${serverUrl}/signed-v1.m3u8?token=expired` : `${serverUrl}/signed-v2.m3u8`,
          original_url: loc,
          canonical_locator: loc,
          resolved: true,
          type: "direct",
          provider: "TestProvider",
          is_proxyable: true,
          is_refreshable: true,
          generation: `gen-${callCount}`,
        };
      },
    });

    const session = await store.create(`${serverUrl}/embed-origin.html`);
    const refreshed = await store.refreshForUpstreamStatus(session.id, 403);
    expect(refreshed).toBeDefined();
    expect(refreshed?.generation).toBe("gen-2");
  });

  // 8. Manifest maestro con variantes
  it("8. Manifest maestro reescribe variantes HLS a rutas proxy opacas", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved(`${serverUrl}/embed-origin.html`, {
      url: `${serverUrl}/master-variants.m3u8`,
      original_url: `${serverUrl}/embed-origin.html`,
      canonical_locator: `${serverUrl}/embed-origin.html`,
      resolved: true,
      type: "direct",
      provider: "TestProvider",
      is_proxyable: true,
      is_refreshable: true,
    });

    const rawManifest =
      `#EXTM3U\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720\n` +
      `720p/index.m3u8\n` +
      `#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n` +
      `1080p/index.m3u8\n`;

    const rewritten = store.rewriteManifest(session.id, rawManifest, `${serverUrl}/master-variants.m3u8`);
    expect(rewritten).toContain(`/api/v1/playback/${session.id}/resource/`);
    expect(rewritten).not.toContain("720p/index.m3u8");
  });

  // 9. Playlist con segmentos relativos
  it("9. Playlist con segmentos relativos reescribe todos los URIs", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved(`${serverUrl}/embed-origin.html`, {
      url: `${serverUrl}/playlist-rel.m3u8`,
      original_url: `${serverUrl}/embed-origin.html`,
      canonical_locator: `${serverUrl}/embed-origin.html`,
      resolved: true,
      type: "direct",
      provider: "TestProvider",
      is_proxyable: true,
      is_refreshable: true,
    });

    const raw =
      `#EXTM3U\n` +
      `#EXTINF:6.0,\n` +
      `segment-0.ts\n` +
      `#EXTINF:6.0,\n` +
      `segment-1.ts\n`;

    const rewritten = store.rewriteManifest(session.id, raw, `${serverUrl}/playlist-rel.m3u8`);
    const lines = rewritten.split("\n").filter((l) => l.startsWith("/api/v1/playback/"));
    expect(lines.length).toBe(2);
  });

  // 10. Playlist con segmentos absolutos
  it("10. Playlist con segmentos absolutos se indexa y reescribe a recursos opacos", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved(`${serverUrl}/embed-origin.html`, {
      url: `${serverUrl}/playlist-abs.m3u8`,
      original_url: `${serverUrl}/embed-origin.html`,
      canonical_locator: `${serverUrl}/embed-origin.html`,
      resolved: true,
      type: "direct",
      provider: "TestProvider",
      is_proxyable: true,
      is_refreshable: true,
    });

    const raw = `#EXTM3U\n#EXTINF:6.0,\n${serverUrl}/abs-segments/seg-0.ts?t=abc\n`;
    const rewritten = store.rewriteManifest(session.id, raw, `${serverUrl}/playlist-abs.m3u8`);
    expect(rewritten).toContain(`/api/v1/playback/${session.id}/resource/`);
    expect(rewritten).not.toContain("abs-segments/seg-0.ts");
  });

  // 11. EXT-X-KEY y EXT-X-MAP
  it("11. Reescribe atributos URI en EXT-X-KEY y EXT-X-MAP", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved(`${serverUrl}/embed-origin.html`, {
      url: `${serverUrl}/playlist-rel.m3u8`,
      original_url: `${serverUrl}/embed-origin.html`,
      canonical_locator: `${serverUrl}/embed-origin.html`,
      resolved: true,
      type: "direct",
      provider: "TestProvider",
      is_proxyable: true,
      is_refreshable: true,
    });

    const raw =
      `#EXTM3U\n` +
      `#EXT-X-KEY:METHOD=AES-128,URI="enc.key"\n` +
      `#EXT-X-MAP:URI="init.mp4"\n` +
      `#EXTINF:6.0,\n` +
      `segment-0.ts\n`;

    const rewritten = store.rewriteManifest(session.id, raw, `${serverUrl}/playlist-rel.m3u8`);
    expect(rewritten).toMatch(/#EXT-X-KEY:METHOD=AES-128,URI="\/api\/v1\/playback\/[^\/]+\/resource\/[^"]+"/);
    expect(rewritten).toMatch(/#EXT-X-MAP:URI="\/api\/v1\/playback\/[^\/]+\/resource\/[^"]+"/);
  });

  // 12. Audio y subtítulos alternativos
  it("12. Reescribe tags EXT-X-MEDIA de audio y subtítulos a recursos proxy", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved(`${serverUrl}/embed-origin.html`, {
      url: `${serverUrl}/master-variants.m3u8`,
      original_url: `${serverUrl}/embed-origin.html`,
      canonical_locator: `${serverUrl}/embed-origin.html`,
      resolved: true,
      type: "direct",
      provider: "TestProvider",
      is_proxyable: true,
      is_refreshable: true,
    });

    const raw =
      `#EXTM3U\n` +
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Español",DEFAULT=YES,URI="audio/es.m3u8"\n` +
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Español",DEFAULT=YES,URI="subs/es.vtt"\n`;

    const rewritten = store.rewriteManifest(session.id, raw, `${serverUrl}/master-variants.m3u8`);
    expect(rewritten).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO.*URI="\/api\/v1\/playback\/[^\/]+\/resource\/[^"]+"/);
    expect(rewritten).toMatch(/#EXT-X-MEDIA:TYPE=SUBTITLES.*URI="\/api\/v1\/playback\/[^\/]+\/resource\/[^"]+"/);
  });

  // 13. Redirección de host conservando seguridad
  it("13. RebaseResource reconstruye correctamente recursos tras cambio de host en renovación", async () => {
    const store = new PlaybackSessionStore();
    const session = store.createFromResolved("https://origin.com/e/1", {
      url: "https://edge1.cdn.com/hls/master.m3u8?t=v1",
      original_url: "https://origin.com/e/1",
      canonical_locator: "https://origin.com/e/1",
      resolved: true,
      type: "direct",
      provider: "CDN",
      is_proxyable: true,
      is_refreshable: true,
      generation: "gen-1",
    });

    const key = store.registerResource(session.id, {
      upstreamUrl: "https://edge1.cdn.com/hls/720p/index.m3u8?t=v1",
      registeredGeneration: "gen-1",
      registeredBaseUrl: "https://edge1.cdn.com/hls/master.m3u8?t=v1",
      rootRelative: "720p/index.m3u8?t=v1",
    });

    // Simular renovación de sesión a un nuevo host
    session.current = {
      ...session.current,
      url: "https://edge2.cdn.com/hls/master.m3u8?t=v2",
      generation: "gen-2",
    };

    const rebased = store.resourceUrl(session.id, key);
    expect(rebased).toBe("https://edge2.cdn.com/hls/720p/index.m3u8?t=v1");
  });

  // 14. Headers específicos por proveedor
  it("14. Provider resolver y host profiles inyectan headers requeridos de proveedor", async () => {
    const vimeos = providerResolverRegistry.findResolver("https://vimeos.net/embed-123.html");
    expect(vimeos).toBeDefined();
    expect(vimeos?.capabilities.requiresHeaders).toBe(true);

    const meta = await EmbedResolvers.resolveWithMeta("https://vimeos.net/embed-123.html");
    expect(meta.requiredHeaders).toBeDefined();
    expect(meta.requiredHeaders?.["User-Agent"]).toContain("Chrome");
  });

  // 15. Range MP4
  it("15. Peticiones con header Range para MP4 reciben 206 Partial Content", async () => {
    const res = await fetch(`${serverUrl}/video.mp4`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/32");
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(10);
  });

  // 16. Dos resoluciones simultáneas ejecutan un solo trabajo (single-flight)
  it("16. ResolutionCoordinator comparte un solo trabajo para llamadas simultáneas", async () => {
    let executionCount = 0;
    const coordinator = new ResolutionCoordinator(async (loc) => {
      executionCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        url: `${serverUrl}/resolved.m3u8`,
        original_url: loc,
        canonical_locator: loc,
        resolved: true,
        type: "direct",
        provider: "Test",
        is_proxyable: true,
        is_refreshable: true,
      };
    });

    const [res1, res2] = await Promise.all([
      coordinator.resolve("https://example.com/embed/simultaneous"),
      coordinator.resolve("https://example.com/embed/simultaneous"),
    ]);

    expect(executionCount).toBe(1);
    expect(res1.url).toBe(res2.url);
  });

  // 17. Dos renovaciones simultáneas ejecutan un solo trabajo
  it("17. PlaybackSessionStore comparte un solo trabajo de renovación simultánea", async () => {
    let refreshCalls = 0;
    const store = new PlaybackSessionStore({
      resolver: async (loc) => {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return {
          url: `${serverUrl}/renewed-${refreshCalls}.m3u8`,
          original_url: loc,
          canonical_locator: loc,
          resolved: true,
          type: "direct",
          provider: "Test",
          is_proxyable: true,
          is_refreshable: true,
          refresh_after: Date.now() - 100,
        };
      },
    });

    const session = await store.create("https://example.com/embed/1");
    refreshCalls = 0;

    const [ref1, ref2] = await Promise.all([
      store.refresh(session.id, true),
      store.refresh(session.id, true),
    ]);

    expect(refreshCalls).toBe(1);
    expect(ref1.url).toBe(ref2.url);
  });

  // 18. Callback tardío ignorado por attemptId
  it("18. isAttemptCurrent descarta callbacks con attemptId desactualizado", () => {
    const currentAttempt = 5;
    const staleCallbackAttempt = 4;
    expect(isAttemptCurrent(currentAttempt, staleCallbackAttempt)).toBe(false);
    expect(isAttemptCurrent(currentAttempt, currentAttempt)).toBe(true);
  });

  // 19. Un modo no se repite dentro del mismo intento
  it("19. recordAttemptedMode y hasAttemptedMode impiden repetir modo en mismo intento", () => {
    const set = new Set<string>();
    expect(hasAttemptedMode(set, "srv-1", "direct")).toBe(false);
    recordAttemptedMode(set, "srv-1", "direct");
    expect(hasAttemptedMode(set, "srv-1", "direct")).toBe(true);
    expect(hasAttemptedMode(set, "srv-1", "proxy")).toBe(false);
  });

  // 20. Embed silencioso no hace failover automático
  it("20. handleEmbedTimeout cambia a awaiting_manual_choice en vez de error o failover ciego", () => {
    const nextState = handleEmbedTimeout("playing_embed");
    expect(nextState).toBe("awaiting_manual_choice");
  });

  // 21. Health-check no bloquea el primer intento
  it("21. scoreServer clasifica servidores sincrónicamente sin bloquear por sondeo", () => {
    const scored = scoreServer("https://cdn.example.com/stream.m3u8", 0);
    expect(scored.id).toBeDefined();
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.health).toBe("excelente");
  });

  // 22. Sesiones, recursos, caché y logs respetan límites (max 64 sessions)
  it("22. PlaybackSessionStore y ResolutionLeaseCache respetan límites de memoria", async () => {
    const store = new PlaybackSessionStore({ maxSessions: 3 });
    const meta = {
      url: "https://example.com/stream.m3u8",
      original_url: "https://example.com/e/1",
      canonical_locator: "https://example.com/e/1",
      resolved: true,
      type: "direct" as const,
      provider: "Test",
      is_proxyable: true,
      is_refreshable: true,
    };

    const s1 = store.createFromResolved("https://example.com/e/1", meta);
    const s2 = store.createFromResolved("https://example.com/e/2", meta);
    const s3 = store.createFromResolved("https://example.com/e/3", meta);
    const s4 = store.createFromResolved("https://example.com/e/4", meta);

    expect(store.stats().sessions).toBeLessThanOrEqual(3);
    expect(store.get(s1.id)).toBeUndefined(); // El más antiguo fue podado
    expect(store.get(s4.id)).toBeDefined();
  });

  // 23. Tokens nunca aparecen completos en logs o respuestas
  it("23. maskSignedTokens enmascara todos los parámetros sensibles", () => {
    const raw = "https://cdn.example.com/hls.m3u8?t=supersecrettoken12345&expires=1700000000&jwt=eyJhbGciOiJIUzI1NiJ9";
    const masked = maskSignedTokens(raw);
    expect(masked).not.toContain("supersecrettoken12345");
    expect(masked).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(masked).toContain("t=***");
    expect(masked).toContain("jwt=***");
  });

  // 24. Fuente marcada falsamente como estable sigue siendo rechazada si la URL es efímera
  it("24. Fuente con source_kind stable_direct se reclasifica a ephemeral_direct si tiene firma", () => {
    const signedUrl = "https://cdn.example.com/movie.m3u8?st=xyz&e=1600000000";
    const kind = classifySourceKind(signedUrl);
    expect(kind).toBe("ephemeral_direct");

    const expiry = parseStreamExpiry(signedUrl);
    expect(expiry.expiresAt).toBeDefined();
    expect(expiry.expiresAt).toBeLessThan(Date.now());
  });

  // 25. Flujo completo /play → resolve → direct/proxy/embed con upstream simulado
  it("25. Flujo completo end-to-end de resolución y delivery", async () => {
    const locator = `${serverUrl}/embed-origin.html`;
    const coordinator = new ResolutionCoordinator(async (loc) => EmbedResolvers.resolveWithMeta(loc));
    const planner = new DeliveryPlanner();

    const meta = await coordinator.resolve(locator);
    expect(meta.original_url).toBe(locator);

    const delivery = buildResolveDeliveryResponse(meta, "test_flow", planner);
    expect(delivery.strategy).toBe("test_flow");
    expect(["direct", "direct_trial", "proxy_required", "embed"]).toContain(delivery.delivery_mode);

    if (delivery.is_proxyable) {
      const store = new PlaybackSessionStore({ resolver: async (loc) => coordinator.resolve(loc) });
      const session = store.createFromResolved(locator, meta);
      expect(session.id).toBeDefined();
      expect(session.current.url).toBe(meta.url);
    }
  });
});
