// server/resolvers/vidhideResolver.ts
//
// Resolver para VidHide (vidhide.com, vidhidepro.com, vixhide.com...). Mismo
// ecosistema de players packed que StreamWish: el embed sirve un JS ofuscado
// (Dean Edwards Packer) cuyo código desempaquetado declara jwplayer().setup({
// sources: [{file: "..."}] }). Estrategia:
//   1. GET embed con Referer propio → html.
//   2. unpackGeneric(html) → regex sources/file → .m3u8 preferido sobre .mp4.
//   3. extractMediaUrlsFromCode sobre HTML completo como red de seguridad.
// Fallback inteligente: nunca lanza; devuelve el embed original como iframe.

import { unpackGeneric, extractMediaUrlsFromCode } from "../scrapers/utils/jsUnpacker";
import { logPlayerEvent } from "../networkLogger";

const FETCH_TIMEOUT_MS = 8000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface DirectResolution {
  type: "direct" | "embed";
  url: string;
  provider: string;
}

/** true si la URL pertenece al ecosistema vidhide (incluye variantes vixhide). */
export function isVidhideUrl(url: string): boolean {
  const u = String(url || "").toLowerCase();
  return u.includes("vidhide") || u.includes("vixhide") || u.includes("vid-hide");
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

function pickStream(urls: string[]): string | null {
  return urls.find((u) => u.includes(".m3u8")) || urls.find((u) => u.includes(".mp4")) || null;
}

/**
 * Resuelve embed de VidHide a su stream directo (.m3u8/.mp4). Ante cualquier
 * fallo devuelve el embed original (iframe funcional con anuncios del host).
 */
export async function resolveVidhide(embedUrl: string): Promise<DirectResolution> {
  const provider = "VidHide";
  try {
    if (!isVidhideUrl(embedUrl)) return { type: "embed", url: embedUrl, provider };

    const html = await fetchEmbedHtml(embedUrl);
    if (!html) {
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: "vidhide: embed sin respuesta OK",
      });
      return { type: "embed", url: embedUrl, provider };
    }

    // 1. Código desempaquetado → declaración sources/file del player
    const unpacked = unpackGeneric(html);
    const declared =
      unpacked.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/i) ||
      unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i) ||
      unpacked.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
    if (declared) return { type: "direct", url: declared[1], provider };

    // 2. Red de seguridad: cualquier media URL en HTML/scripts
    const picked =
      pickStream(extractMediaUrlsFromCode(unpacked)) || pickStream(extractMediaUrlsFromCode(html));
    if (picked) return { type: "direct", url: picked, provider };

    logPlayerEvent({
      eventType: "embed_unresolvable",
      provider,
      serverUrl: embedUrl,
      details: "vidhide: sin sources tras unpack",
    });
    return { type: "embed", url: embedUrl, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
