// server/resolvers/megaStream.ts
//
// Streaming on-the-fly de archivos públicos de MEGA.
// Mega cifra cada archivo con AES-128-CTR por chunks de 16 bytes (bloques
// crecientes: 128 KiB duplicando hasta 1 MiB); megajs resuelve el mapa de
// chunks + clave por archivo y expone download({ start, end }) que ya entrega
// plaintext alineado a lo que pide el cliente. Aquí solo orquestamos:
//
//   <video> ──Range──▶ Express ──start/end──▶ megajs (descarga+descifra) ──pipe──▶ cliente
//
// Nunca se bufferiza el archivo completo: cada request Range crea un stream
// nuevo con maxConnections limitado y se hace backpressure vía pipe().

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { File as MegaFile } from "megajs";
import { isMegaUrl, parseMegaUrl } from "./megaResolver";
import { logProxyRequest } from "../networkLogger";

const MAX_CONNECTIONS_PER_RANGE = 2;
/** Cache de metadata (nombre/tamaño) para no golpear la API de Mega en cada seek. */
const META_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Reintentos ante ETOOMANY (-6) de MEGA: "Too many concurrent IP addresses".
 * Es un límite transitorio de concurrencia por IP, no un archivo muerto: con
 * backoff corto (2s → 4s) la misma petición suele entrar sin caer al embed.
 */
const ETOOMANY_RETRY_DELAYS_MS = [2000, 4000];

function errorCode(err: unknown): number | string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (!err || typeof err !== "object") return String(err ?? "");
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : String(err);
}

function isEtooMany(err: unknown): boolean {
  return Number(errorCode(err)) === -6 || /ETOOMANY|too many concurrent/i.test(errorMessage(err));
}

interface CachedMeta {
  name: string;
  size: number;
  mime: string;
  loadedAt: number;
}

const metaCache = new Map<string, CachedMeta>();

function guessMimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "mkv") return "video/x-matroska";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "avi") return "video/x-msvideo";
  return "video/mp4";
}

export async function getMegaFileMeta(megaUrl: string): Promise<CachedMeta> {
  const cached = metaCache.get(megaUrl);
  if (cached && Date.now() - cached.loadedAt < META_CACHE_TTL_MS) return cached;

  // loadAttributes puede chocar con ETOOMANY (-6); reintentar con backoff corto
  // antes de exponer el error al endpoint (que caería al embed).
  let file: InstanceType<typeof MegaFile> | null = null;
  for (let attempt = 0; ; attempt++) {
    try {
      file = MegaFile.fromURL(megaUrl);
      await file.loadAttributes();
      break;
    } catch (err) {
      if (attempt >= ETOOMANY_RETRY_DELAYS_MS.length || !isEtooMany(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, ETOOMANY_RETRY_DELAYS_MS[attempt]));
    }
  }
  if (!file) throw new Error("MEGA: no se pudo cargar metadata tras reintentos");

  const meta: CachedMeta = {
    name: file.name || "video.mp4",
    size: Number(file.size) || 0,
    mime: guessMimeFromName(file.name || ""),
    loadedAt: Date.now(),
  };
  if (!meta.size) throw new Error("MEGA no reportó tamaño del archivo");
  metaCache.set(megaUrl, meta);
  return meta;
}

/**
 * Probe the first plaintext bytes of a public MEGA file. Metadata alone is not
 * sufficient: MEGA may accept the file descriptor and still reject the first
 * download with EBLOCKED/ETOOMANY/quota errors. The bounded range keeps this
 * health check from buffering a whole movie in memory.
 */
export async function probeMegaFile(megaUrl: string): Promise<boolean> {
  const parsed = parseMegaUrl(megaUrl);
  if (!parsed || parsed.kind !== "file") return false;
  const meta = await getMegaFileMeta(parsed.canonicalUrl);
  const end = Math.min(meta.size - 1, 2047);
  if (end < 0) return false;
  const file = MegaFile.fromURL(parsed.canonicalUrl);
  const stream = file.download({
    start: 0,
    end,
    maxConnections: 1,
    forceHttps: true,
  }) as Readable;
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as string);
      if (bytes > 0) break;
    }
  } finally {
    stream.destroy();
  }
  return bytes > 0;
}

/**
 * Parsea un header Range tipo "bytes=start-end" contra el tamaño total.
 * Devuelve null si no hay header válido; lanza 416 vía retorno si es insatisfactorio.
 */
export function parseByteRange(rangeHeader: string | undefined, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    // Sufijo: últimos N bytes
    const suffix = Number(match[2]);
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  }
  return { start, end };
}

/**
 * Endpoint handler: GET /api/v1/stream/mega?url=<mega.nz/file/...>
 * Soporta Range Requests (206) para scrubbing nativo en Plyr/<video>.
 */
