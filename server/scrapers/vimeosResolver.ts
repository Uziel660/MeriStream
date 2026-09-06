import { request } from "undici";
import { unpackPackedScript, extractMediaUrlsFromCode } from "./utils/jsUnpacker";
import { EmbedResolvers } from "../resolvers";
import { buildProxyHeaders } from "../hostProfiles";

/**
 * Resolver compartido para el host vimeos.net (usado por LaMovie, Cinecalidad y
 * EmbedResolvers). Estado verificado EN VIVO el 2026-08-24:
 *
 * 1. El player del embed (`embed-{id}.html`, `/e/{id}`) trae un Dean Edwards
 *    Packer variante (payload entre comillas simples) cuyo `sources[0].file`
 *    es un master.m3u8 en nodos s{N}.vimeos.net / vimeos.zip / p{N}.vimeos.zip.
 *    ESA es la URL que usa el navegador real y la única que funciona: los MP4
 *    del POST `download_orig` (/d/{id}_h) hoy responden 403 siempre (y el HEAD
 *    al nodo también está prohibido: responde 403 con body de 146 bytes y
 *    Content-Length que envenenaba la rama MP4 del proxy → "El origen ignoró
 *    Range (status 403)"). Por eso se entrega m3u8 validado y el playback va
 *    por la rama HLS del proxy (solo GET).
 *
 * 2. El CDN emite tokens ?t= "muertos" la mayoría de las veces (~1 de cada 4-6
 *    embeds trae uno vivo; medido estadísticamente con re-probe). Por eso este
 *    resolver VALIDA cada candidato con un GET real usando exactamente los
 *    headers del perfil (buildProxyHeaders) y reintenta con embeds frescos
 *    hasta MAX_EMBED_ATTEMPTS antes de rendirse.
 *
 * 3. Headers que exige el nodo (ver hostProfiles.VIMEOS_REQUIRED_HEADERS):
 *    UA Chrome completo + Accept-Encoding; sin Referer ni Origin.
 */
export class VimeosResolver {
  private constructor() {}

  /** Hosts de descarga directa (páginas HTML sin stream embebido): no intentar resolver */
  public static readonly DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"];

  private static readonly DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  private static readonly EMBED_TIMEOUT_MS = 8000;
  /** Intentos de embed→validación antes de caer al POST download_orig. */
  private static readonly MAX_EMBED_ATTEMPTS = 3;
  /** Pausa entre intentos (ms): no martillar el edge mientras rota backends. */
  private static readonly RETRY_PAUSE_MS = 200;

  /** Detecta cualquier forma de URL de vimeos: embed-{id}.html, /e/{id}, /d/{id}_h */
  public static isVimeosUrl(url: string): boolean {
    return /vimeos\.[a-z]+\/(?:embed-[a-zA-Z0-9]+\.html|e\/[a-zA-Z0-9]+|d\/[a-zA-Z0-9]+_h)/i.test(
      (url || "").trim()
    );
  }

  public static isDownloadHostUrl(url: string): boolean {
    const lower = (url || "").toLowerCase();
    return this.DOWNLOAD_HOSTS.some((h) => lower.includes(h));
  }

