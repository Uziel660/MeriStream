import * as crypto from "crypto";
import type { RequestHandler } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EmbedResolvers, type ResolvedStreamMeta } from "./resolvers";
import { buildPlaybackHeaders } from "./hostProfiles";
import { createResolutionTiming } from "./resolutionMetadata";

export type PlaybackResolver = (originalUrl: string) => Promise<ResolvedStreamMeta>;

interface PlaybackResource {
  /** Never exposed to a client: the opaque key is all a browser receives. */
  upstreamUrl: string;
  rootRelative?: string;
  parentResourceId?: string;
  parentRelative?: string;
  registeredGeneration?: string;
  registeredBaseUrl?: string;
}

export interface PlaybackSession {
  id: string;
  original_url: string;
  current: ResolvedStreamMeta;
  created_at: number;
  last_accessed_at: number;
  resources: Map<string, PlaybackResource>;
}

export interface PlaybackSessionStoreOptions {
  resolver?: PlaybackResolver;
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxResourcesPerSession?: number;
}

export interface PlaybackRelayContext {
  sessionId: string;
  kind: "manifest" | "resource";
}

export interface PlaybackRelayResult extends PlaybackRelayContext {
  status?: number;
  error?: unknown;
}

export interface PlaybackRelayHooks {
  onRelayStart?: (context: PlaybackRelayContext) => void;
  onRelayEnd?: (result: PlaybackRelayResult) => void;
}

/**
 * In-memory session boundary for HLS. It intentionally stores the signed upstream
 * URL only server-side; callers route clients using `id` plus opaque resource keys.
 * Replace this store with Redis for multi-process deployments without changing its API.
 */
export class PlaybackSessionStore {
  private readonly sessions = new Map<string, PlaybackSession>();
  private readonly refreshing = new Map<string, Promise<ResolvedStreamMeta>>();
  private readonly resolver: PlaybackResolver;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly maxSessions: number;
  private readonly maxResourcesPerSession: number;

  constructor(options: PlaybackSessionStoreOptions = {}) {
    this.resolver = options.resolver ?? ((url) => EmbedResolvers.resolveWithMeta(url));
    this.now = options.now ?? (() => Date.now());
    this.sessionTtlMs = Math.max(1, options.sessionTtlMs ?? 45 * 60 * 1000);
    this.maxSessions = Math.max(1, options.maxSessions ?? 64);
    this.maxResourcesPerSession = Math.max(1, options.maxResourcesPerSession ?? 300);
  }

  async create(originalUrl: string): Promise<PlaybackSession> {
    const current = await this.resolver(originalUrl);
    return this.createFromResolved(originalUrl, current);
  }

