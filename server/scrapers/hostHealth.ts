// server/scrapers/hostHealth.ts
//
// Host health is deliberately kept independent from the resolver/player. A
// probe is a signal, not a verdict: one timeout makes a host degraded, while a
// circuit is opened only after consecutive failures. Authentication failures
// are token/URL scoped and never blacklist the whole host.

import { buildProxyHeaders } from "../hostProfiles";

export type ProbeState = "unknown" | "checking" | "online" | "degraded" | "offline";

export type HealthReason =
  | "timeout"
  | "auth_expired"
  | "auth_rejected"
  | "invalid_manifest"
  | "http_5xx"
  | "http_4xx"
  | "network_error"
  | "circuit_open"
  | "playback_error"
  | "playback_timeout"
  | "probe_error"
  | "unknown";

export interface ProbeOptions {
  /** Deadline total de la sonda en ms. Si se omite: timeout adaptativo del host. */
  timeoutMs?: number;
  /** Referer del sitio fuente; lo usan los perfiles con refererMode "passthrough". */
  playerReferer?: string;
  /** Inyección para tests y runtimes que proporcionan un cliente HTTP propio. */
  fetch?: typeof fetch;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  state: ProbeState;
  status?: number;
  reason?: HealthReason;
  error?: string;
  fromCache?: boolean;
  cacheStale?: boolean;
  latencyMs?: number;
}

export interface HostHealthSnapshot {
  host: string;
  state: ProbeState;
  reason?: HealthReason;
  consecutiveFailures: number;
  ewmaLatencyMs?: number;
  p95LatencyMs?: number;
  playbackAttempts: number;
  playbackSuccesses: number;
  lastCheckedAt?: number;
  circuitOpenUntil?: number;
}

