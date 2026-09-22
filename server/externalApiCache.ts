import { prisma } from "./db";

const disabled = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";

export async function readExternalApiCache<T>(provider: string, cacheKey: string): Promise<T | null> {
  if (disabled) return null;
  try {
    const hit = await prisma.externalApiCache.findUnique({ where: { cache_key: `${provider}:${cacheKey}` } });
    if (!hit) return null;
    if (hit.expires_at.getTime() <= Date.now()) {
      await prisma.externalApiCache.delete({ where: { cache_key: hit.cache_key } }).catch(() => undefined);
      return null;
    }
    return hit.payload as T;
  } catch { return null; }
}

export async function writeExternalApiCache(provider: string, cacheKey: string, payload: unknown, ttlMs: number): Promise<void> {
  if (disabled) return;
  try {
    await prisma.externalApiCache.upsert({
      where: { cache_key: `${provider}:${cacheKey}` },
      create: { provider, cache_key: `${provider}:${cacheKey}`, payload: payload as any, expires_at: new Date(Date.now() + ttlMs) },
      update: { payload: payload as any, expires_at: new Date(Date.now() + ttlMs) },
    });
  } catch { /* Optimization only; API must continue working without cache. */ }
}
