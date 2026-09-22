export type DeliveryCapability = "direct_ok" | "proxy_required" | "embed_only";

interface CachedCapability {
  capability: DeliveryCapability;
  expiresAt: number;
}

const CACHE_KEY = "meristream_delivery_capabilities";
const MAX_ENTRIES = 100;

const TTL_MS = {
  direct_ok: 3 * 24 * 60 * 60 * 1000, // 3 days
  proxy_required: 24 * 60 * 60 * 1000, // 24 hours
  embed_only: 60 * 60 * 1000, // 1 hour
};

function getCache(): Record<string, CachedCapability> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, CachedCapability>;
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, CachedCapability>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

export function extractCapabilityKey(url: string, provider?: string): string {
  if (provider && provider.trim()) return provider.trim().toLowerCase();
  try {
    const { hostname } = new URL(url);
    return hostname.toLowerCase();
  } catch {
    return url; // fallback for relative or malformed URLs
  }
}

export function getDeliveryCapability(url: string, provider?: string): DeliveryCapability | null {
  const cache = getCache();
  const key = extractCapabilityKey(url, provider);
  const entry = cache[key];

  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    delete cache[key];
    saveCache(cache);
    return null;
  }

  return entry.capability;
}

export function setDeliveryCapability(url: string, capability: DeliveryCapability, provider?: string) {
  const cache = getCache();
  const key = extractCapabilityKey(url, provider);

  // Clean old entries if we're hitting the limit
  const keys = Object.keys(cache);
  if (keys.length >= MAX_ENTRIES && !cache[key]) {
    const now = Date.now();
    // First remove expired
    for (const k of keys) {
      if (cache[k].expiresAt < now) {
        delete cache[k];
      }
    }
    // If still too many, delete oldest
    let remainingKeys = Object.keys(cache);
    if (remainingKeys.length >= MAX_ENTRIES) {
      remainingKeys.sort((a, b) => cache[a].expiresAt - cache[b].expiresAt);
      const toDelete = remainingKeys.length - MAX_ENTRIES + 1;
      for (let i = 0; i < toDelete; i++) {
        delete cache[remainingKeys[i]];
      }
    }
  }

  cache[key] = {
    capability,
    expiresAt: Date.now() + TTL_MS[capability],
  };

  saveCache(cache);
}

export function cleanOldCapabilities() {
  const cache = getCache();
  let changed = false;
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (cache[key].expiresAt < now) {
      delete cache[key];
      changed = true;
    }
  }
  if (changed) {
    saveCache(cache);
  }
}