export interface PlaybackSignal {
  ok: boolean;
  reason?: HealthReason;
  latencyMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 6000;
export const FAILURE_THRESHOLD = 2;
export const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
export const MIN_ADAPTIVE_TIMEOUT_MS = 1200;
export const MAX_ADAPTIVE_TIMEOUT_MS = 35_000;
export const MAX_GLOBAL_PROBES = 2;
export const MAX_PROBES_PER_HOST = 1;

interface HostRecord {
  state: ProbeState;
  reason?: HealthReason;
  consecutiveFailures: number;
  lastFailedAt?: number;
  lastCheckedAt?: number;
  circuitOpenUntil?: number;
  ewmaLatencyMs?: number;
  latencySamples: number[];
  playbackAttempts: number;
  playbackSuccesses: number;
  playbackEwmaLatencyMs?: number;
}

const hostRecords = new Map<string, HostRecord>();
const negativeCache = new Map<string, number>();

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

const globalSemaphore = new Semaphore(MAX_GLOBAL_PROBES);
const hostSemaphores = new Map<string, Semaphore>();

function hostKeyOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function getRecord(url: string): HostRecord {
  const key = hostKeyOf(url);
  let record = hostRecords.get(key);
  if (!record) {
    record = {
      state: "unknown",
      consecutiveFailures: 0,
      latencySamples: [],
      playbackAttempts: 0,
      playbackSuccesses: 0,
    };
    hostRecords.set(key, record);
  }
  return record;
}

function getHostSemaphore(url: string): Semaphore {
  const key = hostKeyOf(url);
  let semaphore = hostSemaphores.get(key);
  if (!semaphore) {
    semaphore = new Semaphore(MAX_PROBES_PER_HOST);
    hostSemaphores.set(key, semaphore);
  }
  return semaphore;
}

function pruneExpired(now: number): void {
  if (hostRecords.size < 500 && negativeCache.size < 500) return;
  for (const [key, rec] of hostRecords) {
    if (rec.lastFailedAt !== undefined && now - rec.lastFailedAt > NEGATIVE_CACHE_TTL_MS) hostRecords.delete(key);
  }
  for (const [key, until] of negativeCache) {
    if (until <= now) negativeCache.delete(key);
  }
}

function ewma(previous: number | undefined, sample: number, alpha = 0.25): number {
  return previous === undefined ? sample : previous * (1 - alpha) + sample * alpha;
}

function recordLatency(record: HostRecord, latencyMs: number): void {
  record.ewmaLatencyMs = ewma(record.ewmaLatencyMs, latencyMs);
  record.latencySamples.push(latencyMs);
  if (record.latencySamples.length > 40) record.latencySamples.shift();
}

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function adaptiveTimeout(url: string, opts: ProbeOptions, profileTimeout: number | undefined): number {
  const record = getRecord(url);
  const configured = opts.timeoutMs ?? profileTimeout ?? DEFAULT_PROBE_TIMEOUT_MS;
  // An explicit deadline is an intentional caller contract (and is useful in
  // deterministic tests), so only adaptive/profile deadlines use the floor.
  if (opts.timeoutMs !== undefined) return Math.max(1, Math.min(MAX_ADAPTIVE_TIMEOUT_MS, opts.timeoutMs));
  const p95 = percentile(record.latencySamples, 0.95);
  const observed = Math.max(record.ewmaLatencyMs ?? 0, (p95 ?? 0) * 1.5);
  return Math.min(MAX_ADAPTIVE_TIMEOUT_MS, Math.max(MIN_ADAPTIVE_TIMEOUT_MS, configured, observed));
}

function reasonForStatus(status: number): HealthReason {
  if (status === 401) return "auth_expired";
  if (status === 403) return "auth_rejected";
  if (status >= 500) return "http_5xx";
  if (status >= 400) return "http_4xx";
  return "probe_error";
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function resultForFailure(
  url: string,
  status: number | undefined,
  reason: HealthReason,
  error: string | undefined,
  latencyMs: number,
  fromCache = false,
): ProbeResult {
  const record = getRecord(url);
  if (reason === "auth_expired" || reason === "auth_rejected") {
    record.state = "degraded";
    record.reason = reason;
    record.lastCheckedAt = Date.now();
    return { url, ok: false, state: "degraded", status, reason, error, latencyMs, fromCache };
  }

  markHostFailed(url, NEGATIVE_CACHE_TTL_MS, reason);
  const current = getRecord(url);
  return {
    url,
    ok: false,
    state: current.state,
    status,
    reason: current.reason ?? reason,
    error,
    latencyMs,
    fromCache,
  };
}

function resultForSuccess(url: string, status: number, latencyMs: number): ProbeResult {
  markHostHealthy(url);
  const record = getRecord(url);
  record.lastCheckedAt = Date.now();
  record.reason = undefined;
  record.state = "online";
  record.consecutiveFailures = 0;
  record.circuitOpenUntil = undefined;
  recordLatency(record, latencyMs);
  return { url, ok: true, state: "online", status, latencyMs };
}

/** ¿El host de esta URL está en circuito abierto vigente? */
export function isHostBlacklisted(url: string): boolean {
  const key = hostKeyOf(url);
  const until = negativeCache.get(key);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    negativeCache.delete(key);
    const record = getRecord(url);
    record.state = "checking";
    record.circuitOpenUntil = undefined;
    return false;
  }
  return true;
}

/** Registra un fallo; el segundo parámetro conserva la API anterior. */
export function markHostFailed(
  url: string,
  ttlMs: number = NEGATIVE_CACHE_TTL_MS,
  reason: HealthReason = "network_error",
): void {
  if (reason === "auth_expired" || reason === "auth_rejected") return;
  const key = hostKeyOf(url);
  const now = Date.now();
  const record = getRecord(url);
  const withinWindow = record.lastFailedAt !== undefined && now - record.lastFailedAt <= NEGATIVE_CACHE_TTL_MS;
  record.consecutiveFailures = withinWindow ? record.consecutiveFailures + 1 : 1;
  record.lastFailedAt = now;
  record.lastCheckedAt = now;
  record.reason = reason;
  record.state = record.consecutiveFailures >= FAILURE_THRESHOLD ? "offline" : "degraded";
  if (record.consecutiveFailures >= FAILURE_THRESHOLD) {
    const until = now + ttlMs;
    negativeCache.set(key, until);
    record.circuitOpenUntil = until;
  }
  pruneExpired(now);
}

/** Limpia fallos y circuito del host tras una respuesta sana. */
export function markHostHealthy(url: string): void {
  const key = hostKeyOf(url);
  const record = getRecord(url);
  record.consecutiveFailures = 0;
  record.state = "online";
  record.reason = undefined;
  record.circuitOpenUntil = undefined;
  record.lastFailedAt = undefined;
  record.lastCheckedAt = Date.now();
  negativeCache.delete(key);
}

/** Snapshot no mutante para métricas, ranking y paneles de administración. */
export function getHostHealth(url: string): HostHealthSnapshot {
  const key = hostKeyOf(url);
  const record = getRecord(url);
  return {
    host: key,
    state: record.state,
    reason: record.reason,
    consecutiveFailures: record.consecutiveFailures,
    ewmaLatencyMs: record.ewmaLatencyMs,
    p95LatencyMs: percentile(record.latencySamples, 0.95),
    playbackAttempts: record.playbackAttempts,
    playbackSuccesses: record.playbackSuccesses,
    lastCheckedAt: record.lastCheckedAt,
    circuitOpenUntil: record.circuitOpenUntil,
  };
}

/** Returns a stable snapshot for every host seen by probes or playback. */
export function listHostHealth(): HostHealthSnapshot[] {
  return [...hostRecords.keys()]
    .map((host) => getHostHealth(host))
    .sort((a, b) => a.host.localeCompare(b.host));
}

async function readPrefix(response: Response, maxBytes = 16 * 1024): Promise<string> {
  if (!response.body) {
    if (typeof response.text === "function") return (await response.text()).slice(0, maxBytes);
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const remaining = maxBytes - total;
      chunks.push(value.slice(0, remaining));
      total += Math.min(value.byteLength, remaining);
      if (value.byteLength >= remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Un CDN puede responder 200 con solo la cabecera HLS (por ejemplo
 * `#EXTM3U\n#EXT-X-VERSION:6`) cuando el token ya no apunta a un recurso real.
 * Esa respuesta no es reproducible y no debe alimentar el ranking de salud.
 * Aceptamos tanto playlists de segmentos como manifests maestros.
 */
function isPlayableHlsManifest(prefix: string): boolean {
  if (!prefix.includes("#EXTM3U")) return false;
  return /#EXTINF\s*:|#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA|PLAYLIST-TYPE|MAP|KEY)\s*:|#EXT-X-ENDLIST(?:\s|$)/i.test(prefix);
}

function isPlayableDashManifest(prefix: string): boolean {
  const trimmed = prefix.trimStart();
  if (!/<MPD\b/i.test(trimmed)) return false;
  return /<Period\b|<AdaptationSet\b|<SegmentTemplate\b|<BaseURL\b/i.test(trimmed);
}

async function probeUncached(url: string, opts: ProbeOptions): Promise<ProbeResult> {
  const startedAt = Date.now();
  const { headers, profile } = buildProxyHeaders(url, opts.playerReferer);
  const timeoutMs = adaptiveTimeout(url, opts, profile.connectTimeoutMs);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const isHls = /\.m3u8(?:\?|$)/i.test(url) || /\/m3u8\//i.test(url) || /hls-vod/i.test(url);
  const isDash = /\.mpd(?:\?|$)/i.test(url);
  const isMp4 = /\.(?:mp4|webm|mkv)(?:\?|$)/i.test(url) || /\/get_video(?:\?|$)/i.test(url) || /tapecontent\.net/i.test(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  let authStatusSeen: HealthReason | undefined;

  try {
    if (isHls || isDash) {
      const response = await fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "follow", headers });
      if (!isSuccessfulStatus(response.status)) {
        if (response.status === 401 || response.status === 403) authStatusSeen = reasonForStatus(response.status);
        await response.body?.cancel().catch(() => undefined);
        return resultForFailure(url, response.status, reasonForStatus(response.status), undefined, elapsed());
      }
      const prefix = await readPrefix(response);
      const playable = isHls ? isPlayableHlsManifest(prefix) : isPlayableDashManifest(prefix);
      if (!playable) {
        return resultForFailure(
          url,
          response.status,
          "invalid_manifest",
          `${isHls ? "HLS" : "DASH"} manifest missing playlist directives`,
          elapsed(),
        );
      }
      return resultForSuccess(url, response.status, elapsed());
    }

    // MP4 hosts often reject HEAD. Probe headers first, then at most 101 bytes.
    const head = await fetchImpl(url, { method: "HEAD", signal: controller.signal, redirect: "follow", headers });
    await head.body?.cancel().catch(() => undefined);
    if (isSuccessfulStatus(head.status)) return resultForSuccess(url, head.status, elapsed());
    if (head.status === 401 || head.status === 403) authStatusSeen = reasonForStatus(head.status);

    if (isMp4) {
      const ranged = await fetchImpl(url, {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { ...headers, Range: "bytes=0-100" },
      });
      await ranged.body?.cancel().catch(() => undefined);
      if (isSuccessfulStatus(ranged.status)) return resultForSuccess(url, ranged.status, elapsed());
      if (ranged.status === 401 || ranged.status === 403) authStatusSeen = reasonForStatus(ranged.status);
      return resultForFailure(url, ranged.status, reasonForStatus(ranged.status), undefined, elapsed());
    }
    return resultForFailure(url, head.status, reasonForStatus(head.status), undefined, elapsed());
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const reason: HealthReason = authStatusSeen ?? (timedOut ? "timeout" : "network_error");
    const message = error instanceof Error ? error.message : String(error);
    return resultForFailure(url, undefined, reason, message, elapsed());
  } finally {
    clearTimeout(timer);
  }
}

/** Probe HLS con GET de manifiesto y MP4 con HEAD + fallback Range GET. */
export async function probeStream(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  if (isHostBlacklisted(url)) {
    const record = getRecord(url);
    return {
      url,
      ok: false,
      state: "offline",
      reason: "circuit_open",
      fromCache: true,
      error: record.circuitOpenUntil ? `circuit open until ${record.circuitOpenUntil}` : undefined,
    };
  }
  const record = getRecord(url);
  record.state = "checking";
  const hostSemaphore = getHostSemaphore(url);
  return globalSemaphore.run(() => hostSemaphore.run(() => probeUncached(url, opts)));
}

function healthRank(url: string): number {
  const record = getRecord(url);
  if (record.playbackAttempts > 0) return 100 + (record.playbackSuccesses / record.playbackAttempts) * 50;
  if (record.state === "online") return 80;
  if (record.state === "degraded") return 40;
  if (record.state === "offline") return 0;
  return 20;
}

/** Ordena URLs sanas primero; si todas fallan devuelve la lista original. */
export async function orderStreamsByHealth(urls: string[], opts: ProbeOptions = {}): Promise<string[]> {
  if (urls.length === 0) return urls;
  const results = await Promise.all(urls.map((url) => probeStream(url, opts)));
  const alive = new Set(results.filter((result) => result.ok).map((result) => result.url));
  if (alive.size === 0) return urls;
  return urls.filter((url) => alive.has(url)).sort((a, b) => healthRank(b) - healthRank(a));
}

/** Registra reproducción real, que pesa más que una sonda HTTP. */
export function recordPlaybackResult(url: string, signal: PlaybackSignal): HostHealthSnapshot {
  const record = getRecord(url);
  record.playbackAttempts += 1;
  if (signal.latencyMs !== undefined && signal.latencyMs >= 0) {
    record.playbackEwmaLatencyMs = ewma(record.playbackEwmaLatencyMs, signal.latencyMs, 0.2);
    recordLatency(record, signal.latencyMs);
  }
  if (signal.ok) {
    record.playbackSuccesses += 1;
    markHostHealthy(url);
  } else {
    markHostFailed(url, NEGATIVE_CACHE_TTL_MS, signal.reason ?? "playback_error");
  }
  return getHostHealth(url);
}

/** Alias explícito para integraciones que reportan eventos del player. */
export const reportPlaybackSignal = recordPlaybackResult;

/** Limpia estado entre suites de test o al cambiar de entorno. */
export function resetHostHealth(): void {
  hostRecords.clear();
  negativeCache.clear();
  hostSemaphores.clear();
}
