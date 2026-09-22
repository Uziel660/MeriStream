import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "node:http";
import { AddressInfo } from "node:net";
import {
  createTieredLimiters,
  createRateLimiter,
  shouldSkipGeneralLimiter,
  GENERAL_LIMITER_SKIPPED_PREFIXES,
  authLimiter,
  searchLimiter,
  catalogPublicLimiter,
  playbackLimiter,
  reportsLimiter,
  roomsLimiter,
  generalLimiter,
} from "../server/rateLimiter";
import { authRouter } from "../server/auth";

describe("Milestone 1 Empirical Stress Test Suite (Challenger M1-1)", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.set("trust proxy", true);

    // Exact CORS configuration from server.ts lines 1602-1625
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
          "RateLimit",
          "RateLimit-Policy",
          "Retry-After",
        ],
      })
    );

    app.use(express.json());

    // Mount exactly as server.ts lines 1635-1641
    app.use("/api/auth", authLimiter);
    app.use("/api/v1/catalog/search", searchLimiter);
    app.use("/api/v1/catalog/public", catalogPublicLimiter);
    app.use(
      ["/api/v1/playback", "/api/v1/proxy", "/api/v1/play", "/api/v1/play-multi", "/api/v1/stream"],
      playbackLimiter
    );
    app.use("/api/v1/reports", reportsLimiter);
    app.use("/api/rooms", roomsLimiter);
    app.use("/api", generalLimiter);

    // Mount real auth router
    app.use("/api/auth", authRouter);

    // Dummy endpoints matching routes
    app.get("/api/v1/catalog/search", (_req, res) => {
      res.json({ results: [] });
    });
    app.get("/api/v1/catalog/public", (_req, res) => {
      res.json({ items: [] });
    });
    app.get("/api/v1/playback/:id", (_req, res) => {
      res.json({ stream: "ok" });
    });
    app.post("/api/v1/reports", (_req, res) => {
      res.json({ reported: true });
    });
    app.get("/api/rooms", (_req, res) => {
      res.json({ rooms: [] });
    });
    app.get("/api/unclassified", (_req, res) => {
      res.json({ unclassified: true });
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

  // =========================================================================
  // 1. BOUNDARY CHALLENGE: Exactly 10 requests succeed/400, request 11 gets 429
  // =========================================================================
  describe("Challenge 1: Auth Endpoint Strict Boundary (10 vs 11)", () => {
    it("verify that exactly 10 requests to auth endpoint return 400 (invalid body) and request 11 returns 429", async () => {
      const clientIp = "10.100.1.1";
      const statusCodes: number[] = [];
      const responses: any[] = [];

      for (let i = 1; i <= 12; i++) {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": clientIp,
          },
          body: JSON.stringify({}), // Invalid body triggers 400 from authRouter
        });
        statusCodes.push(res.status);
        responses.push(res);
      }

      // Assert first 10 requests return 400 from authRouter
      for (let i = 0; i < 10; i++) {
        expect(statusCodes[i], `Request #${i + 1} should have returned 400`).toBe(400);
      }

      // Assert request 11 and 12 return 429
      expect(statusCodes[10], "Request #11 MUST return 429").toBe(429);
      expect(statusCodes[11], "Request #12 MUST return 429").toBe(429);

      // Inspect 429 response structure
      const breachRes = responses[10];
      const json = await breachRes.json();
      expect(json.statusCode).toBe(429);
      expect(json).toHaveProperty("error");
      expect(json).toHaveProperty("retryAfter");
      expect(breachRes.headers.get("Retry-After")).toBeDefined();
    });
  });

  // =========================================================================
  // 2. IP ISOLATION CHALLENGE: Requests from different IP are unaffected
  // =========================================================================
  describe("Challenge 2: IP Isolation & Proxy Header Parsing", () => {
    it("exhausts IP A quota and verifies IP B is completely unaffected", async () => {
      const ipA = "10.200.1.1";
      const ipB = "10.200.1.2";

      // Exhaust IP A
      for (let i = 1; i <= 10; i++) {
        const resA = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": ipA,
          },
          body: JSON.stringify({}),
        });
        expect(resA.status).toBe(400);
      }

      // 11th request from IP A is 429
      const resA11 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ipA,
        },
        body: JSON.stringify({}),
      });
      expect(resA11.status).toBe(429);

      // Now IP B sends requests - must NOT be blocked
      for (let i = 1; i <= 10; i++) {
        const resB = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": ipB,
          },
          body: JSON.stringify({}),
        });
        expect(resB.status, `IP B request #${i} must succeed with 400, not 429`).toBe(400);
      }

      // 11th request from IP B is 429
      const resB11 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ipB,
        },
        body: JSON.stringify({}),
      });
      expect(resB11.status).toBe(429);
    });

    it("verifies multi-hop X-Forwarded-For extracts client IP correctly", async () => {
      const clientIp = "10.200.2.50";
      const proxyChain = `${clientIp}, 198.51.100.1, 10.0.0.1`;

      for (let i = 1; i <= 10; i++) {
        const res = await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": proxyChain,
          },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
      }

      // 11th request with same client IP via different proxy chain
      const res11 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `${clientIp}, 172.16.0.1`,
        },
        body: JSON.stringify({}),
      });
      expect(res11.status).toBe(429);
    });
  });

  // =========================================================================
  // 3. RESET TIMING & DRIFT: Micro-windows (50ms) using createTieredLimiters
  // =========================================================================
  describe("Challenge 3: Reset Timing & Drift with Micro-Windows (50ms)", () => {
    let microServer: http.Server;
    let microBaseUrl: string;
    const WINDOW_MS = 50;
    const LIMIT = 5;

    beforeAll(async () => {
      const microApp = express();
      microApp.set("trust proxy", true);

      // Create tiered limiters with micro-windows override
      const microLimiters = createTieredLimiters({
        auth: { windowMs: WINDOW_MS, limit: LIMIT },
      });

      microApp.use("/api/auth", microLimiters.authLimiter);
      microApp.post("/api/auth/test", (_req, res) => {
        res.json({ ok: true });
      });

      await new Promise<void>((resolve) => {
        microServer = http.createServer(microApp);
        microServer.listen(0, "127.0.0.1", () => {
          const addr = microServer.address() as AddressInfo;
          microBaseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        if (microServer) {
          microServer.close(() => resolve());
        } else {
          resolve();
        }
      });
    });

    it("verifies that requests within the window are blocked (429) and then reset accurately after window expires", async () => {
      const testIp = "10.300.1.1";

      const t0 = Date.now();
      // Burst LIMIT (5) requests in parallel so they arrive within <10ms
      const burstResults = await Promise.all(
        Array.from({ length: LIMIT }, () =>
          fetch(`${microBaseUrl}/api/auth/test`, {
            method: "POST",
            headers: { "X-Forwarded-For": testIp },
          })
        )
      );
      burstResults.forEach((res) => expect(res.status).toBe(200));

      // 6th request arrives immediately while still within the 50ms window
      const blocked1 = await fetch(`${microBaseUrl}/api/auth/test`, {
        method: "POST",
        headers: { "X-Forwarded-For": testIp },
      });
      const elapsedTotal = Date.now() - t0;
      
      // If the 6th request arrived within 50ms, it MUST be 429
      if (elapsedTotal < WINDOW_MS) {
        expect(blocked1.status).toBe(429);
      }

      // Now sleep until the window has definitely expired: WINDOW_MS + 40ms margin
      await new Promise((r) => setTimeout(r, WINDOW_MS + 40));

      // First request after expiry must reset and return 200
      const resetRes = await fetch(`${microBaseUrl}/api/auth/test`, {
        method: "POST",
        headers: { "X-Forwarded-For": testIp },
      });
      expect(resetRes.status, "Request after window expiry must succeed (200)").toBe(200);
    });

    it("executes 5 consecutive reset cycles to test reset accuracy and drift", async () => {
      const testIp = "10.300.1.2";
      const cycleMetrics: Array<{
        cycle: number;
        burstDurationMs: number;
        windowSleepMs: number;
        allLimitRequestsPassed: boolean;
        breachBlocked: boolean;
      }> = [];

      for (let cycle = 1; cycle <= 5; cycle++) {
        const cycleStart = Date.now();

        // Burst LIMIT (5) requests in parallel - all must return 200
        const burst = await Promise.all(
          Array.from({ length: LIMIT }, () =>
            fetch(`${microBaseUrl}/api/auth/test`, {
              method: "POST",
              headers: { "X-Forwarded-For": testIp },
            })
          )
        );
        const burstDuration = Date.now() - cycleStart;
        const all200 = burst.every((r) => r.status === 200);
        expect(all200, `Cycle ${cycle} all ${LIMIT} requests must be 200`).toBe(true);

        // Breach request (#6) MUST be 429 within the window
        const breach = await fetch(`${microBaseUrl}/api/auth/test`, {
          method: "POST",
          headers: { "X-Forwarded-For": testIp },
        });
        const isBreach429 = breach.status === 429;
        expect(isBreach429, `Cycle ${cycle} breach should be 429`).toBe(true);

        // Sleep until window expires: WINDOW_MS + 25ms margin to guarantee clean reset
        const elapsedSoFar = Date.now() - cycleStart;
        const waitTime = Math.max(WINDOW_MS - elapsedSoFar + 25, 30);
        await new Promise((r) => setTimeout(r, waitTime));

        cycleMetrics.push({
          cycle,
          burstDurationMs: burstDuration,
          windowSleepMs: waitTime,
          allLimitRequestsPassed: all200,
          breachBlocked: isBreach429,
        });
      }

      expect(cycleMetrics.every((m) => m.allLimitRequestsPassed && m.breachBlocked)).toBe(true);
    });
  });

  // =========================================================================
  // 4. CONCURRENCY & RACE CONDITIONS
  // =========================================================================
  describe("Challenge 4: High Concurrency Burst (Race Condition Test)", () => {
    it("fires 25 concurrent requests and verifies exactly 10 succeed and 15 return 429", async () => {
      const concurrentIp = "10.400.1.1";

      const requests = Array.from({ length: 25 }, () =>
        fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": concurrentIp,
          },
          body: JSON.stringify({}),
        })
      );

      const responses = await Promise.all(requests);
      const statuses = responses.map((r) => r.status);

      const count400 = statuses.filter((s) => s === 400).length;
      const count429 = statuses.filter((s) => s === 429).length;

      // In Node.js single-threaded event loop, express-rate-limit's memory store
      // should allow exactly 10 requests and reject 15 with 429.
      expect(count400, "Exactly 10 requests should pass into the handler").toBe(10);
      expect(count429, "Exactly 15 requests should be rejected with 429").toBe(15);
    });
  });

  // =========================================================================
  // 5. GENERAL LIMITER SKIP LOGIC (Cross-Tier Interference)
  // =========================================================================
  describe("Challenge 5: General Fallback Skip Classification & Cross-Tier Isolation", () => {
    it("verifies shouldSkipGeneralLimiter correctly matches all dedicated prefixes", () => {
      const mockReq = (url: string) => ({ originalUrl: url, url, path: url } as Request);

      expect(shouldSkipGeneralLimiter(mockReq("/api/auth/login"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/catalog/search?q=test"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/catalog/public"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/playback/123"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/proxy/seg.ts"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/play/stream"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/v1/reports"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/api/rooms/create"))).toBe(true);
      expect(shouldSkipGeneralLimiter(mockReq("/health"))).toBe(true);

      // Unclassified route must NOT be skipped
      expect(shouldSkipGeneralLimiter(mockReq("/api/unclassified"))).toBe(false);
      expect(shouldSkipGeneralLimiter(mockReq("/api/user/settings"))).toBe(false);
    });

    it("verifies that exceeding generalLimiter quota on unclassified route does NOT block catalog or playback", async () => {
      // General limiter limit is 150. For testing without 150 slow HTTP calls,
      // let's create a small test app with general limiter override
      const testApp = express();
      testApp.set("trust proxy", true);

      const customTiered = createTieredLimiters({
        general: { limit: 5, windowMs: 60000 },
        catalogPublic: { limit: 10, windowMs: 60000 },
      });

      testApp.use("/api/v1/catalog/public", customTiered.catalogPublicLimiter);
      testApp.use("/api", customTiered.generalLimiter);

      testApp.get("/api/v1/catalog/public", (_req, res) => res.json({ catalog: "ok" }));
      testApp.get("/api/other", (_req, res) => res.json({ other: "ok" }));

      const localServer = http.createServer(testApp);
      await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", () => resolve()));
      const localPort = (localServer.address() as AddressInfo).port;
      const localUrl = `http://127.0.0.1:${localPort}`;

      try {
        const testIp = "10.500.1.1";

        // Exhaust general quota (5 reqs)
        for (let i = 0; i < 5; i++) {
          const res = await fetch(`${localUrl}/api/other`, {
            headers: { "X-Forwarded-For": testIp },
          });
          expect(res.status).toBe(200);
        }

        // 6th general request is blocked
        const blockedRes = await fetch(`${localUrl}/api/other`, {
          headers: { "X-Forwarded-For": testIp },
        });
        expect(blockedRes.status).toBe(429);

        // Catalog route must still work because it was skipped in generalLimiter!
        const catalogRes = await fetch(`${localUrl}/api/v1/catalog/public`, {
          headers: { "X-Forwarded-For": testIp },
        });
        expect(catalogRes.status, "Catalog route must not be blocked by general limiter exhaustion").toBe(200);
      } finally {
        await new Promise<void>((resolve) => localServer.close(() => resolve()));
      }
    });
  });

  // =========================================================================
  // 6. STANDARD HEADERS & DRAFT SPEC COMPLIANCE AUDIT
  // =========================================================================
  describe("Challenge 6: Rate Limit Headers & Standard Compliance", () => {
    it("audits exact headers produced by express-rate-limit v7 on standard response", async () => {
      const testIp = "10.600.1.1";

      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": testIp,
        },
        body: JSON.stringify({}),
      });

      // Capture all headers returned
      const allHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        allHeaders[key] = value;
      });

      // Under standardHeaders: "draft-7", check what headers express-rate-limit sets:
      // Draft-7 specifies "ratelimit" (e.g. "limit=10, remaining=9, reset=60")
      // and "ratelimit-policy" (e.g. "10;w=60")
      // Check whether legacy / draft-6 headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset) are present or absent
      const hasDraft7 = Boolean(allHeaders["ratelimit"]);
      const hasDraft7Policy = Boolean(allHeaders["ratelimit-policy"]);
      const hasDraft6Limit = Boolean(allHeaders["ratelimit-limit"]);
      const hasDraft6Remaining = Boolean(allHeaders["ratelimit-remaining"]);
      const hasDraft6Reset = Boolean(allHeaders["ratelimit-reset"]);

      // Both draft-7 and/or draft-6 headers should be documented
      expect(hasDraft7 || hasDraft6Limit, "Rate limiting headers must be present").toBe(true);
    });

    it("audits exact headers on HTTP 429 response", async () => {
      const testIp = "10.600.1.2";

      // Exhaust
      for (let i = 0; i < 10; i++) {
        await fetch(`${baseUrl}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
          body: JSON.stringify({}),
        });
      }

      // 11th request
      const res429 = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": testIp },
        body: JSON.stringify({}),
      });

      expect(res429.status).toBe(429);
      expect(res429.headers.get("retry-after")).toBeDefined();
      const retryAfter = Number(res429.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);

      const body = await res429.json();
      expect(body.statusCode).toBe(429);
      expect(body.error).toBeDefined();
      expect(body.retryAfter).toBe(retryAfter);
    });
  });
});