  /**
   * Opens a session from an already-resolved response (for example `/resolve-embed`)
   * so the caller does not pay for a second resolver pass.
   */
  createFromResolved(originalUrl: string, current: ResolvedStreamMeta): PlaybackSession {
    const requestedOriginal = (originalUrl || "").trim();
    if (!requestedOriginal) throw new Error("Falta el origen de reproducción");
    if (!current.resolved || !current.url) throw new Error("No se pudo resolver un stream reproducible");
    if (current.is_proxyable === false) throw new Error("El stream no admite entrega proxy");
    const hasCompleteTiming = Boolean(
      current.resolution_id?.trim() &&
      Number.isFinite(current.resolved_at) &&
      Number.isFinite(current.refresh_after) &&
      Number.isFinite(current.expires_at)
    );
    const normalized = hasCompleteTiming ? current : {
      ...current,
      ...createResolutionTiming({
        originalUrl: current.original_url || requestedOriginal,
        upstreamUrl: current.url,
        provider: current.provider,
        now: this.now(),
        resolutionId: current.resolution_id,
      }),
    };
    // A signed direct URL is not renewable, but it is still proxyable while its
    // token remains valid. Rejecting it here makes every CORS-protected HLS fail
    // even though a short-lived proxy session could serve it correctly.
    const now = this.now();
    if (Number.isFinite(normalized.expires_at) && now >= normalized.expires_at!) {
      throw new Error("El stream firmado ya expiró");
    }
    this.pruneSessions(now, 1);
    const session: PlaybackSession = {
      id: crypto.randomUUID(), original_url: normalized.canonical_locator || requestedOriginal, current: normalized,
      created_at: now, last_accessed_at: now, resources: new Map(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): PlaybackSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.now() - session.last_accessed_at > this.sessionTtlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    session.last_accessed_at = this.now();
    // Map insertion order is our cheap session LRU index.
    this.sessions.delete(id);
    this.sessions.set(id, session);
    return session;
  }

  /** Cheap operational counters; no signed URLs or resource data are exposed. */
  stats(): { sessions: number; refreshing: number; resources: number } {
    this.pruneSessions(this.now());
    let resources = 0;
    for (const session of this.sessions.values()) resources += session.resources.size;
    return { sessions: this.sessions.size, refreshing: this.refreshing.size, resources };
  }

  async upstream(id: string): Promise<ResolvedStreamMeta> {
    const session = this.require(id);
    const now = this.now();
    if (Number.isFinite(session.current.expires_at) && now >= session.current.expires_at!) {
      if (session.current.is_refreshable && session.current.canonical_locator) return this.refresh(id, true);
      throw new Error("La sesión firmada expiró y no tiene localizador renovable");
    }
    if (
      session.current.is_refreshable && session.current.canonical_locator &&
      Number.isFinite(session.current.refresh_after) && now >= session.current.refresh_after!
    ) return this.refresh(id);
    return session.current;
  }

  async refresh(id: string, force = false): Promise<ResolvedStreamMeta> {
    const session = this.require(id);
    if (!session.current.is_refreshable || !session.current.canonical_locator) {
      throw new Error("La sesión no tiene un localizador renovable");
    }
    if (!force && this.now() < session.current.refresh_after!) return session.current;
    const inFlight = this.refreshing.get(id);
    if (inFlight) return inFlight;
    const work = this.resolver(session.original_url).then((next) => {
      if (!next.resolved || !next.url || next.is_proxyable === false) {
        throw new Error("No se pudo renovar la sesión de reproducción");
      }
      session.current = next;
      return next;
    }).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, work);
    return work;
  }

  /** Retry trigger for proxies after the upstream rejects an expired token. */
  async refreshForUpstreamStatus(id: string, status: number): Promise<ResolvedStreamMeta | undefined> {
    if (status !== 401 && status !== 403) return undefined;
    const session = this.require(id);
    if (!session.current.is_refreshable || !session.current.canonical_locator) return undefined;
    return this.refresh(id, true);
  }

  registerResource(id: string, resource: PlaybackResource): string {
    const session = this.require(id);
    // Deterministic opaque IDs deduplicate repeated live/media playlist reloads.
    // Without this, each refresh would grow the resource map indefinitely.
    const key = crypto.createHash("sha256")
      .update(JSON.stringify(resource))
      .digest("base64url")
      .slice(0, 24);
    if (session.resources.has(key)) {
      session.resources.delete(key);
    } else if (session.resources.size >= this.maxResourcesPerSession) {
      const oldest = session.resources.keys().next().value;
      if (oldest) session.resources.delete(oldest);
    }
    session.resources.set(key, resource);
    return key;
  }

  resourceUrl(id: string, key: string, relativePath?: string): string | undefined {
    const session = this.get(id);
    const resource = session?.resources.get(key);
    if (!session || !resource) return undefined;
    // Refresh resource recency while preserving its deterministic opaque ID.
    session.resources.delete(key);
    session.resources.set(key, resource);
    const base = this.resolveResourceUrl(session, key, new Set());
    if (!base || !relativePath) return base;
    // DASH templates are kept in the browser-facing path (for example
    // `segment-$Number$.m4s`) and arrive here after the player expands the
    // template. Never accept an absolute URL as a suffix.
    if (/^[a-z][a-z\d+.-]*:/i.test(relativePath) || relativePath.startsWith("//")) return undefined;
    try {
      const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
      const child = new URL(relativePath.replace(/^\/+/, ""), baseUrl);
      // Some CDNs put the auth token on the directory URL. Carry it forward
      // unless the template supplied its own query string.
      if (!child.search && baseUrl.search) child.search = baseUrl.search;
      return child.toString();
    } catch {
      return undefined;
    }
  }

