export type MediaProbe = {
  status?: number;
  requiresBackendProxy?: boolean;
  contentType?: string | null;
  host?: string | null;
  hls?: boolean;
  segmentStatus?: number;
  bytesRead?: number;
  error?: string;
};

const USER_AGENT = 'MeriStream-active-provider-probe/2026-09';
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('video/') || type.startsWith('audio/') || type.includes('octet-stream')) return true;
  const mp4 = bytes.length >= 8 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  const ts = bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47;
  const webm = bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return mp4 || ts || webm;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs = 12_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probeDirectMedia(url: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<MediaProbe> {
  const response = await fetchWithTimeout(url, { ...headers, Range: 'bytes=0-8191' }, fetchImpl);
  const bytes = await readPrefix(response, 8192);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    host: hostOf(response.url || url),
    bytesRead: bytes.byteLength,
    ...(looksLikeMedia(response.headers.get('content-type'), bytes) ? {} : { error: 'response_not_media' }),
  };
}

async function inspectHlsPlaylist(
  initialText: string,
  initialUrl: string,
  headers: Record<string, string>,
  manifest: MediaProbe,
  fetchImpl: FetchLike,
): Promise<MediaProbe> {
  let playlistText = initialText;
  let playlistUrl = initialUrl;
  for (let depth = 0; depth < 2; depth += 1) {
    const firstResource = playlistText.split(/\r?\n/).map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!firstResource) break;
    const childUrl = new URL(firstResource, playlistUrl).href;
    if (/\.m3u8(?:[?#]|$)/i.test(childUrl)) {
      const child = await fetchWithTimeout(childUrl, headers, fetchImpl);
      const childBytes = await readPrefix(child);
      const childText = new TextDecoder().decode(childBytes);
      if (child.status !== 200 || !childText.includes('#EXTM3U')) break;
      playlistText = childText;
      playlistUrl = child.url || childUrl;
      continue;
    }
    const segment = await fetchWithTimeout(childUrl, { ...headers, Range: 'bytes=0-4095' }, fetchImpl);
    const segmentBytes = await readPrefix(segment, 8192);
    return {
      ...manifest,
      hls: true,
      segmentStatus: segment.status,
      bytesRead: segmentBytes.byteLength,
      ...(looksLikeMedia(segment.headers.get('content-type'), segmentBytes) ? {} : { error: 'first_resource_not_media' }),
    };
  }
  return { ...manifest, hls: true };
}

async function probeHlsMedia(url: string, headers: Record<string, string>, fetchImpl: FetchLike): Promise<MediaProbe> {
  const response = await fetchWithTimeout(url, headers, fetchImpl);
  const bytes = await readPrefix(response);
  const text = new TextDecoder().decode(bytes);
  const baseUrl = response.url || url;
  const manifest = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    host: hostOf(baseUrl),
    bytesRead: bytes.byteLength,
  };
  if (response.status !== 200 || !text.includes('#EXTM3U')) return { ...manifest, hls: false };
  return inspectHlsPlaylist(text, baseUrl, headers, manifest, fetchImpl);
}

export async function probeMedia(
  url: string,
  headers: Record<string, string> = {},
  fetchImpl: FetchLike = fetch,
): Promise<MediaProbe> {
  try {
    // The live probe has no Express server; a relative relay URL is a valid backend-only result.
    if (url.startsWith('/api/')) return { host: 'meristream-backend', requiresBackendProxy: true };
    const isHls = /\.m3u8(?:[?#]|$)/i.test(url) || url.includes('/m3u8/');
    return isHls
      ? await probeHlsMedia(url, headers, fetchImpl)
      : await probeDirectMedia(url, headers, fetchImpl);
  } catch (error) {
    return { host: hostOf(url), error: String((error as Error)?.message || error) };
  }
}
