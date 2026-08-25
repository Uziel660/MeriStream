// server/resolvers/uqloadResolver.ts
//
// Resolver para Uqload (uqload.co, uqload.io, uqload.com, uqload.to...).
// Patrón empírico: el embed sirve un JS packed (Dean Edwards) o un objeto
// sources en texto claro con la URL .mp4 directa. Estrategia en cascada:
//   1. unpackGeneric(html) → regex sources / file → .mp4.
//   2. extractMediaUrlsFromCode sobre HTML + scripts inline → primer .mp4.
// Si nada funciona → { type: "embed", url: <embed original> } (fallback iframe).

import { unpackGeneric, extractMediaUrlsFromCode } from "../scrapers/utils/jsUnpacker";

const FETCH_TIMEOUT_MS = 8000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface DirectResolution {
  type: "direct" | "embed";
  url: string;
  provider: string;
}

/** true si la URL pertenece a cualquier dominio uqload. */
export function isUqloadUrl(url: string): boolean {
  return String(url || "").toLowerCase().includes("uqload");
}

async function fetchEmbedHtml(embedUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(embedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${new URL(embedUrl).origin}/`,
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve embed de Uqload a su MP4 directo. Nunca lanza: ante cualquier fallo
 * devuelve el embed original como fallback iframe.
 */
export async function resolveUqload(embedUrl: string): Promise<DirectResolution> {
  const provider = "Uqload";
  try {
    if (!isUqloadUrl(embedUrl)) return { type: "embed", url: embedUrl, provider };

    const html = await fetchEmbedHtml(embedUrl);
    if (!html) return { type: "embed", url: embedUrl, provider };

    // 1. Objeto sources/file tras desempaquetar (packed Dean Edwards habitual)
    const unpacked = unpackGeneric(html);
    const sourceMatch =
      unpacked.match(/sources\s*[:=]\s*\[?\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
      unpacked.match(/file\s*[:=]\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
      unpacked.match(/["'](https?:\/\/[^"']+\/v\/[^"']+\.mp4[^"']*)["']/i);
    if (sourceMatch) return { type: "direct", url: sourceMatch[1], provider };

    // 2. Cualquier .mp4/.m3u8 en el código (extractMediaUrls ya aplica unpack)
    const media = extractMediaUrlsFromCode(html);
    const mp4 = media.find((u) => u.includes(".mp4")) || media.find((u) => u.includes(".m3u8"));
    if (mp4) return { type: "direct", url: mp4, provider };

    return { type: "embed", url: embedUrl, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
