import { unpackPackedScript, extractMediaUrlsFromCode } from "./utils/jsUnpacker";
import { EmbedResolvers } from "../resolvers";

/**
 * Resolver compartido para el host vimeos.net (usado por LaMovie, Cinecalidad y
 * EmbedResolvers). Unifica las dos técnicas verificadas (2026-08-22):
 *
 * 1. MP4 directo: GET `/d/{id}_h` → extrae `<input name="hash">`; POST
 *    `op=download_orig&id={id}&mode=h&hash={hash}` → enlace
 *    `https://s{N}.vimeos.net/v/.../*.mp4` (responde 206 video/mp4).
 *    CRÍTICO: el hash queda atado al perfil de headers del GET que lo emitió.
 *    Si el GET y el POST no llevan EXACTAMENTE los mismos headers mínimos
 *    (solo User-Agent en el GET; User-Agent+Referer+Content-Type en el POST),
 *    el server responde 200 pero sirve la página SIN el enlace .mp4.
 *    Con hash recién emitido (<500ms) el POST a veces llega vacío: ~600ms
 *    de pausa entre GET y POST fue estable (verificado 2026-08-22).
 * 2. Desempaquetado: el player del embed (`embed-{id}.html`, `/e/{id}`) trae un
 *    Dean Edwards Packer variante (payload entre comillas simples) que se
 *    desempaqueta con jsUnpacker.unpackPackedScript y de donde se extraen los
 *    .m3u8/.mp4.
 */
export class VimeosResolver {
  private constructor() {}

  /** Hosts de descarga directa (páginas HTML sin stream embebido): no intentar resolver */
  public static readonly DOWNLOAD_HOSTS = ["1fichier.com", "megaup.net"];

  private static readonly DEFAULT_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  private static readonly DOWNLOAD_PAGE_TIMEOUT_MS = 15000;
  private static readonly EMBED_TIMEOUT_MS = 7500;

  /** Detecta cualquier forma de URL de vimeos.net: embed-{id}.html, /e/{id}, /d/{id}_h */
  public static isVimeosUrl(url: string): boolean {
    return /vimeos\.net\/(?:embed-[a-zA-Z0-9]+\.html|e\/[a-zA-Z0-9]+|d\/[a-zA-Z0-9]+_h)/i.test(
      (url || "").trim()
    );
  }

  public static isDownloadHostUrl(url: string): boolean {
    const lower = (url || "").toLowerCase();
    return this.DOWNLOAD_HOSTS.some((h) => lower.includes(h));
  }

  /**
   * Resuelve un embed de vimeos.net a streams jugables: primero el MP4 directo
   * (POST download_orig) y como fallback el desempaquetado del embed.
   * Devuelve [] si el archivo fue eliminado/expiró o cambió de formato.
   */
  public static async resolveVimeos(embedUrl: string): Promise<string[]> {
    const url = (embedUrl || "").trim();
    if (!url || this.isDownloadHostUrl(url)) return [];

    const direct = await this.resolveViaDownloadOrig(url);
    if (direct) return [direct];

    return this.resolveViaUnpack(url);
  }

  /**
   * Sustituye cada enlace `/d/{id}_h` de vimeos por su MP4 directo jugable.
   * Los que no se puedan resolver se eliminan (la página HTML no es reproducible);
   * las demás URLs pasan intactas, preservando orden y sin duplicados.
   */
  public static async fixVimeosStreams(streams: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const u of streams) {
      if (/vimeos\.net\/d\/[a-zA-Z0-9]+_h/i.test(u)) {
        const direct = await this.resolveVimeos(u);
        if (direct.length > 0 && !out.includes(direct[0])) out.push(direct[0]);
      } else if (!out.includes(u)) {
        out.push(u);
      }
    }
    return out;
  }

  private static toDownloadPageUrl(url: string): string | null {
    const match =
      url.match(/vimeos\.net\/(?:embed-|e\/)([a-zA-Z0-9]+)/i) ||
      url.match(/vimeos\.net\/d\/([a-zA-Z0-9]+)_h/i);
    return match ? `https://vimeos.net/d/${match[1]}_h` : null;
  }

  private static async resolveViaDownloadOrig(anyVimeosUrl: string): Promise<string | null> {
    const pageUrl = this.toDownloadPageUrl(anyVimeosUrl);
    if (!pageUrl) return null;
    const idMatch = pageUrl.match(/vimeos\.net\/d\/([a-zA-Z0-9]+)_h/i);
    if (!idMatch) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.DOWNLOAD_PAGE_TIMEOUT_MS);
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
        /https?:\/\/s\d+\.vimeos\.net\/[^"'\\\s]+\.mp4\?[^"'\\\s]*/i
      );
      return mp4 ? mp4[0] : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private static async resolveViaUnpack(embedUrl: string): Promise<string[]> {
    try {
      const html = await this.fetchText(embedUrl, this.EMBED_TIMEOUT_MS);
      if (!html || html.includes("File is no longer available")) return [];

      const unpacked = unpackPackedScript(html);
      const urls = extractMediaUrlsFromCode(unpacked);
      return urls.filter(
        (u) =>
          (u.includes(".m3u8") || u.includes(".mp4")) &&
          !EmbedResolvers.isPlaceholderUrl(u)
      );
    } catch {
      return [];
    }
  }

  private static async fetchText(url: string, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": this.DEFAULT_UA },
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
