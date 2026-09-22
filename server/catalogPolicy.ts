import fs from "fs";
import path from "path";
import { normalizeProviderId, PROVIDER_POLICIES, isProviderAllowedInMainPath } from "./providers/providerPolicy";
import type { ContentKind } from "./types";

export type CatalogPolicyMode = "global" | "main" | "legacy";
export interface CatalogPolicy {
  providerModes: Record<string, Exclude<CatalogPolicyMode, "global">>;
}

export interface ShowProviderOverrides {
  main: string[];
  legacy: string[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const POLICY_PATH = path.join(DATA_DIR, "catalog-policy.json");
const DEFAULT_POLICY: CatalogPolicy = { providerModes: {} };
let cached: CatalogPolicy | null = null;

function normalizeMode(value: unknown): Exclude<CatalogPolicyMode, "global"> | null {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "main" || raw === "legacy" ? raw : null;
}

function normalizeProviderMap(value: unknown): CatalogPolicy["providerModes"] {
  const out: CatalogPolicy["providerModes"] = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [rawProvider, rawMode] of Object.entries(value as Record<string, unknown>)) {
    const mode = normalizeMode(rawMode);
    if (!mode) continue;
    const provider = normalizeProviderId(rawProvider);
    if (!provider || provider === "unknown") continue;
    out[provider] = mode;
  }
  return out;
}

function normalizePolicy(value: unknown): CatalogPolicy {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { providerModes: normalizeProviderMap(raw.providerModes) };
}

function loadPolicy(): CatalogPolicy {
  if (cached) return { providerModes: { ...cached.providerModes } };
  try {
    if (fs.existsSync(POLICY_PATH)) {
      cached = normalizePolicy(JSON.parse(fs.readFileSync(POLICY_PATH, "utf8")));
    } else {
      cached = normalizePolicy(DEFAULT_POLICY);
    }
  } catch {
    cached = normalizePolicy(DEFAULT_POLICY);
  }
  return { providerModes: { ...cached.providerModes } };
}

export function getCatalogPolicy(): CatalogPolicy {
  return loadPolicy();
}

export function getCatalogPolicyProviders(): Array<{ id: string; label: string; defaultAllowed: boolean; mode: CatalogPolicyMode }> {
  const policy = loadPolicy();
  return Object.values(PROVIDER_POLICIES)
    .filter((entry) => entry.contentKinds.some((kind) => ["movie", "series", "anime"].includes(kind)))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      label: entry.id,
      defaultAllowed: ["movie", "series", "anime"].some((kind) => isProviderAllowedInMainPath(entry.id, kind as ContentKind)),
      mode: policy.providerModes[entry.id] || "global",
    }));
}

export function saveCatalogPolicy(input: Partial<CatalogPolicy>): CatalogPolicy {
  const next = normalizePolicy({ providerModes: input.providerModes });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${POLICY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tmp, POLICY_PATH);
  cached = next;
  return getCatalogPolicy();
}

export function normalizeShowProviderOverrides(value: unknown): ShowProviderOverrides {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalizeList = (input: unknown) => Array.isArray(input)
    ? [...new Set(input.map((item) => normalizeProviderId(String(item))).filter((item) => item && item !== "unknown"))]
    : [];
  return { main: normalizeList(raw.main), legacy: normalizeList(raw.legacy) };
}

/** Decide la ruta de una fuente respetando excepciones globales, por obra y por stream. */
export function isProviderAllowedForWork(
  providerValue: string | null | undefined,
  contentKind: ContentKind,
  options?: { showOverrides?: unknown; linkOverride?: boolean | null },
): boolean {
  if (options?.linkOverride === true) return true;
  if (options?.linkOverride === false) return false;
  const provider = normalizeProviderId(providerValue);
  const show = normalizeShowProviderOverrides(options?.showOverrides);
  if (show.main.includes(provider)) return true;
  if (show.legacy.includes(provider)) return false;
  const globalMode = loadPolicy().providerModes[provider];
  if (globalMode === "main") return true;
  if (globalMode === "legacy") return false;
  return isProviderAllowedInMainPath(provider, contentKind);
}

export function mergeShowProviderOverride(value: unknown, providerValue: string, mode: CatalogPolicyMode): ShowProviderOverrides {
  const current = normalizeShowProviderOverrides(value);
  const provider = normalizeProviderId(providerValue);
  current.main = current.main.filter((item) => item !== provider);
  current.legacy = current.legacy.filter((item) => item !== provider);
  if (mode === "main") current.main.push(provider);
  if (mode === "legacy") current.legacy.push(provider);
  return current;
}
