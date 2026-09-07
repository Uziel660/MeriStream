import type { ContentKind } from "../types";
import {
  PROVIDER_POLICIES,
  normalizeProviderId,
  type ProviderPolicy,
} from "./providerPolicy";

/** Public registry shape consumed by discovery, resolution and health code. */
export type ProviderRegistryEntry = ProviderPolicy & {
  hosts: readonly string[];
  discovery: NonNullable<ProviderPolicy["discovery"]>;
  resolver: string;
  fallbackProvider?: string;
};

function toEntry(policy: ProviderPolicy): ProviderRegistryEntry {
  return {
    ...policy,
    hosts: Object.freeze([...(policy.hosts || [])]),
    discovery: policy.discovery || "page",
    resolver: policy.resolver || policy.id,
    ...(policy.fallbackProvider ? { fallbackProvider: policy.fallbackProvider } : {}),
  };
}

/**
 * Single runtime view of provider identity. Policy remains the only place that
 * stores priority/lifecycle/language data; this map only normalizes optional
 * defaults and makes the contract easy to consume from other layers.
 */
export const PROVIDER_REGISTRY: Readonly<Record<string, ProviderRegistryEntry>> = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDER_POLICIES).map(([id, policy]) => [id, toEntry(policy)])),
);

export function getProviderDefinition(value: string | null | undefined): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY[normalizeProviderId(value)];
}

export function listProvidersForKind(kind: ContentKind, includeLegacy = false): ProviderRegistryEntry[] {
  return Object.values(PROVIDER_REGISTRY)
    .filter((entry) => entry.contentKinds.includes(kind))
    .filter((entry) => includeLegacy || (entry.lifecycle === "active" || entry.lifecycle === "maintained"))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function fallbackChain(value: string | null | undefined, kind: ContentKind): ProviderRegistryEntry[] {
  const chain: ProviderRegistryEntry[] = [];
  const seen = new Set<string>();
  let current = getProviderDefinition(value);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.contentKinds.includes(kind)) chain.push(current);
    current = current.fallbackProvider ? getProviderDefinition(current.fallbackProvider) : undefined;
  }
  return chain;
}
