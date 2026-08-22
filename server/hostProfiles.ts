// server/hostProfiles.ts
//
// Perfiles universales por host de video: headers que exige cada CDN/WAF
// para servir streams a través del proxy (/api/v1/proxy/stream).
//
// Cada perfil describe cómo el host valida las peticiones:
//  - refererMode:
//      "none"    → enviar SIN Referer (el host rechaza requests con Referer)
//      "fixed"   → forzar un Referer concreto (hotlink-protection del propio host)
//      "passthrough" → usar el referer que manda el player (sitio fuente)
//  - userAgent: UA exacto si el token del stream está firmado contra él
//  - extraHeaders: cabeceras fetch estándar que el WAF exige (Sec-Fetch-*, etc.)
//  - client: "undici" evita huellas HTTP/2 distintas al navegador (impit/Rust da 403)
//  - forceHttp2Client: true cuando la huella TLS/HTTP2 del cliente importa

export type RefererMode = "none" | "fixed" | "passthrough";

export interface HostProfile {
  /** Dominio(s) substring match sobre la URL en minúsculas */
  match: string[];
  refererMode: RefererMode;
  /** Referer a forzar cuando refererMode === "fixed" */
  referer?: string;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  /** Cliente HTTP a usar: undici (fetch nativo) o stealth (impit) */
  client?: "undici" | "stealth";
}

export const CHROME_124_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const CHROME_120_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Perfiles conocidos. Orden importa: el primer match gana.
 * Cada entrada está verificada con curl contra el host real.
 */
export const HOST_PROFILES: HostProfile[] = [
  {
    // Goodstream: token firmado contra UA Chrome/124 exacto del embed; nginx
    // rechaza con 403 cualquier request CON Referer o sin headers fetch estándar.
    // impit (huella HTTP/2 Rust) también da 403 → undici sí pasa.
    match: ["goodstream.one"],
    refererMode: "none",
    userAgent: CHROME_124_UA,
    extraHeaders: {
      Accept: "*/*",
      "Accept-Language": "*",
      "Sec-Fetch-Mode": "cors",
    },
    client: "undici",
  },
  {
    // MP4Upload: hotlink-protection; exige Referer de su propio dominio
    // (referer del sitio fuente → 403; www.mp4upload.com → 206).
    match: ["mp4upload.com"],
    refererMode: "fixed",
    referer: "https://www.mp4upload.com/",
    userAgent: CHROME_120_UA,
  },
];

const DEFAULT_PROFILE: HostProfile = {
  match: [],
  refererMode: "passthrough",
  userAgent: CHROME_120_UA,
};

/** Resuelve el perfil aplicable para una URL objetivo (primer match). */
export function resolveHostProfile(targetUrl: string): HostProfile {
  const lower = targetUrl.toLowerCase();
  for (const profile of HOST_PROFILES) {
    if (profile.match.some((m) => lower.includes(m))) return profile;
  }
  return DEFAULT_PROFILE;
}

/**
 * Construye los headers de request saliente para el proxy según el perfil
 * y el referer que mandó el player (?referer=...).
 */
export function buildProxyHeaders(
  targetUrl: string,
  playerReferer: string | undefined,
  rangeHeader?: string
): { headers: Record<string, string>; profile: HostProfile } {
  const profile = resolveHostProfile(targetUrl);

  let referer: string | undefined;
  switch (profile.refererMode) {
    case "none":
      referer = undefined;
      break;
    case "fixed":
      referer = profile.referer;
      break;
    default:
      referer = playerReferer;
  }

  const headers: Record<string, string> = {
    "User-Agent": profile.userAgent ?? DEFAULT_PROFILE.userAgent!,
    ...(referer ? { Referer: referer } : {}),
    ...profile.extraHeaders,
  };

  if (rangeHeader) headers.Range = rangeHeader;

  return { headers, profile };
}
