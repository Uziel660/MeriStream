import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "node:http";
import { AddressInfo } from "node:net";

/**
 * Interface contract definitions according to PROJECT.md and TEST_INFRA.md:
 * - Auth routes (/api/auth/*): 10 req/min per IP
 * - Search routes (/api/v1/catalog/search): 30 req/min per IP
 * - Catalog browsing (/api/v1/catalog/public): 120 req/min per IP
 * - Playback & Media Proxy (/api/v1/playback/*, /api/v1/proxy/*, /api/v1/play/*): 200 req/min per IP
 * - Reports (/api/v1/reports): 10 req / 5 min (300s)
 * - Watch Party REST (/api/rooms/*): 20 req/min per IP
 * - General fallback (all other routes): 150 req/min per IP (skips dedicated tiers)
 * - Standard headers: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After
 * - Status code on limit breach: HTTP 429 Too Many Requests
 * - Body on limit breach: JSON { error: string, retryAfter: number }
 * - CORS exposed headers: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After
 */

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  message?: string;
  skip?: (req: Request) => boolean;
  keyGenerator?: (req: Request) => string;
  now?: () => number;
}

export interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export function createMemoryRateLimiter(options: RateLimiterOptions) {
  const store = new Map<string, RateLimitRecord>();
  const nowFn = options.now || (() => Date.now());

  const keyGenerator = options.keyGenerator || ((req: Request) => {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const firstIp = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
      if (firstIp) return firstIp;
    }
    return req.ip || req.socket?.remoteAddress || "127.0.0.1";
  });

  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (options.skip && options.skip(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const now = nowFn();

    let record = store.get(key);
    if (!record || now >= record.resetTime) {
      record = {
        count: 0,
        resetTime: now + options.windowMs,
      };
      store.set(key, record);
    }

    record.count++;
    const remaining = Math.max(0, options.max - record.count);
    const resetSeconds = Math.ceil(Math.max(0, record.resetTime - now) / 1000);

    res.setHeader("RateLimit-Limit", String(options.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSeconds));

    if (record.count > options.max) {
      const retryAfterSeconds = Math.max(1, resetSeconds);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: options.message || "Too many requests, please try again later.",
        retryAfter: retryAfterSeconds,
      });
    }

    next();
  };

  middleware.reset = () => store.clear();
  return middleware;
}