  rewriteManifest(id: string, manifest: string, parentUrl: string, pathPrefix = "/api/v1/playback", parentResourceId?: string): string {
    return manifest.split(/\r?\n/).map((line) => {
      const value = line.trim();
      if (!value) return line;
      // HLS places signed sub-resources both on their own line and inside URI
      // attributes (#EXT-X-KEY, #EXT-X-MAP, I-FRAME-STREAM-INF, ...).
      if (value.startsWith("#")) {
        return line.replace(/URI=("([^"]*)"|([^,\s]*))/gi, (match, quoted: string, quotedValue: string | undefined, bareValue: string | undefined) => {
          const opaque = this.toOpaqueResource(id, quotedValue ?? bareValue, parentUrl, pathPrefix, parentResourceId);
          return opaque ? `URI=${quoted ? `"${opaque}"` : opaque}` : match;
        });
      }
      return this.toOpaqueResource(id, value, parentUrl, pathPrefix, parentResourceId) ?? line;
    }).join("\n");
  }

  /**
   * Rewrites an MPD to opaque resource paths while preserving DASH URL
   * templates. A BaseURL becomes an internal directory; media and
   * initialization attributes then resolve through the same session resource
   * endpoint after dash.js expands `$Number$`, `$Time$`, etc.
   */
  rewriteDashManifest(id: string, manifest: string, parentUrl: string, pathPrefix = "/api/v1/playback", parentResourceId?: string): string {
    const baseKeyCache = new Map<string, string>();
    const rootBase = (() => {
      try {
        const url = new URL(parentUrl);
        url.pathname = url.pathname.replace(/[^/]*$/, "");
        url.hash = "";
        return url.toString();
      } catch {
        return parentUrl;
      }
    })();
    const opaqueBase = (value: string, baseUrl: string): string | undefined => {
      try {
        const absolute = new URL(value, baseUrl).toString();
        const keyBase = absolute.endsWith("/") ? absolute : `${absolute}/`;
        let key = baseKeyCache.get(keyBase);
        if (!key) {
          const generation = this.require(id).current.generation;
          key = this.registerResource(id, {
            upstreamUrl: keyBase,
            registeredGeneration: generation,
            registeredBaseUrl: baseUrl,
            ...(parentResourceId ? { parentResourceId, parentRelative: value } : { rootRelative: value }),
          });
          baseKeyCache.set(keyBase, key);
        }
        return `${pathPrefix}/${encodeURIComponent(id)}/resource/${encodeURIComponent(key)}/`;
      } catch {
        return undefined;
      }
    };
    const opaqueTemplate = (value: string, baseUrl: string): string | undefined => {
      try {
        const absolute = new URL(value, baseUrl).toString();
        const parsed = new URL(absolute);
        const slash = parsed.pathname.lastIndexOf("/");
        const directory = `${parsed.origin}${slash >= 0 ? parsed.pathname.slice(0, slash + 1) : "/"}`;
        const suffix = `${slash >= 0 ? parsed.pathname.slice(slash + 1) : parsed.pathname}${parsed.search}${parsed.hash}`;
        const base = opaqueBase(directory, baseUrl);
        if (!base) return undefined;
        // Keep DASH placeholders readable so dash.js can expand them before
        // issuing the request; encode the rest to avoid changing query syntax.
        const encodedSuffix = encodeURIComponent(suffix).replace(/%24/g, "$");
        return `${base}${encodedSuffix}`;
      } catch {
        return undefined;
      }
    };

    let sawBaseUrl = false;
    let rewritten = manifest.replace(/(<BaseURL\b[^>]*>)([^<]+)(<\/BaseURL>)/gi, (match, open, value, close) => {
      const opaque = opaqueBase(String(value).trim(), parentUrl);
      if (!opaque) return match;
      sawBaseUrl = true;
      return `${open}${opaque}${close}`;
    });

    // Relative templates can use the rewritten BaseURL directly. Absolute
    // templates (or MPDs with no BaseURL) need their own opaque directory.
    rewritten = rewritten.replace(/\b(media|initialization|sourceURL)=("|')([^"']+)("|')/gi, (match, attr, quote, value) => {
      const raw = String(value);
      const isAbsolute = /^https?:\/\//i.test(raw);
      if (!isAbsolute && sawBaseUrl) return match;
      const replacement = opaqueTemplate(raw, sawBaseUrl ? parentUrl : rootBase);
      return replacement ? `${attr}=${quote}${replacement}${quote}` : match;
    });
    return rewritten;
  }

  private toOpaqueResource(id: string, value: string, parentUrl: string, pathPrefix: string, parentResourceId?: string): string | undefined {
    if (!value) return undefined;
    try {
      const absolute = new URL(value, parentUrl).toString();
      const generation = this.require(id).current.generation;
      const key = this.registerResource(id, {
        upstreamUrl: absolute,
        registeredGeneration: generation,
        registeredBaseUrl: parentUrl,
        ...(parentResourceId ? { parentResourceId, parentRelative: value } : { rootRelative: value }),
      });
      return `${pathPrefix}/${encodeURIComponent(id)}/resource/${encodeURIComponent(key)}`;
    } catch { return undefined; }
  }

  private resolveResourceUrl(session: PlaybackSession, key: string, seen: Set<string>): string | undefined {
    if (seen.has(key)) return undefined;
    seen.add(key);
    const resource = session.resources.get(key);
    if (!resource) return undefined;
    if (resource.rootRelative) {
      if (/^https?:\/\//i.test(resource.rootRelative) && resource.registeredGeneration === session.current.generation) {
        return resource.upstreamUrl;
      }
      return this.rebaseResource(resource.rootRelative, session.current.url, resource.registeredBaseUrl);
    }
    if (resource.parentResourceId && resource.parentRelative) {
      if (/^https?:\/\//i.test(resource.parentRelative) && resource.registeredGeneration === session.current.generation) {
        return resource.upstreamUrl;
      }
      const parent = this.resolveResourceUrl(session, resource.parentResourceId, seen);
      return parent ? this.rebaseResource(resource.parentRelative, parent, resource.registeredBaseUrl) : undefined;
    }
    return resource.upstreamUrl;
  }

  private rebaseResource(locator: string, refreshedBase: string, registeredBase?: string): string {
    if (!/^https?:\/\//i.test(locator)) return new URL(locator, refreshedBase).toString();
    const oldResource = new URL(locator);
    const renewedBase = new URL(refreshedBase);
    // Absolute child URLs often repeat the root token. On renewal, retain the
    // child's suffix but use the renewed directory, host and query instead of
    // replaying the exact URL that already returned 403.
    const oldBase = registeredBase ? new URL(registeredBase) : undefined;
    const oldDirectory = oldBase ? oldBase.pathname.replace(/[^/]*$/, "") : "";
    const renewedDirectory = renewedBase.pathname.replace(/[^/]*$/, "");
    renewedBase.pathname = oldDirectory && oldResource.pathname.startsWith(oldDirectory)
      ? `${renewedDirectory}${oldResource.pathname.slice(oldDirectory.length)}`
      : oldResource.pathname;
    renewedBase.hash = oldResource.hash;
    return renewedBase.toString();
  }

  private require(id: string): PlaybackSession {
    const session = this.get(id);
    if (!session) throw new Error("Sesión de reproducción no encontrada o expirada");
    return session;
  }

  private pruneSessions(now: number, reserveSlots = 0): void {
    for (const [id, session] of this.sessions) {
      if (now - session.last_accessed_at > this.sessionTtlMs) this.sessions.delete(id);
    }
    const targetSize = Math.max(0, this.maxSessions - reserveSlots);
    while (this.sessions.size > targetSize) {
      const oldestId = this.sessions.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.sessions.delete(oldestId);
    }
  }
}

