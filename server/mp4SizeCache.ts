// server/mp4SizeCache.ts
//
// Cache anti-416 (bug #1, MP4Upload): recuerda el tamaño total anunciado por
// el primer HEAD del proxy en la rama MP4, indexado por "host + path" de la
// URL base (sin query → el token rotatorio de MP4Upload no genera entradas
// nuevas). Si un HEAD posterior anuncia otro content-length es que el token
// rotó y el player está pidiendo rangos de un archivo que ya no existe → el
// proxy responde 416 limpia en vez de un passthrough que el upstream corta a
// mitad. TTL de 30 min; purga expirados al superar MAX_ENTRIES.

export interface Mp4SizeCacheEntry {
  size: number;
  loadedAt: number;
  finalUrl: string;
}

const MP4_SIZE_CACHE_TTL_MS = 30 * 60 * 1000;
const MP4_SIZE_CACHE_MAX_ENTRIES = 500;

const mp4SizeCache = new Map<string, Mp4SizeCacheEntry>();

/** Clave estable por host+path: ignora querystring (tokens) y trailing slash. */
export function mp4SizeCacheKey(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return targetUrl;
  }
}

export function getMp4SizeCacheEntry(targetUrl: string): Mp4SizeCacheEntry | undefined {
  return mp4SizeCache.get(mp4SizeCacheKey(targetUrl));
}

export function setMp4SizeCacheEntry(
  targetUrl: string,
  entry: { size: number; finalUrl: string },
  now: number = Date.now()
): void {
  if (mp4SizeCache.size >= MP4_SIZE_CACHE_MAX_ENTRIES) {
    pruneMp4SizeCache(now);
  }
  mp4SizeCache.set(mp4SizeCacheKey(targetUrl), {
    size: entry.size,
    loadedAt: now,
    finalUrl: entry.finalUrl,
  });
}

/** Elimina entradas cuyo TTL expiró. Devuelve cuántas purgó. */
export function pruneMp4SizeCache(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of mp4SizeCache) {
    if (now - entry.loadedAt > MP4_SIZE_CACHE_TTL_MS) {
      mp4SizeCache.delete(key);
      removed++;
    }
  }
  return removed;
}

/** Solo para tests. */
export function clearMp4SizeCacheForTests(): void {
  mp4SizeCache.clear();
}
