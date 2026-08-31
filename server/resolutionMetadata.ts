import * as crypto from "crypto";

/** Metadata attached to a transient CDN URL. All times are Unix milliseconds. */
export interface ResolutionTiming {
  original_url: string;
  resolved_at: number;
  expires_at: number;
  refresh_after: number;
  resolution_id: string;
  /** Alias useful for consumers that model each refresh as a generation. */
  generation: string;
  expiration_source: "query" | "jwt" | "provider-soft-ttl";
}

const MIN_PLAUSIBLE_EXPIRY_MS = Date.UTC(2020, 0, 1);
const MAX_PLAUSIBLE_EXPIRY_MS = Date.UTC(2100, 0, 1);

function toEpochMs(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "" || !/^\d+(?:\.\d+)?$/.test(String(value))) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  // Epoch seconds are normally ten digits; larger values are milliseconds.
  const ms = numeric < 100_000_000_000 ? Math.round(numeric * 1000) : Math.round(numeric);
  return ms >= MIN_PLAUSIBLE_EXPIRY_MS && ms <= MAX_PLAUSIBLE_EXPIRY_MS ? ms : undefined;
}

function jwtExpiration(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[1].length > 8_192) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown };
    return toEpochMs(typeof payload.exp === "number" || typeof payload.exp === "string" ? payload.exp : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Reads only conventional explicit expiry fields. Unknown numeric query values are
 * deliberately ignored so an unrelated ID cannot accidentally shorten a stream.
 */
export function parseStreamExpiry(url: string): { expiresAt?: number; source?: "query" | "jwt" } {
  try {
    const parsed = new URL(url);

    // Vimeos (y CDNs similares) firman URLs con s=<epoch inicio>&e=<TTL segundos>:
    // la expiración es (s + e) * 1000 ms. Ambos parámetros deben estar presentes.
    const sParam = parsed.searchParams.get("s");
    const eParam = parsed.searchParams.get("e");
    const isVimeos = /(^|\.)vimeos\.[a-z]+$/i.test(parsed.hostname);
    if (sParam && eParam) {
      const sNum = Number(sParam);
      const eNum = Number(eParam);
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0) {
        const expiresAt = toEpochMs(sNum + eNum);
        if (expiresAt) return { expiresAt, source: "query" };
      }
    }

    for (const key of ["expires", "expiry", "exp", ...(isVimeos ? [] : ["e"])]) {
      const value = parsed.searchParams.get(key);
      const expiresAt = value ? toEpochMs(value) : undefined;
      if (expiresAt) return { expiresAt, source: "query" };
    }

    // Signed providers commonly put a compact JWT in one of these parameters.
    for (const key of ["token", "jwt", "access_token", "authorization"]) {
      const value = parsed.searchParams.get(key);
      const expiresAt = value ? jwtExpiration(value.replace(/^Bearer\s+/i, "")) : undefined;
      if (expiresAt) return { expiresAt, source: "jwt" };
    }
  } catch {
    // Resolver callers may pass untrusted/partial URLs; simply fall back to a soft TTL.
  }
  return {};
}

/** Conservative refresh windows when the provider does not publish an expiry. */
export function providerSoftTtlMs(provider: string, upstreamUrl: string): number {
  const identity = `${provider} ${upstreamUrl}`.toLowerCase();
  // Vimeos signed URLs are observed to rotate frequently. Never keep an unlabelled
  // one for the legacy 30 minutes.
  if (identity.includes("vimeos")) return 5 * 60 * 1000;
  if (/dood|voe|streamwish|vidhide|uqload|byse/.test(identity)) return 8 * 60 * 1000;
  return 12 * 60 * 1000;
}

export function createResolutionTiming(input: {
  originalUrl: string;
  upstreamUrl: string;
  provider: string;
  now?: number;
  resolutionId?: string;
}): ResolutionTiming {
  const resolvedAt = input.now ?? Date.now();
  const explicit = parseStreamExpiry(input.upstreamUrl);
  const expiresAt = explicit.expiresAt ?? resolvedAt + providerSoftTtlMs(input.provider, input.upstreamUrl);
  // Keep enough margin to resolve a replacement before a signed URL is rejected.
  const remaining = Math.max(0, expiresAt - resolvedAt);
  const refreshAfter = Math.max(resolvedAt, expiresAt - Math.min(60_000, Math.max(5_000, Math.floor(remaining * 0.2))));
  const resolutionId = input.resolutionId ?? crypto.randomUUID();
  return {
    original_url: input.originalUrl,
    resolved_at: resolvedAt,
    expires_at: expiresAt,
    refresh_after: refreshAfter,
    resolution_id: resolutionId,
    generation: resolutionId,
    expiration_source: explicit.source ?? "provider-soft-ttl",
  };
}

/** `refresh_after` is intentionally the cache boundary, not `expires_at`. */
export function isResolutionFresh(timing: Pick<ResolutionTiming, "refresh_after" | "expires_at">, now = Date.now()): boolean {
  return now < timing.refresh_after && now < timing.expires_at;
}

export function isDirectMedia(url: string): boolean {
  if (!url) return false;
  const u = url.toLowerCase();
  return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u) || u.includes("/m3u8/") || u.includes("hls-vod");
}

export function hasSignedQuery(url: string): boolean {
  try {
    const params = new URL(url).searchParams;
    const sParam = params.get("s");
    const eParam = params.get("e");
    if (sParam && eParam) {
      const sNum = Number(sParam);
      const eNum = Number(eParam);
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0) return true;
    }
    return [
      "t", "token", "jwt", "access_token", "authorization", "expires", "expiry",
      "exp", "sig", "signature", "hash", "auth", "hdnts", "policy",
      "key-pair-id",
    ].some((key) => params.has(key));
  } catch {
    return false;
  }
}

export function classifySourceKind(url: string): "page" | "embed" | "stable_direct" | "ephemeral_direct" {
  const clean = (url || "").trim();
  if (!clean) return "page";
  if (isDirectMedia(clean)) {
    const { expiresAt } = parseStreamExpiry(clean);
    if (expiresAt !== undefined || hasSignedQuery(clean)) {
      return "ephemeral_direct";
    }
    return "stable_direct";
  }
  const lower = clean.toLowerCase();
  if (
    lower.includes("/embed") ||
    lower.includes("/e/") ||
    lower.includes("/v/") ||
    lower.includes("/d/") ||
    lower.includes("mega.nz") ||
    lower.includes("vimeos.") ||
    lower.includes("mp4upload.com") ||
    lower.includes("yourupload.com") ||
    lower.includes("ok.ru") ||
    lower.includes("voe.sx") ||
    lower.includes("voe.") ||
    lower.includes("primeload.co") ||
    lower.includes("byse") ||
    lower.includes("hexload") ||
    lower.includes("streamtape") ||
    lower.includes("streamwish") ||
    lower.includes("dood") ||
    lower.includes("uqload") ||
    lower.includes("vidhide") ||
    lower.includes("goodstream") ||
    lower.includes("fastre") ||
    lower.includes("swhoi") ||
    lower.includes("vidmoly") ||
    lower.includes("upstream") ||
    lower.includes("streamhide") ||
    lower.includes("waaw") ||
    lower.includes("hqq.") ||
    lower.includes("divxplayer") ||
    lower.includes("cvary.org")
  ) {
    return "embed";
  }
  return "page";
}

