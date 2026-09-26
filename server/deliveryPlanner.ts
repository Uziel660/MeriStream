import type { ResolvedStreamMeta } from "./resolvers";
import { createResolutionTiming } from "./resolutionMetadata";
import { hasExplicitHostProfile } from "./hostProfiles";

export type DeliveryMode = "direct" | "direct_trial" | "proxy_required" | "embed";

export interface DeliveryPlannerOptions {
  /** Provider names that have been verified to play directly in a browser. */
  directProviders?: readonly string[];
  /** Provider names that should use the server relay before exposing a CDN to the browser. */
  proxyProviders?: readonly string[];
  /** Exact hosts or parent domains that have been verified to support browser playback. */
  directHosts?: readonly string[];
}

const normalizeIdentity = (value: string | undefined): string => (value || "").trim().toLowerCase();

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

function matchesHost(hostname: string, configuredHost: string): boolean {
  const candidate = normalizeIdentity(configuredHost).replace(/^\.+|\.+$/g, "");
  return candidate.length > 0 && (hostname === candidate || hostname.endsWith(`.${candidate}`));
}

/**
 * Classifies how the browser should receive a resolved stream. Defaults are
 * intentionally conservative: an unknown direct host gets a cheap browser trial,
 * while any required upstream header goes straight to the on-demand proxy.
 */
export class DeliveryPlanner {
  private readonly directProviders: ReadonlySet<string>;
  private readonly proxyProviders: ReadonlySet<string>;
  private readonly directHosts: readonly string[];

  constructor(options: DeliveryPlannerOptions = {}) {
    this.directProviders = new Set((options.directProviders ?? []).map(normalizeIdentity).filter(Boolean));
    // Estos proveedores suelen entregar URLs firmadas, hotlink-protected o
    // inestables. Relaying them desde MeriStream evita que el móvil dependa
    // directamente del CDN externo. La lista es deliberadamente acotada.
    this.proxyProviders = new Set([
      "doramasflix",
      "streamtape",
      "streamtape cdn",
      "doodstream",
      "doodstream cdn",
      "vidhide",
      "vidhide cdn",
      ...(options.proxyProviders ?? []),
    ].map(normalizeIdentity).filter(Boolean));
    this.directHosts = Object.freeze([...(options.directHosts ?? [])]);
  }

  classify(meta: Readonly<ResolvedStreamMeta>): DeliveryMode {
    if (!meta.resolved || meta.is_proxyable === false || meta.type === "embed") return "embed";
    if (meta.requiredHeaders && Object.keys(meta.requiredHeaders).length > 0) return "proxy_required";
    if (hasExplicitHostProfile(meta.url)) return "proxy_required";

    const provider = normalizeIdentity(meta.provider);
    if (provider && [...this.proxyProviders].some((candidate) =>
      provider === candidate || provider.includes(candidate) || candidate.includes(provider),
    )) return "proxy_required";

    if (this.directProviders.has(normalizeIdentity(meta.provider))) return "direct";
    const hostname = hostnameOf(meta.url);
    if (hostname && this.directHosts.some((known) => matchesHost(hostname, known))) return "direct";

    return "direct_trial";
  }
}

export interface ResolveDeliveryResponse extends ResolvedStreamMeta {
  strategy: string;
  delivery_mode: DeliveryMode;
}

/** Produces an API-safe value without handing callers the resolver's mutable object. */
export function buildResolveDeliveryResponse(
  meta: Readonly<ResolvedStreamMeta>,
  strategy: string,
  planner: DeliveryPlanner,
): ResolveDeliveryResponse {
  const is_proxyable = meta.is_proxyable ?? (meta.resolved && meta.type !== "embed");
  const is_refreshable = meta.is_refreshable ?? Boolean(meta.canonical_locator);
  return {
    ...meta,
    is_proxyable,
    is_refreshable,
    requiredHeaders: meta.requiredHeaders ? { ...meta.requiredHeaders } : undefined,
    strategy,
    delivery_mode: planner.classify(meta),
  };
}

export interface ResolutionLeaseCacheOptions {
  /** Small by default because this cache is metadata-only and targets a 2 GB host. */
  maxEntries?: number;
  now?: () => number;
}

export type LightweightResolver = (locator: string) => Promise<ResolvedStreamMeta>;

export interface ResolutionCoordinatorOptions extends ResolutionLeaseCacheOptions {}

interface ResolutionLease {
  readonly meta: Readonly<ResolvedStreamMeta>;
  readonly validUntil: number;
}

