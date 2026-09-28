/**
 * Hosts that have passed the GNULA adapter verification gate.
 *
 * GNULA has many look-alike domains. Keeping the allow-list here prevents a
 * redirect, parking page or unrelated clone from being treated as the same
 * provider just because its hostname contains `gnula`.
 */
export const GNULA_VERIFIED_DOMAINS = ["gnulahd.nu", "gnula.life"] as const;

function cleanHost(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//i, "").split("/")[0].split(":")[0].replace(/^www\./i, "");
}

export function isGnulaVerifiedHost(value: string): boolean {
  const host = cleanHost(value);
  return GNULA_VERIFIED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isGnulaLifeHost(value: string): boolean {
  const host = cleanHost(value);
  return host === "gnula.life" || host.endsWith(".gnula.life");
}

export function isGnulaCanonicalPageHost(value: string): boolean {
  const host = cleanHost(value);
  if (host === "gnula.life" || host === "www.gnula.life") return true;
  return host === "gnulahd.nu" || host.endsWith(".gnulahd.nu");
}

export function normalizeGnulaHost(value: string): string {
  const host = cleanHost(value);
  return isGnulaVerifiedHost(host) ? "gnula" : host || "unknown";
}
