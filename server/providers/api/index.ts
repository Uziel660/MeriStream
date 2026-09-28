import type { DirectStreamProvider, ProviderRequest } from "./types";
import { VidSrcClient } from "./vidsrcClient";
import { FlixQuestClient } from "./flixquestClient";
import { NuvioClient } from "./nuvioClient";
import { AnimeSdkClient } from "./animeSdkClient";
import { StreamProviderClient } from "./streamProviderClient";
import { StremioDirectClient } from "./stremioDirectClient";
import { getProviderPolicy } from "../providerPolicy";

const providers: DirectStreamProvider[] = [
  new VidSrcClient(),
  // VidSrcTo is a separate policy identity and must be health-checked on its
  // own identity. Its old .to origin is retired, so verified VidSrc mirrors
  // remain bounded failover origins instead of returning an empty provider.
  new VidSrcClient(["https://vidsrcto.to", "https://vidsrc.sh", "https://vidsrc.me", "https://vidsrc.sbs"], fetch, "vidsrcto"),
  new FlixQuestClient(),
  new NuvioClient(),
  new AnimeSdkClient(),
  new StreamProviderClient(),
  new StremioDirectClient(),
];

/**
 * Return every registered direct provider for diagnostics and maintenance.
 *
 * The normal playback path must continue to use `getDirectStreamProviders`,
 * which filters retired/disabled providers.  The verification worker needs a
 * complete view so a provider that silently disappeared cannot look healthy
 * merely because it was filtered before the check ran.
 */
export function getAllDirectStreamProviders(): readonly DirectStreamProvider[] {
  return providers;
}

export function isDirectStreamProviderDisabled(id: string): boolean {
  const disabled = new Set(
    String(process.env.MERISTREAM_DISABLED_DIRECT_PROVIDERS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return disabled.has(String(id || "").trim().toLowerCase());
}

export function getDirectStreamProviders(req: ProviderRequest): DirectStreamProvider[] {
  return providers.filter((provider) =>
    !isDirectStreamProviderDisabled(provider.id)
    && provider.kinds.includes(req.kind as any)
    && ["active", "maintained"].includes(getProviderPolicy(provider.id)?.lifecycle || "")
  );
}

export * from "./types";
