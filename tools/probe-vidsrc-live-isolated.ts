import fs from "node:fs/promises";
import path from "node:path";
import { resolveVidSrcEmbed } from "../server/providers/api/vidsrcClient";

type Hop = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  setCookie?: string | null;
  requestHeaders: Record<string, string>;
  bodyPrefix: string;
};

type MediaCheck = {
  requestedUrl: string;
  finalUrl?: string;
  status?: number;
  contentType?: string | null;
  host?: string;
  mediaLike?: boolean;
  requestHeaders: Record<string, string>;
  prefix?: string;
  error?: string;
};

type MediaSummary = Pick<MediaCheck, "status" | "contentType" | "host" | "error"> & { mediaLike?: boolean };

type RawAttempt = { origin: string; result: unknown; hops: Hop[] };

type CaseResult = {
  tmdb: { id: number; kind: "movie" | "series"; title: string; season?: number; episode?: number };
  status: "DIRECT" | "EMBED_ONLY" | "BLOCKED" | "UNAVAILABLE" | "ERROR";
  embedAttempts: Array<{
    origin: string;
    status?: string;
    reason?: string;
    hops: Array<{ status: number; contentType: string | null; host?: string }>;
  }>;
  selected?: {
    embedUrl: string;
    mirror: string;
    playerOrigin?: string;
    hlsHost?: string;
    requiredHeaders?: Record<string, string>;
    audioTracks?: unknown[];
    subtitles?: unknown[];
    manifest?: MediaSummary;
    variant?: MediaSummary;
    segment?: MediaSummary;
    subtitle?: MediaSummary;
  };
  reason?: string;
};

const ORIGINS = [
  "https://vidsrc.sbs",
  "https://vidsrc.to",
  "https://vidsrc.me",
  "https://vidsrc.ir",
  "https://vidsrc2.ru",
  "https://vidsrcme.ru",
  "https://vidsrcme.su",
  "https://vidsrc-me.ru",
  "https://vidsrc-me.su",
  "https://vidsrc-embed.ru",
  "https://vidsrc-embed.su",
  "https://vsrc.su",
];

const UA = "MeriStream-vidsrc-isolated-probe/20260907";

function embedUrl(origin: string, item: CaseResult["tmdb"]): string {
  return item.kind === "movie"
    ? `${origin}/embed/movie/${item.id}`
    : `${origin}/embed/tv/${item.id}/${item.season}/${item.episode}`;
}

function host(url: string | undefined): string | undefined {
  try { return url ? new URL(url).hostname : undefined; } catch { return undefined; }
}

function origin(url: string | undefined): string | undefined {
  try { return url ? new URL(url).origin : undefined; } catch { return undefined; }
}

function summarizeHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "referer" || lowerName === "origin") {
      output[name] = origin(value) || "<redacted>";
    } else if (lowerName === "user-agent" || lowerName === "accept" || lowerName === "range") {
      output[name] = value;
    } else {
      output[name] = "<present>";
    }
  }
  return output;
}

function summarizeMedia(check: MediaCheck | undefined, includeMediaLike = false): MediaSummary | undefined {
  if (!check) return undefined;
  return {
    status: check.status,
    contentType: check.contentType,
    host: check.host,
    ...(includeMediaLike && check.mediaLike !== undefined ? { mediaLike: check.mediaLike } : {}),
    ...(check.error ? { error: check.error } : {}),
  };
}

function summarizeTracks(tracks: unknown[] | undefined): unknown[] {
  return (tracks || []).map((track) => {
    const record = track && typeof track === "object" ? track as Record<string, unknown> : {};
    const trackUrl = typeof record.url === "string" ? record.url : typeof record.src === "string" ? record.src : undefined;
    return {
      ...(record.id !== undefined ? { id: record.id } : {}),
      ...(record.language !== undefined ? { language: record.language } : {}),
      ...(record.label !== undefined ? { label: record.label } : {}),
      ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
      ...(record.isDefault !== undefined ? { isDefault: record.isDefault } : {}),
      ...(record.autoselect !== undefined ? { autoselect: record.autoselect } : {}),
      ...(trackUrl ? { host: host(trackUrl) } : {}),
    };
  });
}