function cloneMeta(meta: Readonly<ResolvedStreamMeta>): ResolvedStreamMeta {
  return {
    ...meta,
    requiredHeaders: meta.requiredHeaders ? { ...meta.requiredHeaders } : undefined,
    subtitles: meta.subtitles ? meta.subtitles.map((track) => ({ ...track })) : undefined,
  };
}

function freezeMeta(meta: Readonly<ResolvedStreamMeta>): Readonly<ResolvedStreamMeta> {
  const copy = cloneMeta(meta);
  if (copy.requiredHeaders) Object.freeze(copy.requiredHeaders);
  return Object.freeze(copy);
}

/**
 * Bounded server-side lease cache for on-demand proxy creation.
 *
 * Retrieval always requires both the opaque resolution id and its stable locator.
 * The transient upstream media URL is deliberately never accepted as a locator.
 */
export class ResolutionLeaseCache {
  private readonly leases = new Map<string, ResolutionLease>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ResolutionLeaseCacheOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 128));
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.cleanup();
    return this.leases.size;
  }

  put(meta: Readonly<ResolvedStreamMeta>): boolean {
    const resolutionId = meta.resolution_id?.trim() || "";
    const originalUrl = meta.original_url?.trim() || "";
    const canonicalLocator = meta.canonical_locator?.trim() || "";
    const refreshBoundary = meta.is_refreshable ? meta.refresh_after : meta.expires_at;
    const validUntil = Math.min(refreshBoundary ?? Number.NaN, meta.expires_at ?? Number.NaN);
    if (
      meta.is_proxyable === false || !resolutionId || !originalUrl ||
      (meta.is_refreshable && !canonicalLocator) ||
      !Number.isFinite(validUntil) || validUntil <= this.now()
    ) return false;

    this.cleanup();
    this.leases.delete(resolutionId);
    this.leases.set(resolutionId, { meta: freezeMeta(meta), validUntil });
    this.enforceLimit();
    return true;
  }

  /**
   * Returns a defensive copy only when `locator` is the original embed/page URL
   * or its canonical equivalent. It never authorizes lookup by `meta.url`.
   */
  get(resolutionId: string, locator: string): ResolvedStreamMeta | undefined {
    // Las rutas HTTP son datos no confiables aunque el tipo compile como string.
    // Normalizar aquí evita que una petición incompleta convierta un error 4xx
    // en "Cannot read properties of undefined (reading 'trim')".
    const id = typeof resolutionId === "string" ? resolutionId.trim() : "";
    const requestedLocator = typeof locator === "string" ? locator.trim() : "";
    if (!id || !requestedLocator) return undefined;

    const lease = this.leases.get(id);
    if (!lease) return undefined;
    if (this.now() >= lease.validUntil) {
      this.leases.delete(id);
      return undefined;
    }

    const originalUrl = lease.meta.original_url?.trim() || "";
    const canonicalLocator = lease.meta.canonical_locator?.trim();
    if (requestedLocator !== originalUrl && requestedLocator !== canonicalLocator) return undefined;

    // Map insertion order is the LRU order. A successful authorized read is a touch.
    this.leases.delete(id);
    this.leases.set(id, lease);
    return cloneMeta(lease.meta);
  }

  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, lease] of this.leases) {
      if (now >= lease.validUntil) {
        this.leases.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.leases.clear();
  }

  private enforceLimit(): void {
    while (this.leases.size > this.maxEntries) {
      const oldest = this.leases.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.leases.delete(oldest);
    }
  }
}

/**
 * Small resolver coordinator used by `/resolve-embed`: fresh metadata is reused by
 * stable locator and concurrent requests for the same locator share one HTTP job.
 * The resolver is injected so this module never pulls a browser or provider runtime
 * into production on its own.
 */
