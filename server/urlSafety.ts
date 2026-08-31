import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export type UrlSafetyErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "credentials_not_allowed"
  | "invalid_hostname"
  | "dns_failed"
  | "no_dns_results"
  | "invalid_ip"
  | "non_public_ip"
  | "redirect_missing_location"
  | "too_many_redirects";

export class UnsafeUrlError extends Error {
  readonly code: UrlSafetyErrorCode;

  constructor(code: UrlSafetyErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnsafeUrlError";
    this.code = code;
  }
}

export interface LookupResult {
  address: string;
  family: number;
}

export type SafeUrlLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly LookupResult[]>;

export interface SafeUrlOptions {
  lookup?: SafeUrlLookup;
}

export interface SafeFetchOptions extends SafeUrlOptions {
  fetch?: typeof fetch;
  maxRedirects?: number;
}

const defaultLookup: SafeUrlLookup = async (hostname, options) => dns.lookup(hostname, options);

const ipv4Number = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
};

const inV4Range = (value: number, base: number, prefix: number): boolean => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
};

const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // unspecified/current network
  [0x0a000000, 8], // RFC 1918
  [0x64400000, 10], // carrier-grade NAT
  [0x7f000000, 8], // loopback
  [0xa9fe0000, 16], // link-local
  [0xac100000, 12], // RFC 1918
  [0xc0000000, 24], // IETF protocol assignments
  [0xc0000200, 24], // documentation
  [0xc0586300, 24], // deprecated 6to4 relay anycast
  [0xc0a80000, 16], // RFC 1918
  [0xc6120000, 15], // benchmark tests
  [0xc6336400, 24], // documentation
  [0xcb007100, 24], // documentation
  [0xe0000000, 4], // multicast
  [0xf0000000, 4], // reserved/broadcast
];

const isPublicIpv4 = (address: string): boolean => {
  const value = ipv4Number(address);
  return value !== null && !NON_PUBLIC_V4.some(([base, prefix]) => inV4Range(value, base, prefix));
};

const parseIpv6 = (address: string): bigint | null => {
  let input = address.toLowerCase().split("%")[0];
  if (isIP(input) !== 6) return null;

  const ipv4Match = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1]);
    if (ipv4 === null) return null;
    input = input.slice(0, -ipv4Match[1].length)
      + `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(parseInt(part, 16)), 0n);
};

const inV6Range = (value: bigint, base: bigint, prefix: number): boolean =>
  prefix === 0 || (value >> BigInt(128 - prefix)) === (base >> BigInt(128 - prefix));

const isPublicIpv6 = (address: string): boolean => {
  const value = parseIpv6(address);
  if (value === null) return false;

  // IPv4-mapped IPv6 (::ffff:0:0/96) must inherit IPv4 safety rules.
  if (inV6Range(value, 0xffffn << 32n, 96)) {
    const mapped = Number(value & 0xffffffffn);
    const dotted = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return isPublicIpv4(dotted);
  }

  const blocked: ReadonlyArray<readonly [bigint, number]> = [
    [0n, 128], // unspecified
    [1n, 128], // loopback
    [0n, 96], // IPv4-compatible/deprecated forms
    [0x64ff9b00000000000000000000n, 96], // NAT64 well-known prefix
    [0x10000000000000000000000000000000n, 64], // discard-only
    [0x20010db8000000000000000000000000n, 32], // documentation
    [0xfc000000000000000000000000000000n, 7], // unique-local
    [0xfe800000000000000000000000000000n, 10], // link-local
    [0xff000000000000000000000000000000n, 8], // multicast
  ];
  return !blocked.some(([base, prefix]) => inV6Range(value, base, prefix));
};

const assertPublicAddress = (address: string): void => {
  const family = isIP(address);
  if (family === 0) throw new UnsafeUrlError("invalid_ip", `DNS returned an invalid IP address: ${address}`);
  const isPublic = family === 4 ? isPublicIpv4(address) : isPublicIpv6(address);
  if (!isPublic) throw new UnsafeUrlError("non_public_ip", "URL resolves to a non-public network address");
};

const isValidHostname = (hostname: string): boolean => {
  if (!hostname || hostname.length > 253) return false;
  if (isIP(hostname) !== 0) return true;
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return normalized.length > 0 && normalized.split(".").every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
};

/**
 * Validates an initial outbound HTTP URL against DNS rebinding/SSRF targets.
 * Consumers must invoke this function again for every redirect destination.
 */
export async function assertSafePublicHttpUrl(input: string | URL, options: SafeUrlOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch (cause) {
    throw new UnsafeUrlError("invalid_url", "Invalid URL", { cause });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("unsupported_protocol", "Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials_not_allowed", "URL credentials are not allowed");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!isValidHostname(hostname)) {
    throw new UnsafeUrlError("invalid_hostname", "URL hostname is invalid");
  }

  // URL.hostname includes brackets for IPv6 literals; lookup expects none.
  let addresses: readonly LookupResult[];
  try {
    addresses = await (options.lookup ?? defaultLookup)(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new UnsafeUrlError("dns_failed", "Unable to resolve URL hostname", { cause });
  }
  if (addresses.length === 0) throw new UnsafeUrlError("no_dns_results", "URL hostname has no addresses");
  for (const result of addresses) assertPublicAddress(result.address);

  return url;
}

export async function isSafePublicHttpUrl(input: string | URL, options: SafeUrlOptions = {}): Promise<boolean> {
  try {
    await assertSafePublicHttpUrl(input, options);
    return true;
  } catch {
    return false;
  }
}

/** Fetches an HTTP resource while revalidating every redirect target. */
export async function fetchSafePublicHttpUrl(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const maxRedirects = Math.max(0, Math.min(10, Math.floor(options.maxRedirects ?? 4)));
  let current = await assertSafePublicHttpUrl(input, options);

  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new UnsafeUrlError("redirect_missing_location", "Redirect response has no Location header");
    }
    if (redirects >= maxRedirects) {
      throw new UnsafeUrlError("too_many_redirects", "Too many outbound redirects");
    }
    current = await assertSafePublicHttpUrl(new URL(location, current), options);
  }
}