function summarizeAttempts(attempts: RawAttempt[]): CaseResult["embedAttempts"] {
  return attempts.map((attempt) => {
    const result = attempt.result && typeof attempt.result === "object" ? attempt.result as Record<string, unknown> : {};
    return {
      origin: attempt.origin,
      ...(typeof result.status === "string" ? { status: result.status } : {}),
      ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      hops: attempt.hops.map((hop) => ({
        status: hop.status,
        contentType: hop.contentType,
        host: host(hop.finalUrl || hop.url),
      })),
    };
  });
}

function summarizeSelected(selected: {
  embedUrl: string;
  mirror: string;
  playerOrigin?: string;
  hlsUrl?: string;
  requiredHeaders?: Record<string, string>;
  audioTracks?: unknown[];
  subtitles?: unknown[];
  manifest?: MediaCheck;
  variant?: MediaCheck;
  segment?: MediaCheck;
  subtitle?: MediaCheck;
}): CaseResult["selected"] {
  return {
    embedUrl: selected.embedUrl,
    mirror: selected.mirror,
    playerOrigin: origin(selected.playerOrigin) || selected.playerOrigin,
    hlsHost: host(selected.hlsUrl),
    requiredHeaders: summarizeHeaders(selected.requiredHeaders),
    audioTracks: summarizeTracks(selected.audioTracks),
    subtitles: summarizeTracks(selected.subtitles),
    manifest: summarizeMedia(selected.manifest),
    variant: summarizeMedia(selected.variant),
    segment: summarizeMedia(selected.segment, true),
    subtitle: summarizeMedia(selected.subtitle),
  };
}

function isLikelyMedia(contentType: string | null, bytes: Uint8Array): boolean {
  const normalized = String(contentType || "").toLowerCase();
  if (normalized.startsWith("image/")) return false;
  const transportStream = bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
  const mp4 = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  const webm = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return transportStream || mp4 || webm || /^(?:video|audio)\//.test(normalized) || normalized.includes("octet-stream");
}

async function readPrefix(response: Response, limit = 64 * 1024): Promise<string> {
  const text = await response.clone().text();
  return text.slice(0, limit);
}

async function media(url: string, headers: Record<string, string>): Promise<MediaCheck> {
  try {
    const requestHeaders = { Accept: "*/*", "User-Agent": UA, ...headers };
    const response = await fetch(url, { redirect: "follow", headers: requestHeaders });
    return {
      requestedUrl: url,
      finalUrl: response.url || url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      host: host(response.url || url),
      mediaLike: isLikelyMedia(response.headers.get("content-type"), new Uint8Array(await response.clone().arrayBuffer())),
      requestHeaders,
      prefix: await readPrefix(response, 2000),
    };
  } catch (error) {
    return { requestedUrl: url, requestHeaders: headers, error: String((error as Error)?.message || error) };
  }
}

async function validateHls(hlsUrl: string, headers: Record<string, string>) {
  const manifest = await media(hlsUrl, headers);
  if (manifest.status !== 200 || !manifest.prefix?.includes("#EXTM3U")) return { manifest };

  const lines = manifest.prefix.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const resource = lines.find((line) => !line.startsWith("#"));
  if (!resource) return { manifest };

  const childUrl = new URL(resource, manifest.finalUrl || hlsUrl).href;
  const variant = /\.m3u8(?:\?|$)/i.test(childUrl) ? await media(childUrl, headers) : undefined;
  const playlist = variant?.prefix || manifest.prefix;
  const playlistUrl = variant?.finalUrl || manifest.finalUrl || hlsUrl;
  const segmentLines = playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !/\.m3u8(?:\?|$)/i.test(line));
  let segment: MediaCheck | undefined;
  for (const segmentLine of segmentLines.slice(0, 12)) {
    const candidate = await media(new URL(segmentLine, playlistUrl).href, { ...headers, Range: "bytes=0-1023" });
    segment = candidate;
    const adLike = candidate.mediaLike !== true;
    if ((candidate.status === 200 || candidate.status === 206) && !adLike) break;
  }
  return { manifest, variant, segment };
}

