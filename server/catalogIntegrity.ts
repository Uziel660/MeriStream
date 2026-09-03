/** Utilities shared by every catalog adapter and the catalog worker.
 *
 * Catalog pages are allowed to contain the same work more than once, but a
 * title is never a safe deduplication key: different years, seasons and cuts
 * can legitimately share a title. URLs are canonicalized only for tracking
 * pagination and repeated cards; the original URL remains persisted.
 */

export interface CatalogItemLike {
  title: string;
  url: string;
  [key: string]: unknown;
}

const TRACKING_PARAMETERS = /^(utm_|fbclid$|gclid$|ref$|referrer$)/i;

export function canonicalCatalogUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const url = new URL(rawUrl.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/{2,}/g, "/");
    url.pathname = path.length > 1 ? path.replace(/\/$/, "") : "/";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/** Deduplicate cards by canonical URL while filling missing metadata. */
export function dedupeCatalogItems<T extends CatalogItemLike>(items: readonly T[] | null | undefined): T[] {
  const byUrl = new Map<string, T>();
  for (const item of items || []) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    const key = canonicalCatalogUrl(item.url);
    const previous = byUrl.get(key);
    if (!previous) {
      byUrl.set(key, item);
      continue;
    }
    const merged = { ...previous } as T;
    for (const [field, value] of Object.entries(item)) {
      const oldValue = (merged as Record<string, unknown>)[field];
      if ((oldValue === undefined || oldValue === null || oldValue === "") && value !== undefined && value !== null && value !== "") {
        (merged as Record<string, unknown>)[field] = value;
      }
    }
    byUrl.set(key, merged);
  }
  return [...byUrl.values()];
}

export function catalogPageFingerprint(items: readonly CatalogItemLike[] | null | undefined): string {
  return dedupeCatalogItems(items)
    .map((item) => canonicalCatalogUrl(item.url))
    .sort()
    .join("|");
}

export function isRepeatedCatalogPage(
  items: readonly CatalogItemLike[] | null | undefined,
  previousFingerprint?: string,
): boolean {
  const fingerprint = catalogPageFingerprint(items);
  return Boolean(fingerprint) && fingerprint === previousFingerprint;
}

