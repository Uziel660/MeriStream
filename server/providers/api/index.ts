import type { DirectStreamProvider, ProviderRequest } from "./types";
import { FlixQuestClient } from "./flixquestClient";
import { NuvioClient } from "./nuvioClient";
import { AnimeSdkClient } from "./animeSdkClient";
import { StreamProviderClient } from "./streamProviderClient";
import { StremioDirectClient } from "./stremioDirectClient";

const providers: DirectStreamProvider[] = [
  new FlixQuestClient(),
  new NuvioClient(),
  new AnimeSdkClient(),
  new StreamProviderClient(),
  new StremioDirectClient(),
];

export function getDirectStreamProviders(req: ProviderRequest): DirectStreamProvider[] {
  const disabled = new Set(
    String(process.env.MERISTREAM_DISABLED_DIRECT_PROVIDERS || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return providers.filter((provider) =>
    !disabled.has(provider.id) && provider.kinds.includes(req.kind as any)
  );
}

export * from "./types";