describe("E2E API Rate Limiter Test Suite (Tiers 1-4)", () => {
  let server: http.Server;
  let baseUrl: string;
  let simulatedTime = Date.now();

  const getSimulatedTime = () => simulatedTime;
  const advanceTime = (ms: number) => {
    simulatedTime += ms;
  };

  // Dedicated limiters instantiated per specifications
  const authLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 10,
    now: getSimulatedTime,
    message: "Demasiados intentos de autenticación. Por favor intente más tarde.",
  });

  const searchLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    now: getSimulatedTime,
    message: "Límite de búsquedas excedido. Reduzca la frecuencia de consultas.",
  });

  const catalogLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    now: getSimulatedTime,
    message: "Límite de navegación del catálogo excedido.",
  });

  const playbackLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 200,
    now: getSimulatedTime,
    message: "Límite de streaming y reproducción excedido.",
  });

  const reportsLimiter = createMemoryRateLimiter({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10,
    now: getSimulatedTime,
    message: "Límite de reportes excedido. Máximo 10 reportes cada 5 minutos.",
  });

  const roomsLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    now: getSimulatedTime,
    message: "Límite de creación y gestión de salas excedido.",
  });

  // Dedicated tier paths to skip in general fallback
  const isDedicatedTierRoute = (req: Request): boolean => {
    const p = req.path;
    return (
      p.startsWith("/api/auth/") ||
      p === "/api/v1/catalog/search" ||
      p === "/api/v1/catalog/public" ||
      p.startsWith("/api/v1/playback/") ||
      p.startsWith("/api/v1/proxy/") ||
      p.startsWith("/api/v1/play/") ||
      p === "/api/v1/reports" ||
      p.startsWith("/api/rooms")
    );
  };

  const fallbackLimiter = createMemoryRateLimiter({
    windowMs: 60 * 1000,
    max: 150,
    now: getSimulatedTime,
    skip: isDedicatedTierRoute,
    message: "Límite general de solicitudes excedido.",
  });

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", true);

    // CORS configuration with exposed rate limit headers
    app.use(
      cors({
        origin: "*",
        credentials: true,
        allowedHeaders: ["Content-Type", "Authorization", "X-Forwarded-For"],
        exposedHeaders: [
          "Content-Range",
          "Accept-Ranges",
          "Content-Length",
          "Content-Type",
          "RateLimit-Limit",
          "RateLimit-Remaining",
          "RateLimit-Reset",
          "Retry-After",
        ],
      })
    );

    app.use(express.json());

    // Mount fallback limiter first so it processes all un-skipped routes
    app.use(fallbackLimiter);

    // Mount dedicated tier limiters
    app.use("/api/auth", authLimiter);
    app.use("/api/v1/catalog/search", searchLimiter);
    app.use("/api/v1/catalog/public", catalogLimiter);
    app.use("/api/v1/playback", playbackLimiter);
    app.use("/api/v1/proxy", playbackLimiter);
    app.use("/api/v1/play", playbackLimiter);
    app.use("/api/v1/reports", reportsLimiter);
    app.use("/api/rooms", roomsLimiter);

    // Dummy test endpoints
    app.post("/api/auth/login", (req, res) => {
      const { username, password } = req.body || {};
      if (username === "alice" && password === "correctpass") {
        return res.json({ success: true, token: "test_jwt_token" });
      }
      return res.status(401).json({ error: "Credenciales inválidas" });
    });

    app.post("/api/auth/register", (_req, res) => {
      res.json({ success: true, message: "User registered" });
    });

    app.get("/api/v1/catalog/search", (req, res) => {
      res.json({ query: req.query.q, results: [] });
    });

    app.get("/api/v1/catalog/public", (_req, res) => {
      res.json({ shows: [{ id: "show-1", title: "Test Show" }] });
    });

    app.get("/api/v1/playback/:id", (req, res) => {
      res.json({ streamUrl: `https://cdn.example.com/hls/${req.params.id}.m3u8` });
    });

    app.get("/api/v1/proxy/segment.ts", (_req, res) => {
      res.setHeader("Content-Type", "video/mp2t");
      res.send(Buffer.from([0x47, 0x40, 0x00, 0x10]));
    });

    app.post("/api/v1/reports", (req, res) => {
      res.json({ received: true, reportId: "rep-123" });
    });

    app.get("/api/rooms", (_req, res) => {
      res.json({ rooms: [] });
    });

    app.get("/api/misc/status", (_req, res) => {
      res.json({ status: "healthy" });
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
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  beforeEach(() => {
    // Reset all stores and synchronize simulated time
    simulatedTime = 1700000000000;
    authLimiter.reset();
    searchLimiter.reset();
    catalogLimiter.reset();
    playbackLimiter.reset();
    reportsLimiter.reset();
    roomsLimiter.reset();
    fallbackLimiter.reset();
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE (7 Tiers + Standard RateLimit Headers)
  // =========================================================================

  describe("Tier 1: Feature Coverage by Quota Tier", () => {
    it("T1.1: Auth tier allows up to 10 req/min and blocks the 11th with HTTP 429", async () => {
      const clientIp = "192.168.1.10";

      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": clientIp,
          },
          body: JSON.stringify({ username: `user_${i}` }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("RateLimit-Limit")).toBe("10");
        expect(res.headers.get("RateLimit-Remaining")).toBe(String(10 - i));
      }

      // 11th request must be rejected with 429
      const res11 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ username: "overflow_user" }),
      });

      expect(res11.status).toBe(429);
      expect(res11.headers.get("RateLimit-Remaining")).toBe("0");
      expect(res11.headers.get("Retry-After")).toBeDefined();

      const body = await res11.json();
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("retryAfter");
      expect(body.retryAfter).toBeGreaterThan(0);
    });

    it("T1.2: Search tier allows 30 req/min and blocks 31st with HTTP 429", async () => {
      const clientIp = "192.168.1.11";

      for (let i = 1; i <= 30; i++) {
        const res = await fetch(`${baseUrl}/api/v1/catalog/search?q=test_${i}`, {
          headers: { "X-Forwarded-For": clientIp },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("RateLimit-Limit")).toBe("30");
        expect(res.headers.get("RateLimit-Remaining")).toBe(String(30 - i));
      }

      const breach = await fetch(`${baseUrl}/api/v1/catalog/search?q=overflow`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(breach.status).toBe(429);
      const data = await breach.json();
      expect(data.error).toContain("búsquedas");
    });

    it("T1.3: Catalog browsing tier allows 120 req/min and blocks 121st with HTTP 429", async () => {
      const clientIp = "192.168.1.12";

      // Execute 120 requests
      const batchSize = 30;
      for (let b = 0; b < 120; b += batchSize) {
        const promises = Array.from({ length: batchSize }, () =>
          fetch(`${baseUrl}/api/v1/catalog/public`, {
            headers: { "X-Forwarded-For": clientIp },
          })
        );
        const results = await Promise.all(promises);
        results.forEach((r) => expect(r.status).toBe(200));
      }

      const breach = await fetch(`${baseUrl}/api/v1/catalog/public`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(breach.status).toBe(429);
      expect(breach.headers.get("RateLimit-Limit")).toBe("120");
      expect(breach.headers.get("RateLimit-Remaining")).toBe("0");
    });

    it("T1.4: Playback tier allows 200 req/min across /playback and /proxy", async () => {
      const clientIp = "192.168.1.13";

      // 100 on /playback and 100 on /proxy = 200 total
      const reqs1 = Array.from({ length: 100 }, () =>
        fetch(`${baseUrl}/api/v1/playback/stream1`, {
          headers: { "X-Forwarded-For": clientIp },
        })
      );
      const resList1 = await Promise.all(reqs1);
      resList1.forEach((r) => expect(r.status).toBe(200));

      const reqs2 = Array.from({ length: 100 }, () =>
        fetch(`${baseUrl}/api/v1/proxy/segment.ts`, {
          headers: { "X-Forwarded-For": clientIp },
        })
      );
      const resList2 = await Promise.all(reqs2);
      resList2.forEach((r) => expect(r.status).toBe(200));

      // 201st request
      const breach = await fetch(`${baseUrl}/api/v1/playback/stream1`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(breach.status).toBe(429);
      expect(breach.headers.get("RateLimit-Limit")).toBe("200");
    });

    it("T1.5: Reports tier enforces strict 10 requests per 5-minute quota", async () => {
      const clientIp = "192.168.1.14";

      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${baseUrl}/api/v1/reports`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": clientIp,
          },
          body: JSON.stringify({ issue: `Broken stream ${i}` }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("RateLimit-Limit")).toBe("10");
        expect(res.headers.get("RateLimit-Remaining")).toBe(String(10 - i));
      }

      const breach = await fetch(`${baseUrl}/api/v1/reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": clientIp,
        },
        body: JSON.stringify({ issue: "Overflow" }),
      });
      expect(breach.status).toBe(429);
      const body = await breach.json();
      expect(body.error).toContain("reportes");
      expect(body.retryAfter).toBeGreaterThan(0);
    });

    it("T1.6: Watch Party REST tier enforces 20 req/min on /api/rooms/*", async () => {
      const clientIp = "192.168.1.15";

      for (let i = 1; i <= 20; i++) {
        const res = await fetch(`${baseUrl}/api/rooms`, {
          headers: { "X-Forwarded-For": clientIp },
        });
        expect(res.status).toBe(200);
      }

      const breach = await fetch(`${baseUrl}/api/rooms`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(breach.status).toBe(429);
      expect(breach.headers.get("RateLimit-Limit")).toBe("20");
    });

    it("T1.7: General fallback limiter enforces 150 req/min on unclassified routes", async () => {
      const clientIp = "192.168.1.16";

      // 150 requests on /api/misc/status
      const batch = 50;
      for (let i = 0; i < 150; i += batch) {
        const promises = Array.from({ length: batch }, () =>
          fetch(`${baseUrl}/api/misc/status`, {
            headers: { "X-Forwarded-For": clientIp },
          })
        );
        const results = await Promise.all(promises);
        results.forEach((r) => expect(r.status).toBe(200));
      }

      const breach = await fetch(`${baseUrl}/api/misc/status`, {
        headers: { "X-Forwarded-For": clientIp },
      });
      expect(breach.status).toBe(429);
      expect(breach.headers.get("RateLimit-Limit")).toBe("150");
    });

    it("T1.8: All rate limited responses format headers with valid non-negative integers", async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "10.0.0.50",
        },
        body: JSON.stringify({ username: "sample" }),
      });

      const limit = Number(res.headers.get("RateLimit-Limit"));
      const remaining = Number(res.headers.get("RateLimit-Remaining"));
      const reset = Number(res.headers.get("RateLimit-Reset"));

      expect(Number.isInteger(limit)).toBe(true);
      expect(Number.isInteger(remaining)).toBe(true);
      expect(Number.isInteger(reset)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(reset).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // =========================================================================

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: Precise boundary progression (9th allows -> 10th allows with remaining 0 -> 11th blocks)", async () => {
      const ip = "192.168.2.1";

      // 1st through 8th
      for (let i = 1; i <= 8; i++) {
        await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ username: `u_${i}` }),
        });
      }

      // 9th request
      const res9 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "u_9" }),
      });
      expect(res9.status).toBe(200);
      expect(res9.headers.get("RateLimit-Remaining")).toBe("1");

      // 10th request (last permitted)
      const res10 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "u_10" }),
      });
      expect(res10.status).toBe(200);
      expect(res10.headers.get("RateLimit-Remaining")).toBe("0");

      // 11th request (boundary breach)
      const res11 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "u_11" }),
      });
      expect(res11.status).toBe(429);
      expect(res11.headers.get("RateLimit-Remaining")).toBe("0");
      expect(res11.headers.get("Retry-After")).toBe("60");
    });

    it("T2.2: Counter resets cleanly after window expires", async () => {
      const ip = "192.168.2.2";

      // Exhaust auth quota
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ username: `u_${i}` }),
        });
      }

      // Verify blocked
      const blockedRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "blocked" }),
      });
      expect(blockedRes.status).toBe(429);

      // Advance time beyond 60-second window
      advanceTime(61 * 1000);

      // Now request must succeed with fresh window
      const resetRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "fresh_start" }),
      });
      expect(resetRes.status).toBe(200);
      expect(resetRes.headers.get("RateLimit-Remaining")).toBe("9");
    });

    it("T2.3: Different IPs maintain strictly independent rate limit counters", async () => {
      const ipVictim = "192.168.2.3";
      const ipInnocent = "192.168.2.4";

      // Exhaust quota for ipVictim
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ipVictim },
          body: JSON.stringify({ username: `victim_${i}` }),
        });
      }

      // ipVictim is blocked
      const victimRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ipVictim },
        body: JSON.stringify({ username: "victim_fail" }),
      });
      expect(victimRes.status).toBe(429);

      // ipInnocent is completely unaffected
      const innocentRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ipInnocent },
        body: JSON.stringify({ username: "innocent_user" }),
      });
      expect(innocentRes.status).toBe(200);
      expect(innocentRes.headers.get("RateLimit-Remaining")).toBe("9");
    });

    it("T2.4: Fallback to socket IP when X-Forwarded-For header is omitted", async () => {
      const res = await fetch(`${baseUrl}/api/v1/catalog/public`);
      expect(res.status).toBe(200);
      expect(res.headers.get("RateLimit-Limit")).toBe("120");
      expect(res.headers.get("RateLimit-Remaining")).toBeDefined();
    });

    it("T2.5: Correctly extracts primary client IP from multi-hop X-Forwarded-For proxy chain", async () => {
      const clientIp = "203.0.113.195";
      const proxyChain = `${clientIp}, 198.51.100.1, 192.0.2.1`;

      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": proxyChain,
          },
          body: JSON.stringify({ username: `hop_${i}` }),
        });
      }

      // 11th request with same primary client IP via different proxy chain
      const differentProxies = `${clientIp}, 10.0.0.1`;
      const breachRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": differentProxies,
        },
        body: JSON.stringify({ username: "hop_11" }),
      });
      expect(breachRes.status).toBe(429);
    });

    it("T2.6: RateLimit-Remaining monotonically decrements with every sequential request", async () => {
      const ip = "192.168.2.10";
      let previousRemaining = 10;

      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ username: `seq_${i}` }),
        });
        const currentRemaining = Number(res.headers.get("RateLimit-Remaining"));
        expect(currentRemaining).toBe(previousRemaining - 1);
        previousRemaining = currentRemaining;
      }
      expect(previousRemaining).toBe(0);
    });
  });

  // =========================================================================
  // TIER 3: CROSS-TIER ISOLATION
  // =========================================================================

  describe("Tier 3: Cross-Tier Isolation", () => {
    it("T3.1: Auth flood on IP does NOT block catalog browsing or playback on same IP", async () => {
      const ip = "192.168.3.1";

      // 1. Flood auth endpoint until blocked
      for (let i = 0; i < 12; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ username: "attacker", password: "bad" }),
        });
      }

      // Verify auth is indeed blocked with 429
      const authCheck = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ username: "attacker", password: "bad" }),
      });
      expect(authCheck.status).toBe(429);

      // 2. Catalog request on same IP must succeed with 200
      const catalogRes = await fetch(`${baseUrl}/api/v1/catalog/public`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(catalogRes.status).toBe(200);
      expect(catalogRes.headers.get("RateLimit-Limit")).toBe("120");

      // 3. Playback request on same IP must succeed with 200
      const playbackRes = await fetch(`${baseUrl}/api/v1/playback/movie-123`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(playbackRes.status).toBe(200);
      expect(playbackRes.headers.get("RateLimit-Limit")).toBe("200");
    });

    it("T3.2: General fallback exhaustion does NOT block playback or rooms tiers", async () => {
      const ip = "192.168.3.2";

      // Exhaust general fallback (150 limit)
      for (let i = 0; i < 151; i++) {
        await fetch(`${baseUrl}/api/misc/status`, {
          headers: { "X-Forwarded-For": ip },
        });
      }

      // Verify general fallback is blocked
      const fallbackCheck = await fetch(`${baseUrl}/api/misc/status`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(fallbackCheck.status).toBe(429);

      // Playback tier must remain completely open
      const playbackRes = await fetch(`${baseUrl}/api/v1/playback/show-456`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(playbackRes.status).toBe(200);

      // Rooms tier must remain completely open
      const roomRes = await fetch(`${baseUrl}/api/rooms`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(roomRes.status).toBe(200);
    });

    it("T3.3: Playback tier exhaustion does NOT prematurely block general fallback", async () => {
      const ip = "192.168.3.3";

      // Exhaust playback quota (200 requests)
      const batch = 50;
      for (let b = 0; b < 200; b += batch) {
        await Promise.all(
          Array.from({ length: batch }, () =>
            fetch(`${baseUrl}/api/v1/playback/hls-chunk`, {
              headers: { "X-Forwarded-For": ip },
            })
          )
        );
      }

      // Verify playback is blocked
      const playbackBreach = await fetch(`${baseUrl}/api/v1/playback/hls-chunk`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(playbackBreach.status).toBe(429);

      // General fallback must still accept requests
      const generalRes = await fetch(`${baseUrl}/api/misc/status`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(generalRes.status).toBe(200);
      expect(generalRes.headers.get("RateLimit-Limit")).toBe("150");
    });

    it("T3.4: Rooms tier exhaustion does NOT block Search tier", async () => {
      const ip = "192.168.3.4";

      // Exhaust rooms tier (20 requests)
      for (let i = 0; i < 21; i++) {
        await fetch(`${baseUrl}/api/rooms`, {
          headers: { "X-Forwarded-For": ip },
        });
      }

      // Verify rooms is blocked
      const roomBreach = await fetch(`${baseUrl}/api/rooms`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(roomBreach.status).toBe(429);

      // Search tier remains available
      const searchRes = await fetch(`${baseUrl}/api/v1/catalog/search?q=movie`, {
        headers: { "X-Forwarded-For": ip },
      });
      expect(searchRes.status).toBe(200);
      expect(searchRes.headers.get("RateLimit-Limit")).toBe("30");
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS
  // =========================================================================

  describe("Tier 4: Real-World Scenarios", () => {
    it("T4.1: Simulated auth brute-force attack blocked with 429 while ongoing playback continues uninterrupted", async () => {
      const victimIp = "203.0.113.88";
      const honestUserIp = "198.51.100.22";

      // 1. Attacker fires 15 rapid failed login attempts
      const attackerPromises = Array.from({ length: 15 }, (_, i) =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": victimIp,
          },
          body: JSON.stringify({
            username: "admin",
            password: `guess_pass_${i}`,
          }),
        })
      );

      const attackerResponses = await Promise.all(attackerPromises);

      // The first 10 requests should be 401 (invalid credentials)
      const allowedFailedLogins = attackerResponses.slice(0, 10);
      allowedFailedLogins.forEach((r) => {
        expect(r.status).toBe(401);
      });

      // Requests 11 through 15 MUST be blocked with 429
      const rateLimitedRequests = attackerResponses.slice(10);
      for (const res of rateLimitedRequests) {
        expect(res.status).toBe(429);
        expect(res.headers.get("RateLimit-Remaining")).toBe("0");
        expect(res.headers.get("Retry-After")).toBeDefined();
        const json = await res.json();
        expect(json).toHaveProperty("error");
        expect(json).toHaveProperty("retryAfter");
        expect(typeof json.retryAfter).toBe("number");
      }

      // 2. Legitimate user on another IP logs in successfully
      const legitLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": honestUserIp,
        },
        body: JSON.stringify({
          username: "alice",
          password: "correctpass",
        }),
      });
      expect(legitLogin.status).toBe(200);
      const legitData = await legitLogin.json();
      expect(legitData.success).toBe(true);

      // 3. User on victim IP can still stream media without interruption
      const streamRes = await fetch(`${baseUrl}/api/v1/playback/session-live-stream`, {
        headers: { "X-Forwarded-For": victimIp },
      });
      expect(streamRes.status).toBe(200);
      const streamData = await streamRes.json();
      expect(streamData.streamUrl).toContain("session-live-stream");
    });

    it("T4.2: High concurrency burst on playback proxy respects quota and does not crash", async () => {
      const ip = "192.168.4.50";

      // Burst of 50 concurrent video segment requests
      const segmentRequests = Array.from({ length: 50 }, () =>
        fetch(`${baseUrl}/api/v1/proxy/segment.ts`, {
          headers: { "X-Forwarded-For": ip },
        })
      );

      const responses = await Promise.all(segmentRequests);
      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("video/mp2t");
      });
    });
  });

  // =========================================================================
  // CORS VERIFICATION
  // =========================================================================

  describe("CORS RateLimit Headers Exposure", () => {
    it("T-CORS.1: Preflight OPTIONS request exposes RateLimit and Retry-After headers in Access-Control-Expose-Headers", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Content-Type, Authorization",
        },
      });

      expect(res.status).toBe(204);
      const exposed = res.headers.get("Access-Control-Expose-Headers") || "";
      expect(exposed.toLowerCase()).toContain("ratelimit-limit");
      expect(exposed.toLowerCase()).toContain("ratelimit-remaining");
      expect(exposed.toLowerCase()).toContain("ratelimit-reset");
      expect(exposed.toLowerCase()).toContain("retry-after");
    });

    it("T-CORS.2: Standard GET responses expose RateLimit headers to cross-origin clients", async () => {
      const res = await fetch(`${baseUrl}/api/v1/catalog/public`, {
        headers: {
          Origin: "http://localhost:5173",
        },
      });

      expect(res.status).toBe(200);
      const exposed = res.headers.get("Access-Control-Expose-Headers") || "";
      expect(exposed).toContain("RateLimit-Limit");
      expect(exposed).toContain("RateLimit-Remaining");
      expect(exposed).toContain("RateLimit-Reset");

      // Verify the headers themselves are accessible
      expect(res.headers.get("RateLimit-Limit")).toBe("120");
      expect(res.headers.get("RateLimit-Remaining")).toBeDefined();
    });

    it("T-CORS.3: Blocked HTTP 429 response exposes Retry-After header via CORS", async () => {
      const ip = "10.0.0.99";

      // Exhaust auth
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
          body: JSON.stringify({ username: "u", password: "p" }),
        });
      }

      const blockedRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:5173",
          "Content-Type": "application/json",
          "X-Forwarded-For": ip,
        },
        body: JSON.stringify({ username: "u", password: "p" }),
      });

      expect(blockedRes.status).toBe(429);
      const exposed = blockedRes.headers.get("Access-Control-Expose-Headers") || "";
      expect(exposed).toContain("Retry-After");
      expect(blockedRes.headers.get("Retry-After")).toBeDefined();
    });
  });
});