async function probe(item: CaseResult["tmdb"]): Promise<CaseResult> {
  const attempts: RawAttempt[] = [];
  let lastInvalidDirect: Parameters<typeof summarizeSelected>[0] | undefined;
  for (const origin of ORIGINS) {
    const hops: Hop[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const requestHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      const response = await fetch(input, init);
      const finalUrl = response.url || String(input);
      hops.push({ url: String(input), finalUrl, status: response.status, contentType: response.headers.get("content-type"), setCookie: response.headers.get("set-cookie"), requestHeaders, bodyPrefix: await readPrefix(response, 800) });
      return response;
    };
    const url = embedUrl(origin, item);
    const result = await resolveVidSrcEmbed(url, fetcher);
    attempts.push({ origin, result, hops });
    if (result.status !== "direct" || !result.hlsUrl) continue;
    const checks = await validateHls(result.hlsUrl, result.requiredHeaders || {});
    const valid = checks.manifest.status === 200 && Boolean(checks.manifest.prefix?.includes("#EXTM3U")) && (!checks.variant || checks.variant.status === 200) && (!checks.segment || checks.segment.status === 200 || checks.segment.status === 206);
    const selected = {
      embedUrl: url,
      mirror: origin,
      playerOrigin: result.playerOrigin,
      hlsUrl: result.hlsUrl,
      requiredHeaders: result.requiredHeaders,
      audioTracks: result.audioTracks || [],
      subtitles: result.subtitles || [],
      subtitle: undefined as MediaCheck | undefined,
      ...checks,
    };
    if (result.subtitles?.[0]?.url) {
      selected.subtitle = await media(result.subtitles[0].url, {});
    }
    if (valid) return {
      tmdb: item,
      status: "DIRECT",
      embedAttempts: summarizeAttempts(attempts),
      selected: summarizeSelected(selected),
    };
    // A mirror can expose a syntactically valid but already rejected signed
    // URL. Keep probing the next mirror instead of classifying the whole
    // provider as ERROR on the first stale token.
    lastInvalidDirect = selected;
  }
  const results = attempts.map((attempt) => attempt.result as { status?: string; reason?: string });
  const statuses = new Set(results.map((result) => result.status));
  const status = statuses.has("embed_only") ? "EMBED_ONLY" : statuses.size > 0 && [...statuses].every((value) => value === "blocked") ? "BLOCKED" : statuses.size > 0 && [...statuses].every((value) => value === "unavailable") ? "UNAVAILABLE" : "ERROR";
  return {
    tmdb: item,
    status,
    embedAttempts: summarizeAttempts(attempts),
    ...(lastInvalidDirect ? { selected: summarizeSelected(lastInvalidDirect) } : {}),
    reason: lastInvalidDirect ? "hls_validation_failed_all_direct_mirrors" : results.map((result) => result.reason).filter(Boolean).join(", ") || "no_direct_hls",
  };
}

const output = {
  generatedAt: new Date().toISOString(),
  branch: "test/vidsrc-live-isolated-20260907",
  pipeline: "TMDB → VidSrc → embed → player/iframe → server hash → rcp/prorcp → HLS → manifest → variant → segmento",
  cases: await Promise.all([
    probe({ id: 550, kind: "movie", title: "Fight Club" }),
    probe({ id: 1396, kind: "series", title: "Breaking Bad", season: 1, episode: 1 }),
  ]),
};

const report = output;

const outputPath = path.resolve("docs/reports/vidsrc-live-isolated-20260907.json");
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
