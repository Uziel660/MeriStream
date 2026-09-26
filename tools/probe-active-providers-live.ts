import fs from "node:fs/promises";
import { ScraperManager } from "../server/scrapers/ScraperManager";
import { EmbedResolvers } from "../server/resolvers";

type ProbeCase = { provider: string; adapter: string; title: string; url: string };
type MediaProbe = {
  status?: number;
  contentType?: string | null;
  host?: string | null;
  hls?: boolean;
  segmentStatus?: number;
  bytesRead?: number;
  error?: string;
};

const CASES: ProbeCase[] = [
  { provider: "doramasflix", adapter: "doramasflix", title: "Mousetrap 1x1", url: "https://doramasflix.io/capitulos/mousetrap-1x1" },
  { provider: "archive-org", adapter: "archive_org", title: "Big Buck Bunny", url: "https://archive.org/details/BigBuckBunny_328" },
  { provider: "tioanime", adapter: "tioanime", title: "Naruto 1", url: "https://tioanime.com/ver/naruto-1" },
];

const UA = "MeriStream-active-provider-probe/2026-09";

function hostOf(value: string | null | undefined): string | null {
  try { return value ? new URL(value).hostname : null; } catch { return null; }
}

async function readPrefix(response: Response, limit = 64 * 1024): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(0, limit);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const take = chunk.slice(0, Math.max(0, limit - total));
      chunks.push(take);
      total += take.byteLength;
      if (take.byteLength < chunk.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function looksLikeMedia(contentType: string | null, bytes: Uint8Array): boolean {
  const type = String(contentType || "").toLowerCase();
  if (type.startsWith("video/") || type.startsWith("audio/") || type.includes("octet-stream")) return true;
  const mp4 = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
  const ts = bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
  const webm = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return mp4 || ts || webm;
}

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}, timeoutMs = 12000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "*/*", ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeMedia(url: string, headers: Record<string, string> = {}): Promise<MediaProbe> {
  try {
    if (/\.m3u8(?:[?#]|$)/i.test(url) || url.includes("/m3u8/")) {
      const manifest = await fetchWithTimeout(url, headers);
      const bytes = await readPrefix(manifest);
      const text = new TextDecoder().decode(bytes);
      const base = manifest.url || url;
      if (manifest.status !== 200 || !text.includes("#EXTM3U")) {
        return { status: manifest.status, contentType: manifest.headers.get("content-type"), host: hostOf(base), hls: false, bytesRead: bytes.byteLength };
      }

      let playlistText = text;
      let playlistUrl = base;
      for (let depth = 0; depth < 2; depth += 1) {
        const firstResource = playlistText.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
        if (!firstResource) break;
        const childUrl = new URL(firstResource, playlistUrl).href;
        if (/\.m3u8(?:[?#]|$)/i.test(childUrl)) {
          const child = await fetchWithTimeout(childUrl, headers);
          const childBytes = await readPrefix(child);
          const childText = new TextDecoder().decode(childBytes);
          if (child.status !== 200 || !childText.includes("#EXTM3U")) break;
          playlistText = childText;
          playlistUrl = child.url || childUrl;
          continue;
        }
        const segment = await fetchWithTimeout(childUrl, { ...headers, Range: "bytes=0-4095" });
        const segmentBytes = await readPrefix(segment, 8192);
        return {
          status: manifest.status,
          contentType: manifest.headers.get("content-type"),
          host: hostOf(base),
          hls: true,
          segmentStatus: segment.status,
          bytesRead: segmentBytes.byteLength,
          ...(looksLikeMedia(segment.headers.get("content-type"), segmentBytes) ? {} : { error: "first_resource_not_media" }),
        };
      }

      return { status: manifest.status, contentType: manifest.headers.get("content-type"), host: hostOf(base), hls: true, bytesRead: bytes.byteLength };
    }

    const response = await fetchWithTimeout(url, { ...headers, Range: "bytes=0-8191" });
    const bytes = await readPrefix(response, 8192);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      host: hostOf(response.url || url),
      bytesRead: bytes.byteLength,
      ...(looksLikeMedia(response.headers.get("content-type"), bytes) ? {} : { error: "response_not_media" }),
    };
  } catch (error) {
    return { host: hostOf(url), error: String((error as Error)?.message || error) };
  }
}

async function resolveCandidate(candidate: string) {
  if (EmbedResolvers.isDirectMediaUrl(candidate)) {
    return { url: candidate, requiredHeaders: {} as Record<string, string>, direct: true };
  }
  try {
    const meta: any = await EmbedResolvers.resolveWithMeta(candidate);
    const resolved = String(meta?.url || "");
    return {
      url: resolved,
      requiredHeaders: (meta?.requiredHeaders || {}) as Record<string, string>,
      direct: Boolean(resolved && EmbedResolvers.isDirectMediaUrl(resolved)),
    };
  } catch (error) {
    return { url: "", requiredHeaders: {} as Record<string, string>, direct: false, error: String((error as Error)?.message || error) };
  }
}

const manager = ScraperManager.getInstance();
const results = [];

for (const item of CASES) {
  const started = Date.now();
  try {
    const extraction = await manager.extractStream(item.url, item.adapter);
    const candidates = Array.from(new Set([
      extraction.stream_url,
      ...(extraction.all_available_streams || []),
    ].filter(Boolean))).slice(0, 5);

    const attempts = [];
    let passed = false;
    for (const candidate of candidates) {
      const resolved = await resolveCandidate(candidate);
      const media = resolved.direct && resolved.url
        ? await probeMedia(resolved.url, resolved.requiredHeaders)
        : { host: hostOf(resolved.url || candidate), error: resolved.error || "not_direct" };
      const ok = Boolean(
        resolved.direct
        && !media.error
        && (media.status === 200 || media.status === 206)
        && (media.segmentStatus === undefined || media.segmentStatus === 200 || media.segmentStatus === 206)
        && (media.bytesRead || 0) > 0
      );
      attempts.push({
        candidateHost: hostOf(candidate),
        resolvedHost: hostOf(resolved.url),
        direct: resolved.direct,
        media,
        ok,
      });
      if (ok) {
        passed = true;
        break;
      }
    }

    results.push({
      provider: item.provider,
      title: item.title,
      locatorHost: hostOf(item.url),
      candidates: candidates.length,
      passed,
      latencyMs: Date.now() - started,
      attempts,
    });
  } catch (error) {
    results.push({
      provider: item.provider,
      title: item.title,
      locatorHost: hostOf(item.url),
      candidates: 0,
      passed: false,
      latencyMs: Date.now() - started,
      error: String((error as Error)?.message || error),
      attempts: [],
    });
  }
}

const output = { generatedAt: new Date().toISOString(), results };
await fs.mkdir("provider-live-results", { recursive: true });
await fs.writeFile("provider-live-results/extra-active-providers.json", JSON.stringify(output, null, 2) + "\n", "utf8");
console.log(JSON.stringify(output, null, 2));