function isManifest(response: Response, url: string): boolean {
  return /mpegurl|dash\+xml/i.test(response.headers.get("content-type") || "") || /\.(?:m3u8|mpd)(?:\?|$)/i.test(url);
}

function isDashManifest(response: Response, url: string): boolean {
  return /dash\+xml/i.test(response.headers.get("content-type") || "") || /\.mpd(?:\?|$)/i.test(url);
}

async function readManifestLimited(response: Response, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Manifiesto HLS/DASH demasiado grande");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Manifiesto HLS/DASH demasiado grande");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (bytes > maxBytes) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Express-ready handlers. Mount them as:
 * `GET /api/v1/playback/:sessionId/master.m3u8` and
 * `GET /api/v1/playback/:sessionId/resource/:resourceId`.
 */
export function createPlaybackSessionHandlers(
  store: PlaybackSessionStore,
  pathPrefix = "/api/v1/playback",
  hooks: PlaybackRelayHooks = {},
): {
  masterManifest: RequestHandler; resource: RequestHandler;
} {
  const proxy = (root: boolean): RequestHandler => async (req, res, next) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const context: PlaybackRelayContext = {
      sessionId: String(req.params.sessionId || ""),
      kind: root ? "manifest" : "resource",
    };
    let status: number | undefined;
    let relayError: unknown;
    req.once("aborted", abort);
    res.once("close", () => { if (!res.writableEnded) abort(); });
    // Observability must never be able to break playback.
    try { hooks.onRelayStart?.(context); } catch { /* best-effort hook */ }
    try {
      const sessionId = context.sessionId;
      const resourceId = String(req.params.resourceId || req.params[1] || "");
      const resourcePathRaw = !root
        ? String(req.params.resourcePath || req.params[2] || req.query.path || "")
        : "";
      let resourcePath = resourcePathRaw;
      try { resourcePath = decodeURIComponent(resourcePathRaw); } catch { /* keep raw */ }
      const url = root
        ? (await store.upstream(sessionId)).url
        : store.resourceUrl(sessionId, resourceId, resourcePath || undefined);
      if (!url) { res.sendStatus(404); return; }
      const session = store.get(sessionId);
      if (!session) { res.sendStatus(404); return; }
      const fetchUpstream = async (target: string) => {
        const range = req.header("range");
        const merged = buildPlaybackHeaders(
          target,
          session.original_url,
          session.current.requiredHeaders,
          range || undefined,
        );
        return fetch(target, { headers: new Headers(merged.headers), signal: controller.signal });
      };
      let upstream = await fetchUpstream(url);
      if (upstream.status === 401 || upstream.status === 403) {
        const refreshed = await store.refreshForUpstreamStatus(sessionId, upstream.status);
        // resourceUrl replays its relative locator against the new root, avoiding a
        // retry of the exact signed absolute URL that just returned 401/403.
        if (refreshed) {
          await upstream.body?.cancel();
          const renewed = root ? refreshed.url : store.resourceUrl(sessionId, resourceId);
          if (renewed) upstream = await fetchUpstream(renewed);
        }
      }
      status = upstream.status;
      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (isManifest(upstream, upstream.url || url)) {
        const body = await readManifestLimited(upstream);
        // The manifest body is rewritten, therefore an upstream byte length/range
        // would be incorrect even though those headers are preserved for media.
        res.removeHeader("content-length");
        res.removeHeader("content-range");
        const dash = isDashManifest(upstream, upstream.url || url);
        const rewritten = dash
          ? store.rewriteDashManifest(sessionId, body, upstream.url || url, pathPrefix, root ? undefined : resourceId)
          : store.rewriteManifest(sessionId, body, upstream.url || url, pathPrefix, root ? undefined : resourceId);
        res.status(upstream.status).type(dash ? "application/dash+xml" : "application/vnd.apple.mpegurl").send(rewritten);
        return;
      }
      if (!upstream.body) { res.status(upstream.status).end(); return; }
      res.status(upstream.status);
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } catch (error) {
      relayError = error;
      if (!controller.signal.aborted && !res.headersSent) next(error);
    } finally {
      req.removeListener("aborted", abort);
      try {
        hooks.onRelayEnd?.({ ...context, status, ...(relayError === undefined ? {} : { error: relayError }) });
      } catch { /* best-effort hook */ }
    }
  };
  return { masterManifest: proxy(true), resource: proxy(false) };
}
