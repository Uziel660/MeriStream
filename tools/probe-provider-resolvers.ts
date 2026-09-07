import fs from "node:fs/promises";
import path from "node:path";
import { ScraperManager } from "../server/scrapers/ScraperManager";
import { EmbedResolvers } from "../server/resolvers";
import { ZOKO_REQUIRED_HEADERS } from "../server/resolvers/zokoanimeResolver";

type MediaCheck = {
  url: string;
  status?: number;
  contentType?: string | null;
  bytesRead?: number;
  requestHeaders?: Record<string, string>;
  segment?: { url: string; status?: number; contentType?: string | null; bytesRead?: number };
  error?: string;
};

type ResolverCheck = {
  provider: string;
  sampleUrl: string;
  adapter: string;
  status?: number;
  title?: string;
  streams: string[];
  directStreams: string[];
  finalHosts: string[];
  mediaChecks: MediaCheck[];
  embedChecks: Array<{ url: string; finalUrl?: string; status?: number; contentType?: string | null; server?: string | null; bytesRead?: number; error?: string }>;
  error?: string;
};

const SAMPLES = [
  { provider: "cinecalidad", adapter: "cinecalidad", url: "https://www.cinecalidad.am/ver-pelicula/bolt/" },
  { provider: "gnula", adapter: "gnula", url: "https://ww3.gnulahd.nu/ver/una-pelicula-de-amor-y-guerra/" },
  { provider: "latanime", adapter: "latanime", url: "https://latanime.org/ver/mushoku-tensei-jobless-reincarnation-s3-castellano-episodio-1" },
  { provider: "zokoanime", adapter: "zokoanime", url: "https://zokoanime.video/stream/mal/32281/1/sub" },
];

async function readPrefix(response: Response, limit = 64 * 1024): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: (await response.text()).slice(0, limit), bytes: 0 };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const chunk = value.slice(0, limit - total);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), bytes: total };
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

function direct(url: string): boolean {
  return EmbedResolvers.isDirectMediaUrl(url) && /^https?:\/\//i.test(url);
}

async function checkMedia(url: string): Promise<MediaCheck> {
  try {
    const requestHeaders = /aniwatchtv\.uk$/i.test(hostOf(url) || "")
      ? { "User-Agent": "MeriStream-provider-probe/2.0", Accept: "*/*", ...ZOKO_REQUIRED_HEADERS }
      : { "User-Agent": "MeriStream-provider-probe/2.0", Accept: "*/*", "Accept-Encoding": "identity" };
    const response = await fetch(url, {
      redirect: "follow",
      headers: requestHeaders,
    });
    const prefix = await readPrefix(response);
    const result: MediaCheck = { url, status: response.status, contentType: response.headers.get("content-type"), bytesRead: prefix.bytes, requestHeaders };
    if (/\.m3u8(?:\?|$)/i.test(url) && prefix.text.includes("#EXTM3U")) {
      let playlistUrl = url;
      let playlistText = prefix.text;
      // Master playlists commonly point to a child media playlist first. Walk
      // those public playlist references before reading one actual media byte.
      for (let depth = 0; depth < 3; depth += 1) {
        const resourceLine = playlistText.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"));
        if (!resourceLine) break;
        const resourceUrl = new URL(resourceLine.trim(), playlistUrl).href;
        if (/\.m3u8(?:\?|$)/i.test(resourceUrl) && depth < 2) {
          const child = await fetch(resourceUrl, { redirect: "follow", headers: requestHeaders });
          const childPrefix = await readPrefix(child, 64 * 1024);
          if (!childPrefix.text.includes("#EXTM3U")) break;
          playlistUrl = resourceUrl;
          playlistText = childPrefix.text;
          continue;
        }
        const segment = await fetch(resourceUrl, { redirect: "follow", headers: { ...requestHeaders, Range: "bytes=0-1023" } });
        const segmentPrefix = await readPrefix(segment, 8 * 1024);
        result.segment = { url: resourceUrl, status: segment.status, contentType: segment.headers.get("content-type"), bytesRead: segmentPrefix.bytes };
        break;
      }
    }
    return result;
  } catch (error) {
    return { url, error: String((error as Error)?.message || error) };
  }
}

async function checkEmbed(url: string): Promise<ResolverCheck["embedChecks"][number]> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "MeriStream-provider-probe/2.0", Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    });
    const prefix = await readPrefix(response, 16 * 1024);
    return {
      url,
      finalUrl: response.url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      bytesRead: prefix.bytes,
    };
  } catch (error) {
    return { url, error: String((error as Error)?.message || error) };
  }
}

async function main(): Promise<void> {
  const manager = ScraperManager.getInstance();
  const results: ResolverCheck[] = [];
  for (const sample of SAMPLES) {
    const result: ResolverCheck = { provider: sample.provider, sampleUrl: sample.url, adapter: sample.adapter, streams: [], directStreams: [], finalHosts: [], mediaChecks: [], embedChecks: [] };
    try {
      const page = await fetch(sample.url, { redirect: "follow", headers: { "User-Agent": "MeriStream-provider-probe/2.0" } });
      result.status = page.status;
      const extraction = await manager.getAdapter(sample.url, sample.adapter).extractStream(sample.url);
      result.title = extraction.title;
      result.streams = extraction.all_available_streams || [];
      result.directStreams = result.streams.filter(direct);
      result.finalHosts = [...new Set(result.directStreams.map(hostOf).filter((value): value is string => Boolean(value)))];
      result.mediaChecks = await Promise.all(result.directStreams.slice(0, 3).map(checkMedia));
      result.embedChecks = await Promise.all(result.streams.filter((value) => !direct(value)).slice(0, 4).map(checkEmbed));
    } catch (error) {
      result.error = String((error as Error)?.message || error);
    }
    results.push(result);
  }
  const output = { generatedAt: new Date().toISOString(), results };
  if (process.argv.includes("--write")) {
    const reportPath = path.resolve("docs/reports/provider-resolver-probe-2026-09-07.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => { console.error(String((error as Error)?.message || error)); process.exitCode = 1; });
