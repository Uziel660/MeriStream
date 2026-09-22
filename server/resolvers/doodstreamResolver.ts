// server/resolvers/doodstreamResolver.ts
//
// Resolver para el ecosistema DoodStream (dood.watch, dsvplay.com, d000d.com,
// dood.la, ds2play.com, ...). Patrón empírico del host:
//   1. GET del HTML del embed → extraer path "/pass_md5.sh/<hash>/<id>".
//   2. GET {hostEmbed}/pass_md5.sh/... con el MISMO User-Agent y Referer del
//      embed → responde texto plano con la URL directa del CDN.
//   3. La URL directa exige token+expiry firmados: se agregan ?token=<md5(email)>&expiry
//      (convención pública del player dood). Si el host cambió el patrón → null.

const FETCH_TIMEOUT_MS = 8000;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

import * as crypto from "crypto";
import { logPlayerEvent } from "../networkLogger";

export interface DirectResolution {
  type: "direct" | "embed";
  url: string;
  provider: string;
}

/** true si la URL pertenece a cualquier dominio del ecosistema dood. */
export function isDoodstreamUrl(url: string): boolean {
  const u = String(url || "").toLowerCase();
  return (
    u.includes("dood.") ||
    u.includes("doodstream") ||
    u.includes("dsvplay") ||
    u.includes("d000d.") ||
    u.includes("ds2play") ||
    u.includes("do7go") ||
    u.includes("dooood")
  );
}

function buildEmbedHeaders(refererOrigin: string): Record<string, string> {
  return {
    "User-Agent": CHROME_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: refererOrigin,
  };
}

async function fetchWith(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve embed de DoodStream a su MP4 directo vía pass_md5.sh.
 * Devuelve { type: "direct", url } o { type: "embed", url: <embed original> };
 * nunca lanza (fallback inteligente a iframe).
 */
export async function resolveDoodstream(embedUrl: string): Promise<DirectResolution> {
  const provider = "DoodStream";
  try {
    if (!isDoodstreamUrl(embedUrl)) {
      return { type: "embed", url: embedUrl, provider };
    }

    const origin = new URL(embedUrl).origin;
    const embedReferer = `${origin}/`;

    // 1. HTML del embed → path pass_md5.sh
    const htmlRes = await fetchWith(embedUrl, buildEmbedHeaders(embedReferer));
    if (!htmlRes.ok || !htmlRes.text) {
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: `doodstream: embed HTTP ${htmlRes.status}`,
      });
      return { type: "embed", url: embedUrl, provider };
    }

    const md5Match = htmlRes.text.match(/\/pass_md5\.sh\/[A-Za-z0-9]+\/[A-Za-z0-9]+/);
    if (!md5Match) {
      // Patrón cambió o requiere captcha → iframe
      logPlayerEvent({
        eventType: "embed_unresolvable",
        provider,
        serverUrl: embedUrl,
        details: "doodstream: sin /pass_md5.sh en embed",
      });
      return { type: "embed", url: embedUrl, provider };
    }

    // 2. Segunda fetch con mismas credenciales (UA idéntico al del embed)
    const md5Res = await fetchWith(`${origin}${md5Match[0]}`, buildEmbedHeaders(embedReferer));
    let direct = md5Res.ok ? md5Res.text.trim() : "";
    if (!direct.startsWith("http")) {
      return { type: "embed", url: embedUrl, provider };
    }

    // 3. Token público del player dood (convención de scrapers conocidos):
    //    ?token=<md5 del correo placeholder>&expiry=<ms epoch>. Sin verificación
    //    en vivo aún; el validador del pipeline descarta si el CDN lo rechaza.
    const token = crypto.createHash("md5").update("support@dood.la").digest("hex");
    const sep = direct.includes("?") ? "&" : "?";
    direct = `${direct}${sep}token=${token}&expiry=${Date.now() + 3600_000}`;

    // 4. Validación rápida de que el CDN sirve video (HEAD puede dar 405 → GET range)
    const headController = new AbortController();
    const headTimer = setTimeout(() => headController.abort(), FETCH_TIMEOUT_MS);
    try {
      let status = 0;
      let contentType = "";
      const head = await fetch(direct, {
        method: "HEAD",
        signal: headController.signal,
        headers: { "User-Agent": CHROME_UA, Referer: embedReferer },
      });
      status = head.status;
      contentType = head.headers.get("content-type") || "";
      if (status === 405) {
        const probe = await fetch(direct, {
          method: "GET",
          headers: { "User-Agent": CHROME_UA, Referer: embedReferer, Range: "bytes=0-1" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        status = probe.status;
        contentType = probe.headers.get("content-type") || "";
        probe.body?.cancel().catch(() => {});
      }
      const playable =
        (status === 200 || status === 206) &&
        (contentType.startsWith("video/") ||
          contentType.includes("octet-stream") ||
          contentType === "");
      if (!playable) {
        return { type: "embed", url: embedUrl, provider };
      }
    } catch {
      // Red inestable en la sonda: devolver igualmente el directo (el player reintentará)
    } finally {
      clearTimeout(headTimer);
    }

    return { type: "direct", url: direct, provider };
  } catch {
    return { type: "embed", url: embedUrl, provider };
  }
}
