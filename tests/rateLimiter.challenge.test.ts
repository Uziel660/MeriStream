import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  createTieredLimiters,
  shouldSkipGeneralLimiter,
  GENERAL_LIMITER_SKIPPED_PREFIXES,
} from "../server/rateLimiter";
import { localAllowedOrigins } from "../app.config";

describe("Challenger M1-2: Streaming Throughput, False-Positive Avoidance & CORS Rate Limit Headers", () => {
  let server: http.Server;
  let baseUrl: string;
  let limiters: ReturnType<typeof createTieredLimiters>;

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", true);

    const allowedOrigins = localAllowedOrigins();

    // Replicate server.ts CORS configuration exactly
    app.use(
      cors({
        origin: (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
        credentials: true,
        allowedHeaders: [
          "Content-Type",
          "Authorization",
          "Range",
          "X-Media-Title",
          "X-Media-Provider",
          "X-TMDB-Personal-Key",
          "Accept",
          "Origin",
          "X-Requested-With",
        ],
        exposedHeaders: [
          "Content-Range",
          "Accept-Ranges",
          "Content-Length",
          "Content-Type",
          "RateLimit-Limit",
          "RateLimit-Remaining",
          "RateLimit-Reset",
          "RateLimit",
          "RateLimit-Policy",
          "Retry-After",
        ],
      })
    );

    app.use(express.json());

    // Create fresh tiered limiters matching production defaults
    limiters = createTieredLimiters();

    // Replicate server.ts mounting order exactly
    app.use("/api/auth", limiters.authLimiter);
    app.use("/api/v1/catalog/search", limiters.searchLimiter);
    app.use("/api/v1/catalog/public", limiters.catalogPublicLimiter);
    app.use(
      ["/api/v1/playback", "/api/v1/proxy", "/api/v1/play", "/api/v1/play-multi", "/api/v1/stream"],
      limiters.playbackLimiter
    );
    app.use("/api/v1/reports", limiters.reportsLimiter);
    app.use("/api/rooms", limiters.roomsLimiter);
    app.use("/api", limiters.generalLimiter);

    // Mount mock endpoints for test verification
    app.get("/api/v1/playback/:id", (req: Request, res: Response) => {
      res.json({ success: true, playbackId: req.params.id });
    });

    app.get("/api/v1/proxy/:file", (req: Request, res: Response) => {
      res.setHeader("Content-Type", "video/mp2t");
      res.send(Buffer.from([0x47, 0x40, 0x00, 0x10]));
    });

    app.get("/api/v1/play/:showId", (req: Request, res: Response) => {
      res.json({ success: true, showId: req.params.showId });
    });

    app.get("/api/v1/unskipped/test", (_req: Request, res: Response) => {
      res.json({ success: true, route: "general-fallback" });
    });

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe("1. Streaming Throughput & False-Positive Avoidance (>150 requests)", () => {
    it("verify 160 rapid requests to /api/v1/playback/:id do NOT get blocked at 150 by general fallback limiter", async () => {
      const clientIp = "192.168.1.50";
      const totalRequests = 160;
      let blockedCount = 0;
      let successfulCount = 0;
      let lastHeaders: Record<string, string> = {};

      for (let i = 1; i <= totalRequests; i++) {
        const res = await fetch(`${baseUrl}/api/v1/playback/stream_${i}.m3u8`, {
          headers: { "X-Forwarded-For": clientIp },
        });

        if (res.status === 429) {
          blockedCount++;
        } else if (res.status === 200) {
          successfulCount++;
        }

        if (i === 150 || i === 151 || i === 160) {
          lastHeaders = Object.fromEntries(res.headers.entries());
        }
      }

      // Assertions
      expect(blockedCount).toBe(0);
      expect(successfulCount).toBe(160);

      // Check draft-7 standard headers
      // express-rate-limit v7 sets 'ratelimit' or 'ratelimit-policy'
      const hasRateLimitHeader = Boolean(
        lastHeaders["ratelimit"] ||
        lastHeaders["ratelimit-limit"] ||
        lastHeaders["ratelimit-policy"]
      );
      expect(hasRateLimitHeader).toBe(true);
    });

    it("verify 160 rapid requests to /api/v1/proxy/:file do NOT get blocked at 150", async () => {
      const clientIp = "192.168.1.51";
      const totalRequests = 160;
      let blockedCount = 0;
      let successfulCount = 0;

      for (let i = 1; i <= totalRequests; i++) {
        const res = await fetch(`${baseUrl}/api/v1/proxy/segment_${i}.ts`, {
          headers: { "X-Forwarded-For": clientIp },
        });

        if (res.status === 429) {
          blockedCount++;
        } else if (res.status === 200) {
          successfulCount++;
        }
      }

      expect(blockedCount).toBe(0);
      expect(successfulCount).toBe(160);
    });

    it("verify playback requests do not consume general fallback quota", async () => {
      // client sends 160 requests to playback, then requests a general fallback endpoint
      const clientIp = "192.168.1.52";
      for (let i = 1; i <= 160; i++) {
        const res = await fetch(`${baseUrl}/api/v1/playback/video_${i}.m3u8`, {
          headers: { "X-Forwarded-For": clientIp },
        });
        expect(res.status).toBe(200);
      }

      // Now client requests general fallback route; it must succeed because general limiter was skipped
      const generalRes = await fetch(`${baseUrl}/api/v1/unskipped/test`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(generalRes.status).toBe(200);
      const data = await generalRes.json();
      expect(data.route).toBe("general-fallback");
    });

    it("verify playback limiter DOES block at 201 requests (quota boundary)", async () => {
      const clientIp = "192.168.1.53";
      let status200 = 0;
      let status429 = 0;
      let breachBody: any = null;

      for (let i = 1; i <= 201; i++) {
        const res = await fetch(`${baseUrl}/api/v1/playback/segment_${i}.ts`, {
          headers: { "X-Forwarded-For": clientIp },
        });
        if (res.status === 200) status200++;
        if (res.status === 429) {
          status429++;
          breachBody = await res.json();
        }
      }

      expect(status200).toBe(200);
      expect(status429).toBe(1);
      expect(breachBody?.statusCode).toBe(429);
      expect(breachBody?.error).toContain("reproducción");
    });
  });

  describe("2. CORS Preflight OPTIONS & Rate Limit Header Exposure", () => {
    it("CORS preflight OPTIONS returns 204 with exposed headers configuration", async () => {
      const res = await fetch(`${baseUrl}/api/v1/playback/test.m3u8`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    });

    it("Standard GET response includes Access-Control-Expose-Headers exposing rate limit headers", async () => {
      const res = await fetch(`${baseUrl}/api/v1/playback/test.m3u8`, {
        method: "GET",
        headers: {
          Origin: "http://localhost:5173",
          "X-Forwarded-For": "192.168.1.60",
        },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      const exposedHeaders = res.headers.get("access-control-expose-headers") || "";
      expect(exposedHeaders).toContain("RateLimit-Limit");
      expect(exposedHeaders).toContain("RateLimit-Remaining");
      expect(exposedHeaders).toContain("RateLimit-Reset");
      expect(exposedHeaders).toContain("Retry-After");
    });

    it("CORS preflight OPTIONS requests are NOT throttled or counted by rate limiters", async () => {
      // Send 250 rapid OPTIONS requests (exceeding both general 150 and playback 200 limits)
      const clientIp = "192.168.1.70";
      let count204 = 0;

      for (let i = 1; i <= 250; i++) {
        const res = await fetch(`${baseUrl}/api/v1/playback/test.m3u8`, {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
            "X-Forwarded-For": clientIp,
          },
        });
        if (res.status === 204) count204++;
      }

      expect(count204).toBe(250);

      // Verify that after 250 OPTIONS, the actual GET request still has full 200 quota
      const getRes = await fetch(`${baseUrl}/api/v1/playback/test.m3u8`, {
        method: "GET",
        headers: {
          Origin: "http://localhost:5173",
          "X-Forwarded-For": clientIp,
        },
      });
      expect(getRes.status).toBe(200);
    });

    it("HTTP 429 response exposes Retry-After and RateLimit headers via CORS", async () => {
      const clientIp = "192.168.1.80";
      // Exhaust general limiter (limit 150)
      for (let i = 1; i <= 150; i++) {
        await fetch(`${baseUrl}/api/v1/unskipped/test`, {
          headers: { "X-Forwarded-For": clientIp, Origin: "http://localhost:5173" },
        });
      }

      // 151st request should be blocked
      const blockedRes = await fetch(`${baseUrl}/api/v1/unskipped/test`, {
        headers: { "X-Forwarded-For": clientIp, Origin: "http://localhost:5173" },
      });

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
      const exposed = blockedRes.headers.get("access-control-expose-headers") || "";
      expect(exposed).toContain("Retry-After");
      expect(blockedRes.headers.get("retry-after")).toBeTruthy();
    });
  });

  describe("3. Edge Cases & Boundary Stress Testing", () => {
    it("shouldSkipGeneralLimiter handles query parameters and trailing paths correctly", () => {
      const mockReq = (url: string) => ({ originalUrl: url } as Request);

      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/playback/123"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/playback/manifest.mpd?token=xyz"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/proxy/segment-001.ts?sig=abc"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/play/show-456"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/play-multi/item-789"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/stream/live"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/catalog/public?genre=anime"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/catalog/search?q=naruto"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/rooms/ABC123"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/auth/login"))).toBe(true);

      // Routes that should NOT be skipped
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/users/profile"))).toBe(false);
      expect(shouldSkipGeneralLimiter(mockReq("/api/settings"))).toBe(false);
      expect(shouldSkipGeneralLimiter(mockReq("/api/unknown/endpoint"))).toBe(false);
    });
  });
});
