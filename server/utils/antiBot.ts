// server/utils/antiBot.ts
// Detección de protecciones anti-bot (Cloudflare challenge, WAF/rate-limit genérico)
// + registro global de señales por host para avisar desde la UI.
//
// Contrato:
//  - detectAntiBot(status, headers, bodySample?, host?) → veredicto puro (salvo el
//    contador interno de 429 repetidos, que es la señal "genérica" definida).
//  - recordAntiBotHit(host, verdict) / getAntiBotReport() → registro { host → { hits, lastAt, kind } }.
//  - countRecentAntiBotHits(host, windowMs) → nº de hits en ventana deslizante
//    (lo usa taskWorker para su auto-throttle por dominio).

export type AntiBotKind = "cloudflare" | "generic";

export interface AntiBotVerdict {
  blocked: boolean;
  kind: AntiBotKind | null;
  evidence: string;
}

export interface AntiBotHostEntry {
  hits: number;
  lastAt: number;
  kind: AntiBotKind;
}

interface HostRecord {
  hits: number;
  lastAt: number;
  kind: AntiBotKind;
  hitTimestamps: number[];
  recent429s: number[];
}

const records = new Map<string, HostRecord>();

/** Ventana por defecto para "N hits en 10 min" (auto-throttle del worker). */
export const ANTIBOT_HIT_WINDOW_MS = 10 * 60 * 1000;

/** Marcadores de body únicos del interstitial de Cloudflare ("Just a moment..."). */
const CF_BODY_MARKERS = [
  "just a moment",
  "challenge-platform",
  "cf-browser-verification",
  "_cf_chl",
  "attention required",
] as const;

/** Nº de 429 en la ventana a partir del cual se considera bloqueo genérico. */
const REPEATED_429_THRESHOLD = 2;

function normalizeHeaders(headers: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof headers.forEach === "function") {
    // Headers/fetch y Map entregan (value, key)
    headers.forEach((value: unknown, key: string) => {
      out[String(key).toLowerCase()] = String(value);
    });
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined && v !== null) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/**
 * Analiza status + headers + muestra del body buscando señales de Cloudflare o
 * de bloqueo genérico (429 repetido). No lanza; nunca devuelve undefined.
 * `host` es opcional y solo mejora la precisión del contador de 429 repetidos.
 */
export function detectAntiBot(
  status: number,
  headers: Record<string, string | string[] | undefined> | any,
  bodySample?: string,
  host?: string
): AntiBotVerdict {
  const h = normalizeHeaders(headers);
  const cfMitigated = (h["cf-mitigated"] || "").toLowerCase();
  const server = (h["server"] || "").toLowerCase();
  const body = (bodySample || "").slice(0, 4000).toLowerCase();

  // 1) Cloudflare declara el challenge explícitamente en cf-mitigated.
  if (cfMitigated.includes("challenge")) {
    return { blocked: true, kind: "cloudflare", evidence: `header cf-mitigated="${h["cf-mitigated"]}" (HTTP ${status})` };
  }

  // 2) Marcadores de body inequívocos del interstitial de CF (puede llegar con 200/403/503).
  const marker = CF_BODY_MARKERS.find((m) => body.includes(m));
  if (marker) {
    return { blocked: true, kind: "cloudflare", evidence: `body contiene "${marker}" (HTTP ${status})` };
  }

  // 3) CDN Cloudflare + status típico de challenge/bloqueo.
  if (server === "cloudflare" && (status === 403 || status === 503 || status === 429)) {
    return { blocked: true, kind: "cloudflare", evidence: `server=cloudflare con HTTP ${status}` };
  }

  // 4) Genérico: 429 repetido dentro de la ventana.
  if (status === 429) {
    const key = `${host || "__global__"}::429`;
    const now = Date.now();
    let rec = records.get(key);
    if (!rec) {
      rec = { hits: 0, lastAt: now, kind: "generic", hitTimestamps: [], recent429s: [] };
      records.set(key, rec);
    }
    rec.recent429s = rec.recent429s.filter((t) => now - t < ANTIBOT_HIT_WINDOW_MS);
    rec.recent429s.push(now);
    if (rec.recent429s.length >= REPEATED_429_THRESHOLD) {
      return {
        blocked: true,
        kind: "generic",
        evidence: `HTTP 429 repetido (${rec.recent429s.length} en ${Math.round(ANTIBOT_HIT_WINDOW_MS / 60000)} min)`,
      };
    }
    return { blocked: false, kind: null, evidence: "HTTP 429 aislado (aún no repetido)" };
  }

  return { blocked: false, kind: null, evidence: "" };
}

/** Registra un hit confirmado para el host (solo llamar con verdict.blocked=true). */
export function recordAntiBotHit(host: string, verdict: AntiBotVerdict): void {
  if (!host || !verdict?.blocked) return;
  const now = Date.now();
  let rec = records.get(host);
  if (!rec) {
    rec = { hits: 0, lastAt: now, kind: verdict.kind || "generic", hitTimestamps: [], recent429s: [] };
    records.set(host, rec);
  }
  rec.hits++;
  rec.lastAt = now;
  rec.kind = verdict.kind || rec.kind;
  rec.hitTimestamps.push(now);
  // Poda defensiva: conserva solo la última hora de timestamps.
  rec.hitTimestamps = rec.hitTimestamps.filter((t) => now - t < ANTIBOT_HIT_WINDOW_MS);
}

/** Nº de hits registrados para el host dentro de la ventana deslizante. */
export function countRecentAntiBotHits(host: string, windowMs: number = ANTIBOT_HIT_WINDOW_MS): number {
  const rec = records.get(host);
  if (!rec) return 0;
  const now = Date.now();
  rec.hitTimestamps = rec.hitTimestamps.filter((t) => now - t < windowMs);
  return rec.hitTimestamps.length;
}

/** Registro global para UI: { host → { hits, lastAt, kind } }. */
export function getAntiBotReport(): Record<string, AntiBotHostEntry> {
  const out: Record<string, AntiBotHostEntry> = {};
  for (const [host, rec] of records) {
    if (host.endsWith("::429")) continue; // claves internas del contador de 429
    out[host] = { hits: rec.hits, lastAt: rec.lastAt, kind: rec.kind };
  }
  return out;
}
