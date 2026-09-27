import { ScraperManager } from "./ScraperManager";

/**
 * Extract streams from a page using its registered adapter, falling back to
 * GenericAdapter when no provider-specific adapter recognizes the URL.
 */
export async function extractStreamsFromUrl(url: string) {
  const adapter = ScraperManager.getInstance().getAdapter(url);
  return adapter.extractStream(url);
}
