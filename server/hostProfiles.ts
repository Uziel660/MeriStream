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
  /**
   * Timeout de conexión (TCP+TLS handshake) en ms que se pasa como connectTimeout
   * al request de undici. Default de undici: 10s. Elevarlo para hosts cuyo WAF
   * tarda mucho en completar el handshake (MP4Upload llega a ~35s).
   */
  connectTimeoutMs?: number;
}

export const CHROME_124_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const CHROME_120_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Cabeceras mínimas que el CDN de vimeos exige HOY (bisección en vivo 2026-08-24,
 * nodos s{N}.vimeos.net y vimeos.zip/p{N}.vimeos.zip):
 *  - User-Agent Chrome moderno COMPLETO (UA recortado o ausente → 403).
 *  - Accept-Encoding presente (sirve "identity": el proxy hace buffering sin
 *    descompresión, así que NUNCA pedir gzip aquí).
 *  - Origin/Referer/sec-fetch/sec-ch-ua NO ayudan y algunos combos estorban.
 * El token ?t= del stream es independiente: se emite sano solo ~1 de cada 4-6
 * peticiones del embed (verificado estadísticamente); VimeosResolver valida el
 * candidato con estos headers y reintenta hasta conseguir uno vivo.
 */
export const VIMEOS_REQUIRED_HEADERS = {
  "User-Agent": CHROME_124_UA,
  "Accept-Encoding": "identity",
} as const;

/**
 * Perfiles conocidos. Orden importa: el primer match gana.
 * Cada entrada está verificada con curl contra el host real.
 */
export const HOST_PROFILES: HostProfile[] = [
  {
    // AnimeFLV / Playmudos / Ducvomes CDNs:
    // impit-client (Rust HTTP/2) sufre 'Remote protocol error occurred' con los
    // datanodes de ducvomes. undici (fetch estándar) pasa limpio y sin cortes.
    // Re-verificado en vivo 2026-08-24: master nika.playmudos.com responde 200
    // incluso SIN headers; los 403 de las 05:31 eran URLs sin token (?st=&e=
    // ausentes o expirados), no un cambio de headers del CDN.
    match: ["ducvomes.com", "playmudos.com"],
    refererMode: "passthrough",
    userAgent: CHROME_120_UA,
    client: "undici",
  },
  {
    // TurboViPlay/TurboSPlayer (cadena HLS de tioplus.app, verificado 2026-08-22):
    // hoy no validan Referer (200 con cualquiera), pero reciben uno ajeno
    // (animeflv.*) vía passthrough. Perfil preventivo: imitar al usuario legítimo
    // de tioplus.app antes de que activen hotlink-protection (patrón MP4Upload).
    match: ["turboviplay.com", "turbosplayer.com"],
    refererMode: "fixed",
    referer: "https://tioplus.app/",
  },
  {
    // Zilla Networks (2026-08-22): Cloudflare activó WAF sobre /segs/* que
    // rechaza con 403 toda request sin Sec-Fetch-Site; con "same-origin"
    // pasa incluso sin UA ni Referer. Verificado por bisección con curl.
    match: ["zilla-networks.com"],
    refererMode: "none",
    extraHeaders: {
      Accept: "*/*",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
    },
    client: "undici",
  },
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
    // TLS handshake puede tardar ~35s; el default de undici (10s) corta la
    // conexión antes de recibir respuesta (UND_ERR_CONNECT_TIMEOUT).
    connectTimeoutMs: 35000,
  },
  {
    // Vimeos (re-bisección en vivo 2026-08-24): el CDN ahora RECHAZA el combo
    // anterior (Origin+Referer vimeos.net) y exige UA Chrome completo +
    // Accept-Encoding, SIN Referer/Origin. El HEAD está prohibido (403 siempre,
    // body de 146 bytes con Content-Length que envenena la rama MP4 del proxy:
    // "El origen ignoró Range (status 403)"), así que VimeosResolver entrega
    // m3u8 validado y la reproducción va por la rama HLS (solo GET).
    // match ampliado a "vimeos." porque los nodos rotan TLD: s{N}.vimeos.net,
    // vimeos.zip, p{N}.vimeos.zip.
    match: ["vimeos."],
    refererMode: "none",
    userAgent: CHROME_124_UA,
    extraHeaders: {
      "Accept-Encoding": "identity",
    },
    client: "undici",
  },
  {
    // Acek-CDN y SprintCDN (CDNs HLS de Goodstream / Cinecalidad / LaMovie):
    // nginx rechaza peticiones con Referer ajeno y con TLS no estándar (impit).
    // Exige undici + Chrome UA + Accept-Encoding: identity + sin Referer.
    match: ["acek-cdn.com", "sprintcdn"],
    refererMode: "none",
    userAgent: CHROME_124_UA,
    extraHeaders: {
      "Accept-Encoding": "identity",
    },
    client: "undici",
  },
  {
    // DoodStream (2026-08-23, resolver pass_md5.sh): el CDN de entrega exige el
    // Referer del propio embed (hotlink-protection estándar del ecosistema dood:
    // dood.watch/dsvplay.com/d000d.com/dood.la). Sin verificación curl en vivo;
    // si el CDN lo rechaza, ajustar contra telemetría de proxy-network.jsonl.
    match: ["dood.", "doodstream", "dsvplay.com", "d000d.com", "ds2play.com", "do7go"],
    refererMode: "passthrough",
    userAgent: CHROME_124_UA,
    client: "undici",
  },
  {
    // Uqload (tier 1 VerAnimes): MP4 directo sin hotlink verificado; passthrough
    // conservador con UA Chrome/124 (perfil default pero cliente explícito).
    // Sin fundamento curl en vivo → se documenta como preventivo.
    match: ["uqload."],
    refererMode: "passthrough",
    userAgent: CHROME_124_UA,
    client: "undici",
  },
  {
    // VidHide (tier 3): mismo ecosistema packed que StreamWish; su CDN suele
    // validar Referer del embed propio. Passthrough + UA moderno, preventivo.
    match: ["vidhide", "vixhide"],
    refererMode: "passthrough",
    userAgent: CHROME_124_UA,
    client: "undici",
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
