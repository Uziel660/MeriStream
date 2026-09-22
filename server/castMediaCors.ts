import type { NextFunction, Request, Response } from "express";

const CAST_MEDIA_PATHS = [
  /^\/api\/v1\/playback\/[^/]+\/(?:master\.(?:m3u8|mpd)|resource\/)/i,
  /^\/api\/v1\/subtitles\/file(?:\/|$)/i,
];

export function isCastMediaPath(pathname: string): boolean {
  return CAST_MEDIA_PATHS.some((pattern) => pattern.test(String(pathname || "")));
}

/**
 * Chromecast fetches adaptive manifests, segments and text tracks from a Web
 * Receiver origin that is unrelated to the sender page. These opaque media
 * routes do not use cookies, so they can safely expose wildcard CORS while the
 * rest of the API keeps its stricter origin allow-list.
 */
export function castMediaCors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept-Encoding, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Content-Length, Content-Range, Accept-Ranges");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Vary", "Origin, Access-Control-Request-Headers");
  res.removeHeader("Access-Control-Allow-Credentials");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