export class ResolutionCoordinator {
  private readonly leases: ResolutionLeaseCache;
  private readonly resolver: LightweightResolver;
  private readonly locatorIndex = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<Readonly<ResolvedStreamMeta>>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(resolver: LightweightResolver, options: ResolutionCoordinatorOptions = {}) {
    this.resolver = resolver;
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 128));
    this.now = options.now ?? Date.now;
    this.leases = new ResolutionLeaseCache({ maxEntries: this.maxEntries, now: this.now });
  }

  async resolve(locator: string): Promise<ResolvedStreamMeta> {
    const stableLocator = typeof locator === "string" ? locator.trim() : "";
    if (!stableLocator) throw new TypeError("A non-empty stable locator is required");

    const cachedId = this.locatorIndex.get(stableLocator);
    if (cachedId) {
      const cached = this.leases.get(cachedId, stableLocator);
      if (cached) {
        this.touchLocator(stableLocator, cachedId);
        return cached;
      }
      this.locatorIndex.delete(stableLocator);
    }

    let shared = this.inFlight.get(stableLocator);
    if (!shared) {
      shared = this.resolveAndStore(stableLocator);
      this.inFlight.set(stableLocator, shared);
      void shared.finally(() => {
        if (this.inFlight.get(stableLocator) === shared) this.inFlight.delete(stableLocator);
      }).catch(() => undefined);
    }

    return cloneMeta(await shared);
  }

  /** Safe bridge for `POST /playback/sessions`; still requires the stable locator. */
  getByResolutionId(resolutionId: string, locator: string): ResolvedStreamMeta | undefined {
    return this.leases.get(resolutionId, locator);
  }

  /**
   * Registers metadata produced by a specialized extractor that already did
   * the network work outside `resolve()`. The stable locator is kept as the
   * authorization key so a later playback-session request can reuse the exact
   * signed URL instead of resolving the provider page a second time.
   */
  rememberResolved(meta: Readonly<ResolvedStreamMeta>, stableLocator?: string): ResolvedStreamMeta {
    const locator = (stableLocator || meta.canonical_locator || meta.original_url || "").trim();
    if (!locator || !meta.resolved || !meta.url || meta.is_proxyable === false) return cloneMeta(meta);

    const hasCompleteTiming = Boolean(
      meta.resolution_id?.trim() &&
      Number.isFinite(meta.resolved_at) &&
      Number.isFinite(meta.refresh_after) &&
      Number.isFinite(meta.expires_at)
    );
    const timing = hasCompleteTiming ? undefined : createResolutionTiming({
      originalUrl: locator,
      upstreamUrl: meta.url,
      provider: meta.provider,
      now: this.now(),
      resolutionId: meta.resolution_id,
    });
    const remembered = freezeMeta({
      ...meta,
      original_url: locator,
      canonical_locator: meta.canonical_locator || locator,
      is_proxyable: meta.is_proxyable ?? true,
      is_refreshable: meta.is_refreshable ?? true,
      ...(timing || {}),
    });
    if (this.leases.put(remembered)) {
      const resolutionId = remembered.resolution_id?.trim();
      const originalUrl = remembered.original_url?.trim();
      if (resolutionId && originalUrl) this.indexLocator(originalUrl, resolutionId);
      if (resolutionId && remembered.canonical_locator) this.indexLocator(remembered.canonical_locator, resolutionId);
    }
    return cloneMeta(remembered);
  }

  clear(): void {
    this.leases.clear();
    this.locatorIndex.clear();
  }

  private async resolveAndStore(locator: string): Promise<Readonly<ResolvedStreamMeta>> {
    const raw = await this.resolver(locator);
    const hasCompleteTiming = Boolean(
      raw.resolution_id?.trim() &&
      Number.isFinite(raw.resolved_at) &&
      Number.isFinite(raw.refresh_after) &&
      Number.isFinite(raw.expires_at)
    );
    const timing = raw.resolved && raw.url && !hasCompleteTiming
      ? createResolutionTiming({
          originalUrl: raw.original_url || locator,
          upstreamUrl: raw.url,
          provider: raw.provider,
          now: this.now(),
          resolutionId: raw.resolution_id,
        })
      : undefined;
    const isProxyable = raw.is_proxyable ?? (raw.resolved && raw.type !== "embed");
    const isRefreshable = raw.is_refreshable ?? Boolean(raw.canonical_locator);
    const resolved = freezeMeta({
      ...(timing ? { ...raw, ...timing } : raw),
      is_proxyable: isProxyable,
      is_refreshable: isRefreshable,
    });
    if (this.leases.put(resolved)) {
      const resolutionId = resolved.resolution_id?.trim();
      const originalUrl = resolved.original_url?.trim();
      if (resolutionId && originalUrl) this.indexLocator(originalUrl, resolutionId);
      if (resolutionId && resolved.canonical_locator) this.indexLocator(resolved.canonical_locator, resolutionId);
    }
    return resolved;
  }

  private indexLocator(locator: string, resolutionId: string): void {
    const stableLocator = typeof locator === "string" ? locator.trim() : "";
    if (!stableLocator) return;
    this.touchLocator(stableLocator, resolutionId);
    while (this.locatorIndex.size > this.maxEntries) {
      const oldest = this.locatorIndex.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.locatorIndex.delete(oldest);
    }
  }

  private touchLocator(locator: string, resolutionId: string): void {
    this.locatorIndex.delete(locator);
    this.locatorIndex.set(locator, resolutionId);
  }
}
