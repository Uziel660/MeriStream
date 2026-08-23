// server/scrapers/hostHealth.ts
//
// Capa de resiliencia global para hosts de video:
//  - Sonda HEAD genérica con los headers que el proxy aplicará según
//    server/hostProfiles.ts. El deadline se toma de opts.timeoutMs, o del
//    connectTimeoutMs del perfil si existe, o del default (6s).
//  - Caché negativa con TTL: un host que acumula fallos consecutivos queda
//    marcado caído unos minutos, evitando re-quemar timeouts contra hosts
//    muertos (doodstream/streamtape caídos) en cada play.
//
// Consumo desde cualquier adaptador/resolver:
//   import { probeStream, orderStreamsByHealth, markHostFailed } from "../hostHealth";

import { buildProxyHeaders } from "../hostProfiles";

export interface ProbeOptions {
  /** Deadline total de la sonda en ms. Si se omite: connectTimeoutMs del perfil o 6s. */
  timeoutMs?: number;
  /** Referer del sitio fuente; lo usan los perfiles con refererMode "passthrough". */
  playerReferer?: string;
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  /** Status HTTP cuando hubo respuesta. */
  status?: number;
  /** Motivo del fallo de red/abort cuando no hubo respuesta utilizable. */
  error?: string;
  /** true si el resultado salió de la caché negativa (sin request de red). */
  fromCache?: boolean;
}

const DEFAULT_PROBE_TIMEOUT_MS = 6000;
/** Fallos consecutivos necesarios antes de enviar el host a caché negativa. */
const FAILURE_THRESHOLD = 2;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

interface FailureRecord {
  count: number;
  lastFailedAt: number;
}

const failures = new Map<string, FailureRecord>();
const negativeCache = new Map<string, number>();

function hostKeyOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pruneExpired(now: number): void {
  if (failures.size < 500 && negativeCache.size < 500) return;
  for (const [key, rec] of failures) {
    if (now - rec.lastFailedAt > NEGATIVE_CACHE_TTL_MS) failures.delete(key);
  }
  for (const [key, until] of negativeCache) {
    if (until <= now) negativeCache.delete(key);
  }
}

/** ¿El host de esta URL está en caché negativa vigente? */
export function isHostBlacklisted(url: string): boolean {
  const until = negativeCache.get(hostKeyOf(url));
  if (until === undefined) return false;
  if (Date.now() > until) {
    negativeCache.delete(hostKeyOf(url));
    return false;
  }
  return true;
}

/**
 * Registra un fallo para el host de la URL. Al acumular FAILURE_THRESHOLD
 * fallos consecutivos dentro de la ventana de TTL, el host entra en caché
 * negativa durante ttlMs (default 5 min).
 *
 * Pensado para llamarse también fuera de la sonda: cuando el player reporta
 * que un stream no reprodujo, el adaptador puede marcarlo aquí y las próximas
 * resoluciones lo dejan al final.
 */
export function markHostFailed(url: string, ttlMs: number = NEGATIVE_CACHE_TTL_MS): void {
  const key = hostKeyOf(url);
  const now = Date.now();
  const prev = failures.get(key);
  const rec =
    prev && now - prev.lastFailedAt <= NEGATIVE_CACHE_TTL_MS
      ? prev
      : { count: 0, lastFailedAt: now };
  rec.count += 1;
  rec.lastFailedAt = now;
  failures.set(key, rec);
  if (rec.count >= FAILURE_THRESHOLD) {
    negativeCache.set(key, now + ttlMs);
  }
  pruneExpired(now);
}

/** Limpia fallos y caché negativa del host (llamar tras una respuesta sana). */
export function markHostHealthy(url: string): void {
  const key = hostKeyOf(url);
  failures.delete(key);
  negativeCache.delete(key);
}

/**
 * Sonda HEAD contra una URL de media directo usando los headers del proxy
 * según hostProfiles (referer/UA/Sec-Fetch-* del perfil). Devuelve ok=true
 * solo con status 2xx/3xx. Consulta y actualiza la caché negativa: un host
 * en caché negativa vigente responde ok=false sin tocar la red.
 */
export async function probeStream(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  if (isHostBlacklisted(url)) {
    return { url, ok: false, fromCache: true };
  }

  const { headers, profile } = buildProxyHeaders(url, opts.playerReferer);
  const timeoutMs = opts.timeoutMs ?? profile.connectTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
      headers,
    });
    res.body?.cancel().catch(() => {});
    const ok = res.status >= 200 && res.status < 400;
    if (ok) {
      markHostHealthy(url);
    } else {
      markHostFailed(url);
    }
    return { url, ok, status: res.status };
  } catch (err) {
    markHostFailed(url);
    return { url, ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ordena URLs de media por salud: sanas primero (orden relativo original).
 * Si NINGUNA pasa la sonda, devuelve la lista intacta: el fallo masivo casi
 * seguro es bloqueo de la sonda/red propia, no hosts muertos, y descartarlo
 * todo empeoraría el failover del player.
 *
 * Nota: aunque el perfil pida un connectTimeoutMs alto, el cliente HTTP
 * (fetch/undici) aplica su propio techo de conexión (~10s default), así que
 * el peor caso por host es ese techo, no el valor del perfil.
 */
export async function orderStreamsByHealth(
  urls: string[],
  opts: ProbeOptions = {}
): Promise<string[]> {
  if (urls.length === 0) return urls;
  const results = await Promise.all(urls.map((url) => probeStream(url, opts)));
  const alive = new Set(results.filter((r) => r.ok).map((r) => r.url));
  if (alive.size === 0) return urls;
  return urls.filter((u) => alive.has(u));
}
