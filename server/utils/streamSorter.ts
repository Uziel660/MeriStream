// server/utils/streamSorter.ts

/**
 * Jerarquía de hosts definida por el usuario (2026-08-23) para orden de
 * reproducción y fallback del servidor, analizada sobre el string de la URL
 * (case-insensitive).
 *
 * TIER 1 (HLS nativo premium): ugc-cdn-caching (TioAnime), goodstream/acek-cdn
 *          (LaMovie/Cinecalidad), uqload (VerAnimes).
 *          vimeos.net permanece en tier 1 por rendimiento validado en el
 *          barrido E2E (heredado del tierset anterior; no listado por el usuario).
 * TIER 2 (HLS/MP4 secundarios): genéricos AnimeFLV que pasan validador sin 403
 *          (ducvomes, playmudos) y doodstream.
 * TIER 3 (embeds funcionales): vidhide.
 * TIER 4 (último recurso): mega.nz/mega.io/mega.co.nz, mp4upload.
 *
 * LISTA NEGRA: voe, mixdrop, filemoon → filtrados en sortStreamsByPriority
 * antes de ordenar (defensiva; el filtro primario es isValidProvider en
 * resolvers.ts).
 */
const TIERS: ReadonlyArray<{ tier: number; tokens: readonly string[] }> = [
  { tier: 1, tokens: ["streamwish", "premilkyway", "sfastwish", "flaswish", "yourupload", "vidcache", "ugc-cdn-caching", "goodstream", "acek-cdn", "uqload", "vimeos.", "zilla-networks", "/api/v1/stream/mega"] },
  // Genéricos AnimeFLV verificados sin 403 en validador y Doodstream
  // Byse locators are the stable Gnula pages that JIT-resolve to SprintCDN HLS.
  { tier: 2, tokens: ["ducvomes.com", "playmudos.com", "doodstream", "dood", "byse"] },
  { tier: 3, tokens: ["ok.ru", "okru", "vidhide", "vixhide"] },
  { tier: 4, tokens: ["mega.nz", "mega.io", "mega.co.nz", "mp4upload"] },
];

/**
 * Hosts no reconocidos: sin datos de estabilidad auditada se colocan por encima
 * del último recurso declarado (tier 4) pero por debajo de cualquier host auditado.
 */
const UNKNOWN_TIER = 3.5;

/** Tokens de proveedores en lista negra (muertos/anuncio-basura): nunca reproducir.
 *  "mxdrop" cubre la variante mxdrop.to de Mixdrop (reportado por stream-agent). */
export const BLACKLISTED_HOST_TOKENS = ["voe", "mixdrop", "mxdrop", "filemoon", "vudeo"] as const;

/** true si la URL pertenece a un host en lista negra (voe/mixdrop/filemoon). */
export function isBlacklistedHost(url: string): boolean {
  const lower = String(url || "").toLowerCase();
  if (!lower) return false;
  return BLACKLISTED_HOST_TOKENS.some((t) => lower.includes(t));
}

export interface StreamEntry {
  url: string;
  type: string;
}

/**
 * Devuelve el tier de estabilidad (1-4) de una URL según su host.
 * URLs desconocidas reciben UNKNOWN_TIER (entre tier 3 y 4).
 */
export function getStreamTier(url: string): number {
  const lower = String(url || "").toLowerCase();
  for (const { tier, tokens } of TIERS) {
    if (tokens.some((t) => lower.includes(t))) return tier;
  }
  return UNKNOWN_TIER;
}

/** Host de una URL (sin www), minúsculas. */
export function hostOfStreamUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Familia de proveedor de una URL: etiqueta de segundo nivel del host
 * ("s12.vimeos.net" → "vimeos", "enc8.goodstream.one" → "goodstream").
 * Los CDNs rotan nodos y TLDs; la prioridad por FAMILIA sobrevive a eso.
 */
export function familyKeyOfStreamUrl(url: string): string {
  const host = hostOfStreamUrl(url);
  const labels = host.split(".").filter(Boolean);
  return labels.length >= 2 ? labels[labels.length - 2] : host;
}

/**
 * Función pura: filtra hosts en lista negra y ordena de menor a mayor número de
 * tier (más estable primero). No muta el array de entrada; dentro de un mismo
 * tier conserva el orden original (Array.prototype.sort es estable).
 *
 * `hostPriority` (opcional): mapa host → rank (1 = mejor) con los overrides
 * definidos por el usuario en el probador de servidores por plataforma. Los
 * hosts con override van PRIMERO por rank; el resto se ordena por tier.
 */
export function sortStreamsByPriority<T extends StreamEntry>(
  streams: T[],
  hostPriority?: Record<string, number>
): T[] {
  return streams
    .filter((s) => !isBlacklistedHost(s?.url))
    .sort((a, b) => {
      if (hostPriority) {
        const pa = hostPriority[familyKeyOfStreamUrl(a.url)];
        const pb = hostPriority[familyKeyOfStreamUrl(b.url)];
        if (pa !== undefined || pb !== undefined) {
          const na = pa ?? Number.MAX_SAFE_INTEGER;
          const nb = pb ?? Number.MAX_SAFE_INTEGER;
          if (na !== nb) return na - nb;
        }
      }
      return getStreamTier(a.url) - getStreamTier(b.url);
    });
}