  /**
   * Resuelve un embed de vimeos.net a un stream jugable VALIDADO:
   * desempaqueta el player del embed y prueba candidatos (.m3u8 primero) con
   * GET real + headers del perfil hasta dar con un token vivo. Fallback final:
   * MP4 del POST download_orig (hoy suele estar muerto; se mantiene por si el
   * CDN relaja). Devuelve [] si nada valida.
   */
  public static async resolveVimeos(embedUrl: string): Promise<string[]> {
    const url = (embedUrl || "").trim();
    if (!url || this.isDownloadHostUrl(url)) return [];

    for (let attempt = 1; attempt <= this.MAX_EMBED_ATTEMPTS; attempt++) {
      const html = await this.fetchText(url, this.EMBED_TIMEOUT_MS);
      if (!html || html.includes("File is no longer available")) {
        if (html && html.includes("File is no longer available")) break;
        continue;
      }

      const unpacked = unpackPackedScript(html);
      const found = extractMediaUrlsFromCode(unpacked);
      // Regex check for sources:[{file:"..."}]
      const sourceMatch = unpacked.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i);
      if (sourceMatch && !found.includes(sourceMatch[1])) found.unshift(sourceMatch[1]);

      // candidatos en claro por si esta respuesta no trae el pack
      for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)["']/gi)) found.push(m[1]);

      const candidates = [...new Set(found)]
        .filter(
          (u) =>
            (u.includes(".m3u8") || u.includes(".mp4")) &&
            !EmbedResolvers.isPlaceholderUrl(u)
        )
        // m3u8 primero: es la forma que el proxy sirve sin HEAD
        .sort((a, b) => Number(b.includes(".m3u8")) - Number(a.includes(".m3u8")))
        .slice(0, 4);

      for (const candidate of candidates) {
        if (await this.validateStreamUrl(candidate)) return [candidate];
      }
      if (attempt < this.MAX_EMBED_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, this.RETRY_PAUSE_MS));
      }
    }

    const direct = await this.resolveViaDownloadOrig(url);
    if (direct && (await this.validateStreamUrl(direct))) return [direct];
    return [];
  }

  /**
   * Sustituye cada enlace `/d/{id}_h` de vimeos por su stream jugable validado.
   * Los que no se puedan resolver se eliminan (la página HTML no es reproducible);
   * las demás URLs pasan intactas, preservando orden y sin duplicados.
   */
  public static async fixVimeosStreams(streams: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const u of streams) {
      if (/vimeos\.[a-z]+\/d\/[a-zA-Z0-9]+_h/i.test(u)) {
        const resolved = await this.resolveVimeos(u);
        if (resolved.length > 0 && !out.includes(resolved[0])) out.push(resolved[0]);
      } else if (!out.includes(u)) {
        out.push(u);
      }
    }
    return out;
  }

  private static toDownloadPageUrl(url: string): string | null {
    const match =
      url.match(/vimeos\.([a-z]+)\/(?:embed-|e\/)([a-zA-Z0-9]+)/i) ||
      url.match(/vimeos\.([a-z]+)\/d\/([a-zA-Z0-9]+)_h/i);
    return match ? `https://vimeos.${match[1]}/d/${match[2]}_h` : null;
  }

  /**
   * GET real contra el stream con los MISMOS headers que usará el proxy
   * (buildProxyHeaders). .mp4 → exige 206 con Range; .m3u8 → 200 plano.
   * Es el filtro que garantiza no entregar tokens muertos al player.
   */
  private static async validateStreamUrl(streamUrl: string): Promise<boolean> {
    const isMp4 = /\.mp4(\?|$)/i.test(streamUrl);
    try {
      const { headers } = buildProxyHeaders(streamUrl, "https://vimeos.net/");
      const res = await request(streamUrl, {
        method: "GET",
        headers: isMp4 ? { ...headers, Range: "bytes=0-1023" } : headers,
        headersTimeout: 7000,
        bodyTimeout: 7000,
      });
      res.body.on("error", () => {});
      res.body.destroy();
      return isMp4 ? res.statusCode === 206 : res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /** Último recurso histórico: hash del GET + POST op=download_orig → MP4 directo. */
  private static async resolveViaDownloadOrig(anyVimeosUrl: string): Promise<string | null> {
    const pageUrl = this.toDownloadPageUrl(anyVimeosUrl);
    if (!pageUrl) return null;
    const idMatch = pageUrl.match(/vimeos\.[a-z]+\/d\/([a-zA-Z0-9]+)_h/i);
    if (!idMatch) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.EMBED_TIMEOUT_MS);
    try {
      const pageRes = await fetch(pageUrl, {
        signal: controller.signal,
        headers: { "User-Agent": this.DEFAULT_UA },
      });
      if (!pageRes.ok) return null;
      const pageHtml = await pageRes.text();
      if (pageHtml.includes("File is no longer available")) return null;

      const hashMatch = pageHtml.match(/name="hash"\s+value="([^"]+)"/);
      if (!hashMatch) return null;

      await new Promise((r) => setTimeout(r, 600));

      const postRes = await fetch(pageUrl, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "User-Agent": this.DEFAULT_UA,
          Referer: pageUrl,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          op: "download_orig",
          id: idMatch[1],
          mode: "h",
          hash: hashMatch[1],
        }).toString(),
      });
      if (!postRes.ok) return null;
      const postHtml = await postRes.text();
      const mp4 = postHtml.match(
        /https?:\/\/s\d+\.vimeos\.[a-z]+\/[^"'\\\s]+\.mp4\?[^"'\\\s]*/i
      );
      return mp4 ? mp4[0] : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private static async fetchText(url: string, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": this.DEFAULT_UA,
          Referer: "https://vimeos.net/",
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
}
