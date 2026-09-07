import fs from "node:fs/promises";
import path from "node:path";

type ProbeHop = {
  url: string;
  status: number;
  contentType: string | null;
  location: string | null;
  server: string | null;
};

type MediaProbe = {
  url: string;
  status?: number;
  contentType?: string | null;
  bytesRead?: number;
  hls?: { segmentUrl: string; status?: number; contentType?: string | null; bytesRead?: number };
  error?: string;
};

type ProviderProbe = {
  provider: string;
  role: string;
  landing: {
    initialUrl: string;
    finalUrl: string;
    finalHost: string | null;
    hops: ProbeHop[];
    bodyBytes: number;
    mediaCandidates: string[];
    error?: string;
  };
  mediaProbes: MediaProbe[];
};

const UA = "MeriStream-provider-probe/2.0 (+public-direct-stream-check)";
const TARGETS = [
  { provider: "cinecalidad", role: "primary", url: "https://www.cinecalidad.am/" },
  { provider: "gnula", role: "secondary", url: "https://ww3.gnulahd.nu/" },
  { provider: "latanime", role: "primary", url: "https://latanime.org/animes?p=1" },
  { provider: "zokoanime", role: "primary", url: "https://zokoanime.video/player" },
  { provider: "tioanime", role: "legacy-fallback", url: "https://tioanime.com/directorio" },
  { provider: "vidsrc", role: "english-direct-api", url: "https://vidsrc.sbs/" },
] as const;

function absolute(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return /^https?:$/i.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function readBytes(response: Response, limit = 128 * 1024): Promise<{ text: string; bytes: number }> {
  if (!response.body) {
    const text = await response.text();
    return { text: text.slice(0, limit), bytes: Math.min(text.length, limit) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      const kept = chunk.slice(0, limit - total);
      chunks.push(kept);
      total += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), bytes: total };
}

async function probeLanding(initialUrl: string): Promise<ProviderProbe["landing"]> {
  const hops: ProbeHop[] = [];
  let current = initialUrl;
  let bodyBytes = 0;
  let body = "";
  try {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });
      const location = response.headers.get("location");
      hops.push({
        url: current,
        status: response.status,
        contentType: response.headers.get("content-type"),
        location,
        server: response.headers.get("server"),
      });
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        current = new URL(location, current).href;
        continue;
      }
      const read = await readBytes(response);
      body = read.text;
      bodyBytes = read.bytes;
      break;
    }
    const mediaCandidates = [...new Set(
      [...body.matchAll(/https?:[^"'\s<>\\]+\.(?:m3u8|mpd|mp4)(?:\?[^"'\s<>\\]*)?/gi)]
        .map((match) => match[0].replace(/\\u0026/g, "&"))
        .filter((value) => /^https?:\/\//i.test(value)),
    )].slice(0, 5);
    let finalHost: string | null = null;
    try { finalHost = new URL(current).hostname; } catch { /* keep null */ }
    return { initialUrl, finalUrl: current, finalHost, hops, bodyBytes, mediaCandidates };
  } catch (error) {
    return { initialUrl, finalUrl: current, finalHost: null, hops, bodyBytes, mediaCandidates: [], error: String((error as Error)?.message || error) };
  }
}

async function probeMedia(url: string): Promise<MediaProbe> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "*/*", Range: "bytes=0-1023" },
    });
    const read = await readBytes(response, 64 * 1024);
    const result: MediaProbe = {
      url,
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytesRead: read.bytes,
    };
    if (/\.m3u8(?:\?|$)/i.test(url) && read.text.includes("#EXTM3U")) {
      const segment = read.text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"));
      const segmentUrl = segment ? absolute(segment.trim(), url) : null;
      if (segmentUrl) {
        const segmentResponse = await fetch(segmentUrl, {
          redirect: "follow",
          headers: { "User-Agent": UA, Accept: "*/*", Range: "bytes=0-1023" },
        });
        const segmentRead = await readBytes(segmentResponse, 8 * 1024);
        result.hls = {
          segmentUrl,
          status: segmentResponse.status,
          contentType: segmentResponse.headers.get("content-type"),
          bytesRead: segmentRead.bytes,
        };
      }
    }
    return result;
  } catch (error) {
    return { url, error: String((error as Error)?.message || error) };
  }
}

async function main(): Promise<void> {
  const probes: ProviderProbe[] = [];
  for (const target of TARGETS) {
    const landing = await probeLanding(target.url);
    const mediaProbes = await Promise.all(landing.mediaCandidates.slice(0, 2).map(probeMedia));
    probes.push({ provider: target.provider, role: target.role, landing, mediaProbes });
  }
  const output = { generatedAt: new Date().toISOString(), userAgent: UA, probes };
  if (process.argv.includes("--write")) {
    const reportPath = path.resolve("docs/reports/provider-host-probe-2026-09-07.json");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(String((error as Error)?.message || error));
  process.exitCode = 1;
});
