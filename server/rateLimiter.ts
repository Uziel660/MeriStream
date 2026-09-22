import rateLimit, { type Options, type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response, NextFunction } from "express";

export interface RateLimiterTierConfig {
  windowMs: number;
  limit: number;
  message?: string;
  skip?: (req: Request, res: Response) => boolean | Promise<boolean>;
  keyGenerator?: (req: Request, res: Response) => string | Promise<string>;
}

export interface TieredLimitersConfig {
  auth?: Partial<RateLimiterTierConfig>;
  search?: Partial<RateLimiterTierConfig>;
  catalogPublic?: Partial<RateLimiterTierConfig>;
  playback?: Partial<RateLimiterTierConfig>;
  reports?: Partial<RateLimiterTierConfig>;
  rooms?: Partial<RateLimiterTierConfig>;
  general?: Partial<RateLimiterTierConfig>;
}

export interface TieredLimiters {
  authLimiter: RateLimitRequestHandler;
  searchLimiter: RateLimitRequestHandler;
  catalogPublicLimiter: RateLimitRequestHandler;
  playbackLimiter: RateLimitRequestHandler;
  reportsLimiter: RateLimitRequestHandler;
  roomsLimiter: RateLimitRequestHandler;
  generalLimiter: RateLimitRequestHandler;
}

/**
 * Fallback IP key generator that avoids undefined IP in test runners or mock requests.
 */
export const defaultKeyGenerator = (req: Request): string => {
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
};

/**
 * Standard HTTP 429 JSON response handler adhering to RFC Draft-7 and MeriStream interface contract.
 */
export const defaultRateLimitHandler = (
  req: Request,
  res: Response,
  _next: NextFunction,
  options: Options
) => {
  const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(429).json({
    error:
      typeof options.message === "string"
        ? options.message
        : "Demasiadas solicitudes. Por favor intente de nuevo más tarde.",
    statusCode: 429,
    retryAfter: retryAfterSeconds,
    retryAfterSeconds: retryAfterSeconds,
  });
};

/**
 * Creates an individual rate limiter using express-rate-limit v7 standards.
 */
export function createRateLimiter(config: RateLimiterTierConfig): RateLimitRequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    validate: {
      trustProxy: false,
      ip: false,
    },
    keyGenerator: config.keyGenerator || defaultKeyGenerator,
    handler: defaultRateLimitHandler,
    message: config.message,
    skip: config.skip,
  });
}

/**
 * Prefixes that bypass the general fallback rate limiter to avoid double-counting
 * and premature throttling on high-throughput routes (e.g. streaming, proxy, public catalog).
 */
export const GENERAL_LIMITER_SKIPPED_PREFIXES = [
  "/api/auth",
  "/auth",
  "/api/v1/catalog/search",
  "/v1/catalog/search",
  "/api/v1/catalog/public",
  "/v1/catalog/public",
  "/api/v1/playback",
  "/v1/playback",
  "/api/v1/proxy",
  "/v1/proxy",
  "/api/v1/play",
  "/v1/play",
  "/api/v1/play-multi",
  "/v1/play-multi",
  "/api/v1/stream",
  "/v1/stream",
  "/api/v1/reports",
  "/v1/reports",
  "/api/rooms",
  "/rooms",
  "/health",
  "/api/v1/health",
  "/assets",
  "/favicon.ico",
];

/**
 * Classifier to skip dedicated route tiers and static/health endpoints in generalLimiter.
 */
export function shouldSkipGeneralLimiter(req: Request): boolean {
  const fullPath = (req.originalUrl || req.url || req.path || "").split("?")[0];
  return GENERAL_LIMITER_SKIPPED_PREFIXES.some((prefix) => fullPath.startsWith(prefix));
}

/**
 * Factory to create all 7 tiered limiters with optional overrides (e.g. micro-windows for testing).
 */
export function createTieredLimiters(
  overrides?: Partial<TieredLimitersConfig>
): TieredLimiters {
  // 1. Auth routes: 10 req/min
  const authConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 10,
    message: "Demasiados intentos de autenticación. Por favor intente de nuevo en 1 minuto.",
    ...overrides?.auth,
  };

  // 2. Search routes: 30 req/min
  const searchConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 30,
    message: "Límite de búsquedas excedido. Por favor espere un momento.",
    ...overrides?.search,
  };

  // 3. Catalog browsing: 120 req/min
  const catalogPublicConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 120,
    message: "Límite de consultas de catálogo excedido. Por favor espere un momento.",
    ...overrides?.catalogPublic,
  };

  // 4. Playback & Media Proxy: 200 req/min
  const playbackConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 200,
    message: "Límite de peticiones de reproducción y streaming excedido. Por favor espere un momento.",
    ...overrides?.playback,
  };

  // 5. Reports: 10 req / 5 min (300,000 ms)
  const reportsConfig: RateLimiterTierConfig = {
    windowMs: 300 * 1000,
    limit: 10,
    message: "Límite de envío de reportes excedido. Máximo 10 reportes cada 5 minutos.",
    ...overrides?.reports,
  };

  // 6. Watch Party REST: 20 req/min
  const roomsConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 20,
    message: "Límite de peticiones de salas de reproducción excedido. Por favor espere un momento.",
    ...overrides?.rooms,
  };

  // 7. General Fallback: 150 req/min with smart skip
  const generalConfig: RateLimiterTierConfig = {
    windowMs: 60 * 1000,
    limit: 150,
    message: "Demasiadas peticiones. Por favor reduzca la frecuencia de navegación.",
    skip: shouldSkipGeneralLimiter,
    ...overrides?.general,
  };

  return {
    authLimiter: createRateLimiter(authConfig),
    searchLimiter: createRateLimiter(searchConfig),
    catalogPublicLimiter: createRateLimiter(catalogPublicConfig),
    playbackLimiter: createRateLimiter(playbackConfig),
    reportsLimiter: createRateLimiter(reportsConfig),
    roomsLimiter: createRateLimiter(roomsConfig),
    generalLimiter: createRateLimiter(generalConfig),
  };
}

// Export singleton instances for production server mounting
const defaultLimiters = createTieredLimiters();
export const authLimiter = defaultLimiters.authLimiter;
export const searchLimiter = defaultLimiters.searchLimiter;
export const catalogPublicLimiter = defaultLimiters.catalogPublicLimiter;
export const playbackLimiter = defaultLimiters.playbackLimiter;
export const reportsLimiter = defaultLimiters.reportsLimiter;
export const roomsLimiter = defaultLimiters.roomsLimiter;
export const generalLimiter = defaultLimiters.generalLimiter;
