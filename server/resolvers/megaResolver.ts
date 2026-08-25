// server/resolvers/megaResolver.ts
//
// Parseo y normalización de URLs públicas de MEGA (mega.nz / mega.io).
// Formatos soportados:
//   - Nuevo:   https://mega.nz/file/{ID}#{KEY}
//   - Legacy:  https://mega.nz/#!{ID}!{KEY}
//   - Folder:  https://mega.nz/folder/{ID}#{KEY}  (solo detección; stream no soportado)
//   - Embed:   https://mega.nz/embed/{ID}#{KEY}

export interface MegaFileLink {
  kind: "file" | "folder";
  fileId: string;
  fileKey: string;
  /** URL canónica en formato nuevo https://mega.nz/file/{ID}#{KEY} */
  canonicalUrl: string;
  /** URL lista para iframe: https://mega.nz/embed/{ID}#{KEY} */
  embedUrl: string;
}

const MEGA_HOSTS = new Set(["mega.nz", "mega.io", "mega.co.nz"]);

/** Detecta si una URL pertenece a Mega (cualquier variante). */
export function isMegaUrl(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return MEGA_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    // Fallback tolerante para URLs sin protocolo ("mega.nz/file/...")
    return /^(https?:\/\/)?(www\.)?(mega\.nz|mega\.io|mega\.co\.nz)\//i.test(url.trim());
  }
}

/**
 * Parsea cualquier variante de URL pública de Mega y extrae { fileId, fileKey }.
 * Devuelve null si la URL no es de Mega o el formato no se reconoce.
 */
export function parseMegaUrl(url: string): MegaFileLink | null {
  const raw = (url || "").trim();
  let u: URL | null = null;
  try {
    u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!MEGA_HOSTS.has(u.hostname.toLowerCase())) return null;

  // Descartar URLs que no apuntan a un recurso compartible
  const segments = u.pathname.split("/").filter(Boolean);
  const fragment = u.hash.replace(/^#/, "");
  const queryKey = u.searchParams.get("key") || "";

  // ── Formato legacy: /#!{ID}!{KEY} (el fragment tras quitar '#' empieza con '!') ──
  const legacyMatch = /^!([A-Za-z0-9_-]{5,12})!([A-Za-z0-9_-]{22,66})$/.exec(fragment);
  if (legacyMatch && segments.length === 0) {
    return buildLink("file", legacyMatch[1], legacyMatch[2]);
  }

  // ── Formato nuevo: /file/{ID}#{KEY} ──
  if (segments[0] === "file" && segments[1] && (fragment || queryKey)) {
    return buildLink("file", segments[1], fragment || queryKey);
  }

  // ── Carpeta: /folder/{ID}#{KEY} ──
  if (segments[0] === "folder" && segments[1] && (fragment || queryKey)) {
    return buildLink("folder", segments[1], fragment || queryKey);
  }

  // ── Embed ya convertido: /embed/{ID}#{KEY} ──
  if (segments[0] === "embed" && segments[1] && (fragment || queryKey)) {
    return buildLink("file", segments[1], fragment || queryKey);
  }

  return null;
}

function buildLink(kind: "file" | "folder", fileId: string, fileKey: string): MegaFileLink {
  const base = kind === "file" ? "file" : "folder";
  return {
    kind,
    fileId,
    fileKey,
    canonicalUrl: `https://mega.nz/${base}/${fileId}#${fileKey}`,
    embedUrl: `https://mega.nz/embed/${fileId}#${fileKey}`,
  };
}

/**
 * Convierte cualquier URL de Mega a su forma /embed/ para iframe.
 * Si la URL no es de Mega devuelve null.
 */
export function toEmbedUrl(url: string): string | null {
  const parsed = parseMegaUrl(url);
  if (!parsed) return null;
  return parsed.embedUrl;
}