export async function handleMegaStream(req: Request, res: Response): Promise<void> {
  const megaUrl = typeof req.query.url === "string" ? req.query.url.trim() : "";
  const _startMs = Date.now();

  if (!isMegaUrl(megaUrl)) {
    res.status(400).json({ error: "URL de MEGA inválida" });
    return;
  }

  const parsed = parseMegaUrl(megaUrl);
  if (!parsed || parsed.kind !== "file") {
    res.status(400).json({ error: "Solo se soportan enlaces públicos /file/{ID}#{KEY}" });
    return;
  }

  try {
    const meta = await getMegaFileMeta(parsed.canonicalUrl);

    // HEAD: metadata pura para que el reproductor calcule duración sin descargar
    if (req.method === "HEAD") {
      res.status(200);
      res.setHeader("Content-Type", meta.mime);
      res.setHeader("Content-Length", String(meta.size));
      res.setHeader("Accept-Ranges", "bytes");
      logProxyRequest({
        targetUrl: parsed.canonicalUrl,
        upstreamStatus: 200,
        durationMs: Date.now() - _startMs,
        bytesReceived: 0,
        client: "mega",
      });
      res.end();
      return;
    }

    const range = parseByteRange(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      meta.size
    );
    const start = range?.start ?? 0;
    const end = range?.end ?? meta.size - 1;
    const contentLength = end - start + 1;

    if (range && (start >= meta.size || end < start)) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${meta.size}`);
      res.end();
      return;
    }

    res.status(range ? 206 : 200);
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(contentLength));
    if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${meta.size}`);
    // Descarga progresiva dentro de la ventana pedida
    res.setHeader("Cache-Control", "no-store");

    const clientAborted = new Promise<void>((resolve) => {
      res.on("close", () => {
        if (!res.writableEnded) resolve();
      });
    });

    const file = MegaFile.fromURL(parsed.canonicalUrl);
    // maxConnections bajo: seeks frecuentes del reproductor no deben abrir 4+ sockets
    // simultáneos por request (riesgo de rate-limit de cuota anónima por IP).
    const openStream = () =>
      file.download({
        start,
        end,
        maxConnections: MAX_CONNECTIONS_PER_RANGE,
        forceHttps: true,
      }) as Readable;

    // El error -6 puede salir al abrir la descarga; reintentar con backoff.
    let stream: Readable | null = null;
    try {
      stream = openStream();
    } catch (err) {
      if (!isEtooMany(err)) throw err;
      for (let attempt = 0; attempt < ETOOMANY_RETRY_DELAYS_MS.length; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, ETOOMANY_RETRY_DELAYS_MS[attempt]));
        try {
          stream = openStream();
          break;
        } catch (retryErr) {
          if (attempt === ETOOMANY_RETRY_DELAYS_MS.length - 1 || !isEtooMany(retryErr)) throw retryErr;
        }
      }
      if (!stream) throw err;
    }
    if (!stream) throw new Error("MEGA: no se pudo abrir el stream tras reintentos");

    await Promise.race([
      pipeline(stream, res),
      clientAborted,
    ]);

    logProxyRequest({
      targetUrl: parsed.canonicalUrl,
      upstreamStatus: range ? 206 : 200,
      durationMs: Date.now() - _startMs,
      bytesReceived: contentLength,
      client: "mega",
    });
  } catch (err: any) {
    console.error("[stream/mega] Error:", err?.message || err);
    // -9 = ETEMPUNAVAIL de Mega (cuota de transferencia) o -6 = ETOOMANY (demasiadas IPs concurrentes)
    const isEtoo = isEtooMany(err);
    const quotaExceeded = err?.code === -9 || isEtoo || /quota|ETEMPUNAVAIL|ETOOMANY|too many concurrent/i.test(String(err?.message));
    const status = quotaExceeded ? 429 : 502;
    const errorMsg = isEtoo
      ? "MEGA ETOOMANY (-6): Demasiadas IPs concurrentes en este enlace"
      : quotaExceeded
      ? "Cuota de transferencia de MEGA excedida"
      : (err?.message || "Error MEGA");

    logProxyRequest({
      targetUrl: parsed.canonicalUrl || megaUrl,
      upstreamStatus: status,
      durationMs: Date.now() - _startMs,
      bytesReceived: 0,
      error: errorMsg,
      client: "mega",
    });

    if (!res.headersSent) {
      res.status(status).json({
        error: quotaExceeded
          ? "Cuota de transferencia de MEGA excedida; usar modo embed como fallback."
          : `Error transmitiendo desde MEGA: ${err?.message}`,
        fallback_embed: true,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}
